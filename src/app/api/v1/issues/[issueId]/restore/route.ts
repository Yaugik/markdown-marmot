import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { restoreIssueWithParentPolicy } from "@/services/issue-lifecycle-policy";
import { issueResponse, issueServiceError, mutationContext } from "../../response";

const schema = z.object({
  workspace_id: z.string().uuid(),
  project_id: z.string().uuid(),
  expected_revision: z.number().int().positive(),
}).strict();
type RouteContext = { params: Promise<{ issueId: string }> };
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: RouteContext) {
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
    const { issueId } = await params;
    const id = z.string().uuid().parse(issueId);
    const input = schema.parse(await request.json());
    const result = await restoreIssueWithParentPolicy({
      workspaceId: input.workspace_id,
      projectId: input.project_id,
      issueId: id,
      expectedRevision: input.expected_revision,
    }, mutationContext(authenticated.session.principalId, context, idempotencyKey));
    return jsonSuccess({
      issue: issueResponse(result.data),
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
