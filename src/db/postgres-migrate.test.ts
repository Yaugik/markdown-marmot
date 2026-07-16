import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadPostgresMigrations } from "./postgres-migrate";

describe("Folio PostgreSQL migrations", () => {
  it("loads migrations in deterministic order with stable checksums", async () => {
    const migrations = await loadPostgresMigrations();
    expect(migrations.map((migration) => migration.name)).toEqual([
      "0001_folio_foundation.sql",
      "0002_database_isolation.sql",
      "0003_auth_sessions.sql",
      "0004_auth_schema_repair.sql",
      "0005_native_pages.sql",
    ]);
    expect(migrations[0]?.checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it("defines the tenant, authorization, concurrency, and audit foundations", async () => {
    const sql = await readFile(path.join(process.cwd(), "migrations/0001_folio_foundation.sql"), "utf8");
    for (const expected of [
      "CREATE TABLE principals",
      "CREATE TABLE workspaces",
      "CREATE TABLE projects",
      "CREATE TABLE project_memberships",
      "CREATE TABLE capability_grants",
      "CREATE TABLE object_grants",
      "CREATE TABLE activity_events",
      "CREATE TABLE outbox_events",
      "CREATE TABLE idempotency_records",
      "CREATE TABLE jobs",
      "revision bigint",
      "activity_events_append_only",
    ]) expect(sql).toContain(expected);
  });

  it("defines immutable native pages and project-owned tree placements", async () => {
    const sql = await readFile(path.join(process.cwd(), "migrations/0005_native_pages.sql"), "utf8");
    for (const expected of [
      "CREATE TABLE pages",
      "CREATE TABLE native_pages",
      "CREATE TABLE native_page_revisions",
      "CREATE TABLE page_tree_nodes",
      "native_page_revisions_immutable",
      "folio_runtime_workspace_scope",
    ]) expect(sql).toContain(expected);
  });
});
