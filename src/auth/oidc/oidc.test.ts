import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  OidcBoundaryError,
  buildAuthorizationUrl,
  createAuthTransaction,
  discoverProvider,
  exchangeAuthorizationCode,
  oidcConfigSchema,
  validateIdToken,
  verifyState,
} from "./index";

const config = oidcConfigSchema.parse({
  issuer: "https://identity.example.com",
  clientId: "folio-client",
  clientSecret: "a-development-secret-long-enough",
  redirectUri: "https://folio.example.com/api/auth/callback",
  scopes: ["openid", "profile", "email"],
  stateSigningKey: new Uint8Array(32).fill(7),
});

const discovery = {
  issuer: config.issuer,
  authorization_endpoint: "https://identity.example.com/oauth/authorize",
  token_endpoint: "https://identity.example.com/oauth/token",
  jwks_uri: "https://identity.example.com/.well-known/jwks.json",
  response_types_supported: ["code"],
  subject_types_supported: ["public"],
  id_token_signing_alg_values_supported: ["RS256"],
  code_challenge_methods_supported: ["S256"],
};

describe("OIDC configuration and discovery", () => {
  it("requires HTTPS, openid, unique scopes, and a strong state key", () => {
    expect(() => oidcConfigSchema.parse({ ...config, issuer: "http://identity.example.com" })).toThrow();
    expect(() => oidcConfigSchema.parse({ ...config, scopes: ["profile"] })).toThrow();
    expect(() => oidcConfigSchema.parse({ ...config, scopes: ["openid", "openid"] })).toThrow();
    expect(() => oidcConfigSchema.parse({ ...config, stateSigningKey: new Uint8Array(16) })).toThrow();
  });

  it("validates discovery capabilities and exact issuer", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(discovery), { status: 200 }));
    await expect(discoverProvider(config, fetcher)).resolves.toEqual(discovery);
    expect(fetcher).toHaveBeenCalledWith(
      new URL("https://identity.example.com/.well-known/openid-configuration"),
      expect.objectContaining({ redirect: "error" }),
    );

    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ...discovery, issuer: "https://attacker.example" })));
    await expect(discoverProvider(config, fetcher)).rejects.toMatchObject({ code: "issuer_mismatch" });
  });
});

describe("authorization transaction", () => {
  it("creates an RFC 7636 S256 challenge and MACed short-lived state", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const created = createAuthTransaction(config, { returnTo: "/projects/one", now });
    expect(created.challenge).toBe(
      Buffer.from(createHash("sha256").update(created.transaction.pkceVerifier).digest()).toString("base64url"),
    );
    expect(created.transaction.pkceVerifier).toHaveLength(43);
    expect(verifyState(created.state, config.stateSigningKey, now)).toEqual({
      ok: true,
      transactionId: created.transaction.id,
    });
    expect(verifyState(`${created.state.slice(0, -1)}x`, config.stateSigningKey, now)).toMatchObject({ ok: false });
    expect(verifyState(created.state, config.stateSigningKey, created.transaction.expiresAt)).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects open-redirect return targets", () => {
    expect(() => createAuthTransaction(config, { returnTo: "https://attacker.example" })).toThrow();
    expect(() => createAuthTransaction(config, { returnTo: "//attacker.example" })).toThrow();
  });

  it("builds a code-only authorization request with nonce and PKCE", () => {
    const created = createAuthTransaction(config);
    const url = buildAuthorizationUrl({
      config,
      discovery,
      state: created.state,
      nonce: created.transaction.nonce,
      pkceChallenge: created.challenge,
    });
    expect(url.origin + url.pathname).toBe(discovery.authorization_endpoint);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      code_challenge_method: "S256",
      code_challenge: created.challenge,
      nonce: created.transaction.nonce,
      state: created.state,
    });
  });
});

describe("callback boundaries", () => {
  it("exchanges a code with the redirect URI and PKCE verifier", async () => {
    const transaction = createAuthTransaction(config).transaction;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ access_token: "access", token_type: "Bearer", id_token: "header.payload.signature" })),
    );
    await expect(exchangeAuthorizationCode({ config, discovery, code: "one-time-code", transaction, fetcher })).resolves.toMatchObject({ access_token: "access" });
    const request = fetcher.mock.calls[0];
    expect(request?.[0]).toBe(discovery.token_endpoint);
    const body = request?.[1]?.body as URLSearchParams;
    expect(body.get("code_verifier")).toBe(transaction.pkceVerifier);
    expect(body.get("redirect_uri")).toBe(config.redirectUri);
  });

  it("delegates signature verification then enforces issuer, audience, expiry, azp, and nonce", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const transaction = createAuthTransaction(config, { now }).transaction;
    const claims = {
      iss: config.issuer,
      sub: "provider-user-1",
      aud: config.clientId,
      exp: Math.floor(now.getTime() / 1000) + 300,
      nonce: transaction.nonce,
    };
    const verify = vi.fn().mockResolvedValue(claims);
    await expect(validateIdToken({ idToken: "jwt", config, discovery, transaction, verify, now })).resolves.toEqual(claims);
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ jwksUri: discovery.jwks_uri, allowedAlgorithms: ["RS256"] }));

    verify.mockResolvedValueOnce({ ...claims, nonce: "wrong" });
    await expect(validateIdToken({ idToken: "jwt", config, discovery, transaction, verify, now })).rejects.toBeInstanceOf(OidcBoundaryError);
    verify.mockResolvedValueOnce({ ...claims, aud: [config.clientId, "other"] });
    await expect(validateIdToken({ idToken: "jwt", config, discovery, transaction, verify, now })).rejects.toMatchObject({ code: "invalid_claims" });
  });
});
