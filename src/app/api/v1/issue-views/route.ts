import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { createIssueSavedView, listIssueSavedViews } from "@/services/issue-views";
import { issueServiceError, mutationContext } from "../issues/response";

const scopeSchema = z.object({ workspace_id: z.string().uuid(), project_id: z.string().uuid() }).strict();
const filtersSchema = z.object({ includeArchived: z.boolean().optional(), statusIds: z.array(z.string().uuid()).optional(), labelIds: z.array(z.string().uuid()).optional(), assigneeIds: z.array(z.string().uuid()).optional(), priorities: z.array(z.enum(["no_priority", "urgent", "high", "medium", "low"])).optional(), milestoneId: z.string().uuid().nullable().optional(), cycleId: z.string().uuid().nullable().optional(), parentIssueId: z.string().uuid().nullable().optional(), query: z.string().max(500).optional() }).strict();
const groupingSchema = z.object({ field: z.enum(["status", "priority", "assignee", "label", "milestone", "cycle", "none"]).optional() }).strict();
const orderingSchema = z.array(z.object({ field: z.enum(["rank", "priority", "dueOn", "startOn", "createdAt", "updatedAt", "issueNumber", "title"]), direction: z.enum(["asc", "desc"]) }).strict()).max(5);
const createSchema = scopeSchema.extend({ name: z.string().trim().min(1).max(120), visibility: z.enum(["private", "project"]).optional(), projection: z.enum(["list", "board", "timeline", "calendar"]).optional(), filters: filtersSchema.optional(), grouping: groupingSchema.optional(), ordering: orderingSchema.optional() }).strict();
export const dynamic = "force-dynamic";
const responseView = (view: Awaited<ReturnType<typeof listIssueSavedViews>>[number]) => ({ id: view.id, workspace_id: view.workspaceId, project_id: view.projectId, owner_principal_id: view.ownerPrincipalId, name: view.name, visibility: view.visibility, projection: view.projection, filters: view.filters, grouping: view.grouping, ordering: view.ordering, revision: view.revision, created_at: view.createdAt, updated_at: view.updatedAt });

export async function GET(request: Request) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  try {
    const url = new URL(request.url);
    const scope = scopeSchema.parse({ workspace_id: url.searchParams.get("workspace_id"), project_id: url.searchParams.get("project_id") });
    const views = await listIssueSavedViews({ workspaceId: scope.workspace_id, projectId: scope.project_id }, authenticated.session.principalId);
    return jsonSuccess(views.map(responseView), context);
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
    const result = await createIssueSavedView({ workspaceId: input.workspace_id, projectId: input.project_id, name: input.name, visibility: input.visibility, projection: input.projection, filters: input.filters, grouping: input.grouping, ordering: input.ordering }, mutationContext(authenticated.session.principalId, context, idempotencyKey));
    return jsonSuccess({ view: responseView(result.data), activity_id: result.activityId, outbox_event_id: result.outboxEventId, replayed: result.replayed }, context, result.replayed ? 200 : 201);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400, { fieldErrors: error.issues.map((issue) => ({ field: issue.path.join("."), code: issue.code, message: issue.message })) });
    if (error instanceof FoundationServiceError) return issueServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
