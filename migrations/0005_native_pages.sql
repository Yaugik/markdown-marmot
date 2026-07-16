CREATE TABLE pages (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id uuid NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('git', 'native')),
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'unavailable')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_principal_id uuid NOT NULL REFERENCES principals(id),
  updated_by_principal_id uuid NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id)
);

CREATE TABLE native_pages (
  page_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  current_revision_id uuid,
  editor_schema_version integer NOT NULL DEFAULT 1 CHECK (editor_schema_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, project_id, page_id),
  FOREIGN KEY (workspace_id, project_id, page_id)
    REFERENCES pages(workspace_id, project_id, id)
);

CREATE TABLE native_page_revisions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  page_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  editor_schema_version integer NOT NULL CHECK (editor_schema_version > 0),
  content jsonb NOT NULL,
  plain_text text NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  author_principal_id uuid NOT NULL REFERENCES principals(id),
  parent_revision_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (page_id, sequence),
  UNIQUE (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, page_id)
    REFERENCES native_pages(workspace_id, project_id, page_id)
);

ALTER TABLE native_page_revisions
  ADD CONSTRAINT native_page_revisions_parent_fk
  FOREIGN KEY (workspace_id, project_id, parent_revision_id)
  REFERENCES native_page_revisions(workspace_id, project_id, id);

ALTER TABLE native_pages
  ADD CONSTRAINT native_pages_current_revision_fk
  FOREIGN KEY (workspace_id, project_id, current_revision_id)
  REFERENCES native_page_revisions(workspace_id, project_id, id);

CREATE TABLE page_tree_nodes (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  parent_node_id uuid,
  node_kind text NOT NULL CHECK (node_kind IN ('folder', 'page', 'alias')),
  page_id uuid,
  rank bigint NOT NULL DEFAULT 1000,
  display_title text CHECK (display_title IS NULL OR length(trim(display_title)) BETWEEN 1 AND 200),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_principal_id uuid NOT NULL REFERENCES principals(id),
  updated_by_principal_id uuid NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (workspace_id, project_id, id),
  CHECK (
    (node_kind = 'folder' AND page_id IS NULL)
    OR (node_kind IN ('page', 'alias') AND page_id IS NOT NULL)
  ),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id),
  FOREIGN KEY (workspace_id, project_id, parent_node_id)
    REFERENCES page_tree_nodes(workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, page_id)
    REFERENCES pages(workspace_id, project_id, id)
);

CREATE INDEX pages_project_status_idx ON pages (project_id, status, updated_at DESC);
CREATE INDEX native_page_revisions_page_sequence_idx
  ON native_page_revisions (page_id, sequence DESC);
CREATE INDEX page_tree_nodes_parent_rank_idx
  ON page_tree_nodes (project_id, parent_node_id, rank, id)
  WHERE archived_at IS NULL;
CREATE UNIQUE INDEX page_tree_nodes_primary_page_idx
  ON page_tree_nodes (page_id)
  WHERE node_kind = 'page' AND archived_at IS NULL;

CREATE OR REPLACE FUNCTION prevent_native_page_revision_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'native_page_revisions are immutable';
END;
$$;

CREATE TRIGGER native_page_revisions_immutable
BEFORE UPDATE OR DELETE ON native_page_revisions
FOR EACH ROW EXECUTE FUNCTION prevent_native_page_revision_mutation();

CREATE TRIGGER native_page_revisions_no_truncate
BEFORE TRUNCATE ON native_page_revisions
FOR EACH STATEMENT EXECUTE FUNCTION prevent_native_page_revision_mutation();

GRANT SELECT, INSERT, UPDATE ON TABLE pages, native_pages, page_tree_nodes TO folio_runtime;
GRANT SELECT, INSERT ON TABLE native_page_revisions TO folio_runtime;

DO $$
DECLARE
  table_name text;
  owner_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'pages',
    'native_pages',
    'native_page_revisions',
    'page_tree_nodes'
  ]
  LOOP
    SELECT pg_get_userbyid(c.relowner)
      INTO owner_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = table_name
       AND c.relkind = 'r';

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY folio_migration_owner_access ON public.%I TO %I USING (true) WITH CHECK (true)',
      table_name,
      owner_name
    );
    EXECUTE format(
      'CREATE POLICY folio_runtime_workspace_scope ON public.%I TO folio_runtime USING (workspace_id = folio.current_workspace_id()) WITH CHECK (workspace_id = folio.current_workspace_id())',
      table_name
    );
  END LOOP;
END
$$;