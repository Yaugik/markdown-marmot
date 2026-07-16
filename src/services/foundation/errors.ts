export type FoundationErrorCode =
  | "VALIDATION_FAILED"
  | "NOT_FOUND"
  | "CAPABILITY_DENIED"
  | "IDEMPOTENCY_CONFLICT"
  | "REVISION_CONFLICT"
  | "CONFIRMATION_REQUIRED"
  | "CONFIRMATION_EXPIRED"
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
