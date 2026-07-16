import type { PoolClient } from "pg";
import { evaluateProjectCapability, type ProjectCapability } from "@/auth/capabilities";
import { FoundationServiceError } from "@/services/foundation/errors";

type AccessRow = {
  workspace_status: string;
  project_status: string;
  membership_status: string;
  capabilities: string[];
};

export async function authorizePageCapability(
  client: PoolClient,
  input: {
    workspaceId: string;
    projectId: string;
    principalId: string;
    capability: ProjectCapability;
    pageId?: string;
  },
): Promise<void> {
  const access = await client.query<AccessRow>(`
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
  `, [input.workspaceId, input.projectId, input.principalId]);
  const row = access.rows[0];
  if (!row) {
    throw new FoundationServiceError("CAPABILITY_DENIED", "Active project membership is required.");
  }

  const grants = await client.query<{ capability: ProjectCapability; effect: "allow" | "deny" }>(`
    SELECT capability, effect
    FROM capability_grants
    WHERE workspace_id = $1 AND (project_id = $2 OR project_id IS NULL)
      AND principal_id = $3 AND capability = $4
      AND valid_from <= now() AND (valid_until IS NULL OR valid_until > now())
  `, [input.workspaceId, input.projectId, input.principalId, input.capability]);

  const objectCapabilities = new Set<ProjectCapability>();
  if (input.pageId) {
    const objectGrant = await client.query<{ capabilities: ProjectCapability[] }>(`
      SELECT capabilities
      FROM object_grants
      WHERE workspace_id = $1 AND project_id = $2 AND principal_id = $3
        AND object_type = 'page' AND object_id = $4
        AND (valid_until IS NULL OR valid_until > now())
    `, [input.workspaceId, input.projectId, input.principalId, input.pageId]);
    for (const capability of objectGrant.rows[0]?.capabilities ?? []) {
      objectCapabilities.add(capability);
    }
  }

  const allowed = new Set<ProjectCapability>([
    ...grants.rows.filter((grant) => grant.effect === "allow").map((grant) => grant.capability),
    ...objectCapabilities,
  ]);
  const denied = new Set<ProjectCapability>(
    grants.rows.filter((grant) => grant.effect === "deny").map((grant) => grant.capability),
  );

  const decision = evaluateProjectCapability({
    capability: input.capability,
    workspaceActive: row.workspace_status === "active",
    projectActive: row.project_status === "active",
    membershipActive: row.membership_status === "active",
    roleCapabilities: new Set(row.capabilities as ProjectCapability[]),
    allowedGrants: allowed,
    deniedGrants: denied,
  });
  if (!decision.allowed) {
    throw new FoundationServiceError("CAPABILITY_DENIED", "The page capability is not permitted.", {
      reason: decision.reason,
      pageId: input.pageId,
    });
  }
}

export async function assertPageExists(
  client: PoolClient,
  workspaceId: string,
  projectId: string,
  pageId: string,
): Promise<{ sourceType: "git" | "native"; status: "active" | "archived" | "unavailable"; revision: number }> {
  const result = await client.query<{ source_type: "git" | "native"; status: "active" | "archived" | "unavailable"; revision: string }>(`
    SELECT source_type, status, revision
    FROM pages
    WHERE workspace_id = $1 AND project_id = $2 AND id = $3
  `, [workspaceId, projectId, pageId]);
  const row = result.rows[0];
  if (!row) throw new FoundationServiceError("NOT_FOUND", "Page was not found.");
  return { sourceType: row.source_type, status: row.status, revision: Number(row.revision) };
}
