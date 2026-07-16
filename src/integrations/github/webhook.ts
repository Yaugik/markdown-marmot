import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const supportedGitHubWebhookEvents = [
  "push",
  "repository",
  "installation",
  "installation_repositories",
  "pull_request",
  "branch_protection_rule",
] as const;

export type SupportedGitHubWebhookEvent =
  (typeof supportedGitHubWebhookEvents)[number];

export type GitHubWebhookHeaderSource =
  | { get(name: string): string | null }
  | Readonly<Record<string, string | readonly string[] | undefined>>;

export type GitHubWebhookFieldError = {
  field: string;
  code: string;
  message: string;
};

export type GitHubWebhookErrorCode =
  | "GITHUB_WEBHOOK_CONFIGURATION_INVALID"
  | "GITHUB_WEBHOOK_SIGNATURE_MISSING"
  | "GITHUB_WEBHOOK_SIGNATURE_INVALID"
  | "GITHUB_WEBHOOK_METADATA_INVALID"
  | "GITHUB_WEBHOOK_EVENT_UNSUPPORTED"
  | "GITHUB_WEBHOOK_BODY_ENCODING_INVALID"
  | "GITHUB_WEBHOOK_JSON_INVALID"
  | "GITHUB_WEBHOOK_PAYLOAD_INVALID";

export type GitHubWebhookBoundaryError = {
  code: GitHubWebhookErrorCode;
  message: string;
  httpStatus: 400 | 401 | 500;
  retryable: false;
  fieldErrors: GitHubWebhookFieldError[];
};

const metadataSchema = z.object({
  deliveryId: z.string().uuid(),
  event: z.enum(supportedGitHubWebhookEvents),
});

const payloadSchema = z
  .object({
    installation: z
      .object({
        id: z.number().int().positive().safe(),
      })
      .passthrough(),
    action: z.string().trim().min(1).max(100).optional(),
  })
  .passthrough();

export type GitHubWebhookPayload = z.infer<typeof payloadSchema>;

export type ParsedGitHubWebhook = {
  deliveryId: string;
  event: SupportedGitHubWebhookEvent;
  installationId: number;
  action?: string;
  payload: GitHubWebhookPayload;
};

export type ParseGitHubWebhookResult =
  | { ok: true; value: ParsedGitHubWebhook }
  | { ok: false; error: GitHubWebhookBoundaryError };

const signaturePattern = /^sha256=([0-9a-f]{64})$/i;
const invalidSignatureDigest = Buffer.alloc(32);

/**
 * Verifies GitHub's sha256 signature against the exact request bytes.
 *
 * The digest comparison always operates on two 32-byte buffers, including for
 * malformed signatures, so the comparison itself remains constant-time.
 */
export function verifyGitHubWebhookSignature(input: {
  rawBody: Uint8Array;
  signature: string;
  secret: string | Uint8Array;
}): boolean {
  const secretIsEmpty =
    typeof input.secret === "string"
      ? input.secret.length === 0
      : input.secret.byteLength === 0;

  if (secretIsEmpty) return false;

  const expectedDigest = createHmac("sha256", input.secret)
    .update(input.rawBody)
    .digest();
  const match = signaturePattern.exec(input.signature);
  const suppliedDigest = match
    ? Buffer.from(match[1], "hex")
    : invalidSignatureDigest;
  const digestsMatch = timingSafeEqual(expectedDigest, suppliedDigest);

  return match !== null && digestsMatch;
}

/**
 * Authenticates and validates a GitHub webhook without depending on an HTTP
 * framework. Callers must pass the body bytes before any text/JSON parsing.
 */
export function parseGitHubWebhookRequest(input: {
  rawBody: Uint8Array;
  headers: GitHubWebhookHeaderSource;
  secret: string | Uint8Array;
}): ParseGitHubWebhookResult {
  if (secretLength(input.secret) === 0) {
    return failure(
      "GITHUB_WEBHOOK_CONFIGURATION_INVALID",
      "The GitHub webhook secret is not configured.",
      500,
    );
  }

  const signature = readSingleHeader(input.headers, "x-hub-signature-256");
  if (signature === undefined) {
    return failure(
      "GITHUB_WEBHOOK_SIGNATURE_MISSING",
      "The GitHub webhook signature header is required.",
      401,
      [{ field: "x-hub-signature-256", code: "required", message: "Required" }],
    );
  }

  if (
    !verifyGitHubWebhookSignature({
      rawBody: input.rawBody,
      signature,
      secret: input.secret,
    })
  ) {
    return failure(
      "GITHUB_WEBHOOK_SIGNATURE_INVALID",
      "The GitHub webhook signature is invalid.",
      401,
    );
  }

  const rawEvent = readSingleHeader(input.headers, "x-github-event");
  const metadataResult = metadataSchema.safeParse({
    deliveryId: readSingleHeader(input.headers, "x-github-delivery"),
    event: rawEvent,
  });
  if (!metadataResult.success) {
    const unsupportedEvent =
      typeof rawEvent === "string" &&
      !supportedGitHubWebhookEvents.some((event) => event === rawEvent);
    return failure(
      unsupportedEvent
        ? "GITHUB_WEBHOOK_EVENT_UNSUPPORTED"
        : "GITHUB_WEBHOOK_METADATA_INVALID",
      unsupportedEvent
        ? "The GitHub webhook event is not supported."
        : "The GitHub webhook metadata is invalid.",
      400,
      zodFieldErrors(metadataResult.error, {
        deliveryId: "x-github-delivery",
        event: "x-github-event",
      }),
    );
  }

  let decodedBody: string;
  try {
    decodedBody = new TextDecoder("utf-8", { fatal: true }).decode(
      input.rawBody,
    );
  } catch {
    return failure(
      "GITHUB_WEBHOOK_BODY_ENCODING_INVALID",
      "The GitHub webhook body must be valid UTF-8.",
      400,
    );
  }

  let untrustedPayload: unknown;
  try {
    untrustedPayload = JSON.parse(decodedBody);
  } catch {
    return failure(
      "GITHUB_WEBHOOK_JSON_INVALID",
      "The GitHub webhook body must contain valid JSON.",
      400,
    );
  }

  const payloadResult = payloadSchema.safeParse(untrustedPayload);
  if (!payloadResult.success) {
    return failure(
      "GITHUB_WEBHOOK_PAYLOAD_INVALID",
      "The GitHub webhook payload is invalid.",
      400,
      zodFieldErrors(payloadResult.error),
    );
  }

  return {
    ok: true,
    value: {
      deliveryId: metadataResult.data.deliveryId,
      event: metadataResult.data.event,
      installationId: payloadResult.data.installation.id,
      ...(payloadResult.data.action === undefined
        ? {}
        : { action: payloadResult.data.action }),
      payload: payloadResult.data,
    },
  };
}

function secretLength(secret: string | Uint8Array): number {
  return typeof secret === "string" ? secret.length : secret.byteLength;
}

function readSingleHeader(
  headers: GitHubWebhookHeaderSource,
  requestedName: string,
): string | undefined {
  if ("get" in headers && typeof headers.get === "function") {
    return headers.get(requestedName) ?? undefined;
  }

  const entry = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === requestedName,
  );
  if (!entry || Array.isArray(entry[1])) return undefined;
  return entry[1];
}

function zodFieldErrors(
  error: z.ZodError,
  fieldAliases: Readonly<Record<string, string>> = {},
): GitHubWebhookFieldError[] {
  return error.issues.map((issue) => {
    const path = issue.path.join(".");
    return {
      field: fieldAliases[path] ?? path,
      code: issue.code,
      message: issue.message,
    };
  });
}

function failure(
  code: GitHubWebhookErrorCode,
  message: string,
  httpStatus: GitHubWebhookBoundaryError["httpStatus"],
  fieldErrors: GitHubWebhookFieldError[] = [],
): ParseGitHubWebhookResult {
  return {
    ok: false,
    error: { code, message, httpStatus, retryable: false, fieldErrors },
  };
}
