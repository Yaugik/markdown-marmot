import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { listPageLinks, replacePageLinks } from "@/services/page-knowledge";
import { pageServiceError } from "../../response";

const scopeSchema = z.object({ workspace_id: z.string().uuid(), project_id: z.string().uuid() }).strict();
const replaceSchema = scopeSchema.extend({
  source_revision_id: z.string().uuid().nullable().optional(),
  links: z.array(z.object({
    target_page_id: z.string().uuid().nullable().optional(),
    external_url: z.string().trim().max(2048).nullable().optional(),
    label: z.string().trim().max(500).nullable().optional(),
    locator: z.record(z.unknown()).optional(),
  }).strict()).max(1000),
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
    const links = await listPageLinks({
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

export async function PUT(request: Request, { params }: RouteContext) {
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
    const input = replaceSchema.parse(await request.json());
    const result = await replacePageLinks({
      workspaceId: input.workspace_id,
      projectId: input.project_id,
      pageId: validatedPageId,
      sourceRevisionId: input.source_revision_id,
      links: input.links.map((link) => ({
        targetPageId: link.target_page_id,
        externalUrl: link.external_url,
        label: link.label,
        locator: link.locator,
      })),
    }, {
      actorPrincipalId: authenticated.session.principalId,
      requestId: context.requestId,
      traceId: context.traceId,
      idempotencyKey,
      source: "api",
    });
    return jsonSuccess({
      links: result.data,
      activity_id: result.activityId,
      outbox_event_id: result.outboxEventId,
      replayed: result.replayed,
    }, context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400, {
      fieldErrors: error.issues.map((issue) => ({ field: issue.path.join("."), code: issue.code, message: issue.message })),
    });
    if (error instanceof FoundationServiceError) return pageServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
