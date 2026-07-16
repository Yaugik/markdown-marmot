import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { addIssueComment, listIssueComments } from "@/services/issue-relations";
import { issueServiceError, mutationContext } from "../../response";

const scopeSchema = z.object({ workspace_id: z.string().uuid(), project_id: z.string().uuid() }).strict();
const createSchema = scopeSchema.extend({ body: z.object({ type: z.literal("doc") }).passthrough() }).strict();
type RouteContext = { params: Promise<{ issueId: string }> };
export const dynamic = "force-dynamic";

const responseComment = (comment: Awaited<ReturnType<typeof listIssueComments>>[number]) => ({
  id: comment.id,
  issue_id: comment.issueId,
  body: comment.body,
  plain_text: comment.plainText,
  revision: comment.revision,
  author_principal_id: comment.authorPrincipalId,
  author_display_name: comment.authorDisplayName,
  created_at: comment.createdAt,
  updated_at: comment.updatedAt,
});

export async function GET(request: Request, { params }: RouteContext) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  try {
    const { issueId } = await params;
    const id = z.string().uuid().parse(issueId);
    const url = new URL(request.url);
    const scope = scopeSchema.parse({ workspace_id: url.searchParams.get("workspace_id"), project_id: url.searchParams.get("project_id") });
    const comments = await listIssueComments({ workspaceId: scope.workspace_id, projectId: scope.project_id, issueId: id }, authenticated.session.principalId);
    return jsonSuccess(comments.map(responseComment), context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400, { fieldErrors: error.issues.map((issue) => ({ field: issue.path.join("."), code: issue.code, message: issue.message })) });
    if (error instanceof FoundationServiceError) return issueServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}

export async function POST(request: Request, { params }: RouteContext) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey) return jsonError("VALIDATION_FAILED", context, 400, { fieldErrors: [{ field: "Idempotency-Key", code: "required", message: "Required" }] });
  try {
    const { issueId } = await params;
    const id = z.string().uuid().parse(issueId);
    const input = createSchema.parse(await request.json());
    const result = await addIssueComment({ workspaceId: input.workspace_id, projectId: input.project_id, issueId: id, body: input.body }, mutationContext(authenticated.session.principalId, context, idempotencyKey));
    return jsonSuccess({ comment: responseComment(result.data), activity_id: result.activityId, outbox_event_id: result.outboxEventId, replayed: result.replayed }, context, result.replayed ? 200 : 201);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400, { fieldErrors: error.issues.map((issue) => ({ field: issue.path.join("."), code: issue.code, message: issue.message })) });
    if (error instanceof FoundationServiceError) return issueServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
