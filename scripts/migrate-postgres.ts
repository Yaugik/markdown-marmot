import { closePostgresPool } from "../src/db/postgres";
import { migratePostgres } from "../src/db/postgres-migrate";

async function main() {
  try {
    const result = await migratePostgres();
    if (result.skipped) {
      console.log("Folio PostgreSQL migration skipped: DATABASE_URL is not configured.");
    } else if (result.applied.length) {
      console.log(`Applied Folio PostgreSQL migrations: ${result.applied.join(", ")}`);
    } else {
      console.log("Folio PostgreSQL database is up to date.");
    }
  } finally {
    await closePostgresPool();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "PostgreSQL migration failed.");
  process.exitCode = 1;
});
