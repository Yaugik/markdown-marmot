import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { ensureTodoOccurrences, readTodoRecurrence, setTodoRecurrence } from "@/services/todo-recurrence";
import { mutationContext, scheduleServiceError } from "../../../schedule/response";

const scopeSchema = z.object({ workspace_id: z.string().uuid(), project_id: z.string().uuid() }).strict();
const setSchema = scopeSchema.extend({
  expected_todo_revision: z.number().int().positive(),
  frequency: z.enum(["daily", "weekly", "monthly"]), interval_count: z.number().int().min(1).max(365).optional(),
  by_weekday: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  by_month_day: z.number().int().min(1).max(31).nullable().optional(),
  local_time: z.string().min(4).max(8), time_zone: z.string().trim().min(1).max(120),
  starts_on: z.string().date(), ends_on: z.string().date().nullable().optional(),
  count_limit: z.number().int().min(1).max(10000).nullable().optional(),
}).strict();
type RouteContext = { params: Promise<{ todoId: string }> };
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: RouteContext) {
  const context = requestContext(request); const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  try {
    const { todoId } = await params; const id = z.string().uuid().parse(todoId); const url = new URL(request.url);
    const scope = scopeSchema.parse({ workspace_id: url.searchParams.get("workspace_id"), project_id: url.searchParams.get("project_id") });
    const rule = await readTodoRecurrence({ workspaceId: scope.workspace_id, projectId: scope.project_id, todoId: id }, authenticated.session.principalId);
    const from = url.searchParams.get("from"); const to = url.searchParams.get("to");
    const occurrences = from && to ? await ensureTodoOccurrences({ workspaceId: scope.workspace_id, projectId: scope.project_id, todoId: id,
      windowStart: z.string().date().parse(from), windowEnd: z.string().date().parse(to), limit: 500 }, authenticated.session.principalId) : [];
    return jsonSuccess({ rule, occurrences: occurrences.map((item) => ({ id: item.id, occurrence_key: item.occurrenceKey,
      scheduled_for: item.scheduledFor, state: item.state, materialized_todo_id: item.materializedTodoId })) }, context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400);
    if (error instanceof FoundationServiceError) return scheduleServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}

export async function PUT(request: Request, { params }: RouteContext) {
  const context = requestContext(request); const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response; const key = request.headers.get("idempotency-key")?.trim();
  if (!key) return jsonError("VALIDATION_FAILED", context, 400);
  try {
    const { todoId } = await params; const id = z.string().uuid().parse(todoId); const input = setSchema.parse(await request.json());
    const result = await setTodoRecurrence({ workspaceId: input.workspace_id, projectId: input.project_id, todoId: id,
      expectedTodoRevision: input.expected_todo_revision, frequency: input.frequency, intervalCount: input.interval_count,
      byWeekday: input.by_weekday, byMonthDay: input.by_month_day, localTime: input.local_time,
      timeZone: input.time_zone, startsOn: input.starts_on, endsOn: input.ends_on, countLimit: input.count_limit },
      mutationContext(authenticated.session.principalId, context, key));
    return jsonSuccess({ recurrence: result.data, replayed: result.replayed }, context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400);
    if (error instanceof FoundationServiceError) return scheduleServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
