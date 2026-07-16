import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

function id() {
  return crypto.randomUUID();
}

describeWithPostgres("Phase 0 and Phase 1 completion", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  afterAll(async () => pool.end());

  it("keeps signed invitation tokens out of idempotency records and accepts them once", async () => {
    process.env.WORKSPACE_INVITATION_SIGNING_KEY ??= "phase0-phase1-test-signing-key-012345678901234567890123";
    const {
      acceptWorkspaceInvitation,
      createProject,
      createWorkspace,
      createWorkspaceInvitation,
      provisionAuthenticatedHuman,
    } = await import("@/services/foundation");
    const { newFolioId } = await import("@/lib/folio-ids");
    const owner = await provisionAuthenticatedHuman({
      issuer: "https://identity.example.test",
      subject: `phase01-owner-${id()}`,
      email: `phase01-owner-${id()}@example.test`,
      displayName: "Phase 0/1 Owner",
    }, pool);
    const inviteeEmail = `phase01-invitee-${id()}@example.test`;
    const invitee = await provisionAuthenticatedHuman({
      issuer: "https://identity.example.test",
      subject: `phase01-invitee-${id()}`,
      email: inviteeEmail,
      displayName: "Phase 0/1 Invitee",
    }, pool);
    const mutation = (principalId:string, key:string) => ({
      actorPrincipalId: principalId,
      requestId: newFolioId(),
      traceId: `phase01-${key}`,
      idempotencyKey: key,
      source: "api" as const,
    });
    const workspace = await createWorkspace({ name: "Phase 0/1", slug: `phase01-${id().slice(0,8)}` }, mutation(owner.principalId, `workspace-${id()}`), pool);
    const project = await createProject({ workspaceId: workspace.data.id, projectKey: "OPS", name: "Operations" }, mutation(owner.principalId, `project-${id()}`), pool);
    const key = `invite-${id()}`;
    const created = await createWorkspaceInvitation({
      workspaceId: workspace.data.id,
      email: inviteeEmail,
      projectAssignments: [{ projectId: project.data.id, roleTemplateKey: "member" }],
    }, mutation(owner.principalId, key), pool);
    const replay = await createWorkspaceInvitation({
      workspaceId: workspace.data.id,
      email: inviteeEmail,
      projectAssignments: [{ projectId: project.data.id, roleTemplateKey: "member" }],
    }, mutation(owner.principalId, key), pool);
    expect(replay.replayed).toBe(true);
    expect(replay.data.token).toBe(created.data.token);
    const stored = await pool.query<{ response_body:string }>(`
      SELECT response_body::text response_body FROM idempotency_records
      WHERE workspace_id=$1 AND principal_id=$2 AND operation='workspace.invitation.create' AND key=$3
    `, [workspace.data.id, owner.principalId, key]);
    expect(stored.rows[0]?.response_body).not.toContain(created.data.token);

    const accepted = await acceptWorkspaceInvitation({ token: created.data.token }, mutation(invitee.principalId, `accept-${id()}`), pool);
    expect(accepted.data.workspaceId).toBe(workspace.data.id);
    await expect(acceptWorkspaceInvitation({ token: created.data.token }, mutation(invitee.principalId, `accept-again-${id()}`), pool)).rejects.toMatchObject({ code: "CONFLICT" });
    const membership = await pool.query(`SELECT 1 FROM project_memberships WHERE workspace_id=$1 AND project_id=$2 AND principal_id=$3 AND status='active'`, [workspace.data.id, project.data.id, invitee.principalId]);
    expect(membership.rows).toHaveLength(1);
  });

  it("enforces immutable snapshots, prepared writes, and isolated webhook privileges", async () => {
    const { newFolioId } = await import("@/lib/folio-ids");
    const { createProject, createWorkspace, provisionAuthenticatedHuman } = await import("@/services/foundation");
    const owner = await provisionAuthenticatedHuman({
      issuer: "https://identity.example.test",
      subject: `phase01-schema-owner-${id()}`,
      email: `phase01-schema-owner-${id()}@example.test`,
      displayName: "Phase 0/1 Schema Owner",
    }, pool);
    const mutation = (key:string) => ({ actorPrincipalId: owner.principalId, requestId:newFolioId(), traceId:key, idempotencyKey:key, source:"api" as const });
    const workspace = await createWorkspace({ name:"Provider Schema", slug:`provider-${id().slice(0,8)}` }, mutation(`workspace-${id()}`), pool);
    const project = await createProject({ workspaceId:workspace.data.id, projectKey:"GIT", name:"Git Provider" }, mutation(`project-${id()}`), pool);
    const installationId=newFolioId();
    const repositoryId=newFolioId();
    const linkId=newFolioId();
    const branchId=newFolioId();
    const snapshotId=newFolioId();
    const snapshotFileId=newFolioId();
    await pool.query(`INSERT INTO github_app_installations(id,workspace_id,provider_installation_id,account_id,account_login,account_type,repository_selection,permissions,events,credential_key_ref,state,created_by_principal_id) VALUES($1,$2,900001,900002,'folio-test','Organization','selected',$3,$4,'env:GITHUB_APP_PRIVATE_KEY','active',$5)`, [installationId,workspace.data.id,{contents:"write",pull_requests:"write"},["push"],owner.principalId]);
    await pool.query(`INSERT INTO github_repositories(id,workspace_id,installation_id,provider_repository_id,owner_login,name,full_name,default_branch,is_private,is_archived,permissions,state) VALUES($1,$2,$3,900003,'folio-test','docs','folio-test/docs','main',true,false,$4,'available')`, [repositoryId,workspace.data.id,installationId,{pull:true,push:true,admin:false,maintain:false,triage:true}]);
    await pool.query(`INSERT INTO project_repository_links(id,workspace_id,project_id,repository_id,display_name,write_policy,include_rules,exclude_rules,created_by_principal_id) VALUES($1,$2,$3,$4,'Docs','pull_request_only',$5,$6,$7)`, [linkId,workspace.data.id,project.data.id,repositoryId,["**/*.md"],[],owner.principalId]);
    await pool.query(`INSERT INTO selected_git_branches(id,workspace_id,project_id,repository_link_id,branch_name,created_by_principal_id) VALUES($1,$2,$3,$4,'main',$5)`, [branchId,workspace.data.id,project.data.id,linkId,owner.principalId]);
    await pool.query(`INSERT INTO git_snapshots(id,workspace_id,project_id,selected_branch_id,head_oid,state,rules_version,parser_version,inventory_hash,file_count) VALUES($1,$2,$3,$4,$5,'candidate',1,'phase01-test',$6,1)`, [snapshotId,workspace.data.id,project.data.id,branchId,"a".repeat(40),"b".repeat(64)]);
    await pool.query(`INSERT INTO git_snapshot_files(id,workspace_id,project_id,snapshot_id,source_path,blob_oid,size_bytes,content_hash,title,markdown,rendered_html,plain_text,headings) VALUES($1,$2,$3,$4,'README.md',$5,8,$6,'README','# README','<h1>README</h1>','README','[]')`, [snapshotFileId,workspace.data.id,project.data.id,snapshotId,"c".repeat(40),"d".repeat(64)]);
    await expect(pool.query(`UPDATE git_snapshot_files SET title='Changed' WHERE id=$1`, [snapshotFileId])).rejects.toMatchObject({ code:"55000" });
    await pool.query(`UPDATE git_snapshots SET state='published',published_at=now(),completed_at=now() WHERE id=$1`, [snapshotId]);
    await pool.query(`UPDATE selected_git_branches SET active_snapshot_id=$2 WHERE id=$1`, [branchId,snapshotId]);
    await expect(pool.query(`UPDATE git_snapshots SET file_count=2 WHERE id=$1`, [snapshotId])).rejects.toMatchObject({ code:"23514" });

    const preparedId=newFolioId();
    await pool.query(`INSERT INTO prepared_git_operations(id,workspace_id,project_id,repository_link_id,selected_branch_id,operation_kind,base_head_oid,target_branch,commit_message,file_operations,normalized_diff,action_digest,risk_level,actor_principal_id,authorizing_principal_id,expires_at,policy_snapshot) VALUES($1,$2,$3,$4,$5,'direct_update',$6,'main','Update README',$7,$8,$9,'R1',$10,$10,now()+interval '30 minutes',$11)`, [preparedId,workspace.data.id,project.data.id,linkId,branchId,"a".repeat(40),[{operation:"upsert",path:"README.md",baseBlobOid:"c".repeat(40),content:"# Updated",contentHash:"e".repeat(64)}],"--- a/README.md\n+++ b/README.md","f".repeat(64),owner.principalId,{linkRevision:1,rulesVersion:1,writePolicy:"pull_request_only"}]);
    await expect(pool.query(`UPDATE prepared_git_operations SET target_branch='other' WHERE id=$1`, [preparedId])).rejects.toMatchObject({ code:"23514" });

    const client=await pool.connect();
    try{
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE folio_webhook");
      await expect(client.query("SELECT count(*) FROM users")).rejects.toMatchObject({ code:"42501" });
      await client.query("ROLLBACK");
    }finally{client.release();}
  });
});
