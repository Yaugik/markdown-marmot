import type { Pool, PoolClient } from "pg";
import { postgresPool } from "@/db/postgres";
import { establishTenantContext } from "@/db/tenant";
import { newFolioId } from "@/lib/folio-ids";
import { authorizeIssueCapability } from "@/services/issue-access";
import { FoundationServiceError } from "@/services/foundation/errors";
import {
  findIdempotentResult,
  inTransaction,
  lockIdempotencyKey,
  recordMutation,
  requestDigest,
} from "@/services/foundation/internal";
import type { MutationContext, MutationResult } from "@/services/foundation/types";
import type { IssuePriority } from "@/services/issues";

export type IssueBulkOperation = "patch" | "transition" | "archive" | "restore";
export type IssueBulkPatch = {
  priority?: IssuePriority;
  estimatePoints?: number | null;
  milestoneId?: string | null;
  cycleId?: string | null;
  startOn?: string | null;
  dueOn?: string | null;
};
export type IssueBulkRequest =
  | { operation: "patch"; patch: IssueBulkPatch }
  | { operation: "transition"; targetStatusId: string; comment?: string }
  | { operation: "archive" }
  | { operation: "restore" };
export type IssueBulkPreview = {
  id: string;
  workspaceId: string;
  projectId: string;
  operation: IssueBulkOperation;
  issueIds: string[];
  request: Record<string, unknown>;
  impact: {
    targetCount: number;
    accessibleCount: number;
    unavailableCount: number;
    blockedCount: number;
    snapshots: Array<{
      issueId: string;
      revision: number;
      statusId: string;
      workflowId: string;
      lifecycle: string;
      parentIssueId?: string | null;
    }>;
    warnings: string[];
  };
  actionDigest: string;
  riskLevel: "R1" | "R2";
  state: "prepared" | "executed" | "expired" | "canceled";
  confirmationId: string | null;
  result: IssueBulkResult | null;
  revision: number;
  createdAt: string;
  expiresAt: string;
  executedAt: string | null;
};
export type IssueBulkResult = {
  succeeded: Array<{ issueId: string; revision: number }>;
  failed: Array<{ issueId: string; code: string; message: string; currentRevision?: number }>;
};

type PreviewRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  operation: IssueBulkOperation;
  issue_ids: string[];
  request: Record<string, unknown>;
  impact: IssueBulkPreview["impact"];
  action_digest: string;
  risk_level: "R1" | "R2";
  state: IssueBulkPreview["state"];
  confirmation_id: string | null;
  result: IssueBulkResult | null;
  revision: string;
  created_by_principal_id: string;
  created_at: Date;
  expires_at: Date;
  executed_at: Date | null;
};

type IssueSnapshotRow = {
  id: string;
  revision: string;
  status_id: string;
  workflow_id: string;
  lifecycle: "active" | "archived";
  parent_issue_id: string | null;
  start_on: string | null;
  due_on: string | null;
};

type TransitionRow = { requires_comment: boolean };

const previewQuery = `SELECT id,workspace_id,project_id,operation,issue_ids,request,impact,
  action_digest,risk_level,state,confirmation_id,result,revision,created_by_principal_id,
  created_at,expires_at,executed_at FROM issue_bulk_previews`;

function mapPreview(row: PreviewRow): IssueBulkPreview {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    operation: row.operation,
    issueIds: row.issue_ids,
    request: row.request,
    impact: row.impact,
    actionDigest: row.action_digest,
    riskLevel: row.risk_level,
    state: row.state,
    confirmationId: row.confirmation_id,
    result: row.result,
    revision: Number(row.revision),
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    executedAt: row.executed_at?.toISOString() ?? null,
  };
}

function validateDate(value: string | null | undefined, label: string): string | null | undefined {
  if (value === null || value === undefined) return value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new FoundationServiceError("VALIDATION_FAILED", `${label} must use YYYY-MM-DD.`);
  }
  return value;
}

function normalizeRequest(request: IssueBulkRequest): Record<string, unknown> {
  if (request.operation === "patch") {
    const patch = { ...request.patch };
    if (!Object.keys(patch).length) {
      throw new FoundationServiceError("VALIDATION_FAILED", "Bulk patch requires at least one field.");
    }
    if (patch.priority !== undefined
      && !["no_priority", "urgent", "high", "medium", "low"].includes(patch.priority)) {
      throw new FoundationServiceError("VALIDATION_FAILED", "Bulk priority is invalid.");
    }
    if (patch.estimatePoints !== undefined && patch.estimatePoints !== null
      && (!Number.isFinite(patch.estimatePoints) || patch.estimatePoints < 0 || patch.estimatePoints > 1_000_000)) {
      throw new FoundationServiceError("VALIDATION_FAILED", "Bulk estimate is invalid.");
    }
    patch.startOn = validateDate(patch.startOn, "Start date");
    patch.dueOn = validateDate(patch.dueOn, "Due date");
    if (patch.startOn && patch.dueOn && patch.dueOn < patch.startOn) {
      throw new FoundationServiceError("VALIDATION_FAILED", "Due date cannot precede start date.");
    }
    return { operation: request.operation, patch };
  }
  if (request.operation === "transition") {
    if (!request.targetStatusId) {
      throw new FoundationServiceError("VALIDATION_FAILED", "Target status is required.");
    }
    const comment = request.comment?.trim();
    if (comment && comment.length > 20_000) {
      throw new FoundationServiceError("VALIDATION_FAILED", "Bulk transition comment is too long.");
    }
    return { operation: request.operation, targetStatusId: request.targetStatusId, comment };
  }
  return { operation: request.operation };
}

function requiredCapability(operation: IssueBulkOperation) {
  if (operation === "transition") return "issue.transition" as const;
  if (operation === "archive" || operation === "restore") return "issue.archive" as const;
  return "issue.edit" as const;
}

function isKnownDatabaseError(error: unknown): error is { code: string; message?: string; constraint?: string } {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && ["23514", "23503", "23505", "22P02", "22007", "22008"].includes(code);
}

function failureFromError(issueId: string, error: unknown): IssueBulkResult["failed"][number] {
  if (error instanceof FoundationServiceError) {
    const current = error.details.currentRevision;
    return {
      issueId,
      code: error.code,
      message: error.message,
      ...(typeof current === "number" || typeof current === "string"
        ? { currentRevision: Number(current) }
        : {}),
    };
  }
  if (isKnownDatabaseError(error)) {
    const code = error.code === "23503" || error.code === "22P02" ? "VALIDATION_FAILED" : "CONFLICT";
    return {
      issueId,
      code,
      message: error.constraint
        ? `Issue update violated ${error.constraint}.`
        : "Issue update failed a database invariant.",
    };
  }
  throw error;
}

async function insertItemActivity(
  client: PoolClient,
  input: {
    workspaceId: string;
    projectId: string;
    context: MutationContext;
    issueId: string;
    action: string;
    revision: number;
    inputSummary: Record<string, unknown>;
    resultSummary: Record<string, unknown>;
  },
) {
  const activityId = newFolioId();
  const outboxId = newFolioId();
  await client.query(`INSERT INTO activity_events(
    id,workspace_id,project_id,actor_principal_id,authorizing_principal_id,source,
    action,target_type,target_id,input_summary,result_summary,request_id,trace_id
  ) VALUES($1,$2,$3,$4,$5,$6,$7,'issue',$8,$9,$10,$11,$12)`, [activityId,
    input.workspaceId, input.projectId, input.context.actorPrincipalId,
    input.context.authorizingPrincipalId ?? input.context.actorPrincipalId,
    input.context.source ?? "api", input.action, input.issueId, input.inputSummary,
    input.resultSummary, input.context.requestId, input.context.traceId]);
  await client.query(`INSERT INTO outbox_events(
    id,workspace_id,project_id,aggregate_type,aggregate_id,aggregate_revision,event_type,
    actor_principal_id,authorizing_principal_id,request_id,trace_id,payload
  ) VALUES($1,$2,$3,'issue',$4,$5,$6,$7,$8,$9,$10,$11)`, [outboxId,
    input.workspaceId, input.projectId, input.issueId, input.revision,
    `${input.action}.v1`, input.context.actorPrincipalId,
    input.context.authorizingPrincipalId ?? input.context.actorPrincipalId,
    input.context.requestId, input.context.traceId, input.resultSummary]);
}

async function activePortfolioReference(
  client: PoolClient,
  table: "milestones" | "cycles",
  workspaceId: string,
  projectId: string,
  id: string | null | undefined,
): Promise<boolean> {
  if (id === null || id === undefined) return true;
  const result = await client.query(`SELECT 1 FROM ${table}
    WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND archived_at IS NULL`,
  [workspaceId, projectId, id]);
  return Boolean(result.rows[0]);
}

function hierarchyDepth(issueId: string, snapshots: Map<string, IssueBulkPreview["impact"]["snapshots"][number]>): number {
  let depth = 0;
  let current = snapshots.get(issueId)?.parentIssueId ?? null;
  const visited = new Set<string>();
  while (current && snapshots.has(current) && !visited.has(current)) {
    visited.add(current);
    depth += 1;
    current = snapshots.get(current)?.parentIssueId ?? null;
  }
  return depth;
}

function orderedIssueIds(preview: PreviewRow): string[] {
  if (preview.operation !== "archive" && preview.operation !== "restore") return preview.issue_ids;
  const snapshots = new Map(preview.impact.snapshots.map((snapshot) => [snapshot.issueId, snapshot]));
  return [...preview.issue_ids].sort((left, right) => {
    const difference = hierarchyDepth(left, snapshots) - hierarchyDepth(right, snapshots);
    if (difference !== 0) return preview.operation === "archive" ? -difference : difference;
    return left.localeCompare(right);
  });
}

async function expirePreparedPreview(
  pool: Pool,
  input: { workspaceId: string; projectId: string; previewId: string; principalId: string },
): Promise<void> {
  await inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, input.principalId);
    await client.query(`UPDATE issue_bulk_previews
      SET state='expired',revision=revision+1
      WHERE workspace_id=$1 AND project_id=$2 AND id=$3
        AND state='prepared' AND expires_at<=now()`,
    [input.workspaceId, input.projectId, input.previewId]);
  });
}

export async function prepareIssueBulkOperation(
  raw: { workspaceId: string; projectId: string; issueIds: string[]; request: IssueBulkRequest },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<IssueBulkPreview>> {
  const issueIds = [...new Set(raw.issueIds)];
  if (issueIds.length < 1 || issueIds.length > 500) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Bulk operations require 1 to 500 unique issues.");
  }
  const request = normalizeRequest(raw.request);
  const operationName = "issue_bulk.prepare";
  const digest = requestDigest({ workspaceId: raw.workspaceId, projectId: raw.projectId, issueIds, request });
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, raw.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operationName, context.idempotencyKey);
    const replay = await findIdempotentResult<IssueBulkPreview>(client, {
      workspaceId: raw.workspaceId,
      projectId: raw.projectId,
      principalId: context.actorPrincipalId,
      operation: operationName,
      key: context.idempotencyKey,
      digest,
    });
    if (replay) return replay;

    const rows = await client.query<IssueSnapshotRow>(`SELECT id,revision,status_id,workflow_id,
      lifecycle,parent_issue_id,start_on::text,due_on::text
      FROM issues WHERE workspace_id=$1 AND project_id=$2 AND id=ANY($3::uuid[])`,
    [raw.workspaceId, raw.projectId, issueIds]);
    const byId = new Map(rows.rows.map((row) => [row.id, row]));
    const accessible: IssueSnapshotRow[] = [];
    let unavailableCount = 0;
    for (const issueId of issueIds) {
      const row = byId.get(issueId);
      if (!row) {
        unavailableCount += 1;
        continue;
      }
      try {
        await authorizeIssueCapability(client, {
          workspaceId: raw.workspaceId,
          projectId: raw.projectId,
          principalId: context.actorPrincipalId,
          capability: requiredCapability(raw.request.operation),
          issueId,
        });
        accessible.push(row);
      } catch (error) {
        if (error instanceof FoundationServiceError) unavailableCount += 1;
        else throw error;
      }
    }
    if (!accessible.length) {
      throw new FoundationServiceError("CAPABILITY_DENIED", "No requested issues are available for this bulk operation.");
    }

    const accessibleIds = new Set(accessible.map((row) => row.id));
    let blockedCount = 0;
    const warnings: string[] = [];
    for (const row of accessible) {
      if (raw.request.operation === "transition") {
        const transition = await client.query<TransitionRow>(`SELECT requires_comment
          FROM issue_workflow_transitions
          WHERE workspace_id=$1 AND project_id=$2 AND workflow_id=$3
            AND from_status_id=$4 AND to_status_id=$5 AND archived_at IS NULL`,
        [raw.workspaceId, raw.projectId, row.workflow_id, row.status_id, raw.request.targetStatusId]);
        if (!transition.rows[0] || row.lifecycle !== "active"
          || (transition.rows[0].requires_comment && !raw.request.comment?.trim())) blockedCount += 1;
      } else if (raw.request.operation === "archive") {
        const children = await client.query<{ id: string }>(`SELECT id FROM issues
          WHERE workspace_id=$1 AND project_id=$2 AND parent_issue_id=$3 AND lifecycle='active'`,
        [raw.workspaceId, raw.projectId, row.id]);
        if (row.lifecycle !== "active"
          || children.rows.some((child) => !accessibleIds.has(child.id))) blockedCount += 1;
      } else if (raw.request.operation === "restore") {
        let blocked = row.lifecycle !== "archived";
        if (!blocked && row.parent_issue_id) {
          const parent = byId.get(row.parent_issue_id)
            ?? (await client.query<IssueSnapshotRow>(`SELECT id,revision,status_id,workflow_id,
              lifecycle,parent_issue_id,start_on::text,due_on::text FROM issues
              WHERE workspace_id=$1 AND project_id=$2 AND id=$3`,
            [raw.workspaceId, raw.projectId, row.parent_issue_id])).rows[0];
          blocked = !parent || (parent.lifecycle !== "active" && !accessibleIds.has(parent.id));
        }
        if (blocked) blockedCount += 1;
      } else {
        let blocked = row.lifecycle !== "active";
        const patch = raw.request.patch;
        const nextStart = patch.startOn === undefined ? row.start_on : patch.startOn;
        const nextDue = patch.dueOn === undefined ? row.due_on : patch.dueOn;
        if (nextStart && nextDue && nextDue < nextStart) blocked = true;
        if (!await activePortfolioReference(client, "milestones", raw.workspaceId, raw.projectId, patch.milestoneId)) blocked = true;
        if (!await activePortfolioReference(client, "cycles", raw.workspaceId, raw.projectId, patch.cycleId)) blocked = true;
        if (blocked) blockedCount += 1;
      }
    }

    if (unavailableCount) warnings.push("Some requested issues are unavailable or unauthorized and will fail individually.");
    if (blockedCount) warnings.push("Some requested issues currently fail operation preconditions.");
    const riskLevel: "R1" | "R2" = accessible.length > 10 ? "R2" : "R1";
    const snapshots = accessible.map((row) => ({
      issueId: row.id,
      revision: Number(row.revision),
      statusId: row.status_id,
      workflowId: row.workflow_id,
      lifecycle: row.lifecycle,
      parentIssueId: row.parent_issue_id,
    }));
    const impact: IssueBulkPreview["impact"] = {
      targetCount: issueIds.length,
      accessibleCount: accessible.length,
      unavailableCount,
      blockedCount,
      snapshots,
      warnings,
    };
    const actionDigest = requestDigest({
      operation: raw.request.operation,
      workspaceId: raw.workspaceId,
      projectId: raw.projectId,
      snapshots,
      request,
    });
    const previewId = newFolioId();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 15 * 60 * 1000);
    const authorizingPrincipalId = context.authorizingPrincipalId ?? context.actorPrincipalId;
    let confirmationId: string | null = null;
    if (riskLevel === "R2") {
      confirmationId = newFolioId();
      await client.query(`INSERT INTO action_confirmations(
        id,workspace_id,project_id,actor_principal_id,authorizing_principal_id,operation,
        action_digest,risk_level,preview,expires_at,created_at,updated_at
      ) VALUES($1,$2,$3,$4,$5,'issue_bulk.execute',$6,'R2',$7,$8,$9,$9)`,
      [confirmationId, raw.workspaceId, raw.projectId, context.actorPrincipalId,
        authorizingPrincipalId, actionDigest, { previewId, operation: raw.request.operation, impact },
        expiresAt, now]);
    }
    const inserted = await client.query<PreviewRow>(`INSERT INTO issue_bulk_previews(
      id,workspace_id,project_id,operation,issue_ids,request,impact,action_digest,risk_level,
      confirmation_id,created_by_principal_id,created_at,expires_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    RETURNING id,workspace_id,project_id,operation,issue_ids,request,impact,action_digest,
      risk_level,state,confirmation_id,result,revision,created_by_principal_id,
      created_at,expires_at,executed_at`,
    [previewId, raw.workspaceId, raw.projectId, raw.request.operation, issueIds, request,
      impact, actionDigest, riskLevel, confirmationId, context.actorPrincipalId, now, expiresAt]);
    const data = mapPreview(inserted.rows[0]!);
    return recordMutation(client, {
      workspaceId: raw.workspaceId,
      projectId: raw.projectId,
      context,
      operation: operationName,
      digest,
      action: operationName,
      targetType: "issue_bulk_preview",
      targetId: previewId,
      aggregateType: "issue_bulk_preview",
      aggregateRevision: 1,
      eventType: "issue_bulk.prepared.v1",
      inputSummary: { operation: raw.request.operation, targetCount: issueIds.length },
      resultSummary: { previewId, accessibleCount: accessible.length, blockedCount, riskLevel, confirmationId },
      data,
    });
  });
}

export async function approveIssueBulkConfirmation(
  raw: { workspaceId: string; projectId: string; confirmationId: string; actionDigest: string; expectedRevision: number },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<{ confirmationId: string; status: "approved"; revision: number }>> {
  if (!Number.isSafeInteger(raw.expectedRevision) || raw.expectedRevision < 1) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Expected revision must be positive.");
  }
  const operation = "issue_bulk.confirm";
  const digest = requestDigest(raw);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, raw.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<{ confirmationId: string; status: "approved"; revision: number }>(client, {
      workspaceId: raw.workspaceId,
      projectId: raw.projectId,
      principalId: context.actorPrincipalId,
      operation,
      key: context.idempotencyKey,
      digest,
    });
    if (replay) return replay;
    const current = await client.query<{
      action_digest: string;
      status: string;
      revision: string;
      expires_at: Date;
      authorizing_principal_id: string;
    }>(`SELECT action_digest,status,revision,expires_at,authorizing_principal_id
      FROM action_confirmations
      WHERE workspace_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE`,
    [raw.workspaceId, raw.projectId, raw.confirmationId]);
    const row = current.rows[0];
    if (!row || row.authorizing_principal_id !== context.actorPrincipalId) {
      throw new FoundationServiceError("NOT_FOUND", "Bulk confirmation was not found.");
    }
    if (row.action_digest !== raw.actionDigest) {
      throw new FoundationServiceError("CONFLICT", "Confirmation digest does not match the preview.");
    }
    if (Number(row.revision) !== raw.expectedRevision) {
      throw new FoundationServiceError("REVISION_CONFLICT", "Confirmation changed after it was read.", {
        expectedRevision: raw.expectedRevision,
        currentRevision: Number(row.revision),
      });
    }
    if (row.status !== "pending" || row.expires_at <= new Date()) {
      throw new FoundationServiceError("CONFLICT", "Confirmation is no longer pending.");
    }
    const now = new Date();
    await client.query(`UPDATE action_confirmations SET status='approved',decided_at=$1,
      revision=revision+1,updated_at=$1
      WHERE workspace_id=$2 AND project_id=$3 AND id=$4 AND status='pending'`,
    [now, raw.workspaceId, raw.projectId, raw.confirmationId]);
    const data = {
      confirmationId: raw.confirmationId,
      status: "approved" as const,
      revision: Number(row.revision) + 1,
    };
    return recordMutation(client, {
      workspaceId: raw.workspaceId,
      projectId: raw.projectId,
      context,
      operation,
      digest,
      action: operation,
      targetType: "action_confirmation",
      targetId: raw.confirmationId,
      aggregateType: "action_confirmation",
      aggregateRevision: data.revision,
      eventType: "action_confirmation.approved.v1",
      inputSummary: { expectedRevision: raw.expectedRevision },
      resultSummary: data,
      data,
    });
  });
}

async function applyPatch(
  client: PoolClient,
  input: {
    workspaceId: string;
    projectId: string;
    issueId: string;
    issue: IssueSnapshotRow;
    patch: IssueBulkPatch;
    actorPrincipalId: string;
    now: Date;
  },
): Promise<Record<string, unknown>> {
  if (input.issue.lifecycle !== "active") {
    throw new FoundationServiceError("CONFLICT", "Archived issue cannot be patched.");
  }
  const nextStart = input.patch.startOn === undefined ? input.issue.start_on : input.patch.startOn;
  const nextDue = input.patch.dueOn === undefined ? input.issue.due_on : input.patch.dueOn;
  if (nextStart && nextDue && nextDue < nextStart) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Due date cannot precede start date.");
  }
  if (!await activePortfolioReference(client, "milestones", input.workspaceId, input.projectId, input.patch.milestoneId)) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Bulk milestone must be active in the project.");
  }
  if (!await activePortfolioReference(client, "cycles", input.workspaceId, input.projectId, input.patch.cycleId)) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Bulk cycle must be active in the project.");
  }
  await client.query(`UPDATE issues SET
    priority=CASE WHEN $1::boolean THEN $2 ELSE priority END,
    estimate_points=CASE WHEN $3::boolean THEN $4 ELSE estimate_points END,
    milestone_id=CASE WHEN $5::boolean THEN $6 ELSE milestone_id END,
    cycle_id=CASE WHEN $7::boolean THEN $8 ELSE cycle_id END,
    start_on=CASE WHEN $9::boolean THEN $10 ELSE start_on END,
    due_on=CASE WHEN $11::boolean THEN $12 ELSE due_on END,
    revision=revision+1,updated_by_principal_id=$13,updated_at=$14
    WHERE workspace_id=$15 AND project_id=$16 AND id=$17`,
  ["priority" in input.patch, input.patch.priority ?? null,
    "estimatePoints" in input.patch, input.patch.estimatePoints ?? null,
    "milestoneId" in input.patch, input.patch.milestoneId ?? null,
    "cycleId" in input.patch, input.patch.cycleId ?? null,
    "startOn" in input.patch, input.patch.startOn ?? null,
    "dueOn" in input.patch, input.patch.dueOn ?? null,
    input.actorPrincipalId, input.now, input.workspaceId, input.projectId, input.issueId]);
  return { changedFields: Object.keys(input.patch) };
}

async function applyTransition(
  client: PoolClient,
  input: {
    workspaceId: string;
    projectId: string;
    issueId: string;
    issue: IssueSnapshotRow;
    request: Record<string, unknown>;
    actorPrincipalId: string;
    now: Date;
  },
): Promise<Record<string, unknown>> {
  if (input.issue.lifecycle !== "active") {
    throw new FoundationServiceError("CONFLICT", "Archived issue cannot transition.");
  }
  const targetStatusId = String(input.request.targetStatusId ?? "");
  const transition = await client.query<TransitionRow>(`SELECT requires_comment
    FROM issue_workflow_transitions
    WHERE workspace_id=$1 AND project_id=$2 AND workflow_id=$3
      AND from_status_id=$4 AND to_status_id=$5 AND archived_at IS NULL`,
  [input.workspaceId, input.projectId, input.issue.workflow_id, input.issue.status_id, targetStatusId]);
  const transitionRow = transition.rows[0];
  if (!transitionRow) {
    throw new FoundationServiceError("CONFLICT", "Workflow transition is not allowed.");
  }
  const comment = typeof input.request.comment === "string" ? input.request.comment.trim() : "";
  if (transitionRow.requires_comment && !comment) {
    throw new FoundationServiceError("VALIDATION_FAILED", "This workflow transition requires a comment.");
  }
  await client.query(`UPDATE issues SET status_id=$1,revision=revision+1,
    updated_by_principal_id=$2,updated_at=$3
    WHERE workspace_id=$4 AND project_id=$5 AND id=$6`,
  [targetStatusId, input.actorPrincipalId, input.now, input.workspaceId, input.projectId, input.issueId]);
  if (comment) {
    await client.query(`INSERT INTO issue_comments(
      id,workspace_id,project_id,issue_id,body,plain_text,author_principal_id,created_at,updated_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)`, [newFolioId(), input.workspaceId,
      input.projectId, input.issueId,
      { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: comment }] }] },
      comment, input.actorPrincipalId, input.now]);
  }
  return {
    fromStatusId: input.issue.status_id,
    toStatusId: targetStatusId,
    commentProvided: Boolean(comment),
  };
}

async function applyLifecycle(
  client: PoolClient,
  input: {
    workspaceId: string;
    projectId: string;
    issueId: string;
    issue: IssueSnapshotRow;
    operation: "archive" | "restore";
    actorPrincipalId: string;
    now: Date;
  },
): Promise<Record<string, unknown>> {
  if (input.operation === "archive") {
    if (input.issue.lifecycle !== "active") {
      throw new FoundationServiceError("CONFLICT", "Issue is not active.");
    }
    const children = await client.query<{ count: string }>(`SELECT count(*)::text count
      FROM issues WHERE workspace_id=$1 AND project_id=$2 AND parent_issue_id=$3
        AND lifecycle='active'`,
    [input.workspaceId, input.projectId, input.issueId]);
    if (Number(children.rows[0]?.count ?? 0) > 0) {
      throw new FoundationServiceError("CONFLICT", "Active child issues must be archived first.");
    }
    await client.query(`UPDATE issues SET lifecycle='archived',archived_at=$1,
      archived_by_principal_id=$2,revision=revision+1,updated_by_principal_id=$2,
      updated_at=$1 WHERE workspace_id=$3 AND project_id=$4 AND id=$5`,
    [input.now, input.actorPrincipalId, input.workspaceId, input.projectId, input.issueId]);
    return { lifecycle: "archived" };
  }
  if (input.issue.lifecycle !== "archived") {
    throw new FoundationServiceError("CONFLICT", "Issue is not archived.");
  }
  if (input.issue.parent_issue_id) {
    const parent = await client.query<{ lifecycle: string }>(`SELECT lifecycle FROM issues
      WHERE workspace_id=$1 AND project_id=$2 AND id=$3`,
    [input.workspaceId, input.projectId, input.issue.parent_issue_id]);
    if (!parent.rows[0] || parent.rows[0].lifecycle !== "active") {
      throw new FoundationServiceError("CONFLICT", "Restore the parent issue first.");
    }
  }
  await client.query(`UPDATE issues SET lifecycle='active',archived_at=NULL,
    archived_by_principal_id=NULL,revision=revision+1,updated_by_principal_id=$1,
    updated_at=$2 WHERE workspace_id=$3 AND project_id=$4 AND id=$5`,
  [input.actorPrincipalId, input.now, input.workspaceId, input.projectId, input.issueId]);
  return { lifecycle: "active" };
}

export async function executeIssueBulkOperation(
  raw: { workspaceId: string; projectId: string; previewId: string; expectedRevision: number },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<IssueBulkPreview>> {
  if (!Number.isSafeInteger(raw.expectedRevision) || raw.expectedRevision < 1) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Expected revision must be positive.");
  }
  await expirePreparedPreview(pool, {
    workspaceId: raw.workspaceId,
    projectId: raw.projectId,
    previewId: raw.previewId,
    principalId: context.actorPrincipalId,
  });
  const operation = "issue_bulk.execute";
  const digest = requestDigest(raw);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, raw.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<IssueBulkPreview>(client, {
      workspaceId: raw.workspaceId,
      projectId: raw.projectId,
      principalId: context.actorPrincipalId,
      operation,
      key: context.idempotencyKey,
      digest,
    });
    if (replay) return replay;
    const current = await client.query<PreviewRow>(`${previewQuery}
      WHERE workspace_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE`,
    [raw.workspaceId, raw.projectId, raw.previewId]);
    const row = current.rows[0];
    if (!row) throw new FoundationServiceError("NOT_FOUND", "Bulk preview was not found.");
    if (row.created_by_principal_id !== context.actorPrincipalId) {
      throw new FoundationServiceError("NOT_FOUND", "Bulk preview was not found.");
    }
    const previewRevision = Number(row.revision);
    if (previewRevision !== raw.expectedRevision) {
      throw new FoundationServiceError("REVISION_CONFLICT", "Bulk preview changed after it was read.", {
        expectedRevision: raw.expectedRevision,
        currentRevision: previewRevision,
      });
    }
    if (row.state === "expired") throw new FoundationServiceError("CONFLICT", "Bulk preview has expired.");
    if (row.state !== "prepared") throw new FoundationServiceError("CONFLICT", "Bulk preview is no longer executable.");
    if (row.risk_level === "R2") {
      const confirmation = await client.query<{
        status: string;
        action_digest: string;
        expires_at: Date;
        authorizing_principal_id: string;
      }>(`SELECT status,action_digest,expires_at,authorizing_principal_id
        FROM action_confirmations
        WHERE workspace_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE`,
      [raw.workspaceId, raw.projectId, row.confirmation_id]);
      const confirmationRow = confirmation.rows[0];
      if (!confirmationRow || confirmationRow.status !== "approved"
        || confirmationRow.action_digest !== row.action_digest
        || confirmationRow.authorizing_principal_id !== (context.authorizingPrincipalId ?? context.actorPrincipalId)
        || confirmationRow.expires_at <= new Date()) {
        throw new FoundationServiceError("CONFLICT", "An approved, unexpired confirmation is required.");
      }
    }

    const snapshots = new Map(row.impact.snapshots.map((snapshot) => [snapshot.issueId, snapshot]));
    const result: IssueBulkResult = { succeeded: [], failed: [] };
    for (const issueId of orderedIssueIds(row)) {
      const snapshot = snapshots.get(issueId);
      if (!snapshot) {
        result.failed.push({ issueId, code: "NOT_FOUND", message: "Issue was unavailable when the preview was prepared." });
        continue;
      }
      await client.query("SAVEPOINT issue_bulk_item");
      try {
        await authorizeIssueCapability(client, {
          workspaceId: raw.workspaceId,
          projectId: raw.projectId,
          principalId: context.actorPrincipalId,
          capability: requiredCapability(row.operation),
          issueId,
        });
        const issue = await client.query<IssueSnapshotRow>(`SELECT id,revision,status_id,workflow_id,
          lifecycle,parent_issue_id,start_on::text,due_on::text FROM issues
          WHERE workspace_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE`,
        [raw.workspaceId, raw.projectId, issueId]);
        const issueRow = issue.rows[0];
        if (!issueRow) throw new FoundationServiceError("NOT_FOUND", "Issue was not found.");
        const revision = Number(issueRow.revision);
        if (revision !== snapshot.revision) {
          throw new FoundationServiceError("REVISION_CONFLICT", "Issue changed after the preview.", {
            currentRevision: revision,
          });
        }
        const now = new Date();
        let summary: Record<string, unknown>;
        if (row.operation === "patch") {
          summary = await applyPatch(client, {
            workspaceId: raw.workspaceId,
            projectId: raw.projectId,
            issueId,
            issue: issueRow,
            patch: row.request.patch as IssueBulkPatch,
            actorPrincipalId: context.actorPrincipalId,
            now,
          });
        } else if (row.operation === "transition") {
          summary = await applyTransition(client, {
            workspaceId: raw.workspaceId,
            projectId: raw.projectId,
            issueId,
            issue: issueRow,
            request: row.request,
            actorPrincipalId: context.actorPrincipalId,
            now,
          });
        } else {
          summary = await applyLifecycle(client, {
            workspaceId: raw.workspaceId,
            projectId: raw.projectId,
            issueId,
            issue: issueRow,
            operation: row.operation,
            actorPrincipalId: context.actorPrincipalId,
            now,
          });
        }
        const nextRevision = revision + 1;
        await insertItemActivity(client, {
          workspaceId: raw.workspaceId,
          projectId: raw.projectId,
          context,
          issueId,
          action: `issue.bulk_${row.operation}`,
          revision: nextRevision,
          inputSummary: { previewId: raw.previewId, expectedRevision: snapshot.revision },
          resultSummary: { issueId, revision: nextRevision, ...summary },
        });
        result.succeeded.push({ issueId, revision: nextRevision });
        await client.query("RELEASE SAVEPOINT issue_bulk_item");
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT issue_bulk_item");
        await client.query("RELEASE SAVEPOINT issue_bulk_item");
        result.failed.push(failureFromError(issueId, error));
      }
    }

    const now = new Date();
    if (row.confirmation_id) {
      const consumed = await client.query(`UPDATE action_confirmations
        SET status='consumed',consumed_at=$1,revision=revision+1,updated_at=$1
        WHERE workspace_id=$2 AND project_id=$3 AND id=$4 AND status='approved'`,
      [now, raw.workspaceId, raw.projectId, row.confirmation_id]);
      if (consumed.rowCount !== 1) {
        throw new FoundationServiceError("CONFLICT", "Bulk confirmation could not be consumed.");
      }
    }
    const updated = await client.query<PreviewRow>(`UPDATE issue_bulk_previews
      SET state='executed',result=$1,executed_at=$2,revision=revision+1
      WHERE workspace_id=$3 AND project_id=$4 AND id=$5
      RETURNING id,workspace_id,project_id,operation,issue_ids,request,impact,action_digest,
        risk_level,state,confirmation_id,result,revision,created_by_principal_id,
        created_at,expires_at,executed_at`,
    [result, now, raw.workspaceId, raw.projectId, raw.previewId]);
    const data = mapPreview(updated.rows[0]!);
    return recordMutation(client, {
      workspaceId: raw.workspaceId,
      projectId: raw.projectId,
      context,
      operation,
      digest,
      action: operation,
      targetType: "issue_bulk_preview",
      targetId: raw.previewId,
      aggregateType: "issue_bulk_preview",
      aggregateRevision: data.revision,
      eventType: "issue_bulk.executed.v1",
      inputSummary: { expectedRevision: raw.expectedRevision, operation: row.operation },
      resultSummary: { previewId: raw.previewId, succeeded: result.succeeded.length, failed: result.failed.length },
      data,
    });
  });
}

export async function readIssueBulkPreview(
  input: { workspaceId: string; projectId: string; previewId: string },
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<IssueBulkPreview> {
  await expirePreparedPreview(pool, { ...input, principalId });
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, principalId);
    const result = await client.query<PreviewRow>(`${previewQuery}
      WHERE workspace_id=$1 AND project_id=$2 AND id=$3`,
    [input.workspaceId, input.projectId, input.previewId]);
    const row = result.rows[0];
    if (!row || row.created_by_principal_id !== principalId) {
      throw new FoundationServiceError("NOT_FOUND", "Bulk preview was not found.");
    }
    let readable = false;
    for (const snapshot of row.impact.snapshots) {
      try {
        await authorizeIssueCapability(client, {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          principalId,
          capability: "issue.read",
          issueId: snapshot.issueId,
        });
        readable = true;
        break;
      } catch (error) {
        if (!(error instanceof FoundationServiceError)) throw error;
      }
    }
    if (!readable) {
      throw new FoundationServiceError("CAPABILITY_DENIED", "No issue in this preview remains readable.");
    }
    return mapPreview(row);
  });
}
