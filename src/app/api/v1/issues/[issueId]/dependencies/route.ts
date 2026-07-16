import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { addIssueDependency, listIssueDependencies } from "@/services/issue-relations";
import { issueServiceError, mutationContext } from "../../response";

const scopeSchema = z.object({ workspace_id: z.string().uuid(), project_id: z.string().uuid() }).strict();
const createSchema = scopeSchema.extend({
  expected_revision: z.number().int().positive(),
  target_issue_id: z.string().uuid(),
  relation_kind: z.enum(["blocks", "relates", "duplicates"]),
}).strict();
type RouteContext = { params: Promise<{ issueId: string }> };
export const dynamic = "force-dynamic";
const responseDependency = (item: Awaited<ReturnType<typeof listIssueDependencies>>[number]) => ({ id: item.id, source_issue_id: item.sourceIssueId, target_issue_id: item.targetIssueId, relation_kind: item.relationKind, created_at: item.createdAt });

export async function GET(request: Request, { params }: RouteContext) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  try {
    const { issueId } = await params;
    const id = z.string().uuid().parse(issueId);
    const url = new URL(request.url);
    const scope = scopeSchema.parse({ workspace_id: url.searchParams.get("workspace_id"), project_id: url.searchParams.get("project_id") });
    const dependencies = await listIssueDependencies({ workspaceId: scope.workspace_id, projectId: scope.project_id, issueId: id }, authenticated.session.principalId);
    return jsonSuccess(dependencies.map(responseDependency), context);
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
    const result = await addIssueDependency({ workspaceId: input.workspace_id, projectId: input.project_id, sourceIssueId: id, targetIssueId: input.target_issue_id, relationKind: input.relation_kind, expectedSourceRevision: input.expected_revision }, mutationContext(authenticated.session.principalId, context, idempotencyKey));
    return jsonSuccess({ dependency: responseDependency(result.data), activity_id: result.activityId, outbox_event_id: result.outboxEventId, replayed: result.replayed }, context, result.replayed ? 200 : 201);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400, { fieldErrors: error.issues.map((issue) => ({ field: issue.path.join("."), code: issue.code, message: issue.message })) });
    if (error instanceof FoundationServiceError) return issueServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
