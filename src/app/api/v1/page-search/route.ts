import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { searchPages } from "@/services/page-knowledge";
import { pageServiceError } from "../pages/response";

const schema = z.object({
  workspace_id: z.string().uuid(),
  project_id: z.string().uuid(),
  q: z.string().trim().min(1).max(500),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  include_archived: z.enum(["true", "false"]).optional(),
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
      q: url.searchParams.get("q"),
      limit: url.searchParams.get("limit") ?? undefined,
      include_archived: url.searchParams.get("include_archived") ?? undefined,
    });
    const results = await searchPages({
      workspaceId: input.workspace_id,
      projectId: input.project_id,
      query: input.q,
      limit: input.limit,
      includeArchived: input.include_archived === "true",
    }, authenticated.session.principalId);
    return jsonSuccess(results, context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400, {
      fieldErrors: error.issues.map((issue) => ({ field: issue.path.join("."), code: issue.code, message: issue.message })),
    });
    if (error instanceof FoundationServiceError) return pageServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
