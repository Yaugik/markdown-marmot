import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { createProject, FoundationServiceError, listPermittedProjects } from "@/services/foundation";

const createProjectSchema = z.object({
  workspace_id: z.string().uuid(),
  project_key: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9]{1,9}$/),
  name: z.string().trim().min(1).max(160),
  time_zone: z.string().trim().min(1).max(100).optional(),
  default_git_write_policy: z.enum(["disabled", "pull_request_only", "direct_allowed"]).optional(),
}).strict();

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  const workspaceId = new URL(request.url).searchParams.get("workspace_id") ?? undefined;
  if (workspaceId && !z.string().uuid().safeParse(workspaceId).success) {
    return jsonError("VALIDATION_FAILED", context, 400, {
      fieldErrors: [{ field: "workspace_id", code: "invalid_format", message: "Expected UUID" }],
    });
  }
  const projects = await listPermittedProjects(authenticated.session.principalId, workspaceId);
  return jsonSuccess(projects.map((project) => ({
    id: project.id,
    workspace_id: project.workspaceId,
    project_key: project.projectKey,
    name: project.name,
    time_zone: project.timeZone,
    default_git_write_policy: project.defaultGitWritePolicy,
    revision: project.revision,
    role_template_key: project.roleTemplateKey,
    capabilities: project.capabilities,
  })), context);
}

export async function POST(request: Request) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey) return jsonError("VALIDATION_FAILED", context, 400, {
    fieldErrors: [{ field: "Idempotency-Key", code: "required", message: "Required" }],
  });
  try {
    const input = createProjectSchema.parse(await request.json());
    const result = await createProject({
      workspaceId: input.workspace_id,
      projectKey: input.project_key,
      name: input.name,
      timeZone: input.time_zone,
      defaultGitWritePolicy: input.default_git_write_policy,
    }, {
      actorPrincipalId: authenticated.session.principalId,
      requestId: context.requestId,
      traceId: context.traceId,
      idempotencyKey,
      source: "api",
    });
    return jsonSuccess({
      project: result.data,
      activity_id: result.activityId,
      outbox_event_id: result.outboxEventId,
      replayed: result.replayed,
    }, context, result.replayed ? 200 : 201);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400, {
      fieldErrors: error.issues.map((issue) => ({ field: issue.path.join("."), code: issue.code, message: issue.message })),
    });
    if (error instanceof FoundationServiceError) {
      const status = error.code === "NOT_FOUND" ? 404 : error.code === "CAPABILITY_DENIED" ? 403 : error.code === "CONFLICT" || error.code === "IDEMPOTENCY_CONFLICT" ? 409 : 400;
      return jsonError(error.code, context, status);
    }
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
