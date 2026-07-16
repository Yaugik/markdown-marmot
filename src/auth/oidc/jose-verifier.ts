import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { IdTokenVerifier } from "./client";

const trustedKeySets = new Map<string, JWTVerifyGetKey>();

export const verifyIdTokenSignature: IdTokenVerifier = async ({
  idToken,
  issuer,
  audience,
  jwksUri,
  allowedAlgorithms,
}) => {
  const uri = new URL(jwksUri);
  if (uri.protocol !== "https:") throw new Error("OIDC JWKS endpoint must use HTTPS.");
  let keySet = trustedKeySets.get(uri.href);
  if (!keySet) {
    keySet = createRemoteJWKSet(uri, {
      timeoutDuration: 5_000,
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60 * 1000,
    });
    trustedKeySets.set(uri.href, keySet);
  }
  const verified = await jwtVerify(idToken, keySet, {
    issuer,
    audience,
    algorithms: [...allowedAlgorithms],
    clockTolerance: 60,
  });
  return verified.payload;
};
