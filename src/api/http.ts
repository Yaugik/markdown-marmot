import { createApiError, type ApiErrorCode } from "./errors";
import { uuidV7Schema } from "./contracts";
import { isSameOriginMutation, resolveAuthSession, type AuthenticatedSession } from "@/auth/sessions";
import { newFolioId } from "@/lib/folio-ids";

export type HttpRequestContext = {
  requestId: string;
  traceId: string;
};

export function requestContext(request: Request): HttpRequestContext {
  const suppliedRequestId = request.headers.get("x-request-id");
  return {
    requestId: uuidV7Schema.safeParse(suppliedRequestId).success ? suppliedRequestId! : newFolioId(),
    traceId: request.headers.get("x-trace-id")?.slice(0, 255) || newFolioId(),
  };
}

export function jsonSuccess(data: unknown, context: HttpRequestContext, status = 200): Response {
  return Response.json({ data, meta: { request_id: context.requestId, trace_id: context.traceId } }, {
    status,
    headers: { "x-request-id": context.requestId, "x-trace-id": context.traceId },
  });
}

export function jsonError(
  code: ApiErrorCode,
  context: HttpRequestContext,
  status: number,
  options?: Parameters<typeof createApiError>[2],
): Response {
  return Response.json(createApiError(code, {
    request_id: context.requestId,
    trace_id: context.traceId,
  }, options), {
    status,
    headers: { "x-request-id": context.requestId, "x-trace-id": context.traceId },
  });
}

export async function authenticatedRequest(
  request: Request,
  context: HttpRequestContext,
): Promise<{ ok: true; session: AuthenticatedSession } | { ok: false; response: Response }> {
  if (!isSameOriginMutation(request)) {
    return { ok: false, response: jsonError("CAPABILITY_DENIED", context, 403) };
  }
  const session = await resolveAuthSession(request);
  if (!session) return { ok: false, response: jsonError("UNAUTHENTICATED", context, 401) };
  return { ok: true, session };
}
