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
  readTodoListPolicy,
} from "@/services/schedule-access";
import { emptyScheduleDocument, structuredScheduleDocument } from "@/services/schedule-document";

export type TodoStatus = "open" | "completed" | "canceled";
export type Todo = {
  id: string;
  workspaceId: string;
  projectId: string;
  listId: string;
  parentTodoId: string | null;
  title: string;
  body: Record<string, unknown>;
  plainText: string;
  status: TodoStatus;
  assignee: { principalId: string; displayName: string; kind: "human" | "agent" } | null;
  startsAt: string | null;
  dueAt: string | null;
  timeZone: string;
  rank: number;
  revision: number;
  createdByPrincipalId: string;
  updatedByPrincipalId: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

type TodoRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  list_id: string;
  parent_todo_id: string | null;
  title: string;
  body: Record<string, unknown>;
  plain_text: string;
  status: TodoStatus;
  assignee_principal_id: string | null;
  assignee_display_name: string | null;
  assignee_kind: "human" | "agent" | null;
  starts_at: Date | null;
  due_at: Date | null;
  time_zone: string;
  rank: number;
  revision: string;
  created_by_principal_id: string;
  updated_by_principal_id: string;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
};

const todoColumns = `
  t.id,t.workspace_id,t.project_id,t.list_id,t.parent_todo_id,t.title,t.body,t.plain_text,
  t.status,t.assignee_principal_id,p.display_name assignee_display_name,
  CASE WHEN p.kind IN ('human','agent') THEN p.kind ELSE NULL END assignee_kind,
  t.starts_at,t.due_at,t.time_zone,t.rank,t.revision,t.created_by_principal_id,
  t.updated_by_principal_id,t.completed_at,t.created_at,t.updated_at,t.archived_at
`;

function mapTodo(row: TodoRow): Todo {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    listId: row.list_id,
    parentTodoId: row.parent_todo_id,
    title: row.title,
    body: row.body,
    plainText: row.plain_text,
    status: row.status,
    assignee: row.assignee_principal_id && row.assignee_display_name && row.assignee_kind ? {
      principalId: row.assignee_principal_id,
      displayName: row.assignee_display_name,
      kind: row.assignee_kind,
    } : null,
    startsAt: row.starts_at?.toISOString() ?? null,
    dueAt: row.due_at?.toISOString() ?? null,
    timeZone: row.time_zone,
    rank: Number(row.rank),
    revision: Number(row.revision),
    createdByPrincipalId: row.created_by_principal_id,
    updatedByPrincipalId: row.updated_by_principal_id,
    completedAt: row.completed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    archivedAt: row.archived_at?.toISOString() ?? null,
  };
}

function boundedTitle(value: string): string {
  const title = value.trim();
  if (!title || title.length > 240) {
    throw new FoundationServiceError("VALIDATION_FAILED", "To-do title must contain 1 to 240 characters.");
  }
  return title;
}

function validateRevision(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Expected revision must be a positive integer.");
  }
}

function validateRank(value: number | undefined): number {
  const rank = value ?? 1000;
  if (!Number.isSafeInteger(rank) || rank < 0) {
    throw new FoundationServiceError("VALIDATION_FAILED", "To-do rank must be a non-negative integer.");
  }
  return rank;
}

function validateTimeZone(value: string | undefined): string {
  const timeZone = value?.trim() || "UTC";
  if (timeZone.length > 120) throw new FoundationServiceError("VALIDATION_FAILED", "Time zone is too long.");
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(new Date());
  } catch {
    throw new FoundationServiceError("VALIDATION_FAILED", "Time zone is not supported.", { timeZone });
  }
  return timeZone;
}

function optionalInstant(value: string | null | undefined, label: string): string | null | undefined {
  if (value === undefined || value === null) return value;
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) {
    throw new FoundationServiceError("VALIDATION_FAILED", `${label} must be an ISO date-time.`);
  }
  return instant.toISOString();
}

function validateWindow(startsAt: string | null | undefined, dueAt: string | null | undefined) {
  if (startsAt && dueAt && new Date(dueAt).getTime() < new Date(startsAt).getTime()) {
    throw new FoundationServiceError("VALIDATION_FAILED", "To-do due time cannot precede its start time.");
  }
}

async function todoRow(client: PoolClient, input: { workspaceId: string; projectId: string; todoId: string }): Promise<TodoRow> {
  const result = await client.query<TodoRow>(`
    SELECT ${todoColumns}
    FROM todos t LEFT JOIN principals p ON p.id=t.assignee_principal_id
    WHERE t.workspace_id=$1 AND t.project_id=$2 AND t.id=$3
  `, [input.workspaceId, input.projectId, input.todoId]);
  const row = result.rows[0];
  if (!row) throw new FoundationServiceError("NOT_FOUND", "To-do was not found.");
  return row;
}

async function authorizeTodo(
  client: PoolClient,
  input: { workspaceId: string; projectId: string; principalId: string; listId: string; capability: "todo.read" | "todo.edit" | "todo.archive" },
) {
  const policy = await readTodoListPolicy(client, {
    workspaceId: input.workspaceId, projectId: input.projectId, listId: input.listId,
  });
  await authorizeScheduleObject(client, {
    workspaceId: input.workspaceId, projectId: input.projectId,
    principalId: input.principalId, capability: input.capability,
    objectType: "todo_list", objectId: input.listId,
    ownerPrincipalId: policy.ownerPrincipalId, visibility: policy.visibility,
  });
  return policy;
}

export async function listTodos(
  input: { workspaceId: string; projectId: string; listId: string; includeArchived?: boolean; status?: TodoStatus },
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<Todo[]> {
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, principalId);
    await authorizeTodo(client, { ...input, principalId, capability: "todo.read" });
    const result = await client.query<TodoRow>(`
      SELECT ${todoColumns}
      FROM todos t LEFT JOIN principals p ON p.id=t.assignee_principal_id
      WHERE t.workspace_id=$1 AND t.project_id=$2 AND t.list_id=$3
        AND ($4::boolean OR t.archived_at IS NULL)
        AND ($5::text IS NULL OR t.status=$5)
      ORDER BY t.archived_at NULLS FIRST,t.rank,t.created_at,t.id
    `, [input.workspaceId, input.projectId, input.listId, input.includeArchived ?? false, input.status ?? null]);
    return result.rows.map(mapTodo);
  });
}

export async function readTodo(
  input: { workspaceId: string; projectId: string; todoId: string },
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<Todo> {
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, principalId);
    const row = await todoRow(client, input);
    await authorizeTodo(client, { ...input, principalId, listId: row.list_id, capability: "todo.read" });
    return mapTodo(row);
  });
}

export async function createTodo(
  raw: {
    workspaceId: string;
    projectId: string;
    listId: string;
    parentTodoId?: string | null;
    title: string;
    body?: Record<string, unknown>;
    assigneePrincipalId?: string | null;
    startsAt?: string | null;
    dueAt?: string | null;
    timeZone?: string;
    rank?: number;
  },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<Todo>> {
  const content = raw.body === undefined ? emptyScheduleDocument() : structuredScheduleDocument(raw.body, "To-do body");
  const input = {
    ...raw,
    parentTodoId: raw.parentTodoId ?? null,
    title: boundedTitle(raw.title),
    body: content.document,
    plainText: content.plainText,
    assigneePrincipalId: raw.assigneePrincipalId ?? null,
    startsAt: optionalInstant(raw.startsAt, "Start time") ?? null,
    dueAt: optionalInstant(raw.dueAt, "Due time") ?? null,
    timeZone: validateTimeZone(raw.timeZone),
    rank: validateRank(raw.rank),
  };
  validateWindow(input.startsAt, input.dueAt);
  const operation = "todo.create";
  const digest = requestDigest(input);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<Todo>(client, {
      workspaceId: input.workspaceId, projectId: input.projectId,
      principalId: context.actorPrincipalId, operation, key: context.idempotencyKey, digest,
    });
    if (replay) return replay;
    await authorizeScheduleProjectCapability(client, {
      workspaceId: input.workspaceId, projectId: input.projectId,
      principalId: context.actorPrincipalId, capability: "todo.create",
    });
    const policy = await authorizeTodo(client, {
      ...input, principalId: context.actorPrincipalId, capability: "todo.edit",
    });
    if (policy.archived) throw new FoundationServiceError("CONFLICT", "Archived lists cannot receive to-dos.");
    const id = newFolioId();
    const inserted = await client.query<TodoRow>(`
      WITH created AS (
        INSERT INTO todos(
          id,workspace_id,project_id,list_id,parent_todo_id,title,body,plain_text,
          assignee_principal_id,starts_at,due_at,time_zone,rank,
          created_by_principal_id,updated_by_principal_id
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)
        RETURNING *
      )
      SELECT ${todoColumns.replaceAll("t.", "created.")}
      FROM created LEFT JOIN principals p ON p.id=created.assignee_principal_id
    `, [id,input.workspaceId,input.projectId,input.listId,input.parentTodoId,input.title,
      input.body,input.plainText,input.assigneePrincipalId,input.startsAt,input.dueAt,
      input.timeZone,input.rank,context.actorPrincipalId]);
    const data = mapTodo(inserted.rows[0]!);
    return recordMutation(client, {
      workspaceId: input.workspaceId, projectId: input.projectId, context,
      operation, digest, action: operation, targetType: "todo", targetId: id,
      aggregateType: "todo", aggregateRevision: 1, eventType: "todo.created.v1",
      inputSummary: {
        listId: input.listId, parentTodoId: input.parentTodoId,
        titleLength: input.title.length, bodyLength: input.plainText.length,
        hasAssignee: input.assigneePrincipalId !== null, hasSchedule: Boolean(input.startsAt || input.dueAt),
      },
      resultSummary: { todoId: id, listId: input.listId, revision: 1 }, data,
    });
  });
}

export async function updateTodo(
  raw: {
    workspaceId: string;
    projectId: string;
    todoId: string;
    expectedRevision: number;
    parentTodoId?: string | null;
    title?: string;
    body?: Record<string, unknown>;
    assigneePrincipalId?: string | null;
    startsAt?: string | null;
    dueAt?: string | null;
    timeZone?: string;
    rank?: number;
  },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<Todo>> {
  validateRevision(raw.expectedRevision);
  const changed = ["parentTodoId","title","body","assigneePrincipalId","startsAt","dueAt","timeZone","rank"]
    .filter((field) => Object.prototype.hasOwnProperty.call(raw, field));
  if (!changed.length) throw new FoundationServiceError("VALIDATION_FAILED", "At least one to-do field must change.");
  const content = raw.body === undefined ? undefined : structuredScheduleDocument(raw.body, "To-do body");
  const input = {
    ...raw,
    title: raw.title === undefined ? undefined : boundedTitle(raw.title),
    body: content?.document,
    plainText: content?.plainText,
    startsAt: optionalInstant(raw.startsAt, "Start time"),
    dueAt: optionalInstant(raw.dueAt, "Due time"),
    timeZone: raw.timeZone === undefined ? undefined : validateTimeZone(raw.timeZone),
    rank: raw.rank === undefined ? undefined : validateRank(raw.rank),
  };
  const operation = "todo.update";
  const digest = requestDigest(input);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<Todo>(client, {
      workspaceId: input.workspaceId, projectId: input.projectId,
      principalId: context.actorPrincipalId, operation, key: context.idempotencyKey, digest,
    });
    if (replay) return replay;
    const current = await todoRow(client, input);
    await authorizeTodo(client, {
      workspaceId: input.workspaceId, projectId: input.projectId, listId: current.list_id,
      principalId: context.actorPrincipalId, capability: "todo.edit",
    });
    if (current.archived_at) throw new FoundationServiceError("CONFLICT", "Archived to-dos cannot be edited.");
    const startsAt = input.startsAt === undefined ? current.starts_at?.toISOString() ?? null : input.startsAt;
    const dueAt = input.dueAt === undefined ? current.due_at?.toISOString() ?? null : input.dueAt;
    validateWindow(startsAt, dueAt);
    const updated = await client.query<TodoRow>(`
      WITH changed AS (
        UPDATE todos SET
          parent_todo_id=CASE WHEN $5::boolean THEN $6::uuid ELSE parent_todo_id END,
          title=coalesce($7,title),
          body=coalesce($8,body), plain_text=coalesce($9,plain_text),
          assignee_principal_id=CASE WHEN $10::boolean THEN $11::uuid ELSE assignee_principal_id END,
          starts_at=CASE WHEN $12::boolean THEN $13::timestamptz ELSE starts_at END,
          due_at=CASE WHEN $14::boolean THEN $15::timestamptz ELSE due_at END,
          time_zone=coalesce($16,time_zone), rank=coalesce($17,rank),
          revision=revision+1,updated_by_principal_id=$18,updated_at=now()
        WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND revision=$4 AND archived_at IS NULL
        RETURNING *
      )
      SELECT ${todoColumns.replaceAll("t.", "changed.")}
      FROM changed LEFT JOIN principals p ON p.id=changed.assignee_principal_id
    `, [input.workspaceId,input.projectId,input.todoId,input.expectedRevision,
      Object.prototype.hasOwnProperty.call(raw,"parentTodoId"),input.parentTodoId ?? null,
      input.title ?? null,input.body ?? null,input.plainText ?? null,
      Object.prototype.hasOwnProperty.call(raw,"assigneePrincipalId"),input.assigneePrincipalId ?? null,
      Object.prototype.hasOwnProperty.call(raw,"startsAt"),input.startsAt ?? null,
      Object.prototype.hasOwnProperty.call(raw,"dueAt"),input.dueAt ?? null,
      input.timeZone ?? null,input.rank ?? null,context.actorPrincipalId]);
    if (!updated.rows[0]) {
      const latest = await todoRow(client, input);
      throw new FoundationServiceError("REVISION_CONFLICT", "To-do changed after it was read.", {
        expectedRevision: input.expectedRevision, currentRevision: Number(latest.revision),
      });
    }
    const data = mapTodo(updated.rows[0]);
    return recordMutation(client, {
      workspaceId: input.workspaceId, projectId: input.projectId, context,
      operation,digest,action:operation,targetType:"todo",targetId:input.todoId,
      aggregateType:"todo",aggregateRevision:data.revision,eventType:"todo.updated.v1",
      inputSummary:{ changedFields: changed, bodyLength: input.plainText?.length },
      resultSummary:{ todoId:data.id,listId:data.listId,revision:data.revision },data,
    });
  });
}

export async function changeTodoStatus(
  raw: { workspaceId: string; projectId: string; todoId: string; expectedRevision: number; status: TodoStatus },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<Todo>> {
  validateRevision(raw.expectedRevision);
  const operation = `todo.${raw.status === "completed" ? "complete" : raw.status === "canceled" ? "cancel" : "reopen"}`;
  const digest = requestDigest(raw);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, raw.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<Todo>(client, {
      workspaceId:raw.workspaceId,projectId:raw.projectId,principalId:context.actorPrincipalId,
      operation,key:context.idempotencyKey,digest,
    });
    if (replay) return replay;
    const current = await todoRow(client, raw);
    await authorizeTodo(client, {
      workspaceId:raw.workspaceId,projectId:raw.projectId,listId:current.list_id,
      principalId:context.actorPrincipalId,capability:"todo.edit",
    });
    if (current.archived_at) throw new FoundationServiceError("CONFLICT", "Archived to-dos cannot change status.");
    const updated = await client.query<TodoRow>(`
      WITH changed AS (
        UPDATE todos SET status=$5,
          completed_at=CASE WHEN $5='completed' THEN now() ELSE NULL END,
          revision=revision+1,updated_by_principal_id=$6,updated_at=now()
        WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND revision=$4 AND archived_at IS NULL
        RETURNING *
      ) SELECT ${todoColumns.replaceAll("t.", "changed.")}
      FROM changed LEFT JOIN principals p ON p.id=changed.assignee_principal_id
    `,[raw.workspaceId,raw.projectId,raw.todoId,raw.expectedRevision,raw.status,context.actorPrincipalId]);
    if (!updated.rows[0]) {
      const latest=await todoRow(client,raw);
      throw new FoundationServiceError("REVISION_CONFLICT","To-do status changed after it was read.",{
        expectedRevision:raw.expectedRevision,currentRevision:Number(latest.revision),
      });
    }
    const data=mapTodo(updated.rows[0]);
    return recordMutation(client,{
      workspaceId:raw.workspaceId,projectId:raw.projectId,context,operation,digest,
      action:operation,targetType:"todo",targetId:raw.todoId,aggregateType:"todo",
      aggregateRevision:data.revision,eventType:`todo.${raw.status}.v1`,inputSummary:{},
      resultSummary:{todoId:data.id,status:data.status,revision:data.revision},data,
    });
  });
}

async function setTodoArchived(
  raw:{workspaceId:string;projectId:string;todoId:string;expectedRevision:number},
  context:MutationContext,
  archived:boolean,
  pool:Pool,
):Promise<MutationResult<Todo>>{
  validateRevision(raw.expectedRevision);
  const operation=archived?"todo.archive":"todo.restore";
  const digest=requestDigest(raw);
  return inTransaction(pool,async(client)=>{
    await establishTenantContext(client,raw.workspaceId,context.actorPrincipalId);
    await lockIdempotencyKey(client,context.actorPrincipalId,operation,context.idempotencyKey);
    const replay=await findIdempotentResult<Todo>(client,{workspaceId:raw.workspaceId,projectId:raw.projectId,
      principalId:context.actorPrincipalId,operation,key:context.idempotencyKey,digest});
    if(replay)return replay;
    const current=await todoRow(client,raw);
    const policy=await authorizeTodo(client,{workspaceId:raw.workspaceId,projectId:raw.projectId,
      listId:current.list_id,principalId:context.actorPrincipalId,capability:"todo.archive"});
    if(!archived){
      if(policy.archived)throw new FoundationServiceError("CONFLICT","Restore the list before restoring its to-dos.");
      if(current.parent_todo_id){
        const parent=await client.query<{archived_at:Date|null}>(`
          SELECT archived_at FROM todos WHERE workspace_id=$1 AND project_id=$2 AND id=$3
        `,[raw.workspaceId,raw.projectId,current.parent_todo_id]);
        if(!parent.rows[0]||parent.rows[0].archived_at){
          throw new FoundationServiceError("CONFLICT","Restore the parent to-do before restoring this child.");
        }
      }
    }
    if(archived){
      const child=await client.query(`SELECT 1 FROM todos WHERE workspace_id=$1 AND project_id=$2
        AND parent_todo_id=$3 AND archived_at IS NULL LIMIT 1`,[raw.workspaceId,raw.projectId,raw.todoId]);
      if(child.rows[0])throw new FoundationServiceError("CONFLICT","Archive child to-dos before their parent.");
    }
    const result=await client.query<TodoRow>(`
      WITH changed AS (
        UPDATE todos SET archived_at=CASE WHEN $5::boolean THEN now() ELSE NULL END,
          revision=revision+1,updated_by_principal_id=$6,updated_at=now()
        WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND revision=$4
          AND (($5::boolean AND archived_at IS NULL) OR (NOT $5::boolean AND archived_at IS NOT NULL))
        RETURNING *
      ) SELECT ${todoColumns.replaceAll("t.","changed.")}
      FROM changed LEFT JOIN principals p ON p.id=changed.assignee_principal_id
    `,[raw.workspaceId,raw.projectId,raw.todoId,raw.expectedRevision,archived,context.actorPrincipalId]);
    if(!result.rows[0]){
      const latest=await todoRow(client,raw);
      throw new FoundationServiceError("REVISION_CONFLICT","To-do lifecycle changed after it was read.",{
        expectedRevision:raw.expectedRevision,currentRevision:Number(latest.revision),
      });
    }
    const data=mapTodo(result.rows[0]);
    return recordMutation(client,{workspaceId:raw.workspaceId,projectId:raw.projectId,context,
      operation,digest,action:operation,targetType:"todo",targetId:raw.todoId,aggregateType:"todo",
      aggregateRevision:data.revision,eventType:archived?"todo.archived.v1":"todo.restored.v1",
      inputSummary:{},resultSummary:{todoId:data.id,revision:data.revision},data});
  });
}

export function archiveTodo(input:{workspaceId:string;projectId:string;todoId:string;expectedRevision:number},context:MutationContext,pool:Pool=postgresPool()){
  return setTodoArchived(input,context,true,pool);
}
export function restoreTodo(input:{workspaceId:string;projectId:string;todoId:string;expectedRevision:number},context:MutationContext,pool:Pool=postgresPool()){
  return setTodoArchived(input,context,false,pool);
}
