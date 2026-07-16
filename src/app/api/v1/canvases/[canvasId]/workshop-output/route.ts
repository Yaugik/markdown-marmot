import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { prepareWorkshopOutput } from "@/services/canvas-facilitation";
import { ecosystemServiceError } from "../../../ecosystem/response";

const schema = z.object({
  workspace_id: z.string().uuid(),
  project_id: z.string().uuid(),
  bounds: z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() }).strict(),
  title: z.string().trim().min(1).max(200).optional(),
}).strict();

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ canvasId: string }> }) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  try {
    const { canvasId } = await params;
    const input = schema.parse(await request.json());
    const data = await prepareWorkshopOutput({
      workspaceId: input.workspace_id,
      projectId: input.project_id,
      canvasId: z.string().uuid().parse(canvasId),
      bounds: input.bounds,
      title: input.title,
    }, authenticated.session.principalId);
    return jsonSuccess(data, context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400);
    if (error instanceof FoundationServiceError) return ecosystemServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
