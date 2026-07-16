import type { Pool, PoolClient } from "pg";
import { postgresPool } from "@/db/postgres";
import { establishTenantContext } from "@/db/tenant";
import { newFolioId } from "@/lib/folio-ids";
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
  authorizeScheduleProjectCapability,
  readCalendarPolicy,
  readTodoListPolicy,
} from "@/services/schedule-access";
import { emptyScheduleDocument, structuredScheduleDocument } from "@/services/schedule-document";

export type AgentScheduleOperation = "create" | "reschedule" | "complete" | "cancel" | "remind";
export type AgentScheduleGrant = {
  id: string;
  agentPrincipalId: string;
  authorizingPrincipalId: string;
  listId: string | null;
  calendarId: string | null;
  operations: AgentScheduleOperation[];
  constraints: Record<string, unknown>;
  validFrom: string;
  validUntil: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

type GrantRow = {
  id: string;
  agent_principal_id: string;
  authorizing_principal_id: string;
  list_id: string | null;
  calendar_id: string | null;
  operations: AgentScheduleOperation[];
  constraints: Record<string, unknown>;
  valid_from: Date;
  valid_until: Date | null;
  revision: string;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
};

const grantColumns = `
  id,agent_principal_id,authorizing_principal_id,list_id,calendar_id,operations,
  constraints,valid_from,valid_until,revision,created_at,updated_at,archived_at
`;

function mapGrant(row: GrantRow): AgentScheduleGrant {
  return {
    id: row.id,
    agentPrincipalId: row.agent_principal_id,
    authorizingPrincipalId: row.authorizing_principal_id,
    listId: row.list_id,
    calendarId: row.calendar_id,
    operations: row.operations,
    constraints: row.constraints,
    validFrom: row.valid_from.toISOString(),
    validUntil: row.valid_until?.toISOString() ?? null,
    revision: Number(row.revision),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    archivedAt: row.archived_at?.toISOString() ?? null,
  };
}

function validateOperations(values: AgentScheduleOperation[]) {
  const operations = [...new Set(values)];
  if (!operations.length) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Agent schedule grant requires operations.");
  }
  return operations;
}

function validateInstant(value: string, label: string): string {
  const result = new Date(value);
  if (Number.isNaN(result.getTime())) {
    throw new FoundationServiceError("VALIDATION_FAILED", `${label} must be an ISO date-time.`);
  }
  return result.toISOString();
}

function validateTitle(value: string, label: string): string {
  const result = value.trim();
  if (!result || result.length > 240) {
    throw new FoundationServiceError("VALIDATION_FAILED", `${label} must contain 1 to 240 characters.`);
  }
  return result;
}

function validateTimeZone(value: string | undefined): string {
  const result = value?.trim() || "UTC";
  if (result.length > 120) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Time zone is too long.");
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: result }).format(new Date());
  } catch {
    throw new FoundationServiceError("VALIDATION_FAILED", "Time zone is not supported.", { timeZone: result });
  }
  return result;
}

async function authorizeGrantTarget(
  client: PoolClient,
  input: {
    workspaceId: string;
    projectId: string;
    principalId: string;
    listId?: string | null;
    calendarId?: string | null;
  },
) {
  if (Boolean(input.listId) === Boolean(input.calendarId)) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Schedule grant requires exactly one list or calendar.");
  }
  if (input.listId) {
    const policy = await readTodoListPolicy(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      listId: input.listId,
    });
    await authorizeScheduleObject(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      principalId: input.principalId,
      capability: "todo.edit",
      objectType: "todo_list",
      objectId: input.listId,
      ownerPrincipalId: policy.ownerPrincipalId,
      visibility: policy.visibility,
    });
    return policy.visibility;
  }
  const policy = await readCalendarPolicy(client, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    calendarId: input.calendarId!,
  });
  await authorizeScheduleObject(client, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    principalId: input.principalId,
    capability: "calendar.edit",
    objectType: "calendar",
    objectId: input.calendarId!,
    ownerPrincipalId: policy.ownerPrincipalId,
    visibility: policy.visibility,
  });
  return policy.visibility;
}

export async function createAgentScheduleGrant(
  raw: {
    workspaceId: string;
    projectId: string;
    agentPrincipalId: string;
    listId?: string | null;
    calendarId?: string | null;
    operations: AgentScheduleOperation[];
    constraints?: Record<string, unknown>;
    validUntil?: string | null;
  },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<AgentScheduleGrant>> {
  const input = {
    ...raw,
    listId: raw.listId ?? null,
    calendarId: raw.calendarId ?? null,
    operations: validateOperations(raw.operations),
    constraints: raw.constraints ?? {},
    validUntil: raw.validUntil ? validateInstant(raw.validUntil, "Grant expiry") : null,
  };
  if (Buffer.byteLength(JSON.stringify(input.constraints)) > 16 * 1024) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Agent schedule constraints must be at most 16 KiB.");
  }
  const operation = "agent_schedule_grant.create";
  const digest = requestDigest(input);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<AgentScheduleGrant>(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      principalId: context.actorPrincipalId,
      operation,
      key: context.idempotencyKey,
      digest,
    });
    if (replay) return replay;
    await authorizeScheduleProjectCapability(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      principalId: context.actorPrincipalId,
      capability: "schedule.delegate",
    });
    const visibility = await authorizeGrantTarget(client, { ...input, principalId: context.actorPrincipalId });
    if (visibility === "project") {
      await authorizeScheduleProjectCapability(client, {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        principalId: context.actorPrincipalId,
        capability: "project.update",
      });
    }
    const id = newFolioId();
    const result = await client.query<GrantRow>(`
      INSERT INTO agent_schedule_grants(
        id,workspace_id,project_id,agent_principal_id,authorizing_principal_id,
        list_id,calendar_id,operations,constraints,valid_until
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING ${grantColumns}
    `, [id,input.workspaceId,input.projectId,input.agentPrincipalId,context.actorPrincipalId,
      input.listId,input.calendarId,input.operations,input.constraints,input.validUntil]);
    const data = mapGrant(result.rows[0]!);
    return recordMutation(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      context,
      operation,
      digest,
      action: operation,
      targetType: "agent_schedule_grant",
      targetId: id,
      aggregateType: "agent_schedule_grant",
      aggregateRevision: 1,
      eventType: "agent_schedule_grant.created.v1",
      inputSummary: {
        agentPrincipalId: input.agentPrincipalId,
        targetType: input.listId ? "todo_list" : "calendar",
        operations: input.operations,
      },
      resultSummary: { grantId: id, agentPrincipalId: input.agentPrincipalId },
      data,
    });
  });
}

export async function listAgentScheduleGrants(
  input: { workspaceId: string; projectId: string; agentPrincipalId?: string },
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<AgentScheduleGrant[]> {
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, principalId);
    await authorizeScheduleProjectCapability(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      principalId,
      capability: "schedule.delegate",
    });
    const result = await client.query<GrantRow>(`
      SELECT ${grantColumns}
      FROM agent_schedule_grants
      WHERE workspace_id=$1 AND project_id=$2 AND archived_at IS NULL
        AND authorizing_principal_id=$3
        AND ($4::uuid IS NULL OR agent_principal_id=$4)
      ORDER BY created_at DESC,id
    `, [input.workspaceId,input.projectId,principalId,input.agentPrincipalId ?? null]);
    return result.rows.map(mapGrant);
  });
}

type AgentCommand =
  | { kind: "create_todo"; grantId: string; title: string; body?: Record<string, unknown>; startsAt?: string | null; dueAt?: string | null; timeZone?: string; assigneePrincipalId?: string | null }
  | { kind: "reschedule_todo"; grantId: string; todoId: string; expectedRevision: number; startsAt: string | null; dueAt: string | null; timeZone?: string }
  | { kind: "complete_todo" | "cancel_todo"; grantId: string; todoId: string; expectedRevision: number }
  | { kind: "create_calendar_entry"; grantId: string; title: string; body?: Record<string, unknown>; startsAt: string; endsAt: string; timeZone?: string; allDay?: boolean }
  | { kind: "reschedule_calendar_entry"; grantId: string; entryId: string; expectedRevision: number; startsAt: string; endsAt: string; timeZone?: string }
  | { kind: "create_reminder"; grantId: string; todoId?: string; calendarEntryId?: string; recipientPrincipalId: string; remindAt: string; deduplicationKey: string };

export type AgentScheduleResult = { kind: AgentCommand["kind"]; targetId: string; revision: number; grantId: string };

function operationFor(command: AgentCommand): AgentScheduleOperation {
  if (command.kind.startsWith("create_") && command.kind !== "create_reminder") return "create";
  if (command.kind.startsWith("reschedule_")) return "reschedule";
  if (command.kind === "complete_todo") return "complete";
  if (command.kind === "cancel_todo") return "cancel";
  return "remind";
}

function commandWindow(command: AgentCommand): { start: string | null; end: string | null } {
  if (command.kind === "create_todo" || command.kind === "reschedule_todo") {
    return {
      start: command.startsAt ? validateInstant(command.startsAt, "Start time") : null,
      end: command.dueAt ? validateInstant(command.dueAt, "Due time") : null,
    };
  }
  if (command.kind === "create_calendar_entry" || command.kind === "reschedule_calendar_entry") {
    return {
      start: validateInstant(command.startsAt, "Start time"),
      end: validateInstant(command.endsAt, "End time"),
    };
  }
  if (command.kind === "create_reminder") {
    return { start: validateInstant(command.remindAt, "Reminder time"), end: null };
  }
  return { start: null, end: null };
}

function enforceConstraints(grant: GrantRow, command: AgentCommand) {
  const range = commandWindow(command);
  const maxDays = typeof grant.constraints.max_days_ahead === "number"
    ? grant.constraints.max_days_ahead
    : 365;
  if (range.start && new Date(range.start).getTime() > Date.now() + Math.max(1, Math.min(maxDays, 3650)) * 86_400_000) {
    throw new FoundationServiceError("CAPABILITY_DENIED", "Agent schedule command exceeds the delegated horizon.");
  }
  if (range.start && range.end && new Date(range.end) < new Date(range.start)) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Schedule end cannot precede start.");
  }
  const earliest = typeof grant.constraints.earliest_hour === "number" ? grant.constraints.earliest_hour : null;
  const latest = typeof grant.constraints.latest_hour === "number" ? grant.constraints.latest_hour : null;
  if (range.start && (earliest !== null || latest !== null)) {
    const hour = new Date(range.start).getUTCHours();
    if ((earliest !== null && hour < earliest) || (latest !== null && hour >= latest)) {
      throw new FoundationServiceError("CAPABILITY_DENIED", "Agent schedule command is outside delegated hours.");
    }
  }
}

async function grantForCommand(
  client: PoolClient,
  input: {
    workspaceId: string;
    projectId: string;
    grantId: string;
    agentPrincipalId: string;
    authorizerPrincipalId: string;
    operation: AgentScheduleOperation;
  },
): Promise<GrantRow> {
  const result = await client.query<GrantRow>(`
    SELECT ${grantColumns}
    FROM agent_schedule_grants
    WHERE workspace_id=$1 AND project_id=$2 AND id=$3
      AND agent_principal_id=$4 AND authorizing_principal_id=$5
      AND $6=ANY(operations) AND archived_at IS NULL
      AND valid_from<=now() AND (valid_until IS NULL OR valid_until>now())
    FOR UPDATE
  `, [input.workspaceId,input.projectId,input.grantId,input.agentPrincipalId,
    input.authorizerPrincipalId,input.operation]);
  const row = result.rows[0];
  if (!row) {
    throw new FoundationServiceError("CAPABILITY_DENIED", "No active agent schedule grant authorizes this command.");
  }
  await authorizeScheduleProjectCapability(client, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    principalId: input.agentPrincipalId,
    capability: "schedule.execute",
  });
  await authorizeScheduleProjectCapability(client, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    principalId: input.authorizerPrincipalId,
    capability: "schedule.execute",
  });
  await authorizeGrantTarget(client, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    principalId: input.authorizerPrincipalId,
    listId: row.list_id,
    calendarId: row.calendar_id,
  });
  return row;
}

function validateExpectedRevision(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Expected revision must be positive.");
  }
}

export async function executeAgentScheduleCommand(
  raw: { workspaceId: string; projectId: string; command: AgentCommand },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<AgentScheduleResult>> {
  const authorizer = context.authorizingPrincipalId;
  if (!authorizer || authorizer === context.actorPrincipalId) {
    throw new FoundationServiceError("CAPABILITY_DENIED", "Agent scheduling requires a distinct authorizing principal.");
  }
  const operation = "agent_schedule.execute";
  const digest = requestDigest(raw);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, raw.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<AgentScheduleResult>(client, {
      workspaceId: raw.workspaceId,
      projectId: raw.projectId,
      principalId: context.actorPrincipalId,
      operation,
      key: context.idempotencyKey,
      digest,
    });
    if (replay) return replay;
    const requestedOperation = operationFor(raw.command);
    const grant = await grantForCommand(client, {
      workspaceId: raw.workspaceId,
      projectId: raw.projectId,
      grantId: raw.command.grantId,
      agentPrincipalId: context.actorPrincipalId,
      authorizerPrincipalId: authorizer,
      operation: requestedOperation,
    });
    enforceConstraints(grant, raw.command);
    let targetId: string;
    let aggregateRevision = 1;

    if (raw.command.kind === "create_todo") {
      if (!grant.list_id) throw new FoundationServiceError("CAPABILITY_DENIED", "Grant does not target a to-do list.");
      const title = validateTitle(raw.command.title, "To-do title");
      const content = raw.command.body === undefined
        ? emptyScheduleDocument()
        : structuredScheduleDocument(raw.command.body, "To-do body");
      const starts = raw.command.startsAt ? validateInstant(raw.command.startsAt, "Start time") : null;
      const due = raw.command.dueAt ? validateInstant(raw.command.dueAt, "Due time") : null;
      if (starts && due && new Date(due) < new Date(starts)) {
        throw new FoundationServiceError("VALIDATION_FAILED", "Due time cannot precede start time.");
      }
      targetId = newFolioId();
      await client.query(`
        INSERT INTO todos(
          id,workspace_id,project_id,list_id,title,body,plain_text,assignee_principal_id,
          starts_at,due_at,time_zone,created_by_principal_id,updated_by_principal_id
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
      `, [targetId,raw.workspaceId,raw.projectId,grant.list_id,title,content.document,
        content.plainText,raw.command.assigneePrincipalId ?? null,starts,due,
        validateTimeZone(raw.command.timeZone),context.actorPrincipalId]);
    } else if (
      raw.command.kind === "reschedule_todo"
      || raw.command.kind === "complete_todo"
      || raw.command.kind === "cancel_todo"
    ) {
      if (!grant.list_id) throw new FoundationServiceError("CAPABILITY_DENIED", "Grant does not target a to-do list.");
      validateExpectedRevision(raw.command.expectedRevision);
      const todo = await client.query<{ list_id: string; revision: string }>(`
        SELECT list_id,revision FROM todos
        WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND archived_at IS NULL FOR UPDATE
      `, [raw.workspaceId,raw.projectId,raw.command.todoId]);
      if (!todo.rows[0] || todo.rows[0].list_id !== grant.list_id) {
        throw new FoundationServiceError("NOT_FOUND", "To-do was not found in the delegated list.");
      }
      if (Number(todo.rows[0].revision) !== raw.command.expectedRevision) {
        throw new FoundationServiceError("REVISION_CONFLICT", "To-do changed after it was read.", {
          expectedRevision: raw.command.expectedRevision,
          currentRevision: Number(todo.rows[0].revision),
        });
      }
      targetId = raw.command.todoId;
      aggregateRevision = raw.command.expectedRevision + 1;
      if (raw.command.kind === "reschedule_todo") {
        const starts = raw.command.startsAt ? validateInstant(raw.command.startsAt, "Start time") : null;
        const due = raw.command.dueAt ? validateInstant(raw.command.dueAt, "Due time") : null;
        if (starts && due && new Date(due) < new Date(starts)) {
          throw new FoundationServiceError("VALIDATION_FAILED", "Due time cannot precede start time.");
        }
        await client.query(`
          UPDATE todos SET starts_at=$4,due_at=$5,time_zone=$6,revision=revision+1,
            updated_by_principal_id=$7,updated_at=now()
          WHERE workspace_id=$1 AND project_id=$2 AND id=$3
        `, [raw.workspaceId,raw.projectId,targetId,starts,due,
          validateTimeZone(raw.command.timeZone),context.actorPrincipalId]);
      } else {
        const status = raw.command.kind === "complete_todo" ? "completed" : "canceled";
        await client.query(`
          UPDATE todos SET status=$4,completed_at=CASE WHEN $4='completed' THEN now() ELSE NULL END,
            revision=revision+1,updated_by_principal_id=$5,updated_at=now()
          WHERE workspace_id=$1 AND project_id=$2 AND id=$3
        `, [raw.workspaceId,raw.projectId,targetId,status,context.actorPrincipalId]);
      }
    } else if (raw.command.kind === "create_calendar_entry") {
      if (!grant.calendar_id) throw new FoundationServiceError("CAPABILITY_DENIED", "Grant does not target a calendar.");
      const title = validateTitle(raw.command.title, "Calendar entry title");
      const content = raw.command.body === undefined
        ? emptyScheduleDocument()
        : structuredScheduleDocument(raw.command.body, "Calendar entry body");
      const starts = validateInstant(raw.command.startsAt, "Start time");
      const ends = validateInstant(raw.command.endsAt, "End time");
      if (new Date(ends) <= new Date(starts)) {
        throw new FoundationServiceError("VALIDATION_FAILED", "Entry end must follow start.");
      }
      targetId = newFolioId();
      await client.query(`
        INSERT INTO calendar_entries(
          id,workspace_id,project_id,calendar_id,title,body,plain_text,starts_at,ends_at,
          all_day,time_zone,created_by_principal_id,updated_by_principal_id
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
      `, [targetId,raw.workspaceId,raw.projectId,grant.calendar_id,title,content.document,
        content.plainText,starts,ends,raw.command.allDay ?? false,
        validateTimeZone(raw.command.timeZone),context.actorPrincipalId]);
    } else if (raw.command.kind === "reschedule_calendar_entry") {
      if (!grant.calendar_id) throw new FoundationServiceError("CAPABILITY_DENIED", "Grant does not target a calendar.");
      validateExpectedRevision(raw.command.expectedRevision);
      const entry = await client.query<{ calendar_id: string; revision: string }>(`
        SELECT calendar_id,revision FROM calendar_entries
        WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND archived_at IS NULL FOR UPDATE
      `, [raw.workspaceId,raw.projectId,raw.command.entryId]);
      if (!entry.rows[0] || entry.rows[0].calendar_id !== grant.calendar_id) {
        throw new FoundationServiceError("NOT_FOUND", "Calendar entry was not found in the delegated calendar.");
      }
      if (Number(entry.rows[0].revision) !== raw.command.expectedRevision) {
        throw new FoundationServiceError("REVISION_CONFLICT", "Calendar entry changed after it was read.", {
          expectedRevision: raw.command.expectedRevision,
          currentRevision: Number(entry.rows[0].revision),
        });
      }
      const starts = validateInstant(raw.command.startsAt, "Start time");
      const ends = validateInstant(raw.command.endsAt, "End time");
      if (new Date(ends) <= new Date(starts)) {
        throw new FoundationServiceError("VALIDATION_FAILED", "Entry end must follow start.");
      }
      targetId = raw.command.entryId;
      aggregateRevision = raw.command.expectedRevision + 1;
      await client.query(`
        UPDATE calendar_entries SET starts_at=$4,ends_at=$5,time_zone=$6,
          revision=revision+1,updated_by_principal_id=$7,updated_at=now()
        WHERE workspace_id=$1 AND project_id=$2 AND id=$3
      `, [raw.workspaceId,raw.projectId,targetId,starts,ends,
        validateTimeZone(raw.command.timeZone),context.actorPrincipalId]);
    } else {
      const deduplicationKey = raw.command.deduplicationKey.trim();
      if (!deduplicationKey || deduplicationKey.length > 240) {
        throw new FoundationServiceError("VALIDATION_FAILED", "Reminder deduplication key is invalid.");
      }
      if (raw.command.todoId && grant.list_id) {
        const todo = await client.query<{ list_id: string }>(`
          SELECT list_id FROM todos
          WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND archived_at IS NULL
        `, [raw.workspaceId,raw.projectId,raw.command.todoId]);
        if (!todo.rows[0] || todo.rows[0].list_id !== grant.list_id) {
          throw new FoundationServiceError("NOT_FOUND", "Reminder target is outside the delegated list.");
        }
      } else if (raw.command.calendarEntryId && grant.calendar_id) {
        const entry = await client.query<{ calendar_id: string }>(`
          SELECT calendar_id FROM calendar_entries
          WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND archived_at IS NULL
        `, [raw.workspaceId,raw.projectId,raw.command.calendarEntryId]);
        if (!entry.rows[0] || entry.rows[0].calendar_id !== grant.calendar_id) {
          throw new FoundationServiceError("NOT_FOUND", "Reminder target is outside the delegated calendar.");
        }
      } else {
        throw new FoundationServiceError("CAPABILITY_DENIED", "Reminder target does not match the grant.");
      }
      const recipient = await client.query(`
        SELECT 1 FROM project_memberships pm JOIN principals p ON p.id=pm.principal_id
        WHERE pm.workspace_id=$1 AND pm.project_id=$2 AND pm.principal_id=$3
          AND pm.status='active' AND p.status='active'
      `, [raw.workspaceId,raw.projectId,raw.command.recipientPrincipalId]);
      if (!recipient.rows[0]) {
        throw new FoundationServiceError("VALIDATION_FAILED", "Reminder recipient must be an active project principal.");
      }
      targetId = newFolioId();
      const remindAt = validateInstant(raw.command.remindAt, "Reminder time");
      await client.query(`
        INSERT INTO reminders(
          id,workspace_id,project_id,todo_id,calendar_entry_id,recipient_principal_id,
          remind_at,deduplication_key,available_at,created_by_principal_id
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$7,$9)
      `, [targetId,raw.workspaceId,raw.projectId,raw.command.todoId ?? null,
        raw.command.calendarEntryId ?? null,raw.command.recipientPrincipalId,
        remindAt,deduplicationKey,context.actorPrincipalId]);
      await client.query(`
        INSERT INTO jobs(id,workspace_id,project_id,kind,payload,deduplication_key,status,available_at)
        VALUES($1,$2,$3,'reminder.delivery',$4,$5,'pending',$6)
        ON CONFLICT DO NOTHING
      `, [newFolioId(),raw.workspaceId,raw.projectId,{ reminderId: targetId },
        `reminder:${targetId}`,remindAt]);
    }

    const data: AgentScheduleResult = {
      kind: raw.command.kind,
      targetId,
      revision: aggregateRevision,
      grantId: grant.id,
    };
    const targetType = raw.command.kind.includes("calendar")
      ? "calendar_entry"
      : raw.command.kind === "create_reminder" ? "reminder" : "todo";
    return recordMutation(client, {
      workspaceId: raw.workspaceId,
      projectId: raw.projectId,
      context,
      operation,
      digest,
      action: `agent_schedule.${raw.command.kind}`,
      targetType,
      targetId,
      aggregateType: targetType,
      aggregateRevision,
      eventType: `agent_schedule.${raw.command.kind}.v1`,
      inputSummary: { grantId: grant.id, operation: requestedOperation },
      resultSummary: data,
      data,
    });
  });
}
