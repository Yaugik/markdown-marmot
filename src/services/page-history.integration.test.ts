import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { newFolioId } from "@/lib/folio-ids";
import { createProject, createWorkspace, provisionAuthenticatedHuman } from "@/services/foundation";
import { archiveNativePage, listNativePageRevisions, readNativePageRevision, restoreNativePage } from "./page-history";
import { createNativePage, editNativePage } from "./pages";

const databaseUrl = process.env.DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const doc = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

describeWithPostgres("native page history and lifecycle", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  afterAll(async () => pool.end());

  it("reads immutable history and archives and restores with revision checks", async () => {
    const suffix = newFolioId();
    const owner = await provisionAuthenticatedHuman({
      issuer: "https://identity.example.test",
      subject: `history-${suffix}`,
      email: `history-${suffix}@example.test`,
      displayName: "Page History Owner",
    }, pool);
    const context = {
      actorPrincipalId: owner.principalId,
      requestId: newFolioId(),
      traceId: `history-${suffix}`,
      idempotencyKey: `workspace-${suffix}`,
      source: "api" as const,
    };
    const workspace = await createWorkspace({
      name: "History Workspace",
      slug: `history-${suffix}`,
    }, context, pool);
    const project = await createProject({
      workspaceId: workspace.data.id,
      projectKey: "HISTORY",
      name: "Page History",
    }, {
      ...context,
      requestId: newFolioId(),
      idempotencyKey: `project-${suffix}`,
    }, pool);
    const created = await createNativePage({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      title: "Decision record",
      content: doc("First"),
    }, {
      ...context,
      requestId: newFolioId(),
      idempotencyKey: `page-${suffix}`,
    }, pool);
    const edited = await editNativePage({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      pageId: created.data.id,
      expectedRevision: 1,
      content: doc("Second"),
    }, {
      ...context,
      requestId: newFolioId(),
      idempotencyKey: `edit-${suffix}`,
    }, pool);

    const history = await listNativePageRevisions({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      pageId: created.data.id,
    }, owner.principalId, pool);
    expect(history.map((revision) => revision.sequence)).toEqual([2, 1]);
    expect(history[0]).not.toHaveProperty("content");
    const firstRevision = await readNativePageRevision({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      pageId: created.data.id,
      revisionId: created.data.currentRevision.id,
    }, owner.principalId, pool);
    expect(firstRevision.plainText).toBe("First");

    const archived = await archiveNativePage({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      pageId: created.data.id,
      expectedRevision: edited.data.revision,
    }, {
      ...context,
      requestId: newFolioId(),
      idempotencyKey: `archive-${suffix}`,
    }, pool);
    expect(archived.data).toMatchObject({ status: "archived", revision: 3 });

    await expect(editNativePage({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      pageId: created.data.id,
      expectedRevision: 3,
      content: doc("Blocked"),
    }, {
      ...context,
      requestId: newFolioId(),
      idempotencyKey: `blocked-${suffix}`,
    }, pool)).rejects.toThrow(/active before creating a revision/);

    await expect(restoreNativePage({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      pageId: created.data.id,
      expectedRevision: 2,
    }, {
      ...context,
      requestId: newFolioId(),
      idempotencyKey: `stale-restore-${suffix}`,
    }, pool)).rejects.toMatchObject({ code: "REVISION_CONFLICT" });

    const restored = await restoreNativePage({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      pageId: created.data.id,
      expectedRevision: 3,
    }, {
      ...context,
      requestId: newFolioId(),
      idempotencyKey: `restore-${suffix}`,
    }, pool);
    expect(restored.data).toMatchObject({ status: "active", revision: 4, archivedAt: null });
  });
});
