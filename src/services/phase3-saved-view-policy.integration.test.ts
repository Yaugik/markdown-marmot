import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { newFolioId } from "@/lib/folio-ids";
import {
  createProject,
  createWorkspace,
  provisionAuthenticatedHuman,
} from "@/services/foundation";
import { createIssue } from "@/services/issues";
import {
  createIssueSavedView,
  executeIssueProjection,
} from "@/services/issue-views";
import { listIssueSavedViewsWithPolicy } from "@/services/issue-view-policy";

const databaseUrl = process.env.DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

function context(principalId: string, suffix: string, key: string) {
  return {
    actorPrincipalId: principalId,
    requestId: newFolioId(),
    traceId: `phase3-saved-view-${suffix}`,
    idempotencyKey: `${key}-${suffix}`,
    source: "api" as const,
  };
}

describeWithPostgres("Phase 3 saved-view policy", () => {
  const pool = new Pool({ connectionString: databaseUrl });

  afterAll(async () => {
    await pool.end();
  });

  it("discovers an object-granted private view without broadening issue access", async () => {
    const suffix = newFolioId();
    const owner = await provisionAuthenticatedHuman({
      issuer: "https://identity.example.test",
      subject: `phase3-view-owner-${suffix}`,
      email: `phase3-view-owner-${suffix}@example.test`,
      displayName: "Saved View Owner",
    }, pool);
    const recipient = await provisionAuthenticatedHuman({
      issuer: "https://identity.example.test",
      subject: `phase3-view-recipient-${suffix}`,
      email: `phase3-view-recipient-${suffix}@example.test`,
      displayName: "Saved View Recipient",
    }, pool);
    const workspace = await createWorkspace({
      name: "Saved View Policy Workspace",
      slug: `phase3-view-${suffix}`,
    }, context(owner.principalId, suffix, "workspace"), pool);
    const project = await createProject({
      workspaceId: workspace.data.id,
      projectKey: "VIEWS",
      name: "Saved View Policy",
    }, context(owner.principalId, suffix, "project"), pool);

    const roleId = newFolioId();
    await pool.query(`INSERT INTO role_templates(
      id,workspace_id,name,template_key,capabilities,is_system_template
    ) VALUES($1,$2,'Project Visitor',$3,ARRAY['project.read']::text[],false)`, [
      roleId, workspace.data.id, `view_visitor_${suffix.slice(0, 8)}`,
    ]);
    await pool.query(`INSERT INTO workspace_memberships(
      id,workspace_id,principal_id,role,status,invited_by_principal_id
    ) VALUES($1,$2,$3,'member','active',$4)`, [
      newFolioId(), workspace.data.id, recipient.principalId, owner.principalId,
    ]);
    await pool.query(`INSERT INTO project_memberships(
      id,workspace_id,project_id,principal_id,role_template_id,status,invited_by_principal_id
    ) VALUES($1,$2,$3,$4,$5,'active',$6)`, [
      newFolioId(), workspace.data.id, project.data.id, recipient.principalId,
      roleId, owner.principalId,
    ]);

    await createIssue({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      title: "Owner-only issue",
    }, context(owner.principalId, suffix, "issue"), pool);
    const privateView = await createIssueSavedView({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      name: "Shared private view",
      visibility: "private",
      projection: "list",
    }, context(owner.principalId, suffix, "view"), pool);
    await pool.query(`INSERT INTO object_grants(
      id,workspace_id,project_id,principal_id,object_type,object_id,capabilities,
      granted_by_principal_id
    ) VALUES($1,$2,$3,$4,'saved_view',$5,ARRAY['issue.read']::text[],$6)`, [
      newFolioId(), workspace.data.id, project.data.id, recipient.principalId,
      privateView.data.id, owner.principalId,
    ]);

    expect(await listIssueSavedViewsWithPolicy({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
    }, recipient.principalId, pool)).toEqual([
      expect.objectContaining({ id: privateView.data.id, visibility: "private" }),
    ]);
    const projection = await executeIssueProjection({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      viewId: privateView.data.id,
    }, recipient.principalId, pool);
    expect(projection.total).toBe(0);
    expect(projection.issues).toEqual([]);
  });
});
