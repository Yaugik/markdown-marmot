import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { addSelectedGitBranch } from "@/services/github-repositories";
import { githubApiError, githubMutationContext } from "../../../github/response";

const schema=z.object({workspace_id:z.string().uuid(),project_id:z.string().uuid(),branch_name:z.string().trim().min(1).max(255)}).strict();
export const dynamic="force-dynamic";

export async function POST(request:Request,{params}:{params:Promise<{linkId:string}>}){const context=requestContext(request);const authenticated=await authenticatedRequest(request,context);if(!authenticated.ok)return authenticated.response;const key=request.headers.get("idempotency-key")?.trim();if(!key)return jsonError("VALIDATION_FAILED",context,400);try{const input=schema.parse(await request.json());const {linkId}=await params;const result=await addSelectedGitBranch({workspaceId:input.workspace_id,projectId:input.project_id,linkId:z.string().uuid().parse(linkId),branchName:input.branch_name},githubMutationContext(authenticated.session.principalId,context,key));return jsonSuccess({selected_branch:result.data,activity_id:result.activityId,outbox_event_id:result.outboxEventId,replayed:result.replayed},context,result.replayed?200:201);}catch(error){if(error instanceof z.ZodError)return jsonError("VALIDATION_FAILED",context,400);return githubApiError(error,context);}}
