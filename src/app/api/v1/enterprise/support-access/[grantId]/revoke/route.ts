import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { revokeSupportAccessGrant } from "@/services/enterprise-controls";
import { ecosystemMutationContext, ecosystemServiceError, mutationEnvelope } from "../../../../ecosystem/response";

const schema=z.object({workspace_id:z.string().uuid(),expected_revision:z.number().int().positive()}).strict();
export const dynamic="force-dynamic";
export async function POST(request:Request,{params}:{params:Promise<{grantId:string}>}){const context=requestContext(request);const authenticated=await authenticatedRequest(request,context);if(!authenticated.ok)return authenticated.response;const key=request.headers.get("idempotency-key")?.trim();if(!key)return jsonError("VALIDATION_FAILED",context,400);try{const {grantId}=await params;const input=schema.parse(await request.json());const result=await revokeSupportAccessGrant({workspaceId:input.workspace_id,grantId:z.string().uuid().parse(grantId),expectedRevision:input.expected_revision},ecosystemMutationContext(authenticated.session.principalId,context,key));return jsonSuccess(mutationEnvelope("support_access",result),context,result.replayed?200:201);}catch(error){if(error instanceof z.ZodError)return jsonError("VALIDATION_FAILED",context,400);if(error instanceof FoundationServiceError)return ecosystemServiceError(error,context);return jsonError("OPERATION_FAILED",context,500);}}
