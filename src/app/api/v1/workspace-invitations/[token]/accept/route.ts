import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { acceptWorkspaceInvitation } from "@/services/foundation";
import { workspaceAdminError, workspaceMutationContext } from "../../../workspace-admin/response";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey) return jsonError("VALIDATION_FAILED", context, 400);
  try {
    const { token } = await params;
    const result = await acceptWorkspaceInvitation({ token }, workspaceMutationContext(authenticated.session.principalId, context, idempotencyKey));
    return jsonSuccess({ acceptance: result.data, activity_id: result.activityId, outbox_event_id: result.outboxEventId, replayed: result.replayed }, context);
  } catch (error) {
    return workspaceAdminError(error, context);
  }
}
