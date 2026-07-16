import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { listNativePageRevisions } from "@/services/page-history";
import { pageServiceError } from "../../response";

type RouteContext = { params: Promise<{ pageId: string }> };
const scopeSchema = z.object({
  workspace_id: z.string().uuid(),
  project_id: z.string().uuid(),
  before_sequence: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict();

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
      before_sequence: url.searchParams.get("before_sequence") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });
    const revisions = await listNativePageRevisions({
      workspaceId: scope.workspace_id,
      projectId: scope.project_id,
      pageId: validatedPageId,
      beforeSequence: scope.before_sequence,
      limit: scope.limit,
    }, authenticated.session.principalId);
    return jsonSuccess(revisions.map((revision) => ({
      id: revision.id,
      page_id: revision.pageId,
      sequence: revision.sequence,
      editor_schema_version: revision.editorSchemaVersion,
      content_hash: revision.contentHash,
      author_principal_id: revision.authorPrincipalId,
      parent_revision_id: revision.parentRevisionId,
      created_at: revision.createdAt,
    })), context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400, {
      fieldErrors: error.issues.map((issue) => ({ field: issue.path.join("."), code: issue.code, message: issue.message })),
    });
    if (error instanceof FoundationServiceError) return pageServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
