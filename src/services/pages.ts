import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { evaluateProjectCapability, type ProjectCapability } from "@/auth/capabilities";
import { postgresPool } from "@/db/postgres";
import { establishTenantContext } from "@/db/tenant";
import { newFolioId } from "@/lib/folio-ids";
import { FoundationServiceError } from "@/services/foundation/errors";
import { findIdempotentResult, inTransaction, lockIdempotencyKey, recordMutation, requestDigest } from "@/services/foundation/internal";
import type { MutationContext, MutationResult } from "@/services/foundation/types";

export type ProseMirrorNode = { type: string; text?: string; content?: ProseMirrorNode[]; attrs?: Record<string, unknown>; marks?: unknown[]; [key: string]: unknown };
export type NativePage = {
  id: string; workspaceId: string; projectId: string; sourceType: "native"; title: string;
  status: "active" | "archived" | "unavailable"; revision: number;
  currentRevision: { id: string; sequence: number; editorSchemaVersion: number; content: ProseMirrorNode; plainText: string; contentHash: string; authorPrincipalId: string; parentRevisionId: string | null; createdAt: string };
  treePlacements: Array<{ id: string; parentNodeId: string | null; nodeKind: "page" | "alias"; rank: number; displayTitle: string | null; revision: number }>;
  createdAt: string; updatedAt: string;
};

type AccessRow = { workspace_status: string; project_status: string; membership_status: string; capabilities: string[] };
type PageRow = { id: string; workspace_id: string; project_id: string; title: string; status: NativePage["status"]; revision: string; current_revision_id: string; editor_schema_version: number; sequence: string; content: ProseMirrorNode; plain_text: string; content_hash: string; author_principal_id: string; parent_revision_id: string | null; revision_created_at: Date; created_at: Date; updated_at: Date };
type PlacementRow = { id: string; parent_node_id: string | null; node_kind: "page" | "alias"; rank: string; display_title: string | null; revision: string };

function title(value: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) throw new FoundationServiceError("VALIDATION_FAILED", "Page title must contain 1 to 200 characters.");
  return normalized;
}

function document(value: unknown): ProseMirrorNode {
  const json = JSON.stringify(value);
  if (!json || Buffer.byteLength(json) > 1024 * 1024) throw new FoundationServiceError("VALIDATION_FAILED", "Native page content must be at most 1 MiB.");
  let count = 0;
  const visit = (candidate: unknown, depth: number): ProseMirrorNode => {
    if (depth > 100 || ++count > 10_000 || !candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new FoundationServiceError("VALIDATION_FAILED", "Native page content is not a valid structured document.");
    const node = candidate as Record<string, unknown>;
    if (typeof node.type !== "string" || !node.type || node.type.length > 100) throw new FoundationServiceError("VALIDATION_FAILED", "Each native page node requires a valid type.");
    if (node.text !== undefined && typeof node.text !== "string") throw new FoundationServiceError("VALIDATION_FAILED", "Native page text values must be strings.");
    if (node.content !== undefined && !Array.isArray(node.content)) throw new FoundationServiceError("VALIDATION_FAILED", "Native page node content must be an array.");
    return { ...node, type: node.type, ...(Array.isArray(node.content) ? { content: node.content.map((child) => visit(child, depth + 1)) } : {}) } as ProseMirrorNode;
  };
  const result = visit(value, 0);
  if (result.type !== "doc") throw new FoundationServiceError("VALIDATION_FAILED", "Native page content must use a doc root node.");
  return result;
}

function plainText(node: ProseMirrorNode): string {
  const parts: string[] = [];
  const walk = (item: ProseMirrorNode) => { if (item.text) parts.push(item.text); item.content?.forEach(walk); if (["paragraph", "heading", "blockquote", "code_block", "list_item"].includes(item.type)) parts.push("\n"); };
  walk(node);
  return parts.join("").replace(/\n{3,}/g, "\n\n").trim();
}
const hash = (node: ProseMirrorNode) => createHash("sha256").update(JSON.stringify(node)).digest("hex");

async function authorize(client: PoolClient, workspaceId: string, projectId: string, principalId: string, capability: ProjectCapability) {
  const access = await client.query<AccessRow>(`
    SELECT w.status workspace_status, p.status project_status, pm.status membership_status, rt.capabilities
    FROM projects p JOIN workspaces w ON w.id=p.workspace_id
    JOIN project_memberships pm ON pm.workspace_id=p.workspace_id AND pm.project_id=p.id AND pm.principal_id=$3
    JOIN workspace_memberships wm ON wm.workspace_id=p.workspace_id AND wm.principal_id=pm.principal_id
    JOIN role_templates rt ON rt.workspace_id=pm.workspace_id AND rt.id=pm.role_template_id
    WHERE p.workspace_id=$1 AND p.id=$2 AND wm.status='active' AND rt.archived_at IS NULL
  `, [workspaceId, projectId, principalId]);
  const row = access.rows[0];
  if (!row) throw new FoundationServiceError("CAPABILITY_DENIED", "Active project membership is required.");
  const grants = await client.query<{ capability: ProjectCapability; effect: "allow" | "deny" }>(`
    SELECT capability,effect FROM capability_grants WHERE workspace_id=$1 AND (project_id=$2 OR project_id IS NULL)
      AND principal_id=$3 AND capability=$4 AND valid_from<=now() AND (valid_until IS NULL OR valid_until>now())
  `, [workspaceId, projectId, principalId, capability]);
  const decision = evaluateProjectCapability({ capability, workspaceActive: row.workspace_status === "active", projectActive: row.project_status === "active", membershipActive: row.membership_status === "active", roleCapabilities: new Set(row.capabilities as ProjectCapability[]), allowedGrants: new Set(grants.rows.filter((g) => g.effect === "allow").map((g) => g.capability)), deniedGrants: new Set(grants.rows.filter((g) => g.effect === "deny").map((g) => g.capability)) });
  if (!decision.allowed) throw new FoundationServiceError("CAPABILITY_DENIED", "The page capability is not permitted.", { reason: decision.reason });
}

async function placements(client: PoolClient, workspaceId: string, projectId: string, pageId: string) {
  const result = await client.query<PlacementRow>(`SELECT id,parent_node_id,node_kind,rank,display_title,revision FROM page_tree_nodes WHERE workspace_id=$1 AND project_id=$2 AND page_id=$3 AND archived_at IS NULL ORDER BY rank,id`, [workspaceId, projectId, pageId]);
  return result.rows.map((row) => ({ id: row.id, parentNodeId: row.parent_node_id, nodeKind: row.node_kind, rank: Number(row.rank), displayTitle: row.display_title, revision: Number(row.revision) }));
}
function map(row: PageRow, treePlacements: NativePage["treePlacements"]): NativePage {
  return { id: row.id, workspaceId: row.workspace_id, projectId: row.project_id, sourceType: "native", title: row.title, status: row.status, revision: Number(row.revision), currentRevision: { id: row.current_revision_id, sequence: Number(row.sequence), editorSchemaVersion: row.editor_schema_version, content: row.content, plainText: row.plain_text, contentHash: row.content_hash, authorPrincipalId: row.author_principal_id, parentRevisionId: row.parent_revision_id, createdAt: row.revision_created_at.toISOString() }, treePlacements, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}
const pageQuery = `SELECT p.id,p.workspace_id,p.project_id,p.title,p.status,p.revision,p.created_at,p.updated_at,np.current_revision_id,npr.editor_schema_version,npr.sequence,npr.content,npr.plain_text,npr.content_hash,npr.author_principal_id,npr.parent_revision_id,npr.created_at revision_created_at FROM pages p JOIN native_pages np ON np.workspace_id=p.workspace_id AND np.project_id=p.project_id AND np.page_id=p.id JOIN native_page_revisions npr ON npr.workspace_id=np.workspace_id AND npr.project_id=np.project_id AND npr.id=np.current_revision_id`;

export async function createNativePage(raw: { workspaceId: string; projectId: string; title: string; content: unknown; parentNodeId?: string | null; displayTitle?: string | null }, context: MutationContext, pool: Pool = postgresPool()): Promise<MutationResult<NativePage>> {
  const input = { ...raw, title: title(raw.title), content: document(raw.content), parentNodeId: raw.parentNodeId ?? null, displayTitle: raw.displayTitle?.trim() || null };
  const operation = "native_page.create", digest = requestDigest(input);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<NativePage>(client, { workspaceId: input.workspaceId, projectId: input.projectId, principalId: context.actorPrincipalId, operation, key: context.idempotencyKey, digest }); if (replay) return replay;
    await authorize(client, input.workspaceId, input.projectId, context.actorPrincipalId, "page.create");
    if (input.parentNodeId) { const parent = await client.query(`SELECT 1 FROM page_tree_nodes WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND node_kind='folder' AND archived_at IS NULL`, [input.workspaceId,input.projectId,input.parentNodeId]); if (!parent.rows[0]) throw new FoundationServiceError("NOT_FOUND", "The parent folder was not found."); }
    const pageId = newFolioId(), revisionId = newFolioId(), treeNodeId = newFolioId(), now = new Date(), text = plainText(input.content), contentHash = hash(input.content);
    await client.query(`INSERT INTO pages(id,workspace_id,project_id,source_type,title,created_by_principal_id,updated_by_principal_id,created_at,updated_at) VALUES($1,$2,$3,'native',$4,$5,$5,$6,$6)`, [pageId,input.workspaceId,input.projectId,input.title,context.actorPrincipalId,now]);
    await client.query(`INSERT INTO native_pages(page_id,workspace_id,project_id,created_at,updated_at) VALUES($1,$2,$3,$4,$4)`, [pageId,input.workspaceId,input.projectId,now]);
    await client.query(`INSERT INTO native_page_revisions(id,workspace_id,project_id,page_id,sequence,editor_schema_version,content,plain_text,content_hash,author_principal_id,created_at) VALUES($1,$2,$3,$4,1,1,$5,$6,$7,$8,$9)`, [revisionId,input.workspaceId,input.projectId,pageId,input.content,text,contentHash,context.actorPrincipalId,now]);
    await client.query(`UPDATE native_pages SET current_revision_id=$1 WHERE page_id=$2`, [revisionId,pageId]);
    await client.query(`INSERT INTO page_tree_nodes(id,workspace_id,project_id,parent_node_id,node_kind,page_id,display_title,created_by_principal_id,updated_by_principal_id,created_at,updated_at) VALUES($1,$2,$3,$4,'page',$5,$6,$7,$7,$8,$8)`, [treeNodeId,input.workspaceId,input.projectId,input.parentNodeId,pageId,input.displayTitle,context.actorPrincipalId,now]);
    const data: NativePage = { id: pageId, workspaceId: input.workspaceId, projectId: input.projectId, sourceType: "native", title: input.title, status: "active", revision: 1, currentRevision: { id: revisionId, sequence: 1, editorSchemaVersion: 1, content: input.content, plainText: text, contentHash, authorPrincipalId: context.actorPrincipalId, parentRevisionId: null, createdAt: now.toISOString() }, treePlacements: [{ id: treeNodeId, parentNodeId: input.parentNodeId, nodeKind: "page", rank: 1000, displayTitle: input.displayTitle, revision: 1 }], createdAt: now.toISOString(), updatedAt: now.toISOString() };
    return recordMutation(client, { workspaceId: input.workspaceId, projectId: input.projectId, context, operation, digest, action: operation, targetType: "page", targetId: pageId, aggregateType: "page", aggregateRevision: 1, eventType: "native_page.created.v1", inputSummary: { title: input.title }, resultSummary: { pageId, revisionId, contentHash }, data });
  });
}

export async function editNativePage(raw: { workspaceId: string; projectId: string; pageId: string; expectedRevision: number; title?: string; content: unknown }, context: MutationContext, pool: Pool = postgresPool()): Promise<MutationResult<NativePage>> {
  const input = { ...raw, title: raw.title === undefined ? undefined : title(raw.title), content: document(raw.content) };
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw new FoundationServiceError("VALIDATION_FAILED", "Expected revision must be a positive integer.");
  const operation = "native_page.edit", digest = requestDigest(input);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client,input.workspaceId,context.actorPrincipalId); await lockIdempotencyKey(client,context.actorPrincipalId,operation,context.idempotencyKey);
    const replay = await findIdempotentResult<NativePage>(client,{ workspaceId:input.workspaceId,projectId:input.projectId,principalId:context.actorPrincipalId,operation,key:context.idempotencyKey,digest }); if(replay) return replay;
    await authorize(client,input.workspaceId,input.projectId,context.actorPrincipalId,"page.edit");
    const current = await client.query<PageRow>(`${pageQuery} WHERE p.workspace_id=$1 AND p.project_id=$2 AND p.id=$3 FOR UPDATE OF p,np`,[input.workspaceId,input.projectId,input.pageId]); const row=current.rows[0];
    if(!row) throw new FoundationServiceError("NOT_FOUND","Native page was not found."); const revision=Number(row.revision); if(revision!==input.expectedRevision) throw new FoundationServiceError("REVISION_CONFLICT","The native page changed after it was read.",{ expectedRevision:input.expectedRevision,currentRevision:revision });
    const nextTitle=input.title??row.title, contentHash=hash(input.content); if(nextTitle===row.title&&contentHash===row.content_hash) throw new FoundationServiceError("CONFLICT","The edit does not contain changes.");
    const revisionId=newFolioId(),now=new Date(),sequence=Number(row.sequence)+1,text=plainText(input.content);
    await client.query(`INSERT INTO native_page_revisions(id,workspace_id,project_id,page_id,sequence,editor_schema_version,content,plain_text,content_hash,author_principal_id,parent_revision_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[revisionId,input.workspaceId,input.projectId,input.pageId,sequence,row.editor_schema_version,input.content,text,contentHash,context.actorPrincipalId,row.current_revision_id,now]);
    await client.query(`UPDATE native_pages SET current_revision_id=$1,updated_at=$2 WHERE page_id=$3`,[revisionId,now,input.pageId]); await client.query(`UPDATE pages SET title=$1,revision=revision+1,updated_by_principal_id=$2,updated_at=$3 WHERE workspace_id=$4 AND project_id=$5 AND id=$6`,[nextTitle,context.actorPrincipalId,now,input.workspaceId,input.projectId,input.pageId]);
    const data=map({...row,title:nextTitle,revision:String(revision+1),current_revision_id:revisionId,sequence:String(sequence),content:input.content,plain_text:text,content_hash:contentHash,author_principal_id:context.actorPrincipalId,parent_revision_id:row.current_revision_id,revision_created_at:now,updated_at:now},await placements(client,input.workspaceId,input.projectId,input.pageId));
    return recordMutation(client,{ workspaceId:input.workspaceId,projectId:input.projectId,context,operation,digest,action:operation,targetType:"page",targetId:input.pageId,aggregateType:"page",aggregateRevision:revision+1,eventType:"native_page.edited.v1",inputSummary:{ expectedRevision:input.expectedRevision },resultSummary:{ pageId:input.pageId,revisionId,contentHash },data });
  });
}

export async function readNativePage(input:{workspaceId:string;projectId:string;pageId:string},principalId:string,pool:Pool=postgresPool()):Promise<NativePage>{ return inTransaction(pool,async(client)=>{ await establishTenantContext(client,input.workspaceId,principalId); await authorize(client,input.workspaceId,input.projectId,principalId,"page.read"); const result=await client.query<PageRow>(`${pageQuery} WHERE p.workspace_id=$1 AND p.project_id=$2 AND p.id=$3`,[input.workspaceId,input.projectId,input.pageId]); if(!result.rows[0]) throw new FoundationServiceError("NOT_FOUND","Native page was not found."); return map(result.rows[0],await placements(client,input.workspaceId,input.projectId,input.pageId)); }); }
export async function listNativePages(input:{workspaceId:string;projectId:string},principalId:string,pool:Pool=postgresPool()):Promise<NativePage[]>{ return inTransaction(pool,async(client)=>{ await establishTenantContext(client,input.workspaceId,principalId); await authorize(client,input.workspaceId,input.projectId,principalId,"page.read"); const result=await client.query<PageRow>(`${pageQuery} WHERE p.workspace_id=$1 AND p.project_id=$2 AND p.source_type='native' ORDER BY lower(p.title),p.id`,[input.workspaceId,input.projectId]); return Promise.all(result.rows.map(async(row)=>map(row,await placements(client,input.workspaceId,input.projectId,row.id)))); }); }
