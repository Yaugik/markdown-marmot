import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import {
  prepareConnectorPromotion,
  prepareRegionOrganization,
  prepareStickyConversion,
} from "@/services/canvas-action-previews";
import { ecosystemMutationContext, ecosystemServiceError, mutationEnvelope } from "../../ecosystem/response";

const scope = z.object({
  workspace_id: z.string().uuid(),
  project_id: z.string().uuid(),
  canvas_id: z.string().uuid(),
}).strict();

const pageTarget = z.object({
  entity_type: z.literal("page"),
  title: z.string().trim().min(1).max(200).optional(),
  parent_node_id: z.string().uuid().nullable().optional(),
}).strict();
const issueTarget = z.object({
  entity_type: z.literal("issue"),
  title: z.string().trim().min(1).max(240).optional(),
  priority: z.enum(["no_priority","urgent","high","medium","low"]).optional(),
}).strict();
const todoTarget = z.object({
  entity_type: z.literal("todo"),
  list_id: z.string().uuid(),
  title: z.string().trim().min(1).max(240).optional(),
  starts_at: z.string().datetime().nullable().optional(),
  due_at: z.string().datetime().nullable().optional(),
  time_zone: z.string().trim().min(1).max(120).optional(),
}).strict();

const schema = scope.extend({
  action: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("promote_connector"),
      connector_element_id: z.string().uuid(),
      relationship_type_id: z.string().uuid(),
    }).strict(),
    z.object({
      kind: z.literal("convert_sticky"),
      sticky_element_id: z.string().uuid(),
      target: z.discriminatedUnion("entity_type", [pageTarget,issueTarget,todoTarget]),
      add_entity_card: z.boolean().optional(),
    }).strict(),
    z.object({
      kind: z.literal("organize_region"),
      element_ids: z.array(z.string().uuid()).min(1).max(100),
      mode: z.enum(["grid","horizontal","vertical"]),
      gap: z.number().nonnegative().max(500).optional(),
      columns: z.number().int().positive().max(20).optional(),
    }).strict(),
  ]),
}).strict();

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key) return jsonError("VALIDATION_FAILED", context, 400);
  try {
    const input = schema.parse(await request.json());
    const mutation = ecosystemMutationContext(authenticated.session.principalId, context, key);
    const action = input.action;
    const result = action.kind === "promote_connector"
      ? await prepareConnectorPromotion({
        workspaceId: input.workspace_id,
        projectId: input.project_id,
        canvasId: input.canvas_id,
        connectorElementId: action.connector_element_id,
        relationshipTypeId: action.relationship_type_id,
      }, mutation)
      : action.kind === "convert_sticky"
        ? await prepareStickyConversion({
          workspaceId: input.workspace_id,
          projectId: input.project_id,
          canvasId: input.canvas_id,
          stickyElementId: action.sticky_element_id,
          target: action.target.entity_type === "page" ? {
            entityType: "page",
            title: action.target.title,
            parentNodeId: action.target.parent_node_id,
          } : action.target.entity_type === "issue" ? {
            entityType: "issue",
            title: action.target.title,
            priority: action.target.priority,
          } : {
            entityType: "todo",
            listId: action.target.list_id,
            title: action.target.title,
            startsAt: action.target.starts_at,
            dueAt: action.target.due_at,
            timeZone: action.target.time_zone,
          },
          addEntityCard: action.add_entity_card,
        }, mutation)
        : await prepareRegionOrganization({
          workspaceId: input.workspace_id,
          projectId: input.project_id,
          canvasId: input.canvas_id,
          elementIds: action.element_ids,
          mode: action.mode,
          gap: action.gap,
          columns: action.columns,
        }, mutation);
    return jsonSuccess(mutationEnvelope("preview", result), context, result.replayed ? 200 : 201);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400);
    if (error instanceof FoundationServiceError) return ecosystemServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
