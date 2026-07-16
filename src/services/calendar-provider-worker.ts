import type { Pool, PoolClient } from "pg";
import { postgresPool } from "@/db/postgres";
import { establishTenantContext } from "@/db/tenant";
import { newFolioId } from "@/lib/folio-ids";
import { calendarProviderAdapter, type CalendarProviderEvent } from "@/services/calendar-providers";
import {
  authorizeScheduleObject,
  authorizeScheduleProjectCapability,
  readCalendarPolicy,
} from "@/services/schedule-access";
import { FoundationServiceError } from "@/services/foundation/errors";
import { inTransaction } from "@/services/foundation/internal";

type OperationContext = {
  id: string;
  workspace_id: string;
  project_id: string;
  connection_id: string;
  binding_id: string | null;
  operation: "discover" | "pull" | "push" | "reconcile" | "revoke";
  created_by_principal_id: string;
  provider_key: string;
  secret_reference: string;
  connection_cursor: string | null;
  calendar_id: string | null;
  external_calendar_id: string | null;
  binding_cursor: string | null;
};

function validateProviderEvent(event: CalendarProviderEvent) {
  const externalId = event.externalId.trim();
  const title = event.title.trim();
  if (!externalId || externalId.length > 500) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Provider event ID is invalid.");
  }
  if (!title || title.length > 240) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Provider event title is invalid.");
  }
  const startsAt = new Date(event.startsAt);
  const endsAt = new Date(event.endsAt);
  const updatedAt = new Date(event.updatedAt);
  if ([startsAt, endsAt, updatedAt].some((value) => Number.isNaN(value.getTime())) || endsAt <= startsAt) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Provider event dates are invalid.");
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: event.timeZone }).format(startsAt);
  } catch {
    throw new FoundationServiceError("VALIDATION_FAILED", "Provider event time zone is invalid.");
  }
  return { ...event, externalId, title, startsAt, endsAt, updatedAt };
}

async function loadOperation(operationId: string, pool: Pool): Promise<OperationContext> {
  const result = await pool.query<OperationContext>(`
    SELECT o.id,o.workspace_id,o.project_id,o.connection_id,o.binding_id,o.operation,
      o.created_by_principal_id,c.provider_key,c.secret_reference,c.sync_cursor connection_cursor,
      b.calendar_id,b.external_calendar_id,b.sync_cursor binding_cursor
    FROM provider_operations o
    JOIN integration_connections c
      ON c.workspace_id=o.workspace_id AND c.project_id=o.project_id AND c.id=o.connection_id
    LEFT JOIN calendar_external_bindings b
      ON b.workspace_id=o.workspace_id AND b.project_id=o.project_id AND b.id=o.binding_id
    WHERE o.id=$1 AND o.state IN ('pending','failed')
  `, [operationId]);
  const row = result.rows[0];
  if (!row) throw new FoundationServiceError("NOT_FOUND", "Retryable provider operation was not found.");
  return row;
}

async function markRunning(operation: OperationContext, pool: Pool) {
  await inTransaction(pool, async (client) => {
    await establishTenantContext(client, operation.workspace_id, operation.created_by_principal_id);
    await authorizeScheduleProjectCapability(client, {
      workspaceId: operation.workspace_id,
      projectId: operation.project_id,
      principalId: operation.created_by_principal_id,
      capability: "integration.manage",
    });
    if (operation.calendar_id) {
      const policy = await readCalendarPolicy(client, {
        workspaceId: operation.workspace_id,
        projectId: operation.project_id,
        calendarId: operation.calendar_id,
      });
      await authorizeScheduleObject(client, {
        workspaceId: operation.workspace_id,
        projectId: operation.project_id,
        principalId: operation.created_by_principal_id,
        capability: "calendar.edit",
        objectType: "calendar",
        objectId: operation.calendar_id,
        ownerPrincipalId: policy.ownerPrincipalId,
        visibility: policy.visibility,
      });
    }
    const changed = await client.query(`
      UPDATE provider_operations
      SET state='running',attempt_count=attempt_count+1,
        started_at=coalesce(started_at,now()),completed_at=NULL,
        last_error_code=NULL,last_error_message=NULL
      WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND state IN ('pending','failed')
      RETURNING id
    `, [operation.workspace_id, operation.project_id, operation.id]);
    if (!changed.rows[0]) {
      throw new FoundationServiceError("CONFLICT", "Provider operation is already running or terminal.");
    }
  });
}

async function finishOperation(
  operation: OperationContext,
  input: {
    state: "succeeded" | "succeeded_with_warnings" | "failed";
    result: Record<string, unknown>;
    errorCode?: string;
    errorMessage?: string;
  },
  pool: Pool,
) {
  await inTransaction(pool, async (client) => {
    await establishTenantContext(client, operation.workspace_id, operation.created_by_principal_id);
    await client.query(`
      UPDATE provider_operations
      SET state=$4,result_summary=$5,last_error_code=$6,last_error_message=$7,completed_at=now()
      WHERE workspace_id=$1 AND project_id=$2 AND id=$3
    `, [operation.workspace_id,operation.project_id,operation.id,input.state,input.result,
      input.errorCode ?? null,input.errorMessage?.slice(0,500) ?? null]);
  });
}

async function recordExternalMutation(
  client: PoolClient,
  operation: OperationContext,
  input: { entryId: string; revision: number; deleted: boolean },
) {
  const requestId = newFolioId();
  await client.query(`
    INSERT INTO activity_events(
      id,workspace_id,project_id,actor_principal_id,authorizing_principal_id,source,
      action,target_type,target_id,input_summary,result_summary,request_id
    ) VALUES($1,$2,$3,$4,$4,'worker','calendar.external_reconciled','calendar_entry',$5,$6,$7,$8)
  `, [newFolioId(),operation.workspace_id,operation.project_id,operation.created_by_principal_id,
    input.entryId,{providerKey:operation.provider_key,bindingId:operation.binding_id},
    {calendarEntryId:input.entryId,deleted:input.deleted,revision:input.revision},requestId]);
  await client.query(`
    INSERT INTO outbox_events(
      id,workspace_id,project_id,aggregate_type,aggregate_id,aggregate_revision,event_type,
      actor_principal_id,authorizing_principal_id,request_id,payload
    ) VALUES($1,$2,$3,'calendar_entry',$4,$5,'calendar_entry.external_reconciled.v1',$6,$6,$7,$8)
  `, [newFolioId(),operation.workspace_id,operation.project_id,input.entryId,input.revision,
    operation.created_by_principal_id,requestId,
    {calendarEntryId:input.entryId,bindingId:operation.binding_id,deleted:input.deleted}]);
}

async function applyPulledEvents(
  operation: OperationContext,
  events: CalendarProviderEvent[],
  cursor: string | null,
  pool: Pool,
): Promise<{ created: number; updated: number; deleted: number; warnings: string[] }> {
  if (!operation.binding_id || !operation.calendar_id) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Pull operation requires a calendar binding.");
  }
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, operation.workspace_id, operation.created_by_principal_id);
    let created = 0;
    let updated = 0;
    let deleted = 0;
    const warnings: string[] = [];
    let index = 0;
    for (const rawEvent of events.slice(0, 5000)) {
      index += 1;
      const savepoint = `provider_event_${index}`;
      await client.query(`SAVEPOINT ${savepoint}`);
      try {
        const event = validateProviderEvent(rawEvent);
        const mapping = await client.query<{ id: string; calendar_entry_id: string | null }>(`
          SELECT id,calendar_entry_id
          FROM external_calendar_event_mappings
          WHERE workspace_id=$1 AND project_id=$2 AND binding_id=$3 AND external_event_id=$4
          FOR UPDATE
        `, [operation.workspace_id,operation.project_id,operation.binding_id,event.externalId]);
        const existing = mapping.rows[0];
        if (event.deleted) {
          if (existing?.calendar_entry_id) {
            const archived = await client.query<{ revision: string }>(`
              UPDATE calendar_entries
              SET archived_at=coalesce(archived_at,now()),revision=revision+1,
                updated_by_principal_id=$4,updated_at=now()
              WHERE workspace_id=$1 AND project_id=$2 AND id=$3
              RETURNING revision
            `, [operation.workspace_id,operation.project_id,existing.calendar_entry_id,
              operation.created_by_principal_id]);
            await client.query(`
              UPDATE external_calendar_event_mappings
              SET etag=$5,provider_updated_at=$6,last_seen_at=now(),deleted_at=now()
              WHERE workspace_id=$1 AND project_id=$2 AND binding_id=$3 AND external_event_id=$4
            `, [operation.workspace_id,operation.project_id,operation.binding_id,event.externalId,
              event.etag,event.updatedAt]);
            await recordExternalMutation(client, operation, {
              entryId: existing.calendar_entry_id,
              revision: Number(archived.rows[0]?.revision ?? 1),
              deleted: true,
            });
            deleted += 1;
          }
          await client.query(`RELEASE SAVEPOINT ${savepoint}`);
          continue;
        }

        let entryId = existing?.calendar_entry_id ?? null;
        let revision = 1;
        if (entryId) {
          const changed = await client.query<{ revision: string }>(`
            UPDATE calendar_entries
            SET title=$4,starts_at=$5,ends_at=$6,all_day=$7,time_zone=$8,
              archived_at=NULL,revision=revision+1,updated_by_principal_id=$9,updated_at=now()
            WHERE workspace_id=$1 AND project_id=$2 AND id=$3
            RETURNING revision
          `, [operation.workspace_id,operation.project_id,entryId,event.title,event.startsAt,event.endsAt,
            event.allDay,event.timeZone,operation.created_by_principal_id]);
          revision = Number(changed.rows[0]?.revision ?? 1);
          updated += 1;
        } else {
          entryId = newFolioId();
          await client.query(`
            INSERT INTO calendar_entries(
              id,workspace_id,project_id,calendar_id,source_kind,title,starts_at,ends_at,
              all_day,time_zone,created_by_principal_id,updated_by_principal_id
            ) VALUES($1,$2,$3,$4,'external',$5,$6,$7,$8,$9,$10,$10)
          `, [entryId,operation.workspace_id,operation.project_id,operation.calendar_id,event.title,
            event.startsAt,event.endsAt,event.allDay,event.timeZone,operation.created_by_principal_id]);
          created += 1;
        }
        await client.query(`
          INSERT INTO external_calendar_event_mappings(
            id,workspace_id,project_id,binding_id,external_event_id,calendar_entry_id,
            etag,provider_updated_at,last_seen_at,deleted_at
          ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now(),NULL)
          ON CONFLICT(binding_id,external_event_id) DO UPDATE SET
            calendar_entry_id=EXCLUDED.calendar_entry_id,etag=EXCLUDED.etag,
            provider_updated_at=EXCLUDED.provider_updated_at,last_seen_at=now(),deleted_at=NULL
        `, [newFolioId(),operation.workspace_id,operation.project_id,operation.binding_id,
          event.externalId,entryId,event.etag,event.updatedAt]);
        await recordExternalMutation(client, operation, { entryId, revision, deleted: false });
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      } catch (error) {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        warnings.push(error instanceof Error ? error.message.slice(0, 200) : "Provider event was rejected.");
      }
    }
    await client.query(`
      UPDATE calendar_external_bindings SET sync_cursor=$4,updated_at=now()
      WHERE workspace_id=$1 AND project_id=$2 AND id=$3
    `, [operation.workspace_id,operation.project_id,operation.binding_id,cursor]);
    await client.query(`
      UPDATE integration_connections
      SET last_synced_at=now(),last_error_code=NULL,last_error_message=NULL,updated_at=now()
      WHERE workspace_id=$1 AND project_id=$2 AND id=$3
    `, [operation.workspace_id,operation.project_id,operation.connection_id]);
    return { created, updated, deleted, warnings };
  });
}

export async function runCalendarProviderOperation(
  operationId: string,
  pool: Pool = postgresPool(),
): Promise<Record<string, unknown>> {
  const operation = await loadOperation(operationId, pool);
  if (!["discover", "pull"].includes(operation.operation)) {
    throw new FoundationServiceError(
      "CONFLICT",
      "Only discover and pull are enabled before provider conflict decisions are resolved.",
    );
  }
  await markRunning(operation, pool);
  const adapter = calendarProviderAdapter(operation.provider_key);
  try {
    if (operation.operation === "discover") {
      const result = await adapter.discoverCalendars({
        secretReference: operation.secret_reference,
        cursor: operation.connection_cursor,
      });
      await inTransaction(pool, async (client) => {
        await establishTenantContext(client, operation.workspace_id, operation.created_by_principal_id);
        await client.query(`
          UPDATE integration_connections
          SET sync_cursor=$4,last_synced_at=now(),last_error_code=NULL,
            last_error_message=NULL,updated_at=now()
          WHERE workspace_id=$1 AND project_id=$2 AND id=$3
        `, [operation.workspace_id,operation.project_id,operation.connection_id,result.cursor]);
      });
      const summary = { calendars: result.calendars.slice(0, 1000), cursor: result.cursor };
      await finishOperation(operation, { state: "succeeded", result: summary }, pool);
      return summary;
    }
    if (!operation.external_calendar_id) {
      throw new FoundationServiceError("VALIDATION_FAILED", "Calendar pull requires an external calendar binding.");
    }
    const pulled = await adapter.pullEvents({
      secretReference: operation.secret_reference,
      externalCalendarId: operation.external_calendar_id,
      cursor: operation.binding_cursor,
    });
    const summary = await applyPulledEvents(operation, pulled.events, pulled.cursor, pool);
    await finishOperation(operation, {
      state: summary.warnings.length ? "succeeded_with_warnings" : "succeeded",
      result: { ...summary, cursor: pulled.cursor },
    }, pool);
    return { ...summary, cursor: pulled.cursor };
  } catch (error) {
    await finishOperation(operation, {
      state: "failed",
      result: {},
      errorCode: error instanceof FoundationServiceError ? error.code : "PROVIDER_OPERATION_FAILED",
      errorMessage: error instanceof Error ? error.message : "Provider operation failed.",
    }, pool);
    throw error;
  }
}
