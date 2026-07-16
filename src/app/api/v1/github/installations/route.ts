import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { createGitHubInstallationStart, listGitHubInstallations } from "@/services/github-installations";
import { githubApiError, githubMutationContext } from "../response";

const startSchema = z.object({
  workspace_id: z.string().uuid(),
  redirect_path: z.string().trim().min(1).max(500).optional(),
}).strict();

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  try {
    const url = new URL(request.url);
    const workspaceId = z.string().uuid().parse(url.searchParams.get("workspace_id"));
    return jsonSuccess(await listGitHubInstallations(workspaceId, authenticated.session.principalId), context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400);
    return githubApiError(error, context);
  }
}

export async function POST(request: Request) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey) return jsonError("VALIDATION_FAILED", context, 400);
  try {
    const input = startSchema.parse(await request.json());
    const result = await createGitHubInstallationStart({
      workspaceId: input.workspace_id,
      redirectPath: input.redirect_path,
    }, githubMutationContext(authenticated.session.principalId, context, idempotencyKey));
    return jsonSuccess({ setup: result.data, activity_id: result.activityId, outbox_event_id: result.outboxEventId, replayed: result.replayed }, context, result.replayed ? 200 : 201);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400);
    return githubApiError(error, context);
  }
}
