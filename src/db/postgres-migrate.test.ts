import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadPostgresMigrations } from "./postgres-migrate";

describe("Folio PostgreSQL migrations", () => {
  it("loads migrations in deterministic order with stable checksums", async () => {
    const migrations = await loadPostgresMigrations();
    expect(migrations.map((migration) => migration.name)).toEqual([
      "0001_folio_foundation.sql",
      "0002_database_isolation.sql",
      "0003_auth_sessions.sql",
      "0004_auth_schema_repair.sql",
      "0005_native_pages.sql",
      "0006_native_page_lifecycle.sql",
      "0007_page_tree_management.sql",
      "0008_phase2_collaboration.sql",
      "0009_phase2_completion.sql",
      "0010_phase3_work_management.sql",
      "0011_phase3_hardening.sql",
      "0012_phase3_security_hardening.sql",
      "0013_phase4_todos_scheduling.sql",
      "0014_phase5_foundations.sql",
      "0015_phase4_phase5_hardening.sql",
      "0016_phase5_calendar_event_mapping.sql",
      "0017_phase4_worker_bootstrap.sql",
      "0018_phase5_reminder_worker_policy.sql",
      "0019_phase5_least_privilege.sql",
    ]);
    expect(migrations[0]?.checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it("defines the tenant, authorization, concurrency, and audit foundations", async () => {
    const sql = await readFile(path.join(process.cwd(), "migrations/0001_folio_foundation.sql"), "utf8");
    for (const expected of [
      "CREATE TABLE principals", "CREATE TABLE workspaces", "CREATE TABLE projects",
      "CREATE TABLE project_memberships", "CREATE TABLE capability_grants",
      "CREATE TABLE object_grants", "CREATE TABLE activity_events",
      "CREATE TABLE outbox_events", "CREATE TABLE idempotency_records",
      "CREATE TABLE jobs", "revision bigint", "activity_events_append_only",
    ]) expect(sql).toContain(expected);
  });

  it("defines immutable native pages and project-owned tree placements", async () => {
    const sql = await readFile(path.join(process.cwd(), "migrations/0005_native_pages.sql"), "utf8");
    for (const expected of [
      "CREATE TABLE pages", "CREATE TABLE native_pages",
      "CREATE TABLE native_page_revisions", "CREATE TABLE page_tree_nodes",
      "native_page_revisions_immutable", "folio_runtime_workspace_scope",
    ]) expect(sql).toContain(expected);
  });

  it("prevents revisions from being added to archived native pages", async () => {
    const sql = await readFile(path.join(process.cwd(), "migrations/0006_native_page_lifecycle.sql"), "utf8");
    expect(sql).toContain("enforce_active_native_page_revision");
    expect(sql).toContain("native_page_revisions_require_active_page");
  });

  it("enforces folder parentage, non-negative ranks, and acyclic page trees", async () => {
    const sql = await readFile(path.join(process.cwd(), "migrations/0007_page_tree_management.sql"), "utf8");
    expect(sql).toContain("page_tree_nodes_rank_nonnegative");
    expect(sql).toContain("page_tree_nodes_folder_title_required");
    expect(sql).toContain("validate_page_tree_parent");
    expect(sql).toContain("page tree cycle detected");
  });

  it("defines Phase 2 collaboration, attachments, links, search, and conversion previews", async () => {
    const sql = await readFile(path.join(process.cwd(), "migrations/0008_phase2_collaboration.sql"), "utf8");
    for (const expected of [
      "CREATE TABLE page_comment_threads", "CREATE TABLE page_comments", "CREATE TABLE mentions",
      "CREATE TABLE attachments", "CREATE TABLE page_links", "CREATE TABLE page_search_documents",
      "CREATE TABLE page_conversion_previews", "native_page_revision_marks_knowledge_stale",
      "native_page_revision_refreshes_search", "page_search_documents_vector_idx",
    ]) expect(sql).toContain(expected);
  });

  it("keeps revision references polymorphic without breaking native triggers", async () => {
    const sql = await readFile(path.join(process.cwd(), "migrations/0009_phase2_completion.sql"), "utf8");
    expect(sql).toContain("DROP CONSTRAINT IF EXISTS page_links_workspace_id_project_id_source_revision_id_fkey");
    expect(sql).toContain("Application-level polymorphic revision reference");
    expect(sql).toContain("source_revision_id IS DISTINCT FROM NEW.id::text");
    expect(sql).toContain("NEW.plain_text, NEW.id::text, now()");
  });

  it("defines configurable Phase 3 workflows, issues, portfolio planning, views, and bulk previews", async () => {
    const sql = await readFile(path.join(process.cwd(), "migrations/0010_phase3_work_management.sql"), "utf8");
    for (const expected of [
      "CREATE TABLE issue_workflows", "CREATE TABLE issue_workflow_statuses",
      "CREATE TABLE issue_workflow_transitions", "CREATE TABLE issues",
      "CREATE TABLE issue_dependencies", "CREATE TABLE issue_comments",
      "CREATE TABLE issue_attachments", "CREATE TABLE issue_saved_views",
      "CREATE TABLE issue_bulk_previews", "prevent_issue_hierarchy_cycle",
      "prevent_blocking_dependency_cycle", "issues_refresh_search",
    ]) expect(sql).toContain(expected);
  });

  it("hardens workflow transitions and active portfolio references", async () => {
    const sql = await readFile(path.join(process.cwd(), "migrations/0011_phase3_hardening.sql"), "utf8");
    expect(sql).toContain("validate_issue_workflow_transition");
    expect(sql).toContain("issue_workflow_transitions_validate_statuses");
    expect(sql).toContain("issue_links_no_self_issue_target");
    expect(sql).toContain("validate_issue_portfolio_references");
    expect(sql).toContain("issue_dependencies_active_relation_idx");
  });

  it("enforces Phase 3 preview ownership and active issue parents", async () => {
    const sql = await readFile(path.join(process.cwd(), "migrations/0012_phase3_security_hardening.sql"), "utf8");
    expect(sql).toContain("issue_bulk_previews_creator_scope");
    expect(sql).toContain("active issue parent must be active in the project");
    expect(sql).toContain("issues_validate_parent_lifecycle");
  });

  it("defines private/shared lists, nested todos, recurrence, reminders, calendars, and agent grants", async () => {
    const sql = await readFile(path.join(process.cwd(), "migrations/0013_phase4_todos_scheduling.sql"), "utf8");
    for (const expected of [
      "CREATE TABLE todo_lists", "CREATE TABLE calendars", "CREATE TABLE todos",
      "CREATE TABLE todo_links", "CREATE TABLE todo_recurrence_rules",
      "CREATE TABLE todo_occurrences", "CREATE TABLE calendar_entries",
      "CREATE TABLE reminders", "CREATE TABLE agent_schedule_grants",
      "validate_todo_parent", "validate_todo_assignee", "prevent_active_todo_child_archive",
    ]) expect(sql).toContain(expected);
  });

  it("defines cursor events, presence, provider-neutral calendar contracts, jobs, and metrics", async () => {
    const sql = await readFile(path.join(process.cwd(), "migrations/0014_phase5_foundations.sql"), "utf8");
    for (const expected of [
      "CREATE TABLE realtime_event_log", "CREATE TABLE presence_sessions",
      "CREATE TABLE integration_connections", "CREATE TABLE calendar_external_bindings",
      "CREATE TABLE provider_operations", "CREATE TABLE job_attempts",
      "CREATE TABLE operation_metrics", "mirror_outbox_to_realtime",
      "claim_folio_jobs", "realtime_event_log_cursor_id_seq",
    ]) expect(sql).toContain(expected);
    expect(sql).not.toContain("TO CURRENT_USER");
  });

  it("isolates workers and decision-gates unsafe calendar synchronization", async () => {
    const sql = await readFile(path.join(process.cwd(), "migrations/0015_phase4_phase5_hardening.sql"), "utf8");
    expect(sql).toContain("CREATE ROLE folio_worker");
    expect(sql).toContain("REVOKE ALL ON FUNCTION claim_folio_jobs");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION claim_folio_jobs");
    expect(sql).toContain("reminders_lease_state_consistent");
    expect(sql).toContain("two-way calendar synchronization is decision-gated");
    expect(sql).toContain("active todo parent must be active in the same list");
  });

  it("adds external event mapping and a single recurrence sweep bootstrap", async () => {
    const mapping = await readFile(path.join(process.cwd(), "migrations/0016_phase5_calendar_event_mapping.sql"), "utf8");
    expect(mapping).toContain("CREATE TABLE external_calendar_event_mappings");
    expect(mapping).toContain("UNIQUE (binding_id, external_event_id)");
    const bootstrap = await readFile(path.join(process.cwd(), "migrations/0017_phase4_worker_bootstrap.sql"), "utf8");
    expect(bootstrap).toContain("todo.recurrence.sweep");
    expect(bootstrap).toContain("ON CONFLICT DO NOTHING");
  });

  it("grants reminder delivery to the worker and keeps realtime events append-only", async () => {
    const reminderWorker = await readFile(path.join(process.cwd(), "migrations/0018_phase5_reminder_worker_policy.sql"), "utf8");
    expect(reminderWorker).toContain("GRANT SELECT, UPDATE ON TABLE reminders TO folio_worker");
    expect(reminderWorker).toContain("CREATE POLICY folio_worker_reminders");
    const leastPrivilege = await readFile(path.join(process.cwd(), "migrations/0019_phase5_least_privilege.sql"), "utf8");
    expect(leastPrivilege).toContain("REVOKE UPDATE, DELETE ON TABLE realtime_event_log FROM folio_runtime");
    expect(leastPrivilege).toContain("realtime_event_log_append_only");
    expect(leastPrivilege).toContain("realtime_event_log_no_truncate");
  });
});