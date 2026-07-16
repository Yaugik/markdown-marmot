import { createHash, createHmac } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { postgresPool } from "@/db/postgres";
import { establishTenantContext } from "@/db/tenant";
import { env, workspaceInvitationsConfigured } from "@/lib/env";
import { newFolioId } from "@/lib/folio-ids";
import { FoundationServiceError } from "./errors";
import { findIdempotentResult, inTransaction, lockIdempotencyKey, recordMutation, requestDigest } from "./internal";
import type { WorkspaceInvitation } from "./memberships";
import type { MutationContext, MutationResult } from "./types";

type InvitationRow = {
  id:string;workspace_id:string;email_normalized:string;status:WorkspaceInvitation["status"];
  project_assignments:WorkspaceInvitation["projectAssignments"];invited_by_principal_id:string;
  accepted_by_principal_id:string|null;expires_at:Date;accepted_at:Date|null;revision:string;
};
const columns=`id,workspace_id,email_normalized,status,project_assignments,invited_by_principal_id,
  accepted_by_principal_id,expires_at,accepted_at,revision`;

function mapInvitation(row:InvitationRow):WorkspaceInvitation{return{id:row.id,workspaceId:row.workspace_id,email:row.email_normalized,status:row.status,projectAssignments:row.project_assignments,invitedByPrincipalId:row.invited_by_principal_id,acceptedByPrincipalId:row.accepted_by_principal_id,expiresAt:row.expires_at.toISOString(),acceptedAt:row.accepted_at?.toISOString()??null,revision:Number(row.revision)};}
async function requireOwner(client:PoolClient,workspaceId:string,principalId:string){const result=await client.query(`SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND principal_id=$2 AND role='owner' AND status='active'`,[workspaceId,principalId]);if(!result.rows[0])throw new FoundationServiceError("CAPABILITY_DENIED","An active workspace owner is required.");}
function normalizedEmail(value:string){const email=value.trim().toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>320)throw new FoundationServiceError("VALIDATION_FAILED","Invitation email is invalid.");return email;}
function tokenFor(invitation:Pick<WorkspaceInvitation,"id"|"workspaceId"|"expiresAt">){if(!workspaceInvitationsConfigured()||!env.WORKSPACE_INVITATION_SIGNING_KEY)throw new FoundationServiceError("CONFLICT","Workspace invitations are not configured.");const encoded=Buffer.from(JSON.stringify({v:1,id:invitation.id,w:invitation.workspaceId,exp:Date.parse(invitation.expiresAt)})).toString("base64url");const signature=createHmac("sha256",env.WORKSPACE_INVITATION_SIGNING_KEY).update(encoded).digest("base64url");return`${encoded}.${signature}`;}
async function validateAssignments(client:PoolClient,workspaceId:string,assignments:Array<{projectId:string;roleTemplateKey:string}>){if(assignments.length>100)throw new FoundationServiceError("VALIDATION_FAILED","Too many project assignments.");const seen=new Set<string>();for(const assignment of assignments){if(seen.has(assignment.projectId))throw new FoundationServiceError("VALIDATION_FAILED","Each project may appear once in an invitation.");seen.add(assignment.projectId);const result=await client.query(`SELECT 1 FROM projects project JOIN role_templates role ON role.workspace_id=project.workspace_id WHERE project.workspace_id=$1 AND project.id=$2 AND project.status='active' AND role.template_key=$3 AND role.archived_at IS NULL`,[workspaceId,assignment.projectId,assignment.roleTemplateKey]);if(!result.rows[0])throw new FoundationServiceError("VALIDATION_FAILED","A project or role assignment is invalid.");}}

export async function createWorkspaceInvitation(
  raw:{workspaceId:string;email:string;projectAssignments?:Array<{projectId:string;roleTemplateKey:string}>;expiresInHours?:number},
  context:MutationContext,pool:Pool=postgresPool(),
):Promise<MutationResult<{invitation:WorkspaceInvitation;token:string}>>{
  if(!workspaceInvitationsConfigured())throw new FoundationServiceError("CONFLICT","Workspace invitations are not configured.");
  const email=normalizedEmail(raw.email);const assignments=(raw.projectAssignments??[]).map((assignment)=>({projectId:assignment.projectId,roleTemplateKey:assignment.roleTemplateKey.trim().toLowerCase()}));const hours=raw.expiresInHours??72;if(!Number.isInteger(hours)||hours<1||hours>168)throw new FoundationServiceError("VALIDATION_FAILED","Invitation expiry must be between 1 and 168 hours.");const input={workspaceId:raw.workspaceId,email,projectAssignments:assignments,expiresInHours:hours};const operation="workspace.invitation.create";const digest=requestDigest(input);
  return inTransaction(pool,async(client)=>{
    await establishTenantContext(client,input.workspaceId,context.actorPrincipalId);await lockIdempotencyKey(client,context.actorPrincipalId,operation,context.idempotencyKey);
    const replay=await findIdempotentResult<WorkspaceInvitation>(client,{workspaceId:input.workspaceId,projectAgnostic:true,principalId:context.actorPrincipalId,operation,key:context.idempotencyKey,digest});
    if(replay)return{...replay,data:{invitation:replay.data,token:tokenFor(replay.data)}};
    await requireOwner(client,input.workspaceId,context.actorPrincipalId);await validateAssignments(client,input.workspaceId,assignments);
    const existingMember=await client.query(`SELECT 1 FROM users user_account JOIN principals principal ON principal.user_id=user_account.id JOIN workspace_memberships membership ON membership.principal_id=principal.id WHERE membership.workspace_id=$1 AND lower(user_account.primary_email)=$2 AND membership.status<>'removed'`,[input.workspaceId,email]);if(existingMember.rows[0])throw new FoundationServiceError("CONFLICT","This email already belongs to the workspace.");
    const id=newFolioId();const expiresAt=new Date(Date.now()+hours*60*60*1000);const unsigned:WorkspaceInvitation={id,workspaceId:input.workspaceId,email,status:"pending",projectAssignments:assignments,invitedByPrincipalId:context.actorPrincipalId,acceptedByPrincipalId:null,expiresAt:expiresAt.toISOString(),acceptedAt:null,revision:1};const token=tokenFor(unsigned);const tokenDigest=createHash("sha256").update(token).digest("hex");
    let inserted;try{inserted=await client.query<InvitationRow>(`INSERT INTO workspace_invitations(id,workspace_id,email_normalized,token_digest,project_assignments,invited_by_principal_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING ${columns}`,[id,input.workspaceId,email,tokenDigest,assignments,context.actorPrincipalId,expiresAt]);}catch(error){if((error as{code?:string}).code==="23505")throw new FoundationServiceError("CONFLICT","A pending invitation already exists for this email.");throw error;}
    const invitation=mapInvitation(inserted.rows[0]!);const recorded=await recordMutation(client,{workspaceId:input.workspaceId,context,operation,digest,action:operation,targetType:"workspace_invitation",targetId:id,aggregateType:"workspace_invitation",aggregateRevision:1,eventType:"workspace.invitation_created.v1",inputSummary:{emailDomain:email.split("@")[1],projectAssignmentCount:assignments.length,expiresInHours:hours},resultSummary:{invitationId:id,expiresAt:invitation.expiresAt},data:invitation});
    return{...recorded,data:{invitation:recorded.data,token}};
  });
}

export async function acceptWorkspaceInvitation(
  raw:{token:string},context:MutationContext,pool:Pool=postgresPool(),
):Promise<MutationResult<{workspaceId:string;invitationId:string}>>{
  const token=raw.token.trim();if(token.length<32||token.length>4000)throw new FoundationServiceError("VALIDATION_FAILED","Invitation token is invalid.");
  const tokenDigest=createHash("sha256").update(token).digest("hex");const operation="workspace.invitation.accept";const digest=requestDigest({tokenDigest});
  return inTransaction(pool,async(client)=>{
    const lookup=await client.query<{id:string;workspace_id:string}>(`SELECT id,workspace_id FROM folio.lookup_workspace_invitation($1,$2)`,[tokenDigest,context.actorPrincipalId]);
    const located=lookup.rows[0];if(!located)throw new FoundationServiceError("NOT_FOUND","Invitation was not found.");
    await establishTenantContext(client,located.workspace_id,context.actorPrincipalId);await lockIdempotencyKey(client,context.actorPrincipalId,operation,context.idempotencyKey);
    const replay=await findIdempotentResult<{workspaceId:string;invitationId:string}>(client,{workspaceId:located.workspace_id,projectAgnostic:true,principalId:context.actorPrincipalId,operation,key:context.idempotencyKey,digest});if(replay)return replay;
    const invitationResult=await client.query<InvitationRow>(`SELECT ${columns} FROM workspace_invitations WHERE workspace_id=$1 AND id=$2 AND token_digest=$3 FOR UPDATE`,[located.workspace_id,located.id,tokenDigest]);const invitation=invitationResult.rows[0];if(!invitation)throw new FoundationServiceError("NOT_FOUND","Invitation was not found.");
    if(invitation.status!=="pending")throw new FoundationServiceError("CONFLICT","Invitation is no longer pending.");
    if(invitation.expires_at<=new Date()){await client.query(`UPDATE workspace_invitations SET status='expired',revision=revision+1,updated_at=now() WHERE id=$1`,[invitation.id]);throw new FoundationServiceError("CONFIRMATION_EXPIRED","Invitation has expired.");}
    await client.query(`INSERT INTO workspace_memberships(id,workspace_id,principal_id,role,status,invited_by_principal_id) VALUES($1,$2,$3,'member','active',$4) ON CONFLICT(workspace_id,principal_id) DO UPDATE SET status='active',role='member',revision=workspace_memberships.revision+1,updated_at=now()`,[newFolioId(),invitation.workspace_id,context.actorPrincipalId,invitation.invited_by_principal_id]);
    for(const assignment of invitation.project_assignments){const role=await client.query<{id:string}>(`SELECT id FROM role_templates WHERE workspace_id=$1 AND template_key=$2 AND archived_at IS NULL`,[invitation.workspace_id,assignment.roleTemplateKey]);if(!role.rows[0])throw new FoundationServiceError("CONFLICT","Invitation role template is no longer available.");await client.query(`INSERT INTO project_memberships(id,workspace_id,project_id,principal_id,role_template_id,status,invited_by_principal_id) VALUES($1,$2,$3,$4,$5,'active',$6) ON CONFLICT(project_id,principal_id) DO UPDATE SET role_template_id=excluded.role_template_id,status='active',revision=project_memberships.revision+1,updated_at=now()`,[newFolioId(),invitation.workspace_id,assignment.projectId,context.actorPrincipalId,role.rows[0].id,invitation.invited_by_principal_id]);}
    const updated=await client.query<InvitationRow>(`UPDATE workspace_invitations SET status='accepted',accepted_by_principal_id=$2,accepted_at=now(),revision=revision+1,updated_at=now() WHERE id=$1 RETURNING ${columns}`,[invitation.id,context.actorPrincipalId]);const data={workspaceId:invitation.workspace_id,invitationId:invitation.id};
    return recordMutation(client,{workspaceId:invitation.workspace_id,context,operation,digest,action:operation,targetType:"workspace_invitation",targetId:invitation.id,aggregateType:"workspace_invitation",aggregateRevision:Number(updated.rows[0]!.revision),eventType:"workspace.invitation_accepted.v1",inputSummary:{projectAssignmentCount:invitation.project_assignments.length},resultSummary:data,data});
  });
}
