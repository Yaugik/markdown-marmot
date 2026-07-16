import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { newFolioId } from "@/lib/folio-ids";
import { createProject, createWorkspace, provisionAuthenticatedHuman } from "@/services/foundation";
import { createNativePage, editNativePage, readNativePage } from "./pages";

const databaseUrl = process.env.DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

describeWithPostgres("native page services", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  afterAll(async () => pool.end());

  it("creates immutable revisions and rejects stale writers", async () => {
    const suffix = newFolioId();
    const owner = await provisionAuthenticatedHuman({ issuer: "https://identity.example.test", subject: `native-${suffix}`, email: `native-${suffix}@example.test`, displayName: "Native Page Owner" }, pool);
    const context = { actorPrincipalId: owner.principalId, requestId: newFolioId(), traceId: `native-${suffix}`, idempotencyKey: `workspace-${suffix}`, source: "api" as const };
    const workspace = await createWorkspace({ name: "Native Workspace", slug: `native-${suffix}` }, context, pool);
    const project = await createProject({ workspaceId: workspace.data.id, projectKey: "NATIVE", name: "Native Pages" }, { ...context, requestId: newFolioId(), idempotencyKey: `project-${suffix}` }, pool);
    const created = await createNativePage({ workspaceId: workspace.data.id, projectId: project.data.id, title: "Product brief", content: doc("First revision") }, { ...context, requestId: newFolioId(), idempotencyKey: `page-${suffix}` }, pool);
    expect(created.data).toMatchObject({ revision: 1, currentRevision: { sequence: 1, plainText: "First revision" }, treePlacements: [{ nodeKind: "page" }] });

    const edited = await editNativePage({ workspaceId: workspace.data.id, projectId: project.data.id, pageId: created.data.id, expectedRevision: 1, title: "Updated brief", content: doc("Second revision") }, { ...context, requestId: newFolioId(), idempotencyKey: `edit-${suffix}` }, pool);
    expect(edited.data).toMatchObject({ title: "Updated brief", revision: 2, currentRevision: { sequence: 2, parentRevisionId: created.data.currentRevision.id, plainText: "Second revision" } });
    await expect(editNativePage({ workspaceId: workspace.data.id, projectId: project.data.id, pageId: created.data.id, expectedRevision: 1, content: doc("Stale") }, { ...context, requestId: newFolioId(), idempotencyKey: `stale-${suffix}` }, pool)).rejects.toMatchObject({ code: "REVISION_CONFLICT", details: { expectedRevision: 1, currentRevision: 2 } });
    expect((await readNativePage({ workspaceId: workspace.data.id, projectId: project.data.id, pageId: created.data.id }, owner.principalId, pool)).currentRevision.plainText).toBe("Second revision");

    const revisions = await pool.query<{ sequence: string }>("SELECT sequence FROM native_page_revisions WHERE page_id=$1 ORDER BY sequence", [created.data.id]);
    expect(revisions.rows).toEqual([{ sequence: "1" }, { sequence: "2" }]);
    await expect(pool.query("UPDATE native_page_revisions SET plain_text='changed' WHERE id=$1", [created.data.currentRevision.id])).rejects.toThrow(/immutable/);
  });
});
