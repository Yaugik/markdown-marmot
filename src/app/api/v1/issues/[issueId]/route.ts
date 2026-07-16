import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { readIssue, updateIssue } from "@/services/issues";
import { issueResponse, issueServiceError, mutationContext } from "../response";

const scopeSchema = z.object({ workspace_id: z.string().uuid(), project_id: z.string().uuid() }).strict();
const patchSchema = scopeSchema.extend({
  expected_revision: z.number().int().positive(),
  title: z.string().trim().min(1).max(240).optional(),
  description: z.object({ type: z.literal("doc") }).passthrough().optional(),
  parent_issue_id: z.string().uuid().nullable().optional(),
  milestone_id: z.string().uuid().nullable().optional(),
  cycle_id: z.string().uuid().nullable().optional(),
  priority: z.enum(["no_priority", "urgent", "high", "medium", "low"]).optional(),
  estimate_points: z.number().nonnegative().nullable().optional(),
  start_on: z.string().date().nullable().optional(),
  due_on: z.string().date().nullable().optional(),
  rank: z.number().int().nonnegative().optional(),
  assignee_ids: z.array(z.string().uuid()).max(100).optional(),
  label_ids: z.array(z.string().uuid()).max(100).optional(),
}).strict();
type RouteContext = { params: Promise<{ issueId: string }> };
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: RouteContext) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  try {
    const { issueId } = await params;
    const id = z.string().uuid().parse(issueId);
    const url = new URL(request.url);
    const scope = scopeSchema.parse({ workspace_id: url.searchParams.get("workspace_id"), project_id: url.searchParams.get("project_id") });
    const issue = await readIssue({ workspaceId: scope.workspace_id, projectId: scope.project_id, issueId: id }, authenticated.session.principalId);
    return jsonSuccess(issueResponse(issue), context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400, { fieldErrors: error.issues.map((issue) => ({ field: issue.path.join("."), code: issue.code, message: issue.message })) });
    if (error instanceof FoundationServiceError) return issueServiceError(error, context);
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
    const { issueId } = await params;
    const id = z.string().uuid().parse(issueId);
    const input = patchSchema.parse(await request.json());
    const result = await updateIssue({
      workspaceId: input.workspace_id,
      projectId: input.project_id,
      issueId: id,
      expectedRevision: input.expected_revision,
      title: input.title,
      description: input.description,
      parentIssueId: input.parent_issue_id,
      milestoneId: input.milestone_id,
      cycleId: input.cycle_id,
      priority: input.priority,
      estimatePoints: input.estimate_points,
      startOn: input.start_on,
      dueOn: input.due_on,
      rank: input.rank,
      assigneeIds: input.assignee_ids,
      labelIds: input.label_ids,
    }, mutationContext(authenticated.session.principalId, context, idempotencyKey));
    return jsonSuccess({ issue: issueResponse(result.data), activity_id: result.activityId, outbox_event_id: result.outboxEventId, replayed: result.replayed }, context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400, { fieldErrors: error.issues.map((issue) => ({ field: issue.path.join("."), code: issue.code, message: issue.message })) });
    if (error instanceof FoundationServiceError) return issueServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
