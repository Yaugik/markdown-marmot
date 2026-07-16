import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { createWorkspace, FoundationServiceError, listPermittedWorkspaces } from "@/services/foundation";

const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/),
  default_time_zone: z.string().trim().min(1).max(100).optional(),
}).strict();

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  const workspaces = await listPermittedWorkspaces(authenticated.session.principalId);
  return jsonSuccess(workspaces.map((workspace) => ({
    id: workspace.id,
    name: workspace.name,
    slug: workspace.slug,
    default_time_zone: workspace.defaultTimeZone,
    revision: workspace.revision,
    membership_role: workspace.membershipRole,
  })), context);
}

export async function POST(request: Request) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey) return jsonError("VALIDATION_FAILED", context, 400, {
    fieldErrors: [{ field: "Idempotency-Key", code: "required", message: "Required" }],
  });
  try {
    const input = createWorkspaceSchema.parse(await request.json());
    const result = await createWorkspace({
      name: input.name,
      slug: input.slug,
      defaultTimeZone: input.default_time_zone,
    }, {
      actorPrincipalId: authenticated.session.principalId,
      requestId: context.requestId,
      traceId: context.traceId,
      idempotencyKey,
      source: "api",
    });
    return jsonSuccess({
      workspace: result.data,
      activity_id: result.activityId,
      outbox_event_id: result.outboxEventId,
      replayed: result.replayed,
    }, context, result.replayed ? 200 : 201);
  } catch (error) {
    return foundationFailure(error, context);
  }
}

function foundationFailure(error: unknown, context: ReturnType<typeof requestContext>): Response {
  if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400, {
    fieldErrors: error.issues.map((issue) => ({ field: issue.path.join("."), code: issue.code, message: issue.message })),
  });
  if (error instanceof FoundationServiceError) {
    const status = error.code === "NOT_FOUND" ? 404 : error.code === "CAPABILITY_DENIED" ? 403 : error.code === "CONFLICT" || error.code === "IDEMPOTENCY_CONFLICT" ? 409 : 400;
    return jsonError(error.code, context, status);
  }
  return jsonError("OPERATION_FAILED", context, 500);
}
