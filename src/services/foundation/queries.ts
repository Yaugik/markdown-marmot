import type { Pool, PoolClient } from "pg";
import { postgresPool } from "@/db/postgres";
import { establishTenantContext } from "@/db/tenant";
import type { ProjectSummary, WorkspaceSummary } from "./types";

type WorkspaceRow = {
  id: string;
  name: string;
  slug: string;
  default_time_zone: string;
  revision: string;
  membership_role: "owner" | "member";
};

type ProjectRow = {
  id: string;
  workspace_id: string;
  project_key: string;
  name: string;
  time_zone: string;
  default_git_write_policy: "disabled" | "pull_request_only" | "direct_allowed";
  revision: string;
  template_key: "admin" | "member" | "guest";
  capabilities: string[];
};

export async function listPermittedWorkspaces(
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<WorkspaceSummary[]> {
  const result = await pool.query<WorkspaceRow>(`
    SELECT w.id, w.name, w.slug, w.default_time_zone, w.revision,
      wm.role membership_role
    FROM workspace_memberships wm
    JOIN workspaces w ON w.id = wm.workspace_id
    WHERE wm.principal_id = $1 AND wm.status = 'active' AND w.status = 'active'
    ORDER BY lower(w.name), w.id
  `, [principalId]);
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    defaultTimeZone: row.default_time_zone,
    revision: Number(row.revision),
    membershipRole: row.membership_role,
  }));
}

export async function listPermittedProjects(
  principalId: string,
  workspaceId: string | undefined,
  pool: Pool = postgresPool(),
): Promise<ProjectSummary[]> {
  if (workspaceId) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await establishTenantContext(client, workspaceId, principalId);
      const result = await queryProjects(client, principalId, workspaceId);
      await client.query("COMMIT");
      return mapProjects(result.rows);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  const result = await queryProjects(pool, principalId, undefined);
  return mapProjects(result.rows);
}

function queryProjects(database: Pool | PoolClient, principalId: string, workspaceId: string | undefined) {
  return database.query<ProjectRow>(`
    SELECT p.id, p.workspace_id, p.project_key, p.name, p.time_zone,
      p.default_git_write_policy, p.revision, rt.template_key, rt.capabilities
    FROM project_memberships pm
    JOIN projects p ON p.id = pm.project_id AND p.workspace_id = pm.workspace_id
    JOIN workspaces w ON w.id = p.workspace_id
    JOIN workspace_memberships wm
      ON wm.workspace_id = p.workspace_id AND wm.principal_id = pm.principal_id
    JOIN role_templates rt
      ON rt.id = pm.role_template_id AND rt.workspace_id = pm.workspace_id
    WHERE pm.principal_id = $1
      AND ($2::uuid IS NULL OR p.workspace_id = $2)
      AND pm.status = 'active' AND wm.status = 'active'
      AND p.status = 'active' AND w.status = 'active'
      AND rt.archived_at IS NULL
    ORDER BY lower(p.name), p.id
  `, [principalId, workspaceId ?? null]);
}

function mapProjects(rows: ProjectRow[]): ProjectSummary[] {
  return rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    projectKey: row.project_key,
    name: row.name,
    timeZone: row.time_zone,
    defaultGitWritePolicy: row.default_git_write_policy,
    revision: Number(row.revision),
    roleTemplateKey: row.template_key,
    capabilities: row.capabilities,
  }));
}
