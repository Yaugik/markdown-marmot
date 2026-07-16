import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { postgresPool } from "@/db/postgres";
import { establishTenantContext } from "@/db/tenant";
import { newFolioId } from "@/lib/folio-ids";
import { authorizeOwnedEcosystemObject, readCanvasPolicy } from "@/services/ecosystem-access";
import { FoundationServiceError } from "@/services/foundation/errors";
import { findIdempotentResult, inTransaction, lockIdempotencyKey, recordMutation, requestDigest } from "@/services/foundation/internal";
import type { MutationContext, MutationResult } from "@/services/foundation/types";
import { createNativePage } from "@/services/pages";
import { createIssue } from "@/services/issues";
import { createTodo } from "@/services/todos";
import { applyCanvasCommand, readCanvas, type CanvasElement } from "@/services/canvas-scenes";
import { createTypedRelationship } from "@/services/typed-relationships";
import { readCanvasActionPreview, type CanvasActionPreview } from "@/services/canvas-action-previews";

const previewColumns = `id,workspace_id,project_id,canvas_id,action_kind,source_element_ids,
  normalized_input,snapshot,action_digest,risk_level,state,confirmation_id,result,
  created_by_principal_id,authorizing_principal_id,expires_at,revision,created_at,
  updated_at,completed_at,last_error_code,last_error_message`;

type PreviewRow = {
  id: string; workspace_id: string; project_id: string; canvas_id: string;
  action_kind: CanvasActionPreview["actionKind"]; source_element_ids: string[];
  normalized_input: Record<string, unknown>; snapshot: Record<string, unknown>;
  action_digest: string; risk_level: CanvasActionPreview["riskLevel"];
  state: CanvasActionPreview["state"]; confirmation_id: string | null;
  result: Record<string, unknown> | null; created_by_principal_id: string;
  authorizing_principal_id: string; expires_at: Date; revision: string;
  created_at: Date; updated_at: Date; completed_at: Date | null;
  last_error_code: string | null; last_error_message: string | null;
};

type ElementRow = {
  id: string; element_kind: string; entity_type: string | null; entity_id: string | null;
  geometry: Record<string, unknown>; content: Record<string, unknown>; z_index: string;
  revision: string; created_by_principal_id: string; updated_by_principal_id: string;
};

type CanvasRow = {
  id: string; title: string; scene_version: number; current_revision_id: string;
  revision: string; owner_principal_id: string; visibility: "private" | "project";
};

function mutationContext(context: MutationContext, key: string, confirmationId?: string | null): MutationContext {
  return { ...context, idempotencyKey: key, confirmationId: confirmationId ?? context.confirmationId };
}

function document(text: string) {
  return { type: "doc", content: text ? [{ type: "paragraph", content: [{ type: "text", text }] }] : [] };
}

function previewData(row: PreviewRow): CanvasActionPreview {
  return {
    id: row.id, workspaceId: row.workspace_id, projectId: row.project_id, canvasId: row.canvas_id,
    actionKind: row.action_kind, sourceElementIds: row.source_element_ids,
    normalizedInput: row.normalized_input, snapshot: row.snapshot, actionDigest: row.action_digest,
    riskLevel: row.risk_level, state: row.state, confirmationId: row.confirmation_id,
    result: row.result, createdByPrincipalId: row.created_by_principal_id,
    authorizingPrincipalId: row.authorizing_principal_id, expiresAt: row.expires_at.toISOString(),
    revision: Number(row.revision), createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(), completedAt: row.completed_at?.toISOString() ?? null,
    lastErrorCode: row.last_error_code, lastErrorMessage: row.last_error_message,
  };
}

async function authorizeCanvasEdit(client: PoolClient, row: PreviewRow, principalId: string) {
  const policy = await readCanvasPolicy(client, { workspaceId: row.workspace_id, projectId: row.project_id, canvasId: row.canvas_id });
  await authorizeOwnedEcosystemObject(client, {
    workspaceId: row.workspace_id, projectId: row.project_id, principalId,
    capability: "canvas.edit", objectType: "canvas", objectId: row.canvas_id,
    ownerPrincipalId: policy.ownerPrincipalId, visibility: policy.visibility,
  });
}

async function executionReplay(
  input: { workspaceId: string; projectId: string; previewId: string },
  context: MutationContext,
  pool: Pool,
) {
  const operation = "canvas_action.execute";
  const digest = requestDigest(input);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, context.actorPrincipalId);
    return findIdempotentResult<CanvasActionPreview>(client, {
      workspaceId: input.workspaceId, projectId: input.projectId,
      principalId: context.actorPrincipalId, operation, key: context.idempotencyKey, digest,
    });
  });
}

async function claimPreview(
  input: { workspaceId: string; projectId: string; previewId: string },
  context: MutationContext,
  pool: Pool,
): Promise<PreviewRow> {
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, context.actorPrincipalId);
    const result = await client.query<PreviewRow>(`SELECT ${previewColumns} FROM canvas_action_previews WHERE workspace_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE`, [input.workspaceId,input.projectId,input.previewId]);
    const row = result.rows[0];
    if (!row || row.created_by_principal_id !== context.actorPrincipalId) throw new FoundationServiceError("NOT_FOUND", "Canvas action preview was not found.");
    if (row.state === "succeeded") return row;
    if (row.expires_at <= new Date()) {
      await client.query(`UPDATE canvas_action_previews SET state='expired',revision=revision+1,updated_at=now() WHERE id=$1`, [row.id]);
      throw new FoundationServiceError("CONFLICT", "Canvas action preview expired.");
    }
    if (!["pending", "executing", "failed"].includes(row.state)) throw new FoundationServiceError("CONFLICT", "Canvas action preview is not executable.");
    await authorizeCanvasEdit(client, row, context.actorPrincipalId);
    if (row.risk_level === "R2") {
      const confirmation = await client.query(`SELECT 1 FROM action_confirmations WHERE workspace_id=$1 AND id=$2 AND operation=$3 AND action_digest=$4 AND risk_level='R2' AND status='approved' AND authorizing_principal_id=$5 AND expires_at>now()`, [row.workspace_id,row.confirmation_id,`canvas.${row.action_kind}`,row.action_digest,row.authorizing_principal_id]);
      if (!confirmation.rows[0]) throw new FoundationServiceError("CONFIRMATION_REQUIRED", "An active approval is required for this broad Canvas action.");
    }
    const updated = await client.query<PreviewRow>(`UPDATE canvas_action_previews SET state='executing',revision=revision+1,updated_at=now(),last_error_code=NULL,last_error_message=NULL WHERE id=$1 RETURNING ${previewColumns}`, [row.id]);
    return updated.rows[0]!;
  });
}

async function savePartialResult(row: PreviewRow, result: Record<string, unknown>, context: MutationContext, pool: Pool) {
  await inTransaction(pool, async (client) => {
    await establishTenantContext(client, row.workspace_id, context.actorPrincipalId);
    await client.query(`UPDATE canvas_action_previews SET result=$2,revision=revision+1,updated_at=now() WHERE id=$1 AND state='executing'`, [row.id,result]);
  });
  row.result = result;
}

async function finishPreview(row: PreviewRow, result: Record<string, unknown>, context: MutationContext, pool: Pool): Promise<MutationResult<CanvasActionPreview>> {
  const operation = "canvas_action.execute";
  const input = { workspaceId: row.workspace_id, projectId: row.project_id, previewId: row.id };
  const digest = requestDigest(input);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, row.workspace_id, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<CanvasActionPreview>(client, {
      workspaceId: row.workspace_id, projectId: row.project_id, principalId: context.actorPrincipalId,
      operation, key: context.idempotencyKey, digest,
    });
    if (replay) return replay;
    const updated = await client.query<PreviewRow>(`UPDATE canvas_action_previews SET state='succeeded',result=$2,revision=revision+1,updated_at=now(),completed_at=now(),last_error_code=NULL,last_error_message=NULL WHERE id=$1 AND state IN ('executing','succeeded') RETURNING ${previewColumns}`, [row.id,result]);
    const current = updated.rows[0];
    if (!current) throw new FoundationServiceError("CONFLICT", "Canvas action preview lost its execution state.");
    const data = previewData(current);
    return recordMutation(client, {
      workspaceId: row.workspace_id,
      projectId: row.project_id,
      context: mutationContext(context, context.idempotencyKey, row.confirmation_id),
      operation,
      digest,
      action: `canvas_action.${row.action_kind}.executed`,
      targetType: "canvas_action_preview",
      targetId: row.id,
      aggregateType: "canvas_action_preview",
      aggregateRevision: data.revision,
      eventType: `canvas_action.${row.action_kind}.executed.v1`,
      inputSummary: { canvasId: row.canvas_id, sourceCount: row.source_element_ids.length, riskLevel: row.risk_level },
      resultSummary: { previewId: row.id, canvasId: row.canvas_id, result },
      data,
    });
  });
}

async function failPreview(row: PreviewRow, error: unknown, context: MutationContext, pool: Pool) {
  await inTransaction(pool, async (client) => {
    await establishTenantContext(client, row.workspace_id, context.actorPrincipalId);
    await client.query(`UPDATE canvas_action_previews SET state='failed',revision=revision+1,updated_at=now(),last_error_code=$2,last_error_message=$3 WHERE id=$1 AND state='executing'`, [row.id,error instanceof FoundationServiceError ? error.code : "CANVAS_ACTION_FAILED",error instanceof Error ? error.message.slice(0,500) : "Canvas action failed."]);
  });
}

function snapshotRef(row: PreviewRow, side: "source" | "target") {
  const value = row.snapshot[side];
  if (!value || typeof value !== "object") throw new FoundationServiceError("CONFLICT", "Canvas action preview endpoint snapshot is invalid.");
  const record = value as Record<string, unknown>;
  if (typeof record.type !== "string" || typeof record.id !== "string") throw new FoundationServiceError("CONFLICT", "Canvas action preview endpoint snapshot is invalid.");
  return { type: record.type as "page" | "issue" | "todo" | "calendar_entry" | "canvas", id: record.id };
}

async function findExistingRelationship(row: PreviewRow, relationshipTypeId: string, source: ReturnType<typeof snapshotRef>, target: ReturnType<typeof snapshotRef>, context: MutationContext, pool: Pool) {
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, row.workspace_id, context.actorPrincipalId);
    const result = await client.query<{ id: string }>(`SELECT id FROM entity_relationships WHERE workspace_id=$1 AND project_id=$2 AND relationship_type_id=$3 AND provenance='explicit' AND state='accepted' AND archived_at IS NULL AND ((source_entity_type=$4 AND source_entity_id=$5 AND target_entity_type=$6 AND target_entity_id=$7) OR (source_entity_type=$6 AND source_entity_id=$7 AND target_entity_type=$4 AND target_entity_id=$5)) ORDER BY created_at LIMIT 1`, [row.workspace_id,row.project_id,relationshipTypeId,source.type,source.id,target.type,target.id]);
    return result.rows[0]?.id ?? null;
  });
}

async function executeConnectorPromotion(row: PreviewRow, context: MutationContext, pool: Pool) {
  const relationshipTypeId = typeof row.normalized_input.relationshipTypeId === "string" ? row.normalized_input.relationshipTypeId : null;
  const connector = row.snapshot.connector as Record<string, unknown> | undefined;
  if (!relationshipTypeId || !connector || typeof connector.id !== "string") throw new FoundationServiceError("CONFLICT", "Connector promotion preview is invalid.");
  const source = snapshotRef(row, "source");
  const target = snapshotRef(row, "target");
  let relationshipId = typeof row.result?.relationshipId === "string" ? row.result.relationshipId : null;
  relationshipId ??= await findExistingRelationship(row, relationshipTypeId, source, target, context, pool);
  if (!relationshipId) {
    const created = await createTypedRelationship({
      workspaceId: row.workspace_id,
      projectId: row.project_id,
      relationshipTypeId,
      source,
      target,
      provenance: "explicit",
      metadata: { canvasActionPreviewId: row.id, connectorElementId: connector.id },
    }, mutationContext(context, `${context.idempotencyKey}:relationship`, row.confirmation_id), pool);
    relationshipId = created.data.id;
  }
  await savePartialResult(row, { ...(row.result ?? {}), relationshipId }, context, pool);

  const scene = await readCanvas({ workspaceId: row.workspace_id, projectId: row.project_id, canvasId: row.canvas_id }, context.actorPrincipalId, pool);
  const current = scene.elements.find((element) => element.id === connector.id && element.kind === "connector");
  if (!current) throw new FoundationServiceError("CONFLICT", "Connector is no longer visible and active.");
  if (current.content.promotedRelationshipId !== relationshipId) {
    await applyCanvasCommand({
      workspaceId: row.workspace_id,
      projectId: row.project_id,
      canvasId: row.canvas_id,
      expectedRevision: scene.revision,
      clientId: `canvas-action:${row.id}`,
      clientSequence: 1,
      command: {
        type: "element.update",
        elementId: current.id,
        expectedElementRevision: current.revision,
        content: { ...current.content, promotedRelationshipId: relationshipId, promotionPreviewId: row.id },
      },
    }, mutationContext(context, `${context.idempotencyKey}:canvas-link`, row.confirmation_id), pool);
  }
  return { relationshipId, connectorElementId: current.id };
}

async function createConvertedEntity(row: PreviewRow, context: MutationContext, pool: Pool) {
  const target = row.normalized_input.target;
  const stickyText = typeof row.normalized_input.stickyText === "string" ? row.normalized_input.stickyText : "";
  if (!target || typeof target !== "object") throw new FoundationServiceError("CONFLICT", "Sticky conversion target is invalid.");
  const value = target as Record<string, unknown>;
  const entityType = value.entityType;
  const title = typeof value.title === "string" ? value.title : stickyText.slice(0,200);
  if (entityType === "page") {
    const created = await createNativePage({
      workspaceId: row.workspace_id, projectId: row.project_id, title, content: document(stickyText),
      parentNodeId: typeof value.parentNodeId === "string" ? value.parentNodeId : null,
    }, mutationContext(context, `${context.idempotencyKey}:entity`, row.confirmation_id), pool);
    return { entityType: "page" as const, entityId: created.data.id };
  }
  if (entityType === "issue") {
    const priority = typeof value.priority === "string" ? value.priority as "no_priority" | "urgent" | "high" | "medium" | "low" : "no_priority";
    const created = await createIssue({ workspaceId: row.workspace_id, projectId: row.project_id, title, description: document(stickyText), priority }, mutationContext(context, `${context.idempotencyKey}:entity`, row.confirmation_id), pool);
    return { entityType: "issue" as const, entityId: created.data.id };
  }
  if (entityType === "todo" && typeof value.listId === "string") {
    const created = await createTodo({
      workspaceId: row.workspace_id, projectId: row.project_id, listId: value.listId,
      title, body: document(stickyText),
      startsAt: typeof value.startsAt === "string" ? value.startsAt : null,
      dueAt: typeof value.dueAt === "string" ? value.dueAt : null,
      timeZone: typeof value.timeZone === "string" ? value.timeZone : undefined,
    }, mutationContext(context, `${context.idempotencyKey}:entity`, row.confirmation_id), pool);
    return { entityType: "todo" as const, entityId: created.data.id };
  }
  throw new FoundationServiceError("CONFLICT", "Sticky conversion target is invalid.");
}

function geometryOf(element: CanvasElement) {
  const number = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return { x: number(element.geometry.x,0), y: number(element.geometry.y,0), width: Math.max(1,number(element.geometry.width,220)), height: Math.max(1,number(element.geometry.height,140)) };
}

async function executeStickyConversion(row: PreviewRow, context: MutationContext, pool: Pool) {
  const stickySnapshot = row.snapshot.sticky as Record<string, unknown> | undefined;
  if (!stickySnapshot || typeof stickySnapshot.id !== "string") throw new FoundationServiceError("CONFLICT", "Sticky conversion preview is invalid.");
  let entityType = typeof row.result?.entityType === "string" ? row.result.entityType as "page" | "issue" | "todo" : null;
  let entityId = typeof row.result?.entityId === "string" ? row.result.entityId : null;
  if (!entityType || !entityId) {
    const created = await createConvertedEntity(row, context, pool);
    entityType = created.entityType;
    entityId = created.entityId;
    await savePartialResult(row, { ...(row.result ?? {}), entityType, entityId }, context, pool);
  }

  let scene = await readCanvas({ workspaceId: row.workspace_id, projectId: row.project_id, canvasId: row.canvas_id }, context.actorPrincipalId, pool);
  let sticky = scene.elements.find((element) => element.id === stickySnapshot.id && element.kind === "sticky");
  if (!sticky) throw new FoundationServiceError("CONFLICT", "Sticky is no longer visible and active.");
  if (sticky.content.linkedEntityId !== entityId || sticky.content.linkedEntityType !== entityType) {
    await applyCanvasCommand({
      workspaceId: row.workspace_id, projectId: row.project_id, canvasId: row.canvas_id,
      expectedRevision: scene.revision, clientId: `canvas-action:${row.id}`, clientSequence: 1,
      command: { type: "element.update", elementId: sticky.id, expectedElementRevision: sticky.revision,
        content: { ...sticky.content, linkedEntityType: entityType, linkedEntityId: entityId, conversionPreviewId: row.id } },
    }, mutationContext(context, `${context.idempotencyKey}:sticky-link`, row.confirmation_id), pool);
  }

  const addEntityCard = row.normalized_input.addEntityCard !== false;
  if (addEntityCard) {
    scene = await readCanvas({ workspaceId: row.workspace_id, projectId: row.project_id, canvasId: row.canvas_id }, context.actorPrincipalId, pool);
    sticky = scene.elements.find((element) => element.id === stickySnapshot.id && element.kind === "sticky") ?? sticky;
    const existing = scene.elements.find((element) => element.kind === "entity_card" && element.entityType === entityType && element.entityId === entityId && element.content.sourceStickyId === sticky!.id);
    if (!existing) {
      const geometry = geometryOf(sticky!);
      await applyCanvasCommand({
        workspaceId: row.workspace_id, projectId: row.project_id, canvasId: row.canvas_id,
        expectedRevision: scene.revision, clientId: `canvas-action:${row.id}`, clientSequence: 2,
        command: { type: "element.create", element: {
          kind: "entity_card", entityType, entityId,
          geometry: { x: geometry.x + geometry.width + 32, y: geometry.y, width: 260, height: 160 },
          content: { sourceStickyId: sticky!.id, conversionPreviewId: row.id },
          zIndex: sticky!.zIndex + 1,
        } },
      }, mutationContext(context, `${context.idempotencyKey}:entity-card`, row.confirmation_id), pool);
    }
  }
  return { entityType, entityId, stickyElementId: sticky.id, entityCardAdded: addEntityCard };
}

function sameGeometry(current: Record<string, unknown>, target: Record<string, unknown>) {
  return requestDigest(current) === requestDigest(target);
}

async function executeOrganization(row: PreviewRow, context: MutationContext, pool: Pool): Promise<MutationResult<CanvasActionPreview>> {
  const placements = Array.isArray(row.normalized_input.placements) ? row.normalized_input.placements as Array<Record<string, unknown>> : [];
  if (!placements.length || placements.length > 100) throw new FoundationServiceError("CONFLICT", "Organization preview placements are invalid.");
  const operation = "canvas_action.execute";
  const digest = requestDigest({ workspaceId: row.workspace_id, projectId: row.project_id, previewId: row.id });
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, row.workspace_id, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<CanvasActionPreview>(client, { workspaceId: row.workspace_id, projectId: row.project_id, principalId: context.actorPrincipalId, operation, key: context.idempotencyKey, digest });
    if (replay) return replay;
    const locked = await client.query<PreviewRow>(`SELECT ${previewColumns} FROM canvas_action_previews WHERE id=$1 FOR UPDATE`, [row.id]);
    const currentPreview = locked.rows[0];
    if (!currentPreview || currentPreview.state !== "executing") throw new FoundationServiceError("CONFLICT", "Organization preview is not executing.");
    await authorizeCanvasEdit(client, currentPreview, context.actorPrincipalId);

    if (currentPreview.risk_level === "R2") {
      const consumed = await client.query(`UPDATE action_confirmations SET status='consumed',consumed_at=now(),revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND operation=$3 AND action_digest=$4 AND status='approved' AND authorizing_principal_id=$5 AND expires_at>now() RETURNING id`, [row.workspace_id,row.confirmation_id,`canvas.${row.action_kind}`,row.action_digest,row.authorizing_principal_id]);
      if (!consumed.rows[0]) throw new FoundationServiceError("CONFIRMATION_REQUIRED", "Organization confirmation is unavailable or was already consumed.");
    }

    const canvasResult = await client.query<CanvasRow>(`SELECT id,title,scene_version,current_revision_id,revision,owner_principal_id,visibility FROM canvases WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND archived_at IS NULL FOR UPDATE`, [row.workspace_id,row.project_id,row.canvas_id]);
    const canvas = canvasResult.rows[0];
    if (!canvas) throw new FoundationServiceError("NOT_FOUND", "Canvas was not found.");
    const baseRevision = Number(canvas.revision);
    for (const placement of placements) {
      if (typeof placement.elementId !== "string" || typeof placement.expectedElementRevision !== "number" || !placement.geometry || typeof placement.geometry !== "object") throw new FoundationServiceError("CONFLICT", "Organization placement is invalid.");
      const element = await client.query<ElementRow>(`SELECT id,element_kind,entity_type,entity_id,geometry,content,z_index,revision,created_by_principal_id,updated_by_principal_id FROM canvas_elements WHERE workspace_id=$1 AND project_id=$2 AND canvas_id=$3 AND id=$4 AND archived_at IS NULL FOR UPDATE`, [row.workspace_id,row.project_id,row.canvas_id,placement.elementId]);
      const current = element.rows[0];
      if (!current) throw new FoundationServiceError("CONFLICT", "An organization target is no longer active.");
      if (!sameGeometry(current.geometry, placement.geometry as Record<string, unknown>) && Number(current.revision) !== placement.expectedElementRevision) {
        throw new FoundationServiceError("REVISION_CONFLICT", "A Canvas element changed after organization was previewed.", { expectedRevision: placement.expectedElementRevision, currentRevision: Number(current.revision), elementId: current.id });
      }
      if (!sameGeometry(current.geometry, placement.geometry as Record<string, unknown>)) {
        await client.query(`UPDATE canvas_elements SET geometry=$5,revision=revision+1,updated_by_principal_id=$6,updated_at=now() WHERE workspace_id=$1 AND project_id=$2 AND canvas_id=$3 AND id=$4`, [row.workspace_id,row.project_id,row.canvas_id,current.id,placement.geometry,context.actorPrincipalId]);
      }
    }
    const nextRevision = baseRevision + 1;
    const elements = await client.query<ElementRow>(`SELECT id,element_kind,entity_type,entity_id,geometry,content,z_index,revision,created_by_principal_id,updated_by_principal_id FROM canvas_elements WHERE workspace_id=$1 AND project_id=$2 AND canvas_id=$3 AND archived_at IS NULL ORDER BY z_index,id`, [row.workspace_id,row.project_id,row.canvas_id]);
    const scene = { sceneVersion: canvas.scene_version, canvasId: canvas.id, title: canvas.title, elements: elements.rows.map((element) => ({ id: element.id, kind: element.element_kind, entityType: element.entity_type, entityId: element.entity_id, geometry: element.geometry, content: element.content, zIndex: Number(element.z_index), revision: Number(element.revision) })) };
    const revisionId = newFolioId();
    const sceneHash = createHash("sha256").update(JSON.stringify(scene)).digest("hex");
    await client.query(`INSERT INTO canvas_revisions(id,workspace_id,project_id,canvas_id,sequence,scene_version,scene,scene_hash,author_principal_id,parent_revision_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [revisionId,row.workspace_id,row.project_id,row.canvas_id,nextRevision,canvas.scene_version,scene,sceneHash,context.actorPrincipalId,canvas.current_revision_id]);
    await client.query(`UPDATE canvases SET revision=$4,current_revision_id=$5,updated_by_principal_id=$6,updated_at=now() WHERE workspace_id=$1 AND project_id=$2 AND id=$3`, [row.workspace_id,row.project_id,row.canvas_id,nextRevision,revisionId,context.actorPrincipalId]);
    await client.query(`INSERT INTO canvas_commands(id,workspace_id,project_id,canvas_id,client_id,client_sequence,base_revision,applied_revision,command_type,command,actor_principal_id) VALUES($1,$2,$3,$4,$5,1,$6,$7,'region.organize',$8,$9)`, [newFolioId(),row.workspace_id,row.project_id,row.canvas_id,`canvas-action:${row.id}`,baseRevision,nextRevision,{ previewId: row.id, placements },context.actorPrincipalId]);
    const result = { canvasId: row.canvas_id, canvasRevision: nextRevision, revisionId, organizedElementIds: placements.map((placement) => placement.elementId) };
    const updated = await client.query<PreviewRow>(`UPDATE canvas_action_previews SET state='succeeded',result=$2,revision=revision+1,updated_at=now(),completed_at=now() WHERE id=$1 RETURNING ${previewColumns}`, [row.id,result]);
    const data = previewData(updated.rows[0]!);
    return recordMutation(client, {
      workspaceId: row.workspace_id, projectId: row.project_id,
      context: mutationContext(context, context.idempotencyKey, row.confirmation_id), operation, digest,
      action: "canvas_action.organize_region.executed", targetType: "canvas_action_preview", targetId: row.id,
      aggregateType: "canvas", aggregateRevision: nextRevision, eventType: "canvas.region_organized.v1",
      inputSummary: { previewId: row.id, elementCount: placements.length, riskLevel: row.risk_level },
      resultSummary: result, data,
    });
  });
}

export async function executeCanvasActionPreview(
  input: { workspaceId: string; projectId: string; previewId: string },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<CanvasActionPreview>> {
  const replay = await executionReplay(input, context, pool);
  if (replay) return replay;
  const row = await claimPreview(input, context, pool);
  if (row.state === "succeeded") {
    return finishPreview(row, row.result ?? {}, context, pool);
  }
  try {
    if (row.action_kind === "organize_region") return executeOrganization(row, context, pool);
    const result = row.action_kind === "promote_connector"
      ? await executeConnectorPromotion(row, context, pool)
      : row.action_kind === "convert_sticky"
        ? await executeStickyConversion(row, context, pool)
        : (() => { throw new FoundationServiceError("CONFLICT", "Canvas action requires a dedicated execution workflow."); })();
    return finishPreview(row, result, context, pool);
  } catch (error) {
    await failPreview(row, error, context, pool);
    throw error;
  }
}

export async function readExecutedCanvasAction(
  input: { workspaceId: string; projectId: string; previewId: string },
  principalId: string,
  pool: Pool = postgresPool(),
) {
  return readCanvasActionPreview(input, principalId, pool);
}
