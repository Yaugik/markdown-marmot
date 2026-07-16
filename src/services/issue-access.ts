import type { PoolClient } from "pg";
import { evaluateProjectCapability, type ProjectCapability } from "@/auth/capabilities";
import { FoundationServiceError } from "@/services/foundation/errors";

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
      AND wm.status = 'active' AND rt.archived_at IS NULL
  `, [workspaceId, projectId, principalId]);
  const row = result.rows[0];
  if (!row) throw new FoundationServiceError("CAPABILITY_DENIED", "Active project membership is required.");
  return row;
}

async function capabilitySets(
  client: PoolClient,
  input: {
    workspaceId: string;
    projectId: string;
    principalId: string;
    capability: ProjectCapability;
    objectType?: "issue" | "saved_view";
    objectId?: string;
  },
): Promise<{ allowed: Set<ProjectCapability>; denied: Set<ProjectCapability> }> {
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
  if (input.objectType && input.objectId) {
    const objectGrant = await client.query<{ capabilities: ProjectCapability[] }>(`
      SELECT capabilities
      FROM object_grants
      WHERE workspace_id = $1 AND project_id = $2 AND principal_id = $3
        AND object_type = $4 AND object_id = $5
        AND (valid_until IS NULL OR valid_until > now())
    `, [input.workspaceId, input.projectId, input.principalId, input.objectType, input.objectId]);
    for (const capability of objectGrant.rows[0]?.capabilities ?? []) allowed.add(capability);
  }
  return { allowed, denied };
}

export async function authorizeIssueCapability(
  client: PoolClient,
  input: {
    workspaceId: string;
    projectId: string;
    principalId: string;
    capability: ProjectCapability;
    issueId?: string;
  },
): Promise<void> {
  const row = await accessRow(client, input.workspaceId, input.projectId, input.principalId);
  const sets = await capabilitySets(client, {
    ...input,
    objectType: input.issueId ? "issue" : undefined,
    objectId: input.issueId,
  });
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
    throw new FoundationServiceError("CAPABILITY_DENIED", "The issue capability is not permitted.", {
      reason: decision.reason,
      issueId: input.issueId,
    });
  }
}

export async function authorizeSavedViewRead(
  client: PoolClient,
  input: {
    workspaceId: string;
    projectId: string;
    principalId: string;
    viewId: string;
    ownerPrincipalId: string;
    visibility: "private" | "project";
  },
): Promise<void> {
  if (input.visibility === "project" || input.ownerPrincipalId === input.principalId) {
    await authorizeIssueCapability(client, { ...input, capability: "issue.read" });
    return;
  }
  const row = await accessRow(client, input.workspaceId, input.projectId, input.principalId);
  const sets = await capabilitySets(client, {
    ...input,
    capability: "issue.read",
    objectType: "saved_view",
    objectId: input.viewId,
  });
  const decision = evaluateProjectCapability({
    capability: "issue.read",
    workspaceActive: row.workspace_status === "active",
    projectActive: row.project_status === "active",
    membershipActive: row.membership_status === "active",
    roleCapabilities: new Set(),
    allowedGrants: sets.allowed,
    deniedGrants: sets.denied,
  });
  if (!decision.allowed) throw new FoundationServiceError("NOT_FOUND", "Saved view was not found.");
}

export async function issueReadScope(
  client: PoolClient,
  input: { workspaceId: string; projectId: string; principalId: string },
): Promise<{ projectWide: boolean; issueIds: string[] }> {
  const row = await accessRow(client, input.workspaceId, input.projectId, input.principalId);
  const sets = await capabilitySets(client, { ...input, capability: "issue.read" });
  const projectDecision = evaluateProjectCapability({
    capability: "issue.read",
    workspaceActive: row.workspace_status === "active",
    projectActive: row.project_status === "active",
    membershipActive: row.membership_status === "active",
    roleCapabilities: new Set(row.capabilities as ProjectCapability[]),
    allowedGrants: sets.allowed,
    deniedGrants: sets.denied,
  });
  if (projectDecision.allowed) return { projectWide: true, issueIds: [] };
  if (projectDecision.reason === "explicitly_denied") {
    throw new FoundationServiceError("CAPABILITY_DENIED", "Issue access is explicitly denied.");
  }
  const objectGrants = await client.query<{ object_id: string }>(`
    SELECT object_id
    FROM object_grants
    WHERE workspace_id = $1 AND project_id = $2 AND principal_id = $3
      AND object_type = 'issue' AND capabilities @> ARRAY['issue.read']::text[]
      AND (valid_until IS NULL OR valid_until > now())
  `, [input.workspaceId, input.projectId, input.principalId]);
  return { projectWide: false, issueIds: objectGrants.rows.map((rowValue) => rowValue.object_id) };
}

export async function assertIssueExists(
  client: PoolClient,
  workspaceId: string,
  projectId: string,
  issueId: string,
): Promise<{ revision: number; lifecycle: "active" | "archived"; statusId: string; workflowId: string }> {
  const result = await client.query<{ revision: string; lifecycle: "active" | "archived"; status_id: string; workflow_id: string }>(`
    SELECT revision, lifecycle, status_id, workflow_id
    FROM issues
    WHERE workspace_id = $1 AND project_id = $2 AND id = $3
  `, [workspaceId, projectId, issueId]);
  const row = result.rows[0];
  if (!row) throw new FoundationServiceError("NOT_FOUND", "Issue was not found.");
  return { revision: Number(row.revision), lifecycle: row.lifecycle, statusId: row.status_id, workflowId: row.workflow_id };
}
