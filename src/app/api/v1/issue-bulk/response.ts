import type { IssueBulkPreview } from "@/services/issue-bulk";

export function bulkPreviewResponse(preview: IssueBulkPreview) {
  return {
    id: preview.id,
    workspace_id: preview.workspaceId,
    project_id: preview.projectId,
    operation: preview.operation,
    issue_ids: preview.issueIds,
    request: preview.request,
    impact: {
      target_count: preview.impact.targetCount,
      accessible_count: preview.impact.accessibleCount,
      unavailable_count: preview.impact.unavailableCount,
      blocked_count: preview.impact.blockedCount,
      snapshots: preview.impact.snapshots.map((snapshot) => ({ issue_id: snapshot.issueId, revision: snapshot.revision, status_id: snapshot.statusId, workflow_id: snapshot.workflowId, lifecycle: snapshot.lifecycle })),
      warnings: preview.impact.warnings,
    },
    action_digest: preview.actionDigest,
    risk_level: preview.riskLevel,
    state: preview.state,
    confirmation_id: preview.confirmationId,
    result: preview.result ? {
      succeeded: preview.result.succeeded.map((item) => ({ issue_id: item.issueId, revision: item.revision })),
      failed: preview.result.failed.map((item) => ({ issue_id: item.issueId, code: item.code, message: item.message, current_revision: item.currentRevision })),
    } : null,
    revision: preview.revision,
    created_at: preview.createdAt,
    expires_at: preview.expiresAt,
    executed_at: preview.executedAt,
  };
}
