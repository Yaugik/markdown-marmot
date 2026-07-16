import { jsonError, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";

export function githubApiError(error: unknown, context: ReturnType<typeof requestContext>): Response {
  if (error instanceof FoundationServiceError) {
    const providerCode = typeof error.details.providerCode === "string" ? error.details.providerCode : null;
    const status = error.code === "NOT_FOUND" ? 404
      : error.code === "CAPABILITY_DENIED" ? 403
        : error.code === "REVISION_CONFLICT" || error.code === "IDEMPOTENCY_CONFLICT" || error.code === "CONFLICT" ? 409
          : 400;
    return jsonError(error.code, context, status, {
      details: providerCode ? { provider_code: providerCode, ...error.details } : Object.keys(error.details).length ? error.details : undefined,
    });
  }
  return jsonError("OPERATION_FAILED", context, 500);
}

export function githubMutationContext(principalId:string,context:ReturnType<typeof requestContext>,idempotencyKey:string,options?:{authorizingPrincipalId?:string;confirmationId?:string}){
  return {actorPrincipalId:principalId,authorizingPrincipalId:options?.authorizingPrincipalId,confirmationId:options?.confirmationId,requestId:context.requestId,traceId:context.traceId,idempotencyKey,source:"api" as const};
}
