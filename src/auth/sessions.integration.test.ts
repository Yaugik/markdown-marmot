import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createAuthSession, resolveAuthSession, revokeAuthSession, serializeSessionCookie } from "./sessions";
import { createAuthTransaction, oidcConfigSchema, PostgresAuthTransactionStore } from "./oidc";

const databaseUrl = process.env.DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("opaque database sessions", () => {
  const pool = new Pool({ connectionString: databaseUrl });

  afterAll(async () => {
    await pool.end();
  });

  it("resolves an active token and rejects it after revocation", async () => {
    const client = await pool.connect();
    const userId = randomUUID();
    const principalId = randomUUID();
    let sessionId: string | undefined;
    try {
      await client.query("INSERT INTO users (id, display_name, primary_email) VALUES ($1, 'Session User', $2)", [userId, `${userId}@example.test`]);
      await client.query("INSERT INTO principals (id, kind, user_id, display_name) VALUES ($1, 'human', $2, 'Session User')", [principalId, userId]);
      const created = await createAuthSession(client, { userId, principalId });
      sessionId = created.sessionId;
      const request = new Request("https://folio.test/api/v1/session", {
        headers: { cookie: serializeSessionCookie(created.token, created.expiresAt).split(";")[0] },
      });

      await expect(resolveAuthSession(request)).resolves.toMatchObject({ userId, principalId });
      await revokeAuthSession(created.sessionId);
      await expect(resolveAuthSession(request)).resolves.toBeUndefined();
    } finally {
      if (sessionId) await client.query("DELETE FROM auth_sessions WHERE id = $1", [sessionId]);
      await client.query("DELETE FROM principals WHERE id = $1", [principalId]);
      await client.query("DELETE FROM users WHERE id = $1", [userId]);
      client.release();
    }
  });

  it("consumes an OIDC transaction exactly once", async () => {
    const config = oidcConfigSchema.parse({
      issuer: "https://identity.example.test",
      clientId: "folio-test",
      redirectUri: "https://folio.test/api/auth/oidc/callback",
      scopes: ["openid", "profile", "email"],
      stateSigningKey: new Uint8Array(32).fill(9),
    });
    const created = createAuthTransaction(config);
    const store = new PostgresAuthTransactionStore();
    await store.save(created.transaction);
    await expect(store.consume(created.transaction.id, new Date())).resolves.toMatchObject({
      id: created.transaction.id,
      consumedAt: expect.any(Date),
    });
    await expect(store.consume(created.transaction.id, new Date())).resolves.toBeNull();
  });
});
