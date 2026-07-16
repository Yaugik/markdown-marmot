CREATE TABLE github_installation_states (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  principal_id uuid NOT NULL REFERENCES principals(id),
  state_digest text NOT NULL UNIQUE CHECK (state_digest ~ '^[a-f0-9]{64}$'),
  redirect_path text NOT NULL DEFAULT '/',
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

CREATE TABLE github_app_installations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  provider_installation_id bigint NOT NULL UNIQUE CHECK (provider_installation_id > 0),
  account_id bigint NOT NULL CHECK (account_id > 0),
  account_login text NOT NULL CHECK (length(trim(account_login)) BETWEEN 1 AND 255),
  account_type text NOT NULL CHECK (account_type IN ('User','Organization','Enterprise')),
  repository_selection text NOT NULL CHECK (repository_selection IN ('all','selected')),
  permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
  events jsonb NOT NULL DEFAULT '[]'::jsonb,
  credential_key_ref text NOT NULL CHECK (length(trim(credential_key_ref)) BETWEEN 1 AND 500),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','suspended','revoked')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_principal_id uuid NOT NULL REFERENCES principals(id),
  last_validated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id,id),
  CHECK (jsonb_typeof(permissions)='object'),
  CHECK (jsonb_typeof(events)='array')
);
CREATE INDEX github_installations_workspace_state_idx
  ON github_app_installations(workspace_id,state,updated_at DESC);

CREATE TABLE github_webhook_deliveries (
  delivery_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  installation_id uuid NOT NULL,
  event_name text NOT NULL CHECK (event_name IN ('push','repository','installation','installation_repositories','pull_request','branch_protection_rule')),
  action text,
  payload_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','queued','processing','succeeded','ignored','failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  last_error_code text,
  last_error_message text,
  UNIQUE (workspace_id,delivery_id),
  FOREIGN KEY (workspace_id,installation_id)
    REFERENCES github_app_installations(workspace_id,id),
  CHECK (jsonb_typeof(payload_summary)='object')
);
CREATE INDEX github_webhook_delivery_status_idx
  ON github_webhook_deliveries(status,received_at);

CREATE TABLE github_repositories (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  installation_id uuid NOT NULL,
  provider_repository_id bigint NOT NULL CHECK (provider_repository_id > 0),
  owner_login text NOT NULL CHECK (length(trim(owner_login)) BETWEEN 1 AND 255),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 255),
  full_name text NOT NULL CHECK (full_name = owner_login || '/' || name),
  default_branch text NOT NULL CHECK (length(default_branch) BETWEEN 1 AND 255),
  is_private boolean NOT NULL,
  is_archived boolean NOT NULL DEFAULT false,
  permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL DEFAULT 'available' CHECK (state IN ('available','removed','inaccessible')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  provider_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id,id),
  UNIQUE (installation_id,provider_repository_id),
  FOREIGN KEY (workspace_id,installation_id)
    REFERENCES github_app_installations(workspace_id,id),
  CHECK (jsonb_typeof(permissions)='object')
);
CREATE INDEX github_repositories_installation_state_idx
  ON github_repositories(installation_id,state,full_name);

CREATE TABLE project_repository_links (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  repository_id uuid NOT NULL,
  display_name text NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 200),
  write_policy text NOT NULL DEFAULT 'pull_request_only'
    CHECK (write_policy IN ('disabled','pull_request_only','direct_allowed')),
  include_rules text[] NOT NULL DEFAULT ARRAY['**/*.md','**/*.markdown']::text[],
  exclude_rules text[] NOT NULL DEFAULT '{}',
  rules_version bigint NOT NULL DEFAULT 1 CHECK (rules_version > 0),
  parser_version text NOT NULL DEFAULT 'legacy-marked-v1' CHECK (length(parser_version) BETWEEN 1 AND 100),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','disabled','removed')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_principal_id uuid NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id,project_id,id),
  UNIQUE (project_id,repository_id),
  FOREIGN KEY (workspace_id,project_id) REFERENCES projects(workspace_id,id),
  FOREIGN KEY (workspace_id,repository_id) REFERENCES github_repositories(workspace_id,id),
  CHECK (cardinality(include_rules) BETWEEN 1 AND 100),
  CHECK (cardinality(exclude_rules) <= 100)
);
CREATE INDEX project_repository_links_project_state_idx
  ON project_repository_links(project_id,state,updated_at DESC);

CREATE TABLE selected_git_branches (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  repository_link_id uuid NOT NULL,
  branch_name text NOT NULL CHECK (length(branch_name) BETWEEN 1 AND 255),
  state text NOT NULL DEFAULT 'enabled' CHECK (state IN ('enabled','disabled','inaccessible')),
  active_snapshot_id uuid,
  last_observed_head_oid text CHECK (last_observed_head_oid IS NULL OR last_observed_head_oid ~ '^[a-f0-9]{40,64}$'),
  last_reconciled_at timestamptz,
  lease_owner text,
  lease_expires_at timestamptz,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_principal_id uuid NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id,project_id,id),
  UNIQUE (repository_link_id,branch_name),
  FOREIGN KEY (workspace_id,project_id,repository_link_id)
    REFERENCES project_repository_links(workspace_id,project_id,id)
);
CREATE INDEX selected_git_branches_reconcile_idx
  ON selected_git_branches(state,last_reconciled_at,updated_at)
  WHERE state='enabled';

CREATE TABLE git_snapshots (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  selected_branch_id uuid NOT NULL,
  head_oid text NOT NULL CHECK (head_oid ~ '^[a-f0-9]{40,64}$'),
  state text NOT NULL DEFAULT 'candidate'
    CHECK (state IN ('candidate','published','failed','superseded','discarded')),
  rules_version bigint NOT NULL CHECK (rules_version > 0),
  parser_version text NOT NULL CHECK (length(parser_version) BETWEEN 1 AND 100),
  inventory_hash text CHECK (inventory_hash IS NULL OR inventory_hash ~ '^[a-f0-9]{64}$'),
  file_count integer NOT NULL DEFAULT 0 CHECK (file_count >= 0),
  added_count integer NOT NULL DEFAULT 0 CHECK (added_count >= 0),
  changed_count integer NOT NULL DEFAULT 0 CHECK (changed_count >= 0),
  removed_count integer NOT NULL DEFAULT 0 CHECK (removed_count >= 0),
  unchanged_count integer NOT NULL DEFAULT 0 CHECK (unchanged_count >= 0),
  warning_count integer NOT NULL DEFAULT 0 CHECK (warning_count >= 0),
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  failure_code text,
  failure_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  completed_at timestamptz,
  UNIQUE (workspace_id,project_id,id),
  UNIQUE (selected_branch_id,head_oid,rules_version,parser_version),
  FOREIGN KEY (workspace_id,project_id,selected_branch_id)
    REFERENCES selected_git_branches(workspace_id,project_id,id),
  CHECK (jsonb_typeof(warnings)='array'),
  CHECK ((state='published') = (published_at IS NOT NULL))
);
CREATE INDEX git_snapshots_branch_time_idx
  ON git_snapshots(selected_branch_id,created_at DESC);

ALTER TABLE selected_git_branches
  ADD CONSTRAINT selected_git_branches_active_snapshot_fk
  FOREIGN KEY (workspace_id,project_id,active_snapshot_id)
  REFERENCES git_snapshots(workspace_id,project_id,id);

CREATE TABLE git_snapshot_files (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  source_path text NOT NULL CHECK (
    length(source_path) BETWEEN 1 AND 1000
    AND source_path !~ '(^|/)\.\.(/|$)'
    AND source_path !~ '^/'
    AND source_path ~* '\.(md|markdown)$'
  ),
  blob_oid text NOT NULL CHECK (blob_oid ~ '^[a-f0-9]{40,64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 0 AND 2097152),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  markdown text NOT NULL,
  rendered_html text NOT NULL,
  plain_text text NOT NULL,
  headings jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id,project_id,id),
  UNIQUE (snapshot_id,source_path),
  FOREIGN KEY (workspace_id,project_id,snapshot_id)
    REFERENCES git_snapshots(workspace_id,project_id,id),
  CHECK (jsonb_typeof(headings)='array')
);
CREATE INDEX git_snapshot_files_snapshot_path_idx
  ON git_snapshot_files(snapshot_id,source_path);

CREATE TABLE git_pages (
  page_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  selected_branch_id uuid NOT NULL,
  source_path text NOT NULL,
  current_snapshot_file_id uuid NOT NULL,
  current_head_oid text NOT NULL CHECK (current_head_oid ~ '^[a-f0-9]{40,64}$'),
  current_blob_oid text NOT NULL CHECK (current_blob_oid ~ '^[a-f0-9]{40,64}$'),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  markdown text NOT NULL,
  rendered_html text NOT NULL,
  plain_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id,project_id,page_id),
  UNIQUE (selected_branch_id,source_path),
  FOREIGN KEY (workspace_id,project_id,page_id) REFERENCES pages(workspace_id,project_id,id),
  FOREIGN KEY (workspace_id,project_id,selected_branch_id)
    REFERENCES selected_git_branches(workspace_id,project_id,id),
  FOREIGN KEY (workspace_id,project_id,current_snapshot_file_id)
    REFERENCES git_snapshot_files(workspace_id,project_id,id)
);
CREATE INDEX git_pages_branch_path_idx ON git_pages(selected_branch_id,source_path);

GRANT SELECT,INSERT,UPDATE ON TABLE
  github_installation_states,github_app_installations,github_webhook_deliveries,
  github_repositories,project_repository_links,selected_git_branches,git_snapshots,
  git_snapshot_files,git_pages
TO folio_runtime;
GRANT SELECT,INSERT,UPDATE ON TABLE
  github_webhook_deliveries,github_app_installations,github_repositories,
  selected_git_branches,git_snapshots,git_snapshot_files,git_pages,
  project_repository_links,pages,page_search_documents,outbox_events,activity_events,jobs
TO folio_worker;

DO $$
DECLARE table_name text; owner_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'github_installation_states','github_app_installations','github_webhook_deliveries',
    'github_repositories','project_repository_links','selected_git_branches','git_snapshots',
    'git_snapshot_files','git_pages'
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
