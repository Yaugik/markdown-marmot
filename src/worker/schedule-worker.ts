import type { Pool } from "pg";
import { postgresPool } from "@/db/postgres";
import { establishTenantContext } from "@/db/tenant";
import { newFolioId } from "@/lib/folio-ids";
import { runCalendarProviderOperation } from "@/services/calendar-provider-worker";
import { claimDurableJobs, enqueueDurableJob, finishDurableJob, type DurableJob } from "@/services/durable-jobs";
import { FoundationServiceError } from "@/services/foundation/errors";
import { inTransaction } from "@/services/foundation/internal";
import { ensureTodoOccurrences, materializeDueTodoOccurrences } from "@/services/todo-recurrence";
import { finishReminderAttempt } from "@/services/reminders";

const supportedKinds = ["reminder.delivery", "todo.recurrence.sweep", "calendar.provider_operation"];

function dateKey(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

async function runReminderJob(job: DurableJob, workerId: string, pool: Pool) {
  if (!job.workspaceId) throw new FoundationServiceError("VALIDATION_FAILED", "Reminder job requires a workspace.");
  const reminderId = typeof job.payload.reminderId === "string" ? job.payload.reminderId : null;
  if (!reminderId) throw new FoundationServiceError("VALIDATION_FAILED", "Reminder job payload is invalid.");
  const reminder = await inTransaction(pool, async (client) => {
    await establishTenantContext(client, job.workspaceId!, newFolioId());
    const result = await client.query<{
      id: string;
      state: string;
      delivery_channel: "in_app" | "email" | "provider";
      attempt_count: number;
      max_attempts: number;
      created_by_principal_id: string;
      project_id: string;
      recipient_principal_id: string;
    }>(`
      UPDATE reminders
      SET state='leased',attempt_count=attempt_count+1,leased_by=$3,
        leased_until=now()+interval '60 seconds',updated_at=now()
      WHERE workspace_id=$1 AND id=$2 AND remind_at<=now() AND available_at<=now()
        AND (state='pending' OR state='failed' OR (state='leased' AND leased_until<now()))
        AND attempt_count<max_attempts
      RETURNING id,state,delivery_channel,attempt_count,max_attempts,
        created_by_principal_id,project_id,recipient_principal_id
    `, [job.workspaceId, reminderId, workerId]);
    return result.rows[0] ?? null;
  });
  if (!reminder) return { reminderId, state: "already_terminal_or_not_due" };
  if (reminder.delivery_channel !== "in_app") {
    await finishReminderAttempt({
      workspaceId: job.workspaceId,
      reminderId,
      workerId,
      success: false,
      errorCode: "DELIVERY_ADAPTER_MISSING",
      errorMessage: `${reminder.delivery_channel} reminder delivery is not configured.`,
    }, pool);
    throw new FoundationServiceError("CONFLICT", `${reminder.delivery_channel} reminder delivery is not configured.`);
  }
  const delivered = await finishReminderAttempt({
    workspaceId: job.workspaceId,
    reminderId,
    workerId,
    success: true,
  }, pool);
  await inTransaction(pool, async (client) => {
    await establishTenantContext(client, job.workspaceId!, reminder.recipient_principal_id);
    const requestId = newFolioId();
    await client.query(`
      INSERT INTO activity_events(
        id,workspace_id,project_id,actor_principal_id,authorizing_principal_id,source,
        action,target_type,target_id,input_summary,result_summary,request_id
      ) VALUES($1,$2,$3,$4,$4,'worker','reminder.delivered','reminder',$5,$6,$7,$8)
    `, [newFolioId(),job.workspaceId,reminder.project_id,reminder.created_by_principal_id,
      reminderId,{deliveryChannel:"in_app"},
      {reminderId,recipientPrincipalId:reminder.recipient_principal_id},requestId]);
    await client.query(`
      INSERT INTO outbox_events(
        id,workspace_id,project_id,aggregate_type,aggregate_id,aggregate_revision,event_type,
        actor_principal_id,authorizing_principal_id,request_id,payload
      ) VALUES($1,$2,$3,'reminder',$4,$5,'reminder.delivered.v1',$6,$6,$7,$8)
    `, [newFolioId(),job.workspaceId,reminder.project_id,reminderId,
      Math.max(1, delivered.attemptCount),reminder.created_by_principal_id,requestId,
      {reminderId,recipientPrincipalId:reminder.recipient_principal_id}]);
  });
  return { reminderId, state: delivered.state };
}

async function runRecurrenceSweep(job: DurableJob, pool: Pool) {
  const rules = await pool.query<{
    workspace_id: string;
    project_id: string;
    todo_id: string;
    created_by_principal_id: string;
  }>(`
    SELECT workspace_id,project_id,todo_id,created_by_principal_id
    FROM todo_recurrence_rules
    WHERE archived_at IS NULL
    ORDER BY updated_at,todo_id
    LIMIT 1000
  `);
  const now = new Date();
  const windowStart = dateKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())));
  const windowEnd = dateKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 45)));
  let expanded = 0;
  let materialized = 0;
  const failures: Array<{ todoId: string; message: string }> = [];
  const projects = new Map<string, {
    workspaceId: string;
    projectId: string;
    actorPrincipalId: string;
  }>();

  for (const rule of rules.rows) {
    try {
      const occurrences = await ensureTodoOccurrences({
        workspaceId: rule.workspace_id,
        projectId: rule.project_id,
        todoId: rule.todo_id,
        windowStart,
        windowEnd,
        limit: 500,
      }, rule.created_by_principal_id, pool);
      expanded += occurrences.length;
      projects.set(`${rule.workspace_id}:${rule.project_id}`, {
        workspaceId: rule.workspace_id,
        projectId: rule.project_id,
        actorPrincipalId: rule.created_by_principal_id,
      });
    } catch (error) {
      failures.push({
        todoId: rule.todo_id,
        message: error instanceof Error ? error.message.slice(0, 200) : "Recurrence expansion failed.",
      });
    }
  }

  for (const project of projects.values()) {
    try {
      const result = await materializeDueTodoOccurrences({
        workspaceId: project.workspaceId,
        projectId: project.projectId,
        through: now.toISOString(),
        limit: 500,
      }, project.actorPrincipalId, pool);
      materialized += result.materialized.length;
    } catch (error) {
      failures.push({
        todoId: `project:${project.projectId}`,
        message: error instanceof Error ? error.message.slice(0, 200) : "Recurrence materialization failed.",
      });
    }
  }

  const next = new Date(Date.now() + 60 * 60 * 1000);
  const bucket = next.toISOString().slice(0, 13);
  await enqueueDurableJob({
    kind: "todo.recurrence.sweep",
    payload: {},
    deduplicationKey: `todo-recurrence-sweep:${bucket}`,
    availableAt: next.toISOString(),
    maxAttempts: 10,
  }, pool);
  return {
    sourceJobId: job.id,
    rules: rules.rowCount,
    projects: projects.size,
    expanded,
    materialized,
    failures,
  };
}

async function executeJob(job: DurableJob, workerId: string, pool: Pool) {
  if (job.kind === "reminder.delivery") return runReminderJob(job, workerId, pool);
  if (job.kind === "todo.recurrence.sweep") return runRecurrenceSweep(job, pool);
  if (job.kind === "calendar.provider_operation") {
    const operationId = typeof job.payload.operationId === "string" ? job.payload.operationId : null;
    if (!operationId) throw new FoundationServiceError("VALIDATION_FAILED", "Provider job payload is invalid.");
    return runCalendarProviderOperation(operationId, pool);
  }
  throw new FoundationServiceError("VALIDATION_FAILED", `Unsupported durable job kind: ${job.kind}`);
}

export async function runScheduleWorkerCycle(
  workerId: string,
  pool: Pool = postgresPool(),
): Promise<number> {
  const jobs = await claimDurableJobs({ workerId, kinds: supportedKinds, limit: 10 }, pool);
  for (const job of jobs) {
    try {
      const result = await executeJob(job, workerId, pool);
      await finishDurableJob({ jobId: job.id, workerId, success: true, result }, pool);
    } catch (error) {
      const code = error instanceof FoundationServiceError ? error.code : "JOB_HANDLER_FAILED";
      const message = error instanceof Error ? error.message : "Job handler failed.";
      const nonRetryable = code === "VALIDATION_FAILED"
        || (code === "CONFLICT" && message.includes("not configured"));
      await finishDurableJob({
        jobId: job.id,
        workerId,
        success: false,
        errorCode: code,
        errorMessage: message,
        retryable: !nonRetryable,
      }, pool);
    }
  }
  return jobs.length;
}
