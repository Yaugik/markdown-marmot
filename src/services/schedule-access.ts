import type { PoolClient } from "pg";
import { evaluateProjectCapability, type ProjectCapability } from "@/auth/capabilities";
import { FoundationServiceError } from "@/services/foundation/errors";

type AccessRow = {
  workspace_status: string;
  project_status: string;
  membership_status: string;
  capabilities: string[];
};

type ScheduleObjectType = "todo_list" | "calendar";

async function accessRow(
  client: PoolClient,
  workspaceId: string,
  projectId: string,
  principalId: string,
): Promise<AccessRow> {
  const result = await client.query<AccessRow>(`
    SELECT w.status workspace_status, p.status project_status,
      pm.status membership_status, rt.capabilities
    FROM projects p
    JOIN workspaces w ON w.id = p.workspace_id
    JOIN project_memberships pm
      ON pm.workspace_id = p.workspace_id AND pm.project_id = p.id
      AND pm.principal_id = $3
    JOIN workspace_memberships wm
      ON wm.workspace_id = p.workspace_id AND wm.principal_id = pm.principal_id
    JOIN role_templates rt
      ON rt.workspace_id = pm.workspace_id AND rt.id = pm.role_template_id
    WHERE p.workspace_id = $1 AND p.id = $2
      AND wm.status = 'active' AND pm.status = 'active'
      AND rt.archived_at IS NULL
  `, [workspaceId, projectId, principalId]);
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
    objectType?: ScheduleObjectType;
    objectId?: string;
  },
): Promise<{ allowed: Set<ProjectCapability>; denied: Set<ProjectCapability>; objectGranted: boolean }> {
  const grants = await client.query<{ capability: ProjectCapability; effect: "allow" | "deny" }>(`
    SELECT capability, effect
    FROM capability_grants
    WHERE workspace_id = $1 AND (project_id = $2 OR project_id IS NULL)
      AND principal_id = $3 AND capability = $4
      AND valid_from <= now() AND (valid_until IS NULL OR valid_until > now())
  `, [input.workspaceId, input.projectId, input.principalId, input.capability]);
  const allowed = new Set<ProjectCapability>(
    grants.rows.filter((grant) => grant.effect === "allow").map((grant) => grant.capability),
  );
  const denied = new Set<ProjectCapability>(
    grants.rows.filter((grant) => grant.effect === "deny").map((grant) => grant.capability),
  );
  let objectGranted = false;
  if (input.objectType && input.objectId) {
    const objectGrant = await client.query<{ capabilities: ProjectCapability[] }>(`
      SELECT capabilities
      FROM object_grants
      WHERE workspace_id = $1 AND project_id = $2 AND principal_id = $3
        AND object_type = $4 AND object_id = $5
        AND (valid_until IS NULL OR valid_until > now())
    `, [input.workspaceId, input.projectId, input.principalId, input.objectType, input.objectId]);
    for (const capability of objectGrant.rows[0]?.capabilities ?? []) {
      if (capability === input.capability) objectGranted = true;
      allowed.add(capability);
    }
  }
  return { allowed, denied, objectGranted };
}

export async function authorizeScheduleProjectCapability(
  client: PoolClient,
  input: {
    workspaceId: string;
    projectId: string;
    principalId: string;
    capability: ProjectCapability;
  },
): Promise<void> {
  const row = await accessRow(client, input.workspaceId, input.projectId, input.principalId);
  const sets = await grantSets(client, input);
  const decision = evaluateProjectCapability({
    capability: input.capability,
    workspaceActive: row.workspace_status === "active",
    projectActive: row.project_status === "active",
    membershipActive: row.membership_status === "active",
    roleCapabilities: new Set(row.capabilities as ProjectCapability[]),
    allowedGrants: sets.allowed,
    deniedGrants: sets.denied,
  });
  if (!decision.allowed) {
    throw new FoundationServiceError("CAPABILITY_DENIED", "The scheduling capability is not permitted.", {
      capability: input.capability,
      reason: decision.reason,
    });
  }
}

export async function authorizeScheduleObject(
  client: PoolClient,
  input: {
    workspaceId: string;
    projectId: string;
    principalId: string;
    capability: "todo.read" | "todo.edit" | "todo.archive" | "calendar.read" | "calendar.edit" | "calendar.archive";
    objectType: ScheduleObjectType;
    objectId: string;
    ownerPrincipalId: string;
    visibility: "private" | "project";
  },
): Promise<void> {
  const row = await accessRow(client, input.workspaceId, input.projectId, input.principalId);
  const sets = await grantSets(client, input);
  const roleCapabilities = new Set(row.capabilities as ProjectCapability[]);
  const projectDecision = evaluateProjectCapability({
    capability: input.capability,
    workspaceActive: row.workspace_status === "active",
    projectActive: row.project_status === "active",
    membershipActive: row.membership_status === "active",
    roleCapabilities,
    allowedGrants: sets.allowed,
    deniedGrants: sets.denied,
  });
  const ownerAllowed = input.ownerPrincipalId === input.principalId && projectDecision.allowed;
  const sharedAllowed = input.visibility === "project" && projectDecision.allowed;
  const objectAllowed = sets.objectGranted && !sets.denied.has(input.capability);
  if (!ownerAllowed && !sharedAllowed && !objectAllowed) {
    throw new FoundationServiceError("NOT_FOUND", "The scheduling object was not found.");
  }
}

export async function scheduleObjectReadScope(
  client: PoolClient,
  input: {
    workspaceId: string;
    projectId: string;
    principalId: string;
    objectType: ScheduleObjectType;
    capability: "todo.read" | "calendar.read";
  },
): Promise<{ projectWide: boolean; objectIds: string[] }> {
  const row = await accessRow(client, input.workspaceId, input.projectId, input.principalId);
  const sets = await grantSets(client, input);
  const decision = evaluateProjectCapability({
    capability: input.capability,
    workspaceActive: row.workspace_status === "active",
    projectActive: row.project_status === "active",
    membershipActive: row.membership_status === "active",
    roleCapabilities: new Set(row.capabilities as ProjectCapability[]),
    allowedGrants: sets.allowed,
    deniedGrants: sets.denied,
  });
  if (decision.reason === "explicitly_denied") {
    throw new FoundationServiceError("CAPABILITY_DENIED", "Scheduling access is explicitly denied.");
  }
  const grants = await client.query<{ object_id: string }>(`
    SELECT object_id
    FROM object_grants
    WHERE workspace_id = $1 AND project_id = $2 AND principal_id = $3
      AND object_type = $4 AND capabilities @> ARRAY[$5]::text[]
      AND (valid_until IS NULL OR valid_until > now())
  `, [input.workspaceId, input.projectId, input.principalId, input.objectType, input.capability]);
  return { projectWide: decision.allowed, objectIds: grants.rows.map((grant) => grant.object_id) };
}

export async function readTodoListPolicy(
  client: PoolClient,
  input: { workspaceId: string; projectId: string; listId: string },
): Promise<{ ownerPrincipalId: string; visibility: "private" | "project"; revision: number; archived: boolean }> {
  const result = await client.query<{
    owner_principal_id: string;
    visibility: "private" | "project";
    revision: string;
    archived_at: Date | null;
  }>(`
    SELECT owner_principal_id, visibility, revision, archived_at
    FROM todo_lists
    WHERE workspace_id = $1 AND project_id = $2 AND id = $3
  `, [input.workspaceId, input.projectId, input.listId]);
  const row = result.rows[0];
  if (!row) throw new FoundationServiceError("NOT_FOUND", "To-do list was not found.");
  return {
    ownerPrincipalId: row.owner_principal_id,
    visibility: row.visibility,
    revision: Number(row.revision),
    archived: row.archived_at !== null,
  };
}

export async function readCalendarPolicy(
  client: PoolClient,
  input: { workspaceId: string; projectId: string; calendarId: string },
): Promise<{ ownerPrincipalId: string; visibility: "private" | "project"; revision: number; archived: boolean }> {
  const result = await client.query<{
    owner_principal_id: string;
    visibility: "private" | "project";
    revision: string;
    archived_at: Date | null;
  }>(`
    SELECT owner_principal_id, visibility, revision, archived_at
    FROM calendars
    WHERE workspace_id = $1 AND project_id = $2 AND id = $3
  `, [input.workspaceId, input.projectId, input.calendarId]);
  const row = result.rows[0];
  if (!row) throw new FoundationServiceError("NOT_FOUND", "Calendar was not found.");
  return {
    ownerPrincipalId: row.owner_principal_id,
    visibility: row.visibility,
    revision: Number(row.revision),
    archived: row.archived_at !== null,
  };
}
