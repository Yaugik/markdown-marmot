import { createHash } from "node:crypto";
import { z } from "zod";
import { authenticatedRequest, jsonError, requestContext } from "@/api";
import { completeGitHubInstallation } from "@/services/github-installations";
import { githubApiError, githubMutationContext } from "../../response";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  try {
    const url = new URL(request.url);
    const state = z.string().min(40).max(4000).parse(url.searchParams.get("state"));
    const providerInstallationId = z.coerce.number().int().positive().parse(url.searchParams.get("installation_id"));
    const idempotencyKey = `github-install:${createHash("sha256").update(`${state}:${providerInstallationId}`).digest("hex")}`;
    const result = await completeGitHubInstallation({ state, providerInstallationId }, githubMutationContext(authenticated.session.principalId, context, idempotencyKey));
    const redirect = new URL(result.data.redirectPath, url.origin);
    redirect.searchParams.set("github_installation", "connected");
    redirect.searchParams.set("installation_id", result.data.installation.id);
    return Response.redirect(redirect, 303);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400);
    return githubApiError(error, context);
  }
}
