import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { preparePageConversion } from "@/services/page-conversion";
import { pageServiceError } from "../pages/response";

const schema = z.object({
  workspace_id: z.string().uuid(),
  project_id: z.string().uuid(),
  operation: z.enum(["git_to_native", "native_to_git", "convert"]),
  source_page_id: z.string().uuid().nullable().optional(),
  source_descriptor: z.record(z.unknown()),
  target_descriptor: z.record(z.unknown()),
  markdown: z.string().max(2 * 1024 * 1024).optional(),
  title: z.string().trim().min(1).max(200).optional(),
  parent_node_id: z.string().uuid().nullable().optional(),
  display_title: z.string().trim().min(1).max(200).nullable().optional(),
  reassign_relationships: z.boolean().optional(),
}).strict();
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey) return jsonError("VALIDATION_FAILED", context, 400, {
    fieldErrors: [{ field: "Idempotency-Key", code: "required", message: "Required" }],
  });
  try {
    const input = schema.parse(await request.json());
    const result = await preparePageConversion({
      workspaceId: input.workspace_id,
      projectId: input.project_id,
      operation: input.operation,
      sourcePageId: input.source_page_id,
      sourceDescriptor: input.source_descriptor,
      targetDescriptor: input.target_descriptor,
      markdown: input.markdown,
      title: input.title,
      parentNodeId: input.parent_node_id,
      displayTitle: input.display_title,
      reassignRelationships: input.reassign_relationships,
    }, {
      actorPrincipalId: authenticated.session.principalId,
      requestId: context.requestId,
      traceId: context.traceId,
      idempotencyKey,
      source: "api",
    });
    return jsonSuccess({
      preview: result.data,
      activity_id: result.activityId,
      outbox_event_id: result.outboxEventId,
      replayed: result.replayed,
    }, context, result.replayed ? 200 : 201);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400, {
      fieldErrors: error.issues.map((issue) => ({ field: issue.path.join("."), code: issue.code, message: issue.message })),
    });
    if (error instanceof FoundationServiceError) return pageServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
