import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { readOperationalReadiness } from "@/services/operational-readiness";
import { workspaceAdminError } from "../workspace-admin/response";

export const dynamic="force-dynamic";
export async function GET(request:Request){const context=requestContext(request);const authenticated=await authenticatedRequest(request,context);if(!authenticated.ok)return authenticated.response;try{const url=new URL(request.url);const workspaceId=z.string().uuid().parse(url.searchParams.get("workspace_id"));return jsonSuccess(await readOperationalReadiness(workspaceId,authenticated.session.principalId),context);}catch(error){if(error instanceof z.ZodError)return jsonError("VALIDATION_FAILED",context,400);return workspaceAdminError(error,context);}}
