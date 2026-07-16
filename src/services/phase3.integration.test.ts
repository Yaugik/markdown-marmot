import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { newFolioId } from "@/lib/folio-ids";
import { createProject, createWorkspace, provisionAuthenticatedHuman } from "@/services/foundation";
import {
  archiveIssue,
  createIssue,
  readIssue,
  restoreIssue,
  transitionIssue,
  updateIssue,
} from "./issues";
import { createIssueWorkflow } from "./issue-workflows";
import {
  addIssueComment,
  addIssueDependency,
} from "./issue-relations";
import {
  addRoadmapItem,
  createCycle,
  createIssueLabel,
  createMilestone,
  createRoadmap,
} from "./issue-portfolio";
import {
  createIssueSavedView,
  executeIssueProjection,
  listIssueSavedViews,
} from "./issue-views";
import {
  executeIssueBulkOperation,
  prepareIssueBulkOperation,
} from "./issue-bulk";
import {
  prepareIssueAttachment,
  readIssueAttachmentContent,
  storeIssueAttachmentContent,
} from "./issue-attachments";

const databaseUrl = process.env.DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const document = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

describeWithPostgres("Phase 3 work management", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  afterAll(async () => {
    await pool.end();
  });

  it("supports configurable workflows, safe relationships, portfolio views, and partial bulk results", async () => {
    const suffix = newFolioId();
    const owner = await provisionAuthenticatedHuman({
      issuer: "https://identity.example.test",
      subject: `phase3-owner-${suffix}`,
      email: `phase3-owner-${suffix}@example.test`,
      displayName: "Phase 3 Owner",
    }, pool);
    const reviewer = await provisionAuthenticatedHuman({
      issuer: "https://identity.example.test",
      subject: `phase3-reviewer-${suffix}`,
      email: `phase3-reviewer-${suffix}@example.test`,
      displayName: "Phase 3 Reviewer",
    }, pool);
    const context = (key: string) => ({
      actorPrincipalId: owner.principalId,
      requestId: newFolioId(),
      traceId: `phase3-${suffix}`,
      idempotencyKey: `${key}-${suffix}`,
      source: "api" as const,
    });
    const workspace = await createWorkspace({
      name: "Phase 3 Workspace",
      slug: `phase3-${suffix}`,
    }, context("workspace"), pool);
    const project = await createProject({
      workspaceId: workspace.data.id,
      projectKey: "WORK",
      name: "Work Management",
    }, context("project"), pool);

    const reviewerRoleId = newFolioId();
    await pool.query(`INSERT INTO role_templates(
      id,workspace_id,name,template_key,capabilities,is_system_template
    ) VALUES($1,$2,'Issue Reader',$3,ARRAY['issue.read']::text[],false)`, [
      reviewerRoleId,
      workspace.data.id,
      `issue_reader_${suffix.slice(0, 8)}`,
    ]);
    await pool.query(`INSERT INTO workspace_memberships(
      id,workspace_id,principal_id,role,status,invited_by_principal_id
    ) VALUES($1,$2,$3,'member','active',$4)`, [
      newFolioId(), workspace.data.id, reviewer.principalId, owner.principalId,
    ]);
    await pool.query(`INSERT INTO project_memberships(
      id,workspace_id,project_id,principal_id,role_template_id,status,invited_by_principal_id
    ) VALUES($1,$2,$3,$4,$5,'active',$6)`, [
      newFolioId(), workspace.data.id, project.data.id, reviewer.principalId,
      reviewerRoleId, owner.principalId,
    ]);

    const workflow = await createIssueWorkflow({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      name: "Delivery",
      isDefault: true,
      statuses: [
        { key: "backlog", name: "Backlog", category: "backlog", isInitial: true },
        { key: "doing", name: "Doing", category: "in_progress" },
        { key: "done", name: "Done", category: "completed" },
      ],
      transitions: [
        { fromKey: "backlog", toKey: "doing", name: "Start" },
        { fromKey: "doing", toKey: "done", name: "Complete" },
      ],
    }, context("workflow"), pool);
    const backlog = workflow.data.statuses.find((status) => status.name === "Backlog")!;
    const doing = workflow.data.statuses.find((status) => status.name === "Doing")!;
    const done = workflow.data.statuses.find((status) => status.name === "Done")!;

    const label = await createIssueLabel({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      name: "Backend",
      colorKey: "violet",
    }, context("label"), pool);
    const milestone = await createMilestone({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      name: "Beta",
      targetOn: "2026-09-30",
    }, context("milestone"), pool);
    const cycle = await createCycle({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      name: "Cycle 1",
      startsOn: "2026-08-01",
      endsOn: "2026-08-14",
    }, context("cycle"), pool);
    const roadmap = await createRoadmap({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      name: "Product roadmap",
    }, context("roadmap"), pool);

    const parent = await createIssue({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      title: "Parent delivery",
      description: document("Sensitive acceptance body must stay out of activity summaries"),
      workflowId: workflow.data.id,
      statusId: backlog.id,
      milestoneId: milestone.data.id,
      cycleId: cycle.data.id,
      labelIds: [label.data.id],
      priority: "high",
      startOn: "2026-08-01",
      dueOn: "2026-08-10",
    }, context("parent"), pool);
    const child = await createIssue({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      title: "Child delivery",
      workflowId: workflow.data.id,
      statusId: backlog.id,
      parentIssueId: parent.data.id,
    }, context("child"), pool);

    const started = await transitionIssue({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      issueId: child.data.id,
      expectedRevision: 1,
      targetStatusId: doing.id,
    }, context("start-child"), pool);
    expect(started.data.status.id).toBe(doing.id);
    await expect(transitionIssue({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      issueId: parent.data.id,
      expectedRevision: 1,
      targetStatusId: done.id,
    }, context("invalid-transition"), pool)).rejects.toMatchObject({ code: "CONFLICT" });

    await expect(updateIssue({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      issueId: parent.data.id,
      expectedRevision: 1,
      parentIssueId: child.data.id,
    }, context("hierarchy-cycle"), pool)).rejects.toThrow(/hierarchy cycle/i);

    const dependencyA = await createIssue({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      title: "Dependency A",
      workflowId: workflow.data.id,
      statusId: backlog.id,
    }, context("dependency-a"), pool);
    const dependencyB = await createIssue({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      title: "Dependency B",
      workflowId: workflow.data.id,
      statusId: backlog.id,
    }, context("dependency-b"), pool);
    const dependencyC = await createIssue({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      title: "Dependency C",
      workflowId: workflow.data.id,
      statusId: backlog.id,
    }, context("dependency-c"), pool);
    await addIssueDependency({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      sourceIssueId: dependencyA.data.id,
      targetIssueId: dependencyB.data.id,
      relationKind: "blocks",
      expectedSourceRevision: 1,
    }, context("a-blocks-b"), pool);
    await addIssueDependency({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      sourceIssueId: dependencyB.data.id,
      targetIssueId: dependencyC.data.id,
      relationKind: "blocks",
      expectedSourceRevision: 1,
    }, context("b-blocks-c"), pool);
    await expect(addIssueDependency({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      sourceIssueId: dependencyC.data.id,
      targetIssueId: dependencyA.data.id,
      relationKind: "blocks",
      expectedSourceRevision: 1,
    }, context("dependency-cycle"), pool)).rejects.toThrow(/dependency cycle/i);

    await expect(archiveIssue({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      issueId: parent.data.id,
      expectedRevision: 1,
    }, context("parent-archive-blocked"), pool)).rejects.toMatchObject({ code: "CONFLICT" });
    const archivedChild = await archiveIssue({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      issueId: child.data.id,
      expectedRevision: started.data.revision,
    }, context("archive-child"), pool);
    expect(archivedChild.data.lifecycle).toBe("archived");
    const archivedParent = await archiveIssue({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      issueId: parent.data.id,
      expectedRevision: 1,
    }, context("archive-parent"), pool);
    const restoredParent = await restoreIssue({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      issueId: parent.data.id,
      expectedRevision: archivedParent.data.revision,
    }, context("restore-parent"), pool);
    expect(restoredParent.data.lifecycle).toBe("active");

    await addIssueComment({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      issueId: parent.data.id,
      body: document("Portfolio review comment"),
    }, context("comment"), pool);
    await addRoadmapItem({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      roadmapId: roadmap.data.id,
      issueId: parent.data.id,
      expectedRoadmapRevision: 1,
      startsOn: "2026-08-01",
      endsOn: "2026-08-10",
    }, context("roadmap-item"), pool);

    const privateView = await createIssueSavedView({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      name: "Owner planning",
      visibility: "private",
      projection: "timeline",
      filters: { milestoneId: milestone.data.id },
      ordering: [{ field: "startOn", direction: "asc" }],
    }, context("private-view"), pool);
    const projectView = await createIssueSavedView({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      name: "Team board",
      visibility: "project",
      projection: "board",
      grouping: { field: "status" },
    }, context("project-view"), pool);
    expect((await listIssueSavedViews({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
    }, reviewer.principalId, pool)).map((view) => view.id)).toEqual([projectView.data.id]);
    await pool.query(`INSERT INTO object_grants(
      id,workspace_id,project_id,principal_id,object_type,object_id,capabilities,granted_by_principal_id
    ) VALUES($1,$2,$3,$4,'saved_view',$5,ARRAY['issue.read']::text[],$6)`, [
      newFolioId(), workspace.data.id, project.data.id, reviewer.principalId,
      privateView.data.id, owner.principalId,
    ]);
    expect(new Set((await listIssueSavedViews({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
    }, reviewer.principalId, pool)).map((view) => view.id))).toEqual(new Set([privateView.data.id, projectView.data.id]));
    const board = await executeIssueProjection({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      viewId: projectView.data.id,
    }, reviewer.principalId, pool);
    expect(board.kind).toBe("board");
    expect(board.groups.some((group) => group.key === backlog.id)).toBe(true);

    const bulkOne = await createIssue({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      title: "Bulk one",
      workflowId: workflow.data.id,
      statusId: backlog.id,
    }, context("bulk-one"), pool);
    const bulkTwo = await createIssue({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      title: "Bulk two",
      workflowId: workflow.data.id,
      statusId: backlog.id,
    }, context("bulk-two"), pool);
    const bulkPreview = await prepareIssueBulkOperation({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      issueIds: [bulkOne.data.id, bulkTwo.data.id],
      request: { operation: "patch", patch: { priority: "urgent" } },
    }, context("bulk-preview"), pool);
    await updateIssue({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      issueId: bulkTwo.data.id,
      expectedRevision: 1,
      priority: "low",
    }, context("bulk-two-stale"), pool);
    const bulkResult = await executeIssueBulkOperation({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      previewId: bulkPreview.data.id,
      expectedRevision: 1,
    }, context("bulk-execute"), pool);
    expect(bulkResult.data.result?.succeeded).toEqual([
      expect.objectContaining({ issueId: bulkOne.data.id, revision: 2 }),
    ]);
    expect(bulkResult.data.result?.failed).toEqual([
      expect.objectContaining({ issueId: bulkTwo.data.id, code: "REVISION_CONFLICT", currentRevision: 2 }),
    ]);
    expect((await readIssue({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      issueId: bulkOne.data.id,
    }, owner.principalId, pool)).priority).toBe("urgent");

    const attachmentBytes = Buffer.from("phase-3-issue-attachment", "utf8");
    const attachment = await prepareIssueAttachment({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      issueId: parent.data.id,
      fileName: "plan.txt",
      mimeType: "text/plain",
      sizeBytes: attachmentBytes.byteLength,
      sha256: createHash("sha256").update(attachmentBytes).digest("hex"),
    }, context("attachment"), pool);
    await storeIssueAttachmentContent({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      attachmentId: attachment.data.id,
      bytes: attachmentBytes,
    }, owner.principalId, pool);
    expect((await readIssueAttachmentContent({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      attachmentId: attachment.data.id,
    }, owner.principalId, pool)).bytes.toString("utf8")).toBe("phase-3-issue-attachment");

    const activity = await pool.query<{ input_summary: Record<string, unknown> }>(`
      SELECT input_summary FROM activity_events
      WHERE workspace_id=$1 AND project_id=$2 AND target_type='issue' AND target_id=$3
    `, [workspace.data.id, project.data.id, parent.data.id]);
    expect(JSON.stringify(activity.rows)).not.toContain("Sensitive acceptance body");
    expect(activity.rows.length).toBeGreaterThan(0);

    await rm(path.join(process.cwd(), ".local-data", "issue-attachments", workspace.data.id), {
      recursive: true,
      force: true,
    });
  });
});
