import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { listPrincipalMentions } from "@/services/page-collaboration";

const schema = z.object({
  workspace_id: z.string().uuid(),
  project_id: z.string().uuid(),
  state: z.enum(["unread", "read", "dismissed"]).optional(),
}).strict();
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  try {
    const url = new URL(request.url);
    const input = schema.parse({
      workspace_id: url.searchParams.get("workspace_id"),
      project_id: url.searchParams.get("project_id"),
      state: url.searchParams.get("state") ?? undefined,
    });
    const mentions = await listPrincipalMentions({
      workspaceId: input.workspace_id,
      projectId: input.project_id,
      state: input.state,
    }, authenticated.session.principalId);
    return jsonSuccess(mentions, context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400, {
      fieldErrors: error.issues.map((issue) => ({ field: issue.path.join("."), code: issue.code, message: issue.message })),
    });
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
