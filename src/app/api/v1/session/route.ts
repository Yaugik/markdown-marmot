import { authenticatedRequest, jsonSuccess, requestContext } from "@/api";
import { revokeAuthSession, serializeExpiredSessionCookie } from "@/auth/sessions";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  return jsonSuccess({
    user_id: authenticated.session.userId,
    principal_id: authenticated.session.principalId,
    display_name: authenticated.session.displayName,
    primary_email: authenticated.session.primaryEmail,
    expires_at: authenticated.session.expiresAt,
  }, context);
}

export async function DELETE(request: Request) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  await revokeAuthSession(authenticated.session.sessionId);
  const response = jsonSuccess({ revoked: true }, context);
  response.headers.append("set-cookie", serializeExpiredSessionCookie());
  return response;
}
