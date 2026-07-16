import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { prepareIssueBulkOperation } from "@/services/issue-bulk";
import { issueServiceError, mutationContext } from "../issues/response";
import { bulkPreviewResponse } from "./response";

const patchSchema = z.object({
  priority: z.enum(["no_priority", "urgent", "high", "medium", "low"]).optional(),
  estimatePoints: z.number().nonnegative().nullable().optional(),
  milestoneId: z.string().uuid().nullable().optional(),
  cycleId: z.string().uuid().nullable().optional(),
  startOn: z.string().date().nullable().optional(),
  dueOn: z.string().date().nullable().optional(),
}).strict();
const requestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("patch"), patch: patchSchema }).strict(),
  z.object({
    operation: z.literal("transition"),
    targetStatusId: z.string().uuid(),
    comment: z.string().trim().min(1).max(20_000).optional(),
  }).strict(),
  z.object({ operation: z.literal("archive") }).strict(),
  z.object({ operation: z.literal("restore") }).strict(),
]);
const schema = z.object({
  workspace_id: z.string().uuid(),
  project_id: z.string().uuid(),
  issue_ids: z.array(z.string().uuid()).min(1).max(500),
  request: requestSchema,
}).strict();
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
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
    const input = schema.parse(await request.json());
    const result = await prepareIssueBulkOperation({
      workspaceId: input.workspace_id,
      projectId: input.project_id,
      issueIds: input.issue_ids,
      request: input.request,
    }, mutationContext(authenticated.session.principalId, context, idempotencyKey));
    return jsonSuccess({
      preview: bulkPreviewResponse(result.data),
      activity_id: result.activityId,
      outbox_event_id: result.outboxEventId,
      replayed: result.replayed,
    }, context, result.replayed ? 200 : 201);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return jsonError("VALIDATION_FAILED", context, 400, {
        fieldErrors: error.issues.map((issue) => ({
          field: issue.path.join("."),
          code: issue.code,
          message: issue.message,
        })),
      });
    }
    if (error instanceof FoundationServiceError) return issueServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
