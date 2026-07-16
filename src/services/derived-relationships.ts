import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { postgresPool } from "@/db/postgres";
import { establishTenantContext } from "@/db/tenant";
import { newFolioId } from "@/lib/folio-ids";
import { authorizeAgentEntityRead, authorizeAgentProjectCapability } from "@/services/agent-spatial-access";
import { authorizeEcosystemProjectCapability, authorizeGraphEntityRead, type GraphEntityType } from "@/services/ecosystem-access";
import { FoundationServiceError } from "@/services/foundation/errors";
import { findIdempotentResult, inTransaction, lockIdempotencyKey, recordMutation, requestDigest } from "@/services/foundation/internal";
import type { MutationContext, MutationResult } from "@/services/foundation/types";

export type DerivationSourceKind = "page_revision" | "issue_revision" | "todo_revision" | "calendar_revision" | "provider_observation" | "agent_synthesis";
export type DerivedRelationshipCandidate = {
  relationshipTypeId: string;
  target: { type: GraphEntityType; id: string };
  confidence?: number | null;
  metadata?: Record<string, unknown>;
};
export type RelationshipDerivationRun = {
  id: string;
  sourceKind: DerivationSourceKind;
  source: { type: GraphEntityType; id: string; revision: string };
  rebuildKey: string;
  payloadHash: string;
  state: "running" | "succeeded" | "failed" | "superseded";
  relationshipCount: number;
  createdByPrincipalId: string;
  createdAt: string;
  completedAt: string | null;
};

type RunRow = {
  id: string; source_kind: DerivationSourceKind; source_entity_type: GraphEntityType;
  source_entity_id: string; source_revision: string; rebuild_key: string; payload_hash: string;
  state: RelationshipDerivationRun["state"]; relationship_count: number;
  created_by_principal_id: string; created_at: Date; completed_at: Date | null;
};

function mapRun(row: RunRow): RelationshipDerivationRun {
  return {
    id: row.id,
    sourceKind: row.source_kind,
    source: { type: row.source_entity_type, id: row.source_entity_id, revision: row.source_revision },
    rebuildKey: row.rebuild_key,
    payloadHash: row.payload_hash,
    state: row.state,
    relationshipCount: Number(row.relationship_count),
    createdByPrincipalId: row.created_by_principal_id,
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
  };
}

function confidence(value: number | null | undefined) {
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Derived relationship confidence must be between zero and one.");
  }
  return value;
}

async function authorizeSourceMode(
  input: {
    workspaceId: string;
    projectId: string;
    sourceKind: DerivationSourceKind;
    source: { type: GraphEntityType; id: string };
    candidates: Array<{ target: { type: GraphEntityType; id: string } }>;
  },
  context: MutationContext,
  pool: Pool,
) {
  const source = context.source ?? "api";
  if (source === "agent") {
    if (input.sourceKind !== "agent_synthesis" || !context.authorizingPrincipalId || context.authorizingPrincipalId === context.actorPrincipalId) {
      throw new FoundationServiceError("CAPABILITY_DENIED", "Agent-derived relationships require an agent synthesis source and a distinct human authorizer.");
    }
    const chain = {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      agentPrincipalId: context.actorPrincipalId,
      authorizingPrincipalId: context.authorizingPrincipalId,
    };
    await authorizeAgentProjectCapability({ ...chain, capability: "relationship.edit" }, pool);
    await authorizeAgentEntityRead({ ...chain, entityType: input.source.type, entityId: input.source.id }, pool);
    for (const candidate of input.candidates) {
      await authorizeAgentEntityRead({ ...chain, entityType: candidate.target.type, entityId: candidate.target.id }, pool);
    }
    return;
  }
  if (source !== "worker" && source !== "system") {
    throw new FoundationServiceError("CAPABILITY_DENIED", "Derived relationship rebuilds are limited to workers, systems, and authorized project agents.");
  }
}

export async function rebuildDerivedRelationships(
  raw: {
    workspaceId: string;
    projectId: string;
    sourceKind: DerivationSourceKind;
    source: { type: GraphEntityType; id: string; revision: string };
    rebuildKey: string;
    candidates: DerivedRelationshipCandidate[];
  },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<RelationshipDerivationRun>> {
  const rebuildKey = raw.rebuildKey.trim();
  const sourceRevision = raw.source.revision.trim();
  if (!rebuildKey || rebuildKey.length > 240 || !sourceRevision || sourceRevision.length > 180) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Derived relationship rebuild identity is invalid.");
  }
  if (!raw.candidates.length || raw.candidates.length > 500) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Derived relationship rebuild requires 1 to 500 candidates.");
  }
  const candidates = raw.candidates.map((candidate) => ({
    relationshipTypeId: candidate.relationshipTypeId,
    target: candidate.target,
    confidence: confidence(candidate.confidence),
    metadata: candidate.metadata ?? {},
  }));
  if (Buffer.byteLength(JSON.stringify(candidates)) > 2 * 1024 * 1024) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Derived relationship rebuild payload is too large.");
  }
  const input = { ...raw, rebuildKey, source: { ...raw.source, revision: sourceRevision }, candidates };
  await authorizeSourceMode(input, context, pool);
  const operation = "relationship.derived.rebuild";
  const digest = requestDigest(input);
  const authorizer = context.authorizingPrincipalId ?? context.actorPrincipalId;
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<RelationshipDerivationRun>(client, {
      workspaceId: input.workspaceId, projectId: input.projectId, principalId: context.actorPrincipalId,
      operation, key: context.idempotencyKey, digest,
    });
    if (replay) return replay;
    await authorizeEcosystemProjectCapability(client, {
      workspaceId: input.workspaceId, projectId: input.projectId,
      principalId: authorizer, capability: "relationship.edit",
    });
    await authorizeGraphEntityRead(client, {
      workspaceId: input.workspaceId, projectId: input.projectId, principalId: authorizer,
      entityType: input.source.type, entityId: input.source.id,
    });
    for (const candidate of candidates) {
      await authorizeGraphEntityRead(client, {
        workspaceId: input.workspaceId, projectId: input.projectId, principalId: authorizer,
        entityType: candidate.target.type, entityId: candidate.target.id,
      });
      const relationshipType = await client.query<{ source_entity_types: GraphEntityType[]; target_entity_types: GraphEntityType[]; state: string }>(`
        SELECT source_entity_types,target_entity_types,state FROM relationship_types
        WHERE workspace_id=$1 AND project_id=$2 AND id=$3
      `, [input.workspaceId,input.projectId,candidate.relationshipTypeId]);
      const type = relationshipType.rows[0];
      if (!type || type.state !== "active" || !type.source_entity_types.includes(input.source.type) || !type.target_entity_types.includes(candidate.target.type)) {
        throw new FoundationServiceError("VALIDATION_FAILED", "A derived relationship type does not allow the requested endpoints.");
      }
    }

    const runId = newFolioId();
    const payloadHash = createHash("sha256").update(JSON.stringify(candidates)).digest("hex");
    await client.query(`
      INSERT INTO relationship_derivation_runs(
        id,workspace_id,project_id,source_kind,source_entity_type,source_entity_id,
        source_revision,rebuild_key,payload_hash,state,created_by_principal_id
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'running',$10)
    `, [runId,input.workspaceId,input.projectId,input.sourceKind,input.source.type,input.source.id,
      input.source.revision,input.rebuildKey,payloadHash,context.actorPrincipalId]);

    await client.query(`
      UPDATE entity_relationships relationship
      SET state='archived',archived_at=now(),revision=revision+1,
        updated_by_principal_id=$4,updated_at=now()
      FROM relationship_derivation_runs run
      WHERE relationship.workspace_id=$1 AND relationship.project_id=$2
        AND relationship.derivation_run_id=run.id AND run.rebuild_key=$3
        AND relationship.provenance='derived' AND relationship.archived_at IS NULL
    `, [input.workspaceId,input.projectId,input.rebuildKey,context.actorPrincipalId]);

    for (const candidate of candidates) {
      await client.query(`
        INSERT INTO entity_relationships(
          id,workspace_id,project_id,relationship_type_id,
          source_entity_type,source_entity_id,target_entity_type,target_entity_id,
          provenance,confidence,state,metadata,derivation_run_id,
          created_by_principal_id,updated_by_principal_id
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'derived',$9,'accepted',$10,$11,$12,$12)
      `, [newFolioId(),input.workspaceId,input.projectId,candidate.relationshipTypeId,
        input.source.type,input.source.id,candidate.target.type,candidate.target.id,
        candidate.confidence,{ ...candidate.metadata, rebuildKey: input.rebuildKey, sourceRevision: input.source.revision },
        runId,context.actorPrincipalId]);
    }

    const completed = await client.query<RunRow>(`
      UPDATE relationship_derivation_runs
      SET state='succeeded',relationship_count=$2,completed_at=now()
      WHERE id=$1
      RETURNING id,source_kind,source_entity_type,source_entity_id,source_revision,
        rebuild_key,payload_hash,state,relationship_count,created_by_principal_id,created_at,completed_at
    `, [runId,candidates.length]);
    const data = mapRun(completed.rows[0]!);
    return recordMutation(client, {
      workspaceId: input.workspaceId, projectId: input.projectId, context,
      operation, digest, action: operation, targetType: "relationship_derivation_run", targetId: runId,
      aggregateType: "relationship_derivation_run", aggregateRevision: 1,
      eventType: "relationship.derived_rebuilt.v1",
      inputSummary: { sourceKind: input.sourceKind, sourceType: input.source.type, rebuildKey: input.rebuildKey, candidateCount: candidates.length },
      resultSummary: { derivationRunId: runId, relationshipCount: candidates.length, payloadHash },
      data,
    });
  });
}

export async function readRelationshipDerivationRuns(
  input: { workspaceId: string; projectId: string; sourceType: GraphEntityType; sourceId: string; limit?: number },
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<RelationshipDerivationRun[]> {
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, principalId);
    await authorizeEcosystemProjectCapability(client, { workspaceId: input.workspaceId, projectId: input.projectId, principalId, capability: "relationship.read" });
    await authorizeGraphEntityRead(client, { workspaceId: input.workspaceId, projectId: input.projectId, principalId, entityType: input.sourceType, entityId: input.sourceId });
    const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
    const result = await client.query<RunRow>(`
      SELECT id,source_kind,source_entity_type,source_entity_id,source_revision,rebuild_key,
        payload_hash,state,relationship_count,created_by_principal_id,created_at,completed_at
      FROM relationship_derivation_runs
      WHERE workspace_id=$1 AND project_id=$2 AND source_entity_type=$3 AND source_entity_id=$4
      ORDER BY created_at DESC,id LIMIT $5
    `, [input.workspaceId,input.projectId,input.sourceType,input.sourceId,limit]);
    return result.rows.map(mapRun);
  });
}
