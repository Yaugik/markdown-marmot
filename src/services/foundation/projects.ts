import type { Pool } from "pg";
import { postgresPool } from "@/db/postgres";
import { newFolioId } from "@/lib/folio-ids";
import { establishTenantContext } from "@/db/tenant";
import { FoundationServiceError } from "./errors";
import {
  findIdempotentResult,
  inTransaction,
  lockIdempotencyKey,
  recordMutation,
  requestDigest,
} from "./internal";
import type { MutationContext, MutationResult, ProjectSummary } from "./types";

export type CreateProjectInput = {
  workspaceId: string;
  projectKey: string;
  name: string;
  timeZone?: string;
  defaultGitWritePolicy?: "disabled" | "pull_request_only" | "direct_allowed";
};

function validate(input: CreateProjectInput): Required<CreateProjectInput> {
  const normalized = {
    workspaceId: input.workspaceId,
    projectKey: input.projectKey.trim().toUpperCase(),
    name: input.name.trim(),
    timeZone: input.timeZone?.trim() || "UTC",
    defaultGitWritePolicy: input.defaultGitWritePolicy ?? "pull_request_only",
  };
  if (!/^[A-Z][A-Z0-9]{1,9}$/.test(normalized.projectKey)) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Project key must contain 2 to 10 uppercase letters or numbers.");
  }
  if (normalized.name.length < 1 || normalized.name.length > 160) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Project name must contain 1 to 160 characters.");
  }
  return normalized;
}

export async function createProject(
  rawInput: CreateProjectInput,
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<ProjectSummary>> {
  const input = validate(rawInput);
  const operation = "project.create";
  const digest = requestDigest(input);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<ProjectSummary>(client, {
      workspaceId: input.workspaceId,
      projectAgnostic: true,
      principalId: context.actorPrincipalId,
      operation,
      key: context.idempotencyKey,
      digest,
    });
    if (replay) return replay;

    const access = await client.query<{ workspace_status: string; membership_status: string }>(`
      SELECT w.status workspace_status, wm.status membership_status
      FROM workspaces w
      JOIN workspace_memberships wm
        ON wm.workspace_id = w.id AND wm.principal_id = $2
      WHERE w.id = $1
    `, [input.workspaceId, context.actorPrincipalId]);
    if (!access.rows[0]) {
      throw new FoundationServiceError("CAPABILITY_DENIED", "Active workspace membership is required.");
    }
    if (access.rows[0].workspace_status !== "active" || access.rows[0].membership_status !== "active") {
      throw new FoundationServiceError("CAPABILITY_DENIED", "Workspace or membership is not active.");
    }
    const adminRole = await client.query<{ id: string; capabilities: string[] }>(`
      SELECT id, capabilities
      FROM role_templates
      WHERE workspace_id = $1 AND template_key = 'admin' AND archived_at IS NULL
    `, [input.workspaceId]);
    if (!adminRole.rows[0]) {
      throw new FoundationServiceError("NOT_FOUND", "Workspace Admin role template was not found.");
    }

    const projectId = newFolioId();
    try {
      await client.query(`
        INSERT INTO projects (
          id, workspace_id, project_key, name, time_zone, default_git_write_policy
        ) VALUES ($1, $2, $3, $4, $5, $6)
      `, [
        projectId, input.workspaceId, input.projectKey, input.name, input.timeZone,
        input.defaultGitWritePolicy,
      ]);
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new FoundationServiceError("CONFLICT", "Project key is already in use in this workspace.", {
          projectKey: input.projectKey,
        });
      }
      throw error;
    }
    await client.query(`
      INSERT INTO project_memberships (
        id, workspace_id, project_id, principal_id, role_template_id,
        status, invited_by_principal_id
      ) VALUES ($1, $2, $3, $4, $5, 'active', $4)
    `, [
      newFolioId(), input.workspaceId, projectId, context.actorPrincipalId,
      adminRole.rows[0].id,
    ]);

    const data: ProjectSummary = {
      id: projectId,
      workspaceId: input.workspaceId,
      projectKey: input.projectKey,
      name: input.name,
      timeZone: input.timeZone,
      defaultGitWritePolicy: input.defaultGitWritePolicy,
      revision: 1,
      roleTemplateKey: "admin",
      capabilities: adminRole.rows[0].capabilities,
    };
    return recordMutation(client, {
      workspaceId: input.workspaceId,
      projectId,
      context,
      operation,
      digest,
      action: operation,
      targetType: "project",
      targetId: projectId,
      aggregateType: "project",
      aggregateRevision: 1,
      eventType: "project.created.v1",
      inputSummary: { projectKey: input.projectKey, name: input.name },
      resultSummary: { projectId, adminPrincipalId: context.actorPrincipalId },
      data,
    });
  });
}
