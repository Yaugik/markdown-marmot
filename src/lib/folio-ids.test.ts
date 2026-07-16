import { describe, expect, it } from "vitest";
import { newFolioId } from "./folio-ids";

describe("newFolioId", () => {
  it("creates an RFC 9562 UUIDv7", () => {
    const id = newFolioId(new Date("2026-07-13T10:00:00.000Z"));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("sorts IDs from different milliseconds chronologically", () => {
    const earlier = newFolioId(new Date("2026-07-13T10:00:00.000Z"));
    const later = newFolioId(new Date("2026-07-13T10:00:00.001Z"));
    expect(earlier < later).toBe(true);
  });
});
