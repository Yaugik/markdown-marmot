import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { readNativePageRevision } from "@/services/page-history";
import { pageServiceError } from "../../../response";

type RouteContext = { params: Promise<{ pageId: string; revisionId: string }> };
const scopeSchema = z.object({
  workspace_id: z.string().uuid(),
  project_id: z.string().uuid(),
}).strict();

export async function GET(request: Request, { params }: RouteContext) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;

  try {
    const params = await params;
    const pageId = z.string().uuid().parse(params.pageId);
    const revisionId = z.string().uuid().parse(params.revisionId);
    const url = new URL(request.url);
    const scope = scopeSchema.parse({
      workspace_id: url.searchParams.get("workspace_id"),
      project_id: url.searchParams.get("project_id"),
    });
    const revision = await readNativePageRevision({
      workspaceId: scope.workspace_id,
      projectId: scope.project_id,
      pageId,
      revisionId,
    }, authenticated.session.principalId);
    return jsonSuccess({
      id: revision.id,
      page_id: revision.pageId,
      sequence: revision.sequence,
      editor_schema_version: revision.editorSchemaVersion,
      content: revision.content,
      plain_text: revision.plainText,
      content_hash: revision.contentHash,
      author_principal_id: revision.authorPrincipalId,
      parent_revision_id: revision.parentRevisionId,
      created_at: revision.createdAt,
    }, context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400, {
      fieldErrors: error.issues.map((issue) => ({ field: issue.path.join("."), code: issue.code, message: issue.message })),
    });
    if (error instanceof FoundationServiceError) return pageServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
