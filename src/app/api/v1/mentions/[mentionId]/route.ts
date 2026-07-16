import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { updateMentionState } from "@/services/page-collaboration";
import { pageServiceError } from "../../pages/response";

const schema = z.object({
  workspace_id: z.string().uuid(),
  project_id: z.string().uuid(),
  state: z.enum(["read", "dismissed"]),
}).strict();
type RouteContext = { params: Promise<{ mentionId: string }> };
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: RouteContext) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  try {
    const { mentionId } = await params;
    const validatedMentionId = z.string().uuid().parse(mentionId);
    const input = schema.parse(await request.json());
    const mention = await updateMentionState({
      workspaceId: input.workspace_id,
      projectId: input.project_id,
      mentionId: validatedMentionId,
      state: input.state,
    }, authenticated.session.principalId);
    return jsonSuccess(mention, context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400, {
      fieldErrors: error.issues.map((issue) => ({ field: issue.path.join("."), code: issue.code, message: issue.message })),
    });
    if (error instanceof FoundationServiceError) return pageServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
