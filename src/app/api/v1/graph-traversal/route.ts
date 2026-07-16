import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { executeGraphTraversal } from "@/services/graph-explorer";
import { ecosystemServiceError } from "../ecosystem/response";

const entity=z.enum(["page","issue","todo","calendar_entry","canvas"]);
const schema=z.object({workspace_id:z.string().uuid(),project_id:z.string().uuid(),view_id:z.string().uuid().optional(),root_entities:z.array(z.object({type:entity,id:z.string().uuid()}).strict()).max(50).optional(),filters:z.record(z.unknown()).optional(),traversal:z.record(z.unknown()).optional()}).strict();
export const dynamic="force-dynamic";
export async function POST(request:Request){const context=requestContext(request);const authenticated=await authenticatedRequest(request,context);if(!authenticated.ok)return authenticated.response;try{const input=schema.parse(await request.json());const result=await executeGraphTraversal({workspaceId:input.workspace_id,projectId:input.project_id,viewId:input.view_id,rootEntities:input.root_entities,filters:input.filters,traversal:input.traversal},authenticated.session.principalId);return jsonSuccess(result,context);}catch(error){if(error instanceof z.ZodError)return jsonError("VALIDATION_FAILED",context,400);if(error instanceof FoundationServiceError)return ecosystemServiceError(error,context);return jsonError("OPERATION_FAILED",context,500);}}
