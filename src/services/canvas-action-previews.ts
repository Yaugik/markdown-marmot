import type { Pool } from "pg";
import { postgresPool } from "@/db/postgres";
import { establishTenantContext } from "@/db/tenant";
import { newFolioId } from "@/lib/folio-ids";
import { authorizeEcosystemProjectCapability, authorizeOwnedEcosystemObject, readCanvasPolicy } from "@/services/ecosystem-access";
import { FoundationServiceError } from "@/services/foundation/errors";
import { findIdempotentResult, inTransaction, lockIdempotencyKey, recordMutation, requestDigest } from "@/services/foundation/internal";
import type { MutationContext, MutationResult } from "@/services/foundation/types";
import { readCanvas, type CanvasElement } from "@/services/canvas-scenes";
import { listRelationshipTypes } from "@/services/typed-relationships";

export type CanvasActionKind = "promote_connector" | "convert_sticky" | "organize_region" | "prepare_workshop_output";
export type CanvasActionPreview = {
  id: string;
  workspaceId: string;
  projectId: string;
  canvasId: string;
  actionKind: CanvasActionKind;
  sourceElementIds: string[];
  normalizedInput: Record<string, unknown>;
  snapshot: Record<string, unknown>;
  actionDigest: string;
  riskLevel: "R1" | "R2";
  state: "pending" | "executing" | "succeeded" | "failed" | "expired" | "canceled";
  confirmationId: string | null;
  result: Record<string, unknown> | null;
  createdByPrincipalId: string;
  authorizingPrincipalId: string;
  expiresAt: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
};

export type StickyConversionTarget =
  | { entityType: "page"; title?: string; parentNodeId?: string | null }
  | { entityType: "issue"; title?: string; priority?: "no_priority" | "urgent" | "high" | "medium" | "low" }
  | { entityType: "todo"; listId: string; title?: string; startsAt?: string | null; dueAt?: string | null; timeZone?: string };

export type OrganizeMode = "grid" | "horizontal" | "vertical";

type PreviewRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  canvas_id: string;
  action_kind: CanvasActionKind;
  source_element_ids: string[];
  normalized_input: Record<string, unknown>;
  snapshot: Record<string, unknown>;
  action_digest: string;
  risk_level: "R1" | "R2";
  state: CanvasActionPreview["state"];
  confirmation_id: string | null;
  result: Record<string, unknown> | null;
  created_by_principal_id: string;
  authorizing_principal_id: string;
  expires_at: Date;
  revision: string;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  last_error_code: string | null;
  last_error_message: string | null;
};

const columns = `id,workspace_id,project_id,canvas_id,action_kind,source_element_ids,
  normalized_input,snapshot,action_digest,risk_level,state,confirmation_id,result,
  created_by_principal_id,authorizing_principal_id,expires_at,revision,created_at,
  updated_at,completed_at,last_error_code,last_error_message`;

function mapPreview(row: PreviewRow): CanvasActionPreview {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    canvasId: row.canvas_id,
    actionKind: row.action_kind,
    sourceElementIds: row.source_element_ids,
    normalizedInput: row.normalized_input,
    snapshot: row.snapshot,
    actionDigest: row.action_digest,
    riskLevel: row.risk_level,
    state: row.state,
    confirmationId: row.confirmation_id,
    result: row.result,
    createdByPrincipalId: row.created_by_principal_id,
    authorizingPrincipalId: row.authorizing_principal_id,
    expiresAt: row.expires_at.toISOString(),
    revision: Number(row.revision),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
  };
}

function textFromSticky(element: CanvasElement) {
  for (const candidate of [element.content.text, element.content.title, element.content.label]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  throw new FoundationServiceError("VALIDATION_FAILED", "Sticky conversion requires visible sticky text.");
}

function finiteGeometry(element: CanvasElement) {
  const number = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return {
    x: number(element.geometry.x, 0),
    y: number(element.geometry.y, 0),
    width: Math.max(1, number(element.geometry.width, 220)),
    height: Math.max(1, number(element.geometry.height, 140)),
  };
}

async function authorizeCanvasEdit(
  client: import("pg").PoolClient,
  input: { workspaceId: string; projectId: string; canvasId: string; principalId: string },
) {
  const policy = await readCanvasPolicy(client, input);
  await authorizeOwnedEcosystemObject(client, {
    ...input,
    capability: "canvas.edit",
    objectType: "canvas",
    objectId: input.canvasId,
    ownerPrincipalId: policy.ownerPrincipalId,
    visibility: policy.visibility,
  });
}

async function insertPreview(
  input: {
    workspaceId: string;
    projectId: string;
    canvasId: string;
    actionKind: CanvasActionKind;
    sourceElementIds: string[];
    normalizedInput: Record<string, unknown>;
    snapshot: Record<string, unknown>;
    riskLevel: "R1" | "R2";
  },
  context: MutationContext,
  pool: Pool,
): Promise<MutationResult<CanvasActionPreview>> {
  const operation = `canvas_action_preview.${input.actionKind}`;
  const authorizer = context.authorizingPrincipalId ?? context.actorPrincipalId;
  const actionDigest = requestDigest({
    operation: input.actionKind,
    actorPrincipalId: context.actorPrincipalId,
    authorizingPrincipalId: authorizer,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    canvasId: input.canvasId,
    normalizedInput: input.normalizedInput,
    snapshot: input.snapshot,
  });
  const digest = requestDigest({ ...input, actionDigest, authorizer });
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<CanvasActionPreview>(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      principalId: context.actorPrincipalId,
      operation,
      key: context.idempotencyKey,
      digest,
    });
    if (replay) return replay;
    await authorizeCanvasEdit(client, { ...input, principalId: context.actorPrincipalId });

    const previewId = newFolioId();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    let confirmationId: string | null = null;
    if (input.riskLevel === "R2") {
      confirmationId = newFolioId();
      await client.query(`
        INSERT INTO action_confirmations(
          id,workspace_id,project_id,actor_principal_id,authorizing_principal_id,
          operation,action_digest,risk_level,preview,status,expires_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,'R2',$8,'pending',$9)
      `, [confirmationId,input.workspaceId,input.projectId,context.actorPrincipalId,authorizer,
        `canvas.${input.actionKind}`,actionDigest,{
          canvasId: input.canvasId,
          sourceElementIds: input.sourceElementIds,
          normalizedInput: input.normalizedInput,
          snapshot: input.snapshot,
        },expiresAt.toISOString()]);
    }

    const inserted = await client.query<PreviewRow>(`
      INSERT INTO canvas_action_previews(
        id,workspace_id,project_id,canvas_id,action_kind,source_element_ids,
        normalized_input,snapshot,action_digest,risk_level,confirmation_id,
        created_by_principal_id,authorizing_principal_id,expires_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING ${columns}
    `, [previewId,input.workspaceId,input.projectId,input.canvasId,input.actionKind,
      input.sourceElementIds,input.normalizedInput,input.snapshot,actionDigest,input.riskLevel,
      confirmationId,context.actorPrincipalId,authorizer,expiresAt.toISOString()]);
    const data = mapPreview(inserted.rows[0]!);
    return recordMutation(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      context,
      operation,
      digest,
      action: operation,
      targetType: "canvas_action_preview",
      targetId: previewId,
      aggregateType: "canvas_action_preview",
      aggregateRevision: 1,
      eventType: `canvas_action_preview.${input.actionKind}.created.v1`,
      inputSummary: { canvasId: input.canvasId, sourceCount: input.sourceElementIds.length, riskLevel: input.riskLevel },
      resultSummary: { previewId, confirmationId, actionDigest, expiresAt: data.expiresAt },
      data,
    });
  });
}

export async function prepareConnectorPromotion(
  raw: { workspaceId: string; projectId: string; canvasId: string; connectorElementId: string; relationshipTypeId: string },
  context: MutationContext,
  pool: Pool = postgresPool(),
) {
  const scene = await readCanvas({ workspaceId: raw.workspaceId, projectId: raw.projectId, canvasId: raw.canvasId }, context.actorPrincipalId, pool);
  const connector = scene.elements.find((element) => element.id === raw.connectorElementId && element.kind === "connector");
  if (!connector) throw new FoundationServiceError("NOT_FOUND", "Visible Canvas connector was not found.");
  const fromId = typeof connector.content.fromElementId === "string" ? connector.content.fromElementId : null;
  const toId = typeof connector.content.toElementId === "string" ? connector.content.toElementId : null;
  const from = scene.elements.find((element) => element.id === fromId && element.kind === "entity_card");
  const to = scene.elements.find((element) => element.id === toId && element.kind === "entity_card");
  if (!from?.entityType || !from.entityId || !to?.entityType || !to.entityId) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Connector promotion requires two visible entity-card endpoints.");
  }
  const relationshipTypes = await listRelationshipTypes({ workspaceId: raw.workspaceId, projectId: raw.projectId }, context.actorPrincipalId, pool);
  const relationshipType = relationshipTypes.find((item) => item.id === raw.relationshipTypeId && item.state === "active");
  if (!relationshipType
    || !relationshipType.sourceEntityTypes.includes(from.entityType)
    || !relationshipType.targetEntityTypes.includes(to.entityType)) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Relationship type does not allow the selected connector endpoints.");
  }
  return insertPreview({
    ...raw,
    actionKind: "promote_connector",
    sourceElementIds: [connector.id, from.id, to.id],
    normalizedInput: { relationshipTypeId: relationshipType.id },
    snapshot: {
      canvasRevision: scene.revision,
      connector: { id: connector.id, revision: connector.revision, contentHash: requestDigest(connector.content) },
      source: { elementId: from.id, type: from.entityType, id: from.entityId },
      target: { elementId: to.id, type: to.entityType, id: to.entityId },
    },
    riskLevel: "R1",
  }, context, pool);
}

export async function prepareStickyConversion(
  raw: { workspaceId: string; projectId: string; canvasId: string; stickyElementId: string; target: StickyConversionTarget; addEntityCard?: boolean },
  context: MutationContext,
  pool: Pool = postgresPool(),
) {
  const scene = await readCanvas({ workspaceId: raw.workspaceId, projectId: raw.projectId, canvasId: raw.canvasId }, context.actorPrincipalId, pool);
  const sticky = scene.elements.find((element) => element.id === raw.stickyElementId && element.kind === "sticky");
  if (!sticky) throw new FoundationServiceError("NOT_FOUND", "Visible Canvas sticky was not found.");
  const stickyText = textFromSticky(sticky);
  const title = raw.target.title?.trim() || stickyText.split("\n", 1)[0]!.slice(0, 200);
  if (!title) throw new FoundationServiceError("VALIDATION_FAILED", "Converted entity title is empty.");
  const normalizedTarget = { ...raw.target, title };
  return insertPreview({
    ...raw,
    actionKind: "convert_sticky",
    sourceElementIds: [sticky.id],
    normalizedInput: { target: normalizedTarget, addEntityCard: raw.addEntityCard ?? true, stickyText },
    snapshot: {
      canvasRevision: scene.revision,
      sticky: { id: sticky.id, revision: sticky.revision, contentHash: requestDigest(sticky.content), geometry: finiteGeometry(sticky) },
    },
    riskLevel: "R1",
  }, context, pool);
}

export async function prepareRegionOrganization(
  raw: {
    workspaceId: string;
    projectId: string;
    canvasId: string;
    elementIds: string[];
    mode: OrganizeMode;
    gap?: number;
    columns?: number;
  },
  context: MutationContext,
  pool: Pool = postgresPool(),
) {
  const elementIds = [...new Set(raw.elementIds)];
  if (!elementIds.length || elementIds.length > 100) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Region organization requires 1 to 100 elements.");
  }
  const scene = await readCanvas({ workspaceId: raw.workspaceId, projectId: raw.projectId, canvasId: raw.canvasId }, context.actorPrincipalId, pool);
  const selected = elementIds.map((id) => scene.elements.find((element) => element.id === id)).filter((value): value is CanvasElement => Boolean(value));
  if (selected.length !== elementIds.length || selected.some((element) => ["connector", "comment", "vote"].includes(element.kind))) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Only visible spatial elements can be organized.");
  }
  const gap = Math.max(0, Math.min(raw.gap ?? 24, 500));
  const columns = Math.max(1, Math.min(raw.columns ?? Math.ceil(Math.sqrt(selected.length)), 20));
  const boxes = selected.map((element) => ({ element, geometry: finiteGeometry(element) }));
  const originX = Math.min(...boxes.map((item) => item.geometry.x));
  const originY = Math.min(...boxes.map((item) => item.geometry.y));
  const maxWidth = Math.max(...boxes.map((item) => item.geometry.width));
  const maxHeight = Math.max(...boxes.map((item) => item.geometry.height));
  const placements = boxes.map((item, index) => {
    const column = raw.mode === "vertical" ? 0 : raw.mode === "horizontal" ? index : index % columns;
    const row = raw.mode === "horizontal" ? 0 : raw.mode === "vertical" ? index : Math.floor(index / columns);
    return {
      elementId: item.element.id,
      expectedElementRevision: item.element.revision,
      geometry: { ...item.geometry, x: originX + column * (maxWidth + gap), y: originY + row * (maxHeight + gap) },
    };
  });
  return insertPreview({
    ...raw,
    actionKind: "organize_region",
    sourceElementIds: elementIds,
    normalizedInput: { mode: raw.mode, gap, columns, placements },
    snapshot: { canvasRevision: scene.revision, elements: boxes.map((item) => ({ id: item.element.id, revision: item.element.revision, geometryHash: requestDigest(item.geometry) })) },
    riskLevel: elementIds.length > 10 ? "R2" : "R1",
  }, context, pool);
}

export async function readCanvasActionPreview(
  input: { workspaceId: string; projectId: string; previewId: string },
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<CanvasActionPreview> {
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, principalId);
    const result = await client.query<PreviewRow>(`SELECT ${columns} FROM canvas_action_previews WHERE workspace_id=$1 AND project_id=$2 AND id=$3`, [input.workspaceId,input.projectId,input.previewId]);
    const row = result.rows[0];
    if (!row) throw new FoundationServiceError("NOT_FOUND", "Canvas action preview was not found.");
    if (row.expires_at <= new Date() && ["pending", "executing"].includes(row.state)) {
      await client.query(`UPDATE canvas_action_previews SET state='expired',revision=revision+1,updated_at=now() WHERE id=$1`, [row.id]);
      row.state = "expired";
      row.revision = String(Number(row.revision) + 1);
      row.updated_at = new Date();
    }
    return mapPreview(row);
  });
}

export async function approveCanvasActionPreview(
  raw: { workspaceId: string; projectId: string; previewId: string; expectedRevision: number },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<CanvasActionPreview>> {
  const operation = "canvas_action_preview.approve";
  const digest = requestDigest(raw);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, raw.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<CanvasActionPreview>(client, { workspaceId: raw.workspaceId, projectId: raw.projectId, principalId: context.actorPrincipalId, operation, key: context.idempotencyKey, digest });
    if (replay) return replay;
    const preview = await client.query<PreviewRow>(`SELECT ${columns} FROM canvas_action_previews WHERE workspace_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE`, [raw.workspaceId,raw.projectId,raw.previewId]);
    const row = preview.rows[0];
    if (!row || row.authorizing_principal_id !== context.actorPrincipalId) throw new FoundationServiceError("NOT_FOUND", "Canvas action preview was not found.");
    if (row.risk_level !== "R2" || !row.confirmation_id || row.state !== "pending" || row.expires_at <= new Date()) {
      throw new FoundationServiceError("CONFLICT", "Canvas action preview is not awaiting an active R2 approval.");
    }
    if (Number(row.revision) !== raw.expectedRevision) throw new FoundationServiceError("REVISION_CONFLICT", "Canvas action preview changed after it was read.", { expectedRevision: raw.expectedRevision, currentRevision: Number(row.revision) });
    const approved = await client.query(`UPDATE action_confirmations SET status='approved',decided_at=now(),revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND authorizing_principal_id=$3 AND action_digest=$4 AND status='pending' AND expires_at>now() RETURNING id`, [raw.workspaceId,row.confirmation_id,context.actorPrincipalId,row.action_digest]);
    if (!approved.rows[0]) throw new FoundationServiceError("CONFLICT", "Canvas action confirmation is no longer approvable.");
    row.revision = String(Number(row.revision) + 1);
    row.updated_at = new Date();
    await client.query(`UPDATE canvas_action_previews SET revision=$2,updated_at=now() WHERE id=$1`, [row.id,row.revision]);
    const data = mapPreview(row);
    return recordMutation(client, {
      workspaceId: raw.workspaceId,
      projectId: raw.projectId,
      context,
      operation,
      digest,
      action: operation,
      targetType: "canvas_action_preview",
      targetId: row.id,
      aggregateType: "canvas_action_preview",
      aggregateRevision: data.revision,
      eventType: "canvas_action_preview.approved.v1",
      inputSummary: { expectedRevision: raw.expectedRevision, riskLevel: row.risk_level },
      resultSummary: { previewId: row.id, confirmationId: row.confirmation_id },
      data,
    });
  });
}
