import type { Pool } from "pg";
import { postgresPool } from "@/db/postgres";
import { establishTenantContext } from "@/db/tenant";
import { newFolioId } from "@/lib/folio-ids";
import { executeAuditExportWithActivity } from "@/services/audit-export-worker";
import { runCalendarProviderOperation } from "@/services/calendar-provider-worker";
import { claimDurableJobs, enqueueDurableJob, finishDurableJob, type DurableJob } from "@/services/durable-jobs";
import { FoundationServiceError } from "@/services/foundation/errors";
import { inTransaction } from "@/services/foundation/internal";
import { claimReminderForDelivery, finishReminderDelivery } from "@/services/reminder-worker";
import { ensureTodoOccurrences, materializeDueTodoOccurrences } from "@/services/todo-recurrence";

const supportedKinds = ["reminder.delivery", "todo.recurrence.sweep", "calendar.provider_operation", "audit.export"];

function dateKey(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

async function runReminderJob(job: DurableJob, workerId: string, pool: Pool) {
  if (!job.workspaceId) throw new FoundationServiceError("VALIDATION_FAILED", "Reminder job requires a workspace.");
  const reminderId = typeof job.payload.reminderId === "string" ? job.payload.reminderId : null;
  if (!reminderId) throw new FoundationServiceError("VALIDATION_FAILED", "Reminder job payload is invalid.");

  const reminder = await claimReminderForDelivery({
    workspaceId: job.workspaceId,
    reminderId,
    workerId,
  }, pool);
  if (!reminder) return { reminderId, state: "already_terminal_or_not_due" };

  if (reminder.deliveryChannel !== "in_app") {
    await finishReminderDelivery({
      workspaceId: job.workspaceId,
      reminderId,
      workerId,
      success: false,
      errorCode: "DELIVERY_ADAPTER_MISSING",
      errorMessage: `${reminder.deliveryChannel} reminder delivery is not configured.`,
    }, pool);
    throw new FoundationServiceError(
      "CONFLICT",
      `${reminder.deliveryChannel} reminder delivery is not configured.`,
    );
  }

  const delivered = await finishReminderDelivery({
    workspaceId: job.workspaceId,
    reminderId,
    workerId,
    success: true,
  }, pool);

  await inTransaction(pool, async (client) => {
    await establishTenantContext(client, job.workspaceId!, reminder.recipientPrincipalId);
    const requestId = newFolioId();
    await client.query(`
      INSERT INTO activity_events(
        id,workspace_id,project_id,actor_principal_id,authorizing_principal_id,source,
        action,target_type,target_id,input_summary,result_summary,request_id
      ) VALUES($1,$2,$3,$4,$4,'worker','reminder.delivered','reminder',$5,$6,$7,$8)
    `, [newFolioId(),job.workspaceId,reminder.projectId,reminder.createdByPrincipalId,
      reminderId,{deliveryChannel:"in_app"},
      {reminderId,recipientPrincipalId:reminder.recipientPrincipalId},requestId]);
    await client.query(`
      INSERT INTO outbox_events(
        id,workspace_id,project_id,aggregate_type,aggregate_id,aggregate_revision,event_type,
        actor_principal_id,authorizing_principal_id,request_id,payload
      ) VALUES($1,$2,$3,'reminder',$4,$5,'reminder.delivered.v1',$6,$6,$7,$8)
    `, [newFolioId(),job.workspaceId,reminder.projectId,reminderId,
      Math.max(1, delivered.attemptCount),reminder.createdByPrincipalId,requestId,
      {reminderId,recipientPrincipalId:reminder.recipientPrincipalId}]);
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
  if (job.kind === "audit.export") {
    const exportId = typeof job.payload.exportId === "string" ? job.payload.exportId : null;
    if (!exportId) throw new FoundationServiceError("VALIDATION_FAILED", "Audit export job payload is invalid.");
    return executeAuditExportWithActivity(exportId, pool);
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
