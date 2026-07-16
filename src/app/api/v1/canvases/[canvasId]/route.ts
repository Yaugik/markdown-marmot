import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { readCanvas } from "@/services/canvas-scenes";
import { ecosystemServiceError } from "../../ecosystem/response";

export const dynamic="force-dynamic";
export async function GET(request:Request,{params}:{params:Promise<{canvasId:string}>}){const context=requestContext(request);const authenticated=await authenticatedRequest(request,context);if(!authenticated.ok)return authenticated.response;try{const {canvasId}=await params;const url=new URL(request.url);const workspaceId=z.string().uuid().parse(url.searchParams.get("workspace_id"));const projectId=z.string().uuid().parse(url.searchParams.get("project_id"));return jsonSuccess(await readCanvas({workspaceId,projectId,canvasId:z.string().uuid().parse(canvasId)},authenticated.session.principalId),context);}catch(error){if(error instanceof z.ZodError)return jsonError("VALIDATION_FAILED",context,400);if(error instanceof FoundationServiceError)return ecosystemServiceError(error,context);return jsonError("OPERATION_FAILED",context,500);}}
