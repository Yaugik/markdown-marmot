import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { createIssueWorkflow, listIssueWorkflows } from "@/services/issue-workflows";
import { issueServiceError, mutationContext } from "../issues/response";

const scopeSchema = z.object({ workspace_id: z.string().uuid(), project_id: z.string().uuid() }).strict();
const createSchema = scopeSchema.extend({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(4000).optional(),
  is_default: z.boolean().optional(),
  statuses: z.array(z.object({ key: z.string().trim().min(1).max(40), name: z.string().trim().min(1).max(80), category: z.enum(["backlog", "planned", "in_progress", "completed", "canceled"]), color_key: z.string().optional(), rank: z.number().int().nonnegative().optional(), is_initial: z.boolean().optional() }).strict()).min(2).max(30),
  transitions: z.array(z.object({ from_key: z.string(), to_key: z.string(), name: z.string().trim().min(1).max(120).optional(), requires_comment: z.boolean().optional() }).strict()).max(900).optional(),
}).strict();
export const dynamic = "force-dynamic";
const responseWorkflow = (workflow: Awaited<ReturnType<typeof listIssueWorkflows>>[number]) => ({
  id: workflow.id, workspace_id: workflow.workspaceId, project_id: workflow.projectId,
  name: workflow.name, description: workflow.description, is_default: workflow.isDefault,
  revision: workflow.revision,
  statuses: workflow.statuses.map((status) => ({ id: status.id, name: status.name, category: status.category, color_key: status.colorKey, rank: status.rank, is_initial: status.isInitial, revision: status.revision })),
  transitions: workflow.transitions.map((transition) => ({ id: transition.id, from_status_id: transition.fromStatusId, to_status_id: transition.toStatusId, name: transition.name, requires_comment: transition.requiresComment, revision: transition.revision })),
  created_at: workflow.createdAt, updated_at: workflow.updatedAt,
});

export async function GET(request: Request) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  try {
    const url = new URL(request.url);
    const scope = scopeSchema.parse({ workspace_id: url.searchParams.get("workspace_id"), project_id: url.searchParams.get("project_id") });
    const workflows = await listIssueWorkflows({ workspaceId: scope.workspace_id, projectId: scope.project_id }, authenticated.session.principalId);
    return jsonSuccess(workflows.map(responseWorkflow), context);
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
    const result = await createIssueWorkflow({ workspaceId: input.workspace_id, projectId: input.project_id, name: input.name, description: input.description, isDefault: input.is_default, statuses: input.statuses.map((status) => ({ key: status.key, name: status.name, category: status.category, colorKey: status.color_key, rank: status.rank, isInitial: status.is_initial })), transitions: input.transitions?.map((transition) => ({ fromKey: transition.from_key, toKey: transition.to_key, name: transition.name, requiresComment: transition.requires_comment })) }, mutationContext(authenticated.session.principalId, context, idempotencyKey));
    return jsonSuccess({ workflow: responseWorkflow(result.data), activity_id: result.activityId, outbox_event_id: result.outboxEventId, replayed: result.replayed }, context, result.replayed ? 200 : 201);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400, { fieldErrors: error.issues.map((issue) => ({ field: issue.path.join("."), code: issue.code, message: issue.message })) });
    if (error instanceof FoundationServiceError) return issueServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
