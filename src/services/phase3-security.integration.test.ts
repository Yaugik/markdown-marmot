import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { newFolioId } from "@/lib/folio-ids";
import {
  createProject,
  createWorkspace,
  provisionAuthenticatedHuman,
} from "@/services/foundation";
import {
  archiveIssue,
  createIssue,
  readIssue,
} from "@/services/issues";
import {
  addIssueDependency,
  addIssueLink,
} from "@/services/issue-relations";
import {
  listReadableIssueDependencies,
  listReadableIssueLinks,
} from "@/services/issue-relation-reads";
import {
  executeIssueBulkOperation,
  prepareIssueBulkOperation,
  readIssueBulkPreview,
} from "@/services/issue-bulk";
import {
  createIssueSavedView,
} from "@/services/issue-views";
import { updateIssueSavedViewWithPolicy } from "@/services/issue-view-policy";
import { restoreIssueWithParentPolicy } from "@/services/issue-lifecycle-policy";

const databaseUrl = process.env.DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

function context(principalId: string, suffix: string, key: string) {
  return {
    actorPrincipalId: principalId,
    requestId: newFolioId(),
    traceId: `phase3-security-${suffix}`,
    idempotencyKey: `${key}-${suffix}`,
    source: "api" as const,
  };
}

describeWithPostgres("Phase 3 security hardening", () => {
  const pool = new Pool({ connectionString: databaseUrl });

  afterAll(async () => {
    await pool.end();
  });

  it("keeps previews private, filters hidden targets, and isolates bulk failures", async () => {
    const suffix = newFolioId();
    const owner = await provisionAuthenticatedHuman({
      issuer: "https://identity.example.test",
      subject: `phase3-security-owner-${suffix}`,
      email: `phase3-security-owner-${suffix}@example.test`,
      displayName: "Phase 3 Security Owner",
    }, pool);
    const objectReader = await provisionAuthenticatedHuman({
      issuer: "https://identity.example.test",
      subject: `phase3-security-object-reader-${suffix}`,
      email: `phase3-security-object-reader-${suffix}@example.test`,
      displayName: "Object Reader",
    }, pool);
    const viewReader = await provisionAuthenticatedHuman({
      issuer: "https://identity.example.test",
      subject: `phase3-security-view-reader-${suffix}`,
      email: `phase3-security-view-reader-${suffix}@example.test`,
      displayName: "View Reader",
    }, pool);

    const workspace = await createWorkspace({
      name: "Phase 3 Security Workspace",
      slug: `phase3-security-${suffix}`,
    }, context(owner.principalId, suffix, "workspace"), pool);
    const project = await createProject({
      workspaceId: workspace.data.id,
      projectKey: "SECURE",
      name: "Phase 3 Security",
    }, context(owner.principalId, suffix, "project"), pool);

    const objectReaderRoleId = newFolioId();
    const viewReaderRoleId = newFolioId();
    await pool.query(`INSERT INTO role_templates(
      id,workspace_id,name,template_key,capabilities,is_system_template
    ) VALUES
      ($1,$2,'Object Reader',$3,ARRAY['project.read']::text[],false),
      ($4,$2,'View Reader',$5,ARRAY['project.read','issue.read']::text[],false)`, [
      objectReaderRoleId,
      workspace.data.id,
      `object_reader_${suffix.slice(0, 8)}`,
      viewReaderRoleId,
      `view_reader_${suffix.slice(0, 8)}`,
    ]);
    for (const principalId of [objectReader.principalId, viewReader.principalId]) {
      await pool.query(`INSERT INTO workspace_memberships(
        id,workspace_id,principal_id,role,status,invited_by_principal_id
      ) VALUES($1,$2,$3,'member','active',$4)`, [
        newFolioId(), workspace.data.id, principalId, owner.principalId,
      ]);
    }
    await pool.query(`INSERT INTO project_memberships(
      id,workspace_id,project_id,principal_id,role_template_id,status,invited_by_principal_id
    ) VALUES
      ($1,$2,$3,$4,$5,'active',$6),
      ($7,$2,$3,$8,$9,'active',$6)`, [
      newFolioId(), workspace.data.id, project.data.id, objectReader.principalId,
      objectReaderRoleId, owner.principalId, newFolioId(), viewReader.principalId,
      viewReaderRoleId,
    ]);

    const source = await createIssue({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      title: "Visible source issue",
    }, context(owner.principalId, suffix, "source"), pool);
    const hidden = await createIssue({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      title: "Hidden target issue",
    }, context(owner.principalId, suffix, "hidden"), pool);
    await addIssueDependency({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      sourceIssueId: source.data.id,
      targetIssueId: hidden.data.id,
      relationKind: "blocks",
      expectedSourceRevision: source.data.revision,
    }, context(owner.principalId, suffix, "dependency"), pool);
    await addIssueLink({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      issueId: source.data.id,
      expectedRevision: source.data.revision + 1,
      linkKind: "issue",
      targetIssueId: hidden.data.id,
    }, context(owner.principalId, suffix, "issue-link"), pool);
    await addIssueLink({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      issueId: source.data.id,
      expectedRevision: source.data.revision + 2,
      linkKind: "external",
      externalUrl: "https://example.test/public",
    }, context(owner.principalId, suffix, "external-link"), pool);
    await pool.query(`INSERT INTO object_grants(
      id,workspace_id,project_id,principal_id,object_type,object_id,capabilities,
      granted_by_principal_id
    ) VALUES($1,$2,$3,$4,'issue',$5,ARRAY['issue.read']::text[],$6)`, [
      newFolioId(), workspace.data.id, project.data.id, objectReader.principalId,
      source.data.id, owner.principalId,
    ]);

    expect(await listReadableIssueDependencies({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      issueId: source.data.id,
    }, objectReader.principalId, pool)).toEqual([]);
    expect(await listReadableIssueLinks({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      issueId: source.data.id,
    }, objectReader.principalId, pool)).toEqual([
      expect.objectContaining({ linkKind: "external", externalUrl: "https://example.test/public" }),
    ]);

    const privatePreviewIssue = await createIssue({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      title: "Private preview target",
    }, context(owner.principalId, suffix, "preview-target"), pool);
    const privatePreview = await prepareIssueBulkOperation({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      issueIds: [privatePreviewIssue.data.id],
      request: { operation: "patch", patch: { priority: "high" } },
    }, context(owner.principalId, suffix, "private-preview"), pool);
    await expect(readIssueBulkPreview({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      previewId: privatePreview.data.id,
    }, viewReader.principalId, pool)).rejects.toMatchObject({ code: "NOT_FOUND" });

    const readerView = await createIssueSavedView({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      name: "Reader private view",
      visibility: "private",
    }, context(viewReader.principalId, suffix, "reader-view"), pool);
    await expect(updateIssueSavedViewWithPolicy({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      viewId: readerView.data.id,
      expectedRevision: readerView.data.revision,
      visibility: "project",
    }, context(viewReader.principalId, suffix, "publish-reader-view"), pool)).rejects
      .toMatchObject({ code: "CAPABILITY_DENIED" });

    const parent = await createIssue({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      title: "Archived parent",
    }, context(owner.principalId, suffix, "parent"), pool);
    const child = await createIssue({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      title: "Archived child",
      parentIssueId: parent.data.id,
    }, context(owner.principalId, suffix, "child"), pool);
    const archivedChild = await archiveIssue({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      issueId: child.data.id,
      expectedRevision: child.data.revision,
    }, context(owner.principalId, suffix, "archive-child"), pool);
    const archivedParent = await archiveIssue({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      issueId: parent.data.id,
      expectedRevision: parent.data.revision,
    }, context(owner.principalId, suffix, "archive-parent"), pool);
    await expect(restoreIssueWithParentPolicy({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      issueId: child.data.id,
      expectedRevision: archivedChild.data.revision,
    }, context(owner.principalId, suffix, "restore-child-early"), pool)).rejects
      .toMatchObject({ code: "CONFLICT" });
    const restoredParent = await restoreIssueWithParentPolicy({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      issueId: parent.data.id,
      expectedRevision: archivedParent.data.revision,
    }, context(owner.principalId, suffix, "restore-parent"), pool);
    expect(restoredParent.data.lifecycle).toBe("active");
    const restoredChild = await restoreIssueWithParentPolicy({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      issueId: child.data.id,
      expectedRevision: archivedChild.data.revision,
    }, context(owner.principalId, suffix, "restore-child"), pool);
    expect(restoredChild.data.lifecycle).toBe("active");

    const validPatch = await createIssue({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      title: "Bulk valid date",
      startOn: "2026-08-01",
      dueOn: "2026-08-20",
    }, context(owner.principalId, suffix, "bulk-valid"), pool);
    const invalidPatch = await createIssue({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      title: "Bulk invalid date",
      startOn: "2026-08-01",
      dueOn: "2026-08-05",
    }, context(owner.principalId, suffix, "bulk-invalid"), pool);
    const mixedPreview = await prepareIssueBulkOperation({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      issueIds: [validPatch.data.id, invalidPatch.data.id],
      request: { operation: "patch", patch: { startOn: "2026-08-15" } },
    }, context(owner.principalId, suffix, "mixed-preview"), pool);
    expect(mixedPreview.data.impact.blockedCount).toBe(1);
    const mixedResult = await executeIssueBulkOperation({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      previewId: mixedPreview.data.id,
      expectedRevision: mixedPreview.data.revision,
    }, context(owner.principalId, suffix, "mixed-execute"), pool);
    expect(mixedResult.data.result?.succeeded).toEqual([
      expect.objectContaining({ issueId: validPatch.data.id }),
    ]);
    expect(mixedResult.data.result?.failed).toEqual([
      expect.objectContaining({ issueId: invalidPatch.data.id, code: "VALIDATION_FAILED" }),
    ]);
    expect((await readIssue({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      issueId: validPatch.data.id,
    }, owner.principalId, pool)).startOn).toBe("2026-08-15");
  });
});
