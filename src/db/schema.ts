import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
};

export const repositories = sqliteTable("repositories", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  kind: text("kind", { enum: ["local", "remote"] }).notNull(),
  location: text("location").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  defaultBranch: text("default_branch").notNull(),
  lastSuccessfulSyncAt: text("last_successful_sync_at"),
  ...timestamps,
});

export const syncSources = sqliteTable("sync_sources", {
  id: text("id").primaryKey(),
  repositoryId: text("repository_id").notNull().references(() => repositories.id),
  branchName: text("branch_name").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  lastObservedCommit: text("last_observed_commit"),
  ...timestamps,
}, (table) => [uniqueIndex("sync_source_repo_branch").on(table.repositoryId, table.branchName)]);

export const syncRules = sqliteTable("sync_rules", {
  id: text("id").primaryKey(),
  syncSourceId: text("sync_source_id").notNull().references(() => syncSources.id),
  ruleType: text("rule_type", { enum: ["include", "exclude"] }).notNull(),
  targetType: text("target_type", { enum: ["repository", "folder", "file", "glob"] }).notNull(),
  pattern: text("pattern").notNull(),
  position: integer("position").notNull(),
  ...timestamps,
});

export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  payload: text("payload", { mode: "json" }).notNull(),
  status: text("status", { enum: ["pending", "running", "succeeded", "failed"] }).notNull(),
  attempts: integer("attempts").notNull().default(0),
  availableAt: text("available_at").notNull(),
  leaseExpiresAt: text("lease_expires_at"),
  lastError: text("last_error"),
  ...timestamps,
});

export const syncRuns = sqliteTable("sync_runs", {
  id: text("id").primaryKey(),
  syncSourceId: text("sync_source_id").notNull().references(() => syncSources.id),
  status: text("status").notNull(),
  fromCommit: text("from_commit"),
  toCommit: text("to_commit"),
  addedCount: integer("added_count").notNull().default(0),
  changedCount: integer("changed_count").notNull().default(0),
  removedCount: integer("removed_count").notNull().default(0),
  unchangedCount: integer("unchanged_count").notNull().default(0),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  createdAt: text("created_at").notNull(),
});

export const documents = sqliteTable("documents", {
  id: text("id").primaryKey(),
  syncSourceId: text("sync_source_id").notNull().references(() => syncSources.id),
  sourcePath: text("source_path").notNull(),
  title: text("title").notNull(),
  blobOid: text("blob_oid").notNull(),
  commitOid: text("commit_oid").notNull(),
  contentHash: text("content_hash").notNull(),
  markdown: text("markdown").notNull(),
  renderedHtml: text("rendered_html").notNull(),
  extractedText: text("extracted_text").notNull(),
  available: integer("available", { mode: "boolean" }).notNull().default(true),
  lastIndexedAt: text("last_indexed_at").notNull(),
  ...timestamps,
}, (table) => [uniqueIndex("documents_source_path").on(table.syncSourceId, table.sourcePath)]);

export const headings = sqliteTable("headings", {
  id: text("id").primaryKey(),
  documentId: text("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
  level: integer("level").notNull(),
  text: text("text").notNull(),
  slug: text("slug").notNull(),
  position: integer("position").notNull(),
});

export const activityEvents = sqliteTable("activity_events", {
  id: text("id").primaryKey(),
  actorType: text("actor_type").notNull(),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  summary: text("summary").notNull(),
  metadata: text("metadata", { mode: "json" }).notNull(),
  createdAt: text("created_at").notNull(),
});
