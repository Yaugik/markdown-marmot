import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { updateIssueSavedViewWithPolicy } from "@/services/issue-view-policy";
import { issueServiceError, mutationContext } from "../../issues/response";

const filtersSchema = z.object({
  includeArchived: z.boolean().optional(),
  statusIds: z.array(z.string().uuid()).optional(),
  labelIds: z.array(z.string().uuid()).optional(),
  assigneeIds: z.array(z.string().uuid()).optional(),
  priorities: z.array(z.enum(["no_priority", "urgent", "high", "medium", "low"])).optional(),
  milestoneId: z.string().uuid().nullable().optional(),
  cycleId: z.string().uuid().nullable().optional(),
  parentIssueId: z.string().uuid().nullable().optional(),
  query: z.string().max(500).optional(),
}).strict();
const groupingSchema = z.object({
  field: z.enum(["status", "priority", "assignee", "label", "milestone", "cycle", "none"]).optional(),
}).strict();
const orderingSchema = z.array(z.object({
  field: z.enum(["rank", "priority", "dueOn", "startOn", "createdAt", "updatedAt", "issueNumber", "title"]),
  direction: z.enum(["asc", "desc"]),
}).strict()).max(5);
const schema = z.object({
  workspace_id: z.string().uuid(),
  project_id: z.string().uuid(),
  expected_revision: z.number().int().positive(),
  name: z.string().trim().min(1).max(120).optional(),
  visibility: z.enum(["private", "project"]).optional(),
  projection: z.enum(["list", "board", "timeline", "calendar"]).optional(),
  filters: filtersSchema.optional(),
  grouping: groupingSchema.optional(),
  ordering: orderingSchema.optional(),
}).strict();
type RouteContext = { params: Promise<{ viewId: string }> };
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: RouteContext) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey) {
    return jsonError("VALIDATION_FAILED", context, 400, {
      fieldErrors: [{ field: "Idempotency-Key", code: "required", message: "Required" }],
    });
  }
  try {
    const { viewId } = await params;
    const id = z.string().uuid().parse(viewId);
    const input = schema.parse(await request.json());
    const result = await updateIssueSavedViewWithPolicy({
      workspaceId: input.workspace_id,
      projectId: input.project_id,
      viewId: id,
      expectedRevision: input.expected_revision,
      name: input.name,
      visibility: input.visibility,
      projection: input.projection,
      filters: input.filters,
      grouping: input.grouping,
      ordering: input.ordering,
    }, mutationContext(authenticated.session.principalId, context, idempotencyKey));
    return jsonSuccess({
      view: {
        id: result.data.id,
        workspace_id: result.data.workspaceId,
        project_id: result.data.projectId,
        owner_principal_id: result.data.ownerPrincipalId,
        name: result.data.name,
        visibility: result.data.visibility,
        projection: result.data.projection,
        filters: result.data.filters,
        grouping: result.data.grouping,
        ordering: result.data.ordering,
        revision: result.data.revision,
        created_at: result.data.createdAt,
        updated_at: result.data.updatedAt,
      },
      activity_id: result.activityId,
      outbox_event_id: result.outboxEventId,
      replayed: result.replayed,
    }, context);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return jsonError("VALIDATION_FAILED", context, 400, {
        fieldErrors: error.issues.map((issue) => ({
          field: issue.path.join("."), code: issue.code, message: issue.message,
        })),
      });
    }
    if (error instanceof FoundationServiceError) return issueServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
