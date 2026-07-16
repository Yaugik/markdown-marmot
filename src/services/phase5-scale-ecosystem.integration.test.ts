import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { newFolioId } from "@/lib/folio-ids";
import { executeAuditExportWithActivity } from "@/services/audit-export-worker";
import { readAuditExportContent, requestAuditExport } from "@/services/audit-exports";
import {
  createSupportAccessGrant,
  createWorkspaceIdentityConfig,
  upsertWorkspaceResidencyPolicy,
} from "@/services/enterprise-controls";
import { createProject, createWorkspace, provisionAuthenticatedHuman } from "@/services/foundation";
import {
  openPageCollaborationRoomWithSnapshot,
  commitPageCollaborationRoomRecoverably,
} from "@/services/page-realtime-collaboration-policy";
import { submitPageCollaborationOperationSafely } from "@/services/page-realtime-operation-policy";
import { createNativePage, readNativePage } from "@/services/pages";
import { createScaleDecision, recordScaleMeasurement } from "@/services/scale-governance";

const databaseUrl=process.env.DATABASE_URL;
const describeWithPostgres=databaseUrl?describe:describe.skip;
const doc=(text:string)=>({type:"doc",content:[{type:"paragraph",content:[{type:"text",text}]}]});
function context(principalId:string,suffix:string,key:string,extra?:{confirmationId?:string}){return{actorPrincipalId:principalId,requestId:newFolioId(),traceId:`phase5-scale-${suffix}`,idempotencyKey:`${key}-${suffix}`,source:"api" as const,...extra};}

describeWithPostgres("Phase 5 scale and ecosystem depth",()=>{
  const pool=new Pool({connectionString:databaseUrl});
  afterAll(async()=>pool.end());

  it("sequences collaboration and gates enterprise effects with evidence and confirmation",async()=>{
    const suffix=newFolioId();
    const owner=await provisionAuthenticatedHuman({issuer:"https://identity.example.test",subject:`phase5-scale-owner-${suffix}`,email:`phase5-scale-owner-${suffix}@example.test`,displayName:"Scale Owner"},pool);
    const support=await provisionAuthenticatedHuman({issuer:"https://identity.example.test",subject:`phase5-support-${suffix}`,email:`phase5-support-${suffix}@example.test`,displayName:"Support Principal"},pool);
    const workspace=await createWorkspace({name:"Phase 5 Scale Workspace",slug:`phase5-scale-${suffix}`},context(owner.principalId,suffix,"workspace"),pool);
    const project=await createProject({workspaceId:workspace.data.id,projectKey:"SCALE",name:"Scale Ecosystem"},context(owner.principalId,suffix,"project"),pool);
    const page=await createNativePage({workspaceId:workspace.data.id,projectId:project.data.id,title:"Realtime brief",content:doc("Initial")},context(owner.principalId,suffix,"page"),pool);

    const room=await openPageCollaborationRoomWithSnapshot({workspaceId:workspace.data.id,projectId:project.data.id,pageId:page.data.id},context(owner.principalId,suffix,"room"),pool);
    expect(room.data).toMatchObject({room:{currentSequence:0},plainText:"Initial"});
    const applied=await submitPageCollaborationOperationSafely({workspaceId:workspace.data.id,projectId:project.data.id,roomId:room.data.room.id,clientId:"client-a",clientSequence:1,baseSequence:0,content:doc("Collaborative update")},context(owner.principalId,suffix,"operation"),pool);
    expect(applied.data.serverSequence).toBe(1);
    const replayed=await submitPageCollaborationOperationSafely({workspaceId:workspace.data.id,projectId:project.data.id,roomId:room.data.room.id,clientId:"client-a",clientSequence:1,baseSequence:0,content:doc("Collaborative update")},context(owner.principalId,suffix,"different-header-key"),pool);
    expect(replayed.replayed).toBe(true);
    await expect(submitPageCollaborationOperationSafely({workspaceId:workspace.data.id,projectId:project.data.id,roomId:room.data.room.id,clientId:"client-a",clientSequence:1,baseSequence:0,content:doc("Different content")},context(owner.principalId,suffix,"mismatched-retry"),pool)).rejects.toMatchObject({code:"IDEMPOTENCY_CONFLICT"});
    const reopened=await openPageCollaborationRoomWithSnapshot({workspaceId:workspace.data.id,projectId:project.data.id,pageId:page.data.id},context(owner.principalId,suffix,"room-reopen"),pool);
    expect(reopened.data).toMatchObject({plainText:"Collaborative update",room:{currentSequence:1}});
    const committed=await commitPageCollaborationRoomRecoverably({workspaceId:workspace.data.id,projectId:project.data.id,roomId:room.data.room.id},context(owner.principalId,suffix,"commit"),pool);
    expect(committed.data.room.state).toBe("closed");
    expect((await readNativePage({workspaceId:workspace.data.id,projectId:project.data.id,pageId:page.data.id},owner.principalId,pool)).currentRevision.plainText).toBe("Collaborative update");

    const measurementIds:string[]=[];
    for(let index=0;index<3;index++){
      const measurement=await recordScaleMeasurement({workspaceId:workspace.data.id,projectId:project.data.id,component:"queue",metricName:"queue.claim_latency_ms",windowStart:`2026-07-${String(10+index).padStart(2,"0")}T00:00:00.000Z`,windowEnd:`2026-07-${String(11+index).padStart(2,"0")}T00:00:00.000Z`,sampleCount:1000,p95:250+index*20,p99:500+index*20,maximum:900,dimensions:{workerCount:2}},context(owner.principalId,suffix,`measurement-${index}`),pool);
      measurementIds.push(measurement.data.id);
    }
    await expect(createScaleDecision({workspaceId:workspace.data.id,projectId:project.data.id,component:"queue",decision:"approve_extraction",rationale:"Insufficient evidence",measurementIds:measurementIds.slice(0,2)},context(owner.principalId,suffix,"insufficient-decision"),pool)).rejects.toMatchObject({code:"CONFLICT"});
    const decision=await createScaleDecision({workspaceId:workspace.data.id,projectId:project.data.id,component:"queue",decision:"approve_extraction",rationale:"Three sustained windows exceed the accepted queue latency threshold.",thresholds:{p95:200},measurementIds},context(owner.principalId,suffix,"decision"),pool);
    expect(decision.data).toMatchObject({component:"queue",decision:"approve_extraction"});

    const identity=await createWorkspaceIdentityConfig({workspaceId:workspace.data.id,providerKind:"oidc",displayName:"Corporate identity",issuer:"https://login.example.test",secretReference:`secret://identity/${suffix}`,allowedDomains:["example.test"],attributeMapping:{email:"email"}},context(owner.principalId,suffix,"identity"),pool);
    expect(identity.data.state).toBe("draft");
    const residency=await upsertWorkspaceResidencyPolicy({workspaceId:workspace.data.id,primaryRegion:"in-west-1",allowedRegions:["in-west-1","eu-west-1"],exportRegion:"in-west-1",customerManagedKeyReference:`kms://workspace/${suffix}`},context(owner.principalId,suffix,"residency"),pool);
    expect(residency.data).toMatchObject({primaryRegion:"in-west-1",customerManagedKeyConfigured:true});

    const confirmationId=newFolioId();
    await pool.query(`INSERT INTO action_confirmations(id,workspace_id,project_id,actor_principal_id,authorizing_principal_id,operation,action_digest,risk_level,preview,status,expires_at,decided_at) VALUES($1,$2,$3,$4,$4,'enterprise.support_access.create',$5,'R3',$6,'approved',now()+interval '1 hour',now())`,[confirmationId,workspace.data.id,project.data.id,owner.principalId,"a".repeat(64),{supportPrincipalId:support.principalId}]);
    const grant=await createSupportAccessGrant({workspaceId:workspace.data.id,supportPrincipalId:support.principalId,confirmationId,reason:"Investigate a customer-reported read-path failure.",capabilities:["project.read","activity.read"],validUntil:new Date(Date.now()+60*60*1000).toISOString()},context(owner.principalId,suffix,"support",{confirmationId}),pool);
    expect(grant.data).toMatchObject({state:"active",confirmationId});
    const confirmation=await pool.query<{status:string;consumed_at:Date|null}>(`SELECT status,consumed_at FROM action_confirmations WHERE id=$1`,[confirmationId]);
    expect(confirmation.rows[0]).toMatchObject({status:"consumed"});
    expect(confirmation.rows[0]?.consumed_at).toBeInstanceOf(Date);
    await expect(createSupportAccessGrant({workspaceId:workspace.data.id,supportPrincipalId:support.principalId,confirmationId,reason:"Attempted replay.",capabilities:["project.read"],validUntil:new Date(Date.now()+30*60*1000).toISOString()},context(owner.principalId,suffix,"support-replay",{confirmationId}),pool)).rejects.toBeTruthy();
    const activity=await pool.query<{confirmation_id:string|null}>(`SELECT confirmation_id FROM activity_events WHERE target_type='support_access_grant' AND target_id=$1`,[grant.data.id]);
    expect(activity.rows[0]?.confirmation_id).toBe(confirmationId);

    const requested=await requestAuditExport({workspaceId:workspace.data.id,projectId:project.data.id,format:"jsonl",filters:{actions:["page_collaboration.commit","enterprise.support_access.create"],limit:1000}},context(owner.principalId,suffix,"audit-export"),pool);
    const executed=await executeAuditExportWithActivity(requested.data.id,pool);
    expect(executed.rowCount).toBeGreaterThanOrEqual(1);
    const content=await readAuditExportContent({workspaceId:workspace.data.id,exportId:requested.data.id},owner.principalId,pool);
    expect(content.content.toString("utf8")).toContain("support_access_grant");
    expect(content.content.toString("utf8")).not.toContain(`secret://identity/${suffix}`);
    const completedActivity=await pool.query(`SELECT 1 FROM activity_events WHERE action='audit_export.completed' AND target_id=$1`,[requested.data.id]);
    expect(completedActivity.rows[0]).toBeTruthy();
  });
});
