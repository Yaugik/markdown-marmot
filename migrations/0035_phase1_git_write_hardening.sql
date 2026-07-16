ALTER TABLE prepared_git_operations
  ADD COLUMN policy_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN target_ref_oid text,
  ADD COLUMN execution_job_id uuid,
  ADD CONSTRAINT prepared_git_operations_policy_snapshot_object
    CHECK (jsonb_typeof(policy_snapshot)='object'),
  ADD CONSTRAINT prepared_git_operations_target_ref_oid_format
    CHECK (target_ref_oid IS NULL OR target_ref_oid ~ '^[a-f0-9]{40,64}$'),
  ADD CONSTRAINT prepared_git_operations_execution_job_fk
    FOREIGN KEY (execution_job_id) REFERENCES jobs(id);

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
    OR NEW.expires_at<>OLD.expires_at
    OR NEW.policy_snapshot<>OLD.policy_snapshot
    OR NEW.target_ref_oid IS DISTINCT FROM OLD.target_ref_oid THEN
    RAISE EXCEPTION 'Prepared Git operation definition is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE INDEX prepared_git_operations_execution_job_idx
  ON prepared_git_operations(execution_job_id)
  WHERE execution_job_id IS NOT NULL;
