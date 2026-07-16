export type FoundationErrorCode =
  | "VALIDATION_FAILED"
  | "NOT_FOUND"
  | "CAPABILITY_DENIED"
  | "IDEMPOTENCY_CONFLICT"
  | "REVISION_CONFLICT"
  | "CONFIRMATION_REQUIRED"
  | "CONFIRMATION_EXPIRED"
  | "BASE_REF_CHANGED"
  | "BLOB_CHANGED"
  | "TARGET_REF_CHANGED"
  | "PATH_POLICY_CHANGED"
  | "GITHUB_PERMISSION_CHANGED"
  | "BRANCH_PROTECTED"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "CONFLICT";

export class FoundationServiceError extends Error {
  constructor(
    public readonly code: FoundationErrorCode,
    message: string,
    public readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "FoundationServiceError";
  }
}
