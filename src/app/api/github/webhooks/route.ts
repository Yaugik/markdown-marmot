import { webhookPostgresPool } from "@/db/webhook-postgres";
import { env, githubAppConfigured } from "@/lib/env";
import { parseGitHubWebhookRequest } from "@/integrations/github/webhook";
import { ingestGitHubWebhook } from "@/services/github-installations";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!githubAppConfigured() || !env.GITHUB_WEBHOOK_SECRET) {
    return Response.json({ error: { code: "AUTH_NOT_CONFIGURED", message: "GitHub App webhook ingestion is not configured.", retryable: false } }, {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  }
  const rawBody = new Uint8Array(await request.arrayBuffer());
  const parsed = parseGitHubWebhookRequest({
    rawBody,
    headers: request.headers,
    secret: env.GITHUB_WEBHOOK_SECRET,
  });
  if (!parsed.ok) {
    return Response.json({
      error: {
        code: parsed.error.code,
        message: parsed.error.message,
        retryable: parsed.error.retryable,
        field_errors: parsed.error.fieldErrors,
      },
    }, { status: parsed.error.httpStatus, headers: { "cache-control": "no-store" } });
  }
  try {
    const result = await ingestGitHubWebhook(parsed.value, webhookPostgresPool());
    return Response.json({ accepted: true, duplicate: result.duplicate, queued_jobs: result.queuedJobs, ignored: result.ignored }, {
      status: result.duplicate ? 200 : 202,
      headers: { "cache-control": "no-store" },
    });
  } catch {
    return Response.json({ error: { code: "OPERATION_FAILED", message: "Webhook delivery could not be queued.", retryable: true } }, {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  }
}
