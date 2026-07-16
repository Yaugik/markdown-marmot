import type { Pool } from "pg";
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
  scheduleObjectReadScope,
} from "@/services/schedule-access";

export type TodoList = {
  id: string;
  workspaceId: string;
  projectId: string;
  ownerPrincipalId: string;
  name: string;
  visibility: "private" | "project";
  revision: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

type TodoListRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  owner_principal_id: string;
  name: string;
  visibility: TodoList["visibility"];
  revision: string;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
};

const columns = `id,workspace_id,project_id,owner_principal_id,name,visibility,revision,created_at,updated_at,archived_at`;

function mapList(row: TodoListRow): TodoList {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    ownerPrincipalId: row.owner_principal_id,
    name: row.name,
    visibility: row.visibility,
    revision: Number(row.revision),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    archivedAt: row.archived_at?.toISOString() ?? null,
  };
}

function boundedName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 120) {
    throw new FoundationServiceError("VALIDATION_FAILED", "List name must contain 1 to 120 characters.");
  }
  return name;
}

function validateRevision(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Expected revision must be a positive integer.");
  }
}

export async function listTodoLists(
  input: { workspaceId: string; projectId: string; includeArchived?: boolean },
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<TodoList[]> {
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, principalId);
    const scope = await scheduleObjectReadScope(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      principalId,
      objectType: "todo_list",
      capability: "todo.read",
    });
    const result = await client.query<TodoListRow>(`
      SELECT ${columns}
      FROM todo_lists
      WHERE workspace_id=$1 AND project_id=$2
        AND ($3::boolean OR archived_at IS NULL)
        AND (
          owner_principal_id=$4
          OR ($5::boolean AND visibility='project')
          OR id=ANY($6::uuid[])
        )
      ORDER BY archived_at NULLS FIRST, updated_at DESC, id
    `, [input.workspaceId, input.projectId, input.includeArchived ?? false,
      principalId, scope.projectWide, scope.objectIds]);
    return result.rows.map(mapList);
  });
}

export async function createTodoList(
  raw: { workspaceId: string; projectId: string; name: string; visibility?: TodoList["visibility"] },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<TodoList>> {
  const input = { ...raw, name: boundedName(raw.name), visibility: raw.visibility ?? "private" };
  const operation = "todo_list.create";
  const digest = requestDigest(input);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<TodoList>(client, {
      workspaceId: input.workspaceId, projectId: input.projectId,
      principalId: context.actorPrincipalId, operation, key: context.idempotencyKey, digest,
    });
    if (replay) return replay;
    await authorizeScheduleProjectCapability(client, {
      workspaceId: input.workspaceId, projectId: input.projectId,
      principalId: context.actorPrincipalId, capability: "todo.create",
    });
    if (input.visibility === "project") {
      await authorizeScheduleProjectCapability(client, {
        workspaceId: input.workspaceId, projectId: input.projectId,
        principalId: context.actorPrincipalId, capability: "project.update",
      });
    }
    const id = newFolioId();
    const inserted = await client.query<TodoListRow>(`
      INSERT INTO todo_lists(id,workspace_id,project_id,owner_principal_id,name,visibility)
      VALUES($1,$2,$3,$4,$5,$6)
      RETURNING ${columns}
    `, [id, input.workspaceId, input.projectId, context.actorPrincipalId, input.name, input.visibility]);
    const data = mapList(inserted.rows[0]!);
    return recordMutation(client, {
      workspaceId: input.workspaceId, projectId: input.projectId, context,
      operation, digest, action: operation, targetType: "todo_list", targetId: id,
      aggregateType: "todo_list", aggregateRevision: 1, eventType: "todo_list.created.v1",
      inputSummary: { visibility: input.visibility, nameLength: input.name.length },
      resultSummary: { listId: id, visibility: input.visibility }, data,
    });
  });
}

export async function updateTodoList(
  raw: {
    workspaceId: string;
    projectId: string;
    listId: string;
    expectedRevision: number;
    name?: string;
    visibility?: TodoList["visibility"];
  },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<TodoList>> {
  validateRevision(raw.expectedRevision);
  if (raw.name === undefined && raw.visibility === undefined) {
    throw new FoundationServiceError("VALIDATION_FAILED", "At least one list field must change.");
  }
  const input = { ...raw, name: raw.name === undefined ? undefined : boundedName(raw.name) };
  const operation = "todo_list.update";
  const digest = requestDigest(input);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<TodoList>(client, {
      workspaceId: input.workspaceId, projectId: input.projectId,
      principalId: context.actorPrincipalId, operation, key: context.idempotencyKey, digest,
    });
    if (replay) return replay;
    const policy = await readTodoListPolicy(client, input);
    await authorizeScheduleObject(client, {
      workspaceId: input.workspaceId, projectId: input.projectId,
      principalId: context.actorPrincipalId, capability: "todo.edit",
      objectType: "todo_list", objectId: input.listId,
      ownerPrincipalId: policy.ownerPrincipalId, visibility: policy.visibility,
    });
    if (policy.archived) throw new FoundationServiceError("CONFLICT", "Archived lists cannot be edited.");
    if (input.visibility === "project" || policy.visibility === "project" && input.visibility === "private") {
      await authorizeScheduleProjectCapability(client, {
        workspaceId: input.workspaceId, projectId: input.projectId,
        principalId: context.actorPrincipalId, capability: "project.update",
      });
    }
    const updated = await client.query<TodoListRow>(`
      UPDATE todo_lists
      SET name=coalesce($5,name), visibility=coalesce($6,visibility),
        revision=revision+1, updated_at=now()
      WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND revision=$4 AND archived_at IS NULL
      RETURNING ${columns}
    `, [input.workspaceId, input.projectId, input.listId, input.expectedRevision,
      input.name ?? null, input.visibility ?? null]);
    if (!updated.rows[0]) {
      const current = await readTodoListPolicy(client, input);
      throw new FoundationServiceError("REVISION_CONFLICT", "To-do list changed after it was read.", {
        expectedRevision: input.expectedRevision, currentRevision: current.revision,
      });
    }
    const data = mapList(updated.rows[0]);
    return recordMutation(client, {
      workspaceId: input.workspaceId, projectId: input.projectId, context,
      operation, digest, action: operation, targetType: "todo_list", targetId: input.listId,
      aggregateType: "todo_list", aggregateRevision: data.revision, eventType: "todo_list.updated.v1",
      inputSummary: { changedFields: [input.name !== undefined ? "name" : null, input.visibility !== undefined ? "visibility" : null].filter(Boolean) },
      resultSummary: { listId: data.id, revision: data.revision, visibility: data.visibility }, data,
    });
  });
}

async function setListArchived(
  raw: { workspaceId: string; projectId: string; listId: string; expectedRevision: number },
  context: MutationContext,
  archived: boolean,
  pool: Pool,
): Promise<MutationResult<TodoList>> {
  validateRevision(raw.expectedRevision);
  const operation = archived ? "todo_list.archive" : "todo_list.restore";
  const digest = requestDigest(raw);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, raw.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<TodoList>(client, {
      workspaceId: raw.workspaceId, projectId: raw.projectId,
      principalId: context.actorPrincipalId, operation, key: context.idempotencyKey, digest,
    });
    if (replay) return replay;
    const policy = await readTodoListPolicy(client, raw);
    await authorizeScheduleObject(client, {
      workspaceId: raw.workspaceId, projectId: raw.projectId,
      principalId: context.actorPrincipalId, capability: "todo.archive",
      objectType: "todo_list", objectId: raw.listId,
      ownerPrincipalId: policy.ownerPrincipalId, visibility: policy.visibility,
    });
    if (archived) {
      const children = await client.query(`
        SELECT 1 FROM todos
        WHERE workspace_id=$1 AND project_id=$2 AND list_id=$3 AND archived_at IS NULL LIMIT 1
      `, [raw.workspaceId, raw.projectId, raw.listId]);
      if (children.rows[0]) throw new FoundationServiceError("CONFLICT", "Archive list to-dos before archiving the list.");
    }
    const result = await client.query<TodoListRow>(`
      UPDATE todo_lists
      SET archived_at=CASE WHEN $5::boolean THEN now() ELSE NULL END,
        revision=revision+1, updated_at=now()
      WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND revision=$4
        AND (($5::boolean AND archived_at IS NULL) OR (NOT $5::boolean AND archived_at IS NOT NULL))
      RETURNING ${columns}
    `, [raw.workspaceId, raw.projectId, raw.listId, raw.expectedRevision, archived]);
    if (!result.rows[0]) {
      const current = await readTodoListPolicy(client, raw);
      throw new FoundationServiceError("REVISION_CONFLICT", "To-do list lifecycle changed after it was read.", {
        expectedRevision: raw.expectedRevision, currentRevision: current.revision,
      });
    }
    const data = mapList(result.rows[0]);
    return recordMutation(client, {
      workspaceId: raw.workspaceId, projectId: raw.projectId, context,
      operation, digest, action: operation, targetType: "todo_list", targetId: raw.listId,
      aggregateType: "todo_list", aggregateRevision: data.revision,
      eventType: archived ? "todo_list.archived.v1" : "todo_list.restored.v1",
      inputSummary: {}, resultSummary: { listId: data.id, revision: data.revision }, data,
    });
  });
}

export function archiveTodoList(
  input: { workspaceId: string; projectId: string; listId: string; expectedRevision: number },
  context: MutationContext,
  pool: Pool = postgresPool(),
) {
  return setListArchived(input, context, true, pool);
}

export function restoreTodoList(
  input: { workspaceId: string; projectId: string; listId: string; expectedRevision: number },
  context: MutationContext,
  pool: Pool = postgresPool(),
) {
  return setListArchived(input, context, false, pool);
}
