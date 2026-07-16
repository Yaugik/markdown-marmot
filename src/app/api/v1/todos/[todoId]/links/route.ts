import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { addTodoLink, listTodoLinks } from "@/services/todo-links";
import { mutationContext, scheduleServiceError } from "../../../schedule/response";

const scopeSchema = z.object({ workspace_id: z.string().uuid(), project_id: z.string().uuid() }).strict();
const createSchema = scopeSchema.extend({
  expected_todo_revision: z.number().int().positive(), link_kind: z.enum(["issue", "page"]),
  target_id: z.string().uuid(), label: z.string().trim().min(1).max(240).nullable().optional(),
}).strict();
type RouteContext = { params: Promise<{ todoId: string }> };
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: RouteContext) {
  const context = requestContext(request); const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  try {
    const { todoId } = await params; const id = z.string().uuid().parse(todoId); const url = new URL(request.url);
    const scope = scopeSchema.parse({ workspace_id: url.searchParams.get("workspace_id"), project_id: url.searchParams.get("project_id") });
    const links = await listTodoLinks({ workspaceId: scope.workspace_id, projectId: scope.project_id, todoId: id }, authenticated.session.principalId);
    return jsonSuccess(links.map((item) => ({ id: item.id, todo_id: item.todoId, link_kind: item.linkKind,
      target_issue_id: item.targetIssueId, target_page_id: item.targetPageId, label: item.label,
      revision: item.revision, created_at: item.createdAt })), context);
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
    const { todoId } = await params; const id = z.string().uuid().parse(todoId); const input = createSchema.parse(await request.json());
    const result = await addTodoLink({ workspaceId: input.workspace_id, projectId: input.project_id, todoId: id,
      expectedTodoRevision: input.expected_todo_revision, linkKind: input.link_kind, targetId: input.target_id,
      label: input.label }, mutationContext(authenticated.session.principalId, context, key));
    return jsonSuccess({ link: result.data, replayed: result.replayed }, context, result.replayed ? 200 : 201);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400);
    if (error instanceof FoundationServiceError) return scheduleServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
