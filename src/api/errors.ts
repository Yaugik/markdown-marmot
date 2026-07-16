import { z } from "zod";
import { responseMetadataSchema, type ResponseMetadata } from "./contracts";

export const apiErrorCodes = [
  "UNAUTHENTICATED",
  "AUTH_NOT_CONFIGURED",
  "AUTH_REQUEST_INVALID",
  "AUTH_PROVIDER_FAILED",
  "AUTH_VERIFIED_EMAIL_REQUIRED",
  "CAPABILITY_DENIED",
  "OBJECT_NOT_GRANTED",
  "VALIDATION_FAILED",
  "NOT_FOUND",
  "CONFLICT",
  "REVISION_CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "CONFIRMATION_REQUIRED",
  "CONFIRMATION_EXPIRED",
  "BASE_REF_CHANGED",
  "BLOB_CHANGED",
  "TARGET_REF_CHANGED",
  "PATH_POLICY_CHANGED",
  "GITHUB_PERMISSION_CHANGED",
  "BRANCH_PROTECTED",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
  "OPERATION_FAILED",
] as const;

export const apiErrorCodeSchema = z.enum(apiErrorCodes);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

const jsonPrimitiveSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    jsonPrimitiveSchema,
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
);

export const fieldErrorSchema = z
  .object({
    field: z.string().min(1).max(255),
    code: z.string().min(1).max(100),
    message: z.string().min(1).max(1000),
  })
  .strict();

export const apiErrorSchema = z
  .object({
    code: apiErrorCodeSchema,
    message: z.string().min(1).max(1000),
    details: z.record(jsonValueSchema).default({}),
    retryable: z.boolean(),
    field_errors: z.array(fieldErrorSchema).default([]),
    suggested_actions: z.array(z.string().min(1).max(255)).default([]),
  })
  .strict();

export const errorEnvelopeSchema = z
  .object({
    error: apiErrorSchema,
    meta: responseMetadataSchema.omit({ next_cursor: true }),
  })
  .strict();

type ErrorDefinition = {
  message: string;
  retryable: boolean;
  suggestedActions: readonly string[];
};

const errorDefinitions: Record<ApiErrorCode, ErrorDefinition> = {
  UNAUTHENTICATED: {
    message: "Authentication is required.",
    retryable: false,
    suggestedActions: ["authenticate"],
  },
  AUTH_NOT_CONFIGURED: {
    message: "Managed authentication is not configured.",
    retryable: false,
    suggestedActions: ["contact_workspace_operator"],
  },
  AUTH_REQUEST_INVALID: {
    message: "The authentication request is invalid or expired.",
    retryable: false,
    suggestedActions: ["restart_authentication"],
  },
  AUTH_PROVIDER_FAILED: {
    message: "The identity provider could not complete authentication.",
    retryable: true,
    suggestedActions: ["restart_authentication"],
  },
  AUTH_VERIFIED_EMAIL_REQUIRED: {
    message: "A verified email address is required.",
    retryable: false,
    suggestedActions: ["verify_provider_email"],
  },
  CAPABILITY_DENIED: {
    message: "You do not have permission to perform this action.",
    retryable: false,
    suggestedActions: [],
  },
  OBJECT_NOT_GRANTED: {
    message: "Access to this object has not been granted.",
    retryable: false,
    suggestedActions: [],
  },
  VALIDATION_FAILED: {
    message: "The request contains invalid input.",
    retryable: false,
    suggestedActions: ["correct_input"],
  },
  NOT_FOUND: {
    message: "The requested resource was not found.",
    retryable: false,
    suggestedActions: [],
  },
  CONFLICT: {
    message: "The requested change conflicts with existing state.",
    retryable: false,
    suggestedActions: ["review_current_state"],
  },
  REVISION_CONFLICT: {
    message: "The resource changed after it was read.",
    retryable: false,
    suggestedActions: ["read_resource", "reapply_change"],
  },
  IDEMPOTENCY_CONFLICT: {
    message: "The idempotency key was already used with different input.",
    retryable: false,
    suggestedActions: ["use_new_idempotency_key"],
  },
  CONFIRMATION_REQUIRED: {
    message: "This action requires confirmation.",
    retryable: false,
    suggestedActions: ["review_confirmation"],
  },
  CONFIRMATION_EXPIRED: {
    message: "The confirmation has expired.",
    retryable: false,
    suggestedActions: ["prepare_confirmation"],
  },
  BASE_REF_CHANGED: {
    message: "The base branch changed after this operation was prepared.",
    retryable: false,
    suggestedActions: ["prepare_change_again"],
  },
  BLOB_CHANGED: {
    message: "A file changed after this operation was prepared.",
    retryable: false,
    suggestedActions: ["read_file", "prepare_change_again"],
  },
  TARGET_REF_CHANGED: {
    message: "The target branch changed after this operation was prepared.",
    retryable: false,
    suggestedActions: ["prepare_change_again"],
  },
  PATH_POLICY_CHANGED: {
    message: "The repository path policy changed.",
    retryable: false,
    suggestedActions: ["review_repository_policy"],
  },
  GITHUB_PERMISSION_CHANGED: {
    message: "GitHub no longer permits this action.",
    retryable: false,
    suggestedActions: ["review_github_permissions"],
  },
  BRANCH_PROTECTED: {
    message: "Branch protection prevents this action.",
    retryable: false,
    suggestedActions: ["open_pull_request"],
  },
  PROVIDER_RATE_LIMITED: {
    message: "The provider rate limit was reached.",
    retryable: true,
    suggestedActions: ["retry_later"],
  },
  PROVIDER_UNAVAILABLE: {
    message: "The provider is temporarily unavailable.",
    retryable: true,
    suggestedActions: ["retry_later"],
  },
  OPERATION_FAILED: {
    message: "The operation could not be completed.",
    retryable: false,
    suggestedActions: ["retry_or_contact_support"],
  },
};

type PublicErrorOptions = {
  details?: Record<string, JsonValue>;
  fieldErrors?: z.infer<typeof fieldErrorSchema>[];
  suggestedActions?: string[];
};

type ErrorMeta = Pick<ResponseMetadata, "request_id" | "trace_id">;

export function createApiError(
  code: ApiErrorCode,
  meta: ErrorMeta,
  options: PublicErrorOptions = {},
) {
  const definition = errorDefinitions[code];

  return errorEnvelopeSchema.parse({
    error: {
      code,
      message: definition.message,
      details: options.details ?? {},
      retryable: definition.retryable,
      field_errors: options.fieldErrors ?? [],
      suggested_actions: options.suggestedActions ?? [
        ...definition.suggestedActions,
      ],
    },
    meta,
  });
}

/**
 * Converts an untrusted exception into a public response without copying its
 * message, stack, cause, provider response, or other implementation details.
 */
export function errorFromUnknown(_cause: unknown, meta: ErrorMeta) {
  return createApiError("OPERATION_FAILED", meta);
}

export type ApiError = z.infer<typeof apiErrorSchema>;
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
