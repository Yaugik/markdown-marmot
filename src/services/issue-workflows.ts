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

export type WorkflowStatusCategory = "backlog" | "planned" | "in_progress" | "completed" | "canceled";
export type IssueWorkflowStatus = {
  id: string;
  name: string;
  category: WorkflowStatusCategory;
  colorKey: string;
  rank: number;
  isInitial: boolean;
  revision: number;
};
export type IssueWorkflowTransition = {
  id: string;
  fromStatusId: string;
  toStatusId: string;
  name: string;
  requiresComment: boolean;
  revision: number;
};
export type IssueWorkflow = {
  id: string;
  workspaceId: string;
  projectId: string;
  name: string;
  description: string;
  isDefault: boolean;
  revision: number;
  statuses: IssueWorkflowStatus[];
  transitions: IssueWorkflowTransition[];
  createdAt: string;
  updatedAt: string;
};

type WorkflowRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  name: string;
  description: string;
  is_default: boolean;
  revision: string;
  created_at: Date;
  updated_at: Date;
};
type StatusRow = {
  id: string;
  workflow_id: string;
  name: string;
  category: WorkflowStatusCategory;
  color_key: string;
  rank: string;
  is_initial: boolean;
  revision: string;
};
type TransitionRow = {
  id: string;
  workflow_id: string;
  from_status_id: string;
  to_status_id: string;
  name: string;
  requires_comment: boolean;
  revision: string;
};

const workflowQuery = `
  SELECT id,workspace_id,project_id,name,description,is_default,revision,created_at,updated_at
  FROM issue_workflows
`;

function boundedText(value: string, label: string, max: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new FoundationServiceError("VALIDATION_FAILED", `${label} must contain 1 to ${max} characters.`);
  }
  return normalized;
}

function color(value: string | undefined): string {
  const normalized = value?.trim() || "gray";
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(normalized)) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Workflow color key is invalid.");
  }
  return normalized;
}

function rank(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Workflow rank must be a non-negative integer.");
  }
  return result;
}

async function hydrateWorkflows(client: PoolClient, rows: WorkflowRow[]): Promise<IssueWorkflow[]> {
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);
  const statuses = await client.query<StatusRow>(`
    SELECT id,workflow_id,name,category,color_key,rank,is_initial,revision
    FROM issue_workflow_statuses
    WHERE workflow_id = ANY($1::uuid[]) AND archived_at IS NULL
    ORDER BY workflow_id,rank,id
  `, [ids]);
  const transitions = await client.query<TransitionRow>(`
    SELECT id,workflow_id,from_status_id,to_status_id,name,requires_comment,revision
    FROM issue_workflow_transitions
    WHERE workflow_id = ANY($1::uuid[]) AND archived_at IS NULL
    ORDER BY workflow_id,name,id
  `, [ids]);
  return rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    isDefault: row.is_default,
    revision: Number(row.revision),
    statuses: statuses.rows.filter((status) => status.workflow_id === row.id).map((status) => ({
      id: status.id,
      name: status.name,
      category: status.category,
      colorKey: status.color_key,
      rank: Number(status.rank),
      isInitial: status.is_initial,
      revision: Number(status.revision),
    })),
    transitions: transitions.rows.filter((transition) => transition.workflow_id === row.id).map((transition) => ({
      id: transition.id,
      fromStatusId: transition.from_status_id,
      toStatusId: transition.to_status_id,
      name: transition.name,
      requiresComment: transition.requires_comment,
      revision: Number(transition.revision),
    })),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }));
}

export async function listIssueWorkflows(
  input: { workspaceId: string; projectId: string },
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<IssueWorkflow[]> {
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, principalId);
    await authorizeIssueCapability(client, { ...input, principalId, capability: "issue.read" });
    const rows = await client.query<WorkflowRow>(`${workflowQuery}
      WHERE workspace_id=$1 AND project_id=$2 AND archived_at IS NULL
      ORDER BY is_default DESC,lower(name),id
    `, [input.workspaceId, input.projectId]);
    return hydrateWorkflows(client, rows.rows);
  });
}

export async function createIssueWorkflow(
  raw: {
    workspaceId: string;
    projectId: string;
    name: string;
    description?: string;
    isDefault?: boolean;
    statuses: Array<{
      key: string;
      name: string;
      category: WorkflowStatusCategory;
      colorKey?: string;
      rank?: number;
      isInitial?: boolean;
    }>;
    transitions?: Array<{
      fromKey: string;
      toKey: string;
      name?: string;
      requiresComment?: boolean;
    }>;
  },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<IssueWorkflow>> {
  const statuses = raw.statuses.map((status, index) => ({
    key: boundedText(status.key, "Status key", 40),
    name: boundedText(status.name, "Status name", 80),
    category: status.category,
    colorKey: color(status.colorKey),
    rank: rank(status.rank, (index + 1) * 1000),
    isInitial: status.isInitial ?? false,
  }));
  if (statuses.length < 2 || statuses.length > 30) {
    throw new FoundationServiceError("VALIDATION_FAILED", "A workflow requires 2 to 30 statuses.");
  }
  if (new Set(statuses.map((status) => status.key)).size !== statuses.length) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Workflow status keys must be unique.");
  }
  if (statuses.filter((status) => status.isInitial).length !== 1) {
    throw new FoundationServiceError("VALIDATION_FAILED", "A workflow requires exactly one initial status.");
  }
  const statusKeys = new Set(statuses.map((status) => status.key));
  const transitions = (raw.transitions ?? []).map((transition) => {
    if (!statusKeys.has(transition.fromKey) || !statusKeys.has(transition.toKey)) {
      throw new FoundationServiceError("VALIDATION_FAILED", "Workflow transitions must reference known status keys.");
    }
    if (transition.fromKey === transition.toKey) {
      throw new FoundationServiceError("VALIDATION_FAILED", "Workflow transitions cannot target the same status.");
    }
    return {
      fromKey: transition.fromKey,
      toKey: transition.toKey,
      name: boundedText(transition.name ?? "Move", "Transition name", 120),
      requiresComment: transition.requiresComment ?? false,
    };
  });
  const input = {
    workspaceId: raw.workspaceId,
    projectId: raw.projectId,
    name: boundedText(raw.name, "Workflow name", 120),
    description: raw.description?.trim() ?? "",
    isDefault: raw.isDefault ?? false,
    statuses,
    transitions,
  };
  if (input.description.length > 4000) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Workflow description must be at most 4000 characters.");
  }
  const operation = "issue_workflow.create";
  const digest = requestDigest(input);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<IssueWorkflow>(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      principalId: context.actorPrincipalId,
      operation,
      key: context.idempotencyKey,
      digest,
    });
    if (replay) return replay;
    await authorizeIssueCapability(client, {
      ...input,
      principalId: context.actorPrincipalId,
      capability: "project.update",
    });
    const now = new Date();
    const workflowId = newFolioId();
    if (input.isDefault) {
      await client.query(`UPDATE issue_workflows SET is_default=false,revision=revision+1,
        updated_by_principal_id=$1,updated_at=$2
        WHERE workspace_id=$3 AND project_id=$4 AND is_default AND archived_at IS NULL`,
      [context.actorPrincipalId, now, input.workspaceId, input.projectId]);
    }
    await client.query(`INSERT INTO issue_workflows(
      id,workspace_id,project_id,name,description,is_default,created_by_principal_id,
      updated_by_principal_id,created_at,updated_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8,$8)`, [workflowId, input.workspaceId,
      input.projectId, input.name, input.description, input.isDefault, context.actorPrincipalId, now]);
    const ids = new Map<string, string>();
    for (const status of input.statuses) {
      const id = newFolioId();
      ids.set(status.key, id);
      await client.query(`INSERT INTO issue_workflow_statuses(
        id,workspace_id,project_id,workflow_id,name,category,color_key,rank,is_initial,
        created_by_principal_id,updated_by_principal_id,created_at,updated_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$11)`, [id, input.workspaceId,
        input.projectId, workflowId, status.name, status.category, status.colorKey, status.rank,
        status.isInitial, context.actorPrincipalId, now]);
    }
    for (const transition of input.transitions) {
      await client.query(`INSERT INTO issue_workflow_transitions(
        id,workspace_id,project_id,workflow_id,from_status_id,to_status_id,name,
        requires_comment,created_by_principal_id,updated_by_principal_id,created_at,updated_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$10)`, [newFolioId(), input.workspaceId,
        input.projectId, workflowId, ids.get(transition.fromKey), ids.get(transition.toKey),
        transition.name, transition.requiresComment, context.actorPrincipalId, now]);
    }
    const created = await client.query<WorkflowRow>(`${workflowQuery} WHERE id=$1`, [workflowId]);
    const data = (await hydrateWorkflows(client, created.rows))[0]!;
    return recordMutation(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      context,
      operation,
      digest,
      action: operation,
      targetType: "issue_workflow",
      targetId: workflowId,
      aggregateType: "issue_workflow",
      aggregateRevision: 1,
      eventType: "issue_workflow.created.v1",
      inputSummary: { name: input.name, statusCount: statuses.length, transitionCount: transitions.length },
      resultSummary: { workflowId, isDefault: input.isDefault },
      data,
    });
  });
}

export async function ensureDefaultIssueWorkflow(
  client: PoolClient,
  input: { workspaceId: string; projectId: string; principalId: string },
): Promise<{ workflowId: string; initialStatusId: string }> {
  const existing = await client.query<{ id: string; initial_status_id: string }>(`
    SELECT w.id,s.id initial_status_id
    FROM issue_workflows w
    JOIN issue_workflow_statuses s ON s.workflow_id=w.id AND s.is_initial AND s.archived_at IS NULL
    WHERE w.workspace_id=$1 AND w.project_id=$2 AND w.is_default AND w.archived_at IS NULL
    LIMIT 1
  `, [input.workspaceId, input.projectId]);
  if (existing.rows[0]) {
    return { workflowId: existing.rows[0].id, initialStatusId: existing.rows[0].initial_status_id };
  }
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`default-workflow:${input.projectId}`]);
  const afterLock = await client.query<{ id: string; initial_status_id: string }>(`
    SELECT w.id,s.id initial_status_id
    FROM issue_workflows w
    JOIN issue_workflow_statuses s ON s.workflow_id=w.id AND s.is_initial AND s.archived_at IS NULL
    WHERE w.workspace_id=$1 AND w.project_id=$2 AND w.is_default AND w.archived_at IS NULL
    LIMIT 1
  `, [input.workspaceId, input.projectId]);
  if (afterLock.rows[0]) {
    return { workflowId: afterLock.rows[0].id, initialStatusId: afterLock.rows[0].initial_status_id };
  }
  const now = new Date();
  const workflowId = newFolioId();
  await client.query(`INSERT INTO issue_workflows(
    id,workspace_id,project_id,name,description,is_default,created_by_principal_id,
    updated_by_principal_id,created_at,updated_at
  ) VALUES($1,$2,$3,'Default','Default issue workflow',true,$4,$4,$5,$5)`,
  [workflowId, input.workspaceId, input.projectId, input.principalId, now]);
  const definitions: Array<[string, WorkflowStatusCategory, string, number, boolean]> = [
    ["Backlog", "backlog", "gray", 1000, true],
    ["Planned", "planned", "blue", 2000, false],
    ["In progress", "in_progress", "amber", 3000, false],
    ["Completed", "completed", "green", 4000, false],
    ["Canceled", "canceled", "red", 5000, false],
  ];
  const ids: string[] = [];
  for (const [name, category, colorKey, statusRank, isInitial] of definitions) {
    const statusId = newFolioId();
    ids.push(statusId);
    await client.query(`INSERT INTO issue_workflow_statuses(
      id,workspace_id,project_id,workflow_id,name,category,color_key,rank,is_initial,
      created_by_principal_id,updated_by_principal_id,created_at,updated_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$11)`, [statusId, input.workspaceId,
      input.projectId, workflowId, name, category, colorKey, statusRank, isInitial,
      input.principalId, now]);
  }
  for (let from = 0; from < ids.length; from += 1) {
    for (let to = 0; to < ids.length; to += 1) {
      if (from === to) continue;
      await client.query(`INSERT INTO issue_workflow_transitions(
        id,workspace_id,project_id,workflow_id,from_status_id,to_status_id,name,
        created_by_principal_id,updated_by_principal_id,created_at,updated_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$9)`, [newFolioId(), input.workspaceId,
        input.projectId, workflowId, ids[from], ids[to], `Move to ${definitions[to]![0]}`,
        input.principalId, now]);
    }
  }
  return { workflowId, initialStatusId: ids[0]! };
}

export async function updateWorkflowStatus(
  raw: {
    workspaceId: string;
    projectId: string;
    statusId: string;
    expectedRevision: number;
    name?: string;
    category?: WorkflowStatusCategory;
    colorKey?: string;
    rank?: number;
  },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<IssueWorkflowStatus>> {
  if (!Number.isSafeInteger(raw.expectedRevision) || raw.expectedRevision < 1) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Expected revision must be positive.");
  }
  const input = {
    ...raw,
    name: raw.name === undefined ? undefined : boundedText(raw.name, "Status name", 80),
    colorKey: raw.colorKey === undefined ? undefined : color(raw.colorKey),
    rank: raw.rank === undefined ? undefined : rank(raw.rank, 0),
  };
  const operation = "issue_workflow_status.update";
  const digest = requestDigest(input);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<IssueWorkflowStatus>(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      principalId: context.actorPrincipalId,
      operation,
      key: context.idempotencyKey,
      digest,
    });
    if (replay) return replay;
    await authorizeIssueCapability(client, { ...input, principalId: context.actorPrincipalId, capability: "project.update" });
    const current = await client.query<StatusRow>(`
      SELECT id,workflow_id,name,category,color_key,rank,is_initial,revision
      FROM issue_workflow_statuses
      WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND archived_at IS NULL FOR UPDATE
    `, [input.workspaceId, input.projectId, input.statusId]);
    const row = current.rows[0];
    if (!row) throw new FoundationServiceError("NOT_FOUND", "Workflow status was not found.");
    const revision = Number(row.revision);
    if (revision !== input.expectedRevision) {
      throw new FoundationServiceError("REVISION_CONFLICT", "Workflow status changed after it was read.", {
        expectedRevision: input.expectedRevision,
        currentRevision: revision,
      });
    }
    const next = {
      name: input.name ?? row.name,
      category: input.category ?? row.category,
      colorKey: input.colorKey ?? row.color_key,
      rank: input.rank ?? Number(row.rank),
    };
    if (next.name === row.name && next.category === row.category
      && next.colorKey === row.color_key && next.rank === Number(row.rank)) {
      throw new FoundationServiceError("CONFLICT", "Workflow status update contains no changes.");
    }
    const now = new Date();
    const updated = await client.query<StatusRow>(`
      UPDATE issue_workflow_statuses SET name=$1,category=$2,color_key=$3,rank=$4,
        revision=revision+1,updated_by_principal_id=$5,updated_at=$6
      WHERE workspace_id=$7 AND project_id=$8 AND id=$9
      RETURNING id,workflow_id,name,category,color_key,rank,is_initial,revision
    `, [next.name, next.category, next.colorKey, next.rank, context.actorPrincipalId, now,
      input.workspaceId, input.projectId, input.statusId]);
    const result = updated.rows[0]!;
    const data: IssueWorkflowStatus = {
      id: result.id,
      name: result.name,
      category: result.category,
      colorKey: result.color_key,
      rank: Number(result.rank),
      isInitial: result.is_initial,
      revision: Number(result.revision),
    };
    return recordMutation(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      context,
      operation,
      digest,
      action: operation,
      targetType: "issue_workflow_status",
      targetId: input.statusId,
      aggregateType: "issue_workflow_status",
      aggregateRevision: revision + 1,
      eventType: "issue_workflow_status.updated.v1",
      inputSummary: { expectedRevision: input.expectedRevision, changedFields: Object.keys(next) },
      resultSummary: { statusId: input.statusId, category: next.category, rank: next.rank },
      data,
    });
  });
}
