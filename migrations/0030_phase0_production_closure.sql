CREATE TABLE workspace_invitations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  email_normalized text NOT NULL CHECK (email_normalized = lower(trim(email_normalized))),
  token_digest text NOT NULL CHECK (token_digest ~ '^[a-f0-9]{64}$'),
  workspace_role text NOT NULL DEFAULT 'member' CHECK (workspace_role = 'member'),
  project_assignments jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','revoked','expired')),
  invited_by_principal_id uuid NOT NULL REFERENCES principals(id),
  accepted_by_principal_id uuid REFERENCES principals(id),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (token_digest),
  CHECK (jsonb_typeof(project_assignments) = 'array'),
  CHECK (expires_at > created_at),
  CHECK ((status = 'accepted') = (accepted_at IS NOT NULL)),
  CHECK (accepted_at IS NULL OR accepted_by_principal_id IS NOT NULL),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);

CREATE UNIQUE INDEX workspace_invitations_active_email_idx
  ON workspace_invitations(workspace_id,email_normalized)
  WHERE status='pending';
CREATE INDEX workspace_invitations_expiry_idx
  ON workspace_invitations(expires_at) WHERE status='pending';

CREATE TABLE workspace_storage_configs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL UNIQUE REFERENCES workspaces(id),
  provider text NOT NULL CHECK (provider IN ('filesystem','s3')),
  bucket text,
  region text,
  endpoint text,
  key_prefix text NOT NULL DEFAULT '',
  credential_ref text,
  encryption_key_ref text,
  force_path_style boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','disabled')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by_principal_id uuid NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (provider='filesystem' AND bucket IS NULL AND credential_ref IS NULL)
    OR (provider='s3' AND bucket IS NOT NULL AND region IS NOT NULL AND credential_ref IS NOT NULL)
  )
);

CREATE TABLE operational_drills (
  id uuid PRIMARY KEY,
  workspace_id uuid REFERENCES workspaces(id),
  drill_kind text NOT NULL CHECK (drill_kind IN ('backup','restore','schema_upgrade','schema_downgrade','key_rotation','disaster_recovery')),
  environment text NOT NULL CHECK (length(trim(environment)) BETWEEN 1 AND 120),
  state text NOT NULL DEFAULT 'running' CHECK (state IN ('running','succeeded','failed')),
  artifact_ref text,
  artifact_sha256 text CHECK (artifact_sha256 IS NULL OR artifact_sha256 ~ '^[a-f0-9]{64}$'),
  source_schema_version text,
  target_schema_version text,
  started_by_principal_id uuid NOT NULL REFERENCES principals(id),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  result_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  failure_code text,
  failure_message text,
  CHECK (jsonb_typeof(result_summary)='object'),
  CHECK ((state='running') = (completed_at IS NULL))
);
CREATE INDEX operational_drills_workspace_time_idx
  ON operational_drills(workspace_id,started_at DESC);

CREATE TABLE legacy_import_runs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  source_fingerprint text NOT NULL CHECK (source_fingerprint ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'running' CHECK (state IN ('running','succeeded','succeeded_with_warnings','failed','canceled')),
  cursor jsonb NOT NULL DEFAULT '{}'::jsonb,
  discovered_count integer NOT NULL DEFAULT 0 CHECK (discovered_count >= 0),
  imported_count integer NOT NULL DEFAULT 0 CHECK (imported_count >= 0),
  skipped_count integer NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  failed_count integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  created_by_principal_id uuid NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  last_error_code text,
  last_error_message text,
  UNIQUE (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id,project_id) REFERENCES projects(workspace_id,id),
  CHECK (jsonb_typeof(cursor)='object')
);

CREATE TABLE legacy_import_records (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  import_run_id uuid NOT NULL,
  legacy_entity_type text NOT NULL CHECK (legacy_entity_type IN ('repository','sync_source','document','activity')),
  legacy_entity_id text NOT NULL CHECK (length(legacy_entity_id) BETWEEN 1 AND 240),
  source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  target_entity_type text,
  target_entity_id uuid,
  state text NOT NULL CHECK (state IN ('imported','skipped','failed')),
  warning_code text,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (import_run_id,legacy_entity_type,legacy_entity_id),
  FOREIGN KEY (workspace_id,project_id,import_run_id)
    REFERENCES legacy_import_runs(workspace_id,project_id,id)
);
CREATE INDEX legacy_import_records_run_state_idx
  ON legacy_import_records(import_run_id,state,created_at);

GRANT SELECT,INSERT,UPDATE ON TABLE
  workspace_invitations,workspace_storage_configs,operational_drills,
  legacy_import_runs,legacy_import_records
TO folio_runtime;

DO $$
DECLARE table_name text; owner_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'workspace_invitations','workspace_storage_configs','operational_drills',
    'legacy_import_runs','legacy_import_records'
  ] LOOP
    SELECT pg_get_userbyid(c.relowner) INTO owner_name
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relname=table_name AND c.relkind='r';
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY folio_migration_owner_access ON public.%I TO %I USING (true) WITH CHECK (true)',table_name,owner_name);
  END LOOP;
END $$;

CREATE POLICY folio_runtime_workspace_invitations ON workspace_invitations
  TO folio_runtime USING (workspace_id=folio.current_workspace_id())
  WITH CHECK (workspace_id=folio.current_workspace_id());
CREATE POLICY folio_runtime_workspace_storage ON workspace_storage_configs
  TO folio_runtime USING (workspace_id=folio.current_workspace_id())
  WITH CHECK (workspace_id=folio.current_workspace_id());
CREATE POLICY folio_runtime_operational_drills ON operational_drills
  TO folio_runtime USING (workspace_id IS NULL OR workspace_id=folio.current_workspace_id())
  WITH CHECK (workspace_id IS NULL OR workspace_id=folio.current_workspace_id());
CREATE POLICY folio_runtime_legacy_import_runs ON legacy_import_runs
  TO folio_runtime USING (workspace_id=folio.current_workspace_id())
  WITH CHECK (workspace_id=folio.current_workspace_id());
CREATE POLICY folio_runtime_legacy_import_records ON legacy_import_records
  TO folio_runtime USING (workspace_id=folio.current_workspace_id())
  WITH CHECK (workspace_id=folio.current_workspace_id());
