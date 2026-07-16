import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { newFolioId } from "@/lib/folio-ids";
import { createProject, createWorkspace, provisionAuthenticatedHuman } from "@/services/foundation";
import { createNativePage } from "./pages";
import { createPageTreeAlias, createPageTreeFolder, listPageTree, movePageTreeNode } from "./page-tree";

const databaseUrl = process.env.DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

describeWithPostgres("page tree services", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  afterAll(async () => pool.end());

  it("creates folders and aliases, orders siblings, moves nodes, and rejects cycles", async () => {
    const suffix = newFolioId();
    const owner = await provisionAuthenticatedHuman({ issuer: "https://identity.example.test", subject: `tree-${suffix}`, email: `tree-${suffix}@example.test`, displayName: "Tree Owner" }, pool);
    const context = { actorPrincipalId: owner.principalId, requestId: newFolioId(), traceId: `tree-${suffix}`, idempotencyKey: `workspace-${suffix}`, source: "api" as const };
    const workspace = await createWorkspace({ name: "Tree Workspace", slug: `tree-${suffix}` }, context, pool);
    const project = await createProject({ workspaceId: workspace.data.id, projectKey: "TREE", name: "Tree" }, { ...context, requestId: newFolioId(), idempotencyKey: `project-${suffix}` }, pool);
    const page = await createNativePage({ workspaceId: workspace.data.id, projectId: project.data.id, title: "Page", content: doc("Page") }, { ...context, requestId: newFolioId(), idempotencyKey: `page-${suffix}` }, pool);

    const root = await createPageTreeFolder({ workspaceId: workspace.data.id, projectId: project.data.id, title: "Root", rank: 20 }, { ...context, requestId: newFolioId(), idempotencyKey: `root-${suffix}` }, pool);
    const child = await createPageTreeFolder({ workspaceId: workspace.data.id, projectId: project.data.id, parentNodeId: root.data.id, title: "Child", rank: 10 }, { ...context, requestId: newFolioId(), idempotencyKey: `child-${suffix}` }, pool);
    const alias = await createPageTreeAlias({ workspaceId: workspace.data.id, projectId: project.data.id, parentNodeId: root.data.id, pageId: page.data.id, displayTitle: "Shortcut", rank: 5 }, { ...context, requestId: newFolioId(), idempotencyKey: `alias-${suffix}` }, pool);

    const tree = await listPageTree({ workspaceId: workspace.data.id, projectId: project.data.id }, owner.principalId, pool);
    expect(tree.filter((node) => node.parentNodeId === root.data.id).map((node) => node.id)).toEqual([alias.data.id, child.data.id]);

    const moved = await movePageTreeNode({ workspaceId: workspace.data.id, projectId: project.data.id, nodeId: alias.data.id, expectedRevision: 1, parentNodeId: child.data.id, rank: 1, displayTitle: "Moved shortcut" }, { ...context, requestId: newFolioId(), idempotencyKey: `move-${suffix}` }, pool);
    expect(moved.data).toMatchObject({ parentNodeId: child.data.id, rank: 1, displayTitle: "Moved shortcut", revision: 2 });

    await expect(movePageTreeNode({ workspaceId: workspace.data.id, projectId: project.data.id, nodeId: alias.data.id, expectedRevision: 1, parentNodeId: root.data.id, rank: 1 }, { ...context, requestId: newFolioId(), idempotencyKey: `stale-${suffix}` }, pool)).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await expect(movePageTreeNode({ workspaceId: workspace.data.id, projectId: project.data.id, nodeId: root.data.id, expectedRevision: 1, parentNodeId: child.data.id, rank: 1 }, { ...context, requestId: newFolioId(), idempotencyKey: `cycle-${suffix}` }, pool)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(pool.query("UPDATE page_tree_nodes SET parent_node_id=$1 WHERE id=$2", [child.data.id, root.data.id])).rejects.toThrow(/cycle/);
  });
});
