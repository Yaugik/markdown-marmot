import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { createTodo, listTodos } from "@/services/todos";
import { mutationContext, scheduleServiceError, todoResponse } from "../schedule/response";

const scopeSchema = z.object({
  workspace_id: z.string().uuid(), project_id: z.string().uuid(), list_id: z.string().uuid(),
}).strict();
const documentSchema = z.object({ type: z.literal("doc") }).passthrough();
const createSchema = scopeSchema.extend({
  parent_todo_id: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(1).max(240), body: documentSchema.optional(),
  assignee_principal_id: z.string().uuid().nullable().optional(),
  starts_at: z.string().max(100).nullable().optional(), due_at: z.string().max(100).nullable().optional(),
  time_zone: z.string().trim().min(1).max(120).optional(), rank: z.number().int().nonnegative().optional(),
}).strict();
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  try {
    const url = new URL(request.url);
    const scope = scopeSchema.parse({
      workspace_id: url.searchParams.get("workspace_id"),
      project_id: url.searchParams.get("project_id"),
      list_id: url.searchParams.get("list_id"),
    });
    const status = url.searchParams.get("status");
    const todos = await listTodos({
      workspaceId: scope.workspace_id, projectId: scope.project_id, listId: scope.list_id,
      includeArchived: url.searchParams.get("include_archived") === "true",
      status: status ? z.enum(["open", "completed", "canceled"]).parse(status) : undefined,
    }, authenticated.session.principalId);
    return jsonSuccess(todos.map(todoResponse), context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400);
    if (error instanceof FoundationServiceError) return scheduleServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}

export async function POST(request: Request) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key) return jsonError("VALIDATION_FAILED", context, 400);
  try {
    const input = createSchema.parse(await request.json());
    const result = await createTodo({
      workspaceId: input.workspace_id, projectId: input.project_id, listId: input.list_id,
      parentTodoId: input.parent_todo_id, title: input.title, body: input.body,
      assigneePrincipalId: input.assignee_principal_id, startsAt: input.starts_at,
      dueAt: input.due_at, timeZone: input.time_zone, rank: input.rank,
    }, mutationContext(authenticated.session.principalId, context, key));
    return jsonSuccess({ todo: todoResponse(result.data), replayed: result.replayed }, context,
      result.replayed ? 200 : 201);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400);
    if (error instanceof FoundationServiceError) return scheduleServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
