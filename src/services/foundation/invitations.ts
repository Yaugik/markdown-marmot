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
