import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { createWorkspaceInvitation, listWorkspaceInvitations } from "@/services/foundation";
import { workspaceAdminError, workspaceMutationContext } from "../../../workspace-admin/response";

const assignment = z.object({
  project_id: z.string().uuid(),
  role_template_key: z.string().trim().regex(/^[a-z][a-z0-9_]{1,39}$/),
}).strict();
const createSchema = z.object({
  email: z.string().email().max(320),
  project_assignments: z.array(assignment).max(100).optional(),
  expires_in_hours: z.number().int().min(1).max(168).optional(),
}).strict();

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ workspaceId: string }> }) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  try {
    const { workspaceId } = await params;
    const invitations = await listWorkspaceInvitations(z.string().uuid().parse(workspaceId), authenticated.session.principalId);
    return jsonSuccess(invitations.map((invitation) => ({
      id: invitation.id,
      workspace_id: invitation.workspaceId,
      email: invitation.email,
      status: invitation.status,
      project_assignments: invitation.projectAssignments.map((assignment) => ({
        project_id: assignment.projectId,
        role_template_key: assignment.roleTemplateKey,
      })),
      invited_by_principal_id: invitation.invitedByPrincipalId,
      accepted_by_principal_id: invitation.acceptedByPrincipalId,
      expires_at: invitation.expiresAt,
      accepted_at: invitation.acceptedAt,
      revision: invitation.revision,
    })), context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400);
    return workspaceAdminError(error, context);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ workspaceId: string }> }) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey) return jsonError("VALIDATION_FAILED", context, 400);
  try {
    const { workspaceId } = await params;
    const input = createSchema.parse(await request.json());
    const result = await createWorkspaceInvitation({
      workspaceId: z.string().uuid().parse(workspaceId),
      email: input.email,
      projectAssignments: input.project_assignments?.map((assignment) => ({
        projectId: assignment.project_id,
        roleTemplateKey: assignment.role_template_key,
      })),
      expiresInHours: input.expires_in_hours,
    }, workspaceMutationContext(authenticated.session.principalId, context, idempotencyKey));
    return jsonSuccess({
      invitation: result.data.invitation,
      token: result.data.token,
      activity_id: result.activityId,
      outbox_event_id: result.outboxEventId,
      replayed: result.replayed,
    }, context, result.replayed ? 200 : 201);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400);
    return workspaceAdminError(error, context);
  }
}
