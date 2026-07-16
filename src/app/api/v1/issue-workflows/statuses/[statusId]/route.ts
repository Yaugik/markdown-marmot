import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { updateWorkflowStatus } from "@/services/issue-workflows";
import { issueServiceError, mutationContext } from "../../../issues/response";

const schema = z.object({
  workspace_id: z.string().uuid(),
  project_id: z.string().uuid(),
  expected_revision: z.number().int().positive(),
  name: z.string().trim().min(1).max(80).optional(),
  category: z.enum(["backlog", "planned", "in_progress", "completed", "canceled"]).optional(),
  color_key: z.string().optional(),
  rank: z.number().int().nonnegative().optional(),
}).strict();
type RouteContext = { params: Promise<{ statusId: string }> };
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: RouteContext) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey) return jsonError("VALIDATION_FAILED", context, 400, { fieldErrors: [{ field: "Idempotency-Key", code: "required", message: "Required" }] });
  try {
    const { statusId } = await params;
    const id = z.string().uuid().parse(statusId);
    const input = schema.parse(await request.json());
    const result = await updateWorkflowStatus({ workspaceId: input.workspace_id, projectId: input.project_id, statusId: id, expectedRevision: input.expected_revision, name: input.name, category: input.category, colorKey: input.color_key, rank: input.rank }, mutationContext(authenticated.session.principalId, context, idempotencyKey));
    return jsonSuccess({ status: { id: result.data.id, name: result.data.name, category: result.data.category, color_key: result.data.colorKey, rank: result.data.rank, is_initial: result.data.isInitial, revision: result.data.revision }, activity_id: result.activityId, outbox_event_id: result.outboxEventId, replayed: result.replayed }, context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400, { fieldErrors: error.issues.map((issue) => ({ field: issue.path.join("."), code: issue.code, message: issue.message })) });
    if (error instanceof FoundationServiceError) return issueServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
