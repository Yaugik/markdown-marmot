import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { OidcConfig } from "./schemas";

export type AuthTransaction = {
  id: string;
  nonce: string;
  pkceVerifier: string;
  returnTo: string;
  createdAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
};

export type AuthTransactionStore = {
  save(transaction: AuthTransaction): Promise<void>;
  /** Must atomically mark an unexpired transaction consumed, returning null after first use. */
  consume(id: string, now: Date): Promise<AuthTransaction | null>;
};

type StatePayload = { v: 1; transactionId: string; expiresAt: number };

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash("sha256").update(verifier, "ascii").digest()) };
}

export function createAuthTransaction(
  config: OidcConfig,
  input: { returnTo?: string; now?: Date } = {},
): { transaction: AuthTransaction; state: string; challenge: string } {
  const now = input.now ?? new Date();
  const returnTo = validateReturnTo(input.returnTo ?? "/");
  const { verifier, challenge } = createPkce();
  const transaction: AuthTransaction = {
    id: base64url(randomBytes(24)),
    nonce: base64url(randomBytes(32)),
    pkceVerifier: verifier,
    returnTo,
    createdAt: now,
    expiresAt: new Date(now.getTime() + config.transactionTtlSeconds * 1000),
    consumedAt: null,
  };
  return { transaction, state: signState(transaction, config.stateSigningKey), challenge };
}

export function verifyState(
  state: string,
  key: Uint8Array,
  now = new Date(),
): { ok: true; transactionId: string } | { ok: false; reason: "malformed" | "invalid_signature" | "expired" } {
  const parts = state.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  let supplied: Buffer;
  try {
    supplied = Buffer.from(parts[1], "base64url");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const expected = createHmac("sha256", key).update(parts[0], "ascii").digest();
  if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
    return { ok: false, reason: "invalid_signature" };
  }
  try {
    const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as Partial<StatePayload>;
    if (payload.v !== 1 || typeof payload.transactionId !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(payload.transactionId) || typeof payload.expiresAt !== "number") {
      return { ok: false, reason: "malformed" };
    }
    if (payload.expiresAt <= now.getTime()) return { ok: false, reason: "expired" };
    return { ok: true, transactionId: payload.transactionId };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

function signState(transaction: AuthTransaction, key: Uint8Array): string {
  const encoded = base64url(Buffer.from(JSON.stringify({ v: 1, transactionId: transaction.id, expiresAt: transaction.expiresAt.getTime() } satisfies StatePayload)));
  return `${encoded}.${base64url(createHmac("sha256", key).update(encoded, "ascii").digest())}`;
}

function validateReturnTo(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\r\n]/.test(value)) {
    throw new Error("returnTo must be an application-relative path");
  }
  return value;
}

function base64url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}
