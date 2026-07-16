import type { Pool } from "pg";
import { postgresPool } from "@/db/postgres";
import { establishTenantContext } from "@/db/tenant";
import { FoundationServiceError } from "@/services/foundation/errors";
import {
  findIdempotentResult,
  inTransaction,
  lockIdempotencyKey,
  recordMutation,
  requestDigest,
} from "@/services/foundation/internal";
import type { MutationContext, MutationResult } from "@/services/foundation/types";
import { assertPageExists, authorizePageCapability } from "@/services/page-access";
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
  const { content: _content, plainText: _plainText, ...summary } = mapRevision(row);
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
    await authorizePageCapability(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      principalId: context.actorPrincipalId,
      capability: "page.archive",
      pageId: input.pageId,
    });
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
    `, [targetStatus, archivedAt, context.actorPrincipalId, now,
      input.workspaceId, input.projectId, input.pageId]);
    await client.query(`
      UPDATE page_tree_nodes
      SET archived_at = $1, revision = revision + 1,
        updated_by_principal_id = $2, updated_at = $3
      WHERE workspace_id = $4 AND project_id = $5 AND page_id = $6
    `, [archivedAt, context.actorPrincipalId, now,
      input.workspaceId, input.projectId, input.pageId]);
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
    await authorizePageCapability(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      principalId,
      capability: "page.read",
      pageId: input.pageId,
    });
    const page = await assertPageExists(client, input.workspaceId, input.projectId, input.pageId);
    if (page.sourceType !== "native") throw new FoundationServiceError("CONFLICT", "Revision history requires a native page.");
    const result = await client.query<RevisionRow>(`${revisionQuery}
      WHERE npr.workspace_id = $1 AND npr.project_id = $2 AND npr.page_id = $3
        AND p.source_type = 'native'
        AND ($4::bigint IS NULL OR npr.sequence < $4)
      ORDER BY npr.sequence DESC
      LIMIT $5
    `, [input.workspaceId, input.projectId, input.pageId, input.beforeSequence ?? null, limit]);
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
    await authorizePageCapability(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      principalId,
      capability: "page.read",
      pageId: input.pageId,
    });
    const result = await client.query<RevisionRow>(`${revisionQuery}
      WHERE npr.workspace_id = $1 AND npr.project_id = $2
        AND npr.page_id = $3 AND npr.id = $4 AND p.source_type = 'native'
    `, [input.workspaceId, input.projectId, input.pageId, input.revisionId]);
    if (!result.rows[0]) throw new FoundationServiceError("NOT_FOUND", "Native page revision was not found.");
    return mapRevision(result.rows[0]);
  });
}
