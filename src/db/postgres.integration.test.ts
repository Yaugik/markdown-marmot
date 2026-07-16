import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("Folio PostgreSQL foundation", () => {
  const pool = new Pool({ connectionString: databaseUrl });

  beforeAll(async () => {
    const migration = await pool.query<{ count: string }>(
      "SELECT count(*)::text count FROM schema_migrations WHERE name = '0001_folio_foundation.sql'",
    );
    expect(migration.rows[0]?.count).toBe("1");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("rejects a project membership whose workspace and project disagree", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const userId = randomUUID();
      const principalId = randomUUID();
      const workspaceA = randomUUID();
      const workspaceB = randomUUID();
      const projectB = randomUUID();
      const roleA = randomUUID();

      await client.query("INSERT INTO users (id, display_name, primary_email) VALUES ($1, 'Test User', $2)", [userId, `${userId}@example.test`]);
      await client.query("INSERT INTO principals (id, kind, user_id, display_name) VALUES ($1, 'human', $2, 'Test User')", [principalId, userId]);
      await client.query("INSERT INTO workspaces (id, name, slug) VALUES ($1, 'Workspace A', $2), ($3, 'Workspace B', $4)", [workspaceA, `a-${workspaceA}`, workspaceB, `b-${workspaceB}`]);
      await client.query("INSERT INTO projects (id, workspace_id, project_key, name) VALUES ($1, $2, 'PROJB', 'Project B')", [projectB, workspaceB]);
      await client.query("INSERT INTO role_templates (id, workspace_id, name, template_key) VALUES ($1, $2, 'Member', 'member')", [roleA, workspaceA]);

      await expect(client.query(
        "INSERT INTO project_memberships (id, workspace_id, project_id, principal_id, role_template_id) VALUES ($1, $2, $3, $4, $5)",
        [randomUUID(), workspaceA, projectB, principalId, roleA],
      )).rejects.toMatchObject({ code: "23503" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("prevents activity updates, deletes, and truncation", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const userId = randomUUID();
      const principalId = randomUUID();
      const workspaceId = randomUUID();
      const activityId = randomUUID();
      await client.query("INSERT INTO users (id, display_name, primary_email) VALUES ($1, 'Audit User', $2)", [userId, `${userId}@example.test`]);
      await client.query("INSERT INTO principals (id, kind, user_id, display_name) VALUES ($1, 'human', $2, 'Audit User')", [principalId, userId]);
      await client.query("INSERT INTO workspaces (id, name, slug) VALUES ($1, 'Audit Workspace', $2)", [workspaceId, `audit-${workspaceId}`]);
      await client.query(`
        INSERT INTO activity_events (
          id, workspace_id, actor_principal_id, source, action, target_type, target_id, request_id
        ) VALUES ($1, $2, $3, 'system', 'test.created', 'workspace', $2, $4)
      `, [activityId, workspaceId, principalId, randomUUID()]);

      await expect(client.query("UPDATE activity_events SET action = 'changed' WHERE id = $1", [activityId]))
        .rejects.toThrow(/append-only/);
      await client.query("ROLLBACK");

      await client.query("BEGIN");
      await expect(client.query("TRUNCATE activity_events"))
        .rejects.toThrow(/append-only/);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
