ALTER TABLE object_grants DROP CONSTRAINT IF EXISTS object_grants_object_type_check;
ALTER TABLE object_grants ADD CONSTRAINT object_grants_object_type_check CHECK (
  object_type IN ('page','issue','saved_view','todo_list','calendar','graph_view','canvas','audit_export')
);

CREATE TABLE page_collaboration_rooms (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  page_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','closing','closed')),
  base_revision_id uuid NOT NULL,
  current_sequence bigint NOT NULL DEFAULT 0 CHECK (current_sequence >= 0),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_principal_id uuid NOT NULL REFERENCES principals(id),
  closed_by_principal_id uuid REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  UNIQUE (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, page_id) REFERENCES native_pages(workspace_id, project_id, page_id),
  FOREIGN KEY (workspace_id, project_id, base_revision_id) REFERENCES native_page_revisions(workspace_id, project_id, id),
  CHECK ((state = 'closed') = (closed_at IS NOT NULL))
);

CREATE UNIQUE INDEX page_collaboration_rooms_active_page_idx
  ON page_collaboration_rooms(page_id) WHERE state IN ('active','closing');

CREATE TABLE page_collaboration_operations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  room_id uuid NOT NULL,
  client_id text NOT NULL CHECK (length(client_id) BETWEEN 1 AND 180),
  client_sequence bigint NOT NULL CHECK (client_sequence > 0),
  base_sequence bigint NOT NULL CHECK (base_sequence >= 0),
  server_sequence bigint NOT NULL CHECK (server_sequence > 0),
  operation jsonb NOT NULL,
  operation_hash text NOT NULL CHECK (operation_hash ~ '^[a-f0-9]{64}$'),
  author_principal_id uuid NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (room_id, server_sequence),
  UNIQUE (room_id, client_id, client_sequence),
  UNIQUE (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, room_id) REFERENCES page_collaboration_rooms(workspace_id, project_id, id),
  CHECK (jsonb_typeof(operation) = 'object')
);

CREATE TABLE page_collaboration_checkpoints (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  room_id uuid NOT NULL,
  server_sequence bigint NOT NULL CHECK (server_sequence >= 0),
  content jsonb NOT NULL,
  plain_text text NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  created_by_principal_id uuid NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (room_id, server_sequence),
  UNIQUE (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, room_id) REFERENCES page_collaboration_rooms(workspace_id, project_id, id)
);

CREATE TABLE scale_measurements (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id uuid,
  component text NOT NULL CHECK (component IN ('search','queue','realtime','database','object_storage')),
  metric_name text NOT NULL CHECK (metric_name ~ '^[a-z][a-z0-9_.:-]{2,119}$'),
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  sample_count bigint NOT NULL CHECK (sample_count >= 0),
  p50 double precision,
  p95 double precision,
  p99 double precision,
  maximum double precision,
  dimensions jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_by_principal_id uuid NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id),
  CHECK (window_end > window_start)
);

CREATE TABLE scale_decisions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id uuid,
  component text NOT NULL CHECK (component IN ('search','queue','realtime','database','object_storage')),
  decision text NOT NULL CHECK (decision IN ('keep_postgres','evaluate_extraction','approve_extraction','reject_extraction')),
  rationale text NOT NULL CHECK (length(trim(rationale)) BETWEEN 1 AND 4000),
  thresholds jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  approved_by_principal_id uuid NOT NULL REFERENCES principals(id),
  effective_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id),
  CHECK (superseded_at IS NULL OR superseded_at > effective_at)
);

CREATE UNIQUE INDEX scale_decisions_current_component_idx
  ON scale_decisions(workspace_id, coalesce(project_id,'00000000-0000-0000-0000-000000000000'::uuid), component)
  WHERE superseded_at IS NULL;

CREATE TABLE workspace_identity_configs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  provider_kind text NOT NULL CHECK (provider_kind IN ('oidc','saml')),
  display_name text NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 120),
  issuer text NOT NULL CHECK (length(trim(issuer)) BETWEEN 1 AND 500),
  secret_reference text NOT NULL CHECK (length(trim(secret_reference)) BETWEEN 1 AND 500),
  allowed_domains text[] NOT NULL DEFAULT '{}',
  attribute_mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','active','disabled','archived')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_principal_id uuid NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, display_name)
);

CREATE TABLE workspace_residency_policies (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id),
  primary_region text NOT NULL CHECK (primary_region ~ '^[a-z][a-z0-9-]{1,39}$'),
  allowed_regions text[] NOT NULL,
  export_region text CHECK (export_region IS NULL OR export_region ~ '^[a-z][a-z0-9-]{1,39}$'),
  customer_managed_key_reference text,
  policy_state text NOT NULL DEFAULT 'enforced' CHECK (policy_state IN ('draft','enforced','suspended')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by_principal_id uuid NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (cardinality(allowed_regions) > 0),
  CHECK (primary_region = ANY(allowed_regions)),
  CHECK (export_region IS NULL OR export_region = ANY(allowed_regions))
);

CREATE TABLE audit_export_requests (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id uuid,
  requested_by_principal_id uuid NOT NULL REFERENCES principals(id),
  format text NOT NULL CHECK (format IN ('jsonl','csv')),
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','succeeded','failed','expired','canceled')),
  object_key text,
  content_hash text CHECK (content_hash IS NULL OR content_hash ~ '^[a-f0-9]{64}$'),
  row_count bigint CHECK (row_count IS NULL OR row_count >= 0),
  expires_at timestamptz NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  last_error_code text,
  last_error_message text,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id),
  CHECK (expires_at > created_at)
);

CREATE TABLE support_access_grants (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  support_principal_id uuid NOT NULL REFERENCES principals(id),
  approved_by_principal_id uuid NOT NULL REFERENCES principals(id),
  confirmation_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  capabilities text[] NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','revoked','expired')),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, confirmation_id) REFERENCES action_confirmations(workspace_id, id),
  CHECK (valid_until > valid_from),
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL))
);

CREATE OR REPLACE FUNCTION prevent_phase5_append_only_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER page_collaboration_operations_immutable
BEFORE UPDATE OR DELETE ON page_collaboration_operations
FOR EACH ROW EXECUTE FUNCTION prevent_phase5_append_only_mutation();

CREATE TRIGGER page_collaboration_operations_no_truncate
BEFORE TRUNCATE ON page_collaboration_operations
FOR EACH STATEMENT EXECUTE FUNCTION prevent_phase5_append_only_mutation();

CREATE INDEX page_collaboration_operations_room_sequence_idx ON page_collaboration_operations(room_id, server_sequence);
CREATE INDEX scale_measurements_component_window_idx ON scale_measurements(component, window_end DESC);
CREATE INDEX audit_export_requests_state_idx ON audit_export_requests(state, created_at) WHERE state IN ('pending','running');
CREATE INDEX support_access_grants_active_idx ON support_access_grants(workspace_id, valid_until) WHERE state='active';

GRANT SELECT, INSERT, UPDATE ON TABLE
  page_collaboration_rooms, page_collaboration_checkpoints, scale_measurements,
  scale_decisions, workspace_identity_configs, workspace_residency_policies,
  audit_export_requests, support_access_grants
TO folio_runtime;
GRANT SELECT, INSERT ON TABLE page_collaboration_operations TO folio_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE audit_export_requests TO folio_worker;

DO $$
DECLARE table_name text; owner_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'page_collaboration_rooms','page_collaboration_operations','page_collaboration_checkpoints',
    'scale_measurements','scale_decisions','workspace_identity_configs',
    'workspace_residency_policies','audit_export_requests','support_access_grants'
  ] LOOP
    SELECT pg_get_userbyid(c.relowner) INTO owner_name
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=table_name AND c.relkind='r';
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY folio_migration_owner_access ON public.%I TO %I USING (true) WITH CHECK (true)',table_name,owner_name);
    EXECUTE format('CREATE POLICY folio_runtime_workspace_scope ON public.%I TO folio_runtime USING (workspace_id=folio.current_workspace_id()) WITH CHECK (workspace_id=folio.current_workspace_id())',table_name);
  END LOOP;
END $$;

CREATE POLICY folio_worker_audit_exports ON audit_export_requests TO folio_worker USING (true) WITH CHECK (true);
