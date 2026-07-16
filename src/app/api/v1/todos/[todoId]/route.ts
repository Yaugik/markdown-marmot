import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { archiveTodo, changeTodoStatus, readTodo, restoreTodo, updateTodo } from "@/services/todos";
import { mutationContext, scheduleServiceError, todoResponse } from "../../schedule/response";

const scopeSchema = z.object({ workspace_id: z.string().uuid(), project_id: z.string().uuid() }).strict();
const documentSchema = z.object({ type: z.literal("doc") }).passthrough();
const updateSchema = scopeSchema.extend({
  expected_revision: z.number().int().positive(), parent_todo_id: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(1).max(240).optional(), body: documentSchema.optional(),
  assignee_principal_id: z.string().uuid().nullable().optional(), starts_at: z.string().max(100).nullable().optional(),
  due_at: z.string().max(100).nullable().optional(), time_zone: z.string().trim().min(1).max(120).optional(),
  rank: z.number().int().nonnegative().optional(),
}).strict();
const commandSchema = scopeSchema.extend({
  expected_revision: z.number().int().positive(),
  action: z.enum(["complete", "cancel", "reopen", "archive", "restore"]),
}).strict();
type RouteContext = { params: Promise<{ todoId: string }> };
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: RouteContext) {
  const context = requestContext(request); const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  try {
    const { todoId } = await params; const id = z.string().uuid().parse(todoId);
    const url = new URL(request.url); const scope = scopeSchema.parse({ workspace_id: url.searchParams.get("workspace_id"), project_id: url.searchParams.get("project_id") });
    return jsonSuccess(todoResponse(await readTodo({ workspaceId: scope.workspace_id, projectId: scope.project_id, todoId: id }, authenticated.session.principalId)), context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400);
    if (error instanceof FoundationServiceError) return scheduleServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}

export async function PATCH(request: Request, { params }: RouteContext) {
  const context = requestContext(request); const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response; const key = request.headers.get("idempotency-key")?.trim();
  if (!key) return jsonError("VALIDATION_FAILED", context, 400);
  try {
    const { todoId } = await params; const id = z.string().uuid().parse(todoId); const input = updateSchema.parse(await request.json());
    const result = await updateTodo({ workspaceId: input.workspace_id, projectId: input.project_id, todoId: id,
      expectedRevision: input.expected_revision, parentTodoId: input.parent_todo_id, title: input.title,
      body: input.body, assigneePrincipalId: input.assignee_principal_id, startsAt: input.starts_at,
      dueAt: input.due_at, timeZone: input.time_zone, rank: input.rank },
      mutationContext(authenticated.session.principalId, context, key));
    return jsonSuccess({ todo: todoResponse(result.data), replayed: result.replayed }, context);
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
    const { todoId } = await params; const id = z.string().uuid().parse(todoId); const input = commandSchema.parse(await request.json());
    const command = { workspaceId: input.workspace_id, projectId: input.project_id, todoId: id, expectedRevision: input.expected_revision };
    const mutation = mutationContext(authenticated.session.principalId, context, key);
    const result = input.action === "archive" ? await archiveTodo(command, mutation)
      : input.action === "restore" ? await restoreTodo(command, mutation)
        : await changeTodoStatus({ ...command, status: input.action === "complete" ? "completed" : input.action === "cancel" ? "canceled" : "open" }, mutation);
    return jsonSuccess({ todo: todoResponse(result.data), replayed: result.replayed }, context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400);
    if (error instanceof FoundationServiceError) return scheduleServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
