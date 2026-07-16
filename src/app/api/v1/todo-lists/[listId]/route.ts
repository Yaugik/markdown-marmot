import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { archiveTodoList, restoreTodoList, updateTodoList } from "@/services/todo-lists";
import { listResponse, mutationContext, scheduleServiceError } from "../../schedule/response";

const updateSchema = z.object({
  workspace_id: z.string().uuid(), project_id: z.string().uuid(),
  expected_revision: z.number().int().positive(),
  name: z.string().trim().min(1).max(120).optional(),
  visibility: z.enum(["private", "project"]).optional(),
}).strict();
const lifecycleSchema = z.object({
  workspace_id: z.string().uuid(), project_id: z.string().uuid(),
  expected_revision: z.number().int().positive(), action: z.enum(["archive", "restore"]),
}).strict();
type RouteContext = { params: Promise<{ listId: string }> };
export const dynamic = "force-dynamic";

async function auth(request: Request) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  return { context, authenticated, key: request.headers.get("idempotency-key")?.trim() };
}

export async function PATCH(request: Request, { params }: RouteContext) {
  const { context, authenticated, key } = await auth(request);
  if (!authenticated.ok) return authenticated.response;
  if (!key) return jsonError("VALIDATION_FAILED", context, 400);
  try {
    const { listId } = await params;
    const id = z.string().uuid().parse(listId);
    const input = updateSchema.parse(await request.json());
    const result = await updateTodoList({
      workspaceId: input.workspace_id, projectId: input.project_id, listId: id,
      expectedRevision: input.expected_revision, name: input.name, visibility: input.visibility,
    }, mutationContext(authenticated.session.principalId, context, key));
    return jsonSuccess({ list: listResponse(result.data), replayed: result.replayed }, context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400);
    if (error instanceof FoundationServiceError) return scheduleServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}

export async function POST(request: Request, { params }: RouteContext) {
  const { context, authenticated, key } = await auth(request);
  if (!authenticated.ok) return authenticated.response;
  if (!key) return jsonError("VALIDATION_FAILED", context, 400);
  try {
    const { listId } = await params;
    const id = z.string().uuid().parse(listId);
    const input = lifecycleSchema.parse(await request.json());
    const command = { workspaceId: input.workspace_id, projectId: input.project_id,
      listId: id, expectedRevision: input.expected_revision };
    const result = input.action === "archive"
      ? await archiveTodoList(command, mutationContext(authenticated.session.principalId, context, key))
      : await restoreTodoList(command, mutationContext(authenticated.session.principalId, context, key));
    return jsonSuccess({ list: listResponse(result.data), replayed: result.replayed }, context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400);
    if (error instanceof FoundationServiceError) return scheduleServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
