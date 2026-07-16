import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { postgresPool } from "@/db/postgres";
import { newFolioId } from "@/lib/folio-ids";

export const sessionCookieName = "__Host-folio_session";

export type AuthenticatedSession = {
  sessionId: string;
  userId: string;
  principalId: string;
  displayName: string;
  primaryEmail: string;
  expiresAt: string;
};

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export async function createAuthSession(
  client: PoolClient,
  input: { userId: string; principalId: string; now?: Date; ttlSeconds?: number; idleSeconds?: number },
): Promise<{ sessionId: string; token: string; expiresAt: Date }> {
  const now = input.now ?? new Date();
  const ttlSeconds = input.ttlSeconds ?? 60 * 60 * 24 * 14;
  const idleSeconds = Math.min(input.idleSeconds ?? 60 * 60 * 24, ttlSeconds);
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
  const idleExpiresAt = new Date(now.getTime() + idleSeconds * 1000);
  const token = randomBytes(32).toString("base64url");
  const sessionId = newFolioId(now);

  await client.query(`
    INSERT INTO auth_sessions (
      id, user_id, principal_id, token_hash, expires_at, idle_expires_at, last_seen_at, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
  `, [sessionId, input.userId, input.principalId, hashSessionToken(token), expiresAt, idleExpiresAt, now]);

  return { sessionId, token, expiresAt };
}

export function serializeSessionCookie(token: string, expiresAt: Date): string {
  return `${sessionCookieName}=${encodeURIComponent(token)}; Path=/; Expires=${expiresAt.toUTCString()}; HttpOnly; Secure; SameSite=Lax`;
}

export function serializeExpiredSessionCookie(): string {
  return `${sessionCookieName}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (key === name) return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return undefined;
}

export async function resolveAuthSession(request: Request, now = new Date()): Promise<AuthenticatedSession | undefined> {
  const token = readCookie(request, sessionCookieName);
  if (!token) return undefined;
  const result = await postgresPool().query<{
    session_id: string;
    user_id: string;
    principal_id: string;
    display_name: string;
    primary_email: string;
    expires_at: Date;
  }>(`
    SELECT s.id session_id, s.user_id, s.principal_id, u.display_name, u.primary_email, s.expires_at
    FROM auth_sessions s
    JOIN users u ON u.id = s.user_id
    JOIN principals p ON p.id = s.principal_id
    WHERE s.token_hash = $1
      AND s.revoked_at IS NULL
      AND s.expires_at > $2
      AND s.idle_expires_at > $2
      AND u.status = 'active'
      AND p.status = 'active'
    LIMIT 1
  `, [hashSessionToken(token), now]);
  const row = result.rows[0];
  if (!row) return undefined;
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    principalId: row.principal_id,
    displayName: row.display_name,
    primaryEmail: row.primary_email,
    expiresAt: row.expires_at.toISOString(),
  };
}

export async function revokeAuthSession(sessionId: string, now = new Date()): Promise<void> {
  await postgresPool().query(
    "UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, $2) WHERE id = $1",
    [sessionId, now],
  );
}

export function isSameOriginMutation(request: Request): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) return true;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}
