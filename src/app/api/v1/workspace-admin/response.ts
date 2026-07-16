import { jsonError, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";

export function workspaceAdminError(error: unknown, context: ReturnType<typeof requestContext>): Response {
  if (error instanceof FoundationServiceError) {
    const status = error.code === "NOT_FOUND" ? 404
      : error.code === "CAPABILITY_DENIED" ? 403
        : ["CONFLICT", "IDEMPOTENCY_CONFLICT", "REVISION_CONFLICT"].includes(error.code) ? 409
          : 400;
    const details = Object.keys(error.details).length ? error.details : undefined;
    return jsonError(error.code, context, status, { details });
  }
  return jsonError("OPERATION_FAILED", context, 500);
}

export function workspaceMutationContext(
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
