import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { readProjectPage } from "@/services/git-pages";
import { editNativePage } from "@/services/pages";
import { pageResponse, pageServiceError, projectPageResponse } from "../response";

const scopeSchema = z.object({ workspace_id: z.string().uuid(), project_id: z.string().uuid() }).strict();
const editSchema = scopeSchema.extend({
  expected_revision: z.number().int().positive(),
  title: z.string().trim().min(1).max(200).optional(),
  content: z.object({ type: z.literal("doc") }).passthrough(),
}).strict();
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
    const scope = scopeSchema.parse({ workspace_id: url.searchParams.get("workspace_id"), project_id: url.searchParams.get("project_id") });
    const page = await readProjectPage({ workspaceId: scope.workspace_id, projectId: scope.project_id, pageId: validatedPageId }, authenticated.session.principalId);
    return jsonSuccess(projectPageResponse(page), context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400, { fieldErrors: error.issues.map((issue) => ({ field: issue.path.join("."), code: issue.code, message: issue.message })) });
    if (error instanceof FoundationServiceError) return pageServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}

export async function PATCH(request: Request, { params }: RouteContext) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey) return jsonError("VALIDATION_FAILED", context, 400, { fieldErrors: [{ field: "Idempotency-Key", code: "required", message: "Required" }] });
  try {
    const { pageId } = await params;
    const validatedPageId = z.string().uuid().parse(pageId);
    const input = editSchema.parse(await request.json());
    const current = await readProjectPage({ workspaceId: input.workspace_id, projectId: input.project_id, pageId: validatedPageId }, authenticated.session.principalId);
    if (current.sourceType === "git") {
      throw new FoundationServiceError("CONFLICT", "Git-backed pages must be changed through a prepared Git operation.", {
        selectedBranchId: current.selectedBranchId,
        sourcePath: current.sourcePath,
        baseHeadOid: current.headOid,
        baseBlobOid: current.blobOid,
      });
    }
    const result = await editNativePage({ workspaceId: input.workspace_id, projectId: input.project_id, pageId: validatedPageId, expectedRevision: input.expected_revision, title: input.title, content: input.content }, { actorPrincipalId: authenticated.session.principalId, requestId: context.requestId, traceId: context.traceId, idempotencyKey, source: "api" });
    return jsonSuccess({ page: pageResponse(result.data), activity_id: result.activityId, outbox_event_id: result.outboxEventId, replayed: result.replayed }, context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400, { fieldErrors: error.issues.map((issue) => ({ field: issue.path.join("."), code: issue.code, message: issue.message })) });
    if (error instanceof FoundationServiceError) return pageServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
