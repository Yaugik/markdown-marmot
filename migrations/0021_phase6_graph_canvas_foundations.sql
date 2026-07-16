CREATE TABLE relationship_types (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  type_key text NOT NULL CHECK (type_key ~ '^[a-z][a-z0-9_.:-]{1,79}$'),
  display_name text NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 120),
  source_entity_types text[] NOT NULL,
  target_entity_types text[] NOT NULL,
  symmetric boolean NOT NULL DEFAULT false,
  inverse_type_key text,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','disabled','archived')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_principal_id uuid NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (workspace_id, project_id, id),
  UNIQUE (project_id, type_key),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id),
  CHECK (cardinality(source_entity_types) > 0),
  CHECK (cardinality(target_entity_types) > 0)
);

CREATE TABLE canvases (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  owner_principal_id uuid NOT NULL REFERENCES principals(id),
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','project')),
  scene_version integer NOT NULL DEFAULT 1 CHECK (scene_version > 0),
  current_revision_id uuid,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_principal_id uuid NOT NULL REFERENCES principals(id),
  updated_by_principal_id uuid NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id)
);

CREATE TABLE entity_relationships (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  relationship_type_id uuid NOT NULL,
  source_entity_type text NOT NULL CHECK (source_entity_type IN ('page','issue','todo','calendar_entry','canvas')),
  source_entity_id uuid NOT NULL,
  target_entity_type text NOT NULL CHECK (target_entity_type IN ('page','issue','todo','calendar_entry','canvas')),
  target_entity_id uuid NOT NULL,
  provenance text NOT NULL CHECK (provenance IN ('explicit','derived','suggested','canvas_only')),
  canvas_id uuid,
  confidence double precision CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','accepted','rejected','archived')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_principal_id uuid NOT NULL REFERENCES principals(id),
  updated_by_principal_id uuid NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, relationship_type_id) REFERENCES relationship_types(workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, canvas_id) REFERENCES canvases(workspace_id, project_id, id),
  CHECK (source_entity_id <> target_entity_id OR source_entity_type <> target_entity_type),
  CHECK ((provenance = 'canvas_only') = (canvas_id IS NOT NULL))
);

CREATE UNIQUE INDEX entity_relationships_active_unique_idx
  ON entity_relationships(relationship_type_id,source_entity_type,source_entity_id,target_entity_type,target_entity_id,provenance,coalesce(canvas_id,'00000000-0000-0000-0000-000000000000'::uuid))
  WHERE archived_at IS NULL AND state IN ('active','accepted');

CREATE TABLE saved_graph_views (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  owner_principal_id uuid NOT NULL REFERENCES principals(id),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','project')),
  root_entities jsonb NOT NULL DEFAULT '[]'::jsonb,
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  traversal jsonb NOT NULL DEFAULT '{"depth":2,"limit":500}'::jsonb,
  layout jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_principal_id uuid NOT NULL REFERENCES principals(id),
  updated_by_principal_id uuid NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (workspace_id, project_id, id),
  UNIQUE (project_id, owner_principal_id, name),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id),
  CHECK (jsonb_typeof(root_entities) = 'array'),
  CHECK (jsonb_typeof(filters) = 'object'),
  CHECK (jsonb_typeof(traversal) = 'object'),
  CHECK (jsonb_typeof(layout) = 'object')
);

CREATE TABLE canvas_revisions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  canvas_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  scene_version integer NOT NULL CHECK (scene_version > 0),
  scene jsonb NOT NULL,
  scene_hash text NOT NULL CHECK (scene_hash ~ '^[a-f0-9]{64}$'),
  author_principal_id uuid NOT NULL REFERENCES principals(id),
  parent_revision_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (canvas_id, sequence),
  UNIQUE (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, canvas_id) REFERENCES canvases(workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, parent_revision_id) REFERENCES canvas_revisions(workspace_id, project_id, id),
  CHECK (jsonb_typeof(scene) = 'object')
);

ALTER TABLE canvases ADD CONSTRAINT canvases_current_revision_fk
  FOREIGN KEY (workspace_id, project_id, current_revision_id)
  REFERENCES canvas_revisions(workspace_id, project_id, id);

CREATE TABLE canvas_elements (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  canvas_id uuid NOT NULL,
  element_kind text NOT NULL CHECK (element_kind IN (
    'entity_card','sticky','text','shape','frame','connector','drawing','comment','vote','presentation_region','mermaid'
  )),
  entity_type text CHECK (entity_type IS NULL OR entity_type IN ('page','issue','todo','calendar_entry','canvas')),
  entity_id uuid,
  geometry jsonb NOT NULL DEFAULT '{}'::jsonb,
  content jsonb NOT NULL DEFAULT '{}'::jsonb,
  z_index bigint NOT NULL DEFAULT 0,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_principal_id uuid NOT NULL REFERENCES principals(id),
  updated_by_principal_id uuid NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, canvas_id) REFERENCES canvases(workspace_id, project_id, id),
  CHECK ((element_kind = 'entity_card') = (entity_type IS NOT NULL AND entity_id IS NOT NULL)),
  CHECK (jsonb_typeof(geometry) = 'object'),
  CHECK (jsonb_typeof(content) = 'object')
);

CREATE TABLE canvas_commands (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  canvas_id uuid NOT NULL,
  client_id text NOT NULL CHECK (length(client_id) BETWEEN 1 AND 180),
  client_sequence bigint NOT NULL CHECK (client_sequence > 0),
  base_revision bigint NOT NULL CHECK (base_revision > 0),
  applied_revision bigint NOT NULL CHECK (applied_revision > 1),
  command_type text NOT NULL CHECK (command_type ~ '^[a-z][a-z0-9_.:-]{1,79}$'),
  command jsonb NOT NULL,
  actor_principal_id uuid NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (canvas_id, client_id, client_sequence),
  UNIQUE (canvas_id, applied_revision),
  UNIQUE (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, canvas_id) REFERENCES canvases(workspace_id, project_id, id),
  CHECK (applied_revision = base_revision + 1),
  CHECK (jsonb_typeof(command) = 'object')
);

CREATE TABLE mermaid_interchange_previews (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  canvas_id uuid,
  direction text NOT NULL CHECK (direction IN ('import','export')),
  source_text text,
  candidate_scene jsonb,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  losses jsonb NOT NULL DEFAULT '[]'::jsonb,
  base_canvas_revision bigint,
  created_by_principal_id uuid NOT NULL REFERENCES principals(id),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, canvas_id) REFERENCES canvases(workspace_id, project_id, id),
  CHECK (expires_at > created_at),
  CHECK (jsonb_typeof(warnings) = 'array'),
  CHECK (jsonb_typeof(losses) = 'array')
);

CREATE OR REPLACE FUNCTION normalize_symmetric_relationship()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE is_symmetric boolean;
BEGIN
  SELECT symmetric INTO is_symmetric FROM relationship_types
  WHERE workspace_id=NEW.workspace_id AND project_id=NEW.project_id AND id=NEW.relationship_type_id;
  IF is_symmetric AND (NEW.source_entity_type,NEW.source_entity_id::text) > (NEW.target_entity_type,NEW.target_entity_id::text) THEN
    SELECT NEW.target_entity_type,NEW.target_entity_id,NEW.source_entity_type,NEW.source_entity_id
      INTO NEW.source_entity_type,NEW.source_entity_id,NEW.target_entity_type,NEW.target_entity_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER entity_relationships_normalize_symmetric
BEFORE INSERT OR UPDATE OF relationship_type_id,source_entity_type,source_entity_id,target_entity_type,target_entity_id
ON entity_relationships FOR EACH ROW EXECUTE FUNCTION normalize_symmetric_relationship();

CREATE OR REPLACE FUNCTION prevent_phase6_append_only_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER canvas_revisions_immutable BEFORE UPDATE OR DELETE ON canvas_revisions
FOR EACH ROW EXECUTE FUNCTION prevent_phase6_append_only_mutation();
CREATE TRIGGER canvas_revisions_no_truncate BEFORE TRUNCATE ON canvas_revisions
FOR EACH STATEMENT EXECUTE FUNCTION prevent_phase6_append_only_mutation();
CREATE TRIGGER canvas_commands_immutable BEFORE UPDATE OR DELETE ON canvas_commands
FOR EACH ROW EXECUTE FUNCTION prevent_phase6_append_only_mutation();
CREATE TRIGGER canvas_commands_no_truncate BEFORE TRUNCATE ON canvas_commands
FOR EACH STATEMENT EXECUTE FUNCTION prevent_phase6_append_only_mutation();

CREATE INDEX entity_relationships_source_idx ON entity_relationships(project_id,source_entity_type,source_entity_id) WHERE archived_at IS NULL;
CREATE INDEX entity_relationships_target_idx ON entity_relationships(project_id,target_entity_type,target_entity_id) WHERE archived_at IS NULL;
CREATE INDEX canvas_elements_canvas_z_idx ON canvas_elements(canvas_id,z_index,id) WHERE archived_at IS NULL;
CREATE INDEX canvas_commands_canvas_revision_idx ON canvas_commands(canvas_id,applied_revision);
CREATE INDEX mermaid_interchange_previews_expiry_idx ON mermaid_interchange_previews(expires_at) WHERE consumed_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON TABLE
  relationship_types, entity_relationships, saved_graph_views, canvases, canvas_elements,
  mermaid_interchange_previews
TO folio_runtime;
GRANT SELECT, INSERT ON TABLE canvas_revisions, canvas_commands TO folio_runtime;

DO $$
DECLARE table_name text; owner_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'relationship_types','entity_relationships','saved_graph_views','canvases',
    'canvas_revisions','canvas_elements','canvas_commands','mermaid_interchange_previews'
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
