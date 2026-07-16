import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { postgresPool } from "@/db/postgres";
import { sqlite } from "@/db/client";
import { establishTenantContext } from "@/db/tenant";
import { env } from "@/lib/env";
import { newFolioId } from "@/lib/folio-ids";
import { authorizeEcosystemProjectCapability, authorizeWorkspaceOwner } from "@/services/ecosystem-access";
import { FoundationServiceError } from "@/services/foundation/errors";
import { findIdempotentResult, inTransaction, lockIdempotencyKey, recordMutation, requestDigest } from "@/services/foundation/internal";
import type { MutationContext, MutationResult } from "@/services/foundation/types";
import { addSelectedGitBranch } from "@/services/github-repositories";
import type { LegacyImportResult } from "@/services/legacy-import";

type LegacyRepository={id:string;display_name:string;local_path:string};
type LegacySource={id:string;repository_id:string;name:string;branch:string};
type LegacyDocument={id:string;sync_source_id:string;path:string;blob_oid:string;content_hash:string};
type RunRow={id:string;state:string;discovered_count:number;imported_count:number;skipped_count:number;failed_count:number;cursor:Record<string,unknown>};

function fingerprint(repositories:LegacyRepository[],sources:LegacySource[],documents:LegacyDocument[]){return createHash("sha256").update(JSON.stringify({repositories:repositories.map((item)=>[item.id,item.display_name]),sources:sources.map((item)=>[item.id,item.repository_id,item.branch]),documents:documents.map((item)=>[item.id,item.sync_source_id,item.path,item.blob_oid,item.content_hash])})).digest("hex");}
function resultFromRun(row:RunRow):LegacyImportResult{return{runId:row.id,state:row.state==="succeeded"?"succeeded":"succeeded_with_warnings",discoveredCount:Number(row.discovered_count),importedCount:Number(row.imported_count),skippedCount:Number(row.skipped_count),failedCount:Number(row.failed_count),selectedBranchIds:Array.isArray(row.cursor.selectedBranchIds)?row.cursor.selectedBranchIds.filter((value):value is string=>typeof value==="string"):[],warnings:Array.isArray(row.cursor.warnings)?row.cursor.warnings.filter((value):value is string=>typeof value==="string"):[]};}

export async function importLegacyReaderMetadataRecoverable(
  raw:{workspaceId:string;projectId:string;mappings:Array<{legacyRepositoryId:string;repositoryLinkId:string}>},
  context:MutationContext,
  pool:Pool=postgresPool(),
):Promise<MutationResult<LegacyImportResult>>{
  if(!env.LEGACY_IMPORT_ENABLED)throw new FoundationServiceError("CAPABILITY_DENIED","Legacy import is disabled by deployment configuration.");
  if(!raw.mappings.length||raw.mappings.length>100)throw new FoundationServiceError("VALIDATION_FAILED","Legacy import requires 1 to 100 repository mappings.");
  const unique=new Set(raw.mappings.map((mapping)=>mapping.legacyRepositoryId));if(unique.size!==raw.mappings.length)throw new FoundationServiceError("VALIDATION_FAILED","Each legacy repository may be mapped once.");
  const repositories=sqlite().prepare(`SELECT id,display_name,local_path FROM repositories ORDER BY id`).all() as LegacyRepository[];
  const sources=sqlite().prepare(`SELECT id,repository_id,name,branch FROM sync_sources ORDER BY id`).all() as LegacySource[];
  const documents=sqlite().prepare(`SELECT id,sync_source_id,path,blob_oid,content_hash FROM documents ORDER BY id`).all() as LegacyDocument[];
  const sourceFingerprint=fingerprint(repositories,sources,documents);const operation="legacy.import.metadata";const digest=requestDigest({workspaceId:raw.workspaceId,projectId:raw.projectId,mappings:raw.mappings,sourceFingerprint});

  const opening=await inTransaction(pool,async(client)=>{
    await establishTenantContext(client,raw.workspaceId,context.actorPrincipalId);await lockIdempotencyKey(client,context.actorPrincipalId,operation,context.idempotencyKey);
    const replay=await findIdempotentResult<LegacyImportResult>(client,{workspaceId:raw.workspaceId,projectId:raw.projectId,principalId:context.actorPrincipalId,operation,key:context.idempotencyKey,digest});if(replay)return{replay,run:null as RunRow|null};
    await authorizeWorkspaceOwner(client,{workspaceId:raw.workspaceId,principalId:context.actorPrincipalId});await authorizeEcosystemProjectCapability(client,{workspaceId:raw.workspaceId,projectId:raw.projectId,principalId:context.actorPrincipalId,capability:"repository.manage"});
    for(const mapping of raw.mappings){const link=await client.query(`SELECT 1 FROM project_repository_links WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND state='active'`,[raw.workspaceId,raw.projectId,mapping.repositoryLinkId]);if(!link.rows[0])throw new FoundationServiceError("VALIDATION_FAILED","A repository mapping does not target an active project repository link.");if(!repositories.some((repository)=>repository.id===mapping.legacyRepositoryId))throw new FoundationServiceError("VALIDATION_FAILED","A mapped legacy repository does not exist.");}
    const existing=await client.query<RunRow>(`SELECT id,state,discovered_count,imported_count,skipped_count,failed_count,cursor FROM legacy_import_runs WHERE workspace_id=$1 AND project_id=$2 AND source_fingerprint=$3 AND state IN ('running','succeeded','succeeded_with_warnings') ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,[raw.workspaceId,raw.projectId,sourceFingerprint]);
    if(existing.rows[0])return{replay:null,run:existing.rows[0]};
    const runId=newFolioId();const inserted=await client.query<RunRow>(`INSERT INTO legacy_import_runs(id,workspace_id,project_id,source_fingerprint,state,discovered_count,created_by_principal_id,cursor) VALUES($1,$2,$3,$4,'running',$5,$6,$7) RETURNING id,state,discovered_count,imported_count,skipped_count,failed_count,cursor`,[runId,raw.workspaceId,raw.projectId,sourceFingerprint,repositories.length+sources.length+documents.length,context.actorPrincipalId,{selectedBranchIds:[],warnings:[]}]);return{replay:null,run:inserted.rows[0]!};
  });
  if(opening.replay)return opening.replay;
  const run=opening.run!;
  if(run.state==="succeeded"||run.state==="succeeded_with_warnings"){
    const data=resultFromRun(run);
    return inTransaction(pool,async(client)=>{await establishTenantContext(client,raw.workspaceId,context.actorPrincipalId);return recordMutation(client,{workspaceId:raw.workspaceId,projectId:raw.projectId,context,operation,digest,action:operation,targetType:"legacy_import_run",targetId:run.id,aggregateType:"legacy_import_run",aggregateRevision:1,eventType:"legacy.import_completed.v1",inputSummary:{mappingCount:raw.mappings.length,sourceFingerprint},resultSummary:{runId:run.id,state:run.state,replayedRun:true},data});});
  }
  throwIfRunningByAnotherAttempt(run);
  let imported=0,skipped=0,failed=0;const selectedBranchIds:string[]=[];const warnings:string[]=[];
  try{
    for(const mapping of raw.mappings){const repository=repositories.find((item)=>item.id===mapping.legacyRepositoryId)!;await inTransaction(pool,async(client)=>{await establishTenantContext(client,raw.workspaceId,context.actorPrincipalId);await client.query(`INSERT INTO legacy_import_records(id,workspace_id,project_id,import_run_id,legacy_entity_type,legacy_entity_id,source_hash,target_entity_type,target_entity_id,state,warning_code) VALUES($1,$2,$3,$4,'repository',$5,$6,'repository_link',$7,'imported','LOCAL_PATH_NOT_IMPORTED') ON CONFLICT(import_run_id,legacy_entity_type,legacy_entity_id) DO NOTHING`,[newFolioId(),raw.workspaceId,raw.projectId,run.id,repository.id,createHash("sha256").update(`${repository.display_name}\0${repository.local_path}`).digest("hex"),mapping.repositoryLinkId]);});imported+=1;
      for(const source of sources.filter((item)=>item.repository_id===repository.id)){let branchId:string|null=null;try{const selected=await addSelectedGitBranch({workspaceId:raw.workspaceId,projectId:raw.projectId,linkId:mapping.repositoryLinkId,branchName:source.branch},{...context,idempotencyKey:`${context.idempotencyKey}:legacy-branch:${source.id}`},pool);branchId=selected.data.id;}catch(error){if(error instanceof FoundationServiceError&&error.code==="CONFLICT")branchId=await inTransaction(pool,async(client)=>{await establishTenantContext(client,raw.workspaceId,context.actorPrincipalId);const found=await client.query<{id:string}>(`SELECT id FROM selected_git_branches WHERE workspace_id=$1 AND project_id=$2 AND repository_link_id=$3 AND branch_name=$4`,[raw.workspaceId,raw.projectId,mapping.repositoryLinkId,source.branch]);return found.rows[0]?.id??null;});else throw error;}if(!branchId){failed+=1;continue;}selectedBranchIds.push(branchId);await inTransaction(pool,async(client)=>{await establishTenantContext(client,raw.workspaceId,context.actorPrincipalId);await client.query(`INSERT INTO legacy_import_records(id,workspace_id,project_id,import_run_id,legacy_entity_type,legacy_entity_id,source_hash,target_entity_type,target_entity_id,state) VALUES($1,$2,$3,$4,'sync_source',$5,$6,'selected_git_branch',$7,'imported') ON CONFLICT(import_run_id,legacy_entity_type,legacy_entity_id) DO NOTHING`,[newFolioId(),raw.workspaceId,raw.projectId,run.id,source.id,createHash("sha256").update(`${source.name}\0${source.branch}`).digest("hex"),branchId]);});imported+=1;
        for(const document of documents.filter((item)=>item.sync_source_id===source.id)){await inTransaction(pool,async(client)=>{await establishTenantContext(client,raw.workspaceId,context.actorPrincipalId);await client.query(`INSERT INTO legacy_import_records(id,workspace_id,project_id,import_run_id,legacy_entity_type,legacy_entity_id,source_hash,state,warning_code) VALUES($1,$2,$3,$4,'document',$5,$6,'skipped','AUTHORITATIVE_GITHUB_REFETCH_REQUIRED') ON CONFLICT(import_run_id,legacy_entity_type,legacy_entity_id) DO NOTHING`,[newFolioId(),raw.workspaceId,raw.projectId,run.id,document.id,createHash("sha256").update(`${document.path}\0${document.blob_oid}\0${document.content_hash}`).digest("hex")]);});skipped+=1;}
      }
    }
    if(skipped)warnings.push(`${skipped} cached document bodies were intentionally skipped and will be rebuilt from GitHub.`);const state=warnings.length||skipped||failed?"succeeded_with_warnings" as const:"succeeded" as const;const data:LegacyImportResult={runId:run.id,state,discoveredCount:repositories.length+sources.length+documents.length,importedCount:imported,skippedCount:skipped,failedCount:failed,selectedBranchIds:[...new Set(selectedBranchIds)],warnings};
    await inTransaction(pool,async(client)=>{await establishTenantContext(client,raw.workspaceId,context.actorPrincipalId);await client.query(`UPDATE legacy_import_runs SET state=$2,imported_count=$3,skipped_count=$4,failed_count=$5,completed_at=now(),updated_at=now(),cursor=$6 WHERE id=$1`,[run.id,state,imported,skipped,failed,{selectedBranchIds:data.selectedBranchIds,warnings}]);});
    return inTransaction(pool,async(client)=>{await establishTenantContext(client,raw.workspaceId,context.actorPrincipalId);return recordMutation(client,{workspaceId:raw.workspaceId,projectId:raw.projectId,context,operation,digest,action:operation,targetType:"legacy_import_run",targetId:run.id,aggregateType:"legacy_import_run",aggregateRevision:1,eventType:"legacy.import_completed.v1",inputSummary:{mappingCount:raw.mappings.length,sourceFingerprint},resultSummary:{runId:run.id,state,imported,skipped,failed},data});});
  }catch(error){await inTransaction(pool,async(client)=>{await establishTenantContext(client,raw.workspaceId,context.actorPrincipalId);await client.query(`UPDATE legacy_import_runs SET state='failed',failed_count=failed_count+1,completed_at=now(),updated_at=now(),last_error_code=$2,last_error_message=$3 WHERE id=$1 AND state='running'`,[run.id,error instanceof FoundationServiceError?error.code:"LEGACY_IMPORT_FAILED",error instanceof Error?error.message.slice(0,500):"Legacy import failed"]);}).catch(()=>undefined);throw error;}
}

function throwIfRunningByAnotherAttempt(run:RunRow){
  if(run.state==="running"&&Number(run.imported_count)+Number(run.skipped_count)+Number(run.failed_count)>0){
    throw new FoundationServiceError("CONFLICT","Legacy import is already running or recovering.",{retryable:true,runId:run.id});
  }
}
