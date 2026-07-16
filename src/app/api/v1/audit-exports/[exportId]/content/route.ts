import { z } from "zod";
import { authenticatedRequest, jsonError, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { readAuditExportContent } from "@/services/audit-exports";
import { ecosystemServiceError } from "../../../ecosystem/response";

export const dynamic="force-dynamic";
export async function GET(request:Request,{params}:{params:Promise<{exportId:string}>}){const context=requestContext(request);const authenticated=await authenticatedRequest(request,context);if(!authenticated.ok)return authenticated.response;try{const {exportId}=await params;const url=new URL(request.url);const workspaceId=z.string().uuid().parse(url.searchParams.get("workspace_id"));const result=await readAuditExportContent({workspaceId,exportId:z.string().uuid().parse(exportId)},authenticated.session.principalId);return new Response(result.content,{status:200,headers:{"content-type":result.export.format==="jsonl"?"application/x-ndjson":"text/csv; charset=utf-8","content-disposition":`attachment; filename="folio-audit-${result.export.id}.${result.export.format}"`,"cache-control":"no-store","x-content-type-options":"nosniff","content-length":String(result.content.byteLength)}});}catch(error){if(error instanceof z.ZodError)return jsonError("VALIDATION_FAILED",context,400);if(error instanceof FoundationServiceError)return ecosystemServiceError(error,context);return jsonError("OPERATION_FAILED",context,500);}}
