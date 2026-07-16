import { eq } from "drizzle-orm";
import { db, sqlite } from "@/db/client";
import { migrate } from "@/db/migrate";
import { migratePostgres } from "@/db/postgres-migrate";
import { jobs } from "@/db/schema";
import { env, folioDatabaseConfigured } from "@/lib/env";
import { now } from "@/lib/ids";
import { syncSource } from "@/services/sync";
import { runGitHubWorkerCycle } from "@/worker/github-worker";
import { runScheduleWorkerCycle } from "@/worker/schedule-worker";

async function claimLegacyJob() {
  const timestamp = now();
  const lease = new Date(Date.now() + env.WORKER_LEASE_SECONDS * 1000).toISOString();
  return sqlite().transaction(() => {
    const job = sqlite().prepare(`
      SELECT * FROM jobs
      WHERE (status='pending' OR (status='running' AND lease_expires_at < ?))
        AND available_at <= ?
      ORDER BY created_at LIMIT 1
    `).get(timestamp, timestamp) as { id: string; payload: string; type: string } | undefined;
    if (!job) return undefined;
    sqlite().prepare(`
      UPDATE jobs SET status='running',attempts=attempts+1,lease_expires_at=?,updated_at=?
      WHERE id=?
    `).run(lease, timestamp, job.id);
    return job;
  })();
}

async function processLegacyJob() {
  const job = await claimLegacyJob();
  if (!job) return false;
  try {
    if (job.type !== "sync-source") throw new Error(`Unsupported legacy job type: ${job.type}`);
    const payload = JSON.parse(job.payload) as { sourceId: string };
    await syncSource(payload.sourceId);
    await db().update(jobs).set({ status: "succeeded", leaseExpiresAt: null, updatedAt: now() }).where(eq(jobs.id, job.id));
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "Job failed";
    await db().update(jobs).set({ status: "failed", leaseExpiresAt: null, lastError: message, updatedAt: now() }).where(eq(jobs.id, job.id));
    console.error(`Legacy job ${job.id} failed: ${message}`);
  }
  return true;
}

async function loop(workerId: string) {
  let worked = false;
  if (folioDatabaseConfigured()) {
    try {
      worked = (await runScheduleWorkerCycle(workerId)) > 0 || worked;
    } catch (error) {
      console.error(`PostgreSQL scheduling worker cycle failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    try {
      worked = (await runGitHubWorkerCycle(workerId)) > 0 || worked;
    } catch (error) {
      console.error(`PostgreSQL GitHub worker cycle failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
  try {
    worked = await processLegacyJob() || worked;
  } catch (error) {
    console.error(`Legacy worker cycle failed: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  setTimeout(() => void loop(workerId), worked ? 50 : env.WORKER_POLL_MS);
}

async function main() {
  migrate();
  await migratePostgres();
  const workerId = `${process.env.HOSTNAME || "local"}:${process.pid}`;
  console.log(`Folio worker is ready as ${workerId}.`);
  await loop(workerId);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Folio worker failed to start.");
  process.exitCode = 1;
});
