import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { readCanvasActionPreview } from "@/services/canvas-action-previews";
import { ecosystemServiceError } from "../../../ecosystem/response";

const scope = z.object({ workspace_id: z.string().uuid(), project_id: z.string().uuid() }).strict();
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ previewId: string }> }) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  try {
    const url = new URL(request.url);
    const input = scope.parse({ workspace_id: url.searchParams.get("workspace_id"), project_id: url.searchParams.get("project_id") });
    const { previewId } = await params;
    const data = await readCanvasActionPreview({
      workspaceId: input.workspace_id,
      projectId: input.project_id,
      previewId: z.string().uuid().parse(previewId),
    }, authenticated.session.principalId);
    return jsonSuccess(data, context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400);
    if (error instanceof FoundationServiceError) return ecosystemServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
