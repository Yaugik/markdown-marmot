import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { archiveCalendar, restoreCalendar, updateCalendar } from "@/services/calendars";
import { calendarResponse, mutationContext, scheduleServiceError } from "../../schedule/response";

const updateSchema = z.object({ workspace_id: z.string().uuid(), project_id: z.string().uuid(),
  expected_revision: z.number().int().positive(), name: z.string().trim().min(1).max(120).optional(),
  visibility: z.enum(["private", "project"]).optional(), time_zone: z.string().trim().min(1).max(120).optional() }).strict();
const commandSchema = z.object({ workspace_id: z.string().uuid(), project_id: z.string().uuid(),
  expected_revision: z.number().int().positive(), action: z.enum(["archive", "restore"]) }).strict();
type RouteContext = { params: Promise<{ calendarId: string }> };
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: RouteContext) {
  const context = requestContext(request); const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response; const key = request.headers.get("idempotency-key")?.trim();
  if (!key) return jsonError("VALIDATION_FAILED", context, 400);
  try {
    const { calendarId } = await params; const id = z.string().uuid().parse(calendarId); const input = updateSchema.parse(await request.json());
    const result = await updateCalendar({ workspaceId: input.workspace_id, projectId: input.project_id, calendarId: id,
      expectedRevision: input.expected_revision, name: input.name, visibility: input.visibility, timeZone: input.time_zone },
      mutationContext(authenticated.session.principalId, context, key));
    return jsonSuccess({ calendar: calendarResponse(result.data), replayed: result.replayed }, context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400);
    if (error instanceof FoundationServiceError) return scheduleServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}

export async function POST(request: Request, { params }: RouteContext) {
  const context = requestContext(request); const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response; const key = request.headers.get("idempotency-key")?.trim();
  if (!key) return jsonError("VALIDATION_FAILED", context, 400);
  try {
    const { calendarId } = await params; const id = z.string().uuid().parse(calendarId); const input = commandSchema.parse(await request.json());
    const command = { workspaceId: input.workspace_id, projectId: input.project_id, calendarId: id, expectedRevision: input.expected_revision };
    const mutation = mutationContext(authenticated.session.principalId, context, key);
    const result = input.action === "archive" ? await archiveCalendar(command, mutation) : await restoreCalendar(command, mutation);
    return jsonSuccess({ calendar: calendarResponse(result.data), replayed: result.replayed }, context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400);
    if (error instanceof FoundationServiceError) return scheduleServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
