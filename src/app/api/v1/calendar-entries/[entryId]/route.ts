import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { archiveCalendarEntry, restoreCalendarEntry } from "@/services/calendar-entry-commands";
import { updateCalendarEntry } from "@/services/calendars";
import { entryResponse, mutationContext, scheduleServiceError } from "../../schedule/response";

const documentSchema = z.object({ type: z.literal("doc") }).passthrough();
const updateSchema = z.object({ workspace_id: z.string().uuid(), project_id: z.string().uuid(),
  expected_revision: z.number().int().positive(), title: z.string().trim().min(1).max(240).optional(),
  body: documentSchema.optional(), starts_at: z.string().min(1).max(100).optional(),
  ends_at: z.string().min(1).max(100).optional(), all_day: z.boolean().optional(),
  time_zone: z.string().trim().min(1).max(120).optional() }).strict();
const commandSchema = z.object({ workspace_id: z.string().uuid(), project_id: z.string().uuid(),
  expected_revision: z.number().int().positive(), action: z.enum(["archive", "restore"]) }).strict();
type RouteContext = { params: Promise<{ entryId: string }> };
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: RouteContext) {
  const context = requestContext(request); const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response; const key = request.headers.get("idempotency-key")?.trim();
  if (!key) return jsonError("VALIDATION_FAILED", context, 400);
  try {
    const { entryId } = await params; const id = z.string().uuid().parse(entryId); const input = updateSchema.parse(await request.json());
    const result = await updateCalendarEntry({ workspaceId: input.workspace_id, projectId: input.project_id,
      entryId: id, expectedRevision: input.expected_revision, title: input.title, body: input.body,
      startsAt: input.starts_at, endsAt: input.ends_at, allDay: input.all_day, timeZone: input.time_zone },
      mutationContext(authenticated.session.principalId, context, key));
    return jsonSuccess({ entry: entryResponse(result.data), replayed: result.replayed }, context);
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
    const { entryId } = await params; const id = z.string().uuid().parse(entryId); const input = commandSchema.parse(await request.json());
    const command = { workspaceId: input.workspace_id, projectId: input.project_id, entryId: id, expectedRevision: input.expected_revision };
    const mutation = mutationContext(authenticated.session.principalId, context, key);
    const result = input.action === "archive" ? await archiveCalendarEntry(command, mutation) : await restoreCalendarEntry(command, mutation);
    return jsonSuccess({ entry: entryResponse(result.data), replayed: result.replayed }, context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400);
    if (error instanceof FoundationServiceError) return scheduleServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
