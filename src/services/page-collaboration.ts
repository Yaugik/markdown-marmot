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
import { assertPageExists, authorizePageCapability } from "@/services/page-access";

export type CommentBody = Record<string, unknown>;
export type PageMention = {
  id: string;
  pageId: string;
  commentId: string | null;
  mentionedPrincipalId: string;
  state: "unread" | "read" | "dismissed";
  createdAt: string;
  readAt: string | null;
};
export type PageComment = {
  id: string;
  threadId: string;
  body: CommentBody;
  plainText: string;
  revision: number;
  authorPrincipalId: string;
  mentions: PageMention[];
  createdAt: string;
  updatedAt: string;
};
export type PageCommentThread = {
  id: string;
  pageId: string;
  pageRevisionId: string | null;
  anchor: Record<string, unknown>;
  anchorState: "current" | "moved" | "stale";
  status: "open" | "resolved";
  revision: number;
  createdByPrincipalId: string;
  resolvedByPrincipalId: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  comments: PageComment[];
};

type ThreadRow = {
  id: string;
  page_id: string;
  page_revision_id: string | null;
  anchor: Record<string, unknown>;
  anchor_state: PageCommentThread["anchorState"];
  status: PageCommentThread["status"];
  revision: string;
  created_by_principal_id: string;
  resolved_by_principal_id: string | null;
  created_at: Date;
  updated_at: Date;
  resolved_at: Date | null;
};
type CommentRow = {
  id: string;
  thread_id: string;
  body: CommentBody;
  plain_text: string;
  revision: string;
  author_principal_id: string;
  created_at: Date;
  updated_at: Date;
};
type MentionRow = {
  id: string;
  page_id: string;
  comment_id: string | null;
  mentioned_principal_id: string;
  state: PageMention["state"];
  created_at: Date;
  read_at: Date | null;
};

function normalizeBody(value: unknown): { body: CommentBody; plainText: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Comment body must be a structured object.");
  }
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > 64 * 1024) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Comment body must be at most 64 KiB.");
  }
  const parts: string[] = [];
  const visit = (candidate: unknown, depth: number) => {
    if (depth > 50) throw new FoundationServiceError("VALIDATION_FAILED", "Comment body is too deeply nested.");
    if (typeof candidate === "string") parts.push(candidate);
    else if (Array.isArray(candidate)) candidate.forEach((item) => visit(item, depth + 1));
    else if (candidate && typeof candidate === "object") {
      const record = candidate as Record<string, unknown>;
      if (typeof record.text === "string") parts.push(record.text);
      else Object.values(record).forEach((item) => visit(item, depth + 1));
    }
  };
  visit(value, 0);
  const plainText = parts.join(" ").replace(/\s+/g, " ").trim();
  if (!plainText || plainText.length > 10_000) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Comment text must contain 1 to 10,000 characters.");
  }
  return { body: value as CommentBody, plainText };
}

function normalizeMentions(value: readonly string[] | undefined): string[] {
  const mentions = [...new Set(value ?? [])];
  if (mentions.length > 50) {
    throw new FoundationServiceError("VALIDATION_FAILED", "A comment may mention at most 50 principals.");
  }
  return mentions;
}

async function validateMentionedPrincipals(
  client: PoolClient,
  workspaceId: string,
  projectId: string,
  principalIds: readonly string[],
) {
  if (!principalIds.length) return;
  const result = await client.query<{ principal_id: string }>(`
    SELECT principal_id
    FROM project_memberships
    WHERE workspace_id = $1 AND project_id = $2
      AND principal_id = ANY($3::uuid[]) AND status = 'active'
  `, [workspaceId, projectId, principalIds]);
  const valid = new Set(result.rows.map((row) => row.principal_id));
  const invalid = principalIds.filter((id) => !valid.has(id));
  if (invalid.length) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Mentioned principals must be active project members.", {
      invalidPrincipalIds: invalid,
    });
  }
}

async function insertMentions(
  client: PoolClient,
  input: {
    workspaceId: string;
    projectId: string;
    pageId: string;
    commentId: string;
    mentionedPrincipalIds: readonly string[];
    actorPrincipalId: string;
  },
): Promise<PageMention[]> {
  await validateMentionedPrincipals(client, input.workspaceId, input.projectId, input.mentionedPrincipalIds);
  const mentions: PageMention[] = [];
  for (const principalId of input.mentionedPrincipalIds) {
    const id = newFolioId();
    const createdAt = new Date();
    await client.query(`
      INSERT INTO mentions (
        id, workspace_id, project_id, page_id, comment_id,
        mentioned_principal_id, created_by_principal_id, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [id, input.workspaceId, input.projectId, input.pageId, input.commentId,
      principalId, input.actorPrincipalId, createdAt]);
    mentions.push({
      id,
      pageId: input.pageId,
      commentId: input.commentId,
      mentionedPrincipalId: principalId,
      state: "unread",
      createdAt: createdAt.toISOString(),
      readAt: null,
    });
  }
  return mentions;
}

function mapMention(row: MentionRow): PageMention {
  return {
    id: row.id,
    pageId: row.page_id,
    commentId: row.comment_id,
    mentionedPrincipalId: row.mentioned_principal_id,
    state: row.state,
    createdAt: row.created_at.toISOString(),
    readAt: row.read_at?.toISOString() ?? null,
  };
}

async function hydrateThreads(client: PoolClient, rows: ThreadRow[]): Promise<PageCommentThread[]> {
  if (!rows.length) return [];
  const threadIds = rows.map((row) => row.id);
  const comments = await client.query<CommentRow>(`
    SELECT id, thread_id, body, plain_text, revision, author_principal_id,
      created_at, updated_at
    FROM page_comments
    WHERE thread_id = ANY($1::uuid[]) AND archived_at IS NULL
    ORDER BY created_at, id
  `, [threadIds]);
  const commentIds = comments.rows.map((row) => row.id);
  const mentions = commentIds.length
    ? await client.query<MentionRow>(`
        SELECT id, page_id, comment_id, mentioned_principal_id, state, created_at, read_at
        FROM mentions WHERE comment_id = ANY($1::uuid[])
        ORDER BY created_at, id
      `, [commentIds])
    : { rows: [] as MentionRow[] };
  const mentionsByComment = new Map<string, PageMention[]>();
  for (const mention of mentions.rows) {
    if (!mention.comment_id) continue;
    const list = mentionsByComment.get(mention.comment_id) ?? [];
    list.push(mapMention(mention));
    mentionsByComment.set(mention.comment_id, list);
  }
  const commentsByThread = new Map<string, PageComment[]>();
  for (const row of comments.rows) {
    const list = commentsByThread.get(row.thread_id) ?? [];
    list.push({
      id: row.id,
      threadId: row.thread_id,
      body: row.body,
      plainText: row.plain_text,
      revision: Number(row.revision),
      authorPrincipalId: row.author_principal_id,
      mentions: mentionsByComment.get(row.id) ?? [],
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    });
    commentsByThread.set(row.thread_id, list);
  }
  return rows.map((row) => ({
    id: row.id,
    pageId: row.page_id,
    pageRevisionId: row.page_revision_id,
    anchor: row.anchor,
    anchorState: row.anchor_state,
    status: row.status,
    revision: Number(row.revision),
    createdByPrincipalId: row.created_by_principal_id,
    resolvedByPrincipalId: row.resolved_by_principal_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    resolvedAt: row.resolved_at?.toISOString() ?? null,
    comments: commentsByThread.get(row.id) ?? [],
  }));
}

async function resolveRevisionAnchor(
  client: PoolClient,
  input: { workspaceId: string; projectId: string; pageId: string; pageRevisionId?: string | null },
): Promise<{ revisionId: string | null; anchorState: "current" | "stale" }> {
  const page = await assertPageExists(client, input.workspaceId, input.projectId, input.pageId);
  if (page.status !== "active") {
    throw new FoundationServiceError("CONFLICT", "Comments can only be added to active pages.");
  }
  if (page.sourceType === "git") return { revisionId: null, anchorState: "current" };
  const current = await client.query<{ current_revision_id: string }>(`
    SELECT current_revision_id FROM native_pages
    WHERE workspace_id = $1 AND project_id = $2 AND page_id = $3
  `, [input.workspaceId, input.projectId, input.pageId]);
  const currentRevisionId = current.rows[0]?.current_revision_id;
  if (!currentRevisionId) throw new FoundationServiceError("NOT_FOUND", "Native page revision was not found.");
  const revisionId = input.pageRevisionId ?? currentRevisionId;
  const revision = await client.query(`
    SELECT 1 FROM native_page_revisions
    WHERE workspace_id = $1 AND project_id = $2 AND page_id = $3 AND id = $4
  `, [input.workspaceId, input.projectId, input.pageId, revisionId]);
  if (!revision.rows[0]) throw new FoundationServiceError("NOT_FOUND", "Native page revision was not found.");
  return { revisionId, anchorState: revisionId === currentRevisionId ? "current" : "stale" };
}

export async function createPageCommentThread(
  raw: {
    workspaceId: string;
    projectId: string;
    pageId: string;
    pageRevisionId?: string | null;
    anchor?: Record<string, unknown>;
    body: unknown;
    mentionedPrincipalIds?: string[];
  },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<PageCommentThread>> {
  const normalizedBody = normalizeBody(raw.body);
  const mentionedPrincipalIds = normalizeMentions(raw.mentionedPrincipalIds);
  const input = { ...raw, anchor: raw.anchor ?? {}, body: normalizedBody.body, mentionedPrincipalIds };
  const operation = "page_comment_thread.create";
  const digest = requestDigest(input);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<PageCommentThread>(client, {
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
      capability: "page.comment",
      pageId: input.pageId,
    });
    const anchor = await resolveRevisionAnchor(client, input);
    const threadId = newFolioId();
    const commentId = newFolioId();
    const now = new Date();
    await client.query(`
      INSERT INTO page_comment_threads (
        id, workspace_id, project_id, page_id, page_revision_id, anchor,
        anchor_state, created_by_principal_id, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
    `, [threadId, input.workspaceId, input.projectId, input.pageId, anchor.revisionId,
      input.anchor, anchor.anchorState, context.actorPrincipalId, now]);
    await client.query(`
      INSERT INTO page_comments (
        id, workspace_id, project_id, thread_id, body, plain_text,
        author_principal_id, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
    `, [commentId, input.workspaceId, input.projectId, threadId, input.body,
      normalizedBody.plainText, context.actorPrincipalId, now]);
    const mentions = await insertMentions(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      pageId: input.pageId,
      commentId,
      mentionedPrincipalIds,
      actorPrincipalId: context.actorPrincipalId,
    });
    const data: PageCommentThread = {
      id: threadId,
      pageId: input.pageId,
      pageRevisionId: anchor.revisionId,
      anchor: input.anchor,
      anchorState: anchor.anchorState,
      status: "open",
      revision: 1,
      createdByPrincipalId: context.actorPrincipalId,
      resolvedByPrincipalId: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      resolvedAt: null,
      comments: [{
        id: commentId,
        threadId,
        body: input.body,
        plainText: normalizedBody.plainText,
        revision: 1,
        authorPrincipalId: context.actorPrincipalId,
        mentions,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      }],
    };
    return recordMutation(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      context,
      operation,
      digest,
      action: operation,
      targetType: "page_comment_thread",
      targetId: threadId,
      aggregateType: "page_comment_thread",
      aggregateRevision: 1,
      eventType: "page_comment_thread.created.v1",
      inputSummary: { pageId: input.pageId, pageRevisionId: anchor.revisionId },
      resultSummary: { threadId, commentId, mentionCount: mentions.length },
      data,
    });
  });
}

export async function addPageComment(
  raw: {
    workspaceId: string;
    projectId: string;
    threadId: string;
    body: unknown;
    mentionedPrincipalIds?: string[];
  },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<PageComment>> {
  const normalizedBody = normalizeBody(raw.body);
  const mentionedPrincipalIds = normalizeMentions(raw.mentionedPrincipalIds);
  const input = { ...raw, body: normalizedBody.body, mentionedPrincipalIds };
  const operation = "page_comment.create";
  const digest = requestDigest(input);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<PageComment>(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      principalId: context.actorPrincipalId,
      operation,
      key: context.idempotencyKey,
      digest,
    });
    if (replay) return replay;
    const thread = await client.query<{ page_id: string; status: string; revision: string }>(`
      SELECT page_id, status, revision FROM page_comment_threads
      WHERE workspace_id = $1 AND project_id = $2 AND id = $3 AND archived_at IS NULL
      FOR UPDATE
    `, [input.workspaceId, input.projectId, input.threadId]);
    const row = thread.rows[0];
    if (!row) throw new FoundationServiceError("NOT_FOUND", "Comment thread was not found.");
    if (row.status !== "open") throw new FoundationServiceError("CONFLICT", "Resolved threads cannot receive comments.");
    await authorizePageCapability(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      principalId: context.actorPrincipalId,
      capability: "page.comment",
      pageId: row.page_id,
    });
    const page = await assertPageExists(client, input.workspaceId, input.projectId, row.page_id);
    if (page.status !== "active") throw new FoundationServiceError("CONFLICT", "Comments can only be added to active pages.");
    const commentId = newFolioId();
    const now = new Date();
    await client.query(`
      INSERT INTO page_comments (
        id, workspace_id, project_id, thread_id, body, plain_text,
        author_principal_id, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
    `, [commentId, input.workspaceId, input.projectId, input.threadId, input.body,
      normalizedBody.plainText, context.actorPrincipalId, now]);
    await client.query(`
      UPDATE page_comment_threads SET revision = revision + 1, updated_at = $1
      WHERE workspace_id = $2 AND project_id = $3 AND id = $4
    `, [now, input.workspaceId, input.projectId, input.threadId]);
    const mentions = await insertMentions(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      pageId: row.page_id,
      commentId,
      mentionedPrincipalIds,
      actorPrincipalId: context.actorPrincipalId,
    });
    const data: PageComment = {
      id: commentId,
      threadId: input.threadId,
      body: input.body,
      plainText: normalizedBody.plainText,
      revision: 1,
      authorPrincipalId: context.actorPrincipalId,
      mentions,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    return recordMutation(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      context,
      operation,
      digest,
      action: operation,
      targetType: "page_comment",
      targetId: commentId,
      aggregateType: "page_comment_thread",
      aggregateRevision: Number(row.revision) + 1,
      eventType: "page_comment.created.v1",
      inputSummary: { threadId: input.threadId },
      resultSummary: { commentId, mentionCount: mentions.length },
      data,
    });
  });
}

export async function listPageCommentThreads(
  input: { workspaceId: string; projectId: string; pageId: string; includeResolved?: boolean },
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<PageCommentThread[]> {
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, principalId);
    await authorizePageCapability(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      principalId,
      capability: "page.read",
      pageId: input.pageId,
    });
    await assertPageExists(client, input.workspaceId, input.projectId, input.pageId);
    const result = await client.query<ThreadRow>(`
      SELECT id, page_id, page_revision_id, anchor, anchor_state, status, revision,
        created_by_principal_id, resolved_by_principal_id, created_at, updated_at, resolved_at
      FROM page_comment_threads
      WHERE workspace_id = $1 AND project_id = $2 AND page_id = $3
        AND archived_at IS NULL AND ($4::boolean OR status = 'open')
      ORDER BY created_at, id
    `, [input.workspaceId, input.projectId, input.pageId, input.includeResolved ?? false]);
    return hydrateThreads(client, result.rows);
  });
}

export async function updatePageCommentThread(
  input: {
    workspaceId: string;
    projectId: string;
    threadId: string;
    expectedRevision: number;
    action: "resolve" | "reopen" | "reanchor";
    pageRevisionId?: string;
    anchor?: Record<string, unknown>;
  },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<PageCommentThread>> {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Expected revision must be a positive integer.");
  }
  if (input.action === "reanchor" && (!input.pageRevisionId || !input.anchor)) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Re-anchoring requires a page revision and anchor.");
  }
  const operation = `page_comment_thread.${input.action}`;
  const digest = requestDigest(input);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<PageCommentThread>(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      principalId: context.actorPrincipalId,
      operation,
      key: context.idempotencyKey,
      digest,
    });
    if (replay) return replay;
    const current = await client.query<ThreadRow>(`
      SELECT id, page_id, page_revision_id, anchor, anchor_state, status, revision,
        created_by_principal_id, resolved_by_principal_id, created_at, updated_at, resolved_at
      FROM page_comment_threads
      WHERE workspace_id = $1 AND project_id = $2 AND id = $3 AND archived_at IS NULL
      FOR UPDATE
    `, [input.workspaceId, input.projectId, input.threadId]);
    const row = current.rows[0];
    if (!row) throw new FoundationServiceError("NOT_FOUND", "Comment thread was not found.");
    const revision = Number(row.revision);
    if (revision !== input.expectedRevision) {
      throw new FoundationServiceError("REVISION_CONFLICT", "The comment thread changed after it was read.", {
        expectedRevision: input.expectedRevision,
        currentRevision: revision,
      });
    }
    await authorizePageCapability(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      principalId: context.actorPrincipalId,
      capability: "page.comment",
      pageId: row.page_id,
    });
    let nextStatus = row.status;
    let nextResolvedAt = row.resolved_at;
    let nextResolver = row.resolved_by_principal_id;
    let nextPageRevisionId = row.page_revision_id;
    let nextAnchor = row.anchor;
    let nextAnchorState = row.anchor_state;
    if (input.action === "resolve") {
      if (row.status === "resolved") throw new FoundationServiceError("CONFLICT", "Comment thread is already resolved.");
      nextStatus = "resolved";
      nextResolvedAt = new Date();
      nextResolver = context.actorPrincipalId;
    } else if (input.action === "reopen") {
      if (row.status === "open") throw new FoundationServiceError("CONFLICT", "Comment thread is already open.");
      nextStatus = "open";
      nextResolvedAt = null;
      nextResolver = null;
    } else {
      const anchor = await resolveRevisionAnchor(client, {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        pageId: row.page_id,
        pageRevisionId: input.pageRevisionId,
      });
      nextPageRevisionId = anchor.revisionId;
      nextAnchor = input.anchor!;
      nextAnchorState = row.page_revision_id === nextPageRevisionId ? "current" : "moved";
    }
    const now = new Date();
    await client.query(`
      UPDATE page_comment_threads
      SET page_revision_id = $1, anchor = $2, anchor_state = $3, status = $4,
        resolved_by_principal_id = $5, resolved_at = $6,
        revision = revision + 1, updated_at = $7
      WHERE workspace_id = $8 AND project_id = $9 AND id = $10
    `, [nextPageRevisionId, nextAnchor, nextAnchorState, nextStatus, nextResolver,
      nextResolvedAt, now, input.workspaceId, input.projectId, input.threadId]);
    const updated = await hydrateThreads(client, [{
      ...row,
      page_revision_id: nextPageRevisionId,
      anchor: nextAnchor,
      anchor_state: nextAnchorState,
      status: nextStatus,
      revision: String(revision + 1),
      resolved_by_principal_id: nextResolver,
      resolved_at: nextResolvedAt,
      updated_at: now,
    }]);
    return recordMutation(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      context,
      operation,
      digest,
      action: operation,
      targetType: "page_comment_thread",
      targetId: input.threadId,
      aggregateType: "page_comment_thread",
      aggregateRevision: revision + 1,
      eventType: `page_comment_thread.${input.action}d.v1`,
      inputSummary: { expectedRevision: input.expectedRevision },
      resultSummary: { threadId: input.threadId, status: nextStatus, anchorState: nextAnchorState },
      data: updated[0]!,
    });
  });
}

export async function listPrincipalMentions(
  input: { workspaceId: string; projectId: string; state?: PageMention["state"] },
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<PageMention[]> {
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, principalId);
    const result = await client.query<MentionRow>(`
      SELECT id, page_id, comment_id, mentioned_principal_id, state, created_at, read_at
      FROM mentions
      WHERE workspace_id = $1 AND project_id = $2 AND mentioned_principal_id = $3
        AND ($4::text IS NULL OR state = $4)
      ORDER BY created_at DESC, id DESC
      LIMIT 200
    `, [input.workspaceId, input.projectId, principalId, input.state ?? null]);
    return result.rows.map(mapMention);
  });
}

export async function updateMentionState(
  input: { workspaceId: string; projectId: string; mentionId: string; state: "read" | "dismissed" },
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<PageMention> {
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, principalId);
    const result = await client.query<MentionRow>(`
      UPDATE mentions
      SET state = $1, read_at = CASE WHEN $1 = 'read' THEN now() ELSE read_at END
      WHERE workspace_id = $2 AND project_id = $3 AND id = $4
        AND mentioned_principal_id = $5
      RETURNING id, page_id, comment_id, mentioned_principal_id, state, created_at, read_at
    `, [input.state, input.workspaceId, input.projectId, input.mentionId, principalId]);
    if (!result.rows[0]) throw new FoundationServiceError("NOT_FOUND", "Mention was not found.");
    return mapMention(result.rows[0]);
  });
}
