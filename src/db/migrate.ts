import { sqlite } from "./client";

export function migrate() {
  const database = sqlite();
  database.exec(`
    CREATE TABLE IF NOT EXISTS repositories (
      id TEXT PRIMARY KEY, display_name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('local','remote')),
      location TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, default_branch TEXT NOT NULL,
      last_successful_sync_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_sources (
      id TEXT PRIMARY KEY, repository_id TEXT NOT NULL REFERENCES repositories(id), branch_name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1, last_observed_commit TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(repository_id, branch_name)
    );
    CREATE TABLE IF NOT EXISTS sync_rules (
      id TEXT PRIMARY KEY, sync_source_id TEXT NOT NULL REFERENCES sync_sources(id), rule_type TEXT NOT NULL,
      target_type TEXT NOT NULL, pattern TEXT NOT NULL, position INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL, lease_expires_at TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS jobs_claim_idx ON jobs(status, available_at);
    CREATE TABLE IF NOT EXISTS sync_runs (
      id TEXT PRIMARY KEY, sync_source_id TEXT NOT NULL REFERENCES sync_sources(id), status TEXT NOT NULL,
      from_commit TEXT, to_commit TEXT, added_count INTEGER NOT NULL DEFAULT 0, changed_count INTEGER NOT NULL DEFAULT 0,
      removed_count INTEGER NOT NULL DEFAULT 0, unchanged_count INTEGER NOT NULL DEFAULT 0, error_code TEXT, error_message TEXT,
      started_at TEXT NOT NULL, finished_at TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY, sync_source_id TEXT NOT NULL REFERENCES sync_sources(id), source_path TEXT NOT NULL,
      title TEXT NOT NULL, blob_oid TEXT NOT NULL, commit_oid TEXT NOT NULL, content_hash TEXT NOT NULL,
      markdown TEXT NOT NULL, rendered_html TEXT NOT NULL, extracted_text TEXT NOT NULL, available INTEGER NOT NULL DEFAULT 1,
      last_indexed_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(sync_source_id, source_path)
    );
    CREATE INDEX IF NOT EXISTS documents_available_idx ON documents(available, updated_at DESC);
    CREATE TABLE IF NOT EXISTS headings (
      id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      level INTEGER NOT NULL, text TEXT NOT NULL, slug TEXT NOT NULL, position INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS activity_events (
      id TEXT PRIMARY KEY, actor_type TEXT NOT NULL, action TEXT NOT NULL, entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL, summary TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS document_search USING fts5(
      document_id UNINDEXED, title, source_path, headings, body, tokenize='porter unicode61'
    );
  `);
}
