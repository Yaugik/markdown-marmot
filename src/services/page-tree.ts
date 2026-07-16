import type { Pool, PoolClient } from "pg";
import { evaluateProjectCapability, type ProjectCapability } from "@/auth/capabilities";
import { postgresPool } from "@/db/postgres";
import { establishTenantContext } from "@/db/tenant";
import { newFolioId } from "@/lib/folio-ids";
import { FoundationServiceError } from "@/services/foundation/errors";
import { findIdempotentResult, inTransaction, lockIdempotencyKey, recordMutation, requestDigest } from "@/services/foundation/internal";
import type { MutationContext, MutationResult } from "@/services/foundation/types";

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
};

type AccessRow = {
  workspace_status: string;
  project_status: string;
  membership_status: string;
  capabilities: string[];
};

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
    throw new FoundationServiceError("CAPABILITY_DENIED", "The page-tree capability is not permitted.", {
      reason: decision.reason,
    });
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

    await authorize(client, input.workspaceId, input.projectId, context.actorPrincipalId, "page.edit");
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
      RETURNING id,workspace_id,project_id,parent_node_id,node_kind,page_id,
        rank,display_title,revision,created_at,updated_at
    `, [nodeId, input.workspaceId, input.projectId, input.parentNodeId, input.nodeKind,
      input.pageId, input.rank, input.displayTitle, context.actorPrincipalId, now]);
    const data = mapNode(result.rows[0]);
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
  raw: { workspaceId: string; projectId: string; parentNodeId?: string | null; pageId: string; displayTitle?: string; rank?: number },
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
    displayTitle: raw.displayTitle === undefined ? undefined
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

    await authorize(client, input.workspaceId, input.projectId, context.actorPrincipalId, "page.edit");
    const current = await client.query<TreeRow>(`
      SELECT id,workspace_id,project_id,parent_node_id,node_kind,page_id,
        rank,display_title,revision,created_at,updated_at
      FROM page_tree_nodes
      WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND archived_at IS NULL
      FOR UPDATE
    `, [input.workspaceId, input.projectId, input.nodeId]);
    const row = current.rows[0];
    if (!row) throw new FoundationServiceError("NOT_FOUND", "The page-tree node was not found.");
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
          WHERE workspace_id=$1 AND project_id=$2 AND parent_node_id=$3 AND archived_at IS NULL
          UNION ALL
          SELECT child.id FROM page_tree_nodes child
          JOIN descendants parent ON child.parent_node_id=parent.id
          WHERE child.workspace_id=$1 AND child.project_id=$2 AND child.archived_at IS NULL
        ) SELECT 1 FROM descendants WHERE id=$4
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
      SET parent_node_id=$1, rank=$2, display_title=$3, revision=revision+1,
        updated_by_principal_id=$4, updated_at=$5
      WHERE workspace_id=$6 AND project_id=$7 AND id=$8
      RETURNING id,workspace_id,project_id,parent_node_id,node_kind,page_id,
        rank,display_title,revision,created_at,updated_at
    `, [input.parentNodeId, input.rank, displayTitle, context.actorPrincipalId, now,
      input.workspaceId, input.projectId, input.nodeId]);
    const data = mapNode(updated.rows[0]);
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

export async function listPageTree(
  input: { workspaceId: string; projectId: string },
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<PageTreeNode[]> {
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, principalId);
    await authorize(client, input.workspaceId, input.projectId, principalId, "page.read");
    const result = await client.query<TreeRow>(`
      SELECT id,workspace_id,project_id,parent_node_id,node_kind,page_id,
        rank,display_title,revision,created_at,updated_at
      FROM page_tree_nodes
      WHERE workspace_id=$1 AND project_id=$2 AND archived_at IS NULL
      ORDER BY parent_node_id NULLS FIRST, rank, id
    `, [input.workspaceId, input.projectId]);
    return result.rows.map(mapNode);
  });
}
