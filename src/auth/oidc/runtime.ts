import { env, oidcConfigured } from "@/lib/env";
import { discoverProvider } from "./client";
import { oidcConfigSchema, type OidcConfig, type OidcDiscoveryDocument } from "./schemas";

let cachedDiscovery: { issuer: string; expiresAt: number; document: OidcDiscoveryDocument } | undefined;

export function runtimeOidcConfig(): OidcConfig {
  if (!oidcConfigured()) throw new Error("Managed OIDC is not configured.");
  return oidcConfigSchema.parse({
    issuer: env.OIDC_ISSUER_URL,
    clientId: env.OIDC_CLIENT_ID,
    clientSecret: env.OIDC_CLIENT_SECRET,
    redirectUri: env.OIDC_REDIRECT_URI,
    scopes: env.OIDC_SCOPES.split(/\s+/).filter(Boolean),
    stateSigningKey: Buffer.from(env.OIDC_STATE_SIGNING_KEY!, "base64url"),
    transactionTtlSeconds: 300,
    sessionTtlSeconds: 60 * 60 * 8,
    cookieName: "__Host-folio_session",
  });
}

export async function runtimeOidcDiscovery(config = runtimeOidcConfig()): Promise<OidcDiscoveryDocument> {
  if (cachedDiscovery?.issuer === config.issuer && cachedDiscovery.expiresAt > Date.now()) {
    return cachedDiscovery.document;
  }
  const document = await discoverProvider(config);
  cachedDiscovery = { issuer: config.issuer, expiresAt: Date.now() + 10 * 60 * 1000, document };
  return document;
}
