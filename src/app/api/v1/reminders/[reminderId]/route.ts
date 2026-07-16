import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { cancelReminder } from "@/services/reminders";
import { mutationContext, reminderResponse, scheduleServiceError } from "../../schedule/response";

const schema = z.object({ workspace_id: z.string().uuid(), project_id: z.string().uuid(), action: z.literal("cancel") }).strict();
type RouteContext = { params: Promise<{ reminderId: string }> };
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: RouteContext) {
  const context = requestContext(request); const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response; const key = request.headers.get("idempotency-key")?.trim();
  if (!key) return jsonError("VALIDATION_FAILED", context, 400);
  try {
    const { reminderId } = await params; const id = z.string().uuid().parse(reminderId); const input = schema.parse(await request.json());
    const result = await cancelReminder({ workspaceId: input.workspace_id, projectId: input.project_id, reminderId: id },
      mutationContext(authenticated.session.principalId, context, key));
    return jsonSuccess({ reminder: reminderResponse(result.data), replayed: result.replayed }, context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400);
    if (error instanceof FoundationServiceError) return scheduleServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
