import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { executeAgentSpatialTool } from "@/services/agent-spatial-tools";
import { ecosystemServiceError } from "../../ecosystem/response";

const entityType = z.enum(["page","issue","todo","calendar_entry","canvas"]);
const entityRef = z.object({ type: entityType, id: z.string().uuid() }).strict();
const bounds = z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() }).strict();
const pageTarget = z.object({ entityType: z.literal("page"), title: z.string().trim().min(1).max(200).optional(), parentNodeId: z.string().uuid().nullable().optional() }).strict();
const issueTarget = z.object({ entityType: z.literal("issue"), title: z.string().trim().min(1).max(240).optional(), priority: z.enum(["no_priority","urgent","high","medium","low"]).optional() }).strict();
const todoTarget = z.object({ entityType: z.literal("todo"), listId: z.string().uuid(), title: z.string().trim().min(1).max(240).optional(), startsAt: z.string().datetime().nullable().optional(), dueAt: z.string().datetime().nullable().optional(), timeZone: z.string().trim().min(1).max(120).optional() }).strict();
const tool = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("expand_graph"), roots: z.array(entityRef).min(1).max(50), mode: z.enum(["connected_components","entity_type"]).optional(), depth: z.number().int().min(0).max(5).optional(), nodeLimit: z.number().int().positive().max(1000).optional(), edgeLimit: z.number().int().positive().max(2000).optional() }).strict(),
  z.object({ tool: z.literal("read_canvas_region"), canvasId: z.string().uuid(), bounds, maxElements: z.number().int().positive().max(500).optional() }).strict(),
  z.object({ tool: z.literal("create_canvas"), title: z.string().trim().min(1).max(200), visibility: z.enum(["private","project"]).optional() }).strict(),
  z.object({ tool: z.literal("add_entity_to_canvas"), canvasId: z.string().uuid(), entity: entityRef, geometry: z.record(z.unknown()).optional(), content: z.record(z.unknown()).optional() }).strict(),
  z.object({ tool: z.literal("create_sticky"), canvasId: z.string().uuid(), text: z.string().trim().min(1).max(10000), geometry: z.record(z.unknown()).optional(), category: z.string().trim().min(1).max(80).optional() }).strict(),
  z.object({ tool: z.literal("connect_canvas_nodes"), canvasId: z.string().uuid(), fromElementId: z.string().uuid(), toElementId: z.string().uuid(), label: z.string().trim().min(1).max(240).optional() }).strict(),
  z.object({ tool: z.literal("organize_canvas_region"), canvasId: z.string().uuid(), elementIds: z.array(z.string().uuid()).min(1).max(100), mode: z.enum(["grid","horizontal","vertical"]), gap: z.number().nonnegative().max(500).optional(), columns: z.number().int().positive().max(20).optional() }).strict(),
  z.object({ tool: z.literal("promote_connector_to_relationship"), canvasId: z.string().uuid(), connectorElementId: z.string().uuid(), relationshipTypeId: z.string().uuid() }).strict(),
  z.object({ tool: z.literal("convert_sticky"), canvasId: z.string().uuid(), stickyElementId: z.string().uuid(), target: z.discriminatedUnion("entityType", [pageTarget,issueTarget,todoTarget]), addEntityCard: z.boolean().optional() }).strict(),
  z.object({ tool: z.literal("execute_canvas_action"), previewId: z.string().uuid() }).strict(),
  z.object({ tool: z.literal("prepare_workshop_output"), canvasId: z.string().uuid(), bounds, title: z.string().trim().min(1).max(200).optional() }).strict(),
]);
const schema = z.object({
  workspace_id: z.string().uuid(),
  project_id: z.string().uuid(),
  agent_principal_id: z.string().uuid(),
  request: tool,
}).strict();
const mutations = new Set([
  "create_canvas","add_entity_to_canvas","create_sticky","connect_canvas_nodes",
  "organize_canvas_region","promote_connector_to_relationship","convert_sticky","execute_canvas_action",
]);

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  try {
    const input = schema.parse(await request.json());
    const suppliedKey = request.headers.get("idempotency-key")?.trim();
    if (mutations.has(input.request.tool) && !suppliedKey) return jsonError("VALIDATION_FAILED", context, 400);
    const data = await executeAgentSpatialTool({
      workspaceId: input.workspace_id,
      projectId: input.project_id,
    }, input.request, {
      actorPrincipalId: input.agent_principal_id,
      authorizingPrincipalId: authenticated.session.principalId,
      requestId: context.requestId,
      traceId: context.traceId,
      idempotencyKey: suppliedKey || `spatial-read-${context.requestId}`,
      source: "agent",
    });
    return jsonSuccess(data, context, mutations.has(input.request.tool) ? 201 : 200);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400);
    if (error instanceof FoundationServiceError) return ecosystemServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
