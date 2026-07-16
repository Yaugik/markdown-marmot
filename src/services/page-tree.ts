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
import { authorizePageCapability } from "@/services/page-access";

export type PageTreeNode = {
  id: string;
  workspaceId: string;
  projectId: string;
  parentNodeId: string | null;
  nodeKind: "folder" | "page" | "alias";
  pageId: string | null;
  rank: number;
  displayTitle: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

type TreeRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  parent_node_id: string | null;
  node_kind: PageTreeNode["nodeKind"];
  page_id: string | null;
  rank: string;
  display_title: string | null;
  revision: string;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
};

const treeSelect = `
  SELECT id, workspace_id, project_id, parent_node_id, node_kind, page_id,
    rank, display_title, revision, created_at, updated_at, archived_at
  FROM page_tree_nodes
`;

function mapNode(row: TreeRow): PageTreeNode {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    parentNodeId: row.parent_node_id,
    nodeKind: row.node_kind,
    pageId: row.page_id,
    rank: Number(row.rank),
    displayTitle: row.display_title,
    revision: Number(row.revision),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    archivedAt: row.archived_at?.toISOString() ?? null,
  };
}

function validateTitle(value: string, label: string): string {
  const title = value.trim();
  if (!title || title.length > 200) {
    throw new FoundationServiceError("VALIDATION_FAILED", `${label} must contain 1 to 200 characters.`);
  }
  return title;
}
function validateRank(value: number | undefined): number {
  const rank = value ?? 1000;
  if (!Number.isSafeInteger(rank) || rank < 0) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Tree rank must be a non-negative integer.");
  }
  return rank;
}
function validateExpectedRevision(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Expected revision must be a positive integer.");
  }
}

async function requireFolder(
  client: PoolClient,
  workspaceId: string,
  projectId: string,
  parentNodeId: string | null,
) {
  if (!parentNodeId) return;
  const parent = await client.query(`
    SELECT 1 FROM page_tree_nodes
    WHERE workspace_id = $1 AND project_id = $2 AND id = $3
      AND node_kind = 'folder' AND archived_at IS NULL
  `, [workspaceId, projectId, parentNodeId]);
  if (!parent.rows[0]) throw new FoundationServiceError("NOT_FOUND", "The parent folder was not found.");
}

async function authorizeNodeEdit(
  client: PoolClient,
  input: { workspaceId: string; projectId: string; principalId: string; node: Pick<TreeRow, "node_kind" | "page_id"> },
) {
  await authorizePageCapability(client, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    principalId: input.principalId,
    capability: "page.edit",
    pageId: input.node.node_kind === "folder" ? undefined : input.node.page_id ?? undefined,
  });
}

async function createNode(
  input: {
    workspaceId: string;
    projectId: string;
    parentNodeId: string | null;
    nodeKind: "folder" | "alias";
    pageId: string | null;
    displayTitle: string;
    rank: number;
  },
  context: MutationContext,
  pool: Pool,
): Promise<MutationResult<PageTreeNode>> {
  const operation = input.nodeKind === "folder" ? "page_tree.folder.create" : "page_tree.alias.create";
  const digest = requestDigest(input);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<PageTreeNode>(client, {
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
      pageId: input.pageId ?? undefined,
    });
    await requireFolder(client, input.workspaceId, input.projectId, input.parentNodeId);
    if (input.pageId) {
      const page = await client.query(`
        SELECT 1 FROM pages
        WHERE workspace_id = $1 AND project_id = $2 AND id = $3 AND status = 'active'
      `, [input.workspaceId, input.projectId, input.pageId]);
      if (!page.rows[0]) throw new FoundationServiceError("NOT_FOUND", "The alias target page was not found.");
    }
    const nodeId = newFolioId();
    const now = new Date();
    const result = await client.query<TreeRow>(`
      INSERT INTO page_tree_nodes (
        id, workspace_id, project_id, parent_node_id, node_kind, page_id,
        rank, display_title, created_by_principal_id, updated_by_principal_id,
        created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$10)
      RETURNING id, workspace_id, project_id, parent_node_id, node_kind, page_id,
        rank, display_title, revision, created_at, updated_at, archived_at
    `, [nodeId, input.workspaceId, input.projectId, input.parentNodeId, input.nodeKind,
      input.pageId, input.rank, input.displayTitle, context.actorPrincipalId, now]);
    const data = mapNode(result.rows[0]!);
    return recordMutation(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      context,
      operation,
      digest,
      action: operation,
      targetType: "page_tree_node",
      targetId: nodeId,
      aggregateType: "page_tree_node",
      aggregateRevision: 1,
      eventType: input.nodeKind === "folder" ? "page_tree.folder_created.v1" : "page_tree.alias_created.v1",
      inputSummary: { parentNodeId: input.parentNodeId, rank: input.rank },
      resultSummary: { nodeId, nodeKind: input.nodeKind, pageId: input.pageId },
      data,
    });
  });
}

export function createPageTreeFolder(
  raw: { workspaceId: string; projectId: string; parentNodeId?: string | null; title: string; rank?: number },
  context: MutationContext,
  pool: Pool = postgresPool(),
) {
  return createNode({
    workspaceId: raw.workspaceId,
    projectId: raw.projectId,
    parentNodeId: raw.parentNodeId ?? null,
    nodeKind: "folder",
    pageId: null,
    displayTitle: validateTitle(raw.title, "Folder title"),
    rank: validateRank(raw.rank),
  }, context, pool);
}

export function createPageTreeAlias(
  raw: {
    workspaceId: string;
    projectId: string;
    parentNodeId?: string | null;
    pageId: string;
    displayTitle?: string;
    rank?: number;
  },
  context: MutationContext,
  pool: Pool = postgresPool(),
) {
  return createNode({
    workspaceId: raw.workspaceId,
    projectId: raw.projectId,
    parentNodeId: raw.parentNodeId ?? null,
    nodeKind: "alias",
    pageId: raw.pageId,
    displayTitle: validateTitle(raw.displayTitle ?? "Alias", "Alias title"),
    rank: validateRank(raw.rank),
  }, context, pool);
}

export async function movePageTreeNode(
  raw: {
    workspaceId: string;
    projectId: string;
    nodeId: string;
    expectedRevision: number;
    parentNodeId?: string | null;
    rank?: number;
    displayTitle?: string | null;
  },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<PageTreeNode>> {
  validateExpectedRevision(raw.expectedRevision);
  const input = {
    ...raw,
    parentNodeId: raw.parentNodeId ?? null,
    rank: validateRank(raw.rank),
    displayTitle: raw.displayTitle === undefined
      ? undefined
      : raw.displayTitle === null ? null : validateTitle(raw.displayTitle, "Display title"),
  };
  const operation = "page_tree.node.move";
  const digest = requestDigest(input);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<PageTreeNode>(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      principalId: context.actorPrincipalId,
      operation,
      key: context.idempotencyKey,
      digest,
    });
    if (replay) return replay;
    const current = await client.query<TreeRow>(`${treeSelect}
      WHERE workspace_id = $1 AND project_id = $2 AND id = $3 AND archived_at IS NULL
      FOR UPDATE
    `, [input.workspaceId, input.projectId, input.nodeId]);
    const row = current.rows[0];
    if (!row) throw new FoundationServiceError("NOT_FOUND", "The page-tree node was not found.");
    await authorizeNodeEdit(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      principalId: context.actorPrincipalId,
      node: row,
    });
    const revision = Number(row.revision);
    if (revision !== input.expectedRevision) {
      throw new FoundationServiceError("REVISION_CONFLICT", "The page-tree node changed after it was read.", {
        expectedRevision: input.expectedRevision,
        currentRevision: revision,
      });
    }
    await requireFolder(client, input.workspaceId, input.projectId, input.parentNodeId);
    if (row.node_kind === "folder" && input.parentNodeId) {
      const cycle = await client.query(`
        WITH RECURSIVE descendants AS (
          SELECT id FROM page_tree_nodes
          WHERE workspace_id = $1 AND project_id = $2 AND parent_node_id = $3 AND archived_at IS NULL
          UNION ALL
          SELECT child.id FROM page_tree_nodes child
          JOIN descendants parent ON child.parent_node_id = parent.id
          WHERE child.workspace_id = $1 AND child.project_id = $2 AND child.archived_at IS NULL
        ) SELECT 1 FROM descendants WHERE id = $4
      `, [input.workspaceId, input.projectId, input.nodeId, input.parentNodeId]);
      if (input.parentNodeId === input.nodeId || cycle.rows[0]) {
        throw new FoundationServiceError("CONFLICT", "A folder cannot be moved into itself or one of its descendants.");
      }
    }
    const displayTitle = input.displayTitle === undefined ? row.display_title : input.displayTitle;
    if (row.node_kind === "folder" && displayTitle === null) {
      throw new FoundationServiceError("VALIDATION_FAILED", "Folders require a display title.");
    }
    if (row.parent_node_id === input.parentNodeId && Number(row.rank) === input.rank && row.display_title === displayTitle) {
      throw new FoundationServiceError("CONFLICT", "The tree move does not contain changes.");
    }
    const now = new Date();
    const updated = await client.query<TreeRow>(`
      UPDATE page_tree_nodes
      SET parent_node_id = $1, rank = $2, display_title = $3,
        revision = revision + 1, updated_by_principal_id = $4, updated_at = $5
      WHERE workspace_id = $6 AND project_id = $7 AND id = $8
      RETURNING id, workspace_id, project_id, parent_node_id, node_kind, page_id,
        rank, display_title, revision, created_at, updated_at, archived_at
    `, [input.parentNodeId, input.rank, displayTitle, context.actorPrincipalId, now,
      input.workspaceId, input.projectId, input.nodeId]);
    const data = mapNode(updated.rows[0]!);
    return recordMutation(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      context,
      operation,
      digest,
      action: operation,
      targetType: "page_tree_node",
      targetId: input.nodeId,
      aggregateType: "page_tree_node",
      aggregateRevision: revision + 1,
      eventType: "page_tree.node_moved.v1",
      inputSummary: { expectedRevision: input.expectedRevision },
      resultSummary: { nodeId: input.nodeId, parentNodeId: input.parentNodeId, rank: input.rank },
      data,
    });
  });
}

export async function setPageTreeNodeArchived(
  input: {
    workspaceId: string;
    projectId: string;
    nodeId: string;
    expectedRevision: number;
    archived: boolean;
    recursive?: boolean;
  },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<PageTreeNode>> {
  validateExpectedRevision(input.expectedRevision);
  const operation = input.archived ? "page_tree.node.archive" : "page_tree.node.restore";
  const digest = requestDigest(input);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<PageTreeNode>(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      principalId: context.actorPrincipalId,
      operation,
      key: context.idempotencyKey,
      digest,
    });
    if (replay) return replay;
    const current = await client.query<TreeRow>(`${treeSelect}
      WHERE workspace_id = $1 AND project_id = $2 AND id = $3
      FOR UPDATE
    `, [input.workspaceId, input.projectId, input.nodeId]);
    const row = current.rows[0];
    if (!row) throw new FoundationServiceError("NOT_FOUND", "The page-tree node was not found.");
    await authorizeNodeEdit(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      principalId: context.actorPrincipalId,
      node: row,
    });
    const revision = Number(row.revision);
    if (revision !== input.expectedRevision) {
      throw new FoundationServiceError("REVISION_CONFLICT", "The page-tree node changed after it was read.", {
        expectedRevision: input.expectedRevision,
        currentRevision: revision,
      });
    }
    if ((row.archived_at !== null) === input.archived) {
      throw new FoundationServiceError("CONFLICT", input.archived ? "Tree node is already archived." : "Tree node is already active.");
    }
    if (!input.archived) await requireFolder(client, input.workspaceId, input.projectId, row.parent_node_id);
    const now = new Date();
    if (input.archived && row.node_kind === "folder") {
      const descendants = await client.query<{ id: string }>(`
        WITH RECURSIVE descendants AS (
          SELECT id FROM page_tree_nodes
          WHERE workspace_id = $1 AND project_id = $2 AND parent_node_id = $3 AND archived_at IS NULL
          UNION ALL
          SELECT child.id FROM page_tree_nodes child
          JOIN descendants parent ON child.parent_node_id = parent.id
          WHERE child.workspace_id = $1 AND child.project_id = $2 AND child.archived_at IS NULL
        ) SELECT id FROM descendants
      `, [input.workspaceId, input.projectId, input.nodeId]);
      if (descendants.rows.length && !input.recursive) {
        throw new FoundationServiceError("CONFLICT", "Folder contains active descendants; recursive archive is required.", {
          descendantCount: descendants.rows.length,
        });
      }
      if (input.recursive && descendants.rows.length) {
        await client.query(`
          UPDATE page_tree_nodes
          SET archived_at = $1, revision = revision + 1,
            updated_by_principal_id = $2, updated_at = $1
          WHERE workspace_id = $3 AND project_id = $4 AND id = ANY($5::uuid[])
        `, [now, context.actorPrincipalId, input.workspaceId, input.projectId,
          descendants.rows.map((item) => item.id)]);
      }
    }
    const updated = await client.query<TreeRow>(`
      UPDATE page_tree_nodes
      SET archived_at = $1, revision = revision + 1,
        updated_by_principal_id = $2, updated_at = $3
      WHERE workspace_id = $4 AND project_id = $5 AND id = $6
      RETURNING id, workspace_id, project_id, parent_node_id, node_kind, page_id,
        rank, display_title, revision, created_at, updated_at, archived_at
    `, [input.archived ? now : null, context.actorPrincipalId, now,
      input.workspaceId, input.projectId, input.nodeId]);
    const data = mapNode(updated.rows[0]!);
    return recordMutation(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      context,
      operation,
      digest,
      action: operation,
      targetType: "page_tree_node",
      targetId: input.nodeId,
      aggregateType: "page_tree_node",
      aggregateRevision: revision + 1,
      eventType: input.archived ? "page_tree.node_archived.v1" : "page_tree.node_restored.v1",
      inputSummary: { expectedRevision: input.expectedRevision, recursive: input.recursive ?? false },
      resultSummary: { nodeId: input.nodeId, archived: input.archived },
      data,
    });
  });
}

export async function reorderPageTreeSiblings(
  input: {
    workspaceId: string;
    projectId: string;
    parentNodeId?: string | null;
    nodes: Array<{ nodeId: string; expectedRevision: number }>;
  },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<PageTreeNode[]>> {
  const parentNodeId = input.parentNodeId ?? null;
  if (!input.nodes.length || input.nodes.length > 500) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Reorder requires 1 to 500 sibling nodes.");
  }
  const ids = input.nodes.map((node) => node.nodeId);
  if (new Set(ids).size !== ids.length) throw new FoundationServiceError("VALIDATION_FAILED", "Reorder node IDs must be unique.");
  input.nodes.forEach((node) => validateExpectedRevision(node.expectedRevision));
  const normalized = { ...input, parentNodeId };
  const operation = "page_tree.siblings.reorder";
  const digest = requestDigest(normalized);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<PageTreeNode[]>(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      principalId: context.actorPrincipalId,
      operation,
      key: context.idempotencyKey,
      digest,
    });
    if (replay) return replay;
    await requireFolder(client, input.workspaceId, input.projectId, parentNodeId);
    const rows = await client.query<TreeRow>(`${treeSelect}
      WHERE workspace_id = $1 AND project_id = $2
        AND parent_node_id IS NOT DISTINCT FROM $3
        AND id = ANY($4::uuid[]) AND archived_at IS NULL
      FOR UPDATE
    `, [input.workspaceId, input.projectId, parentNodeId, ids]);
    if (rows.rows.length !== ids.length) throw new FoundationServiceError("NOT_FOUND", "One or more reorder nodes were not active siblings.");
    const byId = new Map(rows.rows.map((row) => [row.id, row]));
    for (const requested of input.nodes) {
      const row = byId.get(requested.nodeId)!;
      await authorizeNodeEdit(client, {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        principalId: context.actorPrincipalId,
        node: row,
      });
      if (Number(row.revision) !== requested.expectedRevision) {
        throw new FoundationServiceError("REVISION_CONFLICT", "A page-tree sibling changed after it was read.", {
          nodeId: requested.nodeId,
          expectedRevision: requested.expectedRevision,
          currentRevision: Number(row.revision),
        });
      }
    }
    const now = new Date();
    const updatedNodes: PageTreeNode[] = [];
    for (const [index, requested] of input.nodes.entries()) {
      const rank = (index + 1) * 1000;
      const updated = await client.query<TreeRow>(`
        UPDATE page_tree_nodes
        SET rank = $1, revision = revision + 1,
          updated_by_principal_id = $2, updated_at = $3
        WHERE workspace_id = $4 AND project_id = $5 AND id = $6
        RETURNING id, workspace_id, project_id, parent_node_id, node_kind, page_id,
          rank, display_title, revision, created_at, updated_at, archived_at
      `, [rank, context.actorPrincipalId, now, input.workspaceId, input.projectId, requested.nodeId]);
      updatedNodes.push(mapNode(updated.rows[0]!));
    }
    return recordMutation(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      context,
      operation,
      digest,
      action: operation,
      targetType: "project",
      targetId: input.projectId,
      aggregateType: "page_tree",
      aggregateRevision: Math.max(...updatedNodes.map((node) => node.revision)),
      eventType: "page_tree.siblings_reordered.v1",
      inputSummary: { parentNodeId, nodeCount: input.nodes.length },
      resultSummary: { parentNodeId, orderedNodeIds: ids },
      data: updatedNodes,
    });
  });
}

export async function listPageTree(
  input: { workspaceId: string; projectId: string; includeArchived?: boolean },
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<PageTreeNode[]> {
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, principalId);
    const result = await client.query<TreeRow>(`${treeSelect}
      WHERE workspace_id = $1 AND project_id = $2
        AND ($3::boolean OR archived_at IS NULL)
      ORDER BY parent_node_id NULLS FIRST, rank, id
    `, [input.workspaceId, input.projectId, input.includeArchived ?? false]);
    const visibleIds = new Set<string>();
    for (const row of result.rows) {
      if (!row.page_id) continue;
      try {
        await authorizePageCapability(client, {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          principalId,
          capability: "page.read",
          pageId: row.page_id,
        });
        visibleIds.add(row.id);
      } catch (error) {
        if (!(error instanceof FoundationServiceError) || error.code !== "CAPABILITY_DENIED") throw error;
      }
    }
    const byId = new Map(result.rows.map((row) => [row.id, row]));
    for (const id of [...visibleIds]) {
      let parentId = byId.get(id)?.parent_node_id ?? null;
      while (parentId) {
        visibleIds.add(parentId);
        parentId = byId.get(parentId)?.parent_node_id ?? null;
      }
    }
    const hasGlobalRead = await (async () => {
      try {
        await authorizePageCapability(client, {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          principalId,
          capability: "page.read",
        });
        return true;
      } catch (error) {
        if (error instanceof FoundationServiceError && error.code === "CAPABILITY_DENIED") return false;
        throw error;
      }
    })();
    if (hasGlobalRead) result.rows.filter((row) => row.node_kind === "folder").forEach((row) => visibleIds.add(row.id));
    return result.rows.filter((row) => visibleIds.has(row.id)).map(mapNode);
  });
}
