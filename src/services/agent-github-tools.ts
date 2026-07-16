import type { Pool } from "pg";
import { postgresPool } from "@/db/postgres";
import { FoundationServiceError } from "@/services/foundation/errors";
import type { MutationContext } from "@/services/foundation/types";
import {
  authorizeAgentEntityRead,
  authorizeAgentProjectCapability,
  type AgentActorChain,
} from "@/services/agent-spatial-access";
import { readGitPage } from "@/services/git-pages";
import {
  listProjectRepositoryLinks,
  requestGitBranchReconciliation,
} from "@/services/github-repositories";
import {
  enqueuePreparedGitOperation,
  prepareGitWrite,
  readPreparedGitOperation,
} from "@/services/github-write-previews";

export type AgentGitToolRequest =
  | { tool:"list_repository_links" }
  | { tool:"read_git_page";pageId:string }
  | { tool:"request_reconciliation";selectedBranchId:string }
  | {
      tool:"prepare_markdown_write";
      selectedBranchId:string;
      operationKind:"commit_and_pull_request"|"direct_update";
      baseHeadOid:string;
      targetBranch:string;
      commitMessage:string;
      pullRequestTitle?:string;
      pullRequestBody?:string;
      fileOperations:Array<
        | {operation:"upsert";path:string;baseBlobOid:string|null;content:string}
        | {operation:"delete";path:string;baseBlobOid:string}
      >;
    }
  | { tool:"read_prepared_write";preparedOperationId:string }
  | { tool:"execute_prepared_write";preparedOperationId:string;expectedRevision:number };

export type AgentGitToolResult={
  tool:AgentGitToolRequest["tool"];
  riskLevel:"R0"|"R1"|"R2";
  data:unknown;
  permissions:{actor:string;authorizer:string;intersectionApplied:true};
  warnings:string[];
  suggestedNextActions:string[];
};

function chain(scope:{workspaceId:string;projectId:string},context:MutationContext):AgentActorChain{
  if(!context.authorizingPrincipalId||context.authorizingPrincipalId===context.actorPrincipalId){
    throw new FoundationServiceError("CAPABILITY_DENIED","Agent Git tools require a distinct human authorizer.");
  }
  return{...scope,agentPrincipalId:context.actorPrincipalId,authorizingPrincipalId:context.authorizingPrincipalId};
}
function result(request:AgentGitToolRequest,actorChain:AgentActorChain,data:unknown,riskLevel:AgentGitToolResult["riskLevel"],suggestedNextActions:string[]=[],warnings:string[]=[]):AgentGitToolResult{return{tool:request.tool,riskLevel,data,permissions:{actor:actorChain.agentPrincipalId,authorizer:actorChain.authorizingPrincipalId,intersectionApplied:true},warnings,suggestedNextActions};}
async function authorizeRead(actorChain:AgentActorChain,pool:Pool){await authorizeAgentProjectCapability({...actorChain,capability:"repository.read"},pool);}
async function authorizePrepare(actorChain:AgentActorChain,request:Extract<AgentGitToolRequest,{tool:"prepare_markdown_write"}>,pool:Pool){await authorizeAgentProjectCapability({...actorChain,capability:"repository.markdown.prepare"},pool);await authorizeAgentProjectCapability({...actorChain,capability:"repository.markdown.commit"},pool);if(request.operationKind==="commit_and_pull_request"){await authorizeAgentProjectCapability({...actorChain,capability:"repository.branch.create"},pool);await authorizeAgentProjectCapability({...actorChain,capability:"repository.pull_request.open"},pool);}}

export async function executeAgentGitTool(
  scope:{workspaceId:string;projectId:string},
  request:AgentGitToolRequest,
  context:MutationContext,
  pool:Pool=postgresPool(),
):Promise<AgentGitToolResult>{
  const actorChain=chain(scope,context);
  if(request.tool==="list_repository_links"){
    await authorizeRead(actorChain,pool);
    const [agent,authorizer]=await Promise.all([
      listProjectRepositoryLinks(scope,actorChain.agentPrincipalId,pool),
      listProjectRepositoryLinks(scope,actorChain.authorizingPrincipalId,pool),
    ]);
    const permitted=new Set(authorizer.map((link)=>link.id));
    return result(request,actorChain,agent.filter((link)=>permitted.has(link.id)),"R0",["read_git_page","request_reconciliation","prepare_markdown_write"]);
  }
  if(request.tool==="read_git_page"){
    await authorizeAgentEntityRead({...actorChain,entityType:"page",entityId:request.pageId},pool);
    const [agent,authorizer]=await Promise.all([
      readGitPage({...scope,pageId:request.pageId},actorChain.agentPrincipalId,pool),
      readGitPage({...scope,pageId:request.pageId},actorChain.authorizingPrincipalId,pool),
    ]);
    if(agent.id!==authorizer.id||agent.blobOid!==authorizer.blobOid)throw new FoundationServiceError("CONFLICT","Agent and authorizer page views are inconsistent.");
    return result(request,actorChain,agent,"R0",["prepare_markdown_write"]);
  }
  if(request.tool==="request_reconciliation"){
    await authorizeAgentProjectCapability({...actorChain,capability:"repository.reconcile"},pool);
    const queued=await requestGitBranchReconciliation({...scope,selectedBranchId:request.selectedBranchId},context,pool);
    return result(request,actorChain,queued,"R1",["list_repository_links","read_git_page"]);
  }
  if(request.tool==="prepare_markdown_write"){
    await authorizePrepare(actorChain,request,pool);
    const prepared=await prepareGitWrite({
      ...scope,
      selectedBranchId:request.selectedBranchId,
      operationKind:request.operationKind,
      baseHeadOid:request.baseHeadOid,
      targetBranch:request.targetBranch,
      commitMessage:request.commitMessage,
      pullRequestTitle:request.pullRequestTitle,
      pullRequestBody:request.pullRequestBody,
      fileOperations:request.fileOperations,
    },context,pool);
    return result(request,actorChain,prepared,prepared.data.riskLevel==="R2"?"R2":"R1",
      [prepared.data.confirmationId?"human_approve_confirmation":"execute_prepared_write"],
      prepared.data.riskLevel==="R2"?["A human confirmation is required before execution."]:[]);
  }
  if(request.tool==="read_prepared_write"){
    await authorizeRead(actorChain,pool);
    const [agent,authorizer]=await Promise.all([
      readPreparedGitOperation({...scope,preparedOperationId:request.preparedOperationId},actorChain.agentPrincipalId,pool),
      readPreparedGitOperation({...scope,preparedOperationId:request.preparedOperationId},actorChain.authorizingPrincipalId,pool),
    ]);
    if(agent.id!==authorizer.id||agent.actionDigest!==authorizer.actionDigest)throw new FoundationServiceError("CONFLICT","Agent and authorizer prepared-write views are inconsistent.");
    return result(request,actorChain,agent,"R0",[agent.confirmationId?"human_approve_confirmation":"execute_prepared_write"]);
  }
  await authorizeAgentProjectCapability({...actorChain,capability:"repository.markdown.commit"},pool);
  const prepared=await readPreparedGitOperation({...scope,preparedOperationId:request.preparedOperationId},actorChain.agentPrincipalId,pool);
  if(prepared.authorizingPrincipalId!==actorChain.authorizingPrincipalId||prepared.actorPrincipalId!==actorChain.agentPrincipalId){
    throw new FoundationServiceError("CAPABILITY_DENIED","Prepared Git operation belongs to a different actor chain.");
  }
  const queued=await enqueuePreparedGitOperation({...scope,preparedOperationId:request.preparedOperationId,expectedRevision:request.expectedRevision},context,pool);
  return result(request,actorChain,queued,prepared.riskLevel==="R2"?"R2":"R1",["read_prepared_write","read_git_page"]);
}
