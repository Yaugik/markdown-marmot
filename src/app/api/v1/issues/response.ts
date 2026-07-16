import { jsonError, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import type { Issue } from "@/services/issues";

export function issueResponse(issue: Issue) {
  return {
    id: issue.id,
    workspace_id: issue.workspaceId,
    project_id: issue.projectId,
    issue_number: issue.issueNumber,
    identifier: issue.identifier,
    workflow_id: issue.workflowId,
    status: {
      id: issue.status.id,
      name: issue.status.name,
      category: issue.status.category,
      color_key: issue.status.colorKey,
    },
    parent_issue_id: issue.parentIssueId,
    milestone_id: issue.milestoneId,
    cycle_id: issue.cycleId,
    title: issue.title,
    description: issue.description,
    plain_text: issue.plainText,
    priority: issue.priority,
    estimate_points: issue.estimatePoints,
    start_on: issue.startOn,
    due_on: issue.dueOn,
    rank: issue.rank,
    lifecycle: issue.lifecycle,
    revision: issue.revision,
    assignees: issue.assignees.map((assignee) => ({
      principal_id: assignee.principalId,
      display_name: assignee.displayName,
      kind: assignee.kind,
      assignment_role: assignee.assignmentRole,
    })),
    labels: issue.labels.map((label) => ({ id: label.id, name: label.name, color_key: label.colorKey })),
    dependencies: issue.dependencies.map((dependency) => ({
      id: dependency.id,
      source_issue_id: dependency.sourceIssueId,
      target_issue_id: dependency.targetIssueId,
      relation_kind: dependency.relationKind,
    })),
    created_by_principal_id: issue.createdByPrincipalId,
    updated_by_principal_id: issue.updatedByPrincipalId,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    archived_at: issue.archivedAt,
  };
}

function revisionDetail(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

export function issueServiceError(error: FoundationServiceError, context: ReturnType<typeof requestContext>) {
  const status = error.code === "NOT_FOUND" ? 404
    : error.code === "CAPABILITY_DENIED" ? 403
      : ["CONFLICT", "IDEMPOTENCY_CONFLICT", "REVISION_CONFLICT"].includes(error.code) ? 409
        : 400;
  const details = error.code === "REVISION_CONFLICT" ? {
    expected_revision: revisionDetail(error.details.expectedRevision),
    current_revision: revisionDetail(error.details.currentRevision),
  } : Object.keys(error.details).length ? error.details : undefined;
  return jsonError(error.code, context, status, { details });
}

export function mutationContext(
  principalId: string,
  context: ReturnType<typeof requestContext>,
  idempotencyKey: string,
) {
  return {
    actorPrincipalId: principalId,
    requestId: context.requestId,
    traceId: context.traceId,
    idempotencyKey,
    source: "api" as const,
  };
}
