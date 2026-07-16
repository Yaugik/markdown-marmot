import { z } from "zod";
import {
  discoveryDocumentSchema,
  oidcConfigSchema,
  tokenResponseSchema,
  verifiedIdTokenClaimsSchema,
  type OidcConfig,
  type OidcDiscoveryDocument,
  type OidcTokenResponse,
  type VerifiedIdTokenClaims,
} from "./schemas";
import type { AuthTransaction } from "./transaction";

export type IdTokenVerifier = (input: {
  idToken: string;
  issuer: string;
  audience: string;
  jwksUri: string;
  allowedAlgorithms: readonly string[];
}) => Promise<unknown>;

export async function discoverProvider(
  rawConfig: unknown,
  fetcher: typeof fetch = fetch,
): Promise<OidcDiscoveryDocument> {
  const config = oidcConfigSchema.parse(rawConfig);
  const endpoint = new URL(".well-known/openid-configuration", `${normalizedIssuer(config.issuer)}/`);
  const response = await fetcher(endpoint, { headers: { accept: "application/json" }, redirect: "error" });
  if (!response.ok) throw new OidcBoundaryError("discovery_failed", `OIDC discovery failed with HTTP ${response.status}`);
  const document = discoveryDocumentSchema.parse(await response.json());
  if (normalizedIssuer(document.issuer) !== normalizedIssuer(config.issuer)) {
    throw new OidcBoundaryError("issuer_mismatch", "Discovery issuer does not match configured issuer");
  }
  return document;
}

export function buildAuthorizationUrl(input: {
  config: OidcConfig;
  discovery: OidcDiscoveryDocument;
  state: string;
  nonce: string;
  pkceChallenge: string;
}): URL {
  oidcConfigSchema.parse(input.config);
  discoveryDocumentSchema.parse(input.discovery);
  const url = new URL(input.discovery.authorization_endpoint);
  url.search = new URLSearchParams({
    client_id: input.config.clientId,
    redirect_uri: input.config.redirectUri,
    response_type: "code",
    scope: input.config.scopes.join(" "),
    state: z.string().min(32).max(4096).parse(input.state),
    nonce: z.string().min(32).max(128).parse(input.nonce),
    code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/).parse(input.pkceChallenge),
    code_challenge_method: "S256",
  }).toString();
  return url;
}

export async function exchangeAuthorizationCode(input: {
  config: OidcConfig;
  discovery: OidcDiscoveryDocument;
  code: string;
  transaction: AuthTransaction;
  fetcher?: typeof fetch;
}): Promise<OidcTokenResponse> {
  const code = z.string().min(1).max(8192).parse(input.code);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: input.config.redirectUri,
    client_id: input.config.clientId,
    code_verifier: input.transaction.pkceVerifier,
  });
  if (input.config.clientSecret) body.set("client_secret", input.config.clientSecret);
  const response = await (input.fetcher ?? fetch)(input.discovery.token_endpoint, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body,
    redirect: "error",
  });
  if (!response.ok) throw new OidcBoundaryError("token_exchange_failed", `OIDC token exchange failed with HTTP ${response.status}`);
  return tokenResponseSchema.parse(await response.json());
}

export async function validateIdToken(input: {
  idToken: string;
  config: OidcConfig;
  discovery: OidcDiscoveryDocument;
  transaction: AuthTransaction;
  verify: IdTokenVerifier;
  now?: Date;
  clockToleranceSeconds?: number;
}): Promise<VerifiedIdTokenClaims> {
  const untrusted = await input.verify({
    idToken: input.idToken,
    issuer: input.config.issuer,
    audience: input.config.clientId,
    jwksUri: input.discovery.jwks_uri,
    allowedAlgorithms: input.discovery.id_token_signing_alg_values_supported.filter((alg) => alg !== "none"),
  });
  const claims = verifiedIdTokenClaimsSchema.parse(untrusted);
  const now = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const tolerance = z.number().int().min(0).max(300).default(60).parse(input.clockToleranceSeconds);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (normalizedIssuer(claims.iss) !== normalizedIssuer(input.config.issuer)) throw new OidcBoundaryError("invalid_claims", "ID token issuer is invalid");
  if (!audiences.includes(input.config.clientId)) throw new OidcBoundaryError("invalid_claims", "ID token audience is invalid");
  if (audiences.length > 1 && claims.azp !== input.config.clientId) throw new OidcBoundaryError("invalid_claims", "ID token authorized party is invalid");
  if (claims.exp < now - tolerance) throw new OidcBoundaryError("invalid_claims", "ID token has expired");
  if (claims.iat !== undefined && claims.iat > now + tolerance) throw new OidcBoundaryError("invalid_claims", "ID token was issued in the future");
  if (claims.nonce !== input.transaction.nonce) throw new OidcBoundaryError("invalid_claims", "ID token nonce is invalid");
  return claims;
}

export class OidcBoundaryError extends Error {
  constructor(public readonly code: "discovery_failed" | "issuer_mismatch" | "token_exchange_failed" | "invalid_claims", message: string) {
    super(message);
    this.name = "OidcBoundaryError";
  }
}

function normalizedIssuer(value: string): string {
  return value.replace(/\/$/, "");
}
