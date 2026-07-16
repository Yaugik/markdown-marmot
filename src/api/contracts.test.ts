import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  cursorPaginationSchema,
  mutationMetadataSchema,
  mutationRequestMetadataSchema,
  successEnvelopeSchema,
  uuidV7Schema,
} from "./contracts";
import {
  createApiError,
  errorEnvelopeSchema,
  errorFromUnknown,
} from "./errors";

const id = "018f22e2-7b1c-7a04-8c8b-1bdb95943315";
const otherId = "018f22e2-7b1c-7a04-8c8b-1bdb95943316";
const meta = { request_id: id, trace_id: "trace-123" };

describe("API contracts", () => {
  it("accepts UUIDv7 identifiers and rejects other UUID versions", () => {
    expect(uuidV7Schema.parse(id)).toBe(id);
    expect(() =>
      uuidV7Schema.parse("550e8400-e29b-41d4-a716-446655440000"),
    ).toThrow();
  });

  it("rejects unknown mutation request fields", () => {
    expect(() =>
      mutationRequestMetadataSchema.parse({
        request_id: id,
        idempotency_key: "create-issue-1",
        secret: "must-not-pass-through",
      }),
    ).toThrow();
  });

  it("applies bounded cursor pagination defaults", () => {
    expect(cursorPaginationSchema.parse({})).toEqual({ limit: 50 });
    expect(() => cursorPaginationSchema.parse({ limit: 101 })).toThrow();
  });

  it("builds strict typed success envelopes", () => {
    const schema = successEnvelopeSchema(
      z.object({ id: uuidV7Schema }).strict(),
    );
    expect(
      schema.parse({ data: { id }, meta: { ...meta, next_cursor: null } }),
    ).toEqual({
      data: { id },
      meta: { ...meta, next_cursor: null },
    });
  });

  it("validates common mutation response metadata", () => {
    expect(mutationMetadataSchema.parse({ activity_id: otherId })).toEqual({
      activity_id: otherId,
      warnings: [],
      effective_permissions: [],
      suggested_next_actions: [],
    });
  });
});

describe("API errors", () => {
  it("creates the documented machine-readable revision conflict", () => {
    const envelope = createApiError("REVISION_CONFLICT", meta, {
      details: { expected_revision: 12, current_revision: 13 },
    });

    expect(errorEnvelopeSchema.parse(envelope).error).toMatchObject({
      code: "REVISION_CONFLICT",
      retryable: false,
      details: { expected_revision: 12, current_revision: 13 },
    });
  });

  it("does not leak unknown exception details", () => {
    const envelope = errorFromUnknown(
      new Error("database password=correct-horse-battery-staple"),
      meta,
    );
    const serialized = JSON.stringify(envelope);

    expect(envelope.error.code).toBe("OPERATION_FAILED");
    expect(serialized).not.toContain("correct-horse-battery-staple");
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("stack");
  });

  it("uses fixed public messages rather than accepting exception messages", () => {
    expect(createApiError("PROVIDER_UNAVAILABLE", meta).error).toMatchObject({
      message: "The provider is temporarily unavailable.",
      retryable: true,
      suggested_actions: ["retry_later"],
    });
  });
});
