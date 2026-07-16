import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { previewMermaidExport, previewMermaidImport } from "@/services/mermaid-interchange";
import { ecosystemServiceError } from "../../ecosystem/response";

const schema=z.discriminatedUnion("direction",[
  z.object({direction:z.literal("import"),workspace_id:z.string().uuid(),project_id:z.string().uuid(),canvas_id:z.string().uuid(),source_text:z.string().max(204800)}).strict(),
  z.object({direction:z.literal("export"),workspace_id:z.string().uuid(),project_id:z.string().uuid(),canvas_id:z.string().uuid()}).strict(),
]);
export const dynamic="force-dynamic";
export async function POST(request:Request){const context=requestContext(request);const authenticated=await authenticatedRequest(request,context);if(!authenticated.ok)return authenticated.response;try{const input=schema.parse(await request.json());const result=input.direction==="import"?await previewMermaidImport({workspaceId:input.workspace_id,projectId:input.project_id,canvasId:input.canvas_id,sourceText:input.source_text},authenticated.session.principalId):await previewMermaidExport({workspaceId:input.workspace_id,projectId:input.project_id,canvasId:input.canvas_id},authenticated.session.principalId);return jsonSuccess(result,context,201);}catch(error){if(error instanceof z.ZodError)return jsonError("VALIDATION_FAILED",context,400);if(error instanceof FoundationServiceError)return ecosystemServiceError(error,context);return jsonError("OPERATION_FAILED",context,500);}}
