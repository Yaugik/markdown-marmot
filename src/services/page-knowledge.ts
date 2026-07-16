import type { Pool, PoolClient } from "pg";
import type { ProjectCapability } from "@/auth/capabilities";
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
import { assertPageExists, authorizePageCapability } from "@/services/page-access";

const pageGrantCapabilities = new Set<ProjectCapability>([
  "page.read",
  "page.edit",
  "page.comment",
  "page.archive",
]);

export type PageLink = {
  id: string;
  sourcePageId: string;
  sourceRevisionId: string | null;
  targetPageId: string | null;
  externalUrl: string | null;
  linkKind: "page" | "external";
  label: string | null;
  locator: Record<string, unknown>;
  state: "current" | "stale" | "broken";
  createdAt: string;
};
export type PageSearchResult = {
  pageId: string;
  sourceType: "git" | "native";
  title: string;
  snippet: string;
  score: number;
  status: "active" | "archived" | "unavailable";
  updatedAt: string;
};
export type PageGrant = {
  id: string;
  pageId: string;
  principalId: string;
  capabilities: ProjectCapability[];
  validUntil: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

type LinkRow = {
  id: string;
  source_page_id: string;
  source_revision_id: string | null;
  target_page_id: string | null;
  external_url: string | null;
  link_kind: PageLink["linkKind"];
  label: string | null;
  locator: Record<string, unknown>;
  state: PageLink["state"];
  created_at: Date;
};
type GrantRow = {
  id: string;
  object_id: string;
  principal_id: string;
  capabilities: ProjectCapability[];
  valid_until: Date | null;
  revision: string;
  created_at: Date;
  updated_at: Date;
};

function mapLink(row: LinkRow): PageLink {
  return {
    id: row.id,
    sourcePageId: row.source_page_id,
    sourceRevisionId: row.source_revision_id,
    targetPageId: row.target_page_id,
    externalUrl: row.external_url,
    linkKind: row.link_kind,
    label: row.label,
    locator: row.locator,
    state: row.state,
    createdAt: row.created_at.toISOString(),
  };
}
function mapGrant(row: GrantRow): PageGrant {
  return {
    id: row.id,
    pageId: row.object_id,
    principalId: row.principal_id,
    capabilities: row.capabilities,
    validUntil: row.valid_until?.toISOString() ?? null,
    revision: Number(row.revision),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function normalizeLinks(
  links: readonly Array<{
    targetPageId?: string | null;
    externalUrl?: string | null;
    label?: string | null;
    locator?: Record<string, unknown>;
  }>,
) {
  if (links.length > 1000) throw new FoundationServiceError("VALIDATION_FAILED", "A page may expose at most 1,000 links.");
  return links.map((link) => {
    const targetPageId = link.targetPageId ?? null;
    const externalUrl = link.externalUrl?.trim() || null;
    if ((targetPageId ? 1 : 0) + (externalUrl ? 1 : 0) !== 1) {
      throw new FoundationServiceError("VALIDATION_FAILED", "Each link requires exactly one page target or external URL.");
    }
    if (externalUrl) {
      let parsed: URL;
      try {
        parsed = new URL(externalUrl);
      } catch {
        throw new FoundationServiceError("VALIDATION_FAILED", "External link URL is invalid.");
      }
      if (!["http:", "https:", "mailto:"].includes(parsed.protocol)) {
        throw new FoundationServiceError("VALIDATION_FAILED", "External links must use http, https, or mailto.");
      }
    }
    const locator = link.locator ?? {};
    if (Buffer.byteLength(JSON.stringify(locator)) > 16 * 1024) {
      throw new FoundationServiceError("VALIDATION_FAILED", "Link locator is too large.");
    }
    return {
      targetPageId,
      externalUrl,
      label: link.label?.trim().slice(0, 500) || null,
      locator,
    };
  });
}

async function resolveCurrentSourceRevision(
  client: PoolClient,
  input: { workspaceId: string; projectId: string; pageId: string; sourceRevisionId?: string | null },
): Promise<string | null> {
  const page = await assertPageExists(client, input.workspaceId, input.projectId, input.pageId);
  if (page.status !== "active") throw new FoundationServiceError("CONFLICT", "Links can only be refreshed for active pages.");
  if (page.sourceType === "git") return input.sourceRevisionId ?? null;
  const result = await client.query<{ current_revision_id: string }>(`
    SELECT current_revision_id FROM native_pages
    WHERE workspace_id = $1 AND project_id = $2 AND page_id = $3
  `, [input.workspaceId, input.projectId, input.pageId]);
  const currentRevisionId = result.rows[0]?.current_revision_id;
  if (!currentRevisionId) throw new FoundationServiceError("NOT_FOUND", "Native page revision was not found.");
  if (input.sourceRevisionId && input.sourceRevisionId !== currentRevisionId) {
    throw new FoundationServiceError("REVISION_CONFLICT", "Links were extracted from a stale native page revision.", {
      expectedRevision: input.sourceRevisionId,
      currentRevision: currentRevisionId,
    });
  }
  return currentRevisionId;
}

export async function replacePageLinks(
  raw: {
    workspaceId: string;
    projectId: string;
    pageId: string;
    sourceRevisionId?: string | null;
    links: Array<{
      targetPageId?: string | null;
      externalUrl?: string | null;
      label?: string | null;
      locator?: Record<string, unknown>;
    }>;
  },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<PageLink[]>> {
  const input = { ...raw, links: normalizeLinks(raw.links) };
  const operation = "page_links.replace";
  const digest = requestDigest(input);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<PageLink[]>(client, {
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
      capability: "page.edit",
      pageId: input.pageId,
    });
    const sourceRevisionId = await resolveCurrentSourceRevision(client, input);
    const pageTargets = [...new Set(input.links.map((link) => link.targetPageId).filter(Boolean) as string[])];
    if (pageTargets.length) {
      const targets = await client.query<{ id: string }>(`
        SELECT id FROM pages
        WHERE workspace_id = $1 AND project_id = $2 AND id = ANY($3::uuid[])
          AND status <> 'unavailable'
      `, [input.workspaceId, input.projectId, pageTargets]);
      const valid = new Set(targets.rows.map((row) => row.id));
      const missing = pageTargets.filter((id) => !valid.has(id));
      if (missing.length) throw new FoundationServiceError("NOT_FOUND", "One or more page link targets were not found.", { missing });
    }
    await client.query(`
      DELETE FROM page_links
      WHERE workspace_id = $1 AND project_id = $2 AND source_page_id = $3
    `, [input.workspaceId, input.projectId, input.pageId]);
    const created: PageLink[] = [];
    for (const link of input.links) {
      const id = newFolioId();
      const createdAt = new Date();
      const linkKind: PageLink["linkKind"] = link.targetPageId ? "page" : "external";
      await client.query(`
        INSERT INTO page_links (
          id, workspace_id, project_id, source_page_id, source_revision_id,
          target_page_id, external_url, link_kind, label, locator, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `, [id, input.workspaceId, input.projectId, input.pageId, sourceRevisionId,
        link.targetPageId, link.externalUrl, linkKind, link.label, link.locator, createdAt]);
      created.push({
        id,
        sourcePageId: input.pageId,
        sourceRevisionId,
        targetPageId: link.targetPageId,
        externalUrl: link.externalUrl,
        linkKind,
        label: link.label,
        locator: link.locator,
        state: "current",
        createdAt: createdAt.toISOString(),
      });
    }
    const page = await assertPageExists(client, input.workspaceId, input.projectId, input.pageId);
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
      aggregateRevision: page.revision,
      eventType: "page_links.replaced.v1",
      inputSummary: { pageId: input.pageId, linkCount: input.links.length },
      resultSummary: { pageId: input.pageId, linkCount: created.length, sourceRevisionId },
      data: created,
    });
  });
}

export async function listPageLinks(
  input: { workspaceId: string; projectId: string; pageId: string; includeStale?: boolean },
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<PageLink[]> {
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, principalId);
    await authorizePageCapability(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      principalId,
      capability: "page.read",
      pageId: input.pageId,
    });
    const result = await client.query<LinkRow>(`
      SELECT id, source_page_id, source_revision_id, target_page_id, external_url,
        link_kind, label, locator, state, created_at
      FROM page_links
      WHERE workspace_id = $1 AND project_id = $2 AND source_page_id = $3
        AND ($4::boolean OR state = 'current')
      ORDER BY created_at, id
    `, [input.workspaceId, input.projectId, input.pageId, input.includeStale ?? false]);
    return result.rows.map(mapLink);
  });
}

export async function listPageBacklinks(
  input: { workspaceId: string; projectId: string; pageId: string; includeStale?: boolean },
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<PageLink[]> {
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, principalId);
    await authorizePageCapability(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      principalId,
      capability: "page.read",
      pageId: input.pageId,
    });
    const result = await client.query<LinkRow>(`
      SELECT id, source_page_id, source_revision_id, target_page_id, external_url,
        link_kind, label, locator, state, created_at
      FROM page_links
      WHERE workspace_id = $1 AND project_id = $2 AND target_page_id = $3
        AND ($4::boolean OR state = 'current')
      ORDER BY created_at DESC, id DESC
      LIMIT 500
    `, [input.workspaceId, input.projectId, input.pageId, input.includeStale ?? false]);
    const permitted: PageLink[] = [];
    for (const row of result.rows) {
      try {
        await authorizePageCapability(client, {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          principalId,
          capability: "page.read",
          pageId: row.source_page_id,
        });
        permitted.push(mapLink(row));
      } catch (error) {
        if (!(error instanceof FoundationServiceError) || error.code !== "CAPABILITY_DENIED") throw error;
      }
    }
    return permitted;
  });
}

export async function searchPages(
  input: { workspaceId: string; projectId: string; query: string; limit?: number; includeArchived?: boolean },
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<PageSearchResult[]> {
  const query = input.query.trim();
  const limit = input.limit ?? 20;
  if (!query || query.length > 500) throw new FoundationServiceError("VALIDATION_FAILED", "Search query must contain 1 to 500 characters.");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Search limit must be between 1 and 100.");
  }
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, principalId);
    const result = await client.query<{
      page_id: string;
      source_type: "git" | "native";
      title: string;
      snippet: string;
      score: number;
      status: PageSearchResult["status"];
      updated_at: Date;
    }>(`
      SELECT d.page_id, d.source_type, d.title,
        ts_headline('simple', d.body, websearch_to_tsquery('simple', $3),
          'MaxFragments=2,MaxWords=30,MinWords=5,StartSel=<mark>,StopSel=</mark>') snippet,
        ts_rank_cd(d.search_vector, websearch_to_tsquery('simple', $3)) score,
        p.status, d.updated_at
      FROM page_search_documents d
      JOIN pages p
        ON p.workspace_id = d.workspace_id AND p.project_id = d.project_id AND p.id = d.page_id
      WHERE d.workspace_id = $1 AND d.project_id = $2
        AND d.search_vector @@ websearch_to_tsquery('simple', $3)
        AND ($4::boolean OR p.status = 'active')
      ORDER BY score DESC, d.updated_at DESC, d.page_id
      LIMIT 500
    `, [input.workspaceId, input.projectId, query, input.includeArchived ?? false]);
    const permitted: PageSearchResult[] = [];
    for (const row of result.rows) {
      if (permitted.length >= limit) break;
      try {
        await authorizePageCapability(client, {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          principalId,
          capability: "page.read",
          pageId: row.page_id,
        });
        permitted.push({
          pageId: row.page_id,
          sourceType: row.source_type,
          title: row.title,
          snippet: row.snippet,
          score: Number(row.score),
          status: row.status,
          updatedAt: row.updated_at.toISOString(),
        });
      } catch (error) {
        if (!(error instanceof FoundationServiceError) || error.code !== "CAPABILITY_DENIED") throw error;
      }
    }
    return permitted;
  });
}

export async function indexGitPageSearchDocument(
  input: { workspaceId: string; projectId: string; pageId: string; title: string; body: string; revisionId?: string | null },
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<void> {
  await inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, principalId);
    const page = await assertPageExists(client, input.workspaceId, input.projectId, input.pageId);
    if (page.sourceType !== "git") throw new FoundationServiceError("CONFLICT", "Git search indexing requires a Git-backed page.");
    await client.query(`
      INSERT INTO page_search_documents (
        workspace_id, project_id, page_id, source_type, title, body, current_revision_id, updated_at
      ) VALUES ($1, $2, $3, 'git', $4, $5, $6, now())
      ON CONFLICT (workspace_id, project_id, page_id)
      DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body,
        current_revision_id = EXCLUDED.current_revision_id, updated_at = now()
    `, [input.workspaceId, input.projectId, input.pageId, input.title.trim(), input.body, input.revisionId ?? null]);
  });
}

export async function listPageGrants(
  input: { workspaceId: string; projectId: string; pageId: string },
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<PageGrant[]> {
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, principalId);
    await authorizePageCapability(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      principalId,
      capability: "project.grants.manage",
    });
    await assertPageExists(client, input.workspaceId, input.projectId, input.pageId);
    const result = await client.query<GrantRow>(`
      SELECT id, object_id, principal_id, capabilities, valid_until, revision, created_at, updated_at
      FROM object_grants
      WHERE workspace_id = $1 AND project_id = $2 AND object_type = 'page' AND object_id = $3
      ORDER BY created_at, id
    `, [input.workspaceId, input.projectId, input.pageId]);
    return result.rows.map(mapGrant);
  });
}

export async function setPageGrant(
  raw: {
    workspaceId: string;
    projectId: string;
    pageId: string;
    principalId: string;
    capabilities: ProjectCapability[];
    validUntil?: string | null;
    expectedRevision?: number;
  },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<PageGrant>> {
  const capabilities = [...new Set(raw.capabilities)];
  if (!capabilities.length || capabilities.some((capability) => !pageGrantCapabilities.has(capability))) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Page grants require supported page capabilities.");
  }
  const validUntil = raw.validUntil ? new Date(raw.validUntil) : null;
  if (validUntil && (!Number.isFinite(validUntil.getTime()) || validUntil <= new Date())) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Grant expiry must be a future timestamp.");
  }
  const input = { ...raw, capabilities, validUntil: validUntil?.toISOString() ?? null };
  const operation = "page_grant.set";
  const digest = requestDigest(input);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<PageGrant>(client, {
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
      capability: "project.grants.manage",
    });
    const page = await assertPageExists(client, input.workspaceId, input.projectId, input.pageId);
    const member = await client.query(`
      SELECT 1 FROM project_memberships
      WHERE workspace_id = $1 AND project_id = $2 AND principal_id = $3 AND status = 'active'
    `, [input.workspaceId, input.projectId, input.principalId]);
    if (!member.rows[0]) throw new FoundationServiceError("NOT_FOUND", "Grant principal is not an active project member.");
    const current = await client.query<GrantRow>(`
      SELECT id, object_id, principal_id, capabilities, valid_until, revision, created_at, updated_at
      FROM object_grants
      WHERE workspace_id = $1 AND project_id = $2 AND object_type = 'page'
        AND object_id = $3 AND principal_id = $4
      FOR UPDATE
    `, [input.workspaceId, input.projectId, input.pageId, input.principalId]);
    const now = new Date();
    let row: GrantRow;
    if (current.rows[0]) {
      const revision = Number(current.rows[0].revision);
      if (input.expectedRevision === undefined || input.expectedRevision !== revision) {
        throw new FoundationServiceError("REVISION_CONFLICT", "The page grant changed after it was read.", {
          expectedRevision: input.expectedRevision ?? 0,
          currentRevision: revision,
        });
      }
      const updated = await client.query<GrantRow>(`
        UPDATE object_grants
        SET capabilities = $1, valid_until = $2, revision = revision + 1, updated_at = $3,
          granted_by_principal_id = $4
        WHERE id = $5
        RETURNING id, object_id, principal_id, capabilities, valid_until, revision, created_at, updated_at
      `, [capabilities, validUntil, now, context.actorPrincipalId, current.rows[0].id]);
      row = updated.rows[0]!;
    } else {
      if (input.expectedRevision !== undefined) {
        throw new FoundationServiceError("REVISION_CONFLICT", "The page grant does not exist.", {
          expectedRevision: input.expectedRevision,
          currentRevision: 0,
        });
      }
      const id = newFolioId();
      const inserted = await client.query<GrantRow>(`
        INSERT INTO object_grants (
          id, workspace_id, project_id, principal_id, object_type, object_id,
          capabilities, granted_by_principal_id, valid_until, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, 'page', $5, $6, $7, $8, $9, $9)
        RETURNING id, object_id, principal_id, capabilities, valid_until, revision, created_at, updated_at
      `, [id, input.workspaceId, input.projectId, input.principalId, input.pageId,
        capabilities, context.actorPrincipalId, validUntil, now]);
      row = inserted.rows[0]!;
    }
    const data = mapGrant(row);
    return recordMutation(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      context,
      operation,
      digest,
      action: operation,
      targetType: "page_grant",
      targetId: row.id,
      aggregateType: "page",
      aggregateRevision: page.revision,
      eventType: "page_grant.set.v1",
      inputSummary: { pageId: input.pageId, principalId: input.principalId, capabilities },
      resultSummary: { grantId: row.id, revision: data.revision },
      data,
    });
  });
}
