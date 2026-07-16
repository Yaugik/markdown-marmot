import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { newFolioId } from "@/lib/folio-ids";
import { FoundationServiceError } from "./errors";
import type { MutationContext, MutationResult } from "./types";

export async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function requestDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function lockIdempotencyKey(
  client: PoolClient,
  principalId: string,
  operation: string,
  key: string,
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `${principalId}:${operation}:${key}`,
  ]);
}

type StoredMutation<T> = MutationResult<T>;

export async function findIdempotentResult<T>(
  client: PoolClient,
  input: {
    workspaceId?: string;
    projectId?: string;
    projectAgnostic?: boolean;
    principalId: string;
    operation: string;
    key: string;
    digest: string;
  },
): Promise<StoredMutation<T> | null> {
  if (input.workspaceId && input.projectAgnostic) {
    const result = await client.query<{ request_digest: string; response_body: StoredMutation<T> }>(`
      SELECT request_digest, response_body
      FROM idempotency_records
      WHERE workspace_id = $1 AND principal_id = $2 AND operation = $3
        AND idempotency_key = $4 AND expires_at > now()
      ORDER BY created_at DESC
      LIMIT 1
    `, [input.workspaceId, input.principalId, input.operation, input.key]);
    const row = result.rows[0];
    if (!row) return null;
    if (row.request_digest !== input.digest) {
      throw new FoundationServiceError(
        "IDEMPOTENCY_CONFLICT",
        "The idempotency key was already used with different input.",
        { operation: input.operation },
      );
    }
    return { ...row.response_body, replayed: true };
  }

  const values = input.workspaceId
    ? [input.workspaceId, input.projectId ?? null, input.principalId, input.operation, input.key]
    : [input.principalId, input.operation, input.key];
  const result = input.workspaceId
    ? await client.query<{ request_digest: string; response_body: StoredMutation<T> }>(`
        SELECT request_digest, response_body
        FROM idempotency_records
        WHERE workspace_id = $1 AND project_id IS NOT DISTINCT FROM $2
          AND principal_id = $3 AND operation = $4 AND idempotency_key = $5
          AND expires_at > now()
      `, values)
    : await client.query<{ request_digest: string; response_body: StoredMutation<T> }>(`
        SELECT request_digest, response_body
        FROM idempotency_records
        WHERE project_id IS NULL AND principal_id = $1 AND operation = $2
          AND idempotency_key = $3 AND expires_at > now()
        ORDER BY created_at DESC
        LIMIT 1
      `, values);
  const row = result.rows[0];
  if (!row) return null;
  if (row.request_digest !== input.digest) {
    throw new FoundationServiceError(
      "IDEMPOTENCY_CONFLICT",
      "The idempotency key was already used with different input.",
      { operation: input.operation },
    );
  }
  return { ...row.response_body, replayed: true };
}

export async function recordMutation<T>(
  client: PoolClient,
  input: {
    workspaceId: string;
    projectId?: string;
    context: MutationContext;
    operation: string;
    digest: string;
    action: string;
    targetType: string;
    targetId: string;
    aggregateType: string;
    aggregateRevision: number;
    eventType: string;
    inputSummary: Record<string, unknown>;
    resultSummary: Record<string, unknown>;
    data: T;
  },
): Promise<MutationResult<T>> {
  const activityId = newFolioId();
  const outboxEventId = newFolioId();
  const result: MutationResult<T> = {
    data: input.data,
    activityId,
    outboxEventId,
    replayed: false,
  };
  await client.query(`
    INSERT INTO activity_events (
      id, workspace_id, project_id, actor_principal_id, authorizing_principal_id,
      source, action, target_type, target_id, input_summary, result_summary,
      request_id, trace_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
  `, [
    activityId, input.workspaceId, input.projectId ?? null, input.context.actorPrincipalId,
    input.context.authorizingPrincipalId ?? input.context.actorPrincipalId,
    input.context.source ?? "api", input.action, input.targetType, input.targetId,
    input.inputSummary, input.resultSummary, input.context.requestId, input.context.traceId,
  ]);
  await client.query(`
    INSERT INTO outbox_events (
      id, workspace_id, project_id, aggregate_type, aggregate_id, aggregate_revision,
      event_type, actor_principal_id, authorizing_principal_id, request_id, trace_id, payload
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
  `, [
    outboxEventId, input.workspaceId, input.projectId ?? null, input.aggregateType,
    input.targetId, input.aggregateRevision, input.eventType, input.context.actorPrincipalId,
    input.context.authorizingPrincipalId ?? input.context.actorPrincipalId,
    input.context.requestId, input.context.traceId, input.resultSummary,
  ]);
  await client.query(`
    INSERT INTO idempotency_records (
      id, workspace_id, project_id, principal_id, operation, idempotency_key,
      request_digest, response_status, response_body, expires_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, 201, $8, now() + interval '24 hours')
  `, [
    newFolioId(), input.workspaceId, input.projectId ?? null, input.context.actorPrincipalId,
    input.operation, input.context.idempotencyKey, input.digest, result,
  ]);
  return result;
}

export function asNumber(value: string | number): number {
  return typeof value === "number" ? value : Number(value);
}
