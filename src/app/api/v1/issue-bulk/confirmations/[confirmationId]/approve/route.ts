import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { approveIssueBulkConfirmation } from "@/services/issue-bulk";
import { issueServiceError, mutationContext } from "../../../../issues/response";

const schema = z.object({ workspace_id: z.string().uuid(), project_id: z.string().uuid(), action_digest: z.string().regex(/^[a-f0-9]{64}$/), expected_revision: z.number().int().positive() }).strict();
type RouteContext = { params: Promise<{ confirmationId: string }> };
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: RouteContext) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey) return jsonError("VALIDATION_FAILED", context, 400, { fieldErrors: [{ field: "Idempotency-Key", code: "required", message: "Required" }] });
  try {
    const { confirmationId } = await params;
    const id = z.string().uuid().parse(confirmationId);
    const input = schema.parse(await request.json());
    const result = await approveIssueBulkConfirmation({ workspaceId: input.workspace_id, projectId: input.project_id, confirmationId: id, actionDigest: input.action_digest, expectedRevision: input.expected_revision }, mutationContext(authenticated.session.principalId, context, idempotencyKey));
    return jsonSuccess({ confirmation: { id: result.data.confirmationId, status: result.data.status, revision: result.data.revision }, activity_id: result.activityId, outbox_event_id: result.outboxEventId, replayed: result.replayed }, context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400, { fieldErrors: error.issues.map((issue) => ({ field: issue.path.join("."), code: issue.code, message: issue.message })) });
    if (error instanceof FoundationServiceError) return issueServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
