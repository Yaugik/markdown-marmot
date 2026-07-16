import { jsonError, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import type { GitPage } from "@/services/git-pages";
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

export function gitPageResponse(page: GitPage) {
  return {
    id: page.id,
    workspace_id: page.workspaceId,
    project_id: page.projectId,
    source_type: page.sourceType,
    title: page.title,
    status: page.status,
    revision: page.revision,
    git_source: {
      repository_link_id: page.repositoryLinkId,
      repository_full_name: page.repositoryFullName,
      selected_branch_id: page.selectedBranchId,
      branch_name: page.branchName,
      source_path: page.sourcePath,
      snapshot_id: page.snapshotId,
      snapshot_file_id: page.snapshotFileId,
      head_oid: page.headOid,
      blob_oid: page.blobOid,
      content_hash: page.contentHash,
    },
    markdown: page.markdown,
    rendered_html: page.renderedHtml,
    plain_text: page.plainText,
    tree_placements: [],
    created_at: page.createdAt,
    updated_at: page.updatedAt,
  };
}

export function projectPageResponse(page: NativePage | GitPage) {
  return page.sourceType === "git" ? gitPageResponse(page) : pageResponse(page);
}

function revisionDetail(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

export function pageServiceError(error: FoundationServiceError, context: ReturnType<typeof requestContext>) {
  const status = error.code === "NOT_FOUND" ? 404
    : error.code === "CAPABILITY_DENIED" ? 403
      : ["CONFLICT", "IDEMPOTENCY_CONFLICT", "REVISION_CONFLICT", "BASE_REF_CHANGED", "BLOB_CHANGED", "TARGET_REF_CHANGED", "PATH_POLICY_CHANGED"].includes(error.code) ? 409
        : error.code === "PROVIDER_RATE_LIMITED" ? 429
          : error.code === "PROVIDER_UNAVAILABLE" ? 503
            : 400;
  const details = error.code === "REVISION_CONFLICT" ? {
    expected_revision: revisionDetail(error.details.expectedRevision),
    current_revision: revisionDetail(error.details.currentRevision),
  } : Object.keys(error.details).length ? error.details : undefined;
  return jsonError(error.code, context, status, { details });
}
