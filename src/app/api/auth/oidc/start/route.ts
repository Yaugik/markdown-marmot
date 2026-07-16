import { buildAuthorizationUrl, createAuthTransaction, PostgresAuthTransactionStore, runtimeOidcConfig, runtimeOidcDiscovery } from "@/auth/oidc";
import { oidcConfigured } from "@/lib/env";
import { jsonError, requestContext } from "@/api";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = requestContext(request);
  if (!oidcConfigured()) return jsonError("AUTH_NOT_CONFIGURED", context, 503);
  try {
    const requestUrl = new URL(request.url);
    const config = runtimeOidcConfig();
    const discovery = await runtimeOidcDiscovery(config);
    const created = createAuthTransaction(config, { returnTo: requestUrl.searchParams.get("return_to") ?? "/" });
    await new PostgresAuthTransactionStore().save(created.transaction);
    const authorizationUrl = buildAuthorizationUrl({
      config,
      discovery,
      state: created.state,
      nonce: created.transaction.nonce,
      pkceChallenge: created.challenge,
    });
    return Response.redirect(authorizationUrl, 302);
  } catch {
    return jsonError("AUTH_PROVIDER_FAILED", context, 502);
  }
}
