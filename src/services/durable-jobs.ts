import type { Pool } from "pg";
import { postgresPool } from "@/db/postgres";
import { newFolioId } from "@/lib/folio-ids";
import { FoundationServiceError } from "@/services/foundation/errors";
import { inTransaction } from "@/services/foundation/internal";

export type DurableJob = {
  id: string;
  workspaceId: string | null;
  projectId: string | null;
  kind: string;
  payload: Record<string, unknown>;
  status: string;
  priority: number;
  attemptCount: number;
  maxAttempts: number;
  availableAt: string;
  leasedUntil: string | null;
  leasedBy: string | null;
};

type JobRow = {
  id: string; workspace_id: string | null; project_id: string | null; kind: string;
  payload: Record<string, unknown>; status: string; priority: number; attempt_count: number;
  max_attempts: number; available_at: Date; leased_until: Date | null; leased_by: string | null;
};

function map(row: JobRow): DurableJob {
  return {
    id: row.id, workspaceId: row.workspace_id, projectId: row.project_id,
    kind: row.kind, payload: row.payload, status: row.status,
    priority: Number(row.priority), attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts), availableAt: row.available_at.toISOString(),
    leasedUntil: row.leased_until?.toISOString() ?? null, leasedBy: row.leased_by,
  };
}

export async function claimDurableJobs(
  input: { workerId: string; kinds: string[]; leaseSeconds?: number; limit?: number },
  pool: Pool = postgresPool(),
): Promise<DurableJob[]> {
  const workerId = input.workerId.trim();
  if (!workerId || workerId.length > 180) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Worker ID is invalid.");
  }
  const kinds = [...new Set(input.kinds)].filter(Boolean);
  if (!kinds.length) throw new FoundationServiceError("VALIDATION_FAILED", "Worker must support at least one job kind.");
  const lease = Math.max(5, Math.min(input.leaseSeconds ?? 60, 3600));
  const limit = Math.max(1, Math.min(input.limit ?? 10, 100));
  return inTransaction(pool, async (client) => {
    await client.query("SET LOCAL ROLE folio_worker");
    const result = await client.query<JobRow>(`
      SELECT id,workspace_id,project_id,kind,payload,status,priority,attempt_count,
        max_attempts,available_at,leased_until,leased_by
      FROM claim_folio_jobs($1,$2,$3,$4)
    `, [workerId, kinds, lease, limit]);
    for (const row of result.rows) {
      await client.query(`
        INSERT INTO job_attempts(id,job_id,attempt_number,worker_id,state)
        VALUES($1,$2,$3,$4,'running')
        ON CONFLICT(job_id,attempt_number) DO NOTHING
      `, [newFolioId(), row.id, row.attempt_count, workerId]);
    }
    return result.rows.map(map);
  });
}

export async function finishDurableJob(
  input: {
    jobId: string;
    workerId: string;
    success: boolean;
    result?: Record<string, unknown>;
    errorCode?: string;
    errorMessage?: string;
    retryable?: boolean;
  },
  pool: Pool = postgresPool(),
): Promise<DurableJob> {
  return inTransaction(pool, async (client) => {
    await client.query("SET LOCAL ROLE folio_worker");
    const current = await client.query<JobRow>(`
      SELECT id,workspace_id,project_id,kind,payload,status,priority,attempt_count,
        max_attempts,available_at,leased_until,leased_by
      FROM jobs WHERE id=$1 FOR UPDATE
    `, [input.jobId]);
    const row = current.rows[0];
    if (!row) throw new FoundationServiceError("NOT_FOUND", "Job was not found.");
    if (row.status !== "running" || row.leased_by !== input.workerId) {
      throw new FoundationServiceError("CONFLICT", "Job lease is not owned by this worker.");
    }
    const retry = Boolean(!input.success && (input.retryable ?? true) && row.attempt_count < row.max_attempts);
    const delay = Math.min(3600, Math.max(15, 2 ** Math.min(row.attempt_count, 10) * 10));
    const result = await client.query<JobRow>(`
      UPDATE jobs SET
        status=CASE WHEN $3::boolean THEN 'succeeded' WHEN $4::boolean THEN 'pending' ELSE 'failed' END,
        available_at=CASE WHEN $4::boolean THEN now()+make_interval(secs=>$5) ELSE available_at END,
        leased_until=NULL,leased_by=NULL,
        last_error_code=CASE WHEN $3::boolean THEN NULL ELSE $6 END,
        last_error_message=CASE WHEN $3::boolean THEN NULL ELSE left($7,500) END,
        result=CASE WHEN $3::boolean THEN $8 ELSE result END,updated_at=now()
      WHERE id=$1 AND leased_by=$2
      RETURNING id,workspace_id,project_id,kind,payload,status,priority,attempt_count,
        max_attempts,available_at,leased_until,leased_by
    `, [input.jobId,input.workerId,input.success,retry,delay,input.errorCode ?? "JOB_FAILED",
      input.errorMessage ?? "Job execution failed",input.result ?? {}]);
    await client.query(`
      UPDATE job_attempts SET state=$4,completed_at=now(),error_code=$5,error_message=left($6,500)
      WHERE job_id=$1 AND attempt_number=$2 AND worker_id=$3 AND state='running'
    `, [input.jobId,row.attempt_count,input.workerId,input.success ? "succeeded" : "failed",
      input.success ? null : input.errorCode ?? "JOB_FAILED",
      input.success ? null : input.errorMessage ?? "Job execution failed"]);
    await client.query(`
      INSERT INTO operation_metrics(id,workspace_id,project_id,metric_name,metric_value,dimensions)
      VALUES($1,$2,$3,$4,1,$5)
    `, [newFolioId(),row.workspace_id,row.project_id,input.success ? "job.succeeded" : "job.failed",
      { kind: row.kind, retry, attempt: row.attempt_count }]);
    return map(result.rows[0]!);
  });
}

export async function enqueueDurableJob(
  input: {
    workspaceId?: string | null;
    projectId?: string | null;
    kind: string;
    payload: Record<string, unknown>;
    deduplicationKey?: string | null;
    availableAt?: string;
    priority?: number;
    maxAttempts?: number;
  },
  pool: Pool = postgresPool(),
): Promise<string> {
  const id = newFolioId();
  const available = input.availableAt ? new Date(input.availableAt) : new Date();
  if (Number.isNaN(available.getTime())) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Job availability time is invalid.");
  }
  return inTransaction(pool, async (client) => {
    const inserted = await client.query<{ id: string }>(`
      INSERT INTO jobs(id,workspace_id,project_id,kind,payload,deduplication_key,status,priority,max_attempts,available_at)
      VALUES($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9)
      ON CONFLICT DO NOTHING RETURNING id
    `, [id,input.workspaceId ?? null,input.projectId ?? null,input.kind,input.payload,
      input.deduplicationKey ?? null,input.priority ?? 100,input.maxAttempts ?? 5,available.toISOString()]);
    if (inserted.rows[0]) return inserted.rows[0].id;
    if (!input.deduplicationKey) {
      throw new FoundationServiceError("CONFLICT", "Durable job could not be enqueued.");
    }
    const existing = await client.query<{ id: string }>(`
      SELECT id FROM jobs
      WHERE kind=$1 AND deduplication_key=$2 AND status IN ('pending','running')
        AND workspace_id IS NOT DISTINCT FROM $3::uuid
        AND project_id IS NOT DISTINCT FROM $4::uuid
      ORDER BY created_at LIMIT 1
    `, [input.kind,input.deduplicationKey,input.workspaceId ?? null,input.projectId ?? null]);
    if (!existing.rows[0]) throw new FoundationServiceError("CONFLICT", "Deduplicated durable job was not found.");
    return existing.rows[0].id;
  });
}
