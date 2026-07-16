CREATE TABLE prepared_git_operations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  repository_link_id uuid NOT NULL,
  selected_branch_id uuid NOT NULL,
  operation_kind text NOT NULL CHECK (operation_kind IN ('commit','commit_and_pull_request','direct_update')),
  base_head_oid text NOT NULL CHECK (base_head_oid ~ '^[a-f0-9]{40,64}$'),
  target_branch text NOT NULL CHECK (length(target_branch) BETWEEN 1 AND 255),
  pull_request_base_branch text,
  commit_message text NOT NULL CHECK (length(trim(commit_message)) BETWEEN 1 AND 1000),
  pull_request_title text CHECK (pull_request_title IS NULL OR length(trim(pull_request_title)) BETWEEN 1 AND 240),
  pull_request_body text,
  file_operations jsonb NOT NULL,
  normalized_diff text NOT NULL,
  action_digest text NOT NULL CHECK (action_digest ~ '^[a-f0-9]{64}$'),
  risk_level text NOT NULL CHECK (risk_level IN ('R1','R2')),
  state text NOT NULL DEFAULT 'prepared'
    CHECK (state IN ('prepared','executing','succeeded','failed','expired','canceled')),
  confirmation_id uuid,
  actor_principal_id uuid NOT NULL REFERENCES principals(id),
  authorizing_principal_id uuid NOT NULL REFERENCES principals(id),
  expires_at timestamptz NOT NULL,
  provider_result jsonb,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  last_error_code text,
  last_error_message text,
  UNIQUE (workspace_id,project_id,id),
  FOREIGN KEY (workspace_id,project_id,repository_link_id)
    REFERENCES project_repository_links(workspace_id,project_id,id),
  FOREIGN KEY (workspace_id,project_id,selected_branch_id)
    REFERENCES selected_git_branches(workspace_id,project_id,id),
  FOREIGN KEY (workspace_id,confirmation_id)
    REFERENCES action_confirmations(workspace_id,id),
  CHECK (jsonb_typeof(file_operations)='array'),
  CHECK (jsonb_array_length(file_operations) BETWEEN 1 AND 100),
  CHECK (provider_result IS NULL OR jsonb_typeof(provider_result)='object'),
  CHECK (expires_at > created_at),
  CHECK ((operation_kind='commit_and_pull_request') = (pull_request_base_branch IS NOT NULL))
);
CREATE INDEX prepared_git_operations_actor_state_idx
  ON prepared_git_operations(project_id,actor_principal_id,state,created_at DESC);
CREATE INDEX prepared_git_operations_expiry_idx
  ON prepared_git_operations(expires_at) WHERE state='prepared';

CREATE TABLE git_provider_operations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  prepared_operation_id uuid NOT NULL,
  step_kind text NOT NULL CHECK (step_kind IN ('create_blob','create_tree','create_commit','create_ref','update_ref','create_pull_request','reconcile_after_write')),
  step_key text NOT NULL CHECK (length(step_key) BETWEEN 1 AND 240),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','succeeded','failed','waiting_provider')),
  provider_identifier text,
  response_summary jsonb,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  last_error_code text,
  last_error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (workspace_id,project_id,id),
  UNIQUE (prepared_operation_id,step_kind,step_key),
  FOREIGN KEY (workspace_id,project_id,prepared_operation_id)
    REFERENCES prepared_git_operations(workspace_id,project_id,id),
  CHECK (response_summary IS NULL OR jsonb_typeof(response_summary)='object')
);
CREATE INDEX git_provider_operations_work_idx
  ON git_provider_operations(state,available_at,created_at)
  WHERE state IN ('pending','waiting_provider','failed');

CREATE TABLE git_pull_requests (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  repository_link_id uuid NOT NULL,
  prepared_operation_id uuid,
  provider_number integer NOT NULL CHECK (provider_number > 0),
  provider_node_id text,
  html_url text NOT NULL,
  head_branch text NOT NULL,
  base_branch text NOT NULL,
  title text NOT NULL,
  state text NOT NULL CHECK (state IN ('open','closed','merged')),
  provider_created_at timestamptz,
  provider_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id,project_id,id),
  UNIQUE (repository_link_id,provider_number),
  FOREIGN KEY (workspace_id,project_id,repository_link_id)
    REFERENCES project_repository_links(workspace_id,project_id,id),
  FOREIGN KEY (workspace_id,project_id,prepared_operation_id)
    REFERENCES prepared_git_operations(workspace_id,project_id,id)
);
CREATE INDEX git_pull_requests_project_state_idx
  ON git_pull_requests(project_id,state,updated_at DESC);

CREATE TABLE github_rate_limit_observations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  installation_id uuid NOT NULL,
  resource text NOT NULL,
  remaining integer CHECK (remaining IS NULL OR remaining >= 0),
  limit_value integer CHECK (limit_value IS NULL OR limit_value >= 0),
  reset_at timestamptz,
  retry_after_seconds integer CHECK (retry_after_seconds IS NULL OR retry_after_seconds >= 0),
  observed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id,id),
  FOREIGN KEY (workspace_id,installation_id)
    REFERENCES github_app_installations(workspace_id,id)
);
CREATE INDEX github_rate_limit_observations_installation_idx
  ON github_rate_limit_observations(installation_id,observed_at DESC);

GRANT SELECT,INSERT,UPDATE ON TABLE
  prepared_git_operations,git_provider_operations,git_pull_requests,
  github_rate_limit_observations
TO folio_runtime;
GRANT SELECT,INSERT,UPDATE ON TABLE
  prepared_git_operations,git_provider_operations,git_pull_requests,
  github_rate_limit_observations
TO folio_worker;

DO $$
DECLARE table_name text; owner_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'prepared_git_operations','git_provider_operations','git_pull_requests',
    'github_rate_limit_observations'
  ] LOOP
    SELECT pg_get_userbyid(c.relowner) INTO owner_name
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relname=table_name AND c.relkind='r';
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY folio_migration_owner_access ON public.%I TO %I USING (true) WITH CHECK (true)',table_name,owner_name);
    EXECUTE format('CREATE POLICY folio_runtime_workspace_scope ON public.%I TO folio_runtime USING (workspace_id=folio.current_workspace_id()) WITH CHECK (workspace_id=folio.current_workspace_id())',table_name);
    EXECUTE format('CREATE POLICY folio_worker_workspace_access ON public.%I TO folio_worker USING (true) WITH CHECK (true)',table_name);
  END LOOP;
END $$;
