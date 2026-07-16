import type { Pool, PoolClient } from "pg";
import { postgresPool } from "@/db/postgres";
import { establishTenantContext } from "@/db/tenant";
import { newFolioId } from "@/lib/folio-ids";
import { assertIssueExists, authorizeIssueCapability, issueReadScope } from "@/services/issue-access";
import { ensureDefaultIssueWorkflow, type WorkflowStatusCategory } from "@/services/issue-workflows";
import { FoundationServiceError } from "@/services/foundation/errors";
import {
  findIdempotentResult,
  inTransaction,
  lockIdempotencyKey,
  recordMutation,
  requestDigest,
} from "@/services/foundation/internal";
import type { MutationContext, MutationResult } from "@/services/foundation/types";

export type IssuePriority = "no_priority" | "urgent" | "high" | "medium" | "low";
export type IssueLifecycle = "active" | "archived";
export type Issue = {
  id: string;
  workspaceId: string;
  projectId: string;
  issueNumber: number;
  identifier: string;
  workflowId: string;
  status: { id: string; name: string; category: WorkflowStatusCategory; colorKey: string };
  parentIssueId: string | null;
  milestoneId: string | null;
  cycleId: string | null;
  title: string;
  description: Record<string, unknown>;
  plainText: string;
  priority: IssuePriority;
  estimatePoints: number | null;
  startOn: string | null;
  dueOn: string | null;
  rank: number;
  lifecycle: IssueLifecycle;
  revision: number;
  assignees: Array<{ principalId: string; displayName: string; kind: string; assignmentRole: "owner" | "contributor" }>;
  labels: Array<{ id: string; name: string; colorKey: string }>;
  dependencies: Array<{ id: string; sourceIssueId: string; targetIssueId: string; relationKind: "blocks" | "relates" | "duplicates" }>;
  createdByPrincipalId: string;
  updatedByPrincipalId: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

type IssueRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  issue_number: string;
  project_key: string;
  workflow_id: string;
  status_id: string;
  status_name: string;
  status_category: WorkflowStatusCategory;
  status_color_key: string;
  parent_issue_id: string | null;
  milestone_id: string | null;
  cycle_id: string | null;
  title: string;
  description: Record<string, unknown>;
  plain_text: string;
  priority: IssuePriority;
  estimate_points: string | null;
  start_on: string | null;
  due_on: string | null;
  rank: string;
  lifecycle: IssueLifecycle;
  revision: string;
  created_by_principal_id: string;
  updated_by_principal_id: string;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
};
type AssigneeRow = { issue_id: string; principal_id: string; display_name: string; kind: string; assignment_role: "owner" | "contributor" };
type LabelRow = { issue_id: string; id: string; name: string; color_key: string };
type DependencyRow = { id: string; source_issue_id: string; target_issue_id: string; relation_kind: "blocks" | "relates" | "duplicates" };

const issueQuery = `
  SELECT i.id,i.workspace_id,i.project_id,i.issue_number,p.project_key,i.workflow_id,
    i.status_id,s.name status_name,s.category status_category,s.color_key status_color_key,
    i.parent_issue_id,i.milestone_id,i.cycle_id,i.title,i.description,i.plain_text,
    i.priority,i.estimate_points,i.start_on::text,i.due_on::text,i.rank,i.lifecycle,
    i.revision,i.created_by_principal_id,i.updated_by_principal_id,
    i.created_at,i.updated_at,i.archived_at
  FROM issues i
  JOIN projects p ON p.workspace_id=i.workspace_id AND p.id=i.project_id
  JOIN issue_workflow_statuses s
    ON s.workspace_id=i.workspace_id AND s.project_id=i.project_id AND s.id=i.status_id
`;

function boundedTitle(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 240) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Issue title must contain 1 to 240 characters.");
  }
  return normalized;
}

function validateRevision(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Expected revision must be a positive integer.");
  }
}

function validateRank(value: number | undefined): number {
  const result = value ?? 1000;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Issue rank must be a non-negative integer.");
  }
  return result;
}

function validateEstimate(value: number | null | undefined): number | null | undefined {
  if (value === undefined || value === null) return value;
  if (!Number.isFinite(value) || value < 0 || value > 1_000_000) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Estimate must be between 0 and 1,000,000.");
  }
  return Math.round(value * 100) / 100;
}

function structuredDescription(value: unknown): { document: Record<string, unknown>; plainText: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Issue description must be a structured document.");
  }
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > 1024 * 1024) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Issue description must be at most 1 MiB.");
  }
  const root = value as Record<string, unknown>;
  if (root.type !== "doc") throw new FoundationServiceError("VALIDATION_FAILED", "Issue description requires a doc root.");
  let nodes = 0;
  const text: string[] = [];
  const visit = (node: unknown, depth: number) => {
    if (depth > 100 || ++nodes > 10_000 || !node || typeof node !== "object" || Array.isArray(node)) {
      throw new FoundationServiceError("VALIDATION_FAILED", "Issue description is not a valid structured document.");
    }
    const item = node as Record<string, unknown>;
    if (typeof item.type !== "string" || !item.type) {
      throw new FoundationServiceError("VALIDATION_FAILED", "Issue description nodes require a type.");
    }
    if (item.text !== undefined) {
      if (typeof item.text !== "string") throw new FoundationServiceError("VALIDATION_FAILED", "Issue text values must be strings.");
      text.push(item.text);
    }
    if (item.content !== undefined) {
      if (!Array.isArray(item.content)) throw new FoundationServiceError("VALIDATION_FAILED", "Issue node content must be an array.");
      for (const child of item.content) visit(child, depth + 1);
    }
    if (["paragraph", "heading", "blockquote", "code_block", "list_item"].includes(String(item.type))) text.push("\n");
  };
  visit(root, 0);
  const plainText = text.join("").replace(/\n{3,}/g, "\n\n").trim();
  if (plainText.length > 100_000) throw new FoundationServiceError("VALIDATION_FAILED", "Issue text must be at most 100,000 characters.");
  return { document: root, plainText };
}

function emptyDescription() {
  return { document: { type: "doc", content: [] }, plainText: "" };
}

function uniqueIds(values: string[] | undefined, label: string): string[] | undefined {
  if (values === undefined) return undefined;
  const ids = [...new Set(values)];
  if (ids.length > 100) throw new FoundationServiceError("VALIDATION_FAILED", `${label} is limited to 100 entries.`);
  return ids;
}

async function hydrateIssues(client: PoolClient, rows: IssueRow[]): Promise<Issue[]> {
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);
  const assignees = await client.query<AssigneeRow>(`
    SELECT ia.issue_id,ia.principal_id,p.display_name,p.kind,ia.assignment_role
    FROM issue_assignees ia JOIN principals p ON p.id=ia.principal_id
    WHERE ia.issue_id=ANY($1::uuid[])
    ORDER BY lower(p.display_name),p.id
  `, [ids]);
  const labels = await client.query<LabelRow>(`
    SELECT assignment.issue_id,label.id,label.name,label.color_key
    FROM issue_label_assignments assignment
    JOIN issue_labels label ON label.id=assignment.label_id AND label.archived_at IS NULL
    WHERE assignment.issue_id=ANY($1::uuid[])
    ORDER BY lower(label.name),label.id
  `, [ids]);
  const dependencies = await client.query<DependencyRow>(`
    SELECT id,source_issue_id,target_issue_id,relation_kind
    FROM issue_dependencies
    WHERE (source_issue_id=ANY($1::uuid[]) OR target_issue_id=ANY($1::uuid[]))
      AND archived_at IS NULL
    ORDER BY created_at,id
  `, [ids]);
  return rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    issueNumber: Number(row.issue_number),
    identifier: `${row.project_key}-${row.issue_number}`,
    workflowId: row.workflow_id,
    status: { id: row.status_id, name: row.status_name, category: row.status_category, colorKey: row.status_color_key },
    parentIssueId: row.parent_issue_id,
    milestoneId: row.milestone_id,
    cycleId: row.cycle_id,
    title: row.title,
    description: row.description,
    plainText: row.plain_text,
    priority: row.priority,
    estimatePoints: row.estimate_points === null ? null : Number(row.estimate_points),
    startOn: row.start_on,
    dueOn: row.due_on,
    rank: Number(row.rank),
    lifecycle: row.lifecycle,
    revision: Number(row.revision),
    assignees: assignees.rows.filter((item) => item.issue_id === row.id).map((item) => ({
      principalId: item.principal_id,
      displayName: item.display_name,
      kind: item.kind,
      assignmentRole: item.assignment_role,
    })),
    labels: labels.rows.filter((item) => item.issue_id === row.id).map((item) => ({ id: item.id, name: item.name, colorKey: item.color_key })),
    dependencies: dependencies.rows.filter((item) => item.source_issue_id === row.id || item.target_issue_id === row.id).map((item) => ({
      id: item.id,
      sourceIssueId: item.source_issue_id,
      targetIssueId: item.target_issue_id,
      relationKind: item.relation_kind,
    })),
    createdByPrincipalId: row.created_by_principal_id,
    updatedByPrincipalId: row.updated_by_principal_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    archivedAt: row.archived_at?.toISOString() ?? null,
  }));
}

async function replaceAssignments(
  client: PoolClient,
  input: { workspaceId: string; projectId: string; issueId: string; principalIds: string[]; actorPrincipalId: string },
) {
  if (input.principalIds.length) {
    const members = await client.query<{ principal_id: string }>(`
      SELECT principal_id FROM project_memberships
      WHERE workspace_id=$1 AND project_id=$2 AND principal_id=ANY($3::uuid[]) AND status='active'
    `, [input.workspaceId, input.projectId, input.principalIds]);
    if (members.rows.length !== input.principalIds.length) {
      throw new FoundationServiceError("VALIDATION_FAILED", "Every assignee must be an active project member.");
    }
  }
  await client.query("DELETE FROM issue_assignees WHERE issue_id=$1", [input.issueId]);
  for (const principalId of input.principalIds) {
    await client.query(`INSERT INTO issue_assignees(
      workspace_id,project_id,issue_id,principal_id,assigned_by_principal_id
    ) VALUES($1,$2,$3,$4,$5)`, [input.workspaceId, input.projectId, input.issueId, principalId, input.actorPrincipalId]);
  }
}

async function replaceLabels(
  client: PoolClient,
  input: { workspaceId: string; projectId: string; issueId: string; labelIds: string[]; actorPrincipalId: string },
) {
  if (input.labelIds.length) {
    const labels = await client.query<{ id: string }>(`
      SELECT id FROM issue_labels
      WHERE workspace_id=$1 AND project_id=$2 AND id=ANY($3::uuid[]) AND archived_at IS NULL
    `, [input.workspaceId, input.projectId, input.labelIds]);
    if (labels.rows.length !== input.labelIds.length) {
      throw new FoundationServiceError("VALIDATION_FAILED", "Every label must be active in the project.");
    }
  }
  await client.query("DELETE FROM issue_label_assignments WHERE issue_id=$1", [input.issueId]);
  for (const labelId of input.labelIds) {
    await client.query(`INSERT INTO issue_label_assignments(
      workspace_id,project_id,issue_id,label_id,created_by_principal_id
    ) VALUES($1,$2,$3,$4,$5)`, [input.workspaceId, input.projectId, input.issueId, labelId, input.actorPrincipalId]);
  }
}

export async function createIssue(
  raw: {
    workspaceId: string;
    projectId: string;
    title: string;
    description?: unknown;
    workflowId?: string;
    statusId?: string;
    parentIssueId?: string | null;
    milestoneId?: string | null;
    cycleId?: string | null;
    priority?: IssuePriority;
    estimatePoints?: number | null;
    startOn?: string | null;
    dueOn?: string | null;
    rank?: number;
    assigneeIds?: string[];
    labelIds?: string[];
  },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<Issue>> {
  const description = raw.description === undefined ? emptyDescription() : structuredDescription(raw.description);
  const input = {
    workspaceId: raw.workspaceId,
    projectId: raw.projectId,
    title: boundedTitle(raw.title),
    description: description.document,
    plainText: description.plainText,
    workflowId: raw.workflowId,
    statusId: raw.statusId,
    parentIssueId: raw.parentIssueId ?? null,
    milestoneId: raw.milestoneId ?? null,
    cycleId: raw.cycleId ?? null,
    priority: raw.priority ?? "no_priority" as IssuePriority,
    estimatePoints: validateEstimate(raw.estimatePoints) ?? null,
    startOn: raw.startOn ?? null,
    dueOn: raw.dueOn ?? null,
    rank: validateRank(raw.rank),
    assigneeIds: uniqueIds(raw.assigneeIds, "Assignees") ?? [],
    labelIds: uniqueIds(raw.labelIds, "Labels") ?? [],
  };
  if ((input.workflowId && !input.statusId) || (!input.workflowId && input.statusId)) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Workflow and status must be supplied together.");
  }
  const operation = "issue.create";
  const digest = requestDigest({ ...input, descriptionHash: requestDigest(input.description), description: undefined });
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<Issue>(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      principalId: context.actorPrincipalId,
      operation,
      key: context.idempotencyKey,
      digest,
    });
    if (replay) return replay;
    await authorizeIssueCapability(client, { ...input, principalId: context.actorPrincipalId, capability: "issue.create" });
    let workflowId = input.workflowId;
    let statusId = input.statusId;
    if (!workflowId || !statusId) {
      const defaults = await ensureDefaultIssueWorkflow(client, {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        principalId: context.actorPrincipalId,
      });
      workflowId = defaults.workflowId;
      statusId = defaults.initialStatusId;
    }
    if (input.parentIssueId) {
      const parent = await client.query(`SELECT 1 FROM issues
        WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND lifecycle='active'`,
      [input.workspaceId, input.projectId, input.parentIssueId]);
      if (!parent.rows[0]) throw new FoundationServiceError("NOT_FOUND", "Parent issue was not found.");
    }
    await client.query(`INSERT INTO project_issue_counters(workspace_id,project_id,next_number)
      VALUES($1,$2,1) ON CONFLICT (workspace_id,project_id) DO NOTHING`, [input.workspaceId, input.projectId]);
    const counter = await client.query<{ issue_number: string }>(`
      UPDATE project_issue_counters SET next_number=next_number+1,updated_at=now()
      WHERE workspace_id=$1 AND project_id=$2 RETURNING next_number-1 issue_number
    `, [input.workspaceId, input.projectId]);
    const issueNumber = Number(counter.rows[0]!.issue_number);
    const issueId = newFolioId();
    const now = new Date();
    await client.query(`INSERT INTO issues(
      id,workspace_id,project_id,issue_number,workflow_id,status_id,parent_issue_id,
      milestone_id,cycle_id,title,description,plain_text,priority,estimate_points,start_on,
      due_on,rank,created_by_principal_id,updated_by_principal_id,created_at,updated_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18,$19,$19)`,
    [issueId, input.workspaceId, input.projectId, issueNumber, workflowId, statusId,
      input.parentIssueId, input.milestoneId, input.cycleId, input.title, input.description,
      input.plainText, input.priority, input.estimatePoints, input.startOn, input.dueOn,
      input.rank, context.actorPrincipalId, now]);
    await replaceAssignments(client, { ...input, issueId, principalIds: input.assigneeIds, actorPrincipalId: context.actorPrincipalId });
    await replaceLabels(client, { ...input, issueId, labelIds: input.labelIds, actorPrincipalId: context.actorPrincipalId });
    const created = await client.query<IssueRow>(`${issueQuery} WHERE i.id=$1`, [issueId]);
    const data = (await hydrateIssues(client, created.rows))[0]!;
    return recordMutation(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      context,
      operation,
      digest,
      action: operation,
      targetType: "issue",
      targetId: issueId,
      aggregateType: "issue",
      aggregateRevision: 1,
      eventType: "issue.created.v1",
      inputSummary: {
        title: input.title,
        priority: input.priority,
        parentIssueId: input.parentIssueId,
        assigneeCount: input.assigneeIds.length,
        labelCount: input.labelIds.length,
        descriptionBytes: Buffer.byteLength(JSON.stringify(input.description)),
      },
      resultSummary: { issueId, issueNumber, workflowId, statusId },
      data,
    });
  });
}

export async function readIssue(
  input: { workspaceId: string; projectId: string; issueId: string },
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<Issue> {
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, principalId);
    await authorizeIssueCapability(client, { ...input, principalId, capability: "issue.read" });
    const result = await client.query<IssueRow>(`${issueQuery}
      WHERE i.workspace_id=$1 AND i.project_id=$2 AND i.id=$3
    `, [input.workspaceId, input.projectId, input.issueId]);
    if (!result.rows[0]) throw new FoundationServiceError("NOT_FOUND", "Issue was not found.");
    return (await hydrateIssues(client, result.rows))[0]!;
  });
}

export async function listIssues(
  input: {
    workspaceId: string;
    projectId: string;
    includeArchived?: boolean;
    statusIds?: string[];
    labelIds?: string[];
    assigneeIds?: string[];
    priorities?: IssuePriority[];
    milestoneId?: string | null;
    cycleId?: string | null;
    parentIssueId?: string | null;
    query?: string;
    limit?: number;
  },
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<Issue[]> {
  const limit = Math.min(500, Math.max(1, input.limit ?? 200));
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, principalId);
    const scope = await issueReadScope(client, { ...input, principalId });
    if (!scope.projectWide && !scope.issueIds.length) return [];
    const values: unknown[] = [input.workspaceId, input.projectId];
    const conditions = ["i.workspace_id=$1", "i.project_id=$2"];
    const add = (value: unknown) => { values.push(value); return `$${values.length}`; };
    if (!input.includeArchived) conditions.push("i.lifecycle='active'");
    if (!scope.projectWide) conditions.push(`i.id=ANY(${add(scope.issueIds)}::uuid[])`);
    if (input.statusIds?.length) conditions.push(`i.status_id=ANY(${add(input.statusIds)}::uuid[])`);
    if (input.priorities?.length) conditions.push(`i.priority=ANY(${add(input.priorities)}::text[])`);
    if (input.milestoneId !== undefined) conditions.push(`i.milestone_id IS NOT DISTINCT FROM ${add(input.milestoneId)}`);
    if (input.cycleId !== undefined) conditions.push(`i.cycle_id IS NOT DISTINCT FROM ${add(input.cycleId)}`);
    if (input.parentIssueId !== undefined) conditions.push(`i.parent_issue_id IS NOT DISTINCT FROM ${add(input.parentIssueId)}`);
    if (input.labelIds?.length) conditions.push(`EXISTS (
      SELECT 1 FROM issue_label_assignments ila
      WHERE ila.issue_id=i.id AND ila.label_id=ANY(${add(input.labelIds)}::uuid[])
    )`);
    if (input.assigneeIds?.length) conditions.push(`EXISTS (
      SELECT 1 FROM issue_assignees ia
      WHERE ia.issue_id=i.id AND ia.principal_id=ANY(${add(input.assigneeIds)}::uuid[])
    )`);
    if (input.query?.trim()) conditions.push(`EXISTS (
      SELECT 1 FROM issue_search_documents search
      WHERE search.issue_id=i.id AND search.search_vector @@ websearch_to_tsquery('simple',${add(input.query.trim())})
    )`);
    values.push(limit);
    const result = await client.query<IssueRow>(`${issueQuery}
      WHERE ${conditions.join(" AND ")}
      ORDER BY i.rank,i.id LIMIT $${values.length}
    `, values);
    return hydrateIssues(client, result.rows);
  });
}

export async function updateIssue(
  raw: {
    workspaceId: string;
    projectId: string;
    issueId: string;
    expectedRevision: number;
    title?: string;
    description?: unknown;
    parentIssueId?: string | null;
    milestoneId?: string | null;
    cycleId?: string | null;
    priority?: IssuePriority;
    estimatePoints?: number | null;
    startOn?: string | null;
    dueOn?: string | null;
    rank?: number;
    assigneeIds?: string[];
    labelIds?: string[];
  },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<Issue>> {
  validateRevision(raw.expectedRevision);
  const description = raw.description === undefined ? undefined : structuredDescription(raw.description);
  const input = {
    ...raw,
    title: raw.title === undefined ? undefined : boundedTitle(raw.title),
    description: description?.document,
    plainText: description?.plainText,
    estimatePoints: validateEstimate(raw.estimatePoints),
    rank: raw.rank === undefined ? undefined : validateRank(raw.rank),
    assigneeIds: uniqueIds(raw.assigneeIds, "Assignees"),
    labelIds: uniqueIds(raw.labelIds, "Labels"),
  };
  const digestInput = { ...input, descriptionHash: input.description ? requestDigest(input.description) : undefined, description: undefined };
  const operation = "issue.update";
  const digest = requestDigest(digestInput);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<Issue>(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      principalId: context.actorPrincipalId,
      operation,
      key: context.idempotencyKey,
      digest,
    });
    if (replay) return replay;
    await authorizeIssueCapability(client, { ...input, principalId: context.actorPrincipalId, capability: "issue.edit" });
    const current = await client.query<IssueRow>(`${issueQuery}
      WHERE i.workspace_id=$1 AND i.project_id=$2 AND i.id=$3 FOR UPDATE OF i
    `, [input.workspaceId, input.projectId, input.issueId]);
    const row = current.rows[0];
    if (!row) throw new FoundationServiceError("NOT_FOUND", "Issue was not found.");
    const revision = Number(row.revision);
    if (revision !== input.expectedRevision) {
      throw new FoundationServiceError("REVISION_CONFLICT", "Issue changed after it was read.", {
        expectedRevision: input.expectedRevision,
        currentRevision: revision,
      });
    }
    if (row.lifecycle !== "active") throw new FoundationServiceError("CONFLICT", "Archived issues must be restored before editing.");
    if (input.parentIssueId) {
      const parent = await client.query(`SELECT 1 FROM issues
        WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND lifecycle='active'`,
      [input.workspaceId, input.projectId, input.parentIssueId]);
      if (!parent.rows[0]) throw new FoundationServiceError("NOT_FOUND", "Parent issue was not found.");
    }
    const next = {
      title: input.title ?? row.title,
      description: input.description ?? row.description,
      plainText: input.plainText ?? row.plain_text,
      parentIssueId: input.parentIssueId === undefined ? row.parent_issue_id : input.parentIssueId,
      milestoneId: input.milestoneId === undefined ? row.milestone_id : input.milestoneId,
      cycleId: input.cycleId === undefined ? row.cycle_id : input.cycleId,
      priority: input.priority ?? row.priority,
      estimatePoints: input.estimatePoints === undefined
        ? row.estimate_points === null ? null : Number(row.estimate_points)
        : input.estimatePoints,
      startOn: input.startOn === undefined ? row.start_on : input.startOn,
      dueOn: input.dueOn === undefined ? row.due_on : input.dueOn,
      rank: input.rank ?? Number(row.rank),
    };
    const changedFields = Object.entries({
      title: next.title !== row.title,
      description: requestDigest(next.description) !== requestDigest(row.description),
      parentIssueId: next.parentIssueId !== row.parent_issue_id,
      milestoneId: next.milestoneId !== row.milestone_id,
      cycleId: next.cycleId !== row.cycle_id,
      priority: next.priority !== row.priority,
      estimatePoints: next.estimatePoints !== (row.estimate_points === null ? null : Number(row.estimate_points)),
      startOn: next.startOn !== row.start_on,
      dueOn: next.dueOn !== row.due_on,
      rank: next.rank !== Number(row.rank),
      assignees: input.assigneeIds !== undefined,
      labels: input.labelIds !== undefined,
    }).filter(([, changed]) => changed).map(([field]) => field);
    if (!changedFields.length) throw new FoundationServiceError("CONFLICT", "Issue update contains no changes.");
    const now = new Date();
    await client.query(`UPDATE issues SET title=$1,description=$2,plain_text=$3,parent_issue_id=$4,
      milestone_id=$5,cycle_id=$6,priority=$7,estimate_points=$8,start_on=$9,due_on=$10,
      rank=$11,revision=revision+1,updated_by_principal_id=$12,updated_at=$13
      WHERE workspace_id=$14 AND project_id=$15 AND id=$16`, [next.title, next.description,
      next.plainText, next.parentIssueId, next.milestoneId, next.cycleId, next.priority,
      next.estimatePoints, next.startOn, next.dueOn, next.rank, context.actorPrincipalId, now,
      input.workspaceId, input.projectId, input.issueId]);
    if (input.assigneeIds !== undefined) {
      await replaceAssignments(client, { ...input, principalIds: input.assigneeIds, actorPrincipalId: context.actorPrincipalId });
    }
    if (input.labelIds !== undefined) {
      await replaceLabels(client, { ...input, labelIds: input.labelIds, actorPrincipalId: context.actorPrincipalId });
    }
    const updated = await client.query<IssueRow>(`${issueQuery} WHERE i.id=$1`, [input.issueId]);
    const data = (await hydrateIssues(client, updated.rows))[0]!;
    return recordMutation(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      context,
      operation,
      digest,
      action: operation,
      targetType: "issue",
      targetId: input.issueId,
      aggregateType: "issue",
      aggregateRevision: revision + 1,
      eventType: "issue.updated.v1",
      inputSummary: { expectedRevision: input.expectedRevision, changedFields },
      resultSummary: { issueId: input.issueId, revision: revision + 1, priority: next.priority },
      data,
    });
  });
}

export async function transitionIssue(
  raw: {
    workspaceId: string;
    projectId: string;
    issueId: string;
    expectedRevision: number;
    targetStatusId: string;
    comment?: string;
  },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<Issue>> {
  validateRevision(raw.expectedRevision);
  const comment = raw.comment?.trim();
  if (comment && comment.length > 20_000) throw new FoundationServiceError("VALIDATION_FAILED", "Transition comment is too long.");
  const input = { ...raw, comment };
  const operation = "issue.transition";
  const digest = requestDigest({ ...input, commentHash: comment ? requestDigest(comment) : undefined, comment: undefined });
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<Issue>(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      principalId: context.actorPrincipalId,
      operation,
      key: context.idempotencyKey,
      digest,
    });
    if (replay) return replay;
    await authorizeIssueCapability(client, { ...input, principalId: context.actorPrincipalId, capability: "issue.transition" });
    const current = await client.query<IssueRow>(`${issueQuery}
      WHERE i.workspace_id=$1 AND i.project_id=$2 AND i.id=$3 FOR UPDATE OF i
    `, [input.workspaceId, input.projectId, input.issueId]);
    const row = current.rows[0];
    if (!row) throw new FoundationServiceError("NOT_FOUND", "Issue was not found.");
    const revision = Number(row.revision);
    if (revision !== input.expectedRevision) {
      throw new FoundationServiceError("REVISION_CONFLICT", "Issue changed after it was read.", {
        expectedRevision: input.expectedRevision,
        currentRevision: revision,
      });
    }
    if (row.lifecycle !== "active") throw new FoundationServiceError("CONFLICT", "Archived issues cannot transition.");
    if (row.status_id === input.targetStatusId) throw new FoundationServiceError("CONFLICT", "Issue already has the requested status.");
    const transition = await client.query<{ requires_comment: boolean }>(`
      SELECT requires_comment FROM issue_workflow_transitions
      WHERE workspace_id=$1 AND project_id=$2 AND workflow_id=$3
        AND from_status_id=$4 AND to_status_id=$5 AND archived_at IS NULL
    `, [input.workspaceId, input.projectId, row.workflow_id, row.status_id, input.targetStatusId]);
    if (!transition.rows[0]) {
      throw new FoundationServiceError("CONFLICT", "The workflow does not allow this transition.", {
        fromStatusId: row.status_id,
        toStatusId: input.targetStatusId,
      });
    }
    if (transition.rows[0].requires_comment && !comment) {
      throw new FoundationServiceError("VALIDATION_FAILED", "This workflow transition requires a comment.");
    }
    const now = new Date();
    await client.query(`UPDATE issues SET status_id=$1,revision=revision+1,
      updated_by_principal_id=$2,updated_at=$3 WHERE id=$4`,
    [input.targetStatusId, context.actorPrincipalId, now, input.issueId]);
    if (comment) {
      await client.query(`INSERT INTO issue_comments(
        id,workspace_id,project_id,issue_id,body,plain_text,author_principal_id,created_at,updated_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)`, [newFolioId(), input.workspaceId,
        input.projectId, input.issueId, { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: comment }] }] },
        comment, context.actorPrincipalId, now]);
    }
    const updated = await client.query<IssueRow>(`${issueQuery} WHERE i.id=$1`, [input.issueId]);
    const data = (await hydrateIssues(client, updated.rows))[0]!;
    return recordMutation(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      context,
      operation,
      digest,
      action: operation,
      targetType: "issue",
      targetId: input.issueId,
      aggregateType: "issue",
      aggregateRevision: revision + 1,
      eventType: "issue.transitioned.v1",
      inputSummary: { expectedRevision: input.expectedRevision, fromStatusId: row.status_id, toStatusId: input.targetStatusId, commentProvided: Boolean(comment) },
      resultSummary: { issueId: input.issueId, statusId: input.targetStatusId, revision: revision + 1 },
      data,
    });
  });
}

async function changeIssueLifecycle(
  raw: { workspaceId: string; projectId: string; issueId: string; expectedRevision: number; lifecycle: IssueLifecycle },
  context: MutationContext,
  pool: Pool,
): Promise<MutationResult<Issue>> {
  validateRevision(raw.expectedRevision);
  const operation = raw.lifecycle === "archived" ? "issue.archive" : "issue.restore";
  const digest = requestDigest(raw);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, raw.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<Issue>(client, {
      workspaceId: raw.workspaceId,
      projectId: raw.projectId,
      principalId: context.actorPrincipalId,
      operation,
      key: context.idempotencyKey,
      digest,
    });
    if (replay) return replay;
    await authorizeIssueCapability(client, { ...raw, principalId: context.actorPrincipalId, capability: "issue.archive" });
    const current = await client.query<IssueRow>(`${issueQuery}
      WHERE i.workspace_id=$1 AND i.project_id=$2 AND i.id=$3 FOR UPDATE OF i
    `, [raw.workspaceId, raw.projectId, raw.issueId]);
    const row = current.rows[0];
    if (!row) throw new FoundationServiceError("NOT_FOUND", "Issue was not found.");
    const revision = Number(row.revision);
    if (revision !== raw.expectedRevision) {
      throw new FoundationServiceError("REVISION_CONFLICT", "Issue changed after it was read.", {
        expectedRevision: raw.expectedRevision,
        currentRevision: revision,
      });
    }
    if (row.lifecycle === raw.lifecycle) throw new FoundationServiceError("CONFLICT", `Issue is already ${raw.lifecycle}.`);
    if (raw.lifecycle === "archived") {
      const activeChildren = await client.query<{ count: string }>(`
        SELECT count(*)::text count FROM issues
        WHERE workspace_id=$1 AND project_id=$2 AND parent_issue_id=$3 AND lifecycle='active'
      `, [raw.workspaceId, raw.projectId, raw.issueId]);
      if (Number(activeChildren.rows[0]?.count ?? 0) > 0) {
        throw new FoundationServiceError("CONFLICT", "Archive child issues first or use a bulk archive preview.", {
          activeChildCount: Number(activeChildren.rows[0]!.count),
        });
      }
    }
    const now = new Date();
    await client.query(`UPDATE issues SET lifecycle=$1,revision=revision+1,
      archived_at=$2,archived_by_principal_id=$3,updated_by_principal_id=$3,updated_at=$4
      WHERE id=$5`, [raw.lifecycle, raw.lifecycle === "archived" ? now : null,
      raw.lifecycle === "archived" ? context.actorPrincipalId : null, now, raw.issueId]);
    const updated = await client.query<IssueRow>(`${issueQuery} WHERE i.id=$1`, [raw.issueId]);
    const data = (await hydrateIssues(client, updated.rows))[0]!;
    return recordMutation(client, {
      workspaceId: raw.workspaceId,
      projectId: raw.projectId,
      context,
      operation,
      digest,
      action: operation,
      targetType: "issue",
      targetId: raw.issueId,
      aggregateType: "issue",
      aggregateRevision: revision + 1,
      eventType: raw.lifecycle === "archived" ? "issue.archived.v1" : "issue.restored.v1",
      inputSummary: { expectedRevision: raw.expectedRevision },
      resultSummary: { issueId: raw.issueId, lifecycle: raw.lifecycle, revision: revision + 1 },
      data,
    });
  });
}

export function archiveIssue(
  raw: { workspaceId: string; projectId: string; issueId: string; expectedRevision: number },
  context: MutationContext,
  pool: Pool = postgresPool(),
) {
  return changeIssueLifecycle({ ...raw, lifecycle: "archived" }, context, pool);
}

export function restoreIssue(
  raw: { workspaceId: string; projectId: string; issueId: string; expectedRevision: number },
  context: MutationContext,
  pool: Pool = postgresPool(),
) {
  return changeIssueLifecycle({ ...raw, lifecycle: "active" }, context, pool);
}

export async function getIssueRevision(
  client: PoolClient,
  input: { workspaceId: string; projectId: string; issueId: string },
): Promise<number> {
  return (await assertIssueExists(client, input.workspaceId, input.projectId, input.issueId)).revision;
}
