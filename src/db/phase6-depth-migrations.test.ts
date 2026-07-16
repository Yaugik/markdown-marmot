import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Phase 6 depth migration hardening", () => {
  it("routes broad organization events to the Canvas aggregate", async () => {
    const sql = await readFile(path.join(process.cwd(), "migrations/0029_phase6_preview_approval_hardening.sql"), "utf8");
    expect(sql).toContain("normalize_phase6_outbox_aggregate");
    expect(sql).toContain("canvas.region_organized.v1");
    expect(sql).toContain("NEW.aggregate_id := (NEW.payload->>'canvasId')::uuid");
    expect(sql).toContain("outbox_events_normalize_phase6_aggregate");
  });
});
