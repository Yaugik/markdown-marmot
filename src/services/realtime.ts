import type { Pool, PoolClient } from "pg";
import { postgresPool } from "@/db/postgres";
import { establishTenantContext } from "@/db/tenant";
import { newFolioId } from "@/lib/folio-ids";
import { authorizeIssueCapability } from "@/services/issue-access";
import { authorizePageCapability } from "@/services/page-access";
import { FoundationServiceError } from "@/services/foundation/errors";
import { inTransaction } from "@/services/foundation/internal";
import {
  authorizeScheduleObject,
  authorizeScheduleProjectCapability,
  readCalendarPolicy,
  readTodoListPolicy,
} from "@/services/schedule-access";

export type RealtimeEvent = {
  cursorId: number;
  id: string;
  topicType: string;
  topicId: string;
  eventType: string;
  aggregateRevision: number;
  actorPrincipalId: string;
  payload: Record<string, unknown>;
  occurredAt: string;
};

export type PresenceSession = {
  id: string;
  channelType: "page" | "project" | "calendar" | "todo_list";
  channelId: string;
  principalId: string;
  displayName: string;
  clientId: string;
  state: Record<string, unknown>;
  connectedAt: string;
  lastSeenAt: string;
  expiresAt: string;
};

type EventRow = {
  cursor_id: string;
  id: string;
  topic_type: string;
  topic_id: string;
  event_type: string;
  aggregate_revision: string;
  actor_principal_id: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
};

type PresenceRow = {
  id: string;
  channel_type: PresenceSession["channelType"];
  channel_id: string;
  principal_id: string;
  display_name: string;
  client_id: string;
  state: Record<string, unknown>;
  connected_at: Date;
  last_seen_at: Date;
  expires_at: Date;
};

function mapEvent(row: EventRow): RealtimeEvent {
  return {
    cursorId: Number(row.cursor_id),
    id: row.id,
    topicType: row.topic_type,
    topicId: row.topic_id,
    eventType: row.event_type,
    aggregateRevision: Number(row.aggregate_revision),
    actorPrincipalId: row.actor_principal_id,
    payload: row.payload,
    occurredAt: row.occurred_at.toISOString(),
  };
}

function mapPresence(row: PresenceRow): PresenceSession {
  return {
    id: row.id,
    channelType: row.channel_type,
    channelId: row.channel_id,
    principalId: row.principal_id,
    displayName: row.display_name,
    clientId: row.client_id,
    state: row.state,
    connectedAt: row.connected_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  };
}

async function authorizeChannel(
  client: PoolClient,
  input: {
    workspaceId: string;
    projectId: string;
    principalId: string;
    channelType: PresenceSession["channelType"];
    channelId: string;
    writePresence?: boolean;
  },
) {
  await authorizeScheduleProjectCapability(client, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    principalId: input.principalId,
    capability: input.writePresence ? "presence.write" : "realtime.read",
  });
  if (input.channelType === "project") {
    if (input.channelId !== input.projectId) {
      throw new FoundationServiceError("NOT_FOUND", "Realtime channel was not found.");
    }
    return;
  }
  if (input.channelType === "page") {
    await authorizePageCapability(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      principalId: input.principalId,
      capability: "page.read",
      pageId: input.channelId,
    });
    return;
  }
  if (input.channelType === "todo_list") {
    const policy = await readTodoListPolicy(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      listId: input.channelId,
    });
    await authorizeScheduleObject(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      principalId: input.principalId,
      capability: "todo.read",
      objectType: "todo_list",
      objectId: input.channelId,
      ownerPrincipalId: policy.ownerPrincipalId,
      visibility: policy.visibility,
    });
    return;
  }
  const policy = await readCalendarPolicy(client, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    calendarId: input.channelId,
  });
  await authorizeScheduleObject(client, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    principalId: input.principalId,
    capability: "calendar.read",
    objectType: "calendar",
    objectId: input.channelId,
    ownerPrincipalId: policy.ownerPrincipalId,
    visibility: policy.visibility,
  });
}

async function authorizeTodoTopic(
  client: PoolClient,
  input: { workspaceId: string; projectId: string; principalId: string; todoId: string },
) {
  const todo = await client.query<{ list_id: string }>(`
    SELECT list_id FROM todos WHERE workspace_id=$1 AND project_id=$2 AND id=$3
  `, [input.workspaceId,input.projectId,input.todoId]);
  if (!todo.rows[0]) throw new FoundationServiceError("NOT_FOUND", "To-do topic was not found.");
  await authorizeChannel(client, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    principalId: input.principalId,
    channelType: "todo_list",
    channelId: todo.rows[0].list_id,
  });
}

async function authorizeEntryTopic(
  client: PoolClient,
  input: { workspaceId: string; projectId: string; principalId: string; entryId: string },
) {
  const entry = await client.query<{ calendar_id: string }>(`
    SELECT calendar_id FROM calendar_entries WHERE workspace_id=$1 AND project_id=$2 AND id=$3
  `, [input.workspaceId,input.projectId,input.entryId]);
  if (!entry.rows[0]) throw new FoundationServiceError("NOT_FOUND", "Calendar entry topic was not found.");
  await authorizeChannel(client, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    principalId: input.principalId,
    channelType: "calendar",
    channelId: entry.rows[0].calendar_id,
  });
}

async function visibleEvent(
  client: PoolClient,
  input: { workspaceId: string; projectId: string; principalId: string; row: EventRow },
): Promise<boolean> {
  try {
    const type = input.row.topic_type;
    if (type === "page") {
      await authorizePageCapability(client, {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        principalId: input.principalId,
        capability: "page.read",
        pageId: input.row.topic_id,
      });
      return true;
    }
    if (type === "issue") {
      await authorizeIssueCapability(client, {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        principalId: input.principalId,
        capability: "issue.read",
        issueId: input.row.topic_id,
      });
      return true;
    }
    if (type === "todo_list" || type === "calendar") {
      await authorizeChannel(client, {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        principalId: input.principalId,
        channelType: type,
        channelId: input.row.topic_id,
      });
      return true;
    }
    if (type === "todo") {
      await authorizeTodoTopic(client, { ...input, todoId: input.row.topic_id });
      return true;
    }
    if (type === "calendar_entry") {
      await authorizeEntryTopic(client, { ...input, entryId: input.row.topic_id });
      return true;
    }
    if (type === "reminder") {
      const reminder = await client.query<{
        recipient_principal_id: string;
        todo_id: string | null;
        calendar_entry_id: string | null;
      }>(`
        SELECT recipient_principal_id,todo_id,calendar_entry_id
        FROM reminders WHERE workspace_id=$1 AND project_id=$2 AND id=$3
      `, [input.workspaceId,input.projectId,input.row.topic_id]);
      const row = reminder.rows[0];
      if (!row) return false;
      if (row.recipient_principal_id === input.principalId) return true;
      if (row.todo_id) {
        await authorizeTodoTopic(client, { ...input, todoId: row.todo_id });
        return true;
      }
      if (row.calendar_entry_id) {
        await authorizeEntryTopic(client, { ...input, entryId: row.calendar_entry_id });
        return true;
      }
      return false;
    }
    if (type === "agent_schedule_grant") {
      const grant = await client.query<{
        agent_principal_id: string;
        authorizing_principal_id: string;
      }>(`
        SELECT agent_principal_id,authorizing_principal_id
        FROM agent_schedule_grants
        WHERE workspace_id=$1 AND project_id=$2 AND id=$3
      `, [input.workspaceId,input.projectId,input.row.topic_id]);
      const row = grant.rows[0];
      return Boolean(row && (
        row.agent_principal_id === input.principalId
        || row.authorizing_principal_id === input.principalId
      ));
    }
    if (type === "integration_connection") {
      const connection = await client.query<{ owner_principal_id: string }>(`
        SELECT owner_principal_id FROM integration_connections
        WHERE workspace_id=$1 AND project_id=$2 AND id=$3
      `, [input.workspaceId,input.projectId,input.row.topic_id]);
      return connection.rows[0]?.owner_principal_id === input.principalId;
    }
    if (type === "provider_operation") {
      const operation = await client.query<{ created_by_principal_id: string }>(`
        SELECT created_by_principal_id FROM provider_operations
        WHERE workspace_id=$1 AND project_id=$2 AND id=$3
      `, [input.workspaceId,input.projectId,input.row.topic_id]);
      return operation.rows[0]?.created_by_principal_id === input.principalId;
    }
    if (type === "project") {
      return input.row.topic_id === input.projectId;
    }
    return false;
  } catch (error) {
    if (error instanceof FoundationServiceError && ["NOT_FOUND", "CAPABILITY_DENIED"].includes(error.code)) {
      return false;
    }
    throw error;
  }
}

export async function readRealtimeEvents(
  input: {
    workspaceId: string;
    projectId: string;
    afterCursor?: number;
    limit?: number;
    topicType?: string;
    topicId?: string;
  },
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<{ events: RealtimeEvent[]; nextCursor: number }> {
  const after = Math.max(0, input.afterCursor ?? 0);
  const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, principalId);
    await authorizeScheduleProjectCapability(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      principalId,
      capability: "realtime.read",
    });
    const result = await client.query<EventRow>(`
      SELECT cursor_id,id,topic_type,topic_id,event_type,aggregate_revision,
        actor_principal_id,payload,occurred_at
      FROM realtime_event_log
      WHERE workspace_id=$1 AND project_id=$2 AND cursor_id>$3
        AND ($4::text IS NULL OR topic_type=$4)
        AND ($5::uuid IS NULL OR topic_id=$5)
      ORDER BY cursor_id
      LIMIT $6
    `, [input.workspaceId,input.projectId,after,input.topicType ?? null,input.topicId ?? null,limit * 8]);
    const visible: RealtimeEvent[] = [];
    let cursor = after;
    for (const row of result.rows) {
      cursor = Math.max(cursor, Number(row.cursor_id));
      if (await visibleEvent(client, { ...input, principalId, row })) visible.push(mapEvent(row));
      if (visible.length >= limit) break;
    }
    return { events: visible, nextCursor: cursor };
  });
}

export async function heartbeatPresence(
  input: {
    workspaceId: string;
    projectId: string;
    channelType: PresenceSession["channelType"];
    channelId: string;
    clientId: string;
    state?: Record<string, unknown>;
    ttlSeconds?: number;
  },
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<PresenceSession> {
  const clientId = input.clientId.trim();
  if (!clientId || clientId.length > 180) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Presence client ID is invalid.");
  }
  const state = input.state ?? {};
  if (Buffer.byteLength(JSON.stringify(state)) > 4096) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Presence state must be at most 4 KiB.");
  }
  const ttl = Math.max(15, Math.min(input.ttlSeconds ?? 60, 300));
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, principalId);
    await authorizeChannel(client, { ...input, principalId, writePresence: true });
    const id = newFolioId();
    const result = await client.query<PresenceRow>(`
      WITH upserted AS (
        INSERT INTO presence_sessions(
          id,workspace_id,project_id,channel_type,channel_id,principal_id,
          client_id,state,expires_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+make_interval(secs=>$9))
        ON CONFLICT(workspace_id,project_id,channel_type,channel_id,principal_id,client_id)
        DO UPDATE SET state=EXCLUDED.state,last_seen_at=now(),
          expires_at=now()+make_interval(secs=>$9)
        RETURNING *
      )
      SELECT u.id,u.channel_type,u.channel_id,u.principal_id,p.display_name,
        u.client_id,u.state,u.connected_at,u.last_seen_at,u.expires_at
      FROM upserted u JOIN principals p ON p.id=u.principal_id
    `, [id,input.workspaceId,input.projectId,input.channelType,input.channelId,
      principalId,clientId,state,ttl]);
    return mapPresence(result.rows[0]!);
  });
}

export async function listPresence(
  input: {
    workspaceId: string;
    projectId: string;
    channelType: PresenceSession["channelType"];
    channelId: string;
  },
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<PresenceSession[]> {
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, principalId);
    await authorizeChannel(client, { ...input, principalId });
    await client.query(`DELETE FROM presence_sessions WHERE workspace_id=$1 AND expires_at<=now()`, [input.workspaceId]);
    const result = await client.query<PresenceRow>(`
      SELECT s.id,s.channel_type,s.channel_id,s.principal_id,p.display_name,
        s.client_id,s.state,s.connected_at,s.last_seen_at,s.expires_at
      FROM presence_sessions s JOIN principals p ON p.id=s.principal_id
      WHERE s.workspace_id=$1 AND s.project_id=$2 AND s.channel_type=$3
        AND s.channel_id=$4 AND s.expires_at>now()
      ORDER BY p.display_name,s.client_id
    `, [input.workspaceId,input.projectId,input.channelType,input.channelId]);
    return result.rows.map(mapPresence);
  });
}

export async function leavePresence(
  input: {
    workspaceId: string;
    projectId: string;
    channelType: PresenceSession["channelType"];
    channelId: string;
    clientId: string;
  },
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<void> {
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, principalId);
    await authorizeChannel(client, { ...input, principalId, writePresence: true });
    await client.query(`
      DELETE FROM presence_sessions
      WHERE workspace_id=$1 AND project_id=$2 AND channel_type=$3
        AND channel_id=$4 AND principal_id=$5 AND client_id=$6
    `, [input.workspaceId,input.projectId,input.channelType,input.channelId,principalId,input.clientId]);
  });
}
