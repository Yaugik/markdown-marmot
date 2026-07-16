CREATE TABLE relationship_derivation_runs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN (
    'page_revision','issue_revision','todo_revision','calendar_revision','provider_observation','agent_synthesis'
  )),
  source_entity_type text NOT NULL CHECK (source_entity_type IN ('page','issue','todo','calendar_entry','canvas')),
  source_entity_id uuid NOT NULL,
  source_revision text NOT NULL CHECK (length(source_revision) BETWEEN 1 AND 180),
  rebuild_key text NOT NULL CHECK (length(rebuild_key) BETWEEN 1 AND 240),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'running' CHECK (state IN ('running','succeeded','failed','superseded')),
  relationship_count integer NOT NULL DEFAULT 0 CHECK (relationship_count >= 0),
  created_by_principal_id uuid NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  last_error_code text,
  last_error_message text,
  UNIQUE (workspace_id, project_id, id),
  UNIQUE (project_id, rebuild_key, source_revision),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id)
);

ALTER TABLE entity_relationships
  ADD COLUMN derivation_run_id uuid,
  ADD CONSTRAINT entity_relationships_derivation_run_fk
    FOREIGN KEY (workspace_id, project_id, derivation_run_id)
    REFERENCES relationship_derivation_runs(workspace_id, project_id, id),
  ADD CONSTRAINT entity_relationships_derived_run_consistent CHECK (
    provenance <> 'derived' OR derivation_run_id IS NOT NULL
  );

ALTER TABLE canvas_elements
  ADD COLUMN promoted_relationship_id uuid,
  ADD CONSTRAINT canvas_elements_promoted_relationship_fk
    FOREIGN KEY (workspace_id, project_id, promoted_relationship_id)
    REFERENCES entity_relationships(workspace_id, project_id, id),
  ADD CONSTRAINT canvas_elements_promoted_relationship_kind CHECK (
    promoted_relationship_id IS NULL OR element_kind = 'connector'
  );

CREATE TABLE canvas_action_previews (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  canvas_id uuid NOT NULL,
  action_kind text NOT NULL CHECK (action_kind IN (
    'promote_connector','convert_sticky','organize_region','prepare_workshop_output'
  )),
  source_element_ids uuid[] NOT NULL DEFAULT '{}',
  normalized_input jsonb NOT NULL,
  snapshot jsonb NOT NULL,
  action_digest text NOT NULL CHECK (action_digest ~ '^[a-f0-9]{64}$'),
  risk_level text NOT NULL CHECK (risk_level IN ('R1','R2')),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN (
    'pending','executing','succeeded','failed','expired','canceled'
  )),
  confirmation_id uuid,
  result jsonb,
  created_by_principal_id uuid NOT NULL REFERENCES principals(id),
  expires_at timestamptz NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  last_error_code text,
  last_error_message text,
  UNIQUE (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, canvas_id) REFERENCES canvases(workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, confirmation_id) REFERENCES action_confirmations(workspace_id, id),
  CHECK (cardinality(source_element_ids) BETWEEN 1 AND 500),
  CHECK (jsonb_typeof(normalized_input) = 'object'),
  CHECK (jsonb_typeof(snapshot) = 'object'),
  CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  CHECK (expires_at > created_at)
);

CREATE INDEX relationship_derivation_runs_source_idx
  ON relationship_derivation_runs(project_id,source_entity_type,source_entity_id,created_at DESC);
CREATE INDEX entity_relationships_derivation_run_idx
  ON entity_relationships(derivation_run_id) WHERE derivation_run_id IS NOT NULL;
CREATE INDEX canvas_action_previews_creator_idx
  ON canvas_action_previews(project_id,created_by_principal_id,created_at DESC);
CREATE INDEX canvas_action_previews_expiry_idx
  ON canvas_action_previews(expires_at) WHERE state IN ('pending','executing');

GRANT SELECT, INSERT, UPDATE ON TABLE relationship_derivation_runs, canvas_action_previews TO folio_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE canvas_elements TO folio_runtime;

DO $$
DECLARE table_name text; owner_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['relationship_derivation_runs','canvas_action_previews'] LOOP
    SELECT pg_get_userbyid(c.relowner) INTO owner_name
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=table_name AND c.relkind='r';
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY folio_migration_owner_access ON public.%I TO %I USING (true) WITH CHECK (true)',table_name,owner_name);
    EXECUTE format('CREATE POLICY folio_runtime_workspace_scope ON public.%I TO folio_runtime USING (workspace_id=folio.current_workspace_id()) WITH CHECK (workspace_id=folio.current_workspace_id())',table_name);
  END LOOP;
END $$;

CREATE POLICY canvas_action_previews_creator_scope ON canvas_action_previews
  AS RESTRICTIVE TO folio_runtime
  USING (created_by_principal_id=folio.current_principal_id())
  WITH CHECK (created_by_principal_id=folio.current_principal_id());
