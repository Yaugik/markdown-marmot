import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { createPageTreeAlias, createPageTreeFolder, listPageTree } from "@/services/page-tree";

const scopeSchema = z.object({ workspace_id: z.string().uuid(), project_id: z.string().uuid() }).strict();
const createSchema = z.discriminatedUnion("node_kind", [
  scopeSchema.extend({ node_kind: z.literal("folder"), parent_node_id: z.string().uuid().nullable().optional(), title: z.string().trim().min(1).max(200), rank: z.number().int().nonnegative().optional() }).strict(),
  scopeSchema.extend({ node_kind: z.literal("alias"), parent_node_id: z.string().uuid().nullable().optional(), page_id: z.string().uuid(), display_title: z.string().trim().min(1).max(200).optional(), rank: z.number().int().nonnegative().optional() }).strict(),
]);

const responseNode = (node: Awaited<ReturnType<typeof listPageTree>>[number]) => ({
  id: node.id, workspace_id: node.workspaceId, project_id: node.projectId,
  parent_node_id: node.parentNodeId, node_kind: node.nodeKind, page_id: node.pageId,
  rank: node.rank, display_title: node.displayTitle, revision: node.revision,
  created_at: node.createdAt, updated_at: node.updatedAt,
});

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  try {
    const url = new URL(request.url);
    const scope = scopeSchema.parse({ workspace_id: url.searchParams.get("workspace_id"), project_id: url.searchParams.get("project_id") });
    return jsonSuccess((await listPageTree({ workspaceId: scope.workspace_id, projectId: scope.project_id }, authenticated.session.principalId)).map(responseNode), context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400, { fieldErrors: error.issues.map((issue) => ({ field: issue.path.join("."), code: issue.code, message: issue.message })) });
    if (error instanceof FoundationServiceError) return jsonError(error.code, context, error.code === "CAPABILITY_DENIED" ? 403 : error.code === "NOT_FOUND" ? 404 : 400);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}

export async function POST(request: Request) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey) return jsonError("VALIDATION_FAILED", context, 400, { fieldErrors: [{ field: "Idempotency-Key", code: "required", message: "Required" }] });
  try {
    const input = createSchema.parse(await request.json());
    const mutationContext = { actorPrincipalId: authenticated.session.principalId, requestId: context.requestId, traceId: context.traceId, idempotencyKey, source: "api" as const };
    const result = input.node_kind === "folder"
      ? await createPageTreeFolder({ workspaceId: input.workspace_id, projectId: input.project_id, parentNodeId: input.parent_node_id, title: input.title, rank: input.rank }, mutationContext)
      : await createPageTreeAlias({ workspaceId: input.workspace_id, projectId: input.project_id, parentNodeId: input.parent_node_id, pageId: input.page_id, displayTitle: input.display_title, rank: input.rank }, mutationContext);
    return jsonSuccess({ node: responseNode(result.data), activity_id: result.activityId, outbox_event_id: result.outboxEventId, replayed: result.replayed }, context, result.replayed ? 200 : 201);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400, { fieldErrors: error.issues.map((issue) => ({ field: issue.path.join("."), code: issue.code, message: issue.message })) });
    if (error instanceof FoundationServiceError) return jsonError(error.code, context, error.code === "CAPABILITY_DENIED" ? 403 : error.code === "NOT_FOUND" ? 404 : ["CONFLICT", "IDEMPOTENCY_CONFLICT"].includes(error.code) ? 409 : 400);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
