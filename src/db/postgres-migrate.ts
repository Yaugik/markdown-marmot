import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { folioDatabaseConfigured } from "@/lib/env";
import { withPostgresClient } from "./postgres";

const MIGRATION_LOCK_ID = 6_746_520_001;
const compatibleHistoricalChecksums: Readonly<Record<string, ReadonlySet<string>>> = {
  // The first development application of 0002 included one additional trailing
  // newline. Its SQL is byte-for-byte identical after trailing-whitespace trim.
  "0002_database_isolation.sql": new Set([
    "fac4fa5ef1c9fac20c2c44a35479b03d2d2a1efaa1bc7081765d8e530e6ca69b",
  ]),
  // An unreleased development build applied 0003 with UUID transaction IDs
  // under the `folio` schema. 0004 safely creates/copies the canonical public
  // tables without deleting the historical objects.
  "0003_auth_sessions.sql": new Set([
    "801ddd7e5bb8ad4c447f238cea153f6de2a6da17c2483d708ecb7bfb23a1c81d",
  ]),
};

export type Migration = {
  name: string;
  sql: string;
  checksum: string;
};

export async function loadPostgresMigrations(directory = path.join(process.cwd(), "migrations")): Promise<Migration[]> {
  const names = (await readdir(directory))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort();

  return Promise.all(names.map(async (name) => {
    const sql = await readFile(path.join(directory, name), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    return { name, sql, checksum };
  }));
}

export async function migratePostgres(): Promise<{ applied: string[]; skipped: boolean }> {
  if (!folioDatabaseConfigured()) return { applied: [], skipped: true };

  const migrations = await loadPostgresMigrations();
  return withPostgresClient(async (client) => {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    const applied: string[] = [];
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS public.schema_migrations (
          name text PRIMARY KEY,
          checksum text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);

      const existing = await client.query<{ name: string; checksum: string }>(
        "SELECT name, checksum FROM public.schema_migrations ORDER BY name",
      );
      const byName = new Map(existing.rows.map((row) => [row.name, row.checksum]));

      for (const migration of migrations) {
        const previousChecksum = byName.get(migration.name);
        if (previousChecksum && previousChecksum !== migration.checksum
          && !compatibleHistoricalChecksums[migration.name]?.has(previousChecksum)) {
          throw new Error(`Applied migration ${migration.name} has been modified.`);
        }
        if (previousChecksum) continue;

        await client.query("BEGIN");
        try {
          await client.query("SET LOCAL search_path TO public, pg_catalog");
          await client.query(migration.sql);
          await client.query(
            "INSERT INTO public.schema_migrations (name, checksum) VALUES ($1, $2)",
            [migration.name, migration.checksum],
          );
          await client.query("COMMIT");
          applied.push(migration.name);
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      }
      return { applied, skipped: false };
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
    }
  });
}
