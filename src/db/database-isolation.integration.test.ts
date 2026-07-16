import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

async function insertFixture(client: PoolClient) {
  const principalId = randomUUID();
  const workspaceA = randomUUID();
  const workspaceB = randomUUID();
  const projectA = randomUUID();
  const projectB = randomUUID();

  await client.query(
    "INSERT INTO principals (id, kind, display_name) VALUES ($1, 'worker', 'Isolation Test Worker')",
    [principalId],
  );
  await client.query(
    "INSERT INTO workspaces (id, name, slug) VALUES ($1, 'Visible Workspace', $2), ($3, 'Hidden Workspace', $4)",
    [workspaceA, `visible-${workspaceA}`, workspaceB, `hidden-${workspaceB}`],
  );
  await client.query(
    "INSERT INTO projects (id, workspace_id, project_key, name) VALUES ($1, $2, 'VISIBLE', 'Visible Project'), ($3, $4, 'HIDDEN', 'Hidden Project')",
    [projectA, workspaceA, projectB, workspaceB],
  );

  return { principalId, workspaceA, workspaceB, projectA };
}

describeWithPostgres("Folio PostgreSQL runtime isolation", () => {
  const pool = new Pool({ connectionString: databaseUrl });

  beforeAll(async () => {
    const migration = await pool.query<{ count: string }>(
      "SELECT count(*)::text count FROM schema_migrations WHERE name = '0002_database_isolation.sql'",
    );
    expect(migration.rows[0]?.count).toBe("1");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("denies tenant reads until transaction-local context is established", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await insertFixture(client);
      await client.query("SET LOCAL ROLE folio_runtime");

      const result = await client.query("SELECT id FROM workspaces");
      expect(result.rows).toEqual([]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("limits SELECT and INSERT to the transaction workspace for web and worker transactions", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const fixture = await insertFixture(client);
      await client.query("SET LOCAL ROLE folio_runtime");
      await client.query("SELECT folio.set_transaction_context($1, $2)", [
        fixture.workspaceA,
        fixture.principalId,
      ]);

      const workspaces = await client.query<{ id: string }>(
        "SELECT id FROM workspaces ORDER BY id",
      );
      expect(workspaces.rows).toEqual([{ id: fixture.workspaceA }]);

      const projects = await client.query<{ id: string }>(
        "SELECT id FROM projects ORDER BY id",
      );
      expect(projects.rows).toEqual([{ id: fixture.projectA }]);

      await client.query("SAVEPOINT denied_insert");
      await expect(
        client.query(
          "INSERT INTO projects (id, workspace_id, project_key, name) VALUES ($1, $2, 'DENIED', 'Denied Project')",
          [randomUUID(), fixture.workspaceB],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await client.query("ROLLBACK TO SAVEPOINT denied_insert");

      await client.query(
        "INSERT INTO projects (id, workspace_id, project_key, name) VALUES ($1, $2, 'ALLOWED', 'Allowed Project')",
        [randomUUID(), fixture.workspaceA],
      );
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
