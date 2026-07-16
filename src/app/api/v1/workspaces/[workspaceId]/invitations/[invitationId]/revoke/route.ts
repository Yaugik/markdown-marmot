import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { revokeWorkspaceInvitation } from "@/services/foundation";
import { workspaceAdminError, workspaceMutationContext } from "../../../../../workspace-admin/response";

const schema = z.object({ expected_revision: z.number().int().positive() }).strict();
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ workspaceId: string; invitationId: string }> }) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey) return jsonError("VALIDATION_FAILED", context, 400);
  try {
    const { workspaceId, invitationId } = await params;
    const input = schema.parse(await request.json());
    const result = await revokeWorkspaceInvitation({
      workspaceId: z.string().uuid().parse(workspaceId),
      invitationId: z.string().uuid().parse(invitationId),
      expectedRevision: input.expected_revision,
    }, workspaceMutationContext(authenticated.session.principalId, context, idempotencyKey));
    return jsonSuccess({ invitation: result.data, activity_id: result.activityId, outbox_event_id: result.outboxEventId, replayed: result.replayed }, context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400);
    return workspaceAdminError(error, context);
  }
}
