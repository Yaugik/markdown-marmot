import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { createCalendarExternalBinding } from "@/services/calendar-providers";
import { mutationContext, scheduleServiceError } from "../../schedule/response";

const schema = z.object({ workspace_id: z.string().uuid(), project_id: z.string().uuid(),
  calendar_id: z.string().uuid(), connection_id: z.string().uuid(),
  external_calendar_id: z.string().trim().min(1).max(500), direction: z.enum(["pull", "push", "two_way"]).optional(),
  conflict_policy: z.enum(["manual", "provider_wins", "folio_wins"]).optional() }).strict();
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const context = requestContext(request); const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response; const key = request.headers.get("idempotency-key")?.trim();
  if (!key) return jsonError("VALIDATION_FAILED", context, 400);
  try {
    const input = schema.parse(await request.json()); const result = await createCalendarExternalBinding({
      workspaceId: input.workspace_id, projectId: input.project_id, calendarId: input.calendar_id,
      connectionId: input.connection_id, externalCalendarId: input.external_calendar_id,
      direction: input.direction, conflictPolicy: input.conflict_policy },
      mutationContext(authenticated.session.principalId, context, key));
    return jsonSuccess({ binding: { id: result.data.id, calendar_id: result.data.calendarId,
      connection_id: result.data.connectionId, external_calendar_id: result.data.externalCalendarId,
      direction: result.data.direction, conflict_policy: result.data.conflictPolicy,
      state: result.data.state, revision: result.data.revision }, replayed: result.replayed }, context,
      result.replayed ? 200 : 201);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400);
    if (error instanceof FoundationServiceError) return scheduleServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
