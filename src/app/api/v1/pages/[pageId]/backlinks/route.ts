import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { listPageBacklinks } from "@/services/page-knowledge";
import { pageServiceError } from "../../response";

const scopeSchema = z.object({ workspace_id: z.string().uuid(), project_id: z.string().uuid() }).strict();
type RouteContext = { params: Promise<{ pageId: string }> };
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: RouteContext) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  try {
    const { pageId } = await params;
    const validatedPageId = z.string().uuid().parse(pageId);
    const url = new URL(request.url);
    const scope = scopeSchema.parse({
      workspace_id: url.searchParams.get("workspace_id"),
      project_id: url.searchParams.get("project_id"),
    });
    const links = await listPageBacklinks({
      workspaceId: scope.workspace_id,
      projectId: scope.project_id,
      pageId: validatedPageId,
      includeStale: url.searchParams.get("include_stale") === "true",
    }, authenticated.session.principalId);
    return jsonSuccess(links, context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400, {
      fieldErrors: error.issues.map((issue) => ({ field: issue.path.join("."), code: issue.code, message: issue.message })),
    });
    if (error instanceof FoundationServiceError) return pageServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
