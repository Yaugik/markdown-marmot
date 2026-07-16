import type { Pool, PoolClient } from "pg";
import { evaluateProjectCapability, type ProjectCapability } from "@/auth/capabilities";
import { postgresPool } from "@/db/postgres";
import { establishTenantContext } from "@/db/tenant";
import { FoundationServiceError } from "@/services/foundation/errors";
import { findIdempotentResult, inTransaction, lockIdempotencyKey, recordMutation, requestDigest } from "@/services/foundation/internal";
import type { MutationContext, MutationResult } from "@/services/foundation/types";
import type { ProseMirrorNode } from "@/services/pages";

export type NativePageRevisionSummary = {
  id: string;
  pageId: string;
  sequence: number;
  editorSchemaVersion: number;
  contentHash: string;
  authorPrincipalId: string;
  parentRevisionId: string | null;
  createdAt: string;
};

export type NativePageRevision = NativePageRevisionSummary & {
  content: ProseMirrorNode;
  plainText: string;
};

export type NativePageLifecycleResult = {
  pageId: string;
  status: "active" | "archived";
  revision: number;
  archivedAt: string | null;
  updatedAt: string;
};

type AccessRow = {
  workspace_status: string;
  project_status: string;
  membership_status: string;
  capabilities: string[];
};

type RevisionRow = {
  id: string;
  page_id: string;
  sequence: string;
  editor_schema_version: number;
  content: ProseMirrorNode;
  plain_text: string;
  content_hash: string;
  author_principal_id: string;
  parent_revision_id: string | null;
  created_at: Date;
};

async function authorize(
  client: PoolClient,
  workspaceId: string,
  projectId: string,
  principalId: string,
  capability: ProjectCapability,
) {
  const access = await client.query<AccessRow>(`
    SELECT w.status workspace_status, p.status project_status,
      pm.status membership_status, rt.capabilities
    FROM projects p
    JOIN workspaces w ON w.id = p.workspace_id
    JOIN project_memberships pm
      ON pm.workspace_id = p.workspace_id AND pm.project_id = p.id AND pm.principal_id = $3
    JOIN workspace_memberships wm
      ON wm.workspace_id = p.workspace_id AND wm.principal_id = pm.principal_id
    JOIN role_templates rt
      ON rt.workspace_id = pm.workspace_id AND rt.id = pm.role_template_id
    WHERE p.workspace_id = $1 AND p.id = $2
      AND wm.status = 'active' AND rt.archived_at IS NULL
  `, [workspaceId, projectId, principalId]);
  const row = access.rows[0];
  if (!row) throw new FoundationServiceError("CAPABILITY_DENIED", "Active project membership is required.");

  const grants = await client.query<{ capability: ProjectCapability; effect: "allow" | "deny" }>(`
    SELECT capability, effect
    FROM capability_grants
    WHERE workspace_id = $1 AND (project_id = $2 OR project_id IS NULL)
      AND principal_id = $3 AND capability = $4
      AND valid_from <= now() AND (valid_until IS NULL OR valid_until > now())
  `, [workspaceId, projectId, principalId, capability]);

  const decision = evaluateProjectCapability({
    capability,
    workspaceActive: row.workspace_status === "active",
    projectActive: row.project_status === "active",
    membershipActive: row.membership_status === "active",
    roleCapabilities: new Set(row.capabilities as ProjectCapability[]),
    allowedGrants: new Set(grants.rows.filter((grant) => grant.effect === "allow").map((grant) => grant.capability)),
    deniedGrants: new Set(grants.rows.filter((grant) => grant.effect === "deny").map((grant) => grant.capability)),
  });
  if (!decision.allowed) {
    throw new FoundationServiceError("CAPABILITY_DENIED", "The page capability is not permitted.", {
      reason: decision.reason,
    });
  }
}

function validateExpectedRevision(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Expected revision must be a positive integer.");
  }
}

function mapRevision(row: RevisionRow): NativePageRevision {
  return {
    id: row.id,
    pageId: row.page_id,
    sequence: Number(row.sequence),
    editorSchemaVersion: row.editor_schema_version,
    content: row.content,
    plainText: row.plain_text,
    contentHash: row.content_hash,
    authorPrincipalId: row.author_principal_id,
    parentRevisionId: row.parent_revision_id,
    createdAt: row.created_at.toISOString(),
  };
}

function mapRevisionSummary(row: RevisionRow): NativePageRevisionSummary {
  const revision = mapRevision(row);
  const { content: _content, plainText: _plainText, ...summary } = revision;
  return summary;
}

const revisionQuery = `
  SELECT npr.id, npr.page_id, npr.sequence, npr.editor_schema_version,
    npr.content, npr.plain_text, npr.content_hash, npr.author_principal_id,
    npr.parent_revision_id, npr.created_at
  FROM native_page_revisions npr
  JOIN pages p
    ON p.workspace_id = npr.workspace_id
    AND p.project_id = npr.project_id
    AND p.id = npr.page_id
`;

async function setLifecycle(
  input: { workspaceId: string; projectId: string; pageId: string; expectedRevision: number },
  targetStatus: "active" | "archived",
  context: MutationContext,
  pool: Pool,
): Promise<MutationResult<NativePageLifecycleResult>> {
  validateExpectedRevision(input.expectedRevision);
  const operation = targetStatus === "archived" ? "native_page.archive" : "native_page.restore";
  const digest = requestDigest(input);

  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<NativePageLifecycleResult>(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      principalId: context.actorPrincipalId,
      operation,
      key: context.idempotencyKey,
      digest,
    });
    if (replay) return replay;

    await authorize(client, input.workspaceId, input.projectId, context.actorPrincipalId, "page.archive");
    const current = await client.query<{ status: string; revision: string }>(`
      SELECT status, revision
      FROM pages
      WHERE workspace_id = $1 AND project_id = $2 AND id = $3 AND source_type = 'native'
      FOR UPDATE
    `, [input.workspaceId, input.projectId, input.pageId]);
    const row = current.rows[0];
    if (!row) throw new FoundationServiceError("NOT_FOUND", "Native page was not found.");

    const revision = Number(row.revision);
    if (revision !== input.expectedRevision) {
      throw new FoundationServiceError("REVISION_CONFLICT", "The native page changed after it was read.", {
        expectedRevision: input.expectedRevision,
        currentRevision: revision,
      });
    }
    if (row.status === targetStatus) {
      throw new FoundationServiceError(
        "CONFLICT",
        targetStatus === "archived" ? "The native page is already archived." : "The native page is already active.",
      );
    }
    if (row.status === "unavailable") {
      throw new FoundationServiceError("CONFLICT", "Unavailable pages cannot use the native page lifecycle.");
    }

    const now = new Date();
    const archivedAt = targetStatus === "archived" ? now : null;
    await client.query(`
      UPDATE pages
      SET status = $1, archived_at = $2, revision = revision + 1,
        updated_by_principal_id = $3, updated_at = $4
      WHERE workspace_id = $5 AND project_id = $6 AND id = $7
    `, [targetStatus, archivedAt, context.actorPrincipalId, now, input.workspaceId, input.projectId, input.pageId]);
    await client.query(`
      UPDATE page_tree_nodes
      SET archived_at = $1, revision = revision + 1,
        updated_by_principal_id = $2, updated_at = $3
      WHERE workspace_id = $4 AND project_id = $5 AND page_id = $6
    `, [archivedAt, context.actorPrincipalId, now, input.workspaceId, input.projectId, input.pageId]);

    const data: NativePageLifecycleResult = {
      pageId: input.pageId,
      status: targetStatus,
      revision: revision + 1,
      archivedAt: archivedAt?.toISOString() ?? null,
      updatedAt: now.toISOString(),
    };
    return recordMutation(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      context,
      operation,
      digest,
      action: operation,
      targetType: "page",
      targetId: input.pageId,
      aggregateType: "page",
      aggregateRevision: revision + 1,
      eventType: targetStatus === "archived" ? "native_page.archived.v1" : "native_page.restored.v1",
      inputSummary: { expectedRevision: input.expectedRevision },
      resultSummary: { pageId: input.pageId, status: targetStatus },
      data,
    });
  });
}

export function archiveNativePage(
  input: { workspaceId: string; projectId: string; pageId: string; expectedRevision: number },
  context: MutationContext,
  pool: Pool = postgresPool(),
) {
  return setLifecycle(input, "archived", context, pool);
}

export function restoreNativePage(
  input: { workspaceId: string; projectId: string; pageId: string; expectedRevision: number },
  context: MutationContext,
  pool: Pool = postgresPool(),
) {
  return setLifecycle(input, "active", context, pool);
}

export async function listNativePageRevisions(
  input: { workspaceId: string; projectId: string; pageId: string; beforeSequence?: number; limit?: number },
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<NativePageRevisionSummary[]> {
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Revision limit must be between 1 and 100.");
  }
  if (input.beforeSequence !== undefined && (!Number.isSafeInteger(input.beforeSequence) || input.beforeSequence < 1)) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Before sequence must be a positive integer.");
  }

  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, principalId);
    await authorize(client, input.workspaceId, input.projectId, principalId, "page.read");
    const result = await client.query<RevisionRow>(`${revisionQuery}
      WHERE npr.workspace_id = $1 AND npr.project_id = $2 AND npr.page_id = $3
        AND p.source_type = 'native'
        AND ($4::bigint IS NULL OR npr.sequence < $4)
      ORDER BY npr.sequence DESC
      LIMIT $5
    `, [input.workspaceId, input.projectId, input.pageId, input.beforeSequence ?? null, limit]);

    if (!result.rows.length) {
      const page = await client.query(`
        SELECT 1 FROM pages
        WHERE workspace_id = $1 AND project_id = $2 AND id = $3 AND source_type = 'native'
      `, [input.workspaceId, input.projectId, input.pageId]);
      if (!page.rows[0]) throw new FoundationServiceError("NOT_FOUND", "Native page was not found.");
    }
    return result.rows.map(mapRevisionSummary);
  });
}

export async function readNativePageRevision(
  input: { workspaceId: string; projectId: string; pageId: string; revisionId: string },
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<NativePageRevision> {
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, principalId);
    await authorize(client, input.workspaceId, input.projectId, principalId, "page.read");
    const result = await client.query<RevisionRow>(`${revisionQuery}
      WHERE npr.workspace_id = $1 AND npr.project_id = $2
        AND npr.page_id = $3 AND npr.id = $4 AND p.source_type = 'native'
    `, [input.workspaceId, input.projectId, input.pageId, input.revisionId]);
    if (!result.rows[0]) throw new FoundationServiceError("NOT_FOUND", "Native page revision was not found.");
    return mapRevision(result.rows[0]);
  });
}
