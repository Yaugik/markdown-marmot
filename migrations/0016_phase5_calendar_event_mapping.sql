CREATE TABLE external_calendar_event_mappings (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  binding_id uuid NOT NULL,
  external_event_id text NOT NULL CHECK (length(trim(external_event_id)) BETWEEN 1 AND 500),
  calendar_entry_id uuid,
  etag text,
  provider_updated_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (binding_id, external_event_id),
  UNIQUE (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, binding_id)
    REFERENCES calendar_external_bindings(workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, calendar_entry_id)
    REFERENCES calendar_entries(workspace_id, project_id, id),
  CHECK ((deleted_at IS NULL) OR calendar_entry_id IS NOT NULL)
);

CREATE INDEX external_calendar_event_entry_idx
  ON external_calendar_event_mappings(calendar_entry_id)
  WHERE calendar_entry_id IS NOT NULL;
CREATE INDEX external_calendar_event_seen_idx
  ON external_calendar_event_mappings(binding_id, last_seen_at DESC);

GRANT SELECT, INSERT, UPDATE ON TABLE external_calendar_event_mappings TO folio_runtime;

ALTER TABLE external_calendar_event_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_calendar_event_mappings FORCE ROW LEVEL SECURITY;

DO $$
DECLARE owner_name text;
BEGIN
  SELECT pg_get_userbyid(c.relowner) INTO owner_name
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname='external_calendar_event_mappings' AND c.relkind='r';
  EXECUTE format(
    'CREATE POLICY folio_migration_owner_access ON external_calendar_event_mappings TO %I USING (true) WITH CHECK (true)',
    owner_name
  );
END
$$;

CREATE POLICY folio_runtime_workspace_scope ON external_calendar_event_mappings TO folio_runtime
  USING (workspace_id = folio.current_workspace_id())
  WITH CHECK (workspace_id = folio.current_workspace_id());
