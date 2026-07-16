import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { addIssueLink, listIssueLinks } from "@/services/issue-relations";
import { issueServiceError, mutationContext } from "../../response";

const scopeSchema = z.object({ workspace_id: z.string().uuid(), project_id: z.string().uuid() }).strict();
const createSchema = scopeSchema.extend({
  expected_revision: z.number().int().positive(),
  link_kind: z.enum(["issue", "page", "external"]),
  target_issue_id: z.string().uuid().optional(),
  target_page_id: z.string().uuid().optional(),
  external_url: z.string().url().max(2048).optional(),
  label: z.string().trim().min(1).max(240).optional(),
}).strict();
type RouteContext = { params: Promise<{ issueId: string }> };
export const dynamic = "force-dynamic";
const responseLink = (item: Awaited<ReturnType<typeof listIssueLinks>>[number]) => ({ id: item.id, issue_id: item.issueId, link_kind: item.linkKind, target_issue_id: item.targetIssueId, target_page_id: item.targetPageId, external_url: item.externalUrl, label: item.label, created_at: item.createdAt });

export async function GET(request: Request, { params }: RouteContext) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  try {
    const { issueId } = await params;
    const id = z.string().uuid().parse(issueId);
    const url = new URL(request.url);
    const scope = scopeSchema.parse({ workspace_id: url.searchParams.get("workspace_id"), project_id: url.searchParams.get("project_id") });
    const links = await listIssueLinks({ workspaceId: scope.workspace_id, projectId: scope.project_id, issueId: id }, authenticated.session.principalId);
    return jsonSuccess(links.map(responseLink), context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400, { fieldErrors: error.issues.map((issue) => ({ field: issue.path.join("."), code: issue.code, message: issue.message })) });
    if (error instanceof FoundationServiceError) return issueServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}

export async function POST(request: Request, { params }: RouteContext) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey) return jsonError("VALIDATION_FAILED", context, 400, { fieldErrors: [{ field: "Idempotency-Key", code: "required", message: "Required" }] });
  try {
    const { issueId } = await params;
    const id = z.string().uuid().parse(issueId);
    const input = createSchema.parse(await request.json());
    const result = await addIssueLink({ workspaceId: input.workspace_id, projectId: input.project_id, issueId: id, expectedRevision: input.expected_revision, linkKind: input.link_kind, targetIssueId: input.target_issue_id, targetPageId: input.target_page_id, externalUrl: input.external_url, label: input.label }, mutationContext(authenticated.session.principalId, context, idempotencyKey));
    return jsonSuccess({ link: responseLink(result.data), activity_id: result.activityId, outbox_event_id: result.outboxEventId, replayed: result.replayed }, context, result.replayed ? 200 : 201);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400, { fieldErrors: error.issues.map((issue) => ({ field: issue.path.join("."), code: issue.code, message: issue.message })) });
    if (error instanceof FoundationServiceError) return issueServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
