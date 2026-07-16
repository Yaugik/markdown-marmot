import type { Pool } from "pg";
import { defaultProjectRoleCapabilities, type ProjectRole } from "@/auth/capabilities";
import { postgresPool } from "@/db/postgres";
import { newFolioId } from "@/lib/folio-ids";
import { FoundationServiceError } from "./errors";
import {
  findIdempotentResult,
  inTransaction,
  lockIdempotencyKey,
  recordMutation,
  requestDigest,
} from "./internal";
import type { MutationContext, MutationResult, WorkspaceSummary } from "./types";

export type CreateWorkspaceInput = {
  name: string;
  slug: string;
  defaultTimeZone?: string;
};

function validate(input: CreateWorkspaceInput): Required<CreateWorkspaceInput> {
  const normalized = {
    name: input.name.trim(),
    slug: input.slug.trim().toLowerCase(),
    defaultTimeZone: input.defaultTimeZone?.trim() || "UTC",
  };
  if (normalized.name.length < 1 || normalized.name.length > 120) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Workspace name must contain 1 to 120 characters.");
  }
  if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(normalized.slug)) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Workspace slug must contain 3 to 64 lowercase letters, numbers, or hyphens.");
  }
  return normalized;
}

export async function createWorkspace(
  rawInput: CreateWorkspaceInput,
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<WorkspaceSummary>> {
  const input = validate(rawInput);
  const operation = "workspace.create";
  const digest = requestDigest(input);
  return inTransaction(pool, async (client) => {
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<WorkspaceSummary>(client, {
      principalId: context.actorPrincipalId,
      operation,
      key: context.idempotencyKey,
      digest,
    });
    if (replay) return replay;

    const principal = await client.query<{ status: string }>(
      "SELECT status FROM principals WHERE id = $1 AND kind = 'human'",
      [context.actorPrincipalId],
    );
    if (!principal.rows[0]) throw new FoundationServiceError("NOT_FOUND", "Actor principal was not found.");
    if (principal.rows[0].status !== "active") {
      throw new FoundationServiceError("CAPABILITY_DENIED", "Actor principal is not active.");
    }

    const workspaceId = newFolioId();
    try {
      await client.query(`
        INSERT INTO workspaces (id, name, slug, default_time_zone)
        VALUES ($1, $2, $3, $4)
      `, [workspaceId, input.name, input.slug, input.defaultTimeZone]);
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new FoundationServiceError("CONFLICT", "Workspace slug is already in use.", { slug: input.slug });
      }
      throw error;
    }
    await client.query(`
      INSERT INTO workspace_memberships (
        id, workspace_id, principal_id, role, status, invited_by_principal_id
      ) VALUES ($1, $2, $3, 'owner', 'active', $3)
    `, [newFolioId(), workspaceId, context.actorPrincipalId]);

    for (const role of ["admin", "member", "guest"] as const satisfies readonly ProjectRole[]) {
      await client.query(`
        INSERT INTO role_templates (
          id, workspace_id, name, template_key, capabilities, is_system_template
        ) VALUES ($1, $2, $3, $4, $5, true)
      `, [
        newFolioId(), workspaceId, role[0].toUpperCase() + role.slice(1), role,
        [...defaultProjectRoleCapabilities[role]],
      ]);
    }

    const data: WorkspaceSummary = {
      id: workspaceId,
      name: input.name,
      slug: input.slug,
      defaultTimeZone: input.defaultTimeZone,
      revision: 1,
      membershipRole: "owner",
    };
    return recordMutation(client, {
      workspaceId,
      context,
      operation,
      digest,
      action: operation,
      targetType: "workspace",
      targetId: workspaceId,
      aggregateType: "workspace",
      aggregateRevision: 1,
      eventType: "workspace.created.v1",
      inputSummary: { name: input.name, slug: input.slug },
      resultSummary: { workspaceId, ownerPrincipalId: context.actorPrincipalId },
      data,
    });
  });
}
