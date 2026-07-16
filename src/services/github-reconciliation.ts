import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { postgresPool } from "@/db/postgres";
import {
  getGitHubBlob,
  getGitHubCommit,
  getGitHubRef,
  getGitHubTree,
  GitHubProviderError,
} from "@/integrations/github/app-client";
import { env } from "@/lib/env";
import { newFolioId } from "@/lib/folio-ids";
import { parseMarkdown } from "@/lib/markdown";
import { FoundationServiceError } from "@/services/foundation/errors";
import { inTransaction } from "@/services/foundation/internal";
import { pathMatchesMarkdownScope } from "@/services/github-path-policy";

const MAX_FILE_BYTES = 2 * 1024 * 1024;

type BranchContext = {
  workspaceId:string;projectId:string;selectedBranchId:string;branchName:string;
  rulesVersion:number;parserVersion:string;includeRules:string[];excludeRules:string[];
  providerInstallationId:number;ownerLogin:string;repositoryName:string;
  activeSnapshotId:string|null;actorPrincipalId:string;
};
type TreeBlob = { path:string;sha:string;size:number };
type ParsedFile = {
  id:string;path:string;blobOid:string;sizeBytes:number;contentHash:string;title:string;
  markdown:string;renderedHtml:string;plainText:string;
  headings:Array<{level:number;text:string;slug:string;position:number}>;
};
export type GitReconciliationResult = {
  selectedBranchId:string;snapshotId:string|null;headOid:string|null;published:boolean;
  requeued:boolean;fileCount:number;added:number;changed:number;removed:number;
  unchanged:number;warningCount:number;
};

async function workerTransaction<T>(pool:Pool,work:(client:PoolClient)=>Promise<T>){
  return inTransaction(pool,async(client)=>{await client.query("SET LOCAL ROLE folio_worker");return work(client);});
}

function providerFailure(error:unknown):never{
  if(error instanceof GitHubProviderError){
    const code=error.code==="GITHUB_RATE_LIMITED"?"PROVIDER_RATE_LIMITED"
      :error.code==="GITHUB_PROVIDER_UNAVAILABLE"?"PROVIDER_UNAVAILABLE"
        :error.code==="GITHUB_FORBIDDEN"||error.code==="GITHUB_UNAUTHORIZED"?"GITHUB_PERMISSION_CHANGED"
          :"CONFLICT";
    throw new FoundationServiceError(code,error.message,{providerCode:error.code,retryable:error.retryable});
  }
  throw error;
}

async function claimBranch(pool:Pool,selectedBranchId:string,workerId:string):Promise<BranchContext>{
  return workerTransaction(pool,async(client)=>{
    const result=await client.query<{
      workspace_id:string;project_id:string;id:string;branch_name:string;rules_version:string;
      parser_version:string;include_rules:string[];exclude_rules:string[];link_state:string;
      branch_state:string;repository_state:string;installation_state:string;
      provider_installation_id:string;owner_login:string;repository_name:string;
      active_snapshot_id:string|null;created_by_principal_id:string;
    }>(`SELECT branch.workspace_id,branch.project_id,branch.id,branch.branch_name,
      link.rules_version,link.parser_version,link.include_rules,link.exclude_rules,
      link.state link_state,branch.state branch_state,repository.state repository_state,
      installation.state installation_state,installation.provider_installation_id,
      repository.owner_login,repository.name repository_name,branch.active_snapshot_id,
      branch.created_by_principal_id
      FROM selected_git_branches branch
      JOIN project_repository_links link ON link.workspace_id=branch.workspace_id
        AND link.project_id=branch.project_id AND link.id=branch.repository_link_id
      JOIN github_repositories repository ON repository.workspace_id=link.workspace_id
        AND repository.id=link.repository_id
      JOIN github_app_installations installation ON installation.workspace_id=repository.workspace_id
        AND installation.id=repository.installation_id
      WHERE branch.id=$1 FOR UPDATE OF branch`,[selectedBranchId]);
    const row=result.rows[0];
    if(!row)throw new FoundationServiceError("NOT_FOUND","Selected Git branch was not found.");
    if(row.link_state!=="active"||row.branch_state!=="enabled"||row.repository_state!=="available"||row.installation_state!=="active"){
      throw new FoundationServiceError("CONFLICT","Selected Git branch is not currently reconcilable.");
    }
    const leased=await client.query(`UPDATE selected_git_branches SET lease_owner=$2,
      lease_expires_at=now()+interval '10 minutes',updated_at=now()
      WHERE id=$1 AND (lease_expires_at IS NULL OR lease_expires_at<=now() OR lease_owner=$2)
      RETURNING id`,[selectedBranchId,workerId]);
    if(!leased.rows[0])throw new FoundationServiceError("CONFLICT","Selected Git branch is already being reconciled.",{retryable:true});
    return {
      workspaceId:row.workspace_id,projectId:row.project_id,selectedBranchId:row.id,
      branchName:row.branch_name,rulesVersion:Number(row.rules_version),parserVersion:row.parser_version,
      includeRules:row.include_rules,excludeRules:row.exclude_rules,
      providerInstallationId:Number(row.provider_installation_id),ownerLogin:row.owner_login,
      repositoryName:row.repository_name,activeSnapshotId:row.active_snapshot_id,
      actorPrincipalId:row.created_by_principal_id,
    };
  });
}

async function releaseBranch(pool:Pool,selectedBranchId:string,workerId:string){
  await workerTransaction(pool,async(client)=>{
    await client.query(`UPDATE selected_git_branches SET lease_owner=NULL,lease_expires_at=NULL,updated_at=now()
      WHERE id=$1 AND lease_owner=$2`,[selectedBranchId,workerId]);
  }).catch(()=>undefined);
}

async function enumerateTree(context:BranchContext,treeSha:string):Promise<TreeBlob[]>{
  let recursive;
  try{recursive=await getGitHubTree(context.providerInstallationId,context.ownerLogin,context.repositoryName,treeSha,true);}catch(error){providerFailure(error);}
  const convert=(entries:typeof recursive.data.tree,prefix="")=>entries.flatMap((entry)=>{
    const full=prefix?`${prefix}/${entry.path}`:entry.path;
    return entry.type==="blob"&&typeof entry.size==="number"?[{path:full,sha:entry.sha,size:entry.size}]:[];
  });
  if(!recursive.data.truncated)return convert(recursive.data.tree);

  const blobs:TreeBlob[]=[];
  const queue:Array<{sha:string;prefix:string}>=[{sha:treeSha,prefix:""}];
  let visited=0;
  while(queue.length){
    const item=queue.shift()!;
    let page;
    try{page=await getGitHubTree(context.providerInstallationId,context.ownerLogin,context.repositoryName,item.sha,false);}catch(error){providerFailure(error);}
    for(const entry of page.data.tree){
      visited+=1;
      if(visited>env.GITHUB_MAX_SNAPSHOT_FILES*20)throw new FoundationServiceError("CONFLICT","Git tree exceeds the bounded traversal limit.");
      const full=item.prefix?`${item.prefix}/${entry.path}`:entry.path;
      if(entry.type==="tree")queue.push({sha:entry.sha,prefix:full});
      else if(entry.type==="blob"&&typeof entry.size==="number")blobs.push({path:full,sha:entry.sha,size:entry.size});
    }
  }
  return blobs;
}

async function fetchFiles(context:BranchContext,entries:TreeBlob[]):Promise<{files:ParsedFile[];warnings:string[]}>{
  const scoped=entries.filter((entry)=>pathMatchesMarkdownScope(entry.path,context.includeRules,context.excludeRules));
  if(scoped.length>env.GITHUB_MAX_SNAPSHOT_FILES)throw new FoundationServiceError("CONFLICT","Selected branch exceeds the configured Markdown file limit.");
  const warnings:string[]=[];
  const files:ParsedFile[]=[];
  let totalBytes=0;
  for(const entry of scoped.sort((left,right)=>left.path.localeCompare(right.path))){
    if(entry.size>MAX_FILE_BYTES){warnings.push(`${entry.path}: file exceeds 2 MiB and was skipped`);continue;}
    totalBytes+=entry.size;
    if(totalBytes>env.GITHUB_MAX_SNAPSHOT_BYTES)throw new FoundationServiceError("CONFLICT","Selected branch exceeds the configured Markdown byte limit.");
    let blob;
    try{blob=await getGitHubBlob(context.providerInstallationId,context.ownerLogin,context.repositoryName,entry.sha);}catch(error){providerFailure(error);}
    if(blob.data.encoding!=="base64"||blob.data.sha!==entry.sha||blob.data.size!==entry.size){
      throw new FoundationServiceError("CONFLICT","GitHub blob response did not match the selected tree entry.",{path:entry.path});
    }
    const bytes=Buffer.from(blob.data.content.replace(/\s+/g,""),"base64");
    if(bytes.byteLength!==entry.size)throw new FoundationServiceError("CONFLICT","GitHub blob content length is inconsistent.",{path:entry.path});
    let markdown:string;
    try{markdown=new TextDecoder("utf-8",{fatal:true}).decode(bytes);}catch{warnings.push(`${entry.path}: content is not valid UTF-8 and was skipped`);continue;}
    const parsed=parseMarkdown(markdown,entry.path.split("/").at(-1)??entry.path);
    files.push({id:newFolioId(),path:entry.path,blobOid:entry.sha,sizeBytes:entry.size,
      contentHash:parsed.contentHash,title:parsed.title.slice(0,200),markdown,
      renderedHtml:parsed.renderedHtml,plainText:parsed.extractedText,headings:parsed.headings});
  }
  return{files,warnings};
}

async function priorInventory(pool:Pool,context:BranchContext){
  if(!context.activeSnapshotId)return new Map<string,string>();
  return workerTransaction(pool,async(client)=>{
    const result=await client.query<{source_path:string;blob_oid:string}>(`SELECT source_path,blob_oid
      FROM git_snapshot_files WHERE snapshot_id=$1`,[context.activeSnapshotId]);
    return new Map(result.rows.map((row)=>[row.source_path,row.blob_oid]));
  });
}

async function stageCandidate(pool:Pool,context:BranchContext,headOid:string,files:ParsedFile[],warnings:string[],counts:{added:number;changed:number;removed:number;unchanged:number}){
  const inventoryHash=createHash("sha256").update(files.map((file)=>`${file.path}\0${file.blobOid}`).join("\n")).digest("hex");
  return workerTransaction(pool,async(client)=>{
    const existing=await client.query<{id:string;state:string;inventory_hash:string|null;file_count:number}>(`SELECT id,state,inventory_hash,file_count
      FROM git_snapshots
      WHERE selected_branch_id=$1 AND head_oid=$2 AND rules_version=$3 AND parser_version=$4
        AND state IN ('candidate','published')
      ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    [context.selectedBranchId,headOid,context.rulesVersion,context.parserVersion]);
    if(existing.rows[0]){
      const row=existing.rows[0];
      if(row.state==="published")return{snapshotId:row.id,alreadyPublished:true};
      if(row.inventory_hash===inventoryHash&&Number(row.file_count)===files.length)return{snapshotId:row.id,alreadyPublished:false};
      throw new FoundationServiceError("CONFLICT","An incompatible candidate snapshot already exists for this branch head.");
    }
    const snapshotId=newFolioId();
    await client.query(`INSERT INTO git_snapshots(id,workspace_id,project_id,selected_branch_id,head_oid,state,
      rules_version,parser_version,inventory_hash,file_count,added_count,changed_count,removed_count,
      unchanged_count,warning_count,warnings)
      VALUES($1,$2,$3,$4,$5,'candidate',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [snapshotId,context.workspaceId,context.projectId,context.selectedBranchId,headOid,
      context.rulesVersion,context.parserVersion,inventoryHash,files.length,counts.added,counts.changed,
      counts.removed,counts.unchanged,warnings.length,warnings]);
    for(const file of files){
      await client.query(`INSERT INTO git_snapshot_files(id,workspace_id,project_id,snapshot_id,source_path,
        blob_oid,size_bytes,content_hash,title,markdown,rendered_html,plain_text,headings)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [file.id,context.workspaceId,context.projectId,snapshotId,file.path,file.blobOid,file.sizeBytes,
        file.contentHash,file.title,file.markdown,file.renderedHtml,file.plainText,file.headings]);
    }
    return{snapshotId,alreadyPublished:false};
  });
}

async function discardCandidate(pool:Pool,snapshotId:string){
  await workerTransaction(pool,async(client)=>{
    await client.query(`UPDATE git_snapshots SET state='discarded',completed_at=now(),
      failure_code='HEAD_CHANGED',failure_message='Branch head changed during reconciliation'
      WHERE id=$1 AND state='candidate'`,[snapshotId]);
  });
}

async function publishCandidate(pool:Pool,context:BranchContext,workerId:string,snapshotId:string,headOid:string,files:ParsedFile[],counts:{added:number;changed:number;removed:number;unchanged:number},deliveryId?:string){
  return workerTransaction(pool,async(client)=>{
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`github-branch:${context.selectedBranchId}`]);
    const branch=await client.query<{active_snapshot_id:string|null;revision:string;rules_version:string;lease_owner:string|null}>(`SELECT branch.active_snapshot_id,branch.revision,link.rules_version,branch.lease_owner
      FROM selected_git_branches branch JOIN project_repository_links link
      ON link.workspace_id=branch.workspace_id AND link.project_id=branch.project_id AND link.id=branch.repository_link_id
      WHERE branch.id=$1 AND branch.state='enabled' FOR UPDATE OF branch`,[context.selectedBranchId]);
    const current=branch.rows[0];
    if(!current||current.lease_owner!==workerId)throw new FoundationServiceError("CONFLICT","Git branch reconciliation lease was lost.",{retryable:true});
    if(Number(current.rules_version)!==context.rulesVersion)throw new FoundationServiceError("PATH_POLICY_CHANGED","Markdown scope changed during reconciliation.");
    const candidate=await client.query<{state:string}>(`SELECT state FROM git_snapshots WHERE id=$1 AND selected_branch_id=$2 FOR UPDATE`,[snapshotId,context.selectedBranchId]);
    if(!candidate.rows[0])throw new FoundationServiceError("NOT_FOUND","Candidate Git snapshot was not found.");
    if(candidate.rows[0].state==="published")return{revision:Number(current.revision),activityId:null,outboxId:null};
    if(candidate.rows[0].state!=="candidate")throw new FoundationServiceError("CONFLICT","Git snapshot is not publishable.");

    if(current.active_snapshot_id){
      await client.query(`UPDATE git_snapshots SET state='superseded',completed_at=coalesce(completed_at,now())
        WHERE id=$1 AND state='published'`,[current.active_snapshot_id]);
    }
    await client.query(`UPDATE git_snapshots SET state='published',published_at=now(),completed_at=now()
      WHERE id=$1 AND state='candidate'`,[snapshotId]);

    const activePaths=new Set(files.map((file)=>file.path));
    for(const file of files){
      const existing=await client.query<{page_id:string}>(`SELECT page_id FROM git_pages
        WHERE selected_branch_id=$1 AND source_path=$2 FOR UPDATE`,[context.selectedBranchId,file.path]);
      const pageId=existing.rows[0]?.page_id??newFolioId();
      if(existing.rows[0]){
        await client.query(`UPDATE pages SET title=$4,status='active',archived_at=NULL,revision=revision+1,
          updated_by_principal_id=$5,updated_at=now()
          WHERE workspace_id=$1 AND project_id=$2 AND id=$3`,
        [context.workspaceId,context.projectId,pageId,file.title,context.actorPrincipalId]);
      }else{
        await client.query(`INSERT INTO pages(id,workspace_id,project_id,source_type,title,status,
          created_by_principal_id,updated_by_principal_id)
          VALUES($1,$2,$3,'git',$4,'active',$5,$5)`,
        [pageId,context.workspaceId,context.projectId,file.title,context.actorPrincipalId]);
      }
      await client.query(`INSERT INTO git_pages(page_id,workspace_id,project_id,selected_branch_id,source_path,
        current_snapshot_file_id,current_head_oid,current_blob_oid,content_hash,markdown,rendered_html,plain_text)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT(selected_branch_id,source_path) DO UPDATE SET
          current_snapshot_file_id=excluded.current_snapshot_file_id,current_head_oid=excluded.current_head_oid,
          current_blob_oid=excluded.current_blob_oid,content_hash=excluded.content_hash,
          markdown=excluded.markdown,rendered_html=excluded.rendered_html,
          plain_text=excluded.plain_text,updated_at=now()`,
      [pageId,context.workspaceId,context.projectId,context.selectedBranchId,file.path,file.id,headOid,
        file.blobOid,file.contentHash,file.markdown,file.renderedHtml,file.plainText]);
      await client.query(`INSERT INTO page_search_documents(workspace_id,project_id,page_id,source_type,title,body,current_revision_id,updated_at)
        VALUES($1,$2,$3,'git',$4,$5,$6,now())
        ON CONFLICT(workspace_id,project_id,page_id) DO UPDATE SET source_type='git',title=excluded.title,
          body=excluded.body,current_revision_id=excluded.current_revision_id,updated_at=now()`,
      [context.workspaceId,context.projectId,pageId,file.title,file.plainText,`${headOid}:${file.blobOid}`]);
    }
    const removed=await client.query<{page_id:string}>(`SELECT page_id FROM git_pages
      WHERE selected_branch_id=$1 AND NOT(source_path=ANY($2::text[]))`,
    [context.selectedBranchId,[...activePaths]]);
    for(const row of removed.rows){
      await client.query(`UPDATE pages SET status='unavailable',revision=revision+1,
        updated_by_principal_id=$4,updated_at=now()
        WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND status='active'`,
      [context.workspaceId,context.projectId,row.page_id,context.actorPrincipalId]);
      await client.query(`DELETE FROM page_search_documents
        WHERE workspace_id=$1 AND project_id=$2 AND page_id=$3 AND source_type='git'`,
      [context.workspaceId,context.projectId,row.page_id]);
    }
    const branchUpdate=await client.query<{revision:string}>(`UPDATE selected_git_branches
      SET active_snapshot_id=$2,last_observed_head_oid=$3,last_reconciled_at=now(),
        lease_owner=NULL,lease_expires_at=NULL,revision=revision+1,updated_at=now()
      WHERE id=$1 RETURNING revision`,[context.selectedBranchId,snapshotId,headOid]);
    const revision=Number(branchUpdate.rows[0]!.revision);
    const activityId=newFolioId();const outboxId=newFolioId();const requestId=newFolioId();
    await client.query(`INSERT INTO activity_events(id,workspace_id,project_id,actor_principal_id,
      authorizing_principal_id,source,action,target_type,target_id,input_summary,result_summary,request_id,trace_id)
      VALUES($1,$2,$3,$4,$4,'worker','github.branch.reconciled','selected_git_branch',$5,$6,$7,$8,$9)`,
    [activityId,context.workspaceId,context.projectId,context.actorPrincipalId,context.selectedBranchId,
      {headOid,fileCount:files.length},{snapshotId,...counts},requestId,`github-reconcile:${snapshotId}`]);
    await client.query(`INSERT INTO outbox_events(id,workspace_id,project_id,aggregate_type,aggregate_id,
      aggregate_revision,event_type,actor_principal_id,authorizing_principal_id,request_id,trace_id,payload)
      VALUES($1,$2,$3,'selected_git_branch',$4,$5,'github.branch_reconciled.v1',$6,$6,$7,$8,$9)`,
    [outboxId,context.workspaceId,context.projectId,context.selectedBranchId,revision,
      context.actorPrincipalId,requestId,`github-reconcile:${snapshotId}`,{snapshotId,headOid,...counts}]);
    if(deliveryId)await client.query(`UPDATE github_webhook_deliveries SET status='succeeded',
      processed_at=now(),last_error_code=NULL,last_error_message=NULL WHERE delivery_id=$1`,[deliveryId]);
    return{revision,activityId,outboxId};
  });
}

export async function reconcileGitHubBranch(
  input:{selectedBranchId:string;workerId:string;deliveryId?:string;headHint?:string},
  pool:Pool=postgresPool(),
):Promise<GitReconciliationResult>{
  const context=await claimBranch(pool,input.selectedBranchId,input.workerId);
  let snapshotId:string|null=null;
  try{
    let ref;
    try{ref=await getGitHubRef(context.providerInstallationId,context.ownerLogin,context.repositoryName,`heads/${context.branchName}`);}catch(error){providerFailure(error);}
    const headOid=ref.data.object.sha;
    let commit;
    try{commit=await getGitHubCommit(context.providerInstallationId,context.ownerLogin,context.repositoryName,headOid);}catch(error){providerFailure(error);}
    const tree=await enumerateTree(context,commit.data.tree.sha);
    const {files,warnings}=await fetchFiles(context,tree);
    const previous=await priorInventory(pool,context);
    const current=new Map(files.map((file)=>[file.path,file.blobOid]));
    let added=0,changed=0,unchanged=0;
    for(const [path,blob] of current){const prior=previous.get(path);if(prior===undefined)added+=1;else if(prior===blob)unchanged+=1;else changed+=1;}
    let removed=0;for(const path of previous.keys())if(!current.has(path))removed+=1;
    const counts={added,changed,removed,unchanged};
    const staged=await stageCandidate(pool,context,headOid,files,warnings,counts);
    snapshotId=staged.snapshotId;
    if(staged.alreadyPublished){
      await releaseBranch(pool,context.selectedBranchId,input.workerId);
      return{selectedBranchId:context.selectedBranchId,snapshotId,headOid,published:true,requeued:false,
        fileCount:files.length,...counts,warningCount:warnings.length};
    }
    let finalRef;
    try{finalRef=await getGitHubRef(context.providerInstallationId,context.ownerLogin,context.repositoryName,`heads/${context.branchName}`);}catch(error){providerFailure(error);}
    if(finalRef.data.object.sha!==headOid){
      await discardCandidate(pool,snapshotId);
      await workerTransaction(pool,async(client)=>{
        await client.query(`INSERT INTO jobs(id,workspace_id,project_id,kind,payload,deduplication_key,
          status,priority,max_attempts,available_at)
          VALUES($1,$2,$3,'github.branch.reconcile',$4,$5,'pending',50,8,now()) ON CONFLICT DO NOTHING`,
        [newFolioId(),context.workspaceId,context.projectId,
          {selectedBranchId:context.selectedBranchId,headHint:finalRef.data.object.sha},
          `github-reconcile:${context.selectedBranchId}:${finalRef.data.object.sha}`]);
      });
      await releaseBranch(pool,context.selectedBranchId,input.workerId);
      return{selectedBranchId:context.selectedBranchId,snapshotId,headOid,published:false,requeued:true,
        fileCount:files.length,...counts,warningCount:warnings.length};
    }
    await publishCandidate(pool,context,input.workerId,snapshotId,headOid,files,counts,input.deliveryId);
    return{selectedBranchId:context.selectedBranchId,snapshotId,headOid,published:true,requeued:false,
      fileCount:files.length,...counts,warningCount:warnings.length};
  }catch(error){
    if(snapshotId)await workerTransaction(pool,async(client)=>{
      await client.query(`UPDATE git_snapshots SET state='failed',completed_at=now(),failure_code=$2,
        failure_message=$3 WHERE id=$1 AND state='candidate'`,
      [snapshotId,error instanceof FoundationServiceError?error.code:"RECONCILIATION_FAILED",
        error instanceof Error?error.message.slice(0,500):"Reconciliation failed"]);
    }).catch(()=>undefined);
    if(input.deliveryId)await workerTransaction(pool,async(client)=>{
      await client.query(`UPDATE github_webhook_deliveries SET status='failed',processed_at=now(),
        last_error_code=$2,last_error_message=$3 WHERE delivery_id=$1`,
      [input.deliveryId,error instanceof FoundationServiceError?error.code:"RECONCILIATION_FAILED",
        error instanceof Error?error.message.slice(0,500):"Reconciliation failed"]);
    }).catch(()=>undefined);
    await releaseBranch(pool,context.selectedBranchId,input.workerId);
    throw error;
  }
}
