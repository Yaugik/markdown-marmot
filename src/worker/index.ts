import { eq } from "drizzle-orm";
import { db, sqlite } from "@/db/client";
import { migrate } from "@/db/migrate";
import { migratePostgres } from "@/db/postgres-migrate";
import { jobs } from "@/db/schema";
import { env } from "@/lib/env";
import { now } from "@/lib/ids";
import { syncSource } from "@/services/sync";

async function claimJob() {
  const timestamp = now();
  const lease = new Date(Date.now() + env.WORKER_LEASE_SECONDS * 1000).toISOString();
  return sqlite().transaction(() => {
    const job = sqlite().prepare(`SELECT * FROM jobs WHERE (status='pending' OR (status='running' AND lease_expires_at < ?)) AND available_at <= ? ORDER BY created_at LIMIT 1`).get(timestamp, timestamp) as { id: string; payload: string; type: string } | undefined;
    if (!job) return undefined;
    sqlite().prepare("UPDATE jobs SET status='running', attempts=attempts+1, lease_expires_at=?, updated_at=? WHERE id=?").run(lease, timestamp, job.id);
    return job;
  })();
}

async function loop() {
  const job = await claimJob();
  if (job) {
    try {
      if (job.type !== "sync-source") throw new Error(`Unsupported job type: ${job.type}`);
      const payload = JSON.parse(job.payload) as { sourceId: string };
      await syncSource(payload.sourceId);
      await db().update(jobs).set({ status: "succeeded", leaseExpiresAt: null, updatedAt: now() }).where(eq(jobs.id, job.id));
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : "Job failed";
      await db().update(jobs).set({ status: "failed", leaseExpiresAt: null, lastError: message, updatedAt: now() }).where(eq(jobs.id, job.id));
      console.error(`Job ${job.id} failed: ${message}`);
    }
  }
  setTimeout(loop, job ? 50 : env.WORKER_POLL_MS);
}

async function main() {
  migrate();
  await migratePostgres();
  console.log("Folio worker is ready.");
  await loop();
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Folio worker failed to start.");
  process.exitCode = 1;
});
