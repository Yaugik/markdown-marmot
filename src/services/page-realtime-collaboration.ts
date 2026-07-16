import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { postgresPool } from "@/db/postgres";
import { establishTenantContext } from "@/db/tenant";
import { newFolioId } from "@/lib/folio-ids";
import { authorizePageCapability } from "@/services/page-access";
import { editNativePage, type NativePage, type ProseMirrorNode } from "@/services/pages";
import { FoundationServiceError } from "@/services/foundation/errors";
import {
  findIdempotentResult,
  inTransaction,
  lockIdempotencyKey,
  recordMutation,
  requestDigest,
} from "@/services/foundation/internal";
import type { MutationContext, MutationResult } from "@/services/foundation/types";

export type PageCollaborationRoom = {
  id: string;
  pageId: string;
  state: "active" | "closing" | "closed";
  baseRevisionId: string;
  currentSequence: number;
  revision: number;
  createdByPrincipalId: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
};

export type PageCollaborationOperation = {
  id: string;
  roomId: string;
  clientId: string;
  clientSequence: number;
  baseSequence: number;
  serverSequence: number;
  operation: { kind: "replace_document"; content: ProseMirrorNode };
  operationHash: string;
  authorPrincipalId: string;
  createdAt: string;
};

export type PageCollaborationSnapshot = {
  room: PageCollaborationRoom;
  content: ProseMirrorNode;
  plainText: string;
  contentHash: string;
  operations: PageCollaborationOperation[];
};

type RoomRow = {
  id: string; page_id: string; state: PageCollaborationRoom["state"];
  base_revision_id: string; current_sequence: string; revision: string;
  created_by_principal_id: string; created_at: Date; updated_at: Date; closed_at: Date | null;
};
type OperationRow = {
  id: string; room_id: string; client_id: string; client_sequence: string;
  base_sequence: string; server_sequence: string; operation: PageCollaborationOperation["operation"];
  operation_hash: string; author_principal_id: string; created_at: Date;
};
type CheckpointRow = { content: ProseMirrorNode; plain_text: string; content_hash: string; server_sequence: string };

function mapRoom(row: RoomRow): PageCollaborationRoom {
  return {
    id: row.id,
    pageId: row.page_id,
    state: row.state,
    baseRevisionId: row.base_revision_id,
    currentSequence: Number(row.current_sequence),
    revision: Number(row.revision),
    createdByPrincipalId: row.created_by_principal_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    closedAt: row.closed_at?.toISOString() ?? null,
  };
}

function mapOperation(row: OperationRow): PageCollaborationOperation {
  return {
    id: row.id,
    roomId: row.room_id,
    clientId: row.client_id,
    clientSequence: Number(row.client_sequence),
    baseSequence: Number(row.base_sequence),
    serverSequence: Number(row.server_sequence),
    operation: row.operation,
    operationHash: row.operation_hash,
    authorPrincipalId: row.author_principal_id,
    createdAt: row.created_at.toISOString(),
  };
}

function normalizeDocument(value: unknown): ProseMirrorNode {
  const json = JSON.stringify(value);
  if (!json || Buffer.byteLength(json) > 1024 * 1024) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Collaboration content must be at most 1 MiB.");
  }
  let count = 0;
  const visit = (candidate: unknown, depth: number): ProseMirrorNode => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) || depth > 100 || ++count > 10_000) {
      throw new FoundationServiceError("VALIDATION_FAILED", "Collaboration content is not a valid document.");
    }
    const node = candidate as Record<string, unknown>;
    if (typeof node.type !== "string" || !node.type || node.type.length > 100) {
      throw new FoundationServiceError("VALIDATION_FAILED", "Collaboration document nodes require a valid type.");
    }
    if (node.text !== undefined && typeof node.text !== "string") {
      throw new FoundationServiceError("VALIDATION_FAILED", "Collaboration text values must be strings.");
    }
    if (node.content !== undefined && !Array.isArray(node.content)) {
      throw new FoundationServiceError("VALIDATION_FAILED", "Collaboration node content must be an array.");
    }
    return {
      ...node,
      type: node.type,
      ...(Array.isArray(node.content) ? { content: node.content.map((child) => visit(child,depth + 1)) } : {}),
    } as ProseMirrorNode;
  };
  const result = visit(value,0);
  if (result.type !== "doc") throw new FoundationServiceError("VALIDATION_FAILED", "Collaboration content requires a doc root.");
  return result;
}

function documentPlainText(document: ProseMirrorNode): string {
  const parts: string[] = [];
  const visit = (node: ProseMirrorNode) => {
    if (node.text) parts.push(node.text);
    node.content?.forEach(visit);
    if (["paragraph","heading","blockquote","code_block","list_item"].includes(node.type)) parts.push("\n");
  };
  visit(document);
  return parts.join("").replace(/\n{3,}/g,"\n\n").trim();
}
const hashDocument = (document: ProseMirrorNode) => createHash("sha256").update(JSON.stringify(document)).digest("hex");

async function roomRow(client: PoolClient, input: { workspaceId: string; projectId: string; roomId: string }, lock = false) {
  const result = await client.query<RoomRow>(`
    SELECT id,page_id,state,base_revision_id,current_sequence,revision,
      created_by_principal_id,created_at,updated_at,closed_at
    FROM page_collaboration_rooms
    WHERE workspace_id=$1 AND project_id=$2 AND id=$3
    ${lock ? "FOR UPDATE" : ""}
  `, [input.workspaceId,input.projectId,input.roomId]);
  const row = result.rows[0];
  if (!row) throw new FoundationServiceError("NOT_FOUND", "Collaboration room was not found.");
  return row;
}

export async function openPageCollaborationRoom(
  input: { workspaceId: string; projectId: string; pageId: string },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<PageCollaborationSnapshot>> {
  const operation = "page_collaboration.open";
  const digest = requestDigest(input);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client,input.workspaceId,context.actorPrincipalId);
    await lockIdempotencyKey(client,context.actorPrincipalId,operation,context.idempotencyKey);
    const replay = await findIdempotentResult<PageCollaborationSnapshot>(client,{
      workspaceId: input.workspaceId,projectId: input.projectId,principalId: context.actorPrincipalId,
      operation,key: context.idempotencyKey,digest,
    });
    if (replay) return replay;
    await authorizePageCapability(client,{ ...input, principalId: context.actorPrincipalId, capability: "page.collaborate" });
    const page = await client.query<{
      page_revision: string; current_revision_id: string; content: ProseMirrorNode; plain_text: string;
      content_hash: string; status: string;
    }>(`
      SELECT p.revision page_revision,p.status,np.current_revision_id,r.content,r.plain_text,r.content_hash
      FROM pages p JOIN native_pages np ON np.workspace_id=p.workspace_id AND np.project_id=p.project_id AND np.page_id=p.id
      JOIN native_page_revisions r ON r.workspace_id=np.workspace_id AND r.project_id=np.project_id AND r.id=np.current_revision_id
      WHERE p.workspace_id=$1 AND p.project_id=$2 AND p.id=$3 FOR UPDATE OF p,np
    `, [input.workspaceId,input.projectId,input.pageId]);
    const current = page.rows[0];
    if (!current) throw new FoundationServiceError("NOT_FOUND", "Native page was not found.");
    if (current.status !== "active") throw new FoundationServiceError("CONFLICT", "Only active native pages can be collaborated on.");
    const existing = await client.query<RoomRow>(`
      SELECT id,page_id,state,base_revision_id,current_sequence,revision,
        created_by_principal_id,created_at,updated_at,closed_at
      FROM page_collaboration_rooms
      WHERE workspace_id=$1 AND project_id=$2 AND page_id=$3 AND state IN ('active','closing')
    `, [input.workspaceId,input.projectId,input.pageId]);
    let row = existing.rows[0];
    if (!row) {
      const id = newFolioId();
      const inserted = await client.query<RoomRow>(`
        INSERT INTO page_collaboration_rooms(
          id,workspace_id,project_id,page_id,base_revision_id,created_by_principal_id
        ) VALUES($1,$2,$3,$4,$5,$6)
        RETURNING id,page_id,state,base_revision_id,current_sequence,revision,
          created_by_principal_id,created_at,updated_at,closed_at
      `, [id,input.workspaceId,input.projectId,input.pageId,current.current_revision_id,context.actorPrincipalId]);
      row = inserted.rows[0]!;
      await client.query(`
        INSERT INTO page_collaboration_checkpoints(
          id,workspace_id,project_id,room_id,server_sequence,content,plain_text,content_hash,created_by_principal_id
        ) VALUES($1,$2,$3,$4,0,$5,$6,$7,$8)
      `, [newFolioId(),input.workspaceId,input.projectId,id,current.content,current.plain_text,current.content_hash,context.actorPrincipalId]);
    }
    const data: PageCollaborationSnapshot = {
      room: mapRoom(row),content: current.content,plainText: current.plain_text,
      contentHash: current.content_hash,operations: [],
    };
    return recordMutation(client,{
      workspaceId: input.workspaceId,projectId: input.projectId,context,operation,digest,
      action: operation,targetType: "page_collaboration_room",targetId: row.id,
      aggregateType: "page_collaboration_room",aggregateRevision: Number(row.revision),
      eventType: "page_collaboration.opened.v1",inputSummary:{pageId:input.pageId},
      resultSummary:{roomId:row.id,pageId:input.pageId,currentSequence:Number(row.current_sequence)},data,
    });
  });
}

export async function readPageCollaborationRoom(
  input: { workspaceId: string; projectId: string; roomId: string; afterSequence?: number; limit?: number },
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<PageCollaborationSnapshot> {
  return inTransaction(pool,async(client)=>{
    await establishTenantContext(client,input.workspaceId,principalId);
    const row = await roomRow(client,input);
    await authorizePageCapability(client,{
      workspaceId:input.workspaceId,projectId:input.projectId,principalId,capability:"page.read",pageId:row.page_id,
    });
    const checkpoint = await client.query<CheckpointRow>(`
      SELECT content,plain_text,content_hash,server_sequence
      FROM page_collaboration_checkpoints WHERE room_id=$1
      ORDER BY server_sequence DESC LIMIT 1
    `,[input.roomId]);
    const cp = checkpoint.rows[0];
    if (!cp) throw new FoundationServiceError("CONFLICT", "Collaboration room has no checkpoint.");
    const limit = Math.max(1,Math.min(input.limit ?? 200,500));
    const operations = await client.query<OperationRow>(`
      SELECT id,room_id,client_id,client_sequence,base_sequence,server_sequence,operation,
        operation_hash,author_principal_id,created_at
      FROM page_collaboration_operations
      WHERE room_id=$1 AND server_sequence>$2 ORDER BY server_sequence LIMIT $3
    `,[input.roomId,Math.max(0,input.afterSequence ?? 0),limit]);
    return { room:mapRoom(row),content:cp.content,plainText:cp.plain_text,contentHash:cp.content_hash,operations:operations.rows.map(mapOperation) };
  });
}

export async function submitPageCollaborationOperation(
  raw: {
    workspaceId: string; projectId: string; roomId: string; clientId: string;
    clientSequence: number; baseSequence: number; content: unknown;
  },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<PageCollaborationOperation>> {
  const clientId = raw.clientId.trim();
  if (!clientId || clientId.length > 180 || !Number.isSafeInteger(raw.clientSequence) || raw.clientSequence < 1
    || !Number.isSafeInteger(raw.baseSequence) || raw.baseSequence < 0) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Collaboration client sequence is invalid.");
  }
  const content = normalizeDocument(raw.content);
  const operationValue = { kind:"replace_document" as const,content };
  const input = { ...raw,clientId,content };
  const operation = "page_collaboration.operation.submit";
  const digest = requestDigest(input);
  return inTransaction(pool,async(client)=>{
    await establishTenantContext(client,input.workspaceId,context.actorPrincipalId);
    await lockIdempotencyKey(client,context.actorPrincipalId,operation,context.idempotencyKey);
    const replay = await findIdempotentResult<PageCollaborationOperation>(client,{
      workspaceId:input.workspaceId,projectId:input.projectId,principalId:context.actorPrincipalId,
      operation,key:context.idempotencyKey,digest,
    });
    if (replay) return replay;
    const row = await roomRow(client,input,true);
    await authorizePageCapability(client,{
      workspaceId:input.workspaceId,projectId:input.projectId,principalId:context.actorPrincipalId,
      capability:"page.collaborate",pageId:row.page_id,
    });
    if (row.state !== "active") throw new FoundationServiceError("CONFLICT", "Collaboration room is not accepting operations.");
    const duplicate = await client.query<OperationRow>(`
      SELECT id,room_id,client_id,client_sequence,base_sequence,server_sequence,operation,
        operation_hash,author_principal_id,created_at
      FROM page_collaboration_operations WHERE room_id=$1 AND client_id=$2 AND client_sequence=$3
    `,[input.roomId,clientId,input.clientSequence]);
    if (duplicate.rows[0]) {
      const data = mapOperation(duplicate.rows[0]);
      return recordMutation(client,{
        workspaceId:input.workspaceId,projectId:input.projectId,context,operation,digest,
        action:operation,targetType:"page_collaboration_operation",targetId:data.id,
        aggregateType:"page_collaboration_room",aggregateRevision:Number(row.revision),
        eventType:"page_collaboration.operation_replayed.v1",
        inputSummary:{roomId:input.roomId,clientId,clientSequence:input.clientSequence},
        resultSummary:{operationId:data.id,serverSequence:data.serverSequence,replayedClientSequence:true},data,
      });
    }
    const currentSequence = Number(row.current_sequence);
    if (input.baseSequence !== currentSequence) throw new FoundationServiceError("REVISION_CONFLICT", "Collaboration room advanced after the client read it.",{
      expectedRevision: input.baseSequence,currentRevision:currentSequence,
    });
    const serverSequence = currentSequence + 1;
    const id = newFolioId();
    const operationHash = createHash("sha256").update(JSON.stringify(operationValue)).digest("hex");
    const inserted = await client.query<OperationRow>(`
      INSERT INTO page_collaboration_operations(
        id,workspace_id,project_id,room_id,client_id,client_sequence,base_sequence,
        server_sequence,operation,operation_hash,author_principal_id
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING id,room_id,client_id,client_sequence,base_sequence,server_sequence,operation,
        operation_hash,author_principal_id,created_at
    `,[id,input.workspaceId,input.projectId,input.roomId,clientId,input.clientSequence,input.baseSequence,
      serverSequence,operationValue,operationHash,context.actorPrincipalId]);
    const text = documentPlainText(content);
    const contentHash = hashDocument(content);
    await client.query(`
      INSERT INTO page_collaboration_checkpoints(
        id,workspace_id,project_id,room_id,server_sequence,content,plain_text,content_hash,created_by_principal_id
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `,[newFolioId(),input.workspaceId,input.projectId,input.roomId,serverSequence,content,text,contentHash,context.actorPrincipalId]);
    await client.query(`
      UPDATE page_collaboration_rooms SET current_sequence=$4,revision=revision+1,updated_at=now()
      WHERE workspace_id=$1 AND project_id=$2 AND id=$3
    `,[input.workspaceId,input.projectId,input.roomId,serverSequence]);
    const data = mapOperation(inserted.rows[0]!);
    return recordMutation(client,{
      workspaceId:input.workspaceId,projectId:input.projectId,context,operation,digest,
      action:operation,targetType:"page_collaboration_operation",targetId:id,
      aggregateType:"page_collaboration_room",aggregateRevision:Number(row.revision)+1,
      eventType:"page_collaboration.operation_applied.v1",
      inputSummary:{roomId:input.roomId,clientId,clientSequence:input.clientSequence,baseSequence:input.baseSequence},
      resultSummary:{operationId:id,roomId:input.roomId,serverSequence,contentHash},data,
    });
  });
}

export async function commitPageCollaborationRoom(
  input: { workspaceId: string; projectId: string; roomId: string },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<{ room: PageCollaborationRoom; page: NativePage }>> {
  const prepared = await inTransaction(pool,async(client)=>{
    await establishTenantContext(client,input.workspaceId,context.actorPrincipalId);
    const row = await roomRow(client,input,true);
    await authorizePageCapability(client,{
      workspaceId:input.workspaceId,projectId:input.projectId,principalId:context.actorPrincipalId,
      capability:"page.collaborate",pageId:row.page_id,
    });
    if (row.state === "closed") {
      throw new FoundationServiceError("CONFLICT", "Collaboration room is already closed.");
    }
    const checkpoint = await client.query<CheckpointRow>(`
      SELECT content,plain_text,content_hash,server_sequence FROM page_collaboration_checkpoints
      WHERE room_id=$1 ORDER BY server_sequence DESC LIMIT 1
    `,[input.roomId]);
    const cp = checkpoint.rows[0];
    if (!cp) throw new FoundationServiceError("CONFLICT", "Collaboration room has no checkpoint.");
    const page = await client.query<{ revision: string; current_revision_id: string }>(`
      SELECT p.revision,np.current_revision_id FROM pages p JOIN native_pages np
        ON np.workspace_id=p.workspace_id AND np.project_id=p.project_id AND np.page_id=p.id
      WHERE p.workspace_id=$1 AND p.project_id=$2 AND p.id=$3
    `,[input.workspaceId,input.projectId,row.page_id]);
    const current = page.rows[0];
    if (!current || current.current_revision_id !== row.base_revision_id) {
      throw new FoundationServiceError("REVISION_CONFLICT", "Native page changed outside the collaboration room.",{
        expectedRevision:row.base_revision_id,currentRevision:current?.current_revision_id ?? null,
      });
    }
    await client.query(`UPDATE page_collaboration_rooms SET state='closing',updated_at=now() WHERE id=$1`,[input.roomId]);
    return { row,checkpoint:cp,pageRevision:Number(current.revision) };
  });

  let page: NativePage;
  try {
    const committed = await editNativePage({
      workspaceId:input.workspaceId,projectId:input.projectId,pageId:prepared.row.page_id,
      expectedRevision:prepared.pageRevision,content:prepared.checkpoint.content,
    },{ ...context,idempotencyKey:`${context.idempotencyKey}:native-page` },pool);
    page = committed.data;
  } catch (error) {
    await inTransaction(pool,async(client)=>{
      await establishTenantContext(client,input.workspaceId,context.actorPrincipalId);
      await client.query(`UPDATE page_collaboration_rooms SET state='active',updated_at=now() WHERE id=$1 AND state='closing'`,[input.roomId]);
    });
    throw error;
  }

  const operation = "page_collaboration.commit";
  const digest = requestDigest({ ...input,serverSequence:Number(prepared.checkpoint.server_sequence),pageRevision:page.revision });
  return inTransaction(pool,async(client)=>{
    await establishTenantContext(client,input.workspaceId,context.actorPrincipalId);
    await lockIdempotencyKey(client,context.actorPrincipalId,operation,context.idempotencyKey);
    const replay = await findIdempotentResult<{ room:PageCollaborationRoom;page:NativePage }>(client,{
      workspaceId:input.workspaceId,projectId:input.projectId,principalId:context.actorPrincipalId,
      operation,key:context.idempotencyKey,digest,
    });
    if (replay) return replay;
    const closed = await client.query<RoomRow>(`
      UPDATE page_collaboration_rooms SET state='closed',closed_by_principal_id=$4,
        closed_at=now(),revision=revision+1,updated_at=now()
      WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND state='closing' AND current_sequence=$5
      RETURNING id,page_id,state,base_revision_id,current_sequence,revision,
        created_by_principal_id,created_at,updated_at,closed_at
    `,[input.workspaceId,input.projectId,input.roomId,context.actorPrincipalId,Number(prepared.checkpoint.server_sequence)]);
    const row = closed.rows[0];
    if (!row) throw new FoundationServiceError("CONFLICT", "Collaboration room changed while it was being committed.");
    const data = { room:mapRoom(row),page };
    return recordMutation(client,{
      workspaceId:input.workspaceId,projectId:input.projectId,context,operation,digest,
      action:operation,targetType:"page_collaboration_room",targetId:input.roomId,
      aggregateType:"page_collaboration_room",aggregateRevision:Number(row.revision),
      eventType:"page_collaboration.committed.v1",
      inputSummary:{roomId:input.roomId,serverSequence:Number(prepared.checkpoint.server_sequence)},
      resultSummary:{roomId:input.roomId,pageId:page.id,pageRevision:page.revision,nativeRevisionId:page.currentRevision.id},data,
    });
  });
}
