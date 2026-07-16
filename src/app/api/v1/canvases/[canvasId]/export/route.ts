import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { exportCanvasAccessible } from "@/services/canvas-accessible-export";
import { ecosystemServiceError } from "../../../ecosystem/response";

const bounds = z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() }).strict();
const schema = z.object({
  workspace_id: z.string().uuid(),
  project_id: z.string().uuid(),
  format: z.enum(["markdown","json"]),
  bounds: bounds.optional(),
}).strict();

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ canvasId: string }> }) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  try {
    const { canvasId } = await params;
    const input = schema.parse(await request.json());
    const data = await exportCanvasAccessible({
      workspaceId: input.workspace_id,
      projectId: input.project_id,
      canvasId: z.string().uuid().parse(canvasId),
      format: input.format,
      bounds: input.bounds,
    }, authenticated.session.principalId);
    return jsonSuccess(data, context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400);
    if (error instanceof FoundationServiceError) return ecosystemServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
