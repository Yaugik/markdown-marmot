import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { createNativePage, listNativePages, type NativePage } from "@/services/pages";

const scopeSchema = z.object({ workspace_id: z.string().uuid(), project_id: z.string().uuid() }).strict();
const createSchema = scopeSchema.extend({
  title: z.string().trim().min(1).max(200),
  content: z.object({ type: z.literal("doc") }).passthrough(),
  parent_node_id: z.string().uuid().nullable().optional(),
  display_title: z.string().trim().min(1).max(200).nullable().optional(),
}).strict();

export const dynamic = "force-dynamic";

export function pageResponse(page: NativePage) {
  return {
    id: page.id,
    workspace_id: page.workspaceId,
    project_id: page.projectId,
    source_type: page.sourceType,
    title: page.title,
    status: page.status,
    revision: page.revision,
    current_revision: {
      id: page.currentRevision.id,
      sequence: page.currentRevision.sequence,
      editor_schema_version: page.currentRevision.editorSchemaVersion,
      content: page.currentRevision.content,
      plain_text: page.currentRevision.plainText,
      content_hash: page.currentRevision.contentHash,
      author_principal_id: page.currentRevision.authorPrincipalId,
      parent_revision_id: page.currentRevision.parentRevisionId,
      created_at: page.currentRevision.createdAt,
    },
    tree_placements: page.treePlacements.map((placement) => ({
      id: placement.id,
      parent_node_id: placement.parentNodeId,
      node_kind: placement.nodeKind,
      rank: placement.rank,
      display_title: placement.displayTitle,
      revision: placement.revision,
    })),
    created_at: page.createdAt,
    updated_at: page.updatedAt,
  };
}

export function pageServiceError(error: FoundationServiceError, context: ReturnType<typeof requestContext>) {
  const status = error.code === "NOT_FOUND" ? 404
    : error.code === "CAPABILITY_DENIED" ? 403
      : ["CONFLICT", "IDEMPOTENCY_CONFLICT", "REVISION_CONFLICT"].includes(error.code) ? 409
        : 400;
  const details = error.code === "REVISION_CONFLICT" ? {
    expected_revision: Number(error.details.expectedRevision),
    current_revision: Number(error.details.currentRevision),
  } : undefined;
  return jsonError(error.code, context, status, { details });
}

export async function GET(request: Request) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  try {
    const url = new URL(request.url);
    const scope = scopeSchema.parse({
      workspace_id: url.searchParams.get("workspace_id"),
      project_id: url.searchParams.get("project_id"),
    });
    const pages = await listNativePages({ workspaceId: scope.workspace_id, projectId: scope.project_id }, authenticated.session.principalId);
    return jsonSuccess(pages.map(pageResponse), context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400, { fieldErrors: error.issues.map((issue) => ({ field: issue.path.join("."), code: issue.code, message: issue.message })) });
    if (error instanceof FoundationServiceError) return pageServiceError(error, context);
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
    const result = await createNativePage({ workspaceId: input.workspace_id, projectId: input.project_id, title: input.title, content: input.content, parentNodeId: input.parent_node_id, displayTitle: input.display_title }, { actorPrincipalId: authenticated.session.principalId, requestId: context.requestId, traceId: context.traceId, idempotencyKey, source: "api" });
    return jsonSuccess({ page: pageResponse(result.data), activity_id: result.activityId, outbox_event_id: result.outboxEventId, replayed: result.replayed }, context, result.replayed ? 200 : 201);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400, { fieldErrors: error.issues.map((issue) => ({ field: issue.path.join("."), code: issue.code, message: issue.message })) });
    if (error instanceof FoundationServiceError) return pageServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
