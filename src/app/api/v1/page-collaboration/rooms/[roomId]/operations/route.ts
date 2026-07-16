import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { submitPageCollaborationOperation } from "@/services/page-realtime-collaboration";
import { ecosystemMutationContext, ecosystemServiceError, mutationEnvelope } from "../../../../ecosystem/response";

const schema=z.object({workspace_id:z.string().uuid(),project_id:z.string().uuid(),client_id:z.string().trim().min(1).max(180),client_sequence:z.number().int().positive(),base_sequence:z.number().int().nonnegative(),content:z.record(z.unknown())}).strict();
export const dynamic="force-dynamic";
export async function POST(request:Request,{params}:{params:Promise<{roomId:string}>}){const context=requestContext(request);const authenticated=await authenticatedRequest(request,context);if(!authenticated.ok)return authenticated.response;const key=request.headers.get("idempotency-key")?.trim();if(!key)return jsonError("VALIDATION_FAILED",context,400);try{const {roomId}=await params;const input=schema.parse(await request.json());const result=await submitPageCollaborationOperation({workspaceId:input.workspace_id,projectId:input.project_id,roomId:z.string().uuid().parse(roomId),clientId:input.client_id,clientSequence:input.client_sequence,baseSequence:input.base_sequence,content:input.content},ecosystemMutationContext(authenticated.session.principalId,context,key));return jsonSuccess(mutationEnvelope("operation",result),context,result.replayed?200:201);}catch(error){if(error instanceof z.ZodError)return jsonError("VALIDATION_FAILED",context,400);if(error instanceof FoundationServiceError)return ecosystemServiceError(error,context);return jsonError("OPERATION_FAILED",context,500);}}
