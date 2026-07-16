import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  parseGitHubWebhookRequest,
  supportedGitHubWebhookEvents,
  verifyGitHubWebhookSignature,
} from "./webhook";

const secret = "development-webhook-secret";
const deliveryId = "018f47a8-36f4-7c3a-9e40-01a4d4f25123";

function signedRequest(
  payload: unknown,
  overrides: Record<string, string | undefined> = {},
) {
  const rawBody = Buffer.from(JSON.stringify(payload));
  const signature = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const headers: Record<string, string | undefined> = {
    "x-hub-signature-256": signature,
    "x-github-delivery": deliveryId,
    "x-github-event": "push",
    ...overrides,
  };
  return { rawBody, headers, secret };
}

describe("verifyGitHubWebhookSignature", () => {
  it("accepts a signature over the exact raw bytes", () => {
    const rawBody = Buffer.from('{"installation":{"id":42}}');
    const signature = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;

    expect(verifyGitHubWebhookSignature({ rawBody, signature, secret })).toBe(
      true,
    );
    expect(
      verifyGitHubWebhookSignature({
        rawBody: Buffer.from('{ "installation": {"id":42}}'),
        signature,
        secret,
      }),
    ).toBe(false);
  });

  it("rejects malformed, wrong, and legacy sha1 signatures", () => {
    const rawBody = Buffer.from("{}");
    for (const signature of [
      "sha256=not-hex",
      `sha256=${"0".repeat(64)}`,
      `sha1=${"0".repeat(40)}`,
    ]) {
      expect(verifyGitHubWebhookSignature({ rawBody, signature, secret })).toBe(
        false,
      );
    }
  });
});

describe("parseGitHubWebhookRequest", () => {
  it.each(supportedGitHubWebhookEvents)(
    "accepts the supported %s event",
    (event) => {
      const result = parseGitHubWebhookRequest(
        signedRequest(
          { installation: { id: 42 }, action: "updated" },
          { "x-github-event": event },
        ),
      );

      expect(result).toEqual({
        ok: true,
        value: {
          deliveryId,
          event,
          installationId: 42,
          action: "updated",
          payload: { installation: { id: 42 }, action: "updated" },
        },
      });
    },
  );

  it("reads case-insensitive record headers", () => {
    const request = signedRequest({ installation: { id: 42 } });
    const result = parseGitHubWebhookRequest({
      ...request,
      headers: {
        "X-Hub-Signature-256": request.headers["x-hub-signature-256"],
        "X-GitHub-Delivery": deliveryId,
        "X-GitHub-Event": "push",
      },
    });

    expect(result.ok).toBe(true);
  });

  it("rejects a missing signature with a machine-readable error", () => {
    const request = signedRequest(
      { installation: { id: 42 } },
      {
        "x-hub-signature-256": undefined,
      },
    );

    expect(parseGitHubWebhookRequest(request)).toMatchObject({
      ok: false,
      error: {
        code: "GITHUB_WEBHOOK_SIGNATURE_MISSING",
        httpStatus: 401,
        retryable: false,
        fieldErrors: [{ field: "x-hub-signature-256", code: "required" }],
      },
    });
  });

  it("rejects a signature made with another secret before parsing JSON", () => {
    const request = signedRequest({ installation: { id: 42 } });
    const result = parseGitHubWebhookRequest({
      ...request,
      secret: "wrong-secret",
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "GITHUB_WEBHOOK_SIGNATURE_INVALID", httpStatus: 401 },
    });
  });

  it("rejects an unsupported event", () => {
    const result = parseGitHubWebhookRequest(
      signedRequest(
        { installation: { id: 42 } },
        { "x-github-event": "issues" },
      ),
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "GITHUB_WEBHOOK_EVENT_UNSUPPORTED",
        fieldErrors: [{ field: "x-github-event" }],
      },
    });
  });

  it("rejects a malformed delivery ID", () => {
    const result = parseGitHubWebhookRequest(
      signedRequest(
        { installation: { id: 42 } },
        { "x-github-delivery": "not-a-guid" },
      ),
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "GITHUB_WEBHOOK_METADATA_INVALID",
        fieldErrors: [{ field: "x-github-delivery" }],
      },
    });
  });

  it("requires a positive safe installation ID", () => {
    const result = parseGitHubWebhookRequest(
      signedRequest({
        installation: { id: 0 },
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "GITHUB_WEBHOOK_PAYLOAD_INVALID",
        fieldErrors: [{ field: "installation.id" }],
      },
    });
  });

  it("distinguishes invalid UTF-8 and invalid JSON", () => {
    const invalidUtf8 = Buffer.from([0xff]);
    const utf8Signature = `sha256=${createHmac("sha256", secret).update(invalidUtf8).digest("hex")}`;
    const commonHeaders = {
      "x-hub-signature-256": utf8Signature,
      "x-github-delivery": deliveryId,
      "x-github-event": "push",
    };

    expect(
      parseGitHubWebhookRequest({
        rawBody: invalidUtf8,
        headers: commonHeaders,
        secret,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "GITHUB_WEBHOOK_BODY_ENCODING_INVALID" },
    });

    const invalidJson = Buffer.from("not-json");
    expect(
      parseGitHubWebhookRequest({
        rawBody: invalidJson,
        headers: {
          ...commonHeaders,
          "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(invalidJson).digest("hex")}`,
        },
        secret,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "GITHUB_WEBHOOK_JSON_INVALID" },
    });
  });

  it("rejects an unconfigured webhook secret", () => {
    const request = signedRequest({ installation: { id: 42 } });

    expect(parseGitHubWebhookRequest({ ...request, secret: "" })).toMatchObject(
      {
        ok: false,
        error: {
          code: "GITHUB_WEBHOOK_CONFIGURATION_INVALID",
          httpStatus: 500,
        },
      },
    );
  });
});
