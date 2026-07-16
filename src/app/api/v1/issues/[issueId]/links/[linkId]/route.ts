import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { removeIssueLink } from "@/services/issue-link-lifecycle";
import { issueServiceError, mutationContext } from "../../../response";

const schema = z.object({
  workspace_id: z.string().uuid(),
  project_id: z.string().uuid(),
  expected_revision: z.number().int().positive(),
}).strict();
type RouteContext = { params: Promise<{ issueId: string; linkId: string }> };
export const dynamic = "force-dynamic";

export async function DELETE(request: Request, { params }: RouteContext) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey) return jsonError("VALIDATION_FAILED", context, 400, { fieldErrors: [{ field: "Idempotency-Key", code: "required", message: "Required" }] });
  try {
    const { linkId } = await params;
    const id = z.string().uuid().parse(linkId);
    const input = schema.parse(await request.json());
    const result = await removeIssueLink({
      workspaceId: input.workspace_id,
      projectId: input.project_id,
      linkId: id,
      expectedIssueRevision: input.expected_revision,
    }, mutationContext(authenticated.session.principalId, context, idempotencyKey));
    return jsonSuccess({
      link: {
        id: result.data.id,
        issue_id: result.data.issueId,
        link_kind: result.data.linkKind,
        target_issue_id: result.data.targetIssueId,
        target_page_id: result.data.targetPageId,
        external_url: result.data.externalUrl,
        label: result.data.label,
        created_at: result.data.createdAt,
      },
      activity_id: result.activityId,
      outbox_event_id: result.outboxEventId,
      replayed: result.replayed,
    }, context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400, { fieldErrors: error.issues.map((issue) => ({ field: issue.path.join("."), code: issue.code, message: issue.message })) });
    if (error instanceof FoundationServiceError) return issueServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
