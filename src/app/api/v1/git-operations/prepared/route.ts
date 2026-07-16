import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { prepareGitWrite } from "@/services/github-write-previews";
import { githubApiError, githubMutationContext } from "../../github/response";

const fileOperation=z.discriminatedUnion("operation",[
  z.object({operation:z.literal("upsert"),path:z.string().min(1).max(1000),base_blob_oid:z.string().regex(/^[a-f0-9]{40,64}$/).nullable().optional(),content:z.string().max(2*1024*1024)}).strict(),
  z.object({operation:z.literal("delete"),path:z.string().min(1).max(1000),base_blob_oid:z.string().regex(/^[a-f0-9]{40,64}$/)}).strict(),
]);
const schema=z.object({workspace_id:z.string().uuid(),project_id:z.string().uuid(),selected_branch_id:z.string().uuid(),operation_kind:z.enum(["commit_and_pull_request","direct_update"]),base_head_oid:z.string().regex(/^[a-f0-9]{40,64}$/),target_branch:z.string().min(1).max(255),commit_message:z.string().trim().min(1).max(1000),pull_request_title:z.string().trim().min(1).max(240).optional(),pull_request_body:z.string().max(100000).optional(),file_operations:z.array(fileOperation).min(1).max(100)}).strict();
export const dynamic="force-dynamic";

export async function POST(request:Request){const context=requestContext(request);const authenticated=await authenticatedRequest(request,context);if(!authenticated.ok)return authenticated.response;const key=request.headers.get("idempotency-key")?.trim();if(!key)return jsonError("VALIDATION_FAILED",context,400);try{const input=schema.parse(await request.json());const result=await prepareGitWrite({workspaceId:input.workspace_id,projectId:input.project_id,selectedBranchId:input.selected_branch_id,operationKind:input.operation_kind,baseHeadOid:input.base_head_oid,targetBranch:input.target_branch,commitMessage:input.commit_message,pullRequestTitle:input.pull_request_title,pullRequestBody:input.pull_request_body,fileOperations:input.file_operations.map((operation)=>operation.operation==="upsert"?{operation:"upsert",path:operation.path,baseBlobOid:operation.base_blob_oid??null,content:operation.content}:{operation:"delete",path:operation.path,baseBlobOid:operation.base_blob_oid})},githubMutationContext(authenticated.session.principalId,context,key));return jsonSuccess({prepared_operation:result.data,activity_id:result.activityId,outbox_event_id:result.outboxEventId,replayed:result.replayed},context,result.replayed?200:201);}catch(error){if(error instanceof z.ZodError)return jsonError("VALIDATION_FAILED",context,400);return githubApiError(error,context);}}
