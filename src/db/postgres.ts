import { Pool, type PoolClient } from "pg";
import { readFileSync } from "node:fs";
import { env, folioDatabaseConfigured } from "@/lib/env";

const globalPostgres = globalThis as unknown as { folioPool?: Pool };

export function postgresPool(): Pool {
  if (!folioDatabaseConfigured() || !env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for the Folio PostgreSQL database.");
  }

  if (!globalPostgres.folioPool) {
    globalPostgres.folioPool = new Pool({
      connectionString: env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ssl: env.DATABASE_SSL === "require" ? {
        rejectUnauthorized: true,
        ca: env.DATABASE_CA_CERT_PATH ? readFileSync(env.DATABASE_CA_CERT_PATH, "utf8") : undefined,
      } : false,
      application_name: "folio",
    });
  }

  return globalPostgres.folioPool;
}

export async function withPostgresClient<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await postgresPool().connect();
  try {
    return await work(client);
  } finally {
    client.release();
  }
}

export async function closePostgresPool(): Promise<void> {
  if (globalPostgres.folioPool) {
    await globalPostgres.folioPool.end();
    delete globalPostgres.folioPool;
  }
}
