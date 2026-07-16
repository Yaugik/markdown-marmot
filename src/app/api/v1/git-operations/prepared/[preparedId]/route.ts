import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { readPreparedGitOperation } from "@/services/github-write-previews";
import { githubApiError } from "../../../github/response";

const scope=z.object({workspace_id:z.string().uuid(),project_id:z.string().uuid()}).strict();
export const dynamic="force-dynamic";

export async function GET(request:Request,{params}:{params:Promise<{preparedId:string}>}){const context=requestContext(request);const authenticated=await authenticatedRequest(request,context);if(!authenticated.ok)return authenticated.response;try{const url=new URL(request.url);const input=scope.parse({workspace_id:url.searchParams.get("workspace_id"),project_id:url.searchParams.get("project_id")});const {preparedId}=await params;return jsonSuccess(await readPreparedGitOperation({workspaceId:input.workspace_id,projectId:input.project_id,preparedOperationId:z.string().uuid().parse(preparedId)},authenticated.session.principalId),context);}catch(error){if(error instanceof z.ZodError)return jsonError("VALIDATION_FAILED",context,400);return githubApiError(error,context);}}
