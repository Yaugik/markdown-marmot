import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { commitPageCollaborationRoomRecoverably } from "@/services/page-realtime-collaboration-policy";
import { ecosystemMutationContext, ecosystemServiceError, mutationEnvelope } from "../../../../ecosystem/response";

const schema=z.object({workspace_id:z.string().uuid(),project_id:z.string().uuid()}).strict();
export const dynamic="force-dynamic";
export async function POST(request:Request,{params}:{params:Promise<{roomId:string}>}){const context=requestContext(request);const authenticated=await authenticatedRequest(request,context);if(!authenticated.ok)return authenticated.response;const key=request.headers.get("idempotency-key")?.trim();if(!key)return jsonError("VALIDATION_FAILED",context,400);try{const {roomId}=await params;const input=schema.parse(await request.json());const result=await commitPageCollaborationRoomRecoverably({workspaceId:input.workspace_id,projectId:input.project_id,roomId:z.string().uuid().parse(roomId)},ecosystemMutationContext(authenticated.session.principalId,context,key));return jsonSuccess(mutationEnvelope("collaboration",result),context,result.replayed?200:201);}catch(error){if(error instanceof z.ZodError)return jsonError("VALIDATION_FAILED",context,400);if(error instanceof FoundationServiceError)return ecosystemServiceError(error,context);return jsonError("OPERATION_FAILED",context,500);}}
