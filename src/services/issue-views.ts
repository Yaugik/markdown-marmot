import type { Pool } from "pg";
import { postgresPool } from "@/db/postgres";
import { establishTenantContext } from "@/db/tenant";
import { newFolioId } from "@/lib/folio-ids";
import { authorizeIssueCapability, authorizeSavedViewRead } from "@/services/issue-access";
import { listIssues, type Issue, type IssuePriority } from "@/services/issues";
import { FoundationServiceError } from "@/services/foundation/errors";
import {
  findIdempotentResult,
  inTransaction,
  lockIdempotencyKey,
  recordMutation,
  requestDigest,
} from "@/services/foundation/internal";
import type { MutationContext, MutationResult } from "@/services/foundation/types";

export type IssueProjectionKind = "list" | "board" | "timeline" | "calendar";
export type IssueViewFilters = {
  includeArchived?: boolean;
  statusIds?: string[];
  labelIds?: string[];
  assigneeIds?: string[];
  priorities?: IssuePriority[];
  milestoneId?: string | null;
  cycleId?: string | null;
  parentIssueId?: string | null;
  query?: string;
};
export type IssueViewGrouping = { field?: "status" | "priority" | "assignee" | "label" | "milestone" | "cycle" | "none" };
export type IssueViewOrdering = Array<{ field: "rank" | "priority" | "dueOn" | "startOn" | "createdAt" | "updatedAt" | "issueNumber" | "title"; direction: "asc" | "desc" }>;
export type IssueSavedView = {
  id: string;
  workspaceId: string;
  projectId: string;
  ownerPrincipalId: string;
  name: string;
  visibility: "private" | "project";
  projection: IssueProjectionKind;
  filters: IssueViewFilters;
  grouping: IssueViewGrouping;
  ordering: IssueViewOrdering;
  revision: number;
  createdAt: string;
  updatedAt: string;
};
export type IssueProjection = {
  kind: IssueProjectionKind;
  viewId: string | null;
  total: number;
  issues: Issue[];
  groups: Array<{ key: string; label: string; issueIds: string[] }>;
  timeline: Array<{ issueId: string; startOn: string | null; dueOn: string | null }>;
  calendar: Array<{ date: string; starts: string[]; due: string[] }>;
};

type ViewRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  owner_principal_id: string;
  name: string;
  visibility: "private" | "project";
  projection: IssueProjectionKind;
  filters: IssueViewFilters;
  grouping: IssueViewGrouping;
  ordering: IssueViewOrdering;
  revision: string;
  created_at: Date;
  updated_at: Date;
};

const viewQuery = `SELECT id,workspace_id,project_id,owner_principal_id,name,visibility,
  projection,filters,grouping,ordering,revision,created_at,updated_at FROM issue_saved_views`;

function mapView(row: ViewRow): IssueSavedView {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    ownerPrincipalId: row.owner_principal_id,
    name: row.name,
    visibility: row.visibility,
    projection: row.projection,
    filters: row.filters ?? {},
    grouping: row.grouping ?? {},
    ordering: row.ordering ?? [],
    revision: Number(row.revision),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function validateName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 120) throw new FoundationServiceError("VALIDATION_FAILED", "Saved view name must contain 1 to 120 characters.");
  return name;
}

function validateIds(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new FoundationServiceError("VALIDATION_FAILED", `${label} must be an array of IDs.`);
  }
  const unique = [...new Set(value as string[])];
  if (unique.length > 100) throw new FoundationServiceError("VALIDATION_FAILED", `${label} is limited to 100 values.`);
  return unique;
}

function validateFilters(raw: IssueViewFilters | undefined): IssueViewFilters {
  const filters = raw ?? {};
  const query = filters.query?.trim();
  if (query && query.length > 500) throw new FoundationServiceError("VALIDATION_FAILED", "Saved view query is too long.");
  return {
    includeArchived: filters.includeArchived ?? false,
    statusIds: validateIds(filters.statusIds, "Status filters"),
    labelIds: validateIds(filters.labelIds, "Label filters"),
    assigneeIds: validateIds(filters.assigneeIds, "Assignee filters"),
    priorities: filters.priorities,
    milestoneId: filters.milestoneId,
    cycleId: filters.cycleId,
    parentIssueId: filters.parentIssueId,
    query: query || undefined,
  };
}

function validateGrouping(raw: IssueViewGrouping | undefined): IssueViewGrouping {
  const field = raw?.field ?? "none";
  if (!["status", "priority", "assignee", "label", "milestone", "cycle", "none"].includes(field)) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Saved view grouping is invalid.");
  }
  return { field };
}

function validateOrdering(raw: IssueViewOrdering | undefined): IssueViewOrdering {
  const ordering = raw?.length ? raw : [{ field: "rank", direction: "asc" }];
  if (ordering.length > 5) throw new FoundationServiceError("VALIDATION_FAILED", "Saved views support at most five ordering clauses.");
  for (const item of ordering) {
    if (!["rank", "priority", "dueOn", "startOn", "createdAt", "updatedAt", "issueNumber", "title"].includes(item.field)
      || !["asc", "desc"].includes(item.direction)) {
      throw new FoundationServiceError("VALIDATION_FAILED", "Saved view ordering is invalid.");
    }
  }
  return ordering;
}

function priorityWeight(priority: IssuePriority): number {
  return { urgent: 0, high: 1, medium: 2, low: 3, no_priority: 4 }[priority];
}

function orderIssues(issues: Issue[], ordering: IssueViewOrdering): Issue[] {
  return [...issues].sort((left, right) => {
    for (const clause of ordering) {
      let comparison = 0;
      if (clause.field === "priority") comparison = priorityWeight(left.priority) - priorityWeight(right.priority);
      else if (clause.field === "rank" || clause.field === "issueNumber") comparison = left[clause.field] - right[clause.field];
      else {
        const leftValue = left[clause.field] ?? "";
        const rightValue = right[clause.field] ?? "";
        comparison = String(leftValue).localeCompare(String(rightValue));
      }
      if (comparison !== 0) return clause.direction === "asc" ? comparison : -comparison;
    }
    return left.id.localeCompare(right.id);
  });
}

function groupIssues(issues: Issue[], field: IssueViewGrouping["field"]): IssueProjection["groups"] {
  if (!field || field === "none") return [{ key: "all", label: "All issues", issueIds: issues.map((issue) => issue.id) }];
  const groups = new Map<string, { label: string; ids: string[] }>();
  const add = (key: string, label: string, issueId: string) => {
    const group = groups.get(key) ?? { label, ids: [] };
    group.ids.push(issueId);
    groups.set(key, group);
  };
  for (const issue of issues) {
    if (field === "status") add(issue.status.id, issue.status.name, issue.id);
    else if (field === "priority") add(issue.priority, issue.priority.replaceAll("_", " "), issue.id);
    else if (field === "milestone") add(issue.milestoneId ?? "none", issue.milestoneId ? "Milestone" : "No milestone", issue.id);
    else if (field === "cycle") add(issue.cycleId ?? "none", issue.cycleId ? "Cycle" : "No cycle", issue.id);
    else if (field === "assignee") {
      if (!issue.assignees.length) add("none", "Unassigned", issue.id);
      for (const assignee of issue.assignees) add(assignee.principalId, assignee.displayName, issue.id);
    } else if (field === "label") {
      if (!issue.labels.length) add("none", "No labels", issue.id);
      for (const label of issue.labels) add(label.id, label.name, issue.id);
    }
  }
  return [...groups.entries()].map(([key, group]) => ({ key, label: group.label, issueIds: group.ids }));
}

function projectIssues(
  issues: Issue[],
  input: { kind: IssueProjectionKind; viewId?: string | null; grouping: IssueViewGrouping; ordering: IssueViewOrdering },
): IssueProjection {
  const ordered = orderIssues(issues, input.ordering);
  const calendarMap = new Map<string, { starts: string[]; due: string[] }>();
  for (const issue of ordered) {
    if (issue.startOn) {
      const entry = calendarMap.get(issue.startOn) ?? { starts: [], due: [] };
      entry.starts.push(issue.id);
      calendarMap.set(issue.startOn, entry);
    }
    if (issue.dueOn) {
      const entry = calendarMap.get(issue.dueOn) ?? { starts: [], due: [] };
      entry.due.push(issue.id);
      calendarMap.set(issue.dueOn, entry);
    }
  }
  return {
    kind: input.kind,
    viewId: input.viewId ?? null,
    total: ordered.length,
    issues: ordered,
    groups: groupIssues(ordered, input.kind === "board" && input.grouping.field === "none" ? "status" : input.grouping.field),
    timeline: ordered.filter((issue) => issue.startOn || issue.dueOn).map((issue) => ({ issueId: issue.id, startOn: issue.startOn, dueOn: issue.dueOn })),
    calendar: [...calendarMap.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([date, entry]) => ({ date, starts: entry.starts, due: entry.due })),
  };
}

export async function listIssueSavedViews(
  input: { workspaceId: string; projectId: string },
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<IssueSavedView[]> {
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, principalId);
    await authorizeIssueCapability(client, { ...input, principalId, capability: "issue.read" });
    const result = await client.query<ViewRow>(`${viewQuery}
      WHERE workspace_id=$1 AND project_id=$2 AND archived_at IS NULL
        AND (visibility='project' OR owner_principal_id=$3 OR EXISTS (
          SELECT 1 FROM object_grants grant
          WHERE grant.workspace_id=$1 AND grant.project_id=$2 AND grant.principal_id=$3
            AND grant.object_type='saved_view' AND grant.object_id=issue_saved_views.id
            AND grant.capabilities @> ARRAY['issue.read']::text[]
            AND (grant.valid_until IS NULL OR grant.valid_until>now())
        ))
      ORDER BY visibility DESC,lower(name),id
    `, [input.workspaceId, input.projectId, principalId]);
    return result.rows.map(mapView);
  });
}

export async function createIssueSavedView(
  raw: {
    workspaceId: string;
    projectId: string;
    name: string;
    visibility?: IssueSavedView["visibility"];
    projection?: IssueProjectionKind;
    filters?: IssueViewFilters;
    grouping?: IssueViewGrouping;
    ordering?: IssueViewOrdering;
  },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<IssueSavedView>> {
  const input = {
    ...raw,
    name: validateName(raw.name),
    visibility: raw.visibility ?? "private" as IssueSavedView["visibility"],
    projection: raw.projection ?? "list" as IssueProjectionKind,
    filters: validateFilters(raw.filters),
    grouping: validateGrouping(raw.grouping),
    ordering: validateOrdering(raw.ordering),
  };
  const operation = "issue_saved_view.create";
  const digest = requestDigest(input);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<IssueSavedView>(client, { workspaceId: input.workspaceId, projectId: input.projectId, principalId: context.actorPrincipalId, operation, key: context.idempotencyKey, digest });
    if (replay) return replay;
    await authorizeIssueCapability(client, { ...input, principalId: context.actorPrincipalId, capability: input.visibility === "project" ? "project.update" : "issue.read" });
    const id = newFolioId(); const now = new Date();
    const result = await client.query<ViewRow>(`INSERT INTO issue_saved_views(
      id,workspace_id,project_id,owner_principal_id,name,visibility,projection,filters,
      grouping,ordering,created_at,updated_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
    RETURNING id,workspace_id,project_id,owner_principal_id,name,visibility,projection,
      filters,grouping,ordering,revision,created_at,updated_at`, [id, input.workspaceId, input.projectId, context.actorPrincipalId, input.name, input.visibility, input.projection, input.filters, input.grouping, input.ordering, now]);
    const data = mapView(result.rows[0]!);
    return recordMutation(client, { workspaceId: input.workspaceId, projectId: input.projectId, context, operation, digest, action: operation, targetType: "saved_view", targetId: id, aggregateType: "saved_view", aggregateRevision: 1, eventType: "issue_saved_view.created.v1", inputSummary: { name: input.name, visibility: input.visibility, projection: input.projection }, resultSummary: { viewId: id }, data });
  });
}

export async function updateIssueSavedView(
  raw: {
    workspaceId: string;
    projectId: string;
    viewId: string;
    expectedRevision: number;
    name?: string;
    visibility?: IssueSavedView["visibility"];
    projection?: IssueProjectionKind;
    filters?: IssueViewFilters;
    grouping?: IssueViewGrouping;
    ordering?: IssueViewOrdering;
  },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<IssueSavedView>> {
  if (!Number.isSafeInteger(raw.expectedRevision) || raw.expectedRevision < 1) throw new FoundationServiceError("VALIDATION_FAILED", "Expected revision must be positive.");
  const input = {
    ...raw,
    name: raw.name === undefined ? undefined : validateName(raw.name),
    filters: raw.filters === undefined ? undefined : validateFilters(raw.filters),
    grouping: raw.grouping === undefined ? undefined : validateGrouping(raw.grouping),
    ordering: raw.ordering === undefined ? undefined : validateOrdering(raw.ordering),
  };
  const operation = "issue_saved_view.update"; const digest = requestDigest(input);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<IssueSavedView>(client, { workspaceId: input.workspaceId, projectId: input.projectId, principalId: context.actorPrincipalId, operation, key: context.idempotencyKey, digest });
    if (replay) return replay;
    const current = await client.query<ViewRow>(`${viewQuery}
      WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND archived_at IS NULL FOR UPDATE`, [input.workspaceId, input.projectId, input.viewId]);
    const row = current.rows[0];
    if (!row) throw new FoundationServiceError("NOT_FOUND", "Saved view was not found.");
    if (row.owner_principal_id !== context.actorPrincipalId) {
      await authorizeIssueCapability(client, { ...input, principalId: context.actorPrincipalId, capability: "project.update" });
    }
    const revision = Number(row.revision);
    if (revision !== input.expectedRevision) throw new FoundationServiceError("REVISION_CONFLICT", "Saved view changed after it was read.", { expectedRevision: input.expectedRevision, currentRevision: revision });
    const next = {
      name: input.name ?? row.name,
      visibility: input.visibility ?? row.visibility,
      projection: input.projection ?? row.projection,
      filters: input.filters ?? row.filters,
      grouping: input.grouping ?? row.grouping,
      ordering: input.ordering ?? row.ordering,
    };
    const now = new Date();
    const result = await client.query<ViewRow>(`UPDATE issue_saved_views SET name=$1,visibility=$2,
      projection=$3,filters=$4,grouping=$5,ordering=$6,revision=revision+1,updated_at=$7
      WHERE id=$8 RETURNING id,workspace_id,project_id,owner_principal_id,name,visibility,
      projection,filters,grouping,ordering,revision,created_at,updated_at`, [next.name, next.visibility, next.projection, next.filters, next.grouping, next.ordering, now, input.viewId]);
    const data = mapView(result.rows[0]!);
    return recordMutation(client, { workspaceId: input.workspaceId, projectId: input.projectId, context, operation, digest, action: operation, targetType: "saved_view", targetId: input.viewId, aggregateType: "saved_view", aggregateRevision: revision + 1, eventType: "issue_saved_view.updated.v1", inputSummary: { expectedRevision: input.expectedRevision, projection: next.projection }, resultSummary: { viewId: input.viewId, revision: revision + 1 }, data });
  });
}

export async function executeIssueProjection(
  input: {
    workspaceId: string;
    projectId: string;
    viewId?: string;
    projection?: IssueProjectionKind;
    filters?: IssueViewFilters;
    grouping?: IssueViewGrouping;
    ordering?: IssueViewOrdering;
  },
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<IssueProjection> {
  let settings: { kind: IssueProjectionKind; viewId: string | null; filters: IssueViewFilters; grouping: IssueViewGrouping; ordering: IssueViewOrdering };
  if (input.viewId) {
    const view = await inTransaction(pool, async (client) => {
      await establishTenantContext(client, input.workspaceId, principalId);
      const result = await client.query<ViewRow>(`${viewQuery}
        WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND archived_at IS NULL`, [input.workspaceId, input.projectId, input.viewId]);
      const row = result.rows[0];
      if (!row) throw new FoundationServiceError("NOT_FOUND", "Saved view was not found.");
      await authorizeSavedViewRead(client, { workspaceId: input.workspaceId, projectId: input.projectId, principalId, viewId: input.viewId!, ownerPrincipalId: row.owner_principal_id, visibility: row.visibility });
      return mapView(row);
    });
    settings = { kind: view.projection, viewId: view.id, filters: view.filters, grouping: view.grouping, ordering: view.ordering };
  } else {
    settings = {
      kind: input.projection ?? "list",
      viewId: null,
      filters: validateFilters(input.filters),
      grouping: validateGrouping(input.grouping),
      ordering: validateOrdering(input.ordering),
    };
  }
  const issues = await listIssues({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    ...settings.filters,
    limit: 500,
  }, principalId, pool);
  return projectIssues(issues, settings);
}
