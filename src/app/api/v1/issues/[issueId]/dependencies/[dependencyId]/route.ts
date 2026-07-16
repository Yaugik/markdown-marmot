import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { removeIssueDependencyForIssue } from "@/services/issue-relation-mutations";
import { issueServiceError, mutationContext } from "../../../response";

const schema = z.object({
  workspace_id: z.string().uuid(),
  project_id: z.string().uuid(),
  expected_revision: z.number().int().positive(),
}).strict();
type RouteContext = { params: Promise<{ issueId: string; dependencyId: string }> };
export const dynamic = "force-dynamic";

export async function DELETE(request: Request, { params }: RouteContext) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey) {
    return jsonError("VALIDATION_FAILED", context, 400, {
      fieldErrors: [{ field: "Idempotency-Key", code: "required", message: "Required" }],
    });
  }
  try {
    const { issueId, dependencyId } = await params;
    const routeIssueId = z.string().uuid().parse(issueId);
    const id = z.string().uuid().parse(dependencyId);
    const input = schema.parse(await request.json());
    const result = await removeIssueDependencyForIssue({
      workspaceId: input.workspace_id,
      projectId: input.project_id,
      issueId: routeIssueId,
      dependencyId: id,
      expectedSourceRevision: input.expected_revision,
    }, mutationContext(authenticated.session.principalId, context, idempotencyKey));
    return jsonSuccess({
      dependency: {
        id: result.data.id,
        relation_kind: result.data.relationKind,
        archived: true,
      },
      activity_id: result.activityId,
      outbox_event_id: result.outboxEventId,
      replayed: result.replayed,
    }, context);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return jsonError("VALIDATION_FAILED", context, 400, {
        fieldErrors: error.issues.map((issue) => ({
          field: issue.path.join("."), code: issue.code, message: issue.message,
        })),
      });
    }
    if (error instanceof FoundationServiceError) return issueServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
