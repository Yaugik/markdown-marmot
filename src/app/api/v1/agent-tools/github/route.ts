import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { executeAgentGitTool } from "@/services/agent-github-tools";
import { FoundationServiceError } from "@/services/foundation";
import { githubApiError } from "../../github/response";

const oid=z.string().regex(/^[a-f0-9]{40,64}$/);
const fileOperation=z.discriminatedUnion("operation",[
  z.object({operation:z.literal("upsert"),path:z.string().min(1).max(1000),baseBlobOid:oid.nullable(),content:z.string().max(2*1024*1024)}).strict(),
  z.object({operation:z.literal("delete"),path:z.string().min(1).max(1000),baseBlobOid:oid}).strict(),
]);
const tool=z.discriminatedUnion("tool",[
  z.object({tool:z.literal("list_repository_links")}).strict(),
  z.object({tool:z.literal("read_git_page"),pageId:z.string().uuid()}).strict(),
  z.object({tool:z.literal("request_reconciliation"),selectedBranchId:z.string().uuid()}).strict(),
  z.object({tool:z.literal("prepare_markdown_write"),selectedBranchId:z.string().uuid(),operationKind:z.enum(["commit_and_pull_request","direct_update"]),baseHeadOid:oid,targetBranch:z.string().min(1).max(255),commitMessage:z.string().trim().min(1).max(1000),pullRequestTitle:z.string().trim().min(1).max(240).optional(),pullRequestBody:z.string().max(100000).optional(),fileOperations:z.array(fileOperation).min(1).max(100)}).strict(),
  z.object({tool:z.literal("read_prepared_write"),preparedOperationId:z.string().uuid()}).strict(),
  z.object({tool:z.literal("execute_prepared_write"),preparedOperationId:z.string().uuid(),expectedRevision:z.number().int().positive()}).strict(),
]);
const schema=z.object({workspace_id:z.string().uuid(),project_id:z.string().uuid(),agent_principal_id:z.string().uuid(),request:tool}).strict();
const mutations=new Set(["request_reconciliation","prepare_markdown_write","execute_prepared_write"]);
export const dynamic="force-dynamic";

export async function POST(request:Request){
  const context=requestContext(request);
  const authenticated=await authenticatedRequest(request,context);
  if(!authenticated.ok)return authenticated.response;
  const key=request.headers.get("idempotency-key")?.trim();
  try{
    const input=schema.parse(await request.json());
    if(mutations.has(input.request.tool)&&!key)return jsonError("VALIDATION_FAILED",context,400);
    const data=await executeAgentGitTool({workspaceId:input.workspace_id,projectId:input.project_id},input.request,{
      actorPrincipalId:input.agent_principal_id,
      authorizingPrincipalId:authenticated.session.principalId,
      requestId:context.requestId,
      traceId:context.traceId,
      idempotencyKey:key||`agent-git-read-${context.requestId}`,
      source:"agent",
    });
    return jsonSuccess(data,context,mutations.has(input.request.tool)?201:200);
  }catch(error){
    if(error instanceof z.ZodError)return jsonError("VALIDATION_FAILED",context,400);
    if(error instanceof FoundationServiceError)return githubApiError(error,context);
    return jsonError("OPERATION_FAILED",context,500);
  }
}
