import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { newFolioId } from "@/lib/folio-ids";
import { createProject, createWorkspace, provisionAuthenticatedHuman } from "@/services/foundation";
import { readNativePage, createNativePage, editNativePage } from "@/services/pages";
import {
  createPageCommentThread,
  listPageCommentThreads,
  listPrincipalMentions,
  updatePageCommentThread,
} from "./page-collaboration";
import {
  listPageBacklinks,
  searchPages,
  setPageGrant,
} from "./page-knowledge";
import {
  preparePageAttachment,
  readAttachmentContent,
  storeAttachmentContent,
} from "./page-attachments";
import {
  executePageConversion,
  preparePageConversion,
} from "./page-conversion";
import { listPageTree } from "./page-tree";

const databaseUrl = process.env.DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const paragraph = (text: string, targetPageId?: string) => ({
  type: "doc",
  content: [{
    type: "paragraph",
    content: [{
      type: "text",
      text,
      ...(targetPageId ? { marks: [{ type: "link", attrs: { page_id: targetPageId } }] } : {}),
    }],
  }],
});

describeWithPostgres("Phase 2 page workspace", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  afterAll(async () => {
    await pool.end();
  });

  it("supports grants, collaboration, knowledge, attachments, and conversions", async () => {
    const suffix = newFolioId();
    const owner = await provisionAuthenticatedHuman({
      issuer: "https://identity.example.test",
      subject: `phase2-owner-${suffix}`,
      email: `phase2-owner-${suffix}@example.test`,
      displayName: "Phase 2 Owner",
    }, pool);
    const guest = await provisionAuthenticatedHuman({
      issuer: "https://identity.example.test",
      subject: `phase2-guest-${suffix}`,
      email: `phase2-guest-${suffix}@example.test`,
      displayName: "Phase 2 Guest",
    }, pool);
    const baseContext = {
      actorPrincipalId: owner.principalId,
      requestId: newFolioId(),
      traceId: `phase2-${suffix}`,
      idempotencyKey: `workspace-${suffix}`,
      source: "api" as const,
    };
    const workspace = await createWorkspace({
      name: "Phase 2 Workspace",
      slug: `phase2-${suffix}`,
    }, baseContext, pool);
    const project = await createProject({
      workspaceId: workspace.data.id,
      projectKey: "PAGES",
      name: "Page Workspace",
    }, {
      ...baseContext,
      requestId: newFolioId(),
      idempotencyKey: `project-${suffix}`,
    }, pool);
    const guestRole = await pool.query<{ id: string }>(`
      SELECT id FROM role_templates
      WHERE workspace_id = $1 AND template_key = 'guest'
    `, [workspace.data.id]);
    await pool.query(`
      INSERT INTO workspace_memberships (
        id, workspace_id, principal_id, role, status, invited_by_principal_id
      ) VALUES ($1, $2, $3, 'member', 'active', $4)
    `, [newFolioId(), workspace.data.id, guest.principalId, owner.principalId]);
    await pool.query(`
      INSERT INTO project_memberships (
        id, workspace_id, project_id, principal_id, role_template_id,
        status, invited_by_principal_id
      ) VALUES ($1, $2, $3, $4, $5, 'active', $6)
    `, [newFolioId(), workspace.data.id, project.data.id, guest.principalId,
      guestRole.rows[0]!.id, owner.principalId]);

    const target = await createNativePage({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      title: "Target page",
      content: paragraph("Target knowledge"),
    }, {
      ...baseContext,
      requestId: newFolioId(),
      idempotencyKey: `target-${suffix}`,
    }, pool);
    const source = await createNativePage({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      title: "Source page",
      content: paragraph("Alpha knowledge links to target", target.data.id),
    }, {
      ...baseContext,
      requestId: newFolioId(),
      idempotencyKey: `source-${suffix}`,
    }, pool);

    await setPageGrant({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      pageId: source.data.id,
      principalId: guest.principalId,
      capabilities: ["page.read", "page.comment"],
    }, {
      ...baseContext,
      requestId: newFolioId(),
      idempotencyKey: `grant-${suffix}`,
    }, pool);
    expect((await readNativePage({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      pageId: source.data.id,
    }, guest.principalId, pool)).title).toBe("Source page");
    await expect(readNativePage({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      pageId: target.data.id,
    }, guest.principalId, pool)).rejects.toMatchObject({ code: "CAPABILITY_DENIED" });
    const guestTree = await listPageTree({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
    }, guest.principalId, pool);
    expect(guestTree.some((node) => node.pageId === source.data.id)).toBe(true);
    expect(guestTree.some((node) => node.pageId === target.data.id)).toBe(false);

    const backlinks = await listPageBacklinks({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      pageId: target.data.id,
    }, owner.principalId, pool);
    expect(backlinks).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourcePageId: source.data.id, targetPageId: target.data.id }),
    ]));
    const guestSearch = await searchPages({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      query: "Alpha",
    }, guest.principalId, pool);
    expect(guestSearch.map((result) => result.pageId)).toEqual([source.data.id]);

    const thread = await createPageCommentThread({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      pageId: source.data.id,
      pageRevisionId: source.data.currentRevision.id,
      anchor: { from: 0, to: 5, quote: "Alpha" },
      body: { text: "Please review this section" },
      mentionedPrincipalIds: [guest.principalId],
    }, {
      ...baseContext,
      requestId: newFolioId(),
      idempotencyKey: `thread-${suffix}`,
    }, pool);
    expect((await listPrincipalMentions({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      state: "unread",
    }, guest.principalId, pool))).toEqual([
      expect.objectContaining({ pageId: source.data.id, mentionedPrincipalId: guest.principalId }),
    ]);

    const edited = await editNativePage({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      pageId: source.data.id,
      expectedRevision: 1,
      content: paragraph("Alpha knowledge updated", target.data.id),
    }, {
      ...baseContext,
      requestId: newFolioId(),
      idempotencyKey: `edit-${suffix}`,
    }, pool);
    let threads = await listPageCommentThreads({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      pageId: source.data.id,
    }, owner.principalId, pool);
    expect(threads[0]).toMatchObject({ id: thread.data.id, anchorState: "stale", revision: 2 });
    const reanchored = await updatePageCommentThread({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      threadId: thread.data.id,
      expectedRevision: 2,
      action: "reanchor",
      pageRevisionId: edited.data.currentRevision.id,
      anchor: { from: 0, to: 5, quote: "Alpha" },
    }, {
      ...baseContext,
      requestId: newFolioId(),
      idempotencyKey: `reanchor-${suffix}`,
    }, pool);
    expect(reanchored.data.anchorState).toBe("moved");
    await updatePageCommentThread({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      threadId: thread.data.id,
      expectedRevision: reanchored.data.revision,
      action: "resolve",
    }, {
      ...baseContext,
      requestId: newFolioId(),
      idempotencyKey: `resolve-${suffix}`,
    }, pool);
    threads = await listPageCommentThreads({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      pageId: source.data.id,
      includeResolved: true,
    }, owner.principalId, pool);
    expect(threads[0]?.status).toBe("resolved");

    const bytes = Buffer.from("phase-2-attachment", "utf8");
    const attachment = await preparePageAttachment({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      pageId: source.data.id,
      fileName: "evidence.txt",
      mimeType: "text/plain",
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }, {
      ...baseContext,
      requestId: newFolioId(),
      idempotencyKey: `attachment-${suffix}`,
    }, pool);
    const stored = await storeAttachmentContent({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      attachmentId: attachment.data.id,
      bytes,
    }, owner.principalId, pool);
    expect(stored).toMatchObject({ storageState: "available", scanState: "clean" });
    expect((await readAttachmentContent({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      attachmentId: attachment.data.id,
    }, owner.principalId, pool)).bytes.toString("utf8")).toBe("phase-2-attachment");

    const exportPreview = await preparePageConversion({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      operation: "native_to_git",
      sourcePageId: source.data.id,
      sourceDescriptor: { page_id: source.data.id },
      targetDescriptor: { repository_link_id: newFolioId(), branch: "main", path: "source.md" },
    }, {
      ...baseContext,
      requestId: newFolioId(),
      idempotencyKey: `export-preview-${suffix}`,
    }, pool);
    const exported = await executePageConversion({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      previewId: exportPreview.data.id,
      expectedRevision: 1,
    }, {
      ...baseContext,
      requestId: newFolioId(),
      idempotencyKey: `export-${suffix}`,
    }, pool);
    expect(exported.data).toMatchObject({ resultKind: "git_proposal_ready", requiresGitOperation: true });
    expect(exported.data.preview.proposal).toMatchObject({ requiresGitOperation: true });

    const importPreview = await preparePageConversion({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      operation: "git_to_native",
      sourceDescriptor: { repository: "example/docs", branch: "main", path: "import.md", commit: "abc123" },
      targetDescriptor: { project_id: project.data.id },
      markdown: "---\ntitle: Imported\n---\n\n# Imported 🌏\n\nBody\n",
      title: "Imported page",
    }, {
      ...baseContext,
      requestId: newFolioId(),
      idempotencyKey: `import-preview-${suffix}`,
    }, pool);
    const imported = await executePageConversion({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      previewId: importPreview.data.id,
      expectedRevision: 1,
    }, {
      ...baseContext,
      requestId: newFolioId(),
      idempotencyKey: `import-${suffix}`,
    }, pool);
    expect(imported.data).toMatchObject({ resultKind: "native_page_created", requiresGitOperation: false });
    expect((await readNativePage({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      pageId: imported.data.createdPageId!,
    }, owner.principalId, pool)).title).toBe("Imported page");

    await rm(path.join(process.cwd(), ".local-data", "attachments", workspace.data.id), {
      recursive: true,
      force: true,
    });
  });
});
