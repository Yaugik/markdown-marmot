import type { Pool, PoolClient } from "pg";
import { postgresPool } from "@/db/postgres";
import { GitHubProviderError, listGitHubInstallationRepositories } from "@/integrations/github/app-client";
import { newFolioId } from "@/lib/folio-ids";
import { claimDurableJobs, finishDurableJob, type DurableJob } from "@/services/durable-jobs";
import { FoundationServiceError } from "@/services/foundation/errors";
import { inTransaction } from "@/services/foundation/internal";
import { reconcileGitHubBranch } from "@/services/github-reconciliation";

const JOB_KINDS = ["github.repository.refresh", "github.branch.reconcile", "github.write.execute"];

async function workerTransaction<T>(pool:Pool,work:(client:PoolClient)=>Promise<T>){
  return inTransaction(pool,async(client)=>{await client.query("SET LOCAL ROLE folio_worker");return work(client);});
}

async function refreshRepositories(job:DurableJob,pool:Pool){
  const installationId=typeof job.payload.installationId==="string"?job.payload.installationId:null;
  const deliveryId=typeof job.payload.deliveryId==="string"?job.payload.deliveryId:null;
  if(!installationId)throw new FoundationServiceError("VALIDATION_FAILED","Repository refresh job is missing an installation ID.");
  const installation=await workerTransaction(pool,async(client)=>{
    const result=await client.query<{workspace_id:string;provider_installation_id:string;state:string;created_by_principal_id:string;revision:string}>(`SELECT workspace_id,provider_installation_id,state,created_by_principal_id,revision FROM github_app_installations WHERE id=$1`,[installationId]);
    const row=result.rows[0];if(!row)throw new FoundationServiceError("NOT_FOUND","GitHub installation was not found.");
    if(row.state==="revoked")throw new FoundationServiceError("CONFLICT","GitHub installation is revoked.");
    return row;
  });
  let provider;
  try{provider=await listGitHubInstallationRepositories(Number(installation.provider_installation_id));}
  catch(error){if(error instanceof GitHubProviderError)throw new FoundationServiceError("CONFLICT",error.message,{providerCode:error.code,retryable:error.retryable});throw error;}
  if(provider.repositories.length>10000)throw new FoundationServiceError("CONFLICT","GitHub installation exposes more repositories than the supported discovery boundary.");
  return workerTransaction(pool,async(client)=>{
    const observed=provider.repositories.map((repository)=>repository.id);
    for(const repository of provider.repositories){
      await client.query(`INSERT INTO github_repositories(id,workspace_id,installation_id,provider_repository_id,owner_login,name,full_name,default_branch,is_private,is_archived,permissions,state,provider_updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'available',$12)
        ON CONFLICT(installation_id,provider_repository_id) DO UPDATE SET owner_login=excluded.owner_login,name=excluded.name,full_name=excluded.full_name,default_branch=excluded.default_branch,is_private=excluded.is_private,is_archived=excluded.is_archived,permissions=excluded.permissions,state='available',provider_updated_at=excluded.provider_updated_at,revision=github_repositories.revision+1,updated_at=now()`,
      [newFolioId(),installation.workspace_id,installationId,repository.id,repository.owner.login,repository.name,repository.full_name,repository.default_branch,repository.private,repository.archived,repository.permissions??{},repository.updated_at??null]);
    }
    const removed=await client.query(`UPDATE github_repositories SET state='removed',revision=revision+1,updated_at=now()
      WHERE workspace_id=$1 AND installation_id=$2 AND state='available'
        AND NOT(provider_repository_id=ANY($3::bigint[])) RETURNING id`,[installation.workspace_id,installationId,observed]);
    const updated=await client.query<{revision:string}>(`UPDATE github_app_installations SET last_validated_at=now(),state='active',revision=revision+1,updated_at=now() WHERE id=$1 RETURNING revision`,[installationId]);
    await client.query(`INSERT INTO github_rate_limit_observations(id,workspace_id,installation_id,resource,remaining,limit_value,reset_at,retry_after_seconds)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[newFolioId(),installation.workspace_id,installationId,provider.rateLimit.resource,provider.rateLimit.remaining,provider.rateLimit.limit,provider.rateLimit.resetAt,provider.rateLimit.retryAfterSeconds]);
    const activityId=newFolioId();const outboxId=newFolioId();const requestId=newFolioId();
    await client.query(`INSERT INTO activity_events(id,workspace_id,actor_principal_id,authorizing_principal_id,source,action,target_type,target_id,input_summary,result_summary,request_id,trace_id)
      VALUES($1,$2,$3,$3,'worker','github.repositories.refreshed','github_installation',$4,$5,$6,$7,$8)`,[activityId,installation.workspace_id,installation.created_by_principal_id,installationId,{providerRepositoryCount:provider.repositories.length},{availableCount:provider.repositories.length,removedCount:removed.rowCount??0},requestId,`github-repository-refresh:${job.id}`]);
    await client.query(`INSERT INTO outbox_events(id,workspace_id,aggregate_type,aggregate_id,aggregate_revision,event_type,actor_principal_id,authorizing_principal_id,request_id,trace_id,payload)
      VALUES($1,$2,'github_installation',$3,$4,'github.repositories_refreshed.v1',$5,$5,$6,$7,$8)`,[outboxId,installation.workspace_id,installationId,Number(updated.rows[0]!.revision),installation.created_by_principal_id,requestId,`github-repository-refresh:${job.id}`,{availableCount:provider.repositories.length,removedCount:removed.rowCount??0}]);
    if(deliveryId)await client.query(`UPDATE github_webhook_deliveries SET status='succeeded',processed_at=now(),last_error_code=NULL,last_error_message=NULL WHERE delivery_id=$1`,[deliveryId]);
    return{installationId,availableCount:provider.repositories.length,removedCount:removed.rowCount??0};
  });
}

async function executeJob(job:DurableJob,workerId:string,pool:Pool){
  if(job.kind==="github.repository.refresh")return refreshRepositories(job,pool);
  if(job.kind==="github.branch.reconcile"){
    const selectedBranchId=typeof job.payload.selectedBranchId==="string"?job.payload.selectedBranchId:null;
    if(!selectedBranchId)throw new FoundationServiceError("VALIDATION_FAILED","Branch reconciliation job is missing a selected branch ID.");
    return reconcileGitHubBranch({selectedBranchId,workerId,deliveryId:typeof job.payload.deliveryId==="string"?job.payload.deliveryId:undefined,headHint:typeof job.payload.headHint==="string"?job.payload.headHint:undefined},pool);
  }
  throw new FoundationServiceError("CONFLICT","Git write execution handler is not registered yet.");
}

function retryable(error:unknown){
  if(error instanceof FoundationServiceError)return error.details.retryable===true||error.code==="CONFLICT";
  return true;
}

export async function runGitHubWorkerCycle(workerId:string,pool:Pool=postgresPool()):Promise<number>{
  const jobs=await claimDurableJobs({workerId,kinds:JOB_KINDS,leaseSeconds:600,limit:5},pool);
  for(const job of jobs){
    try{
      const result=await executeJob(job,workerId,pool);
      await finishDurableJob({jobId:job.id,workerId,success:true,result:result as Record<string,unknown>},pool);
    }catch(error){
      await finishDurableJob({jobId:job.id,workerId,success:false,errorCode:error instanceof FoundationServiceError?error.code:"GITHUB_JOB_FAILED",errorMessage:error instanceof Error?error.message:"GitHub job failed",retryable:retryable(error)},pool);
    }
  }
  return jobs.length;
}
