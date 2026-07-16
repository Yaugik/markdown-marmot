import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { applyCanvasCommand } from "@/services/canvas-scenes";
import { ecosystemMutationContext, ecosystemServiceError, mutationEnvelope } from "../../../ecosystem/response";

const kind=z.enum(["entity_card","sticky","text","shape","frame","connector","drawing","comment","vote","presentation_region","mermaid"]);
const entity=z.enum(["page","issue","todo","calendar_entry","canvas"]);
const command=z.discriminatedUnion("type",[
  z.object({type:z.literal("canvas.rename"),title:z.string()}).strict(),
  z.object({type:z.literal("element.create"),element:z.object({id:z.string().uuid().optional(),kind,entityType:entity.nullable().optional(),entityId:z.string().uuid().nullable().optional(),geometry:z.record(z.unknown()).optional(),content:z.record(z.unknown()).optional(),zIndex:z.number().int().optional()}).strict()}).strict(),
  z.object({type:z.literal("element.update"),elementId:z.string().uuid(),expectedElementRevision:z.number().int().positive(),geometry:z.record(z.unknown()).optional(),content:z.record(z.unknown()).optional(),zIndex:z.number().int().optional()}).strict(),
  z.object({type:z.literal("element.archive"),elementId:z.string().uuid(),expectedElementRevision:z.number().int().positive()}).strict(),
]);
const schema=z.object({workspace_id:z.string().uuid(),project_id:z.string().uuid(),expected_revision:z.number().int().positive(),client_id:z.string().trim().min(1).max(180),client_sequence:z.number().int().positive(),command}).strict();
export const dynamic="force-dynamic";
export async function POST(request:Request,{params}:{params:Promise<{canvasId:string}>}){const context=requestContext(request);const authenticated=await authenticatedRequest(request,context);if(!authenticated.ok)return authenticated.response;const key=request.headers.get("idempotency-key")?.trim();if(!key)return jsonError("VALIDATION_FAILED",context,400);try{const {canvasId}=await params;const input=schema.parse(await request.json());const result=await applyCanvasCommand({workspaceId:input.workspace_id,projectId:input.project_id,canvasId:z.string().uuid().parse(canvasId),expectedRevision:input.expected_revision,clientId:input.client_id,clientSequence:input.client_sequence,command:input.command},ecosystemMutationContext(authenticated.session.principalId,context,key));return jsonSuccess(mutationEnvelope("canvas",result),context,result.replayed?200:201);}catch(error){if(error instanceof z.ZodError)return jsonError("VALIDATION_FAILED",context,400);if(error instanceof FoundationServiceError)return ecosystemServiceError(error,context);return jsonError("OPERATION_FAILED",context,500);}}
