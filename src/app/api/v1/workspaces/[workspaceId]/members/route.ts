import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { listWorkspaceMembers, updateWorkspaceMember } from "@/services/foundation";
import { workspaceAdminError, workspaceMutationContext } from "../../../workspace-admin/response";

const patchSchema = z.object({
  target_principal_id: z.string().uuid(),
  expected_revision: z.number().int().positive(),
  workspace_role: z.enum(["owner","member"]).optional(),
  status: z.enum(["active","suspended","removed"]).optional(),
}).strict().refine((value) => value.workspace_role !== undefined || value.status !== undefined, {
  message: "At least one membership field must change.",
});

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ workspaceId: string }> }) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  try {
    const { workspaceId } = await params;
    const members = await listWorkspaceMembers(z.string().uuid().parse(workspaceId), authenticated.session.principalId);
    return jsonSuccess(members.map((member) => ({
      principal_id: member.principalId,
      display_name: member.displayName,
      email: member.email,
      workspace_role: member.workspaceRole,
      workspace_status: member.workspaceStatus,
      revision: member.revision,
      projects: member.projects.map((project) => ({
        project_id: project.projectId,
        project_key: project.projectKey,
        role_template_key: project.roleTemplateKey,
        status: project.status,
      })),
    })), context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400);
    return workspaceAdminError(error, context);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ workspaceId: string }> }) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey) return jsonError("VALIDATION_FAILED", context, 400);
  try {
    const { workspaceId } = await params;
    const input = patchSchema.parse(await request.json());
    const result = await updateWorkspaceMember({
      workspaceId: z.string().uuid().parse(workspaceId),
      targetPrincipalId: input.target_principal_id,
      expectedRevision: input.expected_revision,
      workspaceRole: input.workspace_role,
      status: input.status,
    }, workspaceMutationContext(authenticated.session.principalId, context, idempotencyKey));
    return jsonSuccess({ member: result.data, activity_id: result.activityId, outbox_event_id: result.outboxEventId, replayed: result.replayed }, context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400);
    return workspaceAdminError(error, context);
  }
}
