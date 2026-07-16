import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { executeClusteredGraph } from "@/services/graph-clustering";
import { ecosystemServiceError } from "../ecosystem/response";

const entityType = z.enum(["page","issue","todo","calendar_entry","canvas"]);
const schema = z.object({
  workspace_id: z.string().uuid(),
  project_id: z.string().uuid(),
  view_id: z.string().uuid().optional(),
  root_entities: z.array(z.object({ type: entityType, id: z.string().uuid() }).strict()).min(1).max(50).optional(),
  filters: z.record(z.unknown()).optional(),
  traversal: z.record(z.unknown()).optional(),
  mode: z.enum(["connected_components","entity_type"]).optional(),
}).strict().refine((value) => Boolean(value.view_id) !== Boolean(value.root_entities), {
  message: "Provide exactly one graph view or root entity set.",
});

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  try {
    const input = schema.parse(await request.json());
    const data = await executeClusteredGraph({
      workspaceId: input.workspace_id,
      projectId: input.project_id,
      viewId: input.view_id,
      rootEntities: input.root_entities,
      filters: input.filters,
      traversal: input.traversal,
      mode: input.mode,
    }, authenticated.session.principalId);
    return jsonSuccess(data, context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400);
    if (error instanceof FoundationServiceError) return ecosystemServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
