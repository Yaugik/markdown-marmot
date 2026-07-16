import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { postgresPool } from "@/db/postgres";
import { establishTenantContext } from "@/db/tenant";
import { newFolioId } from "@/lib/folio-ids";
import { FoundationServiceError } from "@/services/foundation/errors";
import {
  findIdempotentResult,
  inTransaction,
  lockIdempotencyKey,
  recordMutation,
  requestDigest,
} from "@/services/foundation/internal";
import type { MutationContext, MutationResult } from "@/services/foundation/types";
import {
  analyzeMarkdown,
  markdownToNativeDocument,
  nativeDocumentToMarkdown,
} from "@/services/markdown-roundtrip";
import { assertPageExists, authorizePageCapability } from "@/services/page-access";
import type { ProseMirrorNode } from "@/services/pages";

export type PageConversionOperation = "git_to_native" | "native_to_git" | "convert";
export type PageConversionPreview = {
  id: string;
  operation: PageConversionOperation;
  sourcePageId: string | null;
  sourceDescriptor: Record<string, unknown>;
  targetDescriptor: Record<string, unknown>;
  relationshipPlan: Record<string, unknown>;
  warnings: unknown[];
  proposal: Record<string, unknown>;
  state: "prepared" | "executed" | "expired" | "canceled";
  revision: number;
  createdByPrincipalId: string;
  createdAt: string;
  expiresAt: string;
  executedAt: string | null;
};
export type PageConversionExecution = {
  preview: PageConversionPreview;
  createdPageId: string | null;
  resultKind: "native_page_created" | "git_proposal_ready";
  requiresGitOperation: boolean;
};

type PreviewRow = {
  id: string;
  operation: PageConversionOperation;
  source_page_id: string | null;
  source_descriptor: Record<string, unknown>;
  target_descriptor: Record<string, unknown>;
  relationship_plan: Record<string, unknown>;
  warnings: unknown[];
  proposal: Record<string, unknown>;
  state: PageConversionPreview["state"];
  revision: string;
  created_by_principal_id: string;
  created_at: Date;
  expires_at: Date;
  executed_at: Date | null;
};

function mapPreview(row: PreviewRow): PageConversionPreview {
  return {
    id: row.id,
    operation: row.operation,
    sourcePageId: row.source_page_id,
    sourceDescriptor: row.source_descriptor,
    targetDescriptor: row.target_descriptor,
    relationshipPlan: row.relationship_plan,
    warnings: row.warnings,
    proposal: row.proposal,
    state: row.state,
    revision: Number(row.revision),
    createdByPrincipalId: row.created_by_principal_id,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    executedAt: row.executed_at?.toISOString() ?? null,
  };
}

function plainText(node: ProseMirrorNode): string {
  const parts: string[] = [];
  const visit = (item: ProseMirrorNode) => {
    if (item.text) parts.push(item.text);
    item.content?.forEach(visit);
    if (["paragraph", "heading", "blockquote", "code_block", "list_item"].includes(item.type)) parts.push("\n");
  };
  visit(node);
  return parts.join("").replace(/\n{3,}/g, "\n\n").trim();
}

async function relationshipPreview(
  client: PoolClient,
  workspaceId: string,
  projectId: string,
  sourcePageId: string | null,
  reassignRelationships: boolean,
) {
  if (!sourcePageId) return { reassignRelationships: false, treeNodeIds: [], incomingLinkIds: [], outgoingLinkIds: [] };
  const [tree, incoming, outgoing] = await Promise.all([
    client.query<{ id: string }>(`
      SELECT id FROM page_tree_nodes
      WHERE workspace_id = $1 AND project_id = $2 AND page_id = $3 AND archived_at IS NULL
      ORDER BY id
    `, [workspaceId, projectId, sourcePageId]),
    client.query<{ id: string }>(`
      SELECT id FROM page_links
      WHERE workspace_id = $1 AND project_id = $2 AND target_page_id = $3 AND state = 'current'
      ORDER BY id
    `, [workspaceId, projectId, sourcePageId]),
    client.query<{ id: string }>(`
      SELECT id FROM page_links
      WHERE workspace_id = $1 AND project_id = $2 AND source_page_id = $3 AND state = 'current'
      ORDER BY id
    `, [workspaceId, projectId, sourcePageId]),
  ]);
  return {
    reassignRelationships,
    treeNodeIds: tree.rows.map((row) => row.id),
    incomingLinkIds: incoming.rows.map((row) => row.id),
    outgoingLinkIds: outgoing.rows.map((row) => row.id),
    behavior: reassignRelationships
      ? "tree placements and incoming links move to the created target; outgoing links remain with the source unless reindexed"
      : "source relationships remain unchanged",
  };
}

export async function preparePageConversion(
  raw: {
    workspaceId: string;
    projectId: string;
    operation: PageConversionOperation;
    sourcePageId?: string | null;
    sourceDescriptor: Record<string, unknown>;
    targetDescriptor: Record<string, unknown>;
    markdown?: string;
    title?: string;
    parentNodeId?: string | null;
    displayTitle?: string | null;
    reassignRelationships?: boolean;
  },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<PageConversionPreview>> {
  const input = {
    ...raw,
    sourcePageId: raw.sourcePageId ?? null,
    title: raw.title?.trim() || undefined,
    parentNodeId: raw.parentNodeId ?? null,
    displayTitle: raw.displayTitle?.trim() || null,
    reassignRelationships: raw.reassignRelationships ?? false,
  };
  if (Buffer.byteLength(JSON.stringify(input.sourceDescriptor)) > 64 * 1024
    || Buffer.byteLength(JSON.stringify(input.targetDescriptor)) > 64 * 1024) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Conversion descriptors are too large.");
  }
  const operation = "page_conversion.prepare";
  const digest = requestDigest(input);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<PageConversionPreview>(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      principalId: context.actorPrincipalId,
      operation,
      key: context.idempotencyKey,
      digest,
    });
    if (replay) return replay;

    let sourceType: "git" | "native" | null = null;
    let sourceTitle = input.title;
    let proposal: Record<string, unknown>;
    const warnings: unknown[] = [];
    if (input.sourcePageId) {
      const source = await assertPageExists(client, input.workspaceId, input.projectId, input.sourcePageId);
      sourceType = source.sourceType;
      await authorizePageCapability(client, {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        principalId: context.actorPrincipalId,
        capability: "page.read",
        pageId: input.sourcePageId,
      });
      const titleResult = await client.query<{ title: string }>(`
        SELECT title FROM pages WHERE workspace_id = $1 AND project_id = $2 AND id = $3
      `, [input.workspaceId, input.projectId, input.sourcePageId]);
      sourceTitle = sourceTitle ?? titleResult.rows[0]?.title;
    }

    if (input.operation === "git_to_native" || (input.operation === "convert" && sourceType === "git")) {
      if (sourceType && sourceType !== "git") throw new FoundationServiceError("CONFLICT", "Git-to-native operations require a Git-backed source page.");
      if (typeof input.markdown !== "string") throw new FoundationServiceError("VALIDATION_FAILED", "Git-to-native import requires exact Markdown source.");
      const analysis = analyzeMarkdown(input.markdown);
      warnings.push(...analysis.warnings, ...analysis.blocks.filter((block) => block.protected).map((block) => ({
        code: "protected_raw_imported",
        blockIndex: block.index,
        reason: block.protectedReason,
      })));
      proposal = {
        resultType: "native_page",
        title: sourceTitle ?? "Imported page",
        nativeDocument: markdownToNativeDocument(input.markdown),
        sourceMarkdownHash: analysis.sourceHash,
        parentNodeId: input.parentNodeId,
        displayTitle: input.displayTitle,
      };
      await authorizePageCapability(client, {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        principalId: context.actorPrincipalId,
        capability: "page.create",
      });
    } else {
      if (!input.sourcePageId || sourceType !== "native") {
        throw new FoundationServiceError("CONFLICT", "Native-to-Git operations require a native source page.");
      }
      await authorizePageCapability(client, {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        principalId: context.actorPrincipalId,
        capability: "page.edit",
        pageId: input.sourcePageId,
      });
      const revision = await client.query<{ id: string; content: ProseMirrorNode; content_hash: string; sequence: string }>(`
        SELECT r.id, r.content, r.content_hash, r.sequence
        FROM native_pages n
        JOIN native_page_revisions r
          ON r.workspace_id = n.workspace_id AND r.project_id = n.project_id AND r.id = n.current_revision_id
        WHERE n.workspace_id = $1 AND n.project_id = $2 AND n.page_id = $3
      `, [input.workspaceId, input.projectId, input.sourcePageId]);
      if (!revision.rows[0]) throw new FoundationServiceError("NOT_FOUND", "Native page revision was not found.");
      const markdown = nativeDocumentToMarkdown(revision.rows[0].content);
      const analysis = analyzeMarkdown(markdown);
      warnings.push(...analysis.warnings);
      proposal = {
        resultType: "git_markdown_proposal",
        markdown,
        markdownHash: analysis.sourceHash,
        sourceRevisionId: revision.rows[0].id,
        sourceSequence: Number(revision.rows[0].sequence),
        sourceContentHash: revision.rows[0].content_hash,
        requiresGitOperation: true,
      };
    }

    const relationships = await relationshipPreview(
      client,
      input.workspaceId,
      input.projectId,
      input.sourcePageId,
      input.operation === "convert" && input.reassignRelationships,
    );
    const previewId = newFolioId();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 30 * 60 * 1000);
    const inserted = await client.query<PreviewRow>(`
      INSERT INTO page_conversion_previews (
        id, workspace_id, project_id, source_page_id, operation,
        source_descriptor, target_descriptor, relationship_plan, warnings,
        proposal, created_by_principal_id, created_at, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING id, operation, source_page_id, source_descriptor, target_descriptor,
        relationship_plan, warnings, proposal, state, revision,
        created_by_principal_id, created_at, expires_at, executed_at
    `, [previewId, input.workspaceId, input.projectId, input.sourcePageId, input.operation,
      input.sourceDescriptor, input.targetDescriptor, relationships, warnings, proposal,
      context.actorPrincipalId, now, expiresAt]);
    const data = mapPreview(inserted.rows[0]!);
    return recordMutation(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      context,
      operation,
      digest,
      action: operation,
      targetType: "page_conversion_preview",
      targetId: previewId,
      aggregateType: "page_conversion_preview",
      aggregateRevision: 1,
      eventType: "page_conversion.prepared.v1",
      inputSummary: { operation: input.operation, sourcePageId: input.sourcePageId },
      resultSummary: { previewId, warningCount: warnings.length, expiresAt: expiresAt.toISOString() },
      data,
    });
  });
}

async function createNativePageFromPreview(
  client: PoolClient,
  input: { workspaceId: string; projectId: string; preview: PreviewRow; actorPrincipalId: string },
): Promise<string> {
  const proposal = input.preview.proposal;
  const title = typeof proposal.title === "string" ? proposal.title.trim() : "Imported page";
  const document = proposal.nativeDocument as ProseMirrorNode | undefined;
  if (!document || document.type !== "doc") throw new FoundationServiceError("CONFLICT", "Conversion preview does not contain a native document.");
  const parentNodeId = typeof proposal.parentNodeId === "string" ? proposal.parentNodeId : null;
  const displayTitle = typeof proposal.displayTitle === "string" ? proposal.displayTitle : null;
  if (parentNodeId) {
    const parent = await client.query(`
      SELECT 1 FROM page_tree_nodes
      WHERE workspace_id = $1 AND project_id = $2 AND id = $3
        AND node_kind = 'folder' AND archived_at IS NULL
    `, [input.workspaceId, input.projectId, parentNodeId]);
    if (!parent.rows[0]) throw new FoundationServiceError("NOT_FOUND", "Conversion target folder was not found.");
  }
  const pageId = newFolioId();
  const revisionId = newFolioId();
  const now = new Date();
  const contentHash = createHash("sha256").update(JSON.stringify(document)).digest("hex");
  await client.query(`
    INSERT INTO pages (
      id, workspace_id, project_id, source_type, title,
      created_by_principal_id, updated_by_principal_id, created_at, updated_at
    ) VALUES ($1, $2, $3, 'native', $4, $5, $5, $6, $6)
  `, [pageId, input.workspaceId, input.projectId, title, input.actorPrincipalId, now]);
  await client.query(`
    INSERT INTO native_pages (page_id, workspace_id, project_id, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $4)
  `, [pageId, input.workspaceId, input.projectId, now]);
  await client.query(`
    INSERT INTO native_page_revisions (
      id, workspace_id, project_id, page_id, sequence, editor_schema_version,
      content, plain_text, content_hash, author_principal_id, created_at
    ) VALUES ($1, $2, $3, $4, 1, 1, $5, $6, $7, $8, $9)
  `, [revisionId, input.workspaceId, input.projectId, pageId, document, plainText(document),
    contentHash, input.actorPrincipalId, now]);
  await client.query(`UPDATE native_pages SET current_revision_id = $1 WHERE page_id = $2`, [revisionId, pageId]);

  const plan = input.preview.relationship_plan as {
    reassignRelationships?: boolean;
    treeNodeIds?: string[];
    incomingLinkIds?: string[];
  };
  if (input.preview.operation === "convert" && plan.reassignRelationships && input.preview.source_page_id) {
    await client.query(`
      UPDATE page_tree_nodes
      SET page_id = $1, revision = revision + 1,
        updated_by_principal_id = $2, updated_at = $3
      WHERE workspace_id = $4 AND project_id = $5
        AND id = ANY($6::uuid[]) AND page_id = $7
    `, [pageId, input.actorPrincipalId, now, input.workspaceId, input.projectId,
      plan.treeNodeIds ?? [], input.preview.source_page_id]);
    await client.query(`
      UPDATE page_links SET target_page_id = $1
      WHERE workspace_id = $2 AND project_id = $3
        AND id = ANY($4::uuid[]) AND target_page_id = $5
    `, [pageId, input.workspaceId, input.projectId, plan.incomingLinkIds ?? [], input.preview.source_page_id]);
  } else {
    await client.query(`
      INSERT INTO page_tree_nodes (
        id, workspace_id, project_id, parent_node_id, node_kind, page_id,
        display_title, created_by_principal_id, updated_by_principal_id,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, 'page', $5, $6, $7, $7, $8, $8)
    `, [newFolioId(), input.workspaceId, input.projectId, parentNodeId, pageId,
      displayTitle, input.actorPrincipalId, now]);
  }
  return pageId;
}

export async function executePageConversion(
  input: { workspaceId: string; projectId: string; previewId: string; expectedRevision: number },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<PageConversionExecution>> {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Expected revision must be a positive integer.");
  }
  const operation = "page_conversion.execute";
  const digest = requestDigest(input);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<PageConversionExecution>(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      principalId: context.actorPrincipalId,
      operation,
      key: context.idempotencyKey,
      digest,
    });
    if (replay) return replay;
    const current = await client.query<PreviewRow>(`
      SELECT id, operation, source_page_id, source_descriptor, target_descriptor,
        relationship_plan, warnings, proposal, state, revision,
        created_by_principal_id, created_at, expires_at, executed_at
      FROM page_conversion_previews
      WHERE workspace_id = $1 AND project_id = $2 AND id = $3
      FOR UPDATE
    `, [input.workspaceId, input.projectId, input.previewId]);
    const preview = current.rows[0];
    if (!preview) throw new FoundationServiceError("NOT_FOUND", "Page conversion preview was not found.");
    const revision = Number(preview.revision);
    if (revision !== input.expectedRevision) {
      throw new FoundationServiceError("REVISION_CONFLICT", "The conversion preview changed after it was read.", {
        expectedRevision: input.expectedRevision,
        currentRevision: revision,
      });
    }
    if (preview.state !== "prepared") throw new FoundationServiceError("CONFLICT", "Page conversion preview is no longer executable.");
    if (preview.expires_at <= new Date()) {
      await client.query(`UPDATE page_conversion_previews SET state = 'expired', revision = revision + 1 WHERE id = $1`, [preview.id]);
      throw new FoundationServiceError("CONFLICT", "Page conversion preview has expired.");
    }
    let createdPageId: string | null = null;
    let resultKind: PageConversionExecution["resultKind"];
    let requiresGitOperation = false;
    if (preview.operation === "git_to_native"
      || (preview.operation === "convert" && preview.proposal.resultType === "native_page")) {
      await authorizePageCapability(client, {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        principalId: context.actorPrincipalId,
        capability: "page.create",
      });
      createdPageId = await createNativePageFromPreview(client, {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        preview,
        actorPrincipalId: context.actorPrincipalId,
      });
      resultKind = "native_page_created";
    } else {
      if (!preview.source_page_id) throw new FoundationServiceError("CONFLICT", "Export preview has no source page.");
      await authorizePageCapability(client, {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        principalId: context.actorPrincipalId,
        capability: "page.edit",
        pageId: preview.source_page_id,
      });
      resultKind = "git_proposal_ready";
      requiresGitOperation = true;
    }
    const executedAt = new Date();
    const updated = await client.query<PreviewRow>(`
      UPDATE page_conversion_previews
      SET state = 'executed', revision = revision + 1, executed_at = $1,
        proposal = proposal || $2::jsonb
      WHERE id = $3
      RETURNING id, operation, source_page_id, source_descriptor, target_descriptor,
        relationship_plan, warnings, proposal, state, revision,
        created_by_principal_id, created_at, expires_at, executed_at
    `, [executedAt, { createdPageId, resultKind, requiresGitOperation }, preview.id]);
    const data: PageConversionExecution = {
      preview: mapPreview(updated.rows[0]!),
      createdPageId,
      resultKind,
      requiresGitOperation,
    };
    return recordMutation(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      context,
      operation,
      digest,
      action: operation,
      targetType: "page_conversion_preview",
      targetId: preview.id,
      aggregateType: "page_conversion_preview",
      aggregateRevision: revision + 1,
      eventType: "page_conversion.executed.v1",
      inputSummary: { previewId: preview.id, expectedRevision: input.expectedRevision },
      resultSummary: { createdPageId, resultKind, requiresGitOperation },
      data,
    });
  });
}

export async function readPageConversionPreview(
  input: { workspaceId: string; projectId: string; previewId: string },
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<PageConversionPreview> {
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, principalId);
    const result = await client.query<PreviewRow>(`
      SELECT id, operation, source_page_id, source_descriptor, target_descriptor,
        relationship_plan, warnings, proposal, state, revision,
        created_by_principal_id, created_at, expires_at, executed_at
      FROM page_conversion_previews
      WHERE workspace_id = $1 AND project_id = $2 AND id = $3
    `, [input.workspaceId, input.projectId, input.previewId]);
    const row = result.rows[0];
    if (!row) throw new FoundationServiceError("NOT_FOUND", "Page conversion preview was not found.");
    if (row.source_page_id) {
      await authorizePageCapability(client, {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        principalId,
        capability: "page.read",
        pageId: row.source_page_id,
      });
    } else {
      await authorizePageCapability(client, {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        principalId,
        capability: "page.create",
      });
    }
    return mapPreview(row);
  });
}
