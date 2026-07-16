import type { Pool } from "pg";
import { postgresPool } from "@/db/postgres";
import { newFolioId } from "@/lib/folio-ids";
import { FoundationServiceError } from "@/services/foundation/errors";
import { inTransaction } from "@/services/foundation/internal";
import type { Reminder } from "@/services/reminders";

type ReminderRow = {
  id: string;
  todo_id: string | null;
  calendar_entry_id: string | null;
  recipient_principal_id: string;
  remind_at: Date;
  state: Reminder["state"];
  delivery_channel: Reminder["deliveryChannel"];
  deduplication_key: string;
  attempt_count: number;
  max_attempts: number;
  available_at: Date;
  leased_until: Date | null;
  leased_by: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  sent_at: Date | null;
  created_at: Date;
  updated_at: Date;
  workspace_id: string;
  project_id: string;
  created_by_principal_id: string;
};

const columns = `
  id,todo_id,calendar_entry_id,recipient_principal_id,remind_at,state,
  delivery_channel,deduplication_key,attempt_count,max_attempts,available_at,
  leased_until,leased_by,last_error_code,last_error_message,sent_at,created_at,updated_at,
  workspace_id,project_id,created_by_principal_id
`;

function map(row: ReminderRow): Reminder {
  return {
    id: row.id,
    todoId: row.todo_id,
    calendarEntryId: row.calendar_entry_id,
    recipientPrincipalId: row.recipient_principal_id,
    remindAt: row.remind_at.toISOString(),
    state: row.state,
    deliveryChannel: row.delivery_channel,
    deduplicationKey: row.deduplication_key,
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    availableAt: row.available_at.toISOString(),
    leasedUntil: row.leased_until?.toISOString() ?? null,
    leasedBy: row.leased_by,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    sentAt: row.sent_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function claimReminderForDelivery(
  input: { workspaceId: string; reminderId: string; workerId: string; leaseSeconds?: number },
  pool: Pool = postgresPool(),
): Promise<(Reminder & { projectId: string; createdByPrincipalId: string }) | null> {
  const lease = Math.max(5, Math.min(input.leaseSeconds ?? 60, 3600));
  return inTransaction(pool, async (client) => {
    await client.query("SET LOCAL ROLE folio_worker");
    const result = await client.query<ReminderRow>(`
      UPDATE reminders
      SET state='leased',attempt_count=attempt_count+1,leased_by=$3,
        leased_until=now()+make_interval(secs=>$4),updated_at=now()
      WHERE workspace_id=$1 AND id=$2 AND remind_at<=now() AND available_at<=now()
        AND (state='pending' OR state='failed' OR (state='leased' AND leased_until<now()))
        AND attempt_count<max_attempts
      RETURNING ${columns}
    `, [input.workspaceId,input.reminderId,input.workerId,lease]);
    const row = result.rows[0];
    return row ? { ...map(row), projectId: row.project_id, createdByPrincipalId: row.created_by_principal_id } : null;
  });
}

export async function finishReminderDelivery(
  input: {
    workspaceId: string;
    reminderId: string;
    workerId: string;
    success: boolean;
    errorCode?: string;
    errorMessage?: string;
  },
  pool: Pool = postgresPool(),
): Promise<Reminder> {
  return inTransaction(pool, async (client) => {
    await client.query("SET LOCAL ROLE folio_worker");
    const current = await client.query<ReminderRow>(`
      SELECT ${columns} FROM reminders
      WHERE workspace_id=$1 AND id=$2 FOR UPDATE
    `, [input.workspaceId,input.reminderId]);
    const row = current.rows[0];
    if (!row) throw new FoundationServiceError("NOT_FOUND", "Reminder was not found.");
    if (row.state !== "leased" || row.leased_by !== input.workerId) {
      throw new FoundationServiceError("CONFLICT", "Reminder lease is not owned by this worker.");
    }
    const terminal = !input.success && row.attempt_count >= row.max_attempts;
    const backoffSeconds = Math.min(3600, Math.max(30, 2 ** Math.min(row.attempt_count, 10) * 15));
    const result = await client.query<ReminderRow>(`
      UPDATE reminders SET
        state=CASE WHEN $4::boolean THEN 'sent' ELSE 'failed' END,
        sent_at=CASE WHEN $4::boolean THEN now() ELSE NULL END,
        available_at=CASE WHEN $4::boolean OR $5::boolean
          THEN available_at ELSE now()+make_interval(secs=>$6) END,
        leased_until=NULL,leased_by=NULL,
        last_error_code=CASE WHEN $4::boolean THEN NULL ELSE $7 END,
        last_error_message=CASE WHEN $4::boolean THEN NULL ELSE left($8,500) END,
        updated_at=now()
      WHERE workspace_id=$1 AND id=$2 AND leased_by=$3
      RETURNING ${columns}
    `, [input.workspaceId,input.reminderId,input.workerId,input.success,terminal,
      backoffSeconds,input.errorCode ?? "DELIVERY_FAILED",
      input.errorMessage ?? "Reminder delivery failed"]);
    const data = map(result.rows[0]!);
    await client.query(`
      INSERT INTO operation_metrics(
        id,workspace_id,project_id,metric_name,metric_value,dimensions
      ) VALUES($1,$2,$3,$4,1,$5)
    `, [newFolioId(),row.workspace_id,row.project_id,
      input.success ? "reminder.delivery.succeeded" : "reminder.delivery.failed",
      { attempt: data.attemptCount, terminal }]);
    return data;
  });
}
