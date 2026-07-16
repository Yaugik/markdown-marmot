import { jsonError, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import type { NativePage } from "@/services/pages";

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
