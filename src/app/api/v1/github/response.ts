import { jsonError, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";

const conflictCodes = new Set([
  "CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "REVISION_CONFLICT",
  "BASE_REF_CHANGED",
  "BLOB_CHANGED",
  "TARGET_REF_CHANGED",
  "PATH_POLICY_CHANGED",
  "GITHUB_PERMISSION_CHANGED",
  "BRANCH_PROTECTED",
  "CONFIRMATION_REQUIRED",
  "CONFIRMATION_EXPIRED",
]);

export function githubApiError(error: unknown, context: ReturnType<typeof requestContext>): Response {
  if (error instanceof FoundationServiceError) {
    const providerCode = typeof error.details.providerCode === "string" ? error.details.providerCode : null;
    const status = error.code === "NOT_FOUND" ? 404
      : error.code === "CAPABILITY_DENIED" ? 403
        : error.code === "PROVIDER_RATE_LIMITED" ? 429
          : error.code === "PROVIDER_UNAVAILABLE" ? 503
            : conflictCodes.has(error.code) ? 409
              : 400;
    return jsonError(error.code, context, status, {
      details: providerCode
        ? { provider_code: providerCode, ...error.details }
        : Object.keys(error.details).length ? error.details : undefined,
    });
  }
  return jsonError("OPERATION_FAILED", context, 500);
}

export function githubMutationContext(
  principalId:string,
  context:ReturnType<typeof requestContext>,
  idempotencyKey:string,
  options?:{authorizingPrincipalId?:string;confirmationId?:string},
){
  return {
    actorPrincipalId:principalId,
    authorizingPrincipalId:options?.authorizingPrincipalId,
    confirmationId:options?.confirmationId,
    requestId:context.requestId,
    traceId:context.traceId,
    idempotencyKey,
    source:"api" as const,
  };
}
