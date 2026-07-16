import { z } from "zod";

const httpsUrl = z.string().url().refine((value) => new URL(value).protocol === "https:", {
  message: "Must use HTTPS",
});

export const oidcConfigSchema = z
  .object({
    issuer: httpsUrl,
    clientId: z.string().trim().min(1).max(512),
    clientSecret: z.string().min(16).max(4096).optional(),
    redirectUri: httpsUrl,
    scopes: z.array(z.string().regex(/^[\x21-\x7e]+$/).min(1).max(128)).min(1).max(32),
    stateSigningKey: z.instanceof(Uint8Array).refine((key) => key.byteLength >= 32, {
      message: "State signing key must contain at least 32 bytes",
    }),
    transactionTtlSeconds: z.number().int().min(60).max(600).default(300),
    sessionTtlSeconds: z.number().int().min(300).max(60 * 60 * 24 * 30).default(60 * 60 * 8),
    cookieName: z.string().regex(/^__Host-[A-Za-z0-9_-]+$/).default("__Host-folio_session"),
  })
  .strict()
  .refine((config) => new Set(config.scopes).size === config.scopes.length, {
    path: ["scopes"],
    message: "Scopes must be unique",
  })
  .refine((config) => config.scopes.includes("openid"), {
    path: ["scopes"],
    message: "The openid scope is required",
  });

export type OidcConfig = z.infer<typeof oidcConfigSchema>;

export const discoveryDocumentSchema = z
  .object({
    issuer: httpsUrl,
    authorization_endpoint: httpsUrl,
    token_endpoint: httpsUrl,
    jwks_uri: httpsUrl,
    response_types_supported: z.array(z.string()).refine((values) => values.includes("code")),
    subject_types_supported: z.array(z.string()).min(1),
    id_token_signing_alg_values_supported: z
      .array(z.string())
      .refine((values) => values.some((value) => value !== "none")),
    code_challenge_methods_supported: z.array(z.string()).refine((values) => values.includes("S256")),
    token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
  })
  .passthrough();

export type OidcDiscoveryDocument = z.infer<typeof discoveryDocumentSchema>;

export const tokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    token_type: z.string().regex(/^Bearer$/i),
    expires_in: z.number().int().positive().optional(),
    id_token: z.string().min(1),
    refresh_token: z.string().min(1).optional(),
    scope: z.string().optional(),
  })
  .passthrough();

export type OidcTokenResponse = z.infer<typeof tokenResponseSchema>;

export const verifiedIdTokenClaimsSchema = z
  .object({
    iss: z.string().url(),
    sub: z.string().min(1).max(1024),
    aud: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    exp: z.number().int().positive(),
    iat: z.number().int().positive().optional(),
    nonce: z.string().min(1),
    azp: z.string().min(1).optional(),
    email: z.string().email().optional(),
    email_verified: z.boolean().optional(),
    name: z.string().max(1024).optional(),
  })
  .passthrough();

export type VerifiedIdTokenClaims = z.infer<typeof verifiedIdTokenClaimsSchema>;
