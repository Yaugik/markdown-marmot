import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadPostgresMigrations } from "./postgres-migrate";

const migrationNames = [
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
  "0020_phase5_scale_ecosystem.sql",
  "0021_phase6_graph_canvas_foundations.sql",
  "0022_phase5_phase6_hardening.sql",
  "0023_phase5_audit_export_worker.sql",
  "0024_phase5_phase6_final_security.sql",
  "0025_phase5_phase6_role_capabilities.sql",
  "0026_phase6_authoritative_actions.sql",
  "0027_phase6_authoritative_action_hardening.sql",
  "0028_phase6_agent_preview_access.sql",
  "0029_phase6_preview_approval_hardening.sql",
  "0030_phase0_production_closure.sql",
  "0031_phase1_github_installations_snapshots.sql",
  "0032_phase1_github_writeback.sql",
  "0033_phase0_phase1_security_hardening.sql",
  "0034_phase0_phase1_final_hardening.sql",
  "0035_phase1_git_write_hardening.sql",
] as const;

const expectedSnippets: Record<(typeof migrationNames)[number], readonly string[]> = {
  "0001_folio_foundation.sql": ["CREATE TABLE principals", "CREATE TABLE activity_events", "CREATE TABLE outbox_events", "CREATE TABLE jobs"],
  "0002_database_isolation.sql": ["ENABLE ROW LEVEL SECURITY", "FORCE ROW LEVEL SECURITY", "folio_runtime"],
  "0003_auth_sessions.sql": ["CREATE TABLE auth_sessions", "CREATE TABLE auth_transactions"],
  "0004_auth_schema_repair.sql": ["external_identities", "auth_sessions"],
  "0005_native_pages.sql": ["CREATE TABLE pages", "CREATE TABLE native_page_revisions", "CREATE TABLE page_tree_nodes"],
  "0006_native_page_lifecycle.sql": ["enforce_active_native_page_revision", "native_page_revisions_require_active_page"],
  "0007_page_tree_management.sql": ["validate_page_tree_parent", "page tree cycle detected"],
  "0008_phase2_collaboration.sql": ["CREATE TABLE page_comment_threads", "CREATE TABLE attachments", "CREATE TABLE page_search_documents"],
  "0009_phase2_completion.sql": ["Application-level polymorphic revision reference", "NEW.id::text"],
  "0010_phase3_work_management.sql": ["CREATE TABLE issue_workflows", "CREATE TABLE issues", "CREATE TABLE issue_bulk_previews"],
  "0011_phase3_hardening.sql": ["validate_issue_workflow_transition", "validate_issue_portfolio_references"],
  "0012_phase3_security_hardening.sql": ["issue_bulk_previews_creator_scope", "active issue parent must be active"],
  "0013_phase4_todos_scheduling.sql": ["CREATE TABLE todo_lists", "CREATE TABLE todos", "CREATE TABLE reminders", "CREATE TABLE calendars"],
  "0014_phase5_foundations.sql": ["CREATE TABLE realtime_event_log", "CREATE TABLE provider_operations", "CREATE TABLE job_attempts"],
  "0015_phase4_phase5_hardening.sql": ["CREATE ROLE folio_worker", "two-way calendar synchronization is decision-gated"],
  "0016_phase5_calendar_event_mapping.sql": ["CREATE TABLE external_calendar_event_mappings", "UNIQUE (binding_id, external_event_id)"],
  "0017_phase4_worker_bootstrap.sql": ["todo.recurrence.sweep", "ON CONFLICT DO NOTHING"],
  "0018_phase5_reminder_worker_policy.sql": ["GRANT SELECT, UPDATE ON TABLE reminders TO folio_worker", "folio_worker_reminders"],
  "0019_phase5_least_privilege.sql": ["realtime_event_log_append_only", "REVOKE UPDATE, DELETE ON TABLE realtime_event_log"],
  "0020_phase5_scale_ecosystem.sql": ["CREATE TABLE page_collaboration_rooms", "CREATE TABLE scale_measurements", "CREATE TABLE audit_export_requests"],
  "0021_phase6_graph_canvas_foundations.sql": ["CREATE TABLE relationship_types", "CREATE TABLE canvases", "CREATE TABLE canvas_commands"],
  "0022_phase5_phase6_hardening.sql": ["folio_entity_exists", "canvas_elements_validate_entity_card", "page_collaboration_rooms_validate_base"],
  "0023_phase5_audit_export_worker.sql": ["folio_worker_activity_export_read", "activity_events_workspace_created_idx"],
  "0024_phase5_phase6_final_security.sql": ["support_access_grants_confirmation_unique", "normalize_symmetric_relationship"],
  "0025_phase5_phase6_role_capabilities.sql": ["page.collaborate", "relationship.edit", "canvas.present"],
  "0026_phase6_authoritative_actions.sql": ["CREATE TABLE relationship_derivation_runs", "CREATE TABLE canvas_action_previews"],
  "0027_phase6_authoritative_action_hardening.sql": ["validate_canvas_action_preview_elements", "validate_promoted_canvas_connector"],
  "0028_phase6_agent_preview_access.sql": ["authorizing_principal_id", "canvas_action_previews"],
  "0029_phase6_preview_approval_hardening.sql": ["normalize_phase6_outbox_aggregate", "Canvas action preview definition is immutable"],
  "0030_phase0_production_closure.sql": ["CREATE TABLE workspace_invitations", "CREATE TABLE workspace_storage_configs", "CREATE TABLE operational_drills", "CREATE TABLE legacy_import_runs"],
  "0031_phase1_github_installations_snapshots.sql": ["CREATE TABLE github_app_installations", "CREATE TABLE project_repository_links", "CREATE TABLE git_snapshots", "CREATE TABLE git_pages"],
  "0032_phase1_github_writeback.sql": ["CREATE TABLE prepared_git_operations", "CREATE TABLE git_provider_operations", "CREATE TABLE git_pull_requests"],
  "0033_phase0_phase1_security_hardening.sql": ["Git snapshot files are immutable", "Published Git snapshot content and counts are immutable", "Prepared Git operation definition is immutable"],
  "0034_phase0_phase1_final_hardening.sql": ["git_snapshots_active_identity_idx", "folio.lookup_workspace_invitation", "CREATE ROLE folio_webhook", "git_snapshot_files_candidate_only"],
  "0035_phase1_git_write_hardening.sql": ["policy_snapshot", "target_ref_oid", "execution_job_id"],
};

describe("Folio PostgreSQL migrations", () => {
  it("loads every migration in deterministic order with stable checksums", async () => {
    const migrations = await loadPostgresMigrations();
    expect(migrations.map((migration) => migration.name)).toEqual(migrationNames);
    for (const migration of migrations) expect(migration.checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it("retains the required authorization, audit, concurrency, and domain invariants", async () => {
    for (const name of migrationNames) {
      const sql = await readFile(path.join(process.cwd(), "migrations", name), "utf8");
      for (const expected of expectedSnippets[name]) expect(sql, `${name} should contain ${expected}`).toContain(expected);
    }
  });

  it("keeps public webhook and worker privileges explicit", async () => {
    const finalHardening = await readFile(path.join(process.cwd(), "migrations/0034_phase0_phase1_final_hardening.sql"), "utf8");
    expect(finalHardening).toContain("NOINHERIT NOBYPASSRLS");
    expect(finalHardening).toContain("folio_webhook_job_insert");
    expect(finalHardening).toContain("kind IN ('github.repository.refresh','github.branch.reconcile')");
    expect(finalHardening).toContain("REVOKE ALL ON FUNCTION folio.lookup_workspace_invitation");
  });
});
