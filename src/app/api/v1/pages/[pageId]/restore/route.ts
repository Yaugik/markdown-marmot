import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { restoreNativePage } from "@/services/page-history";
import { pageServiceError } from "../../response";

const inputSchema = z.object({
  workspace_id: z.string().uuid(),
  project_id: z.string().uuid(),
  expected_revision: z.number().int().positive(),
}).strict();
type RouteContext = { params: Promise<{ pageId: string }> };

export async function POST(request: Request, { params }: RouteContext) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey) return jsonError("VALIDATION_FAILED", context, 400, {
    fieldErrors: [{ field: "Idempotency-Key", code: "required", message: "Required" }],
  });

  try {
    const { pageId } = await params;
    const validatedPageId = z.string().uuid().parse(pageId);
    const input = inputSchema.parse(await request.json());
    const result = await restoreNativePage({
      workspaceId: input.workspace_id,
      projectId: input.project_id,
      pageId: validatedPageId,
      expectedRevision: input.expected_revision,
    }, {
      actorPrincipalId: authenticated.session.principalId,
      requestId: context.requestId,
      traceId: context.traceId,
      idempotencyKey,
      source: "api",
    });
    return jsonSuccess({
      page: {
        id: result.data.pageId,
        status: result.data.status,
        revision: result.data.revision,
        archived_at: result.data.archivedAt,
        updated_at: result.data.updatedAt,
      },
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
