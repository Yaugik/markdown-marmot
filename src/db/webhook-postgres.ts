import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { env, folioDatabaseConfigured } from "@/lib/env";

const globalWebhook = globalThis as unknown as { folioWebhookPool?: Pool };

export function webhookPostgresPool(): Pool {
  if (!folioDatabaseConfigured() || !env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for GitHub webhook ingestion.");
  }
  if (!globalWebhook.folioWebhookPool) {
    globalWebhook.folioWebhookPool = new Pool({
      connectionString: env.DATABASE_URL,
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ssl: env.DATABASE_SSL === "require" ? {
        rejectUnauthorized: true,
        ca: env.DATABASE_CA_CERT_PATH ? readFileSync(env.DATABASE_CA_CERT_PATH, "utf8") : undefined,
      } : false,
      application_name: "folio-webhook",
      options: "-c role=folio_webhook",
    });
  }
  return globalWebhook.folioWebhookPool;
}
