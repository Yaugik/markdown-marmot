import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { listGitHubRepositories, refreshGitHubRepositories } from "@/services/github-installations";
import { githubApiError, githubMutationContext } from "../../../response";

const scope = z.object({ workspace_id: z.string().uuid() }).strict();
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ installationId: string }> }) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  try {
    const url = new URL(request.url);
    const input = scope.parse({ workspace_id: url.searchParams.get("workspace_id") });
    const { installationId } = await params;
    const repositories = await listGitHubRepositories({ workspaceId: input.workspace_id, installationId: z.string().uuid().parse(installationId) }, authenticated.session.principalId);
    return jsonSuccess(repositories, context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400);
    return githubApiError(error, context);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ installationId: string }> }) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey) return jsonError("VALIDATION_FAILED", context, 400);
  try {
    const input = scope.parse(await request.json());
    const { installationId } = await params;
    const result = await refreshGitHubRepositories({ workspaceId: input.workspace_id, installationId: z.string().uuid().parse(installationId) }, githubMutationContext(authenticated.session.principalId, context, idempotencyKey));
    return jsonSuccess({ refresh: result.data, activity_id: result.activityId, outbox_event_id: result.outboxEventId, replayed: result.replayed }, context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400);
    return githubApiError(error, context);
  }
}
