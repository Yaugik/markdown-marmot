CREATE OR REPLACE FUNCTION prevent_workspace_invitation_definition_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.workspace_id<>OLD.workspace_id
    OR NEW.email_normalized<>OLD.email_normalized
    OR NEW.token_digest<>OLD.token_digest
    OR NEW.workspace_role<>OLD.workspace_role
    OR NEW.project_assignments<>OLD.project_assignments
    OR NEW.invited_by_principal_id<>OLD.invited_by_principal_id
    OR NEW.expires_at<>OLD.expires_at THEN
    RAISE EXCEPTION 'Workspace invitation definition is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workspace_invitations_definition_immutable
  BEFORE UPDATE ON workspace_invitations
  FOR EACH ROW EXECUTE FUNCTION prevent_workspace_invitation_definition_change();

CREATE OR REPLACE FUNCTION validate_storage_config_secret_boundary()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(NEW.credential_ref,'') ~* '(BEGIN [A-Z ]*PRIVATE KEY|gh[pousr]_[A-Za-z0-9]|AKIA[0-9A-Z]{16})'
    OR coalesce(NEW.encryption_key_ref,'') ~* '(BEGIN [A-Z ]*PRIVATE KEY|gh[pousr]_[A-Za-z0-9])' THEN
    RAISE EXCEPTION 'Storage configuration accepts secret references, not secret values' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workspace_storage_configs_secret_boundary
  BEFORE INSERT OR UPDATE ON workspace_storage_configs
  FOR EACH ROW EXECUTE FUNCTION validate_storage_config_secret_boundary();

CREATE OR REPLACE FUNCTION validate_github_credential_reference()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.credential_key_ref ~* '(BEGIN [A-Z ]*PRIVATE KEY|gh[pousr]_[A-Za-z0-9]|eyJ[A-Za-z0-9_-]+\.)' THEN
    RAISE EXCEPTION 'GitHub installation stores a key reference, not a private key or token' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER github_installations_secret_boundary
  BEFORE INSERT OR UPDATE OF credential_key_ref ON github_app_installations
  FOR EACH ROW EXECUTE FUNCTION validate_github_credential_reference();

CREATE OR REPLACE FUNCTION prevent_git_snapshot_file_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Git snapshot files are immutable' USING ERRCODE='55000';
END $$;
CREATE TRIGGER git_snapshot_files_immutable
  BEFORE UPDATE OR DELETE ON git_snapshot_files
  FOR EACH ROW EXECUTE FUNCTION prevent_git_snapshot_file_mutation();
CREATE TRIGGER git_snapshot_files_no_truncate
  BEFORE TRUNCATE ON git_snapshot_files
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_git_snapshot_file_mutation();

CREATE OR REPLACE FUNCTION validate_selected_branch_active_snapshot()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE snapshot_branch uuid; snapshot_state text;
BEGIN
  IF NEW.active_snapshot_id IS NULL THEN RETURN NEW; END IF;
  SELECT selected_branch_id,state INTO snapshot_branch,snapshot_state
    FROM git_snapshots
   WHERE workspace_id=NEW.workspace_id AND project_id=NEW.project_id AND id=NEW.active_snapshot_id;
  IF snapshot_branch IS DISTINCT FROM NEW.id OR snapshot_state<>'published' THEN
    RAISE EXCEPTION 'Selected branch active snapshot must be a published snapshot of the same branch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER selected_git_branches_validate_active_snapshot
  BEFORE INSERT OR UPDATE OF active_snapshot_id ON selected_git_branches
  FOR EACH ROW EXECUTE FUNCTION validate_selected_branch_active_snapshot();

CREATE OR REPLACE FUNCTION prevent_published_snapshot_rewrite()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state IN ('published','superseded') THEN
    IF NEW.workspace_id<>OLD.workspace_id OR NEW.project_id<>OLD.project_id
      OR NEW.selected_branch_id<>OLD.selected_branch_id OR NEW.head_oid<>OLD.head_oid
      OR NEW.rules_version<>OLD.rules_version OR NEW.parser_version<>OLD.parser_version
      OR NEW.inventory_hash IS DISTINCT FROM OLD.inventory_hash
      OR NEW.file_count<>OLD.file_count OR NEW.added_count<>OLD.added_count
      OR NEW.changed_count<>OLD.changed_count OR NEW.removed_count<>OLD.removed_count
      OR NEW.unchanged_count<>OLD.unchanged_count OR NEW.warning_count<>OLD.warning_count
      OR NEW.warnings<>OLD.warnings OR NEW.published_at IS DISTINCT FROM OLD.published_at THEN
      RAISE EXCEPTION 'Published Git snapshot content and counts are immutable' USING ERRCODE='23514';
    END IF;
    IF NOT (OLD.state='published' AND NEW.state IN ('published','superseded')
      OR OLD.state='superseded' AND NEW.state='superseded') THEN
      RAISE EXCEPTION 'Published Git snapshot lifecycle transition is invalid' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER git_snapshots_published_immutable
  BEFORE UPDATE ON git_snapshots
  FOR EACH ROW EXECUTE FUNCTION prevent_published_snapshot_rewrite();

CREATE OR REPLACE FUNCTION validate_git_page_source()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE page_source text;
BEGIN
  SELECT source_type INTO page_source
    FROM pages WHERE workspace_id=NEW.workspace_id AND project_id=NEW.project_id AND id=NEW.page_id;
  IF page_source IS DISTINCT FROM 'git' THEN
    RAISE EXCEPTION 'Git page mapping requires a Git-backed page' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER git_pages_validate_page_source
  BEFORE INSERT OR UPDATE OF workspace_id,project_id,page_id ON git_pages
  FOR EACH ROW EXECUTE FUNCTION validate_git_page_source();

CREATE OR REPLACE FUNCTION prevent_prepared_git_definition_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.workspace_id<>OLD.workspace_id OR NEW.project_id<>OLD.project_id
    OR NEW.repository_link_id<>OLD.repository_link_id OR NEW.selected_branch_id<>OLD.selected_branch_id
    OR NEW.operation_kind<>OLD.operation_kind OR NEW.base_head_oid<>OLD.base_head_oid
    OR NEW.target_branch<>OLD.target_branch
    OR NEW.pull_request_base_branch IS DISTINCT FROM OLD.pull_request_base_branch
    OR NEW.commit_message<>OLD.commit_message
    OR NEW.pull_request_title IS DISTINCT FROM OLD.pull_request_title
    OR NEW.pull_request_body IS DISTINCT FROM OLD.pull_request_body
    OR NEW.file_operations<>OLD.file_operations OR NEW.normalized_diff<>OLD.normalized_diff
    OR NEW.action_digest<>OLD.action_digest OR NEW.risk_level<>OLD.risk_level
    OR NEW.confirmation_id IS DISTINCT FROM OLD.confirmation_id
    OR NEW.actor_principal_id<>OLD.actor_principal_id
    OR NEW.authorizing_principal_id<>OLD.authorizing_principal_id
    OR NEW.expires_at<>OLD.expires_at THEN
    RAISE EXCEPTION 'Prepared Git operation definition is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER prepared_git_operations_definition_immutable
  BEFORE UPDATE ON prepared_git_operations
  FOR EACH ROW EXECUTE FUNCTION prevent_prepared_git_definition_change();

CREATE OR REPLACE FUNCTION protect_completed_provider_operation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state='succeeded' AND (
    NEW.state<>OLD.state OR NEW.provider_identifier IS DISTINCT FROM OLD.provider_identifier
    OR NEW.response_summary IS DISTINCT FROM OLD.response_summary
    OR NEW.request_digest<>OLD.request_digest OR NEW.step_key<>OLD.step_key
  ) THEN
    RAISE EXCEPTION 'Successful Git provider operation is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER git_provider_operations_success_immutable
  BEFORE UPDATE ON git_provider_operations
  FOR EACH ROW EXECUTE FUNCTION protect_completed_provider_operation();

CREATE OR REPLACE FUNCTION validate_webhook_payload_summary_size()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_column_size(NEW.payload_summary)>262144 THEN
    RAISE EXCEPTION 'GitHub webhook payload summary exceeds 256 KiB' USING ERRCODE='22001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER github_webhook_payload_summary_bounded
  BEFORE INSERT OR UPDATE OF payload_summary ON github_webhook_deliveries
  FOR EACH ROW EXECUTE FUNCTION validate_webhook_payload_summary_size();

REVOKE DELETE ON TABLE workspace_invitations,workspace_storage_configs,
  operational_drills,legacy_import_runs,legacy_import_records,
  github_installation_states,github_app_installations,github_webhook_deliveries,
  github_repositories,project_repository_links,selected_git_branches,git_snapshots,
  git_snapshot_files,git_pages,prepared_git_operations,git_provider_operations,
  git_pull_requests,github_rate_limit_observations
FROM folio_runtime;
REVOKE UPDATE,DELETE ON TABLE git_snapshot_files FROM folio_runtime,folio_worker;

CREATE POLICY folio_worker_git_pages ON pages
  AS RESTRICTIVE TO folio_worker
  USING (source_type='git') WITH CHECK (source_type='git');
CREATE POLICY folio_worker_git_search ON page_search_documents
  AS RESTRICTIVE TO folio_worker
  USING (source_type='git') WITH CHECK (source_type='git');
CREATE POLICY folio_worker_git_activity_insert ON activity_events
  AS RESTRICTIVE TO folio_worker
  FOR INSERT WITH CHECK (source='worker');
CREATE POLICY folio_worker_git_outbox_insert ON outbox_events
  AS RESTRICTIVE TO folio_worker
  FOR INSERT WITH CHECK (true);
