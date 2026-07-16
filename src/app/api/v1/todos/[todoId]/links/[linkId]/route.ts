import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { removeTodoLink } from "@/services/todo-links";
import { mutationContext, scheduleServiceError } from "../../../../schedule/response";

const schema = z.object({ workspace_id: z.string().uuid(), project_id: z.string().uuid(),
  expected_todo_revision: z.number().int().positive() }).strict();
type RouteContext = { params: Promise<{ todoId: string; linkId: string }> };
export const dynamic = "force-dynamic";

export async function DELETE(request: Request, { params }: RouteContext) {
  const context = requestContext(request); const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response; const key = request.headers.get("idempotency-key")?.trim();
  if (!key) return jsonError("VALIDATION_FAILED", context, 400);
  try {
    const params = await params; const todoId = z.string().uuid().parse(params.todoId); const linkId = z.string().uuid().parse(params.linkId);
    const input = schema.parse(await request.json());
    const result = await removeTodoLink({ workspaceId: input.workspace_id, projectId: input.project_id,
      todoId, linkId, expectedTodoRevision: input.expected_todo_revision },
      mutationContext(authenticated.session.principalId, context, key));
    return jsonSuccess({ link: result.data, replayed: result.replayed }, context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400);
    if (error instanceof FoundationServiceError) return scheduleServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
