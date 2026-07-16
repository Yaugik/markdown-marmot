import { describe, expect, it } from "vitest";
import { jsonError, jsonSuccess, requestContext } from "./http";

describe("HTTP API helpers", () => {
  it("preserves a valid request UUIDv7 and generates trace metadata", async () => {
    const requestId = "018f22e2-7b1c-7a04-8c8b-1bdb95943315";
    const context = requestContext(new Request("https://folio.test/api", { headers: { "x-request-id": requestId } }));
    const response = jsonSuccess({ ok: true }, context, 201);
    expect(response.status).toBe(201);
    expect(response.headers.get("x-request-id")).toBe(requestId);
    await expect(response.json()).resolves.toMatchObject({ meta: { request_id: requestId } });
  });

  it("uses the public error envelope", async () => {
    const context = requestContext(new Request("https://folio.test/api"));
    const response = jsonError("UNAUTHENTICATED", context, 401);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "UNAUTHENTICATED" } });
  });
});
