import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { postgresPool } from "@/db/postgres";
import { establishTenantContext } from "@/db/tenant";
import { env, githubAppConfigured } from "@/lib/env";
import { newFolioId } from "@/lib/folio-ids";
import {
  getGitHubInstallation,
  GitHubProviderError,
  listGitHubInstallationRepositories,
  type GitHubRateLimit,
} from "@/integrations/github/app-client";
import type { ParsedGitHubWebhook } from "@/integrations/github/webhook";
import { enqueueDurableJob } from "@/services/durable-jobs";
import { FoundationServiceError } from "@/services/foundation/errors";
import {
  findIdempotentResult,
  inTransaction,
  lockIdempotencyKey,
  recordMutation,
  requestDigest,
} from "@/services/foundation/internal";
import type { MutationContext, MutationResult } from "@/services/foundation/types";

export type GitHubInstallation = {
  id:string;workspaceId:string;providerInstallationId:number;accountId:number;accountLogin:string;
  accountType:"User"|"Organization"|"Enterprise";repositorySelection:"all"|"selected";
  permissions:Record<string,string>;events:string[];state:"active"|"suspended"|"revoked";
  revision:number;lastValidatedAt:string|null;createdAt:string;updatedAt:string;
};
export type GitHubRepository = {
  id:string;installationId:string;providerRepositoryId:number;ownerLogin:string;name:string;
  fullName:string;defaultBranch:string;isPrivate:boolean;isArchived:boolean;
  permissions:Record<string,boolean>;state:"available"|"removed"|"inaccessible";revision:number;
};

type InstallationRow={id:string;workspace_id:string;provider_installation_id:string;account_id:string;account_login:string;account_type:GitHubInstallation["accountType"];repository_selection:GitHubInstallation["repositorySelection"];permissions:Record<string,string>;events:string[];state:GitHubInstallation["state"];revision:string;last_validated_at:Date|null;created_at:Date;updated_at:Date};
type RepositoryRow={id:string;installation_id:string;provider_repository_id:string;owner_login:string;name:string;full_name:string;default_branch:string;is_private:boolean;is_archived:boolean;permissions:Record<string,boolean>;state:GitHubRepository["state"];revision:string};
const installationColumns=`id,workspace_id,provider_installation_id,account_id,account_login,account_type,repository_selection,permissions,events,state,revision,last_validated_at,created_at,updated_at`;
const repositoryColumns=`id,installation_id,provider_repository_id,owner_login,name,full_name,default_branch,is_private,is_archived,permissions,state,revision`;

function mapInstallation(row:InstallationRow):GitHubInstallation{return{id:row.id,workspaceId:row.workspace_id,providerInstallationId:Number(row.provider_installation_id),accountId:Number(row.account_id),accountLogin:row.account_login,accountType:row.account_type,repositorySelection:row.repository_selection,permissions:row.permissions,events:row.events,state:row.state,revision:Number(row.revision),lastValidatedAt:row.last_validated_at?.toISOString()??null,createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString()};}
function mapRepository(row:RepositoryRow):GitHubRepository{return{id:row.id,installationId:row.installation_id,providerRepositoryId:Number(row.provider_repository_id),ownerLogin:row.owner_login,name:row.name,fullName:row.full_name,defaultBranch:row.default_branch,isPrivate:row.is_private,isArchived:row.is_archived,permissions:row.permissions,state:row.state,revision:Number(row.revision)};}

async function requireOwner(client:import("pg").PoolClient,workspaceId:string,principalId:string){const result=await client.query(`SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND principal_id=$2 AND role='owner' AND status='active'`,[workspaceId,principalId]);if(!result.rows[0])throw new FoundationServiceError("CAPABILITY_DENIED","An active workspace owner is required.");}
function providerFailure(error:unknown):never{if(error instanceof GitHubProviderError){const code=error.code==="GITHUB_NOT_FOUND"?"NOT_FOUND":error.code==="GITHUB_CONFLICT"?"CONFLICT":error.code==="GITHUB_FORBIDDEN"||error.code==="GITHUB_UNAUTHORIZED"?"CAPABILITY_DENIED":"CONFLICT";throw new FoundationServiceError(code,error.message,{providerCode:error.code,retryable:error.retryable});}throw error;}
function digest(value:string){return createHash("sha256").update(value).digest("hex");}
function signature(value:string){return createHmac("sha256",env.GITHUB_INSTALL_STATE_SIGNING_KEY!).update(value).digest("base64url");}

function parseState(state:string){
  if(!githubAppConfigured())throw new FoundationServiceError("CONFLICT","GitHub App is not configured.");
  const [encoded,supplied]=state.split(".");if(!encoded||!supplied)throw new FoundationServiceError("VALIDATION_FAILED","GitHub installation state is invalid.");
  const expected=Buffer.from(signature(encoded));const received=Buffer.from(supplied);
  if(expected.length!==received.length||!timingSafeEqual(expected,received))throw new FoundationServiceError("CAPABILITY_DENIED","GitHub installation state signature is invalid.");
  let payload:unknown;try{payload=JSON.parse(Buffer.from(encoded,"base64url").toString("utf8"));}catch{throw new FoundationServiceError("VALIDATION_FAILED","GitHub installation state payload is invalid.");}
  if(!payload||typeof payload!=="object")throw new FoundationServiceError("VALIDATION_FAILED","GitHub installation state payload is invalid.");
  const value=payload as Record<string,unknown>;
  if(value.v!==1||typeof value.id!=="string"||typeof value.workspaceId!=="string"||typeof value.principalId!=="string"||typeof value.exp!=="number"||typeof value.redirectPath!=="string")throw new FoundationServiceError("VALIDATION_FAILED","GitHub installation state payload is invalid.");
  if(value.exp*1000<=Date.now())throw new FoundationServiceError("CONFLICT","GitHub installation state expired.");
  return value as {v:1;id:string;workspaceId:string;principalId:string;exp:number;redirectPath:string};
}

export async function createGitHubInstallationStart(
  raw:{workspaceId:string;redirectPath?:string},context:MutationContext,pool:Pool=postgresPool(),
):Promise<MutationResult<{installationUrl:string;expiresAt:string}>>{
  if(!githubAppConfigured()||!env.GITHUB_APP_SLUG)throw new FoundationServiceError("CONFLICT","GitHub App is not configured.");
  const redirectPath=raw.redirectPath?.trim()||"/settings/integrations";
  if(!redirectPath.startsWith("/")||redirectPath.startsWith("//")||redirectPath.length>500)throw new FoundationServiceError("VALIDATION_FAILED","GitHub redirect path is invalid.");
  const operation="github.installation.start";const input={workspaceId:raw.workspaceId,redirectPath};const requestHash=requestDigest(input);
  return inTransaction(pool,async(client)=>{
    await establishTenantContext(client,input.workspaceId,context.actorPrincipalId);await lockIdempotencyKey(client,context.actorPrincipalId,operation,context.idempotencyKey);
    const replay=await findIdempotentResult<{installationUrl:string;expiresAt:string}>(client,{workspaceId:input.workspaceId,projectAgnostic:true,principalId:context.actorPrincipalId,operation,key:context.idempotencyKey,digest:requestHash});if(replay)return replay;
    await requireOwner(client,input.workspaceId,context.actorPrincipalId);
    const id=newFolioId();const expiresAt=new Date(Date.now()+15*60*1000);const encoded=Buffer.from(JSON.stringify({v:1,id,workspaceId:input.workspaceId,principalId:context.actorPrincipalId,exp:Math.floor(expiresAt.getTime()/1000),redirectPath})).toString("base64url");const state=`${encoded}.${signature(encoded)}`;
    await client.query(`INSERT INTO github_installation_states(id,workspace_id,principal_id,state_digest,redirect_path,expires_at) VALUES($1,$2,$3,$4,$5,$6)`,[id,input.workspaceId,context.actorPrincipalId,digest(state),redirectPath,expiresAt]);
    const installationUrl=new URL(`/apps/${env.GITHUB_APP_SLUG}/installations/new`,env.GITHUB_WEB_URL);installationUrl.searchParams.set("state",state);
    const data={installationUrl:installationUrl.toString(),expiresAt:expiresAt.toISOString()};
    return recordMutation(client,{workspaceId:input.workspaceId,context,operation,digest:requestHash,action:operation,targetType:"github_installation_state",targetId:id,aggregateType:"github_installation_state",aggregateRevision:1,eventType:"github.installation_started.v1",inputSummary:{redirectPath},resultSummary:{stateId:id,expiresAt:data.expiresAt},data});
  });
}

export async function completeGitHubInstallation(
  raw:{state:string;providerInstallationId:number},context:MutationContext,pool:Pool=postgresPool(),
):Promise<MutationResult<{installation:GitHubInstallation;redirectPath:string}>>{
  if(!Number.isSafeInteger(raw.providerInstallationId)||raw.providerInstallationId<1)throw new FoundationServiceError("VALIDATION_FAILED","GitHub installation ID is invalid.");
  const state=parseState(raw.state);if(state.principalId!==context.actorPrincipalId)throw new FoundationServiceError("CAPABILITY_DENIED","GitHub installation state belongs to another principal.");
  const operation="github.installation.complete";const input={workspaceId:state.workspaceId,stateId:state.id,providerInstallationId:raw.providerInstallationId};const requestHash=requestDigest(input);
  const prior=await pool.query<InstallationRow>(`SELECT ${installationColumns} FROM github_app_installations WHERE provider_installation_id=$1`,[raw.providerInstallationId]);
  if(prior.rows[0]&&prior.rows[0].workspace_id===state.workspaceId)return inTransaction(pool,async(client)=>{await establishTenantContext(client,state.workspaceId,context.actorPrincipalId);await requireOwner(client,state.workspaceId,context.actorPrincipalId);return recordMutation(client,{workspaceId:state.workspaceId,context,operation,digest:requestHash,action:operation,targetType:"github_installation",targetId:prior.rows[0]!.id,aggregateType:"github_installation",aggregateRevision:Number(prior.rows[0]!.revision),eventType:"github.installation_completed.v1",inputSummary:{replayedProviderInstallation:true},resultSummary:{installationId:prior.rows[0]!.id},data:{installation:mapInstallation(prior.rows[0]!),redirectPath:state.redirectPath}});});
  await inTransaction(pool,async(client)=>{await establishTenantContext(client,state.workspaceId,context.actorPrincipalId);await requireOwner(client,state.workspaceId,context.actorPrincipalId);const consumed=await client.query(`UPDATE github_installation_states SET consumed_at=now() WHERE id=$1 AND workspace_id=$2 AND principal_id=$3 AND state_digest=$4 AND consumed_at IS NULL AND expires_at>now() RETURNING id`,[state.id,state.workspaceId,context.actorPrincipalId,digest(raw.state)]);if(!consumed.rows[0])throw new FoundationServiceError("CONFLICT","GitHub installation state is expired, consumed, or invalid.");});
  let provider;try{provider=await getGitHubInstallation(raw.providerInstallationId);}catch(error){providerFailure(error);}
  return inTransaction(pool,async(client)=>{
    await establishTenantContext(client,state.workspaceId,context.actorPrincipalId);await lockIdempotencyKey(client,context.actorPrincipalId,operation,context.idempotencyKey);
    const replay=await findIdempotentResult<{installation:GitHubInstallation;redirectPath:string}>(client,{workspaceId:state.workspaceId,projectAgnostic:true,principalId:context.actorPrincipalId,operation,key:context.idempotencyKey,digest:requestHash});if(replay)return replay;
    const id=newFolioId();let result;
    try{result=await client.query<InstallationRow>(`INSERT INTO github_app_installations(id,workspace_id,provider_installation_id,account_id,account_login,account_type,repository_selection,permissions,events,credential_key_ref,state,created_by_principal_id,last_validated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
      ON CONFLICT(provider_installation_id) DO UPDATE SET account_id=excluded.account_id,account_login=excluded.account_login,account_type=excluded.account_type,repository_selection=excluded.repository_selection,permissions=excluded.permissions,events=excluded.events,state=excluded.state,last_validated_at=now(),revision=github_app_installations.revision+1,updated_at=now()
      WHERE github_app_installations.workspace_id=excluded.workspace_id RETURNING ${installationColumns}`,[id,state.workspaceId,raw.providerInstallationId,provider.data.account.id,provider.data.account.login,provider.data.account.type,provider.data.repository_selection,provider.data.permissions,provider.data.events,env.GITHUB_CREDENTIAL_KEY_REF,provider.data.suspended_at?"suspended":"active",context.actorPrincipalId]);}
    catch(error){if((error as {code?:string}).code==='23505')throw new FoundationServiceError("CONFLICT","GitHub installation is already linked to another workspace.");throw error;}
    if(!result.rows[0])throw new FoundationServiceError("CONFLICT","GitHub installation is already linked to another workspace.");
    const installation=mapInstallation(result.rows[0]);const data={installation,redirectPath:state.redirectPath};
    return recordMutation(client,{workspaceId:state.workspaceId,context,operation,digest:requestHash,action:operation,targetType:"github_installation",targetId:installation.id,aggregateType:"github_installation",aggregateRevision:installation.revision,eventType:"github.installation_completed.v1",inputSummary:{accountType:installation.accountType,repositorySelection:installation.repositorySelection},resultSummary:{installationId:installation.id,accountLogin:installation.accountLogin},data});
  });
}

export async function listGitHubInstallations(workspaceId:string,principalId:string,pool:Pool=postgresPool()):Promise<GitHubInstallation[]>{return inTransaction(pool,async(client)=>{await establishTenantContext(client,workspaceId,principalId);await requireOwner(client,workspaceId,principalId);const result=await client.query<InstallationRow>(`SELECT ${installationColumns} FROM github_app_installations WHERE workspace_id=$1 ORDER BY updated_at DESC,id`,[workspaceId]);return result.rows.map(mapInstallation);});}

async function observeRateLimit(pool:Pool,workspaceId:string,installationId:string,observation:GitHubRateLimit){await pool.query(`INSERT INTO github_rate_limit_observations(id,workspace_id,installation_id,resource,remaining,limit_value,reset_at,retry_after_seconds) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[newFolioId(),workspaceId,installationId,observation.resource,observation.remaining,observation.limit,observation.resetAt,observation.retryAfterSeconds]).catch(()=>undefined);}

export async function refreshGitHubRepositories(
  raw:{workspaceId:string;installationId:string},context:MutationContext,pool:Pool=postgresPool(),
):Promise<MutationResult<{repositories:GitHubRepository[];removedCount:number}>>{
  const operation="github.repositories.refresh";const requestHash=requestDigest(raw);
  const installation=await inTransaction(pool,async(client)=>{await establishTenantContext(client,raw.workspaceId,context.actorPrincipalId);await requireOwner(client,raw.workspaceId,context.actorPrincipalId);const result=await client.query<InstallationRow>(`SELECT ${installationColumns} FROM github_app_installations WHERE workspace_id=$1 AND id=$2 AND state<>'revoked'`,[raw.workspaceId,raw.installationId]);if(!result.rows[0])throw new FoundationServiceError("NOT_FOUND","GitHub installation was not found.");return result.rows[0];});
  let provider;try{provider=await listGitHubInstallationRepositories(Number(installation.provider_installation_id));}catch(error){providerFailure(error);}
  await observeRateLimit(pool,raw.workspaceId,raw.installationId,provider.rateLimit);
  return inTransaction(pool,async(client)=>{
    await establishTenantContext(client,raw.workspaceId,context.actorPrincipalId);await lockIdempotencyKey(client,context.actorPrincipalId,operation,context.idempotencyKey);
    const replay=await findIdempotentResult<{repositories:GitHubRepository[];removedCount:number}>(client,{workspaceId:raw.workspaceId,projectAgnostic:true,principalId:context.actorPrincipalId,operation,key:context.idempotencyKey,digest:requestHash});if(replay)return replay;
    const observedIds=provider.repositories.map((repository)=>repository.id);
    const rows:RepositoryRow[]=[];
    for(const repository of provider.repositories.slice(0,10000)){
      const owner=repository.owner.login;const name=repository.name;const result=await client.query<RepositoryRow>(`INSERT INTO github_repositories(id,workspace_id,installation_id,provider_repository_id,owner_login,name,full_name,default_branch,is_private,is_archived,permissions,state,provider_updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'available',$12)
        ON CONFLICT(installation_id,provider_repository_id) DO UPDATE SET owner_login=excluded.owner_login,name=excluded.name,full_name=excluded.full_name,default_branch=excluded.default_branch,is_private=excluded.is_private,is_archived=excluded.is_archived,permissions=excluded.permissions,state='available',provider_updated_at=excluded.provider_updated_at,revision=github_repositories.revision+1,updated_at=now()
        RETURNING ${repositoryColumns}`,[newFolioId(),raw.workspaceId,raw.installationId,repository.id,owner,name,repository.full_name,repository.default_branch,repository.private,repository.archived,repository.permissions??{},repository.updated_at??null]);rows.push(result.rows[0]!);
    }
    const removed=await client.query(`UPDATE github_repositories SET state='removed',revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND installation_id=$2 AND state='available' AND NOT(provider_repository_id=ANY($3::bigint[])) RETURNING id`,[raw.workspaceId,raw.installationId,observedIds]);
    await client.query(`UPDATE github_app_installations SET last_validated_at=now(),revision=revision+1,updated_at=now() WHERE id=$1`,[raw.installationId]);
    const data={repositories:rows.map(mapRepository),removedCount:removed.rowCount??0};
    return recordMutation(client,{workspaceId:raw.workspaceId,context,operation,digest:requestHash,action:operation,targetType:"github_installation",targetId:raw.installationId,aggregateType:"github_installation",aggregateRevision:Number(installation.revision)+1,eventType:"github.repositories_refreshed.v1",inputSummary:{providerRepositoryCount:provider.repositories.length},resultSummary:{availableCount:rows.length,removedCount:data.removedCount},data});
  });
}

export async function listGitHubRepositories(raw:{workspaceId:string;installationId?:string},principalId:string,pool:Pool=postgresPool()):Promise<GitHubRepository[]>{return inTransaction(pool,async(client)=>{await establishTenantContext(client,raw.workspaceId,principalId);await requireOwner(client,raw.workspaceId,principalId);const result=await client.query<RepositoryRow>(`SELECT ${repositoryColumns} FROM github_repositories WHERE workspace_id=$1 AND ($2::uuid IS NULL OR installation_id=$2) ORDER BY state,full_name`,[raw.workspaceId,raw.installationId??null]);return result.rows.map(mapRepository);});}

function payloadSummary(parsed:ParsedGitHubWebhook){const payload=parsed.payload as Record<string,unknown>;const repository=payload.repository&&typeof payload.repository==='object'?payload.repository as Record<string,unknown>:undefined;const pullRequest=payload.pull_request&&typeof payload.pull_request==='object'?payload.pull_request as Record<string,unknown>:undefined;return{event:parsed.event,action:parsed.action??null,providerInstallationId:parsed.installationId,repositoryId:typeof repository?.id==='number'?repository.id:null,repositoryFullName:typeof repository?.full_name==='string'?repository.full_name:null,ref:typeof payload.ref==='string'?payload.ref:null,before:typeof payload.before==='string'?payload.before:null,after:typeof payload.after==='string'?payload.after:null,pullRequestNumber:typeof pullRequest?.number==='number'?pullRequest.number:typeof payload.number==='number'?payload.number:null};}

export async function ingestGitHubWebhook(parsed:ParsedGitHubWebhook,pool:Pool=postgresPool()):Promise<{duplicate:boolean;queuedJobs:number;ignored:boolean}>{
  const installationResult=await pool.query<{id:string;workspace_id:string;state:string}>(`SELECT id,workspace_id,state FROM github_app_installations WHERE provider_installation_id=$1`,[parsed.installationId]);const installation=installationResult.rows[0];if(!installation)return{duplicate:false,queuedJobs:0,ignored:true};
  const summary=payloadSummary(parsed);const inserted=await pool.query(`INSERT INTO github_webhook_deliveries(delivery_id,workspace_id,installation_id,event_name,action,payload_summary,status) VALUES($1,$2,$3,$4,$5,$6,'received') ON CONFLICT(delivery_id) DO NOTHING RETURNING delivery_id`,[parsed.deliveryId,installation.workspace_id,installation.id,parsed.event,parsed.action??null,summary]);if(!inserted.rows[0])return{duplicate:true,queuedJobs:0,ignored:false};
  if(parsed.event==='installation'&&parsed.action){const state=parsed.action==='deleted'?"revoked":parsed.action==='suspend'?"suspended":parsed.action==='unsuspend'?"active":null;if(state)await pool.query(`UPDATE github_app_installations SET state=$2,revision=revision+1,updated_at=now() WHERE id=$1`,[installation.id,state]);}
  const jobIds:string[]=[];
  if(['installation','installation_repositories','repository'].includes(parsed.event))jobIds.push(await enqueueDurableJob({workspaceId:installation.workspace_id,kind:"github.repository.refresh",payload:{installationId:installation.id,deliveryId:parsed.deliveryId},deduplicationKey:`github-repositories:${installation.id}`},pool));
  if(parsed.event==='push'&&typeof summary.repositoryId==='number'&&typeof summary.ref==='string'&&summary.ref.startsWith('refs/heads/')){const branchName=summary.ref.slice('refs/heads/'.length);const branches=await pool.query<{id:string;project_id:string}>(`SELECT branch.id,branch.project_id FROM selected_git_branches branch JOIN project_repository_links link ON link.workspace_id=branch.workspace_id AND link.project_id=branch.project_id AND link.id=branch.repository_link_id JOIN github_repositories repository ON repository.workspace_id=link.workspace_id AND repository.id=link.repository_id WHERE repository.provider_repository_id=$1 AND branch.branch_name=$2 AND branch.state='enabled'`,[summary.repositoryId,branchName]);for(const branch of branches.rows)jobIds.push(await enqueueDurableJob({workspaceId:installation.workspace_id,projectId:branch.project_id,kind:"github.branch.reconcile",payload:{selectedBranchId:branch.id,deliveryId:parsed.deliveryId,headHint:summary.after},deduplicationKey:`github-reconcile:${branch.id}:${summary.after??'unknown'}`},pool));}
  await pool.query(`UPDATE github_webhook_deliveries SET status=$2,processed_at=CASE WHEN $2='ignored' THEN now() ELSE processed_at END WHERE delivery_id=$1`,[parsed.deliveryId,jobIds.length?'queued':'ignored']);return{duplicate:false,queuedJobs:jobIds.length,ignored:jobIds.length===0};
}
