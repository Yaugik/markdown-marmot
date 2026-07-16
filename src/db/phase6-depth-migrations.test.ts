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

  it("binds delegated Canvas ownership and derivation sources to principal kinds", async () => {
    const actionHardening = await readFile(path.join(process.cwd(), "migrations/0027_phase6_authoritative_action_hardening.sql"), "utf8");
    expect(actionHardening).toContain("validate_relationship_derivation_actor");
    expect(actionHardening).toContain("Agent synthesis derivations require an agent principal");
    expect(actionHardening).toContain("Revision and provider derivations require a system principal");
    const approvalHardening = await readFile(path.join(process.cwd(), "migrations/0029_phase6_preview_approval_hardening.sql"), "utf8");
    expect(approvalHardening).toContain("prevent_private_agent_canvas_owner");
    expect(approvalHardening).toContain("Private Canvases require a human or system owner");
  });

  it("keeps preview definitions immutable after creation", async () => {
    const sql = await readFile(path.join(process.cwd(), "migrations/0029_phase6_preview_approval_hardening.sql"), "utf8");
    expect(sql).toContain("prevent_canvas_action_preview_definition_change");
    expect(sql).toContain("Canvas action preview definition is immutable");
    expect(sql).toContain("canvas_action_previews_definition_immutable");
  });
});
