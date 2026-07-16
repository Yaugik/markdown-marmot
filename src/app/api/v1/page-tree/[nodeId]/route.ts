import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { movePageTreeNode, setPageTreeNodeArchived } from "@/services/page-tree";
import { pageServiceError } from "../../pages/response";

const schema = z.object({
  workspace_id: z.string().uuid(),
  project_id: z.string().uuid(),
  expected_revision: z.number().int().positive(),
  action: z.enum(["move", "archive", "restore"]).default("move"),
  parent_node_id: z.string().uuid().nullable().optional(),
  rank: z.number().int().nonnegative().optional(),
  display_title: z.string().trim().min(1).max(200).nullable().optional(),
  recursive: z.boolean().optional(),
}).strict();
type RouteContext = { params: Promise<{ nodeId: string }> };
export const dynamic = "force-dynamic";

function responseNode(node: Awaited<ReturnType<typeof movePageTreeNode>>["data"]) {
  return {
    id: node.id,
    workspace_id: node.workspaceId,
    project_id: node.projectId,
    parent_node_id: node.parentNodeId,
    node_kind: node.nodeKind,
    page_id: node.pageId,
    rank: node.rank,
    display_title: node.displayTitle,
    revision: node.revision,
    created_at: node.createdAt,
    updated_at: node.updatedAt,
    archived_at: node.archivedAt,
  };
}

export async function PATCH(request: Request, { params }: RouteContext) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey) return jsonError("VALIDATION_FAILED", context, 400, {
    fieldErrors: [{ field: "Idempotency-Key", code: "required", message: "Required" }],
  });
  try {
    const { nodeId } = await params;
    const validatedNodeId = z.string().uuid().parse(nodeId);
    const input = schema.parse(await request.json());
    const mutationContext = {
      actorPrincipalId: authenticated.session.principalId,
      requestId: context.requestId,
      traceId: context.traceId,
      idempotencyKey,
      source: "api" as const,
    };
    const result = input.action === "move"
      ? await movePageTreeNode({
          workspaceId: input.workspace_id,
          projectId: input.project_id,
          nodeId: validatedNodeId,
          expectedRevision: input.expected_revision,
          parentNodeId: input.parent_node_id,
          rank: input.rank,
          displayTitle: input.display_title,
        }, mutationContext)
      : await setPageTreeNodeArchived({
          workspaceId: input.workspace_id,
          projectId: input.project_id,
          nodeId: validatedNodeId,
          expectedRevision: input.expected_revision,
          archived: input.action === "archive",
          recursive: input.recursive,
        }, mutationContext);
    return jsonSuccess({
      node: responseNode(result.data),
      activity_id: result.activityId,
      outbox_event_id: result.outboxEventId,
      replayed: result.replayed,
    }, context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400, {
      fieldErrors: error.issues.map((issue) => ({ field: issue.path.join("."), code: issue.code, message: issue.message })),
    });
    if (error instanceof FoundationServiceError) return pageServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
