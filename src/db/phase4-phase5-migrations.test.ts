import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Phase 4 and Phase 5 migration hardening", () => {
  it("isolates reminder delivery under the worker role", async () => {
    const sql = await readFile(
      path.join(process.cwd(), "migrations/0018_phase5_reminder_worker_policy.sql"),
      "utf8",
    );
    expect(sql).toContain("GRANT SELECT, UPDATE ON TABLE reminders TO folio_worker");
    expect(sql).toContain("CREATE POLICY folio_worker_reminders");
  });

  it("makes realtime events append-only and removes broad mutation privileges", async () => {
    const sql = await readFile(
      path.join(process.cwd(), "migrations/0019_phase5_least_privilege.sql"),
      "utf8",
    );
    expect(sql).toContain("REVOKE UPDATE, DELETE ON TABLE realtime_event_log FROM folio_runtime");
    expect(sql).toContain("prevent_realtime_event_mutation");
    expect(sql).toContain("realtime_event_log_append_only");
    expect(sql).toContain("realtime_event_log_no_truncate");
  });
});
