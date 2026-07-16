import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { executeMermaidImport } from "@/services/mermaid-interchange";
import { ecosystemMutationContext, ecosystemServiceError } from "../../../../ecosystem/response";

const schema=z.object({workspace_id:z.string().uuid(),project_id:z.string().uuid(),client_id:z.string().trim().min(1).max(180)}).strict();
export const dynamic="force-dynamic";
export async function POST(request:Request,{params}:{params:Promise<{previewId:string}>}){const context=requestContext(request);const authenticated=await authenticatedRequest(request,context);if(!authenticated.ok)return authenticated.response;const key=request.headers.get("idempotency-key")?.trim();if(!key)return jsonError("VALIDATION_FAILED",context,400);try{const {previewId}=await params;const input=schema.parse(await request.json());const result=await executeMermaidImport({workspaceId:input.workspace_id,projectId:input.project_id,previewId:z.string().uuid().parse(previewId),clientId:input.client_id},ecosystemMutationContext(authenticated.session.principalId,context,key));return jsonSuccess(result,context,201);}catch(error){if(error instanceof z.ZodError)return jsonError("VALIDATION_FAILED",context,400);if(error instanceof FoundationServiceError)return ecosystemServiceError(error,context);return jsonError("OPERATION_FAILED",context,500);}}
