import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { calendarView } from "@/services/calendars";
import { scheduleServiceError } from "../schedule/response";

const schema = z.object({ workspace_id: z.string().uuid(), project_id: z.string().uuid(),
  from: z.string().min(1).max(100), to: z.string().min(1).max(100),
  include_todos: z.boolean().optional(), include_issues: z.boolean().optional() }).strict();
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const context = requestContext(request); const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  try {
    const input = schema.parse(await request.json());
    const items = await calendarView({ workspaceId: input.workspace_id, projectId: input.project_id,
      from: input.from, to: input.to, includeTodos: input.include_todos, includeIssues: input.include_issues },
      authenticated.session.principalId);
    return jsonSuccess(items.map((item) => ({ id: item.id, source: item.source, source_id: item.sourceId,
      calendar_id: item.calendarId, title: item.title, starts_at: item.startsAt, ends_at: item.endsAt,
      all_day: item.allDay, time_zone: item.timeZone })), context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400);
    if (error instanceof FoundationServiceError) return scheduleServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
