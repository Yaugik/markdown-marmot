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
import { authorizeScheduleObject, readTodoListPolicy } from "@/services/schedule-access";
import { expandRecurrence, type RecurrenceFrequency, type RecurrenceRule } from "@/services/recurrence";

export type StoredTodoRecurrence = RecurrenceRule & {
  todoId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

export type TodoOccurrence = {
  id: string;
  recurrenceRuleId: string;
  sourceTodoId: string;
  occurrenceKey: string;
  scheduledFor: string;
  state: "scheduled" | "materialized" | "skipped";
  materializedTodoId: string | null;
  createdAt: string;
  materializedAt: string | null;
};

type RuleRow = {
  id: string;
  todo_id: string;
  frequency: RecurrenceFrequency;
  interval_count: number;
  by_weekday: number[];
  by_month_day: number | null;
  local_time: string;
  time_zone: string;
  starts_on: string;
  ends_on: string | null;
  count_limit: number | null;
  revision: string;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
};

type OccurrenceRow = {
  id: string;
  recurrence_rule_id: string;
  source_todo_id: string;
  occurrence_key: string;
  scheduled_for: Date;
  state: TodoOccurrence["state"];
  materialized_todo_id: string | null;
  created_at: Date;
  materialized_at: Date | null;
};

type TodoTemplateRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  list_id: string;
  parent_todo_id: string | null;
  title: string;
  body: Record<string, unknown>;
  plain_text: string;
  assignee_principal_id: string | null;
  starts_at: Date | null;
  due_at: Date | null;
  time_zone: string;
  rank: number;
  revision: string;
  archived_at: Date | null;
};

function mapRule(row: RuleRow): StoredTodoRecurrence {
  return {
    id: row.id,
    todoId: row.todo_id,
    frequency: row.frequency,
    intervalCount: Number(row.interval_count),
    byWeekday: row.by_weekday.map(Number),
    byMonthDay: row.by_month_day === null ? null : Number(row.by_month_day),
    localTime: row.local_time.slice(0, 5),
    timeZone: row.time_zone,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    countLimit: row.count_limit === null ? null : Number(row.count_limit),
    revision: Number(row.revision),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    archivedAt: row.archived_at?.toISOString() ?? null,
  };
}

function mapOccurrence(row: OccurrenceRow): TodoOccurrence {
  return {
    id: row.id,
    recurrenceRuleId: row.recurrence_rule_id,
    sourceTodoId: row.source_todo_id,
    occurrenceKey: row.occurrence_key,
    scheduledFor: row.scheduled_for.toISOString(),
    state: row.state,
    materializedTodoId: row.materialized_todo_id,
    createdAt: row.created_at.toISOString(),
    materializedAt: row.materialized_at?.toISOString() ?? null,
  };
}

function validateRevision(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Expected revision must be a positive integer.");
  }
}

function normalizedRule(raw: {
  frequency: RecurrenceFrequency;
  intervalCount?: number;
  byWeekday?: number[];
  byMonthDay?: number | null;
  localTime: string;
  timeZone: string;
  startsOn: string;
  endsOn?: string | null;
  countLimit?: number | null;
}) {
  const rule = {
    frequency: raw.frequency,
    intervalCount: raw.intervalCount ?? 1,
    byWeekday: [...new Set(raw.byWeekday ?? [])].sort((left, right) => left - right),
    byMonthDay: raw.byMonthDay ?? null,
    localTime: raw.localTime,
    timeZone: raw.timeZone.trim(),
    startsOn: raw.startsOn,
    endsOn: raw.endsOn ?? null,
    countLimit: raw.countLimit ?? null,
  };
  expandRecurrence({ id: "validation", ...rule }, rule.startsOn, rule.endsOn ?? rule.startsOn, 1);
  return rule;
}

async function templateRow(
  client: PoolClient,
  input: { workspaceId: string; projectId: string; todoId: string },
): Promise<TodoTemplateRow> {
  const result = await client.query<TodoTemplateRow>(`
    SELECT id,workspace_id,project_id,list_id,parent_todo_id,title,body,plain_text,
      assignee_principal_id,starts_at,due_at,time_zone,rank,revision,archived_at
    FROM todos WHERE workspace_id=$1 AND project_id=$2 AND id=$3
  `, [input.workspaceId, input.projectId, input.todoId]);
  const row = result.rows[0];
  if (!row) throw new FoundationServiceError("NOT_FOUND", "To-do was not found.");
  return row;
}

async function authorizeTemplate(
  client: PoolClient,
  template: TodoTemplateRow,
  principalId: string,
  capability: "todo.read" | "todo.edit",
) {
  const policy = await readTodoListPolicy(client, {
    workspaceId: template.workspace_id, projectId: template.project_id, listId: template.list_id,
  });
  await authorizeScheduleObject(client, {
    workspaceId: template.workspace_id, projectId: template.project_id,
    principalId, capability, objectType: "todo_list", objectId: template.list_id,
    ownerPrincipalId: policy.ownerPrincipalId, visibility: policy.visibility,
  });
}

export async function readTodoRecurrence(
  input: { workspaceId: string; projectId: string; todoId: string },
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<StoredTodoRecurrence | null> {
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, principalId);
    const template = await templateRow(client, input);
    await authorizeTemplate(client, template, principalId, "todo.read");
    const result = await client.query<RuleRow>(`
      SELECT id,todo_id,frequency,interval_count,by_weekday,by_month_day,
        local_time::text,time_zone,starts_on::text,ends_on::text,count_limit,
        revision,created_at,updated_at,archived_at
      FROM todo_recurrence_rules
      WHERE workspace_id=$1 AND project_id=$2 AND todo_id=$3
    `, [input.workspaceId, input.projectId, input.todoId]);
    return result.rows[0] ? mapRule(result.rows[0]) : null;
  });
}

export async function setTodoRecurrence(
  raw: {
    workspaceId: string;
    projectId: string;
    todoId: string;
    expectedTodoRevision: number;
    frequency: RecurrenceFrequency;
    intervalCount?: number;
    byWeekday?: number[];
    byMonthDay?: number | null;
    localTime: string;
    timeZone: string;
    startsOn: string;
    endsOn?: string | null;
    countLimit?: number | null;
  },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<StoredTodoRecurrence>> {
  validateRevision(raw.expectedTodoRevision);
  const rule = normalizedRule(raw);
  const input = { ...raw, ...rule };
  const operation = "todo.recurrence.set";
  const digest = requestDigest(input);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<StoredTodoRecurrence>(client, {
      workspaceId: input.workspaceId, projectId: input.projectId,
      principalId: context.actorPrincipalId, operation, key: context.idempotencyKey, digest,
    });
    if (replay) return replay;
    const template = await templateRow(client, input);
    await authorizeTemplate(client, template, context.actorPrincipalId, "todo.edit");
    if (template.archived_at) throw new FoundationServiceError("CONFLICT", "Archived to-dos cannot recur.");
    if (Number(template.revision) !== input.expectedTodoRevision) {
      throw new FoundationServiceError("REVISION_CONFLICT", "To-do changed after it was read.", {
        expectedRevision: input.expectedTodoRevision, currentRevision: Number(template.revision),
      });
    }
    const ruleId = newFolioId();
    const result = await client.query<RuleRow>(`
      INSERT INTO todo_recurrence_rules(
        id,workspace_id,project_id,todo_id,frequency,interval_count,by_weekday,
        by_month_day,local_time,time_zone,starts_on,ends_on,count_limit,created_by_principal_id
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT (todo_id) DO UPDATE SET
        frequency=EXCLUDED.frequency,interval_count=EXCLUDED.interval_count,
        by_weekday=EXCLUDED.by_weekday,by_month_day=EXCLUDED.by_month_day,
        local_time=EXCLUDED.local_time,time_zone=EXCLUDED.time_zone,
        starts_on=EXCLUDED.starts_on,ends_on=EXCLUDED.ends_on,count_limit=EXCLUDED.count_limit,
        revision=todo_recurrence_rules.revision+1,updated_at=now(),archived_at=NULL
      RETURNING id,todo_id,frequency,interval_count,by_weekday,by_month_day,
        local_time::text,time_zone,starts_on::text,ends_on::text,count_limit,
        revision,created_at,updated_at,archived_at
    `, [ruleId,input.workspaceId,input.projectId,input.todoId,input.frequency,input.intervalCount,
      input.byWeekday,input.byMonthDay,input.localTime,input.timeZone,input.startsOn,input.endsOn,
      input.countLimit,context.actorPrincipalId]);
    await client.query(`
      UPDATE todos SET revision=revision+1,updated_by_principal_id=$5,updated_at=now()
      WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND revision=$4
    `, [input.workspaceId,input.projectId,input.todoId,input.expectedTodoRevision,context.actorPrincipalId]);
    const data = mapRule(result.rows[0]!);
    return recordMutation(client, {
      workspaceId: input.workspaceId, projectId: input.projectId, context,
      operation,digest,action:operation,targetType:"todo_recurrence",targetId:data.id,
      aggregateType:"todo",aggregateRevision:input.expectedTodoRevision+1,
      eventType:"todo.recurrence_set.v1",
      inputSummary:{todoId:input.todoId,frequency:input.frequency,intervalCount:input.intervalCount,timeZone:input.timeZone},
      resultSummary:{recurrenceRuleId:data.id,todoId:input.todoId,revision:data.revision},data,
    });
  });
}

export async function ensureTodoOccurrences(
  input: {
    workspaceId: string;
    projectId: string;
    todoId: string;
    windowStart: string;
    windowEnd: string;
    limit?: number;
  },
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<TodoOccurrence[]> {
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, principalId);
    const template = await templateRow(client, input);
    await authorizeTemplate(client, template, principalId, "todo.read");
    const rules = await client.query<RuleRow>(`
      SELECT id,todo_id,frequency,interval_count,by_weekday,by_month_day,
        local_time::text,time_zone,starts_on::text,ends_on::text,count_limit,
        revision,created_at,updated_at,archived_at
      FROM todo_recurrence_rules
      WHERE workspace_id=$1 AND project_id=$2 AND todo_id=$3 AND archived_at IS NULL
    `, [input.workspaceId,input.projectId,input.todoId]);
    const row = rules.rows[0];
    if (!row) return [];
    const rule = mapRule(row);
    const expanded = expandRecurrence(rule,input.windowStart,input.windowEnd,input.limit ?? 500);
    for (const occurrence of expanded) {
      await client.query(`
        INSERT INTO todo_occurrences(
          id,workspace_id,project_id,recurrence_rule_id,source_todo_id,
          occurrence_key,scheduled_for
        ) VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (recurrence_rule_id,occurrence_key) DO NOTHING
      `, [newFolioId(),input.workspaceId,input.projectId,rule.id,input.todoId,
        occurrence.occurrenceKey,occurrence.scheduledFor]);
    }
    const result = await client.query<OccurrenceRow>(`
      SELECT id,recurrence_rule_id,source_todo_id,occurrence_key,scheduled_for,
        state,materialized_todo_id,created_at,materialized_at
      FROM todo_occurrences
      WHERE workspace_id=$1 AND project_id=$2 AND recurrence_rule_id=$3
        AND scheduled_for >= $4::date AND scheduled_for < ($5::date + interval '1 day')
      ORDER BY scheduled_for,id
    `, [input.workspaceId,input.projectId,rule.id,input.windowStart,input.windowEnd]);
    return result.rows.map(mapOccurrence);
  });
}

export async function materializeDueTodoOccurrences(
  input: { workspaceId: string; projectId: string; through: string; limit?: number },
  actorPrincipalId: string,
  pool: Pool = postgresPool(),
): Promise<{ materialized: string[]; skipped: string[] }> {
  const through = new Date(input.through);
  if (Number.isNaN(through.getTime())) throw new FoundationServiceError("VALIDATION_FAILED", "Materialization time is invalid.");
  const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client,input.workspaceId,actorPrincipalId);
    const due = await client.query<OccurrenceRow & TodoTemplateRow>(`
      SELECT o.id,o.recurrence_rule_id,o.source_todo_id,o.occurrence_key,o.scheduled_for,
        o.state,o.materialized_todo_id,o.created_at,o.materialized_at,
        t.workspace_id,t.project_id,t.list_id,t.parent_todo_id,t.title,t.body,t.plain_text,
        t.assignee_principal_id,t.starts_at,t.due_at,t.time_zone,t.rank,t.revision,t.archived_at
      FROM todo_occurrences o JOIN todos t
        ON t.workspace_id=o.workspace_id AND t.project_id=o.project_id AND t.id=o.source_todo_id
      WHERE o.workspace_id=$1 AND o.project_id=$2 AND o.state='scheduled'
        AND o.scheduled_for <= $3 AND t.archived_at IS NULL
      ORDER BY o.scheduled_for,o.id
      FOR UPDATE OF o SKIP LOCKED
      LIMIT $4
    `,[input.workspaceId,input.projectId,through.toISOString(),limit]);
    const materialized:string[]=[];
    const skipped:string[]=[];
    for(const row of due.rows){
      const parentActive = !row.parent_todo_id || Boolean((await client.query(`
        SELECT 1 FROM todos WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND archived_at IS NULL
      `,[input.workspaceId,input.projectId,row.parent_todo_id])).rows[0]);
      if(!parentActive){
        await client.query(`UPDATE todo_occurrences SET state='skipped' WHERE id=$1`,[row.id]);
        skipped.push(row.id);
        continue;
      }
      const duration = row.starts_at && row.due_at ? row.due_at.getTime()-row.starts_at.getTime() : null;
      const materializedId=newFolioId();
      const start=row.scheduled_for;
      const dueAt=duration===null?null:new Date(start.getTime()+duration);
      const inserted=await client.query<{id:string}>(`
        INSERT INTO todos(
          id,workspace_id,project_id,list_id,parent_todo_id,title,body,plain_text,
          assignee_principal_id,starts_at,due_at,time_zone,rank,
          created_by_principal_id,updated_by_principal_id
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)
        ON CONFLICT DO NOTHING RETURNING id
      `,[materializedId,input.workspaceId,input.projectId,row.list_id,row.parent_todo_id,row.title,
        row.body,row.plain_text,row.assignee_principal_id,start,dueAt,row.time_zone,row.rank,actorPrincipalId]);
      if(!inserted.rows[0]){ skipped.push(row.id); continue; }
      await client.query(`UPDATE todo_occurrences SET state='materialized',materialized_todo_id=$2,materialized_at=now()
        WHERE id=$1 AND state='scheduled'`,[row.id,materializedId]);
      const activityId=newFolioId();
      const outboxId=newFolioId();
      const requestId=newFolioId();
      await client.query(`INSERT INTO activity_events(
        id,workspace_id,project_id,actor_principal_id,authorizing_principal_id,source,action,
        target_type,target_id,input_summary,result_summary,request_id
      ) VALUES($1,$2,$3,$4,$4,'worker','todo.recurrence.materialize','todo',$5,$6,$7,$8)`,[
        activityId,input.workspaceId,input.projectId,actorPrincipalId,materializedId,
        {recurrenceRuleId:row.recurrence_rule_id,occurrenceKey:row.occurrence_key},
        {todoId:materializedId,sourceTodoId:row.source_todo_id},requestId]);
      await client.query(`INSERT INTO outbox_events(
        id,workspace_id,project_id,aggregate_type,aggregate_id,aggregate_revision,event_type,
        actor_principal_id,authorizing_principal_id,request_id,payload
      ) VALUES($1,$2,$3,'todo',$4,1,'todo.recurrence_materialized.v1',$5,$5,$6,$7)`,[
        outboxId,input.workspaceId,input.projectId,materializedId,actorPrincipalId,requestId,
        {todoId:materializedId,sourceTodoId:row.source_todo_id,occurrenceKey:row.occurrence_key}]);
      materialized.push(materializedId);
    }
    return {materialized,skipped};
  });
}
