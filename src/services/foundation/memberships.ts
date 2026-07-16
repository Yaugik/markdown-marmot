import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { postgresPool } from "@/db/postgres";
import { establishTenantContext } from "@/db/tenant";
import { newFolioId } from "@/lib/folio-ids";
import { FoundationServiceError } from "./errors";
import {
  findIdempotentResult,
  inTransaction,
  lockIdempotencyKey,
  recordMutation,
  requestDigest,
} from "./internal";
import type { MutationContext, MutationResult } from "./types";

export type WorkspaceMember = {
  principalId: string;
  displayName: string;
  email: string;
  workspaceRole: "owner" | "member";
  workspaceStatus: "invited" | "active" | "suspended" | "removed";
  revision: number;
  projects: Array<{ projectId: string; projectKey: string; roleTemplateKey: string; status: string }>;
};

export type WorkspaceInvitation = {
  id: string;
  workspaceId: string;
  email: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  projectAssignments: Array<{ projectId: string; roleTemplateKey: string }>;
  invitedByPrincipalId: string;
  acceptedByPrincipalId: string | null;
  expiresAt: string;
  acceptedAt: string | null;
  revision: number;
};

type InvitationRow = {
  id: string; workspace_id: string; email_normalized: string; status: WorkspaceInvitation["status"];
  project_assignments: WorkspaceInvitation["projectAssignments"]; invited_by_principal_id: string;
  accepted_by_principal_id: string | null; expires_at: Date; accepted_at: Date | null; revision: string;
};

const invitationColumns = `id,workspace_id,email_normalized,status,project_assignments,
  invited_by_principal_id,accepted_by_principal_id,expires_at,accepted_at,revision`;

function mapInvitation(row: InvitationRow): WorkspaceInvitation {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    email: row.email_normalized,
    status: row.status,
    projectAssignments: row.project_assignments,
    invitedByPrincipalId: row.invited_by_principal_id,
    acceptedByPrincipalId: row.accepted_by_principal_id,
    expiresAt: row.expires_at.toISOString(),
    acceptedAt: row.accepted_at?.toISOString() ?? null,
    revision: Number(row.revision),
  };
}

async function requireWorkspaceOwner(client: PoolClient, workspaceId: string, principalId: string) {
  const result = await client.query(`SELECT 1 FROM workspaces workspace
    JOIN workspace_memberships membership ON membership.workspace_id=workspace.id
    WHERE workspace.id=$1 AND workspace.status='active' AND membership.principal_id=$2
      AND membership.role='owner' AND membership.status='active'`, [workspaceId,principalId]);
  if (!result.rows[0]) throw new FoundationServiceError("CAPABILITY_DENIED", "An active workspace owner is required.");
}

function normalizedEmail(value: string) {
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Invitation email is invalid.");
  }
  return email;
}

async function validateAssignments(
  client: PoolClient,
  workspaceId: string,
  assignments: Array<{ projectId: string; roleTemplateKey: string }>,
) {
  if (assignments.length > 100) throw new FoundationServiceError("VALIDATION_FAILED", "Too many project assignments.");
  const seen = new Set<string>();
  for (const assignment of assignments) {
    if (seen.has(assignment.projectId)) throw new FoundationServiceError("VALIDATION_FAILED", "Each project may appear once in an invitation.");
    seen.add(assignment.projectId);
    const result = await client.query(`SELECT 1 FROM projects project
      JOIN role_templates role ON role.workspace_id=project.workspace_id
      WHERE project.workspace_id=$1 AND project.id=$2 AND project.status='active'
        AND role.template_key=$3 AND role.archived_at IS NULL`,
    [workspaceId,assignment.projectId,assignment.roleTemplateKey]);
    if (!result.rows[0]) throw new FoundationServiceError("VALIDATION_FAILED", "A project or role assignment is invalid.");
  }
}

export async function listWorkspaceMembers(
  workspaceId: string,
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<WorkspaceMember[]> {
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client,workspaceId,principalId);
    await requireWorkspaceOwner(client,workspaceId,principalId);
    const members = await client.query<{
      principal_id:string;display_name:string;primary_email:string;role:"owner"|"member";
      status:WorkspaceMember["workspaceStatus"];revision:string;
    }>(`SELECT principal.id principal_id,principal.display_name,user_account.primary_email,
      membership.role,membership.status,membership.revision
      FROM workspace_memberships membership
      JOIN principals principal ON principal.id=membership.principal_id
      JOIN users user_account ON user_account.id=principal.user_id
      WHERE membership.workspace_id=$1 ORDER BY membership.status,principal.display_name,principal.id`,[workspaceId]);
    const projects = await client.query<{principal_id:string;project_id:string;project_key:string;template_key:string;status:string}>(`
      SELECT membership.principal_id,membership.project_id,project.project_key,role.template_key,membership.status
      FROM project_memberships membership
      JOIN projects project ON project.workspace_id=membership.workspace_id AND project.id=membership.project_id
      JOIN role_templates role ON role.workspace_id=membership.workspace_id AND role.id=membership.role_template_id
      WHERE membership.workspace_id=$1`,[workspaceId]);
    return members.rows.map((member) => ({
      principalId: member.principal_id,
      displayName: member.display_name,
      email: member.primary_email,
      workspaceRole: member.role,
      workspaceStatus: member.status,
      revision: Number(member.revision),
      projects: projects.rows.filter((project) => project.principal_id===member.principal_id).map((project) => ({
        projectId: project.project_id, projectKey: project.project_key,
        roleTemplateKey: project.template_key, status: project.status,
      })),
    }));
  });
}

export async function listWorkspaceInvitations(
  workspaceId: string,
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<WorkspaceInvitation[]> {
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client,workspaceId,principalId);
    await requireWorkspaceOwner(client,workspaceId,principalId);
    await client.query(`UPDATE workspace_invitations SET status='expired',revision=revision+1,updated_at=now()
      WHERE workspace_id=$1 AND status='pending' AND expires_at<=now()`,[workspaceId]);
    const result = await client.query<InvitationRow>(`SELECT ${invitationColumns} FROM workspace_invitations
      WHERE workspace_id=$1 ORDER BY created_at DESC,id`,[workspaceId]);
    return result.rows.map(mapInvitation);
  });
}

export async function createWorkspaceInvitation(
  raw: {
    workspaceId: string;
    email: string;
    projectAssignments?: Array<{ projectId: string; roleTemplateKey: string }>;
    expiresInHours?: number;
  },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<{ invitation: WorkspaceInvitation; token: string }>> {
  const email = normalizedEmail(raw.email);
  const assignments = (raw.projectAssignments ?? []).map((assignment) => ({
    projectId: assignment.projectId,
    roleTemplateKey: assignment.roleTemplateKey.trim().toLowerCase(),
  }));
  const hours = raw.expiresInHours ?? 72;
  if (!Number.isInteger(hours) || hours < 1 || hours > 168) throw new FoundationServiceError("VALIDATION_FAILED", "Invitation expiry must be between 1 and 168 hours.");
  const input = { workspaceId: raw.workspaceId, email, projectAssignments: assignments, expiresInHours: hours };
  const operation = "workspace.invitation.create";
  const digest = requestDigest(input);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client,input.workspaceId,context.actorPrincipalId);
    await lockIdempotencyKey(client,context.actorPrincipalId,operation,context.idempotencyKey);
    const replay = await findIdempotentResult<{ invitation: WorkspaceInvitation; token: string }>(client,{
      workspaceId: input.workspaceId, projectAgnostic: true, principalId: context.actorPrincipalId,
      operation,key:context.idempotencyKey,digest,
    });
    if (replay) return replay;
    await requireWorkspaceOwner(client,input.workspaceId,context.actorPrincipalId);
    await validateAssignments(client,input.workspaceId,assignments);
    const existingMember = await client.query(`SELECT 1 FROM users user_account
      JOIN principals principal ON principal.user_id=user_account.id
      JOIN workspace_memberships membership ON membership.principal_id=principal.id
      WHERE membership.workspace_id=$1 AND user_account.primary_email=$2 AND membership.status<>'removed'`,
    [input.workspaceId,email]);
    if (existingMember.rows[0]) throw new FoundationServiceError("CONFLICT", "This email already belongs to the workspace.");
    const token = randomBytes(32).toString("base64url");
    const tokenDigest = createHash("sha256").update(token).digest("hex");
    const id = newFolioId();
    const expiresAt = new Date(Date.now()+hours*60*60*1000);
    let inserted;
    try {
      inserted = await client.query<InvitationRow>(`INSERT INTO workspace_invitations(
        id,workspace_id,email_normalized,token_digest,project_assignments,invited_by_principal_id,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING ${invitationColumns}`,
      [id,input.workspaceId,email,tokenDigest,assignments,context.actorPrincipalId,expiresAt]);
    } catch (error) {
      if ((error as {code?:string}).code==='23505') throw new FoundationServiceError("CONFLICT", "A pending invitation already exists for this email.");
      throw error;
    }
    const data = { invitation: mapInvitation(inserted.rows[0]!), token };
    return recordMutation(client,{
      workspaceId: input.workspaceId, context, operation, digest,
      action: operation,targetType:"workspace_invitation",targetId:id,
      aggregateType:"workspace_invitation",aggregateRevision:1,eventType:"workspace.invitation_created.v1",
      inputSummary:{ emailDomain: email.split('@')[1], projectAssignmentCount: assignments.length, expiresInHours: hours },
      resultSummary:{ invitationId:id, expiresAt:expiresAt.toISOString() },data,
    });
  });
}

export async function acceptWorkspaceInvitation(
  raw: { token: string },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<{ workspaceId: string; invitationId: string }>> {
  const token = raw.token.trim();
  if (token.length < 32 || token.length > 200) throw new FoundationServiceError("VALIDATION_FAILED", "Invitation token is invalid.");
  const tokenDigest = createHash("sha256").update(token).digest("hex");
  const operation = "workspace.invitation.accept";
  const digest = requestDigest({ tokenDigest });
  return inTransaction(pool, async (client) => {
    const principal = await client.query<{email:string}>(`SELECT user_account.primary_email email FROM principals principal
      JOIN users user_account ON user_account.id=principal.user_id
      WHERE principal.id=$1 AND principal.kind='human' AND principal.status='active'`,[context.actorPrincipalId]);
    if (!principal.rows[0]) throw new FoundationServiceError("CAPABILITY_DENIED", "An active human principal is required.");
    const invitationResult = await client.query<InvitationRow & {token_digest:string}>(`SELECT ${invitationColumns},token_digest
      FROM workspace_invitations WHERE token_digest=$1 FOR UPDATE`,[tokenDigest]);
    const invitation = invitationResult.rows[0];
    if (!invitation) throw new FoundationServiceError("NOT_FOUND", "Invitation was not found.");
    await establishTenantContext(client,invitation.workspace_id,context.actorPrincipalId);
    await lockIdempotencyKey(client,context.actorPrincipalId,operation,context.idempotencyKey);
    const replay = await findIdempotentResult<{ workspaceId:string; invitationId:string }>(client,{
      workspaceId: invitation.workspace_id, projectAgnostic:true, principalId: context.actorPrincipalId,
      operation,key:context.idempotencyKey,digest,
    });
    if (replay) return replay;
    if (invitation.status!=='pending') throw new FoundationServiceError("CONFLICT", "Invitation is no longer pending.");
    if (invitation.expires_at<=new Date()) {
      await client.query(`UPDATE workspace_invitations SET status='expired',revision=revision+1,updated_at=now() WHERE id=$1`,[invitation.id]);
      throw new FoundationServiceError("CONFLICT", "Invitation has expired.");
    }
    if (principal.rows[0].email.toLowerCase()!==invitation.email_normalized) {
      throw new FoundationServiceError("CAPABILITY_DENIED", "Invitation email does not match the authenticated identity.");
    }
    await client.query(`INSERT INTO workspace_memberships(id,workspace_id,principal_id,role,status,invited_by_principal_id)
      VALUES($1,$2,$3,'member','active',$4)
      ON CONFLICT(workspace_id,principal_id) DO UPDATE SET status='active',role='member',revision=workspace_memberships.revision+1,updated_at=now()`,
    [newFolioId(),invitation.workspace_id,context.actorPrincipalId,invitation.invited_by_principal_id]);
    for (const assignment of invitation.project_assignments) {
      const role = await client.query<{id:string}>(`SELECT id FROM role_templates
        WHERE workspace_id=$1 AND template_key=$2 AND archived_at IS NULL`,
      [invitation.workspace_id,assignment.roleTemplateKey]);
      if (!role.rows[0]) throw new FoundationServiceError("CONFLICT", "Invitation role template is no longer available.");
      await client.query(`INSERT INTO project_memberships(id,workspace_id,project_id,principal_id,role_template_id,status,invited_by_principal_id)
        VALUES($1,$2,$3,$4,$5,'active',$6)
        ON CONFLICT(project_id,principal_id) DO UPDATE SET role_template_id=excluded.role_template_id,status='active',revision=project_memberships.revision+1,updated_at=now()`,
      [newFolioId(),invitation.workspace_id,assignment.projectId,context.actorPrincipalId,role.rows[0].id,invitation.invited_by_principal_id]);
    }
    const updated = await client.query<InvitationRow>(`UPDATE workspace_invitations
      SET status='accepted',accepted_by_principal_id=$2,accepted_at=now(),revision=revision+1,updated_at=now()
      WHERE id=$1 RETURNING ${invitationColumns}`,[invitation.id,context.actorPrincipalId]);
    const data = { workspaceId: invitation.workspace_id, invitationId: invitation.id };
    return recordMutation(client,{
      workspaceId: invitation.workspace_id, context, operation, digest,
      action:operation,targetType:"workspace_invitation",targetId:invitation.id,
      aggregateType:"workspace_invitation",aggregateRevision:Number(updated.rows[0]!.revision),
      eventType:"workspace.invitation_accepted.v1",
      inputSummary:{ projectAssignmentCount: invitation.project_assignments.length },
      resultSummary:data,data,
    });
  });
}

export async function revokeWorkspaceInvitation(
  raw: { workspaceId:string; invitationId:string; expectedRevision:number },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<WorkspaceInvitation>> {
  const operation="workspace.invitation.revoke";
  const digest=requestDigest(raw);
  return inTransaction(pool,async(client)=>{
    await establishTenantContext(client,raw.workspaceId,context.actorPrincipalId);
    await lockIdempotencyKey(client,context.actorPrincipalId,operation,context.idempotencyKey);
    const replay=await findIdempotentResult<WorkspaceInvitation>(client,{workspaceId:raw.workspaceId,projectAgnostic:true,principalId:context.actorPrincipalId,operation,key:context.idempotencyKey,digest});
    if(replay)return replay;
    await requireWorkspaceOwner(client,raw.workspaceId,context.actorPrincipalId);
    const updated=await client.query<InvitationRow>(`UPDATE workspace_invitations SET status='revoked',revoked_at=now(),revision=revision+1,updated_at=now()
      WHERE workspace_id=$1 AND id=$2 AND revision=$3 AND status='pending' RETURNING ${invitationColumns}`,
    [raw.workspaceId,raw.invitationId,raw.expectedRevision]);
    if(!updated.rows[0])throw new FoundationServiceError("REVISION_CONFLICT","Invitation is not pending at the expected revision.");
    const data=mapInvitation(updated.rows[0]);
    return recordMutation(client,{workspaceId:raw.workspaceId,context,operation,digest,action:operation,targetType:"workspace_invitation",targetId:raw.invitationId,aggregateType:"workspace_invitation",aggregateRevision:data.revision,eventType:"workspace.invitation_revoked.v1",inputSummary:{expectedRevision:raw.expectedRevision},resultSummary:{invitationId:data.id},data});
  });
}

export async function updateWorkspaceMember(
  raw: { workspaceId:string; targetPrincipalId:string; expectedRevision:number; workspaceRole?:"owner"|"member"; status?:"active"|"suspended"|"removed" },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<{ principalId:string; workspaceRole:string; status:string; revision:number }>> {
  if(raw.workspaceRole===undefined&&raw.status===undefined)throw new FoundationServiceError("VALIDATION_FAILED","At least one membership field must change.");
  const operation="workspace.membership.update";const digest=requestDigest(raw);
  return inTransaction(pool,async(client)=>{
    await establishTenantContext(client,raw.workspaceId,context.actorPrincipalId);
    await lockIdempotencyKey(client,context.actorPrincipalId,operation,context.idempotencyKey);
    const replay=await findIdempotentResult<{principalId:string;workspaceRole:string;status:string;revision:number}>(client,{workspaceId:raw.workspaceId,projectAgnostic:true,principalId:context.actorPrincipalId,operation,key:context.idempotencyKey,digest});
    if(replay)return replay;
    await requireWorkspaceOwner(client,raw.workspaceId,context.actorPrincipalId);
    const current=await client.query<{role:string;status:string;revision:string}>(`SELECT role,status,revision FROM workspace_memberships WHERE workspace_id=$1 AND principal_id=$2 FOR UPDATE`,[raw.workspaceId,raw.targetPrincipalId]);
    if(!current.rows[0])throw new FoundationServiceError("NOT_FOUND","Workspace member was not found.");
    if(Number(current.rows[0].revision)!==raw.expectedRevision)throw new FoundationServiceError("REVISION_CONFLICT","Workspace membership changed after it was read.",{expectedRevision:raw.expectedRevision,currentRevision:Number(current.rows[0].revision)});
    const nextRole=raw.workspaceRole??current.rows[0].role;const nextStatus=raw.status??current.rows[0].status;
    if(current.rows[0].role==='owner'&&(nextRole!=='owner'||nextStatus!=='active')){
      const owners=await client.query<{count:string}>(`SELECT count(*) count FROM workspace_memberships WHERE workspace_id=$1 AND role='owner' AND status='active'`,[raw.workspaceId]);
      if(Number(owners.rows[0]!.count)<=1)throw new FoundationServiceError("CONFLICT","The last active workspace owner cannot be removed or demoted.");
    }
    const updated=await client.query<{role:string;status:string;revision:string}>(`UPDATE workspace_memberships SET role=$3,status=$4,revision=revision+1,updated_at=now()
      WHERE workspace_id=$1 AND principal_id=$2 RETURNING role,status,revision`,[raw.workspaceId,raw.targetPrincipalId,nextRole,nextStatus]);
    if(nextStatus!=='active')await client.query(`UPDATE project_memberships SET status=$3,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND principal_id=$2 AND status<>'removed'`,[raw.workspaceId,raw.targetPrincipalId,nextStatus==='removed'?'removed':'suspended']);
    const data={principalId:raw.targetPrincipalId,workspaceRole:updated.rows[0]!.role,status:updated.rows[0]!.status,revision:Number(updated.rows[0]!.revision)};
    return recordMutation(client,{workspaceId:raw.workspaceId,context,operation,digest,action:operation,targetType:"workspace_membership",targetId:raw.targetPrincipalId,aggregateType:"workspace_membership",aggregateRevision:data.revision,eventType:"workspace.membership_updated.v1",inputSummary:{changedFields:[raw.workspaceRole!==undefined?'workspaceRole':null,raw.status!==undefined?'status':null].filter(Boolean)},resultSummary:data,data});
  });
}
