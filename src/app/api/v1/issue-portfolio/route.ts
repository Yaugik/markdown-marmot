import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { createCycle, createIssueLabel, createMilestone, createRoadmap, listIssuePortfolio } from "@/services/issue-portfolio";
import { issueServiceError, mutationContext } from "../issues/response";

const scopeSchema = z.object({ workspace_id: z.string().uuid(), project_id: z.string().uuid() }).strict();
const createSchema = z.discriminatedUnion("kind", [
  scopeSchema.extend({ kind: z.literal("label"), name: z.string().trim().min(1).max(80), description: z.string().max(1000).optional(), color_key: z.string().optional() }).strict(),
  scopeSchema.extend({ kind: z.literal("milestone"), name: z.string().trim().min(1).max(120), description: z.string().max(4000).optional(), target_on: z.string().date().nullable().optional(), state: z.enum(["planned", "active", "completed", "canceled"]).optional() }).strict(),
  scopeSchema.extend({ kind: z.literal("cycle"), name: z.string().trim().min(1).max(120), starts_on: z.string().date(), ends_on: z.string().date(), state: z.enum(["planned", "active", "completed", "canceled"]).optional() }).strict(),
  scopeSchema.extend({ kind: z.literal("roadmap"), name: z.string().trim().min(1).max(120), description: z.string().max(4000).optional(), visibility: z.enum(["project", "private"]).optional() }).strict(),
]);
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  try {
    const url = new URL(request.url);
    const scope = scopeSchema.parse({ workspace_id: url.searchParams.get("workspace_id"), project_id: url.searchParams.get("project_id") });
    const portfolio = await listIssuePortfolio({ workspaceId: scope.workspace_id, projectId: scope.project_id }, authenticated.session.principalId);
    return jsonSuccess({
      labels: portfolio.labels.map((item) => ({ id: item.id, name: item.name, description: item.description, color_key: item.colorKey, revision: item.revision, created_at: item.createdAt, updated_at: item.updatedAt })),
      milestones: portfolio.milestones.map((item) => ({ id: item.id, name: item.name, description: item.description, target_on: item.targetOn, state: item.state, revision: item.revision, created_at: item.createdAt, updated_at: item.updatedAt })),
      cycles: portfolio.cycles.map((item) => ({ id: item.id, name: item.name, starts_on: item.startsOn, ends_on: item.endsOn, state: item.state, revision: item.revision, created_at: item.createdAt, updated_at: item.updatedAt })),
      roadmaps: portfolio.roadmaps.map((item) => ({ id: item.id, name: item.name, description: item.description, visibility: item.visibility, owner_principal_id: item.ownerPrincipalId, revision: item.revision, items: item.items.map((roadmapItem) => ({ issue_id: roadmapItem.issueId, rank: roadmapItem.rank, starts_on: roadmapItem.startsOn, ends_on: roadmapItem.endsOn, created_at: roadmapItem.createdAt })), created_at: item.createdAt, updated_at: item.updatedAt })),
    }, context);
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
    const mutation = mutationContext(authenticated.session.principalId, context, idempotencyKey);
    const result = input.kind === "label"
      ? await createIssueLabel({ workspaceId: input.workspace_id, projectId: input.project_id, name: input.name, description: input.description, colorKey: input.color_key }, mutation)
      : input.kind === "milestone"
        ? await createMilestone({ workspaceId: input.workspace_id, projectId: input.project_id, name: input.name, description: input.description, targetOn: input.target_on, state: input.state }, mutation)
        : input.kind === "cycle"
          ? await createCycle({ workspaceId: input.workspace_id, projectId: input.project_id, name: input.name, startsOn: input.starts_on, endsOn: input.ends_on, state: input.state }, mutation)
          : await createRoadmap({ workspaceId: input.workspace_id, projectId: input.project_id, name: input.name, description: input.description, visibility: input.visibility }, mutation);
    return jsonSuccess({ kind: input.kind, resource: result.data, activity_id: result.activityId, outbox_event_id: result.outboxEventId, replayed: result.replayed }, context, result.replayed ? 200 : 201);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400, { fieldErrors: error.issues.map((issue) => ({ field: issue.path.join("."), code: issue.code, message: issue.message })) });
    if (error instanceof FoundationServiceError) return issueServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
