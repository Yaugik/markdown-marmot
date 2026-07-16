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
      "CREATE TABLE page_comment_threads",
      "CREATE TABLE page_comments",
      "CREATE TABLE mentions",
      "CREATE TABLE attachments",
      "CREATE TABLE page_links",
      "CREATE TABLE page_search_documents",
      "CREATE TABLE page_conversion_previews",
      "native_page_revision_marks_knowledge_stale",
      "native_page_revision_refreshes_search",
      "page_search_documents_vector_idx",
    ]) expect(sql).toContain(expected);
  });

  it("keeps link revision references polymorphic for Git and native pages", async () => {
    const sql = await readFile(path.join(process.cwd(), "migrations/0009_phase2_completion.sql"), "utf8");
    expect(sql).toContain("DROP CONSTRAINT IF EXISTS page_links_workspace_id_project_id_source_revision_id_fkey");
    expect(sql).toContain("Application-level polymorphic revision reference");
  });

  it("defines configurable Phase 3 workflows, issues, portfolio planning, views, and bulk previews", async () => {
    const sql = await readFile(path.join(process.cwd(), "migrations/0010_phase3_work_management.sql"), "utf8");
    for (const expected of [
      "CREATE TABLE issue_workflows",
      "CREATE TABLE issue_workflow_statuses",
      "CREATE TABLE issue_workflow_transitions",
      "CREATE TABLE issues",
      "CREATE TABLE issue_dependencies",
      "CREATE TABLE issue_comments",
      "CREATE TABLE issue_attachments",
      "CREATE TABLE issue_saved_views",
      "CREATE TABLE issue_bulk_previews",
      "prevent_issue_hierarchy_cycle",
      "prevent_blocking_dependency_cycle",
      "issues_refresh_search",
    ]) expect(sql).toContain(expected);
  });

  it("hardens workflow transitions and active portfolio references", async () => {
    const sql = await readFile(path.join(process.cwd(), "migrations/0011_phase3_hardening.sql"), "utf8");
    expect(sql).toContain("validate_issue_workflow_transition");
    expect(sql).toContain("issue_workflow_transitions_validate_statuses");
    expect(sql).toContain("issue_links_no_self_issue_target");
    expect(sql).toContain("validate_issue_portfolio_references");
  });
});
