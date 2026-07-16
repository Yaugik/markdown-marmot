import { withPostgresClient } from "@/db/postgres";
import {
  exchangeAuthorizationCode,
  PostgresAuthTransactionStore,
  runtimeOidcConfig,
  runtimeOidcDiscovery,
  validateIdToken,
  verifyIdTokenSignature,
  verifyState,
} from "@/auth/oidc";
import { createAuthSession, serializeSessionCookie } from "@/auth/sessions";
import { provisionAuthenticatedHuman } from "@/services/foundation";
import { newFolioId } from "@/lib/folio-ids";
import { jsonError, requestContext, type ApiErrorCode } from "@/api";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = requestContext(request);
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return callbackFailure("AUTH_REQUEST_INVALID", 400, context);

  try {
    const config = runtimeOidcConfig();
    const verifiedState = verifyState(state, config.stateSigningKey);
    if (!verifiedState.ok) return callbackFailure("AUTH_REQUEST_INVALID", 400, context);
    const transaction = await new PostgresAuthTransactionStore().consume(verifiedState.transactionId, new Date());
    if (!transaction) return callbackFailure("AUTH_REQUEST_INVALID", 400, context);
    const discovery = await runtimeOidcDiscovery(config);
    const tokens = await exchangeAuthorizationCode({ config, discovery, code, transaction });
    const claims = await validateIdToken({
      idToken: tokens.id_token,
      config,
      discovery,
      transaction,
      verify: verifyIdTokenSignature,
    });
    if (!claims.email || claims.email_verified !== true) {
      return callbackFailure("AUTH_VERIFIED_EMAIL_REQUIRED", 403, context);
    }
    const identity = await provisionAuthenticatedHuman({
      issuer: claims.iss,
      subject: claims.sub,
      email: claims.email,
      displayName: claims.name?.trim() || claims.email.split("@")[0],
      claimsSummary: { email_verified: true },
    });
    const createdSession = await withPostgresClient(async (client) => {
      await client.query("BEGIN");
      try {
        const session = await createAuthSession(client, {
          userId: identity.userId,
          principalId: identity.principalId,
          ttlSeconds: config.sessionTtlSeconds,
        });
        await client.query(`
          INSERT INTO security_events (
            id, actor_principal_id, event_type, result, request_id, summary
          ) VALUES ($1, $2, 'oidc.login', 'succeeded', $3, $4)
        `, [newFolioId(), identity.principalId, newFolioId(), { issuer: claims.iss }]);
        await client.query("COMMIT");
        return session;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
    const response = Response.redirect(new URL(transaction.returnTo, url.origin), 302);
    response.headers.append("set-cookie", serializeSessionCookie(createdSession.token, createdSession.expiresAt));
    return response;
  } catch {
    return callbackFailure("AUTH_PROVIDER_FAILED", 502, context);
  }
}

function callbackFailure(code: ApiErrorCode, status: number, context: ReturnType<typeof requestContext>): Response {
  return jsonError(code, context, status);
}
