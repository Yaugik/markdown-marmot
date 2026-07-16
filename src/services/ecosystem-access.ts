import type { PoolClient } from "pg";
import { evaluateProjectCapability, type ProjectCapability } from "@/auth/capabilities";
import { authorizeIssueCapability } from "@/services/issue-access";
import { authorizePageCapability } from "@/services/page-access";
import { FoundationServiceError } from "@/services/foundation/errors";
import { authorizeScheduleObject, readCalendarPolicy, readTodoListPolicy } from "@/services/schedule-access";

export type EcosystemObjectType = "graph_view" | "canvas" | "audit_export";
export type GraphEntityType = "page" | "issue" | "todo" | "calendar_entry" | "canvas";

type AccessRow = {
  workspace_status: string;
  project_status: string;
  membership_status: string;
  capabilities: string[];
};

async function accessRow(
  client: PoolClient,
  workspaceId: string,
  projectId: string,
  principalId: string,
): Promise<AccessRow> {
  const result = await client.query<AccessRow>(`
    SELECT w.status workspace_status,p.status project_status,pm.status membership_status,rt.capabilities
    FROM projects p
    JOIN workspaces w ON w.id=p.workspace_id
    JOIN project_memberships pm ON pm.workspace_id=p.workspace_id AND pm.project_id=p.id AND pm.principal_id=$3
    JOIN workspace_memberships wm ON wm.workspace_id=p.workspace_id AND wm.principal_id=pm.principal_id
    JOIN role_templates rt ON rt.workspace_id=pm.workspace_id AND rt.id=pm.role_template_id
    WHERE p.workspace_id=$1 AND p.id=$2 AND wm.status='active' AND pm.status='active'
      AND rt.archived_at IS NULL
  `, [workspaceId,projectId,principalId]);
  const row = result.rows[0];
  if (!row) throw new FoundationServiceError("CAPABILITY_DENIED", "Active project membership is required.");
  return row;
}

async function grantSets(
  client: PoolClient,
  input: {
    workspaceId: string;
    projectId: string;
    principalId: string;
    capability: ProjectCapability;
    objectType?: EcosystemObjectType;
    objectId?: string;
  },
): Promise<{ allowed: Set<ProjectCapability>; denied: Set<ProjectCapability>; objectGranted: boolean }> {
  const grants = await client.query<{ capability: ProjectCapability; effect: "allow" | "deny" }>(`
    SELECT capability,effect FROM capability_grants
    WHERE workspace_id=$1 AND (project_id=$2 OR project_id IS NULL)
      AND principal_id=$3 AND capability=$4
      AND valid_from<=now() AND (valid_until IS NULL OR valid_until>now())
  `, [input.workspaceId,input.projectId,input.principalId,input.capability]);
  const allowed = new Set<ProjectCapability>(grants.rows.filter((row) => row.effect === "allow").map((row) => row.capability));
  const denied = new Set<ProjectCapability>(grants.rows.filter((row) => row.effect === "deny").map((row) => row.capability));
  let objectGranted = false;
  if (input.objectType && input.objectId) {
    const object = await client.query<{ capabilities: ProjectCapability[] }>(`
      SELECT capabilities FROM object_grants
      WHERE workspace_id=$1 AND project_id=$2 AND principal_id=$3
        AND object_type=$4 AND object_id=$5
        AND (valid_until IS NULL OR valid_until>now())
    `, [input.workspaceId,input.projectId,input.principalId,input.objectType,input.objectId]);
    for (const capability of object.rows[0]?.capabilities ?? []) {
      allowed.add(capability);
      if (capability === input.capability) objectGranted = true;
    }
  }
  return { allowed, denied, objectGranted };
}

export async function authorizeEcosystemProjectCapability(
  client: PoolClient,
  input: { workspaceId: string; projectId: string; principalId: string; capability: ProjectCapability },
): Promise<void> {
  const row = await accessRow(client,input.workspaceId,input.projectId,input.principalId);
  const sets = await grantSets(client,input);
  const decision = evaluateProjectCapability({
    capability: input.capability,
    workspaceActive: row.workspace_status === "active",
    projectActive: row.project_status === "active",
    membershipActive: row.membership_status === "active",
    roleCapabilities: new Set(row.capabilities as ProjectCapability[]),
    allowedGrants: sets.allowed,
    deniedGrants: sets.denied,
  });
  if (!decision.allowed) throw new FoundationServiceError("CAPABILITY_DENIED", "The ecosystem capability is not permitted.", {
    capability: input.capability,
    reason: decision.reason,
  });
}

export async function authorizeWorkspaceOwner(
  client: PoolClient,
  input: { workspaceId: string; principalId: string },
): Promise<void> {
  const result = await client.query(`
    SELECT 1 FROM workspaces w
    JOIN workspace_memberships wm ON wm.workspace_id=w.id
    WHERE w.id=$1 AND w.status='active' AND wm.principal_id=$2
      AND wm.role='owner' AND wm.status='active'
  `, [input.workspaceId,input.principalId]);
  if (!result.rows[0]) throw new FoundationServiceError("CAPABILITY_DENIED", "An active workspace owner is required.");
}

export async function authorizeOwnedEcosystemObject(
  client: PoolClient,
  input: {
    workspaceId: string;
    projectId: string;
    principalId: string;
    capability: ProjectCapability;
    objectType: "graph_view" | "canvas";
    objectId: string;
    ownerPrincipalId: string;
    visibility: "private" | "project";
  },
): Promise<void> {
  const row = await accessRow(client,input.workspaceId,input.projectId,input.principalId);
  const sets = await grantSets(client,input);
  const decision = evaluateProjectCapability({
    capability: input.capability,
    workspaceActive: row.workspace_status === "active",
    projectActive: row.project_status === "active",
    membershipActive: row.membership_status === "active",
    roleCapabilities: new Set(row.capabilities as ProjectCapability[]),
    allowedGrants: sets.allowed,
    deniedGrants: sets.denied,
  });
  const ownerAllowed = input.ownerPrincipalId === input.principalId && decision.allowed;
  const projectAllowed = input.visibility === "project" && decision.allowed;
  const objectAllowed = sets.objectGranted && !sets.denied.has(input.capability);
  if (!ownerAllowed && !projectAllowed && !objectAllowed) {
    throw new FoundationServiceError("NOT_FOUND", "The requested object was not found.");
  }
}

export async function readCanvasPolicy(
  client: PoolClient,
  input: { workspaceId: string; projectId: string; canvasId: string },
): Promise<{ ownerPrincipalId: string; visibility: "private" | "project"; revision: number; archived: boolean }> {
  const result = await client.query<{
    owner_principal_id: string; visibility: "private" | "project"; revision: string; archived_at: Date | null;
  }>(`
    SELECT owner_principal_id,visibility,revision,archived_at FROM canvases
    WHERE workspace_id=$1 AND project_id=$2 AND id=$3
  `, [input.workspaceId,input.projectId,input.canvasId]);
  const row = result.rows[0];
  if (!row) throw new FoundationServiceError("NOT_FOUND", "Canvas was not found.");
  return { ownerPrincipalId: row.owner_principal_id, visibility: row.visibility, revision: Number(row.revision), archived: row.archived_at !== null };
}

export async function readGraphViewPolicy(
  client: PoolClient,
  input: { workspaceId: string; projectId: string; viewId: string },
): Promise<{ ownerPrincipalId: string; visibility: "private" | "project"; revision: number; archived: boolean }> {
  const result = await client.query<{
    owner_principal_id: string; visibility: "private" | "project"; revision: string; archived_at: Date | null;
  }>(`
    SELECT owner_principal_id,visibility,revision,archived_at FROM saved_graph_views
    WHERE workspace_id=$1 AND project_id=$2 AND id=$3
  `, [input.workspaceId,input.projectId,input.viewId]);
  const row = result.rows[0];
  if (!row) throw new FoundationServiceError("NOT_FOUND", "Graph view was not found.");
  return { ownerPrincipalId: row.owner_principal_id, visibility: row.visibility, revision: Number(row.revision), archived: row.archived_at !== null };
}

export async function authorizeGraphEntityRead(
  client: PoolClient,
  input: { workspaceId: string; projectId: string; principalId: string; entityType: GraphEntityType; entityId: string },
): Promise<void> {
  if (input.entityType === "page") {
    await authorizePageCapability(client,{ ...input, capability: "page.read", pageId: input.entityId });
    return;
  }
  if (input.entityType === "issue") {
    await authorizeIssueCapability(client,{ ...input, capability: "issue.read", issueId: input.entityId });
    return;
  }
  if (input.entityType === "todo") {
    const todo = await client.query<{ list_id: string }>(`
      SELECT list_id FROM todos WHERE workspace_id=$1 AND project_id=$2 AND id=$3
    `, [input.workspaceId,input.projectId,input.entityId]);
    if (!todo.rows[0]) throw new FoundationServiceError("NOT_FOUND", "To-do was not found.");
    const policy = await readTodoListPolicy(client,{ ...input, listId: todo.rows[0].list_id });
    await authorizeScheduleObject(client,{
      ...input, capability: "todo.read", objectType: "todo_list", objectId: todo.rows[0].list_id,
      ownerPrincipalId: policy.ownerPrincipalId, visibility: policy.visibility,
    });
    return;
  }
  if (input.entityType === "calendar_entry") {
    const entry = await client.query<{ calendar_id: string }>(`
      SELECT calendar_id FROM calendar_entries WHERE workspace_id=$1 AND project_id=$2 AND id=$3
    `, [input.workspaceId,input.projectId,input.entityId]);
    if (!entry.rows[0]) throw new FoundationServiceError("NOT_FOUND", "Calendar entry was not found.");
    const policy = await readCalendarPolicy(client,{ ...input, calendarId: entry.rows[0].calendar_id });
    await authorizeScheduleObject(client,{
      ...input, capability: "calendar.read", objectType: "calendar", objectId: entry.rows[0].calendar_id,
      ownerPrincipalId: policy.ownerPrincipalId, visibility: policy.visibility,
    });
    return;
  }
  const policy = await readCanvasPolicy(client,{ ...input, canvasId: input.entityId });
  await authorizeOwnedEcosystemObject(client,{
    ...input, capability: "canvas.read", objectType: "canvas", objectId: input.entityId,
    ownerPrincipalId: policy.ownerPrincipalId, visibility: policy.visibility,
  });
}
