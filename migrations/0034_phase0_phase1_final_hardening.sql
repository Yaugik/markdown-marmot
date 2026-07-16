DO $$
DECLARE constraint_name text;
BEGIN
  SELECT conname INTO constraint_name
  FROM pg_constraint
  WHERE conrelid='git_snapshots'::regclass
    AND contype='c'
    AND pg_get_constraintdef(oid) ILIKE '%state%published%published_at%'
  LIMIT 1;
  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE git_snapshots DROP CONSTRAINT %I',constraint_name);
  END IF;
END $$;

ALTER TABLE git_snapshots
  ADD CONSTRAINT git_snapshots_publication_state_consistent CHECK (
    (state IN ('published','superseded')) = (published_at IS NOT NULL)
  );

DO $$
DECLARE constraint_name text;
BEGIN
  SELECT conname INTO constraint_name
  FROM pg_constraint
  WHERE conrelid='git_snapshots'::regclass
    AND contype='u'
    AND pg_get_constraintdef(oid) ILIKE '%selected_branch_id%head_oid%rules_version%parser_version%'
  LIMIT 1;
  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE git_snapshots DROP CONSTRAINT %I',constraint_name);
  END IF;
END $$;
CREATE UNIQUE INDEX git_snapshots_active_identity_idx
  ON git_snapshots(selected_branch_id,head_oid,rules_version,parser_version)
  WHERE state IN ('candidate','published');

CREATE OR REPLACE FUNCTION folio.lookup_workspace_invitation(
  invitation_digest text,
  accepting_principal_id uuid
)
RETURNS TABLE(
  id uuid,
  workspace_id uuid,
  email_normalized text,
  status text,
  project_assignments jsonb,
  invited_by_principal_id uuid,
  expires_at timestamptz,
  revision bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
SET row_security=off
AS $$
DECLARE principal_email text;
BEGIN
  SELECT lower(user_account.primary_email) INTO principal_email
  FROM principals principal
  JOIN users user_account ON user_account.id=principal.user_id
  WHERE principal.id=accepting_principal_id
    AND principal.kind='human'
    AND principal.status='active';
  IF principal_email IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT invitation.id,invitation.workspace_id,invitation.email_normalized,
      invitation.status,invitation.project_assignments,
      invitation.invited_by_principal_id,invitation.expires_at,invitation.revision
    FROM workspace_invitations invitation
    WHERE invitation.token_digest=invitation_digest
      AND invitation.email_normalized=principal_email;
END
$$;
REVOKE ALL ON FUNCTION folio.lookup_workspace_invitation(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION folio.lookup_workspace_invitation(text,uuid) TO folio_runtime;

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='folio_webhook') THEN
    CREATE ROLE folio_webhook
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  EXECUTE format('GRANT folio_webhook TO %I',current_user);
END $$;

GRANT USAGE ON SCHEMA public TO folio_webhook;
GRANT SELECT ON TABLE github_app_installations,github_repositories,
  project_repository_links,selected_git_branches TO folio_webhook;
GRANT SELECT,INSERT,UPDATE ON TABLE github_webhook_deliveries TO folio_webhook;
GRANT SELECT,INSERT ON TABLE jobs TO folio_webhook;
GRANT UPDATE(state,revision,updated_at) ON TABLE github_app_installations TO folio_webhook;
GRANT DELETE ON TABLE page_search_documents TO folio_worker;

CREATE POLICY folio_webhook_installation_lookup ON github_app_installations
  TO folio_webhook USING (true);
CREATE POLICY folio_webhook_repository_lookup ON github_repositories
  TO folio_webhook USING (true);
CREATE POLICY folio_webhook_link_lookup ON project_repository_links
  TO folio_webhook USING (true);
CREATE POLICY folio_webhook_branch_lookup ON selected_git_branches
  TO folio_webhook USING (true);
CREATE POLICY folio_webhook_delivery_access ON github_webhook_deliveries
  TO folio_webhook USING (true) WITH CHECK (true);
CREATE POLICY folio_webhook_job_insert ON jobs
  TO folio_webhook FOR INSERT WITH CHECK (
    kind IN ('github.repository.refresh','github.branch.reconcile')
    AND workspace_id IS NOT NULL
  );
CREATE POLICY folio_webhook_job_read ON jobs
  TO folio_webhook FOR SELECT USING (
    kind IN ('github.repository.refresh','github.branch.reconcile')
  );

CREATE OR REPLACE FUNCTION validate_git_snapshot_file_parent_state()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE snapshot_state text;
BEGIN
  SELECT state INTO snapshot_state FROM git_snapshots
  WHERE workspace_id=NEW.workspace_id AND project_id=NEW.project_id AND id=NEW.snapshot_id;
  IF snapshot_state IS DISTINCT FROM 'candidate' THEN
    RAISE EXCEPTION 'Git snapshot files may only be inserted into candidate snapshots'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER git_snapshot_files_candidate_only
  BEFORE INSERT ON git_snapshot_files
  FOR EACH ROW EXECUTE FUNCTION validate_git_snapshot_file_parent_state();

CREATE OR REPLACE FUNCTION validate_prepared_git_confirmation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE confirmation_record record;
BEGIN
  IF NEW.risk_level='R1' THEN
    IF NEW.confirmation_id IS NOT NULL THEN
      RAISE EXCEPTION 'R1 Git operation must not bind an R2 confirmation' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO confirmation_record FROM action_confirmations
  WHERE workspace_id=NEW.workspace_id AND id=NEW.confirmation_id;
  IF confirmation_record.id IS NULL
    OR confirmation_record.project_id IS DISTINCT FROM NEW.project_id
    OR confirmation_record.actor_principal_id<>NEW.actor_principal_id
    OR confirmation_record.authorizing_principal_id<>NEW.authorizing_principal_id
    OR confirmation_record.operation<>'github.write.execute'
    OR confirmation_record.action_digest<>NEW.action_digest
    OR confirmation_record.risk_level<>'R2' THEN
    RAISE EXCEPTION 'R2 Git operation confirmation binding is invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER prepared_git_operations_validate_confirmation
  BEFORE INSERT OR UPDATE OF risk_level,confirmation_id,action_digest,
    actor_principal_id,authorizing_principal_id
  ON prepared_git_operations
  FOR EACH ROW EXECUTE FUNCTION validate_prepared_git_confirmation();
