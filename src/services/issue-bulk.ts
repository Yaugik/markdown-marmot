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
  | { operation: "transition"; targetStatusId: string }
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
    snapshots: Array<{ issueId: string; revision: number; statusId: string; workflowId: string; lifecycle: string }>;
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
};

const previewQuery = `SELECT id,workspace_id,project_id,operation,issue_ids,request,impact,
  action_digest,risk_level,state,confirmation_id,result,revision,created_at,expires_at,executed_at
  FROM issue_bulk_previews`;

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
    if (!Object.keys(patch).length) throw new FoundationServiceError("VALIDATION_FAILED", "Bulk patch requires at least one field.");
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
    if (!request.targetStatusId) throw new FoundationServiceError("VALIDATION_FAILED", "Target status is required.");
    return { operation: request.operation, targetStatusId: request.targetStatusId };
  }
  return { operation: request.operation };
}

function requiredCapability(operation: IssueBulkOperation) {
  if (operation === "transition") return "issue.transition" as const;
  if (operation === "archive" || operation === "restore") return "issue.archive" as const;
  return "issue.edit" as const;
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

export async function prepareIssueBulkOperation(
  raw: {
    workspaceId: string;
    projectId: string;
    issueIds: string[];
    request: IssueBulkRequest;
  },
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
    const rows = await client.query<IssueSnapshotRow>(`
      SELECT id,revision,status_id,workflow_id,lifecycle,parent_issue_id
      FROM issues WHERE workspace_id=$1 AND project_id=$2 AND id=ANY($3::uuid[])
    `, [raw.workspaceId, raw.projectId, issueIds]);
    const byId = new Map(rows.rows.map((row) => [row.id, row]));
    const accessible: IssueSnapshotRow[] = [];
    let unavailableCount = 0;
    for (const issueId of issueIds) {
      const row = byId.get(issueId);
      if (!row) { unavailableCount += 1; continue; }
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
    if (!accessible.length) throw new FoundationServiceError("CAPABILITY_DENIED", "No requested issues are available for this bulk operation.");
    let blockedCount = 0;
    const warnings: string[] = [];
    if (raw.request.operation === "transition") {
      for (const row of accessible) {
        const allowed = await client.query(`SELECT 1 FROM issue_workflow_transitions
          WHERE workspace_id=$1 AND project_id=$2 AND workflow_id=$3
            AND from_status_id=$4 AND to_status_id=$5 AND archived_at IS NULL`,
        [raw.workspaceId, raw.projectId, row.workflow_id, row.status_id, raw.request.targetStatusId]);
        if (!allowed.rows[0] || row.lifecycle !== "active") blockedCount += 1;
      }
    } else if (raw.request.operation === "archive") {
      const targetSet = accessible.map((row) => row.id);
      for (const row of accessible) {
        const children = await client.query<{ count: string }>(`SELECT count(*)::text count FROM issues
          WHERE workspace_id=$1 AND project_id=$2 AND parent_issue_id=$3 AND lifecycle='active'
            AND NOT (id=ANY($4::uuid[]))`, [raw.workspaceId, raw.projectId, row.id, targetSet]);
        if (Number(children.rows[0]?.count ?? 0) > 0 || row.lifecycle !== "active") blockedCount += 1;
      }
    } else if (raw.request.operation === "restore") {
      blockedCount = accessible.filter((row) => row.lifecycle !== "archived").length;
    } else {
      blockedCount = accessible.filter((row) => row.lifecycle !== "active").length;
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
    let confirmationId: string | null = null;
    if (riskLevel === "R2") {
      confirmationId = newFolioId();
      await client.query(`INSERT INTO action_confirmations(
        id,workspace_id,project_id,actor_principal_id,authorizing_principal_id,operation,
        action_digest,risk_level,preview,expires_at,created_at,updated_at
      ) VALUES($1,$2,$3,$4,$4,'issue_bulk.execute',$5,'R2',$6,$7,$8,$8)`,
      [confirmationId, raw.workspaceId, raw.projectId, context.actorPrincipalId,
        actionDigest, { previewId, operation: raw.request.operation, impact }, expiresAt, now]);
    }
    const inserted = await client.query<PreviewRow>(`INSERT INTO issue_bulk_previews(
      id,workspace_id,project_id,operation,issue_ids,request,impact,action_digest,risk_level,
      confirmation_id,created_by_principal_id,created_at,expires_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    RETURNING id,workspace_id,project_id,operation,issue_ids,request,impact,action_digest,
      risk_level,state,confirmation_id,result,revision,created_at,expires_at,executed_at`,
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
    const current = await client.query<{ action_digest: string; status: string; revision: string; expires_at: Date; authorizing_principal_id: string }>(`
      SELECT action_digest,status,revision,expires_at,authorizing_principal_id
      FROM action_confirmations
      WHERE workspace_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE
    `, [raw.workspaceId, raw.projectId, raw.confirmationId]);
    const row = current.rows[0];
    if (!row || row.authorizing_principal_id !== context.actorPrincipalId) {
      throw new FoundationServiceError("NOT_FOUND", "Bulk confirmation was not found.");
    }
    if (row.action_digest !== raw.actionDigest) throw new FoundationServiceError("CONFLICT", "Confirmation digest does not match the preview.");
    if (Number(row.revision) !== raw.expectedRevision) throw new FoundationServiceError("REVISION_CONFLICT", "Confirmation changed after it was read.", { expectedRevision: raw.expectedRevision, currentRevision: Number(row.revision) });
    if (row.status !== "pending" || row.expires_at <= new Date()) throw new FoundationServiceError("CONFLICT", "Confirmation is no longer pending.");
    const now = new Date();
    await client.query(`UPDATE action_confirmations SET status='approved',decided_at=$1,
      revision=revision+1,updated_at=$1 WHERE id=$2`, [now, raw.confirmationId]);
    const data = { confirmationId: raw.confirmationId, status: "approved" as const, revision: Number(row.revision) + 1 };
    return recordMutation(client, { workspaceId: raw.workspaceId, projectId: raw.projectId, context, operation, digest, action: operation, targetType: "action_confirmation", targetId: raw.confirmationId, aggregateType: "action_confirmation", aggregateRevision: data.revision, eventType: "action_confirmation.approved.v1", inputSummary: { expectedRevision: raw.expectedRevision }, resultSummary: data, data });
  });
}

export async function executeIssueBulkOperation(
  raw: { workspaceId: string; projectId: string; previewId: string; expectedRevision: number },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<IssueBulkPreview>> {
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
      WHERE workspace_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE`, [raw.workspaceId, raw.projectId, raw.previewId]);
    const row = current.rows[0];
    if (!row) throw new FoundationServiceError("NOT_FOUND", "Bulk preview was not found.");
    const previewRevision = Number(row.revision);
    if (previewRevision !== raw.expectedRevision) throw new FoundationServiceError("REVISION_CONFLICT", "Bulk preview changed after it was read.", { expectedRevision: raw.expectedRevision, currentRevision: previewRevision });
    if (row.state !== "prepared") throw new FoundationServiceError("CONFLICT", "Bulk preview is no longer executable.");
    if (row.expires_at <= new Date()) {
      await client.query("UPDATE issue_bulk_previews SET state='expired',revision=revision+1 WHERE id=$1", [raw.previewId]);
      throw new FoundationServiceError("CONFLICT", "Bulk preview has expired.");
    }
    if (row.risk_level === "R2") {
      const confirmation = await client.query<{ status: string; action_digest: string; expires_at: Date; authorizing_principal_id: string }>(`
        SELECT status,action_digest,expires_at,authorizing_principal_id FROM action_confirmations
        WHERE workspace_id=$1 AND id=$2 FOR UPDATE
      `, [raw.workspaceId, row.confirmation_id]);
      const confirmationRow = confirmation.rows[0];
      if (!confirmationRow || confirmationRow.status !== "approved"
        || confirmationRow.action_digest !== row.action_digest
        || confirmationRow.authorizing_principal_id !== context.actorPrincipalId
        || confirmationRow.expires_at <= new Date()) {
        throw new FoundationServiceError("CONFLICT", "An approved, unexpired confirmation is required.");
      }
    }
    const request = row.request as Record<string, unknown>;
    const snapshots = new Map(row.impact.snapshots.map((snapshot) => [snapshot.issueId, snapshot]));
    const result: IssueBulkResult = { succeeded: [], failed: [] };
    const targetSet = row.impact.snapshots.map((snapshot) => snapshot.issueId);
    for (const issueId of row.issue_ids) {
      const snapshot = snapshots.get(issueId);
      if (!snapshot) {
        result.failed.push({ issueId, code: "NOT_FOUND", message: "Issue was unavailable when the preview was prepared." });
        continue;
      }
      try {
        await authorizeIssueCapability(client, {
          workspaceId: raw.workspaceId,
          projectId: raw.projectId,
          principalId: context.actorPrincipalId,
          capability: requiredCapability(row.operation),
          issueId,
        });
        const issue = await client.query<IssueSnapshotRow>(`SELECT id,revision,status_id,workflow_id,lifecycle,parent_issue_id
          FROM issues WHERE workspace_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE`,
        [raw.workspaceId, raw.projectId, issueId]);
        const issueRow = issue.rows[0];
        if (!issueRow) {
          result.failed.push({ issueId, code: "NOT_FOUND", message: "Issue was not found." });
          continue;
        }
        const revision = Number(issueRow.revision);
        if (revision !== snapshot.revision) {
          result.failed.push({ issueId, code: "REVISION_CONFLICT", message: "Issue changed after the preview.", currentRevision: revision });
          continue;
        }
        const now = new Date();
        let summary: Record<string, unknown>;
        if (row.operation === "patch") {
          if (issueRow.lifecycle !== "active") throw new FoundationServiceError("CONFLICT", "Archived issue cannot be patched.");
          const patch = request.patch as IssueBulkPatch;
          await client.query(`UPDATE issues SET
            priority=COALESCE($1,priority),estimate_points=CASE WHEN $2::boolean THEN $3 ELSE estimate_points END,
            milestone_id=CASE WHEN $4::boolean THEN $5 ELSE milestone_id END,
            cycle_id=CASE WHEN $6::boolean THEN $7 ELSE cycle_id END,
            start_on=CASE WHEN $8::boolean THEN $9 ELSE start_on END,
            due_on=CASE WHEN $10::boolean THEN $11 ELSE due_on END,
            revision=revision+1,updated_by_principal_id=$12,updated_at=$13 WHERE id=$14`,
          [patch.priority ?? null, "estimatePoints" in patch, patch.estimatePoints ?? null,
            "milestoneId" in patch, patch.milestoneId ?? null, "cycleId" in patch,
            patch.cycleId ?? null, "startOn" in patch, patch.startOn ?? null,
            "dueOn" in patch, patch.dueOn ?? null, context.actorPrincipalId, now, issueId]);
          summary = { changedFields: Object.keys(patch) };
        } else if (row.operation === "transition") {
          if (issueRow.lifecycle !== "active") throw new FoundationServiceError("CONFLICT", "Archived issue cannot transition.");
          const targetStatusId = String(request.targetStatusId);
          const transition = await client.query(`SELECT 1 FROM issue_workflow_transitions
            WHERE workspace_id=$1 AND project_id=$2 AND workflow_id=$3
              AND from_status_id=$4 AND to_status_id=$5 AND archived_at IS NULL`,
          [raw.workspaceId, raw.projectId, issueRow.workflow_id, issueRow.status_id, targetStatusId]);
          if (!transition.rows[0]) throw new FoundationServiceError("CONFLICT", "Workflow transition is not allowed.");
          await client.query(`UPDATE issues SET status_id=$1,revision=revision+1,
            updated_by_principal_id=$2,updated_at=$3 WHERE id=$4`,
          [targetStatusId, context.actorPrincipalId, now, issueId]);
          summary = { fromStatusId: issueRow.status_id, toStatusId: targetStatusId };
        } else if (row.operation === "archive") {
          if (issueRow.lifecycle !== "active") throw new FoundationServiceError("CONFLICT", "Issue is not active.");
          const children = await client.query<{ count: string }>(`SELECT count(*)::text count FROM issues
            WHERE workspace_id=$1 AND project_id=$2 AND parent_issue_id=$3 AND lifecycle='active'
              AND NOT(id=ANY($4::uuid[]))`, [raw.workspaceId, raw.projectId, issueId, targetSet]);
          if (Number(children.rows[0]?.count ?? 0) > 0) throw new FoundationServiceError("CONFLICT", "Active child issues are outside the bulk target set.");
          await client.query(`UPDATE issues SET lifecycle='archived',archived_at=$1,
            archived_by_principal_id=$2,revision=revision+1,updated_by_principal_id=$2,
            updated_at=$1 WHERE id=$3`, [now, context.actorPrincipalId, issueId]);
          summary = { lifecycle: "archived" };
        } else {
          if (issueRow.lifecycle !== "archived") throw new FoundationServiceError("CONFLICT", "Issue is not archived.");
          await client.query(`UPDATE issues SET lifecycle='active',archived_at=NULL,
            archived_by_principal_id=NULL,revision=revision+1,updated_by_principal_id=$1,
            updated_at=$2 WHERE id=$3`, [context.actorPrincipalId, now, issueId]);
          summary = { lifecycle: "active" };
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
      } catch (error) {
        if (error instanceof FoundationServiceError) {
          result.failed.push({ issueId, code: error.code, message: error.message,
            ...(error.details.currentRevision ? { currentRevision: Number(error.details.currentRevision) } : {}) });
        } else throw error;
      }
    }
    const now = new Date();
    if (row.confirmation_id) {
      await client.query(`UPDATE action_confirmations SET status='consumed',consumed_at=$1,
        revision=revision+1,updated_at=$1 WHERE id=$2 AND status='approved'`, [now, row.confirmation_id]);
    }
    const updated = await client.query<PreviewRow>(`UPDATE issue_bulk_previews SET state='executed',
      result=$1,executed_at=$2,revision=revision+1 WHERE id=$3
      RETURNING id,workspace_id,project_id,operation,issue_ids,request,impact,action_digest,
        risk_level,state,confirmation_id,result,revision,created_at,expires_at,executed_at`,
    [result, now, raw.previewId]);
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
      aggregateRevision: previewRevision + 1,
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
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, principalId);
    await authorizeIssueCapability(client, { ...input, principalId, capability: "issue.read" });
    const result = await client.query<PreviewRow>(`${previewQuery}
      WHERE workspace_id=$1 AND project_id=$2 AND id=$3`, [input.workspaceId, input.projectId, input.previewId]);
    if (!result.rows[0]) throw new FoundationServiceError("NOT_FOUND", "Bulk preview was not found.");
    return mapPreview(result.rows[0]);
  });
}
