import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { executeIssueProjection } from "@/services/issue-views";
import { issueResponse, issueServiceError } from "../issues/response";

const filtersSchema = z.object({ includeArchived: z.boolean().optional(), statusIds: z.array(z.string().uuid()).optional(), labelIds: z.array(z.string().uuid()).optional(), assigneeIds: z.array(z.string().uuid()).optional(), priorities: z.array(z.enum(["no_priority", "urgent", "high", "medium", "low"])).optional(), milestoneId: z.string().uuid().nullable().optional(), cycleId: z.string().uuid().nullable().optional(), parentIssueId: z.string().uuid().nullable().optional(), query: z.string().max(500).optional() }).strict();
const schema = z.object({
  workspace_id: z.string().uuid(),
  project_id: z.string().uuid(),
  view_id: z.string().uuid().optional(),
  projection: z.enum(["list", "board", "timeline", "calendar"]).optional(),
  filters: filtersSchema.optional(),
  grouping: z.object({ field: z.enum(["status", "priority", "assignee", "label", "milestone", "cycle", "none"]).optional() }).strict().optional(),
  ordering: z.array(z.object({ field: z.enum(["rank", "priority", "dueOn", "startOn", "createdAt", "updatedAt", "issueNumber", "title"]), direction: z.enum(["asc", "desc"]) }).strict()).max(5).optional(),
}).strict();
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  try {
    const input = schema.parse(await request.json());
    const projection = await executeIssueProjection({ workspaceId: input.workspace_id, projectId: input.project_id, viewId: input.view_id, projection: input.projection, filters: input.filters, grouping: input.grouping, ordering: input.ordering }, authenticated.session.principalId);
    return jsonSuccess({ kind: projection.kind, view_id: projection.viewId, total: projection.total, issues: projection.issues.map(issueResponse), groups: projection.groups, timeline: projection.timeline.map((item) => ({ issue_id: item.issueId, start_on: item.startOn, due_on: item.dueOn })), calendar: projection.calendar }, context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400, { fieldErrors: error.issues.map((issue) => ({ field: issue.path.join("."), code: issue.code, message: issue.message })) });
    if (error instanceof FoundationServiceError) return issueServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
