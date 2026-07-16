CREATE TABLE project_issue_counters (
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  next_number bigint NOT NULL DEFAULT 1 CHECK (next_number > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, project_id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id)
);

CREATE TABLE issue_workflows (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 4000),
  is_default boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_principal_id uuid NOT NULL REFERENCES principals(id),
  updated_by_principal_id uuid NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id)
);

CREATE UNIQUE INDEX issue_workflows_default_idx
  ON issue_workflows (project_id) WHERE is_default AND archived_at IS NULL;
CREATE UNIQUE INDEX issue_workflows_name_idx
  ON issue_workflows (project_id, lower(name)) WHERE archived_at IS NULL;

CREATE TABLE issue_workflow_statuses (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  category text NOT NULL CHECK (category IN ('backlog', 'planned', 'in_progress', 'completed', 'canceled')),
  color_key text NOT NULL DEFAULT 'gray' CHECK (color_key ~ '^[a-z][a-z0-9_-]{0,31}$'),
  rank bigint NOT NULL DEFAULT 1000 CHECK (rank >= 0),
  is_initial boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_principal_id uuid NOT NULL REFERENCES principals(id),
  updated_by_principal_id uuid NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, workflow_id)
    REFERENCES issue_workflows(workspace_id, project_id, id)
);

CREATE UNIQUE INDEX issue_workflow_statuses_name_idx
  ON issue_workflow_statuses (workflow_id, lower(name)) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX issue_workflow_statuses_initial_idx
  ON issue_workflow_statuses (workflow_id) WHERE is_initial AND archived_at IS NULL;
CREATE INDEX issue_workflow_statuses_order_idx
  ON issue_workflow_statuses (workflow_id, rank, id) WHERE archived_at IS NULL;

CREATE TABLE issue_workflow_transitions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  from_status_id uuid NOT NULL,
  to_status_id uuid NOT NULL,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  requires_comment boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_principal_id uuid NOT NULL REFERENCES principals(id),
  updated_by_principal_id uuid NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (workspace_id, project_id, id),
  UNIQUE (workflow_id, from_status_id, to_status_id),
  CHECK (from_status_id <> to_status_id),
  FOREIGN KEY (workspace_id, project_id, workflow_id)
    REFERENCES issue_workflows(workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, from_status_id)
    REFERENCES issue_workflow_statuses(workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, to_status_id)
    REFERENCES issue_workflow_statuses(workspace_id, project_id, id)
);

CREATE TABLE issue_labels (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  color_key text NOT NULL DEFAULT 'gray' CHECK (color_key ~ '^[a-z][a-z0-9_-]{0,31}$'),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_principal_id uuid NOT NULL REFERENCES principals(id),
  updated_by_principal_id uuid NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id)
);

CREATE UNIQUE INDEX issue_labels_name_idx
  ON issue_labels (project_id, lower(name)) WHERE archived_at IS NULL;

CREATE TABLE milestones (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 4000),
  target_on date,
  state text NOT NULL DEFAULT 'planned' CHECK (state IN ('planned', 'active', 'completed', 'canceled')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_principal_id uuid NOT NULL REFERENCES principals(id),
  updated_by_principal_id uuid NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id)
);

CREATE TABLE cycles (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  state text NOT NULL DEFAULT 'planned' CHECK (state IN ('planned', 'active', 'completed', 'canceled')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_principal_id uuid NOT NULL REFERENCES principals(id),
  updated_by_principal_id uuid NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (workspace_id, project_id, id),
  CHECK (ends_on >= starts_on),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id)
);

CREATE TABLE roadmaps (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 4000),
  visibility text NOT NULL DEFAULT 'project' CHECK (visibility IN ('project', 'private')),
  owner_principal_id uuid NOT NULL REFERENCES principals(id),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_principal_id uuid NOT NULL REFERENCES principals(id),
  updated_by_principal_id uuid NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id)
);

CREATE TABLE issues (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  issue_number bigint NOT NULL CHECK (issue_number > 0),
  workflow_id uuid NOT NULL,
  status_id uuid NOT NULL,
  parent_issue_id uuid,
  milestone_id uuid,
  cycle_id uuid,
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 240),
  description jsonb NOT NULL DEFAULT '{}'::jsonb,
  plain_text text NOT NULL DEFAULT '' CHECK (length(plain_text) <= 100000),
  priority text NOT NULL DEFAULT 'no_priority'
    CHECK (priority IN ('no_priority', 'urgent', 'high', 'medium', 'low')),
  estimate_points numeric(8,2) CHECK (estimate_points IS NULL OR estimate_points >= 0),
  start_on date,
  due_on date,
  rank bigint NOT NULL DEFAULT 1000 CHECK (rank >= 0),
  lifecycle text NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'archived')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_principal_id uuid NOT NULL REFERENCES principals(id),
  updated_by_principal_id uuid NOT NULL REFERENCES principals(id),
  archived_by_principal_id uuid REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (workspace_id, project_id, id),
  UNIQUE (project_id, issue_number),
  CHECK (due_on IS NULL OR start_on IS NULL OR due_on >= start_on),
  CHECK ((lifecycle = 'archived') = (archived_at IS NOT NULL)),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id),
  FOREIGN KEY (workspace_id, project_id, workflow_id)
    REFERENCES issue_workflows(workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, status_id)
    REFERENCES issue_workflow_statuses(workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, parent_issue_id)
    REFERENCES issues(workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, milestone_id)
    REFERENCES milestones(workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, cycle_id)
    REFERENCES cycles(workspace_id, project_id, id)
);

CREATE INDEX issues_project_status_idx
  ON issues (project_id, lifecycle, status_id, rank, id);
CREATE INDEX issues_parent_idx
  ON issues (parent_issue_id, rank, id) WHERE lifecycle = 'active';
CREATE INDEX issues_dates_idx
  ON issues (project_id, start_on, due_on) WHERE lifecycle = 'active';

CREATE TABLE issue_assignees (
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  issue_id uuid NOT NULL,
  principal_id uuid NOT NULL REFERENCES principals(id),
  assignment_role text NOT NULL DEFAULT 'owner' CHECK (assignment_role IN ('owner', 'contributor')),
  assigned_by_principal_id uuid NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (issue_id, principal_id),
  FOREIGN KEY (workspace_id, project_id, issue_id)
    REFERENCES issues(workspace_id, project_id, id)
);

CREATE TABLE issue_label_assignments (
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  issue_id uuid NOT NULL,
  label_id uuid NOT NULL,
  created_by_principal_id uuid NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (issue_id, label_id),
  FOREIGN KEY (workspace_id, project_id, issue_id)
    REFERENCES issues(workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, label_id)
    REFERENCES issue_labels(workspace_id, project_id, id)
);

CREATE TABLE issue_dependencies (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  source_issue_id uuid NOT NULL,
  target_issue_id uuid NOT NULL,
  relation_kind text NOT NULL CHECK (relation_kind IN ('blocks', 'relates', 'duplicates')),
  created_by_principal_id uuid NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (workspace_id, project_id, id),
  UNIQUE (source_issue_id, target_issue_id, relation_kind),
  CHECK (source_issue_id <> target_issue_id),
  FOREIGN KEY (workspace_id, project_id, source_issue_id)
    REFERENCES issues(workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, target_issue_id)
    REFERENCES issues(workspace_id, project_id, id)
);

CREATE INDEX issue_dependencies_source_idx
  ON issue_dependencies (source_issue_id, relation_kind) WHERE archived_at IS NULL;
CREATE INDEX issue_dependencies_target_idx
  ON issue_dependencies (target_issue_id, relation_kind) WHERE archived_at IS NULL;

CREATE TABLE issue_comments (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  issue_id uuid NOT NULL,
  body jsonb NOT NULL,
  plain_text text NOT NULL CHECK (length(trim(plain_text)) BETWEEN 1 AND 20000),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  author_principal_id uuid NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, issue_id)
    REFERENCES issues(workspace_id, project_id, id)
);

CREATE TABLE issue_attachments (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  issue_id uuid NOT NULL,
  comment_id uuid,
  object_key text NOT NULL,
  file_name text NOT NULL CHECK (length(trim(file_name)) BETWEEN 1 AND 255),
  mime_type text NOT NULL CHECK (length(trim(mime_type)) BETWEEN 1 AND 255),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 0 AND 10485760),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  storage_state text NOT NULL DEFAULT 'pending' CHECK (storage_state IN ('pending', 'available', 'failed')),
  scan_state text NOT NULL DEFAULT 'pending' CHECK (scan_state IN ('pending', 'clean', 'rejected')),
  uploaded_by_principal_id uuid NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz,
  archived_at timestamptz,
  UNIQUE (workspace_id, object_key),
  UNIQUE (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, issue_id)
    REFERENCES issues(workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, comment_id)
    REFERENCES issue_comments(workspace_id, project_id, id)
);

CREATE TABLE issue_links (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  issue_id uuid NOT NULL,
  target_issue_id uuid,
  target_page_id uuid,
  external_url text,
  link_kind text NOT NULL CHECK (link_kind IN ('issue', 'page', 'external')),
  label text CHECK (label IS NULL OR length(label) <= 240),
  created_by_principal_id uuid NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (workspace_id, project_id, id),
  CHECK (
    (link_kind = 'issue' AND target_issue_id IS NOT NULL AND target_page_id IS NULL AND external_url IS NULL)
    OR (link_kind = 'page' AND target_issue_id IS NULL AND target_page_id IS NOT NULL AND external_url IS NULL)
    OR (link_kind = 'external' AND target_issue_id IS NULL AND target_page_id IS NULL AND external_url IS NOT NULL)
  ),
  CHECK (external_url IS NULL OR length(external_url) <= 2048),
  FOREIGN KEY (workspace_id, project_id, issue_id)
    REFERENCES issues(workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, target_issue_id)
    REFERENCES issues(workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, target_page_id)
    REFERENCES pages(workspace_id, project_id, id)
);

CREATE TABLE roadmap_items (
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  roadmap_id uuid NOT NULL,
  issue_id uuid NOT NULL,
  rank bigint NOT NULL DEFAULT 1000 CHECK (rank >= 0),
  starts_on date,
  ends_on date,
  created_by_principal_id uuid NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (roadmap_id, issue_id),
  CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on),
  FOREIGN KEY (workspace_id, project_id, roadmap_id)
    REFERENCES roadmaps(workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, issue_id)
    REFERENCES issues(workspace_id, project_id, id)
);

CREATE TABLE issue_saved_views (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  owner_principal_id uuid NOT NULL REFERENCES principals(id),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'project')),
  projection text NOT NULL DEFAULT 'list' CHECK (projection IN ('list', 'board', 'timeline', 'calendar')),
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  grouping jsonb NOT NULL DEFAULT '{}'::jsonb,
  ordering jsonb NOT NULL DEFAULT '[]'::jsonb,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id)
);

CREATE INDEX issue_saved_views_visibility_idx
  ON issue_saved_views (project_id, visibility, owner_principal_id) WHERE archived_at IS NULL;

CREATE TABLE issue_search_documents (
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  issue_id uuid NOT NULL,
  issue_number bigint NOT NULL,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(body, '')), 'B')
  ) STORED,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, project_id, issue_id),
  FOREIGN KEY (workspace_id, project_id, issue_id)
    REFERENCES issues(workspace_id, project_id, id)
);

CREATE INDEX issue_search_documents_vector_idx
  ON issue_search_documents USING gin (search_vector);

CREATE TABLE issue_bulk_previews (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('patch', 'transition', 'archive', 'restore')),
  issue_ids uuid[] NOT NULL CHECK (cardinality(issue_ids) BETWEEN 1 AND 500),
  request jsonb NOT NULL,
  impact jsonb NOT NULL,
  action_digest text NOT NULL CHECK (action_digest ~ '^[a-f0-9]{64}$'),
  risk_level text NOT NULL CHECK (risk_level IN ('R1', 'R2')),
  state text NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared', 'executed', 'expired', 'canceled')),
  confirmation_id uuid,
  result jsonb,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_principal_id uuid NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  executed_at timestamptz,
  UNIQUE (workspace_id, project_id, id),
  CHECK (expires_at > created_at),
  CHECK ((state = 'executed') = (executed_at IS NOT NULL)),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id),
  FOREIGN KEY (workspace_id, confirmation_id)
    REFERENCES action_confirmations(workspace_id, id)
);

CREATE OR REPLACE FUNCTION validate_issue_workflow_status()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM issue_workflow_statuses s
    WHERE s.workspace_id = NEW.workspace_id
      AND s.project_id = NEW.project_id
      AND s.workflow_id = NEW.workflow_id
      AND s.id = NEW.status_id
      AND s.archived_at IS NULL
  ) THEN
    RAISE EXCEPTION 'issue status does not belong to the selected workflow'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER issues_validate_workflow_status
BEFORE INSERT OR UPDATE OF workspace_id, project_id, workflow_id, status_id
ON issues FOR EACH ROW EXECUTE FUNCTION validate_issue_workflow_status();

CREATE OR REPLACE FUNCTION prevent_issue_hierarchy_cycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE cycle_found boolean;
BEGIN
  IF NEW.parent_issue_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.parent_issue_id = NEW.id THEN
    RAISE EXCEPTION 'issue hierarchy cycle detected' USING ERRCODE = '23514';
  END IF;
  WITH RECURSIVE ancestors AS (
    SELECT id, parent_issue_id FROM issues
      WHERE workspace_id = NEW.workspace_id AND project_id = NEW.project_id
        AND id = NEW.parent_issue_id
    UNION ALL
    SELECT parent.id, parent.parent_issue_id
      FROM issues parent JOIN ancestors child ON child.parent_issue_id = parent.id
      WHERE parent.workspace_id = NEW.workspace_id AND parent.project_id = NEW.project_id
  )
  SELECT EXISTS (SELECT 1 FROM ancestors WHERE id = NEW.id) INTO cycle_found;
  IF cycle_found THEN
    RAISE EXCEPTION 'issue hierarchy cycle detected' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER issues_prevent_hierarchy_cycle
BEFORE INSERT OR UPDATE OF parent_issue_id ON issues
FOR EACH ROW EXECUTE FUNCTION prevent_issue_hierarchy_cycle();

CREATE OR REPLACE FUNCTION prevent_blocking_dependency_cycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE cycle_found boolean;
BEGIN
  IF NEW.relation_kind <> 'blocks' OR NEW.archived_at IS NOT NULL THEN RETURN NEW; END IF;
  WITH RECURSIVE reachable AS (
    SELECT target_issue_id AS id
      FROM issue_dependencies
      WHERE workspace_id = NEW.workspace_id AND project_id = NEW.project_id
        AND source_issue_id = NEW.target_issue_id
        AND relation_kind = 'blocks' AND archived_at IS NULL
    UNION
    SELECT dependency.target_issue_id
      FROM issue_dependencies dependency JOIN reachable parent ON dependency.source_issue_id = parent.id
      WHERE dependency.workspace_id = NEW.workspace_id AND dependency.project_id = NEW.project_id
        AND dependency.relation_kind = 'blocks' AND dependency.archived_at IS NULL
  )
  SELECT NEW.source_issue_id = NEW.target_issue_id
    OR EXISTS (SELECT 1 FROM reachable WHERE id = NEW.source_issue_id)
    INTO cycle_found;
  IF cycle_found THEN
    RAISE EXCEPTION 'issue dependency cycle detected' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER issue_dependencies_prevent_cycle
BEFORE INSERT OR UPDATE OF source_issue_id, target_issue_id, relation_kind, archived_at
ON issue_dependencies FOR EACH ROW EXECUTE FUNCTION prevent_blocking_dependency_cycle();

CREATE OR REPLACE FUNCTION refresh_issue_search_document()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO issue_search_documents (
    workspace_id, project_id, issue_id, issue_number, title, body, updated_at
  ) VALUES (
    NEW.workspace_id, NEW.project_id, NEW.id, NEW.issue_number, NEW.title, NEW.plain_text, now()
  ) ON CONFLICT (workspace_id, project_id, issue_id)
  DO UPDATE SET issue_number = EXCLUDED.issue_number, title = EXCLUDED.title,
    body = EXCLUDED.body, updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER issues_refresh_search
AFTER INSERT OR UPDATE OF title, plain_text ON issues
FOR EACH ROW EXECUTE FUNCTION refresh_issue_search_document();

GRANT SELECT, INSERT, UPDATE ON TABLE
  project_issue_counters, issue_workflows, issue_workflow_statuses,
  issue_workflow_transitions, issue_labels, milestones, cycles, roadmaps,
  issues, issue_assignees, issue_label_assignments, issue_dependencies,
  issue_comments, issue_attachments, issue_links, roadmap_items,
  issue_saved_views, issue_search_documents, issue_bulk_previews
TO folio_runtime;
GRANT DELETE ON TABLE issue_assignees, issue_label_assignments, roadmap_items TO folio_runtime;

DO $$
DECLARE table_name text; owner_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'project_issue_counters', 'issue_workflows', 'issue_workflow_statuses',
    'issue_workflow_transitions', 'issue_labels', 'milestones', 'cycles',
    'roadmaps', 'issues', 'issue_assignees', 'issue_label_assignments',
    'issue_dependencies', 'issue_comments', 'issue_attachments', 'issue_links',
    'roadmap_items', 'issue_saved_views', 'issue_search_documents',
    'issue_bulk_previews'
  ] LOOP
    SELECT pg_get_userbyid(c.relowner) INTO owner_name
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = table_name AND c.relkind = 'r';
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY folio_migration_owner_access ON public.%I TO %I USING (true) WITH CHECK (true)',
      table_name, owner_name
    );
    EXECUTE format(
      'CREATE POLICY folio_runtime_workspace_scope ON public.%I TO folio_runtime USING (workspace_id = folio.current_workspace_id()) WITH CHECK (workspace_id = folio.current_workspace_id())',
      table_name
    );
  END LOOP;
END
$$;
