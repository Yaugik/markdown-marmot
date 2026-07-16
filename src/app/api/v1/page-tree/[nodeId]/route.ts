import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { movePageTreeNode } from "@/services/page-tree";

const schema = z.object({
  workspace_id: z.string().uuid(), project_id: z.string().uuid(),
  expected_revision: z.number().int().positive(),
  parent_node_id: z.string().uuid().nullable().optional(),
  rank: z.number().int().nonnegative().optional(),
  display_title: z.string().trim().min(1).max(200).nullable().optional(),
}).strict();
type RouteContext = { params: Promise<{ nodeId: string }> };
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: RouteContext) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey) return jsonError("VALIDATION_FAILED", context, 400, { fieldErrors: [{ field: "Idempotency-Key", code: "required", message: "Required" }] });
  try {
    const { nodeId } = await params;
    const validatedNodeId = z.string().uuid().parse(nodeId);
    const input = schema.parse(await request.json());
    const result = await movePageTreeNode({ workspaceId: input.workspace_id, projectId: input.project_id, nodeId: validatedNodeId, expectedRevision: input.expected_revision, parentNodeId: input.parent_node_id, rank: input.rank, displayTitle: input.display_title }, { actorPrincipalId: authenticated.session.principalId, requestId: context.requestId, traceId: context.traceId, idempotencyKey, source: "api" });
    return jsonSuccess({ node: { id: result.data.id, workspace_id: result.data.workspaceId, project_id: result.data.projectId, parent_node_id: result.data.parentNodeId, node_kind: result.data.nodeKind, page_id: result.data.pageId, rank: result.data.rank, display_title: result.data.displayTitle, revision: result.data.revision, created_at: result.data.createdAt, updated_at: result.data.updatedAt }, activity_id: result.activityId, outbox_event_id: result.outboxEventId, replayed: result.replayed }, context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400, { fieldErrors: error.issues.map((issue) => ({ field: issue.path.join("."), code: issue.code, message: issue.message })) });
    if (error instanceof FoundationServiceError) return jsonError(error.code, context, error.code === "CAPABILITY_DENIED" ? 403 : error.code === "NOT_FOUND" ? 404 : ["CONFLICT", "IDEMPOTENCY_CONFLICT", "REVISION_CONFLICT"].includes(error.code) ? 409 : 400, error.code === "REVISION_CONFLICT" ? { details: { expected_revision: Number(error.details.expectedRevision), current_revision: Number(error.details.currentRevision) } } : undefined);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
