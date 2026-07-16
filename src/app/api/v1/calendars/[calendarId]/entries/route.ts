import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { createAuthorizedCalendarEntry } from "@/services/calendar-entry-commands";
import { listCalendarEntries } from "@/services/calendars";
import { entryResponse, mutationContext, scheduleServiceError } from "../../../schedule/response";

const scopeSchema = z.object({ workspace_id: z.string().uuid(), project_id: z.string().uuid() }).strict();
const documentSchema = z.object({ type: z.literal("doc") }).passthrough();
const createSchema = scopeSchema.extend({ source_kind: z.enum(["manual", "todo", "issue"]).optional(),
  todo_id: z.string().uuid().nullable().optional(), issue_id: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(1).max(240), body: documentSchema.optional(),
  starts_at: z.string().min(1).max(100), ends_at: z.string().min(1).max(100),
  all_day: z.boolean().optional(), time_zone: z.string().trim().min(1).max(120).optional() }).strict();
type RouteContext = { params: Promise<{ calendarId: string }> };
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: RouteContext) {
  const context = requestContext(request); const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  try {
    const { calendarId } = await params; const id = z.string().uuid().parse(calendarId); const url = new URL(request.url);
    const scope = scopeSchema.parse({ workspace_id: url.searchParams.get("workspace_id"), project_id: url.searchParams.get("project_id") });
    const entries = await listCalendarEntries({ workspaceId: scope.workspace_id, projectId: scope.project_id,
      calendarId: id, from: z.string().min(1).parse(url.searchParams.get("from")),
      to: z.string().min(1).parse(url.searchParams.get("to")), includeArchived: url.searchParams.get("include_archived") === "true" }, authenticated.session.principalId);
    return jsonSuccess(entries.map(entryResponse), context);
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
    const { calendarId } = await params; const id = z.string().uuid().parse(calendarId); const input = createSchema.parse(await request.json());
    const result = await createAuthorizedCalendarEntry({ workspaceId: input.workspace_id, projectId: input.project_id,
      calendarId: id, sourceKind: input.source_kind, todoId: input.todo_id, issueId: input.issue_id,
      title: input.title, body: input.body, startsAt: input.starts_at, endsAt: input.ends_at,
      allDay: input.all_day, timeZone: input.time_zone }, mutationContext(authenticated.session.principalId, context, key));
    return jsonSuccess({ entry: entryResponse(result.data), replayed: result.replayed }, context, result.replayed ? 200 : 201);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400);
    if (error instanceof FoundationServiceError) return scheduleServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
