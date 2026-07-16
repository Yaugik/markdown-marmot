import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { createIssue, listIssues } from "@/services/issues";
import { issueResponse, issueServiceError, mutationContext } from "./response";

const scopeSchema = z.object({ workspace_id: z.string().uuid(), project_id: z.string().uuid() }).strict();
const documentSchema = z.object({ type: z.literal("doc") }).passthrough();
const createSchema = scopeSchema.extend({
  title: z.string().trim().min(1).max(240),
  description: documentSchema.optional(),
  workflow_id: z.string().uuid().optional(),
  status_id: z.string().uuid().optional(),
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
const uuidCsv = z.string().transform((value) => value.split(",").map((item) => item.trim()).filter(Boolean)).pipe(z.array(z.string().uuid()).max(100));
const priorityCsv = z.string().transform((value) => value.split(",").map((item) => item.trim()).filter(Boolean)).pipe(z.array(z.enum(["no_priority", "urgent", "high", "medium", "low"])).max(5));
const listSchema = scopeSchema.extend({
  include_archived: z.enum(["true", "false"]).optional(),
  status_ids: uuidCsv.optional(),
  label_ids: uuidCsv.optional(),
  assignee_ids: uuidCsv.optional(),
  priorities: priorityCsv.optional(),
  milestone_id: z.string().uuid().optional(),
  cycle_id: z.string().uuid().optional(),
  parent_issue_id: z.string().uuid().optional(),
  q: z.string().trim().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
}).strict();
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  try {
    const url = new URL(request.url);
    const input = listSchema.parse({
      workspace_id: url.searchParams.get("workspace_id"),
      project_id: url.searchParams.get("project_id"),
      include_archived: url.searchParams.get("include_archived") ?? undefined,
      status_ids: url.searchParams.get("status_ids") ?? undefined,
      label_ids: url.searchParams.get("label_ids") ?? undefined,
      assignee_ids: url.searchParams.get("assignee_ids") ?? undefined,
      priorities: url.searchParams.get("priorities") ?? undefined,
      milestone_id: url.searchParams.get("milestone_id") ?? undefined,
      cycle_id: url.searchParams.get("cycle_id") ?? undefined,
      parent_issue_id: url.searchParams.get("parent_issue_id") ?? undefined,
      q: url.searchParams.get("q") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });
    const issues = await listIssues({
      workspaceId: input.workspace_id,
      projectId: input.project_id,
      includeArchived: input.include_archived === "true",
      statusIds: input.status_ids,
      labelIds: input.label_ids,
      assigneeIds: input.assignee_ids,
      priorities: input.priorities,
      milestoneId: input.milestone_id,
      cycleId: input.cycle_id,
      parentIssueId: input.parent_issue_id,
      query: input.q,
      limit: input.limit,
    }, authenticated.session.principalId);
    return jsonSuccess(issues.map(issueResponse), context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400, { fieldErrors: error.issues.map((issue) => ({ field: issue.path.join("."), code: issue.code, message: issue.message })) });
    if (error instanceof FoundationServiceError) return issueServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}

export async function POST(request: Request) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey) return jsonError("VALIDATION_FAILED", context, 400, { fieldErrors: [{ field: "Idempotency-Key", code: "required", message: "Required" }] });
  try {
    const input = createSchema.parse(await request.json());
    const result = await createIssue({
      workspaceId: input.workspace_id,
      projectId: input.project_id,
      title: input.title,
      description: input.description,
      workflowId: input.workflow_id,
      statusId: input.status_id,
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
    return jsonSuccess({ issue: issueResponse(result.data), activity_id: result.activityId, outbox_event_id: result.outboxEventId, replayed: result.replayed }, context, result.replayed ? 200 : 201);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400, { fieldErrors: error.issues.map((issue) => ({ field: issue.path.join("."), code: issue.code, message: issue.message })) });
    if (error instanceof FoundationServiceError) return issueServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
