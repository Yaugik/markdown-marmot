import { jsonError, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";

function revisionDetail(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

export function ecosystemServiceError(
  error: FoundationServiceError,
  context: ReturnType<typeof requestContext>,
) {
  const status = error.code === "NOT_FOUND" ? 404
    : error.code === "CAPABILITY_DENIED" ? 403
      : ["CONFLICT", "IDEMPOTENCY_CONFLICT", "REVISION_CONFLICT"].includes(error.code) ? 409
        : 400;
  const details = error.code === "REVISION_CONFLICT" ? {
    expected_revision: revisionDetail(error.details.expectedRevision),
    current_revision: revisionDetail(error.details.currentRevision),
  } : Object.keys(error.details).length ? error.details : undefined;
  return jsonError(error.code, context, status, { details });
}

export function ecosystemMutationContext(
  principalId: string,
  context: ReturnType<typeof requestContext>,
  idempotencyKey: string,
  options?: { authorizingPrincipalId?: string; confirmationId?: string },
) {
  return {
    actorPrincipalId: principalId,
    authorizingPrincipalId: options?.authorizingPrincipalId,
    confirmationId: options?.confirmationId,
    requestId: context.requestId,
    traceId: context.traceId,
    idempotencyKey,
    source: "api" as const,
  };
}

export const mutationEnvelope = <T>(name: string, result: {
  data: T;
  activityId: string;
  outboxEventId: string;
  replayed: boolean;
}) => ({
  [name]: result.data,
  activity_id: result.activityId,
  outbox_event_id: result.outboxEventId,
  replayed: result.replayed,
});
