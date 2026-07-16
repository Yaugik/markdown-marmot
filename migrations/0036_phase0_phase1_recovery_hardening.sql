CREATE UNIQUE INDEX legacy_import_runs_active_fingerprint_idx
  ON legacy_import_runs(workspace_id,project_id,source_fingerprint)
  WHERE state IN ('running','succeeded','succeeded_with_warnings');

ALTER TABLE prepared_git_operations
  ADD COLUMN IF NOT EXISTS confirmation_consumed_at timestamptz;

CREATE INDEX github_webhook_deliveries_pending_idx
  ON github_webhook_deliveries(created_at,delivery_id)
  WHERE status IN ('received','queued','failed');

CREATE INDEX selected_git_branches_reconciliation_due_idx
  ON selected_git_branches(last_reconciled_at,id)
  WHERE state='enabled';

CREATE INDEX prepared_git_operations_stuck_idx
  ON prepared_git_operations(updated_at,id)
  WHERE state='executing';
