import type { Pool } from "pg";
import { postgresPool } from "@/db/postgres";
import { establishTenantContext } from "@/db/tenant";
import { newFolioId } from "@/lib/folio-ids";
import { assertIssueExists, authorizeIssueCapability } from "@/services/issue-access";
import { authorizePageCapability, assertPageExists } from "@/services/page-access";
import { FoundationServiceError } from "@/services/foundation/errors";
import {
  findIdempotentResult,
  inTransaction,
  lockIdempotencyKey,
  recordMutation,
  requestDigest,
} from "@/services/foundation/internal";
import type { MutationContext, MutationResult } from "@/services/foundation/types";

export type IssueComment = {
  id: string;
  issueId: string;
  body: Record<string, unknown>;
  plainText: string;
  revision: number;
  authorPrincipalId: string;
  authorDisplayName: string;
  createdAt: string;
  updatedAt: string;
};
export type IssueDependency = {
  id: string;
  sourceIssueId: string;
  targetIssueId: string;
  relationKind: "blocks" | "relates" | "duplicates";
  createdAt: string;
};
export type IssueLink = {
  id: string;
  issueId: string;
  linkKind: "issue" | "page" | "external";
  targetIssueId: string | null;
  targetPageId: string | null;
  externalUrl: string | null;
  label: string | null;
  createdAt: string;
};

type CommentRow = {
  id: string;
  issue_id: string;
  body: Record<string, unknown>;
  plain_text: string;
  revision: string;
  author_principal_id: string;
  author_display_name: string;
  created_at: Date;
  updated_at: Date;
};
type DependencyRow = {
  id: string;
  source_issue_id: string;
  target_issue_id: string;
  relation_kind: IssueDependency["relationKind"];
  created_at: Date;
};
type LinkRow = {
  id: string;
  issue_id: string;
  link_kind: IssueLink["linkKind"];
  target_issue_id: string | null;
  target_page_id: string | null;
  external_url: string | null;
  label: string | null;
  created_at: Date;
};

function commentDocument(value: unknown): { body: Record<string, unknown>; plainText: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Comment must be a structured document.");
  }
  const body = value as Record<string, unknown>;
  if (body.type !== "doc") throw new FoundationServiceError("VALIDATION_FAILED", "Comment requires a doc root.");
  const json = JSON.stringify(body);
  if (Buffer.byteLength(json) > 256 * 1024) throw new FoundationServiceError("VALIDATION_FAILED", "Comment is too large.");
  const text: string[] = [];
  let count = 0;
  const visit = (candidate: unknown, depth: number) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) || depth > 50 || ++count > 3000) {
      throw new FoundationServiceError("VALIDATION_FAILED", "Comment document is invalid.");
    }
    const node = candidate as Record<string, unknown>;
    if (typeof node.type !== "string") throw new FoundationServiceError("VALIDATION_FAILED", "Comment nodes require a type.");
    if (node.text !== undefined) {
      if (typeof node.text !== "string") throw new FoundationServiceError("VALIDATION_FAILED", "Comment text must be a string.");
      text.push(node.text);
    }
    if (node.content !== undefined) {
      if (!Array.isArray(node.content)) throw new FoundationServiceError("VALIDATION_FAILED", "Comment node content must be an array.");
      for (const child of node.content) visit(child, depth + 1);
    }
    if (["paragraph", "heading", "blockquote", "code_block", "list_item"].includes(String(node.type))) text.push("\n");
  };
  visit(body, 0);
  const plainText = text.join("").replace(/\n{3,}/g, "\n\n").trim();
  if (!plainText || plainText.length > 20_000) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Comment text must contain 1 to 20,000 characters.");
  }
  return { body, plainText };
}

const mapComment = (row: CommentRow): IssueComment => ({
  id: row.id,
  issueId: row.issue_id,
  body: row.body,
  plainText: row.plain_text,
  revision: Number(row.revision),
  authorPrincipalId: row.author_principal_id,
  authorDisplayName: row.author_display_name,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});
const mapDependency = (row: DependencyRow): IssueDependency => ({
  id: row.id,
  sourceIssueId: row.source_issue_id,
  targetIssueId: row.target_issue_id,
  relationKind: row.relation_kind,
  createdAt: row.created_at.toISOString(),
});
const mapLink = (row: LinkRow): IssueLink => ({
  id: row.id,
  issueId: row.issue_id,
  linkKind: row.link_kind,
  targetIssueId: row.target_issue_id,
  targetPageId: row.target_page_id,
  externalUrl: row.external_url,
  label: row.label,
  createdAt: row.created_at.toISOString(),
});

export async function listIssueComments(
  input: { workspaceId: string; projectId: string; issueId: string },
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<IssueComment[]> {
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, principalId);
    await authorizeIssueCapability(client, { ...input, principalId, capability: "issue.read" });
    const result = await client.query<CommentRow>(`
      SELECT comment.id,comment.issue_id,comment.body,comment.plain_text,comment.revision,
        comment.author_principal_id,principal.display_name author_display_name,
        comment.created_at,comment.updated_at
      FROM issue_comments comment JOIN principals principal ON principal.id=comment.author_principal_id
      WHERE comment.workspace_id=$1 AND comment.project_id=$2 AND comment.issue_id=$3
        AND comment.archived_at IS NULL
      ORDER BY comment.created_at,comment.id
    `, [input.workspaceId, input.projectId, input.issueId]);
    return result.rows.map(mapComment);
  });
}

export async function addIssueComment(
  raw: { workspaceId: string; projectId: string; issueId: string; body: unknown },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<IssueComment>> {
  const comment = commentDocument(raw.body);
  const input = { ...raw, body: comment.body, plainText: comment.plainText };
  const operation = "issue.comment.create";
  const digest = requestDigest({ ...input, bodyHash: requestDigest(input.body), body: undefined });
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<IssueComment>(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      principalId: context.actorPrincipalId,
      operation,
      key: context.idempotencyKey,
      digest,
    });
    if (replay) return replay;
    await authorizeIssueCapability(client, { ...input, principalId: context.actorPrincipalId, capability: "issue.comment" });
    const issue = await assertIssueExists(client, input.workspaceId, input.projectId, input.issueId);
    if (issue.lifecycle !== "active") throw new FoundationServiceError("CONFLICT", "Archived issues cannot receive comments.");
    const commentId = newFolioId();
    const now = new Date();
    const inserted = await client.query<CommentRow>(`
      INSERT INTO issue_comments(
        id,workspace_id,project_id,issue_id,body,plain_text,author_principal_id,created_at,updated_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)
      RETURNING id,issue_id,body,plain_text,revision,author_principal_id,
        (SELECT display_name FROM principals WHERE id=$7) author_display_name,created_at,updated_at
    `, [commentId, input.workspaceId, input.projectId, input.issueId, input.body,
      input.plainText, context.actorPrincipalId, now]);
    const data = mapComment(inserted.rows[0]!);
    return recordMutation(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      context,
      operation,
      digest,
      action: operation,
      targetType: "issue_comment",
      targetId: commentId,
      aggregateType: "issue_comment",
      aggregateRevision: 1,
      eventType: "issue_comment.created.v1",
      inputSummary: { issueId: input.issueId, bodyLength: input.plainText.length },
      resultSummary: { commentId, issueId: input.issueId },
      data,
    });
  });
}

export async function listIssueDependencies(
  input: { workspaceId: string; projectId: string; issueId: string },
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<IssueDependency[]> {
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, principalId);
    await authorizeIssueCapability(client, { ...input, principalId, capability: "issue.read" });
    const result = await client.query<DependencyRow>(`
      SELECT id,source_issue_id,target_issue_id,relation_kind,created_at
      FROM issue_dependencies
      WHERE workspace_id=$1 AND project_id=$2
        AND (source_issue_id=$3 OR target_issue_id=$3) AND archived_at IS NULL
      ORDER BY relation_kind,created_at,id
    `, [input.workspaceId, input.projectId, input.issueId]);
    return result.rows.map(mapDependency);
  });
}

export async function addIssueDependency(
  raw: {
    workspaceId: string;
    projectId: string;
    sourceIssueId: string;
    targetIssueId: string;
    relationKind: IssueDependency["relationKind"];
    expectedSourceRevision: number;
  },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<IssueDependency>> {
  if (!Number.isSafeInteger(raw.expectedSourceRevision) || raw.expectedSourceRevision < 1) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Expected source revision must be positive.");
  }
  if (raw.sourceIssueId === raw.targetIssueId) throw new FoundationServiceError("VALIDATION_FAILED", "An issue cannot depend on itself.");
  const operation = "issue.dependency.create";
  const digest = requestDigest(raw);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, raw.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<IssueDependency>(client, {
      workspaceId: raw.workspaceId,
      projectId: raw.projectId,
      principalId: context.actorPrincipalId,
      operation,
      key: context.idempotencyKey,
      digest,
    });
    if (replay) return replay;
    await authorizeIssueCapability(client, {
      workspaceId: raw.workspaceId,
      projectId: raw.projectId,
      principalId: context.actorPrincipalId,
      capability: "issue.edit",
      issueId: raw.sourceIssueId,
    });
    await authorizeIssueCapability(client, {
      workspaceId: raw.workspaceId,
      projectId: raw.projectId,
      principalId: context.actorPrincipalId,
      capability: "issue.read",
      issueId: raw.targetIssueId,
    });
    const source = await client.query<{ revision: string; lifecycle: string }>(`
      SELECT revision,lifecycle FROM issues
      WHERE workspace_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE
    `, [raw.workspaceId, raw.projectId, raw.sourceIssueId]);
    const row = source.rows[0];
    if (!row) throw new FoundationServiceError("NOT_FOUND", "Source issue was not found.");
    if (Number(row.revision) !== raw.expectedSourceRevision) {
      throw new FoundationServiceError("REVISION_CONFLICT", "Source issue changed after it was read.", {
        expectedRevision: raw.expectedSourceRevision,
        currentRevision: Number(row.revision),
      });
    }
    if (row.lifecycle !== "active") throw new FoundationServiceError("CONFLICT", "Archived issues cannot gain dependencies.");
    const target = await assertIssueExists(client, raw.workspaceId, raw.projectId, raw.targetIssueId);
    if (target.lifecycle !== "active") throw new FoundationServiceError("CONFLICT", "Dependency target must be active.");
    const dependencyId = newFolioId();
    const now = new Date();
    const inserted = await client.query<DependencyRow>(`
      INSERT INTO issue_dependencies(
        id,workspace_id,project_id,source_issue_id,target_issue_id,relation_kind,
        created_by_principal_id,created_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING id,source_issue_id,target_issue_id,relation_kind,created_at
    `, [dependencyId, raw.workspaceId, raw.projectId, raw.sourceIssueId, raw.targetIssueId,
      raw.relationKind, context.actorPrincipalId, now]);
    await client.query(`UPDATE issues SET revision=revision+1,updated_by_principal_id=$1,
      updated_at=$2 WHERE id=$3`, [context.actorPrincipalId, now, raw.sourceIssueId]);
    const data = mapDependency(inserted.rows[0]!);
    return recordMutation(client, {
      workspaceId: raw.workspaceId,
      projectId: raw.projectId,
      context,
      operation,
      digest,
      action: operation,
      targetType: "issue_dependency",
      targetId: dependencyId,
      aggregateType: "issue",
      aggregateRevision: raw.expectedSourceRevision + 1,
      eventType: "issue_dependency.created.v1",
      inputSummary: { sourceIssueId: raw.sourceIssueId, targetIssueId: raw.targetIssueId, relationKind: raw.relationKind },
      resultSummary: { dependencyId, sourceRevision: raw.expectedSourceRevision + 1 },
      data,
    });
  });
}

export async function removeIssueDependency(
  raw: {
    workspaceId: string;
    projectId: string;
    dependencyId: string;
    expectedSourceRevision: number;
  },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<IssueDependency>> {
  const operation = "issue.dependency.archive";
  const digest = requestDigest(raw);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, raw.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<IssueDependency>(client, {
      workspaceId: raw.workspaceId,
      projectId: raw.projectId,
      principalId: context.actorPrincipalId,
      operation,
      key: context.idempotencyKey,
      digest,
    });
    if (replay) return replay;
    const dependency = await client.query<DependencyRow & { archived_at: Date | null }>(`
      SELECT id,source_issue_id,target_issue_id,relation_kind,created_at,archived_at
      FROM issue_dependencies
      WHERE workspace_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE
    `, [raw.workspaceId, raw.projectId, raw.dependencyId]);
    const relation = dependency.rows[0];
    if (!relation || relation.archived_at) throw new FoundationServiceError("NOT_FOUND", "Issue dependency was not found.");
    await authorizeIssueCapability(client, {
      workspaceId: raw.workspaceId,
      projectId: raw.projectId,
      principalId: context.actorPrincipalId,
      capability: "issue.edit",
      issueId: relation.source_issue_id,
    });
    const source = await assertIssueExists(client, raw.workspaceId, raw.projectId, relation.source_issue_id);
    if (source.revision !== raw.expectedSourceRevision) {
      throw new FoundationServiceError("REVISION_CONFLICT", "Source issue changed after it was read.", {
        expectedRevision: raw.expectedSourceRevision,
        currentRevision: source.revision,
      });
    }
    const now = new Date();
    await client.query("UPDATE issue_dependencies SET archived_at=$1 WHERE id=$2", [now, raw.dependencyId]);
    await client.query(`UPDATE issues SET revision=revision+1,updated_by_principal_id=$1,
      updated_at=$2 WHERE id=$3`, [context.actorPrincipalId, now, relation.source_issue_id]);
    const data = mapDependency(relation);
    return recordMutation(client, {
      workspaceId: raw.workspaceId,
      projectId: raw.projectId,
      context,
      operation,
      digest,
      action: operation,
      targetType: "issue_dependency",
      targetId: raw.dependencyId,
      aggregateType: "issue",
      aggregateRevision: source.revision + 1,
      eventType: "issue_dependency.archived.v1",
      inputSummary: { expectedSourceRevision: raw.expectedSourceRevision },
      resultSummary: { dependencyId: raw.dependencyId, sourceIssueId: relation.source_issue_id },
      data,
    });
  });
}

export async function listIssueLinks(
  input: { workspaceId: string; projectId: string; issueId: string },
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<IssueLink[]> {
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, principalId);
    await authorizeIssueCapability(client, { ...input, principalId, capability: "issue.read" });
    const result = await client.query<LinkRow>(`
      SELECT id,issue_id,link_kind,target_issue_id,target_page_id,external_url,label,created_at
      FROM issue_links
      WHERE workspace_id=$1 AND project_id=$2 AND issue_id=$3 AND archived_at IS NULL
      ORDER BY created_at,id
    `, [input.workspaceId, input.projectId, input.issueId]);
    return result.rows.map(mapLink);
  });
}

export async function addIssueLink(
  raw: {
    workspaceId: string;
    projectId: string;
    issueId: string;
    expectedRevision: number;
    linkKind: IssueLink["linkKind"];
    targetIssueId?: string;
    targetPageId?: string;
    externalUrl?: string;
    label?: string;
  },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<IssueLink>> {
  if (!Number.isSafeInteger(raw.expectedRevision) || raw.expectedRevision < 1) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Expected revision must be positive.");
  }
  const label = raw.label?.trim() || null;
  if (label && label.length > 240) throw new FoundationServiceError("VALIDATION_FAILED", "Link label is too long.");
  let externalUrl: string | null = null;
  if (raw.linkKind === "external") {
    try {
      const url = new URL(raw.externalUrl ?? "");
      if (!["http:", "https:"].includes(url.protocol) || url.toString().length > 2048) throw new Error("invalid");
      externalUrl = url.toString();
    } catch {
      throw new FoundationServiceError("VALIDATION_FAILED", "External issue links require a valid HTTP(S) URL.");
    }
  }
  const input = {
    ...raw,
    targetIssueId: raw.linkKind === "issue" ? raw.targetIssueId : undefined,
    targetPageId: raw.linkKind === "page" ? raw.targetPageId : undefined,
    externalUrl,
    label,
  };
  if (input.linkKind === "issue" && !input.targetIssueId) throw new FoundationServiceError("VALIDATION_FAILED", "Issue link target is required.");
  if (input.linkKind === "page" && !input.targetPageId) throw new FoundationServiceError("VALIDATION_FAILED", "Page link target is required.");
  const operation = "issue.link.create";
  const digest = requestDigest(input);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<IssueLink>(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      principalId: context.actorPrincipalId,
      operation,
      key: context.idempotencyKey,
      digest,
    });
    if (replay) return replay;
    await authorizeIssueCapability(client, { ...input, principalId: context.actorPrincipalId, capability: "issue.edit" });
    const issue = await assertIssueExists(client, input.workspaceId, input.projectId, input.issueId);
    if (issue.revision !== input.expectedRevision) {
      throw new FoundationServiceError("REVISION_CONFLICT", "Issue changed after it was read.", {
        expectedRevision: input.expectedRevision,
        currentRevision: issue.revision,
      });
    }
    if (issue.lifecycle !== "active") throw new FoundationServiceError("CONFLICT", "Archived issues cannot gain links.");
    if (input.targetIssueId) {
      await authorizeIssueCapability(client, {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        principalId: context.actorPrincipalId,
        capability: "issue.read",
        issueId: input.targetIssueId,
      });
      await assertIssueExists(client, input.workspaceId, input.projectId, input.targetIssueId);
    }
    if (input.targetPageId) {
      await authorizePageCapability(client, {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        principalId: context.actorPrincipalId,
        capability: "page.read",
        pageId: input.targetPageId,
      });
      await assertPageExists(client, input.workspaceId, input.projectId, input.targetPageId);
    }
    const linkId = newFolioId();
    const now = new Date();
    const inserted = await client.query<LinkRow>(`
      INSERT INTO issue_links(
        id,workspace_id,project_id,issue_id,target_issue_id,target_page_id,external_url,
        link_kind,label,created_by_principal_id,created_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING id,issue_id,link_kind,target_issue_id,target_page_id,external_url,label,created_at
    `, [linkId, input.workspaceId, input.projectId, input.issueId, input.targetIssueId ?? null,
      input.targetPageId ?? null, input.externalUrl, input.linkKind, input.label,
      context.actorPrincipalId, now]);
    await client.query(`UPDATE issues SET revision=revision+1,updated_by_principal_id=$1,
      updated_at=$2 WHERE id=$3`, [context.actorPrincipalId, now, input.issueId]);
    const data = mapLink(inserted.rows[0]!);
    return recordMutation(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      context,
      operation,
      digest,
      action: operation,
      targetType: "issue_link",
      targetId: linkId,
      aggregateType: "issue",
      aggregateRevision: issue.revision + 1,
      eventType: "issue_link.created.v1",
      inputSummary: { issueId: input.issueId, linkKind: input.linkKind },
      resultSummary: { linkId, issueId: input.issueId, targetIssueId: input.targetIssueId, targetPageId: input.targetPageId },
      data,
    });
  });
}
