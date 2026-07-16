import { describe, expect, it } from "vitest";
import { isSameOriginMutation, readCookie, serializeSessionCookie, sessionCookieName } from "./sessions";

describe("session cookie boundary", () => {
  it("serializes an opaque secure host cookie", () => {
    const cookie = serializeSessionCookie("opaque-token", new Date("2026-07-14T00:00:00Z"));
    expect(cookie).toContain(`${sessionCookieName}=opaque-token`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
  });

  it("reads an exact cookie name", () => {
    const request = new Request("https://folio.test", { headers: { cookie: `other=1; ${sessionCookieName}=abc%20123` } });
    expect(readCookie(request, sessionCookieName)).toBe("abc 123");
  });

  it("requires same-origin state-changing requests", () => {
    expect(isSameOriginMutation(new Request("https://folio.test/api", { method: "POST", headers: { origin: "https://folio.test" } }))).toBe(true);
    expect(isSameOriginMutation(new Request("https://folio.test/api", { method: "POST", headers: { origin: "https://evil.test" } }))).toBe(false);
    expect(isSameOriginMutation(new Request("https://folio.test/api", { method: "POST" }))).toBe(false);
  });
});
