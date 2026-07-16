import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { createPageCommentThread, listPageCommentThreads } from "@/services/page-collaboration";
import { pageServiceError } from "../../response";

const scopeSchema = z.object({
  workspace_id: z.string().uuid(),
  project_id: z.string().uuid(),
}).strict();
const createSchema = scopeSchema.extend({
  page_revision_id: z.string().uuid().nullable().optional(),
  anchor: z.record(z.unknown()).optional(),
  body: z.record(z.unknown()),
  mentioned_principal_ids: z.array(z.string().uuid()).max(50).optional(),
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
    const scope = scopeSchema.parse({
      workspace_id: url.searchParams.get("workspace_id"),
      project_id: url.searchParams.get("project_id"),
    });
    const threads = await listPageCommentThreads({
      workspaceId: scope.workspace_id,
      projectId: scope.project_id,
      pageId: validatedPageId,
      includeResolved: url.searchParams.get("include_resolved") === "true",
    }, authenticated.session.principalId);
    return jsonSuccess(threads, context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400, {
      fieldErrors: error.issues.map((issue) => ({ field: issue.path.join("."), code: issue.code, message: issue.message })),
    });
    if (error instanceof FoundationServiceError) return pageServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}

export async function POST(request: Request, { params }: RouteContext) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey) return jsonError("VALIDATION_FAILED", context, 400, {
    fieldErrors: [{ field: "Idempotency-Key", code: "required", message: "Required" }],
  });
  try {
    const { pageId } = await params;
    const validatedPageId = z.string().uuid().parse(pageId);
    const input = createSchema.parse(await request.json());
    const result = await createPageCommentThread({
      workspaceId: input.workspace_id,
      projectId: input.project_id,
      pageId: validatedPageId,
      pageRevisionId: input.page_revision_id,
      anchor: input.anchor,
      body: input.body,
      mentionedPrincipalIds: input.mentioned_principal_ids,
    }, {
      actorPrincipalId: authenticated.session.principalId,
      requestId: context.requestId,
      traceId: context.traceId,
      idempotencyKey,
      source: "api",
    });
    return jsonSuccess({
      thread: result.data,
      activity_id: result.activityId,
      outbox_event_id: result.outboxEventId,
      replayed: result.replayed,
    }, context, result.replayed ? 200 : 201);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400, {
      fieldErrors: error.issues.map((issue) => ({ field: issue.path.join("."), code: issue.code, message: issue.message })),
    });
    if (error instanceof FoundationServiceError) return pageServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
