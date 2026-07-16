import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { createCalendar, listCalendars } from "@/services/calendars";
import { calendarResponse, mutationContext, scheduleServiceError } from "../schedule/response";

const scopeSchema = z.object({ workspace_id: z.string().uuid(), project_id: z.string().uuid() }).strict();
const createSchema = scopeSchema.extend({ name: z.string().trim().min(1).max(120),
  visibility: z.enum(["private", "project"]).optional(), time_zone: z.string().trim().min(1).max(120).optional() }).strict();
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = requestContext(request); const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  try {
    const url = new URL(request.url); const scope = scopeSchema.parse({ workspace_id: url.searchParams.get("workspace_id"), project_id: url.searchParams.get("project_id") });
    const calendars = await listCalendars({ workspaceId: scope.workspace_id, projectId: scope.project_id,
      includeArchived: url.searchParams.get("include_archived") === "true" }, authenticated.session.principalId);
    return jsonSuccess(calendars.map(calendarResponse), context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400);
    if (error instanceof FoundationServiceError) return scheduleServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}

export async function POST(request: Request) {
  const context = requestContext(request); const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response; const key = request.headers.get("idempotency-key")?.trim();
  if (!key) return jsonError("VALIDATION_FAILED", context, 400);
  try {
    const input = createSchema.parse(await request.json()); const result = await createCalendar({ workspaceId: input.workspace_id,
      projectId: input.project_id, name: input.name, visibility: input.visibility, timeZone: input.time_zone },
      mutationContext(authenticated.session.principalId, context, key));
    return jsonSuccess({ calendar: calendarResponse(result.data), replayed: result.replayed }, context, result.replayed ? 200 : 201);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400);
    if (error instanceof FoundationServiceError) return scheduleServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
