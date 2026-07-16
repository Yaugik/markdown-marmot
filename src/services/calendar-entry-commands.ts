import type { Pool, PoolClient } from "pg";
import { postgresPool } from "@/db/postgres";
import { establishTenantContext } from "@/db/tenant";
import { newFolioId } from "@/lib/folio-ids";
import { authorizeIssueCapability } from "@/services/issue-access";
import { FoundationServiceError } from "@/services/foundation/errors";
import {
  findIdempotentResult,
  inTransaction,
  lockIdempotencyKey,
  recordMutation,
  requestDigest,
} from "@/services/foundation/internal";
import type { MutationContext, MutationResult } from "@/services/foundation/types";
import {
  authorizeScheduleObject,
  readCalendarPolicy,
  readTodoListPolicy,
} from "@/services/schedule-access";
import { emptyScheduleDocument, structuredScheduleDocument } from "@/services/schedule-document";
import type { CalendarEntry } from "@/services/calendars";

type EntryRow = {
  id: string;
  calendar_id: string;
  source_kind: CalendarEntry["sourceKind"];
  todo_id: string | null;
  issue_id: string | null;
  title: string;
  body: Record<string, unknown>;
  plain_text: string;
  starts_at: Date;
  ends_at: Date;
  all_day: boolean;
  time_zone: string;
  revision: string;
  created_by_principal_id: string;
  updated_by_principal_id: string;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
};

const columns = `
  id,calendar_id,source_kind,todo_id,issue_id,title,body,plain_text,starts_at,ends_at,
  all_day,time_zone,revision,created_by_principal_id,updated_by_principal_id,
  created_at,updated_at,archived_at
`;

function mapEntry(row: EntryRow): CalendarEntry {
  return {
    id: row.id,
    calendarId: row.calendar_id,
    sourceKind: row.source_kind,
    todoId: row.todo_id,
    issueId: row.issue_id,
    title: row.title,
    body: row.body,
    plainText: row.plain_text,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
    allDay: row.all_day,
    timeZone: row.time_zone,
    revision: Number(row.revision),
    createdByPrincipalId: row.created_by_principal_id,
    updatedByPrincipalId: row.updated_by_principal_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    archivedAt: row.archived_at?.toISOString() ?? null,
  };
}

function title(value: string) {
  const result = value.trim();
  if (!result || result.length > 240) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Calendar entry title must contain 1 to 240 characters.");
  }
  return result;
}

function instant(value: string, label: string) {
  const result = new Date(value);
  if (Number.isNaN(result.getTime())) {
    throw new FoundationServiceError("VALIDATION_FAILED", `${label} must be an ISO date-time.`);
  }
  return result.toISOString();
}

function timeZone(value: string | undefined) {
  const result = value?.trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone: result }).format(new Date());
  } catch {
    throw new FoundationServiceError("VALIDATION_FAILED", "Time zone is not supported.", { timeZone: result });
  }
  return result;
}

async function authorizeCalendarEdit(
  client: PoolClient,
  input: { workspaceId: string; projectId: string; calendarId: string; principalId: string },
) {
  const policy = await readCalendarPolicy(client, input);
  await authorizeScheduleObject(client, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    principalId: input.principalId,
    capability: "calendar.edit",
    objectType: "calendar",
    objectId: input.calendarId,
    ownerPrincipalId: policy.ownerPrincipalId,
    visibility: policy.visibility,
  });
  if (policy.archived) throw new FoundationServiceError("CONFLICT", "Archived calendars cannot receive entries.");
}

async function authorizeSource(
  client: PoolClient,
  input: {
    workspaceId: string;
    projectId: string;
    principalId: string;
    sourceKind: "manual" | "todo" | "issue";
    todoId: string | null;
    issueId: string | null;
  },
) {
  if (input.sourceKind === "manual") {
    if (input.todoId || input.issueId) {
      throw new FoundationServiceError("VALIDATION_FAILED", "Manual entries cannot have a to-do or issue source.");
    }
    return;
  }
  if (input.sourceKind === "todo") {
    if (!input.todoId || input.issueId) {
      throw new FoundationServiceError("VALIDATION_FAILED", "To-do entries require exactly one to-do source.");
    }
    const todo = await client.query<{ list_id: string }>(`
      SELECT list_id FROM todos
      WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND archived_at IS NULL
    `, [input.workspaceId,input.projectId,input.todoId]);
    if (!todo.rows[0]) throw new FoundationServiceError("NOT_FOUND", "Source to-do was not found.");
    const policy = await readTodoListPolicy(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      listId: todo.rows[0].list_id,
    });
    await authorizeScheduleObject(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      principalId: input.principalId,
      capability: "todo.read",
      objectType: "todo_list",
      objectId: todo.rows[0].list_id,
      ownerPrincipalId: policy.ownerPrincipalId,
      visibility: policy.visibility,
    });
    return;
  }
  if (!input.issueId || input.todoId) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Issue entries require exactly one issue source.");
  }
  await authorizeIssueCapability(client, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    principalId: input.principalId,
    capability: "issue.read",
    issueId: input.issueId,
  });
}

export async function createAuthorizedCalendarEntry(
  raw: {
    workspaceId: string;
    projectId: string;
    calendarId: string;
    sourceKind?: "manual" | "todo" | "issue";
    todoId?: string | null;
    issueId?: string | null;
    title: string;
    body?: Record<string, unknown>;
    startsAt: string;
    endsAt: string;
    allDay?: boolean;
    timeZone?: string;
  },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<CalendarEntry>> {
  const startsAt = instant(raw.startsAt, "Start time");
  const endsAt = instant(raw.endsAt, "End time");
  if (new Date(endsAt) <= new Date(startsAt)) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Calendar entry end must follow its start.");
  }
  const body = raw.body === undefined
    ? emptyScheduleDocument()
    : structuredScheduleDocument(raw.body, "Calendar entry body");
  const input = {
    ...raw,
    sourceKind: raw.sourceKind ?? "manual",
    todoId: raw.todoId ?? null,
    issueId: raw.issueId ?? null,
    title: title(raw.title),
    body: body.document,
    plainText: body.plainText,
    startsAt,
    endsAt,
    allDay: raw.allDay ?? false,
    timeZone: timeZone(raw.timeZone),
  };
  const operation = "calendar_entry.create";
  const digest = requestDigest(input);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<CalendarEntry>(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      principalId: context.actorPrincipalId,
      operation,
      key: context.idempotencyKey,
      digest,
    });
    if (replay) return replay;
    await authorizeCalendarEdit(client, { ...input, principalId: context.actorPrincipalId });
    await authorizeSource(client, { ...input, principalId: context.actorPrincipalId });
    const id = newFolioId();
    const result = await client.query<EntryRow>(`
      INSERT INTO calendar_entries(
        id,workspace_id,project_id,calendar_id,source_kind,todo_id,issue_id,title,
        body,plain_text,starts_at,ends_at,all_day,time_zone,
        created_by_principal_id,updated_by_principal_id
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)
      RETURNING ${columns}
    `, [id,input.workspaceId,input.projectId,input.calendarId,input.sourceKind,input.todoId,
      input.issueId,input.title,input.body,input.plainText,input.startsAt,input.endsAt,
      input.allDay,input.timeZone,context.actorPrincipalId]);
    const data = mapEntry(result.rows[0]!);
    return recordMutation(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      context,
      operation,
      digest,
      action: operation,
      targetType: "calendar_entry",
      targetId: id,
      aggregateType: "calendar_entry",
      aggregateRevision: 1,
      eventType: "calendar_entry.created.v1",
      inputSummary: {
        calendarId: input.calendarId,
        sourceKind: input.sourceKind,
        titleLength: input.title.length,
        bodyLength: input.plainText.length,
        allDay: input.allDay,
      },
      resultSummary: { entryId: id, calendarId: input.calendarId },
      data,
    });
  });
}

async function setEntryArchived(
  raw: { workspaceId: string; projectId: string; entryId: string; expectedRevision: number },
  context: MutationContext,
  archived: boolean,
  pool: Pool,
): Promise<MutationResult<CalendarEntry>> {
  if (!Number.isSafeInteger(raw.expectedRevision) || raw.expectedRevision < 1) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Expected revision must be positive.");
  }
  const operation = archived ? "calendar_entry.archive" : "calendar_entry.restore";
  const digest = requestDigest(raw);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, raw.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<CalendarEntry>(client, {
      workspaceId: raw.workspaceId,
      projectId: raw.projectId,
      principalId: context.actorPrincipalId,
      operation,
      key: context.idempotencyKey,
      digest,
    });
    if (replay) return replay;
    const current = await client.query<EntryRow>(`
      SELECT ${columns} FROM calendar_entries
      WHERE workspace_id=$1 AND project_id=$2 AND id=$3
    `, [raw.workspaceId,raw.projectId,raw.entryId]);
    const row = current.rows[0];
    if (!row) throw new FoundationServiceError("NOT_FOUND", "Calendar entry was not found.");
    await authorizeCalendarEdit(client, {
      workspaceId: raw.workspaceId,
      projectId: raw.projectId,
      calendarId: row.calendar_id,
      principalId: context.actorPrincipalId,
    });
    const result = await client.query<EntryRow>(`
      UPDATE calendar_entries
      SET archived_at=CASE WHEN $5::boolean THEN now() ELSE NULL END,
        revision=revision+1,updated_by_principal_id=$6,updated_at=now()
      WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND revision=$4
        AND (($5::boolean AND archived_at IS NULL) OR (NOT $5::boolean AND archived_at IS NOT NULL))
      RETURNING ${columns}
    `, [raw.workspaceId,raw.projectId,raw.entryId,raw.expectedRevision,archived,
      context.actorPrincipalId]);
    if (!result.rows[0]) {
      throw new FoundationServiceError("REVISION_CONFLICT", "Calendar entry lifecycle changed after it was read.", {
        expectedRevision: raw.expectedRevision,
        currentRevision: Number(row.revision),
      });
    }
    const data = mapEntry(result.rows[0]);
    return recordMutation(client, {
      workspaceId: raw.workspaceId,
      projectId: raw.projectId,
      context,
      operation,
      digest,
      action: operation,
      targetType: "calendar_entry",
      targetId: raw.entryId,
      aggregateType: "calendar_entry",
      aggregateRevision: data.revision,
      eventType: archived ? "calendar_entry.archived.v1" : "calendar_entry.restored.v1",
      inputSummary: {},
      resultSummary: { entryId: data.id, calendarId: data.calendarId, revision: data.revision },
      data,
    });
  });
}

export function archiveCalendarEntry(
  input: { workspaceId: string; projectId: string; entryId: string; expectedRevision: number },
  context: MutationContext,
  pool: Pool = postgresPool(),
) {
  return setEntryArchived(input, context, true, pool);
}

export function restoreCalendarEntry(
  input: { workspaceId: string; projectId: string; entryId: string; expectedRevision: number },
  context: MutationContext,
  pool: Pool = postgresPool(),
) {
  return setEntryArchived(input, context, false, pool);
}
