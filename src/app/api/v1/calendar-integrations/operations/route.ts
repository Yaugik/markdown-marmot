import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { enqueueCalendarProviderOperation } from "@/services/calendar-providers";
import { mutationContext, scheduleServiceError } from "../../schedule/response";

const schema = z.object({ workspace_id: z.string().uuid(), project_id: z.string().uuid(),
  connection_id: z.string().uuid(), binding_id: z.string().uuid().nullable().optional(),
  operation: z.enum(["discover", "pull", "push", "reconcile", "revoke"]) }).strict();
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const context = requestContext(request); const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response; const key = request.headers.get("idempotency-key")?.trim();
  if (!key) return jsonError("VALIDATION_FAILED", context, 400);
  try {
    const input = schema.parse(await request.json()); const result = await enqueueCalendarProviderOperation({
      workspaceId: input.workspace_id, projectId: input.project_id, connectionId: input.connection_id,
      bindingId: input.binding_id, operation: input.operation },
      mutationContext(authenticated.session.principalId, context, key));
    return jsonSuccess({ operation_id: result.data.operationId, job_id: result.data.jobId,
      state: result.data.state, replayed: result.replayed }, context, result.replayed ? 200 : 202);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400);
    if (error instanceof FoundationServiceError) return scheduleServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
