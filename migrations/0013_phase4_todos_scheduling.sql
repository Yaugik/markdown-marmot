CREATE TABLE todo_lists (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  owner_principal_id uuid NOT NULL REFERENCES principals(id),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'project')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id)
);

CREATE TABLE calendars (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  owner_principal_id uuid NOT NULL REFERENCES principals(id),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'project')),
  time_zone text NOT NULL DEFAULT 'UTC' CHECK (length(trim(time_zone)) BETWEEN 1 AND 120),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id)
);

CREATE TABLE todos (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  list_id uuid NOT NULL,
  parent_todo_id uuid,
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 240),
  body jsonb NOT NULL DEFAULT '{"type":"doc","content":[]}'::jsonb,
  plain_text text NOT NULL DEFAULT '' CHECK (length(plain_text) <= 100000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'canceled')),
  assignee_principal_id uuid REFERENCES principals(id),
  starts_at timestamptz,
  due_at timestamptz,
  time_zone text NOT NULL DEFAULT 'UTC' CHECK (length(trim(time_zone)) BETWEEN 1 AND 120),
  rank integer NOT NULL DEFAULT 0 CHECK (rank >= 0),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_principal_id uuid NOT NULL REFERENCES principals(id),
  updated_by_principal_id uuid NOT NULL REFERENCES principals(id),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, list_id)
    REFERENCES todo_lists(workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, parent_todo_id)
    REFERENCES todos(workspace_id, project_id, id),
  CHECK (due_at IS NULL OR starts_at IS NULL OR due_at >= starts_at),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);

CREATE TABLE todo_links (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  todo_id uuid NOT NULL,
  link_kind text NOT NULL CHECK (link_kind IN ('issue', 'page')),
  target_issue_id uuid,
  target_page_id uuid,
  label text CHECK (label IS NULL OR length(trim(label)) BETWEEN 1 AND 240),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_principal_id uuid NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, todo_id)
    REFERENCES todos(workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, target_issue_id)
    REFERENCES issues(workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, target_page_id)
    REFERENCES pages(workspace_id, project_id, id),
  CHECK (
    (link_kind = 'issue' AND target_issue_id IS NOT NULL AND target_page_id IS NULL)
    OR (link_kind = 'page' AND target_page_id IS NOT NULL AND target_issue_id IS NULL)
  )
);

CREATE UNIQUE INDEX todo_links_active_target_idx
  ON todo_links (todo_id, link_kind, coalesce(target_issue_id, target_page_id))
  WHERE archived_at IS NULL;

CREATE TABLE todo_recurrence_rules (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  todo_id uuid NOT NULL,
  frequency text NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly')),
  interval_count integer NOT NULL DEFAULT 1 CHECK (interval_count BETWEEN 1 AND 365),
  by_weekday smallint[] NOT NULL DEFAULT '{}' CHECK (
    by_weekday <@ ARRAY[0,1,2,3,4,5,6]::smallint[]
  ),
  by_month_day smallint CHECK (by_month_day BETWEEN 1 AND 31),
  local_time time NOT NULL DEFAULT '09:00',
  time_zone text NOT NULL CHECK (length(trim(time_zone)) BETWEEN 1 AND 120),
  starts_on date NOT NULL,
  ends_on date,
  count_limit integer CHECK (count_limit BETWEEN 1 AND 10000),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_principal_id uuid NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (workspace_id, project_id, id),
  UNIQUE (todo_id),
  FOREIGN KEY (workspace_id, project_id, todo_id)
    REFERENCES todos(workspace_id, project_id, id),
  CHECK (ends_on IS NULL OR ends_on >= starts_on),
  CHECK (frequency = 'weekly' OR cardinality(by_weekday) = 0),
  CHECK (frequency = 'monthly' OR by_month_day IS NULL)
);

CREATE TABLE todo_occurrences (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  recurrence_rule_id uuid NOT NULL,
  source_todo_id uuid NOT NULL,
  occurrence_key text NOT NULL CHECK (length(occurrence_key) BETWEEN 1 AND 180),
  scheduled_for timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'scheduled' CHECK (state IN ('scheduled', 'materialized', 'skipped')),
  materialized_todo_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  materialized_at timestamptz,
  UNIQUE (recurrence_rule_id, occurrence_key),
  UNIQUE (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, recurrence_rule_id)
    REFERENCES todo_recurrence_rules(workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, source_todo_id)
    REFERENCES todos(workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, materialized_todo_id)
    REFERENCES todos(workspace_id, project_id, id),
  CHECK ((state = 'materialized') = (materialized_todo_id IS NOT NULL)),
  CHECK ((state = 'materialized') = (materialized_at IS NOT NULL))
);

CREATE TABLE calendar_entries (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  calendar_id uuid NOT NULL,
  source_kind text NOT NULL DEFAULT 'manual' CHECK (source_kind IN ('manual', 'todo', 'issue', 'external')),
  todo_id uuid,
  issue_id uuid,
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 240),
  body jsonb NOT NULL DEFAULT '{"type":"doc","content":[]}'::jsonb,
  plain_text text NOT NULL DEFAULT '' CHECK (length(plain_text) <= 100000),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  all_day boolean NOT NULL DEFAULT false,
  time_zone text NOT NULL DEFAULT 'UTC' CHECK (length(trim(time_zone)) BETWEEN 1 AND 120),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_principal_id uuid NOT NULL REFERENCES principals(id),
  updated_by_principal_id uuid NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, calendar_id)
    REFERENCES calendars(workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, todo_id)
    REFERENCES todos(workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, issue_id)
    REFERENCES issues(workspace_id, project_id, id),
  CHECK (ends_at > starts_at),
  CHECK (
    (source_kind = 'manual' AND todo_id IS NULL AND issue_id IS NULL)
    OR (source_kind = 'todo' AND todo_id IS NOT NULL AND issue_id IS NULL)
    OR (source_kind = 'issue' AND issue_id IS NOT NULL AND todo_id IS NULL)
    OR (source_kind = 'external' AND todo_id IS NULL AND issue_id IS NULL)
  )
);

CREATE TABLE reminders (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  todo_id uuid,
  calendar_entry_id uuid,
  recipient_principal_id uuid NOT NULL REFERENCES principals(id),
  remind_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'leased', 'sent', 'failed', 'canceled')),
  delivery_channel text NOT NULL DEFAULT 'in_app' CHECK (delivery_channel IN ('in_app', 'email', 'provider')),
  deduplication_key text NOT NULL CHECK (length(deduplication_key) BETWEEN 1 AND 240),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 100),
  available_at timestamptz NOT NULL,
  leased_until timestamptz,
  leased_by text,
  last_error_code text,
  last_error_message text,
  sent_at timestamptz,
  created_by_principal_id uuid NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, recipient_principal_id, deduplication_key),
  UNIQUE (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, todo_id)
    REFERENCES todos(workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, calendar_entry_id)
    REFERENCES calendar_entries(workspace_id, project_id, id),
  CHECK ((todo_id IS NOT NULL)::integer + (calendar_entry_id IS NOT NULL)::integer = 1),
  CHECK (available_at >= created_at),
  CHECK ((state = 'sent') = (sent_at IS NOT NULL)),
  CHECK (state = 'leased' OR leased_until IS NULL)
);

CREATE TABLE agent_schedule_grants (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  agent_principal_id uuid NOT NULL REFERENCES principals(id),
  authorizing_principal_id uuid NOT NULL REFERENCES principals(id),
  list_id uuid,
  calendar_id uuid,
  operations text[] NOT NULL CHECK (operations <@ ARRAY['create','reschedule','complete','cancel','remind']::text[]),
  constraints jsonb NOT NULL DEFAULT '{}'::jsonb,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, list_id)
    REFERENCES todo_lists(workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, calendar_id)
    REFERENCES calendars(workspace_id, project_id, id),
  CHECK ((list_id IS NOT NULL)::integer + (calendar_id IS NOT NULL)::integer = 1),
  CHECK (valid_until IS NULL OR valid_until > valid_from),
  CHECK (cardinality(operations) > 0)
);

CREATE OR REPLACE FUNCTION validate_todo_parent()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE parent_list uuid;
BEGIN
  IF NEW.parent_todo_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.parent_todo_id = NEW.id THEN
    RAISE EXCEPTION 'todo hierarchy cycle detected' USING ERRCODE = '23514';
  END IF;
  SELECT list_id INTO parent_list
  FROM todos
  WHERE workspace_id = NEW.workspace_id AND project_id = NEW.project_id
    AND id = NEW.parent_todo_id AND archived_at IS NULL;
  IF parent_list IS NULL OR parent_list <> NEW.list_id THEN
    RAISE EXCEPTION 'todo parent must be active in the same list' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    WITH RECURSIVE ancestors(id, parent_todo_id) AS (
      SELECT id, parent_todo_id FROM todos
      WHERE workspace_id = NEW.workspace_id AND project_id = NEW.project_id AND id = NEW.parent_todo_id
      UNION ALL
      SELECT t.id, t.parent_todo_id FROM todos t
      JOIN ancestors a ON t.id = a.parent_todo_id
      WHERE t.workspace_id = NEW.workspace_id AND t.project_id = NEW.project_id
    ) SELECT 1 FROM ancestors WHERE id = NEW.id
  ) THEN
    RAISE EXCEPTION 'todo hierarchy cycle detected' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER todos_validate_parent
BEFORE INSERT OR UPDATE OF workspace_id, project_id, list_id, parent_todo_id ON todos
FOR EACH ROW EXECUTE FUNCTION validate_todo_parent();

CREATE OR REPLACE FUNCTION validate_todo_assignee()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.assignee_principal_id IS NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM project_memberships pm
    JOIN principals p ON p.id = pm.principal_id
    WHERE pm.workspace_id = NEW.workspace_id AND pm.project_id = NEW.project_id
      AND pm.principal_id = NEW.assignee_principal_id AND pm.status = 'active'
      AND p.status = 'active' AND p.kind IN ('human', 'agent')
  ) THEN
    RAISE EXCEPTION 'todo assignee must be an active human or agent project member' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER todos_validate_assignee
BEFORE INSERT OR UPDATE OF workspace_id, project_id, assignee_principal_id ON todos
FOR EACH ROW EXECUTE FUNCTION validate_todo_assignee();

CREATE OR REPLACE FUNCTION prevent_todo_parent_archive()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL AND EXISTS (
    SELECT 1 FROM todos child
    WHERE child.workspace_id = NEW.workspace_id AND child.project_id = NEW.project_id
      AND child.parent_todo_id = NEW.id AND child.archived_at IS NULL
  ) THEN
    RAISE EXCEPTION 'archive child todos before their parent' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER todos_archive_requires_archived_children
BEFORE UPDATE OF archived_at ON todos
FOR EACH ROW EXECUTE FUNCTION prevent_todo_parent_archive();

CREATE OR REPLACE FUNCTION validate_agent_schedule_grant()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM principals p
    JOIN project_memberships pm ON pm.principal_id = p.id
    WHERE p.id = NEW.agent_principal_id AND p.kind = 'agent' AND p.status = 'active'
      AND pm.workspace_id = NEW.workspace_id AND pm.project_id = NEW.project_id AND pm.status = 'active'
  ) THEN
    RAISE EXCEPTION 'schedule grant target must be an active project agent' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_schedule_grants_validate_agent
BEFORE INSERT OR UPDATE OF workspace_id, project_id, agent_principal_id ON agent_schedule_grants
FOR EACH ROW EXECUTE FUNCTION validate_agent_schedule_grant();

CREATE INDEX todo_lists_project_visibility_idx ON todo_lists(project_id, visibility, updated_at DESC) WHERE archived_at IS NULL;
CREATE INDEX todos_list_rank_idx ON todos(list_id, rank, created_at, id) WHERE archived_at IS NULL;
CREATE INDEX todos_assignee_due_idx ON todos(assignee_principal_id, due_at) WHERE archived_at IS NULL AND status = 'open';
CREATE INDEX todo_occurrences_due_idx ON todo_occurrences(scheduled_for, state) WHERE state = 'scheduled';
CREATE INDEX calendar_entries_window_idx ON calendar_entries(calendar_id, starts_at, ends_at) WHERE archived_at IS NULL;
CREATE INDEX reminders_claim_idx ON reminders(available_at, remind_at, created_at) WHERE state IN ('pending', 'leased');
CREATE INDEX agent_schedule_grants_lookup_idx ON agent_schedule_grants(agent_principal_id, list_id, calendar_id, valid_until) WHERE archived_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON TABLE
  todo_lists, calendars, todos, todo_links, todo_recurrence_rules,
  todo_occurrences, calendar_entries, reminders, agent_schedule_grants
TO folio_runtime;

DO $$
DECLARE table_name text; owner_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'todo_lists','calendars','todos','todo_links','todo_recurrence_rules',
    'todo_occurrences','calendar_entries','reminders','agent_schedule_grants'
  ] LOOP
    SELECT pg_get_userbyid(c.relowner) INTO owner_name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = table_name AND c.relkind = 'r';
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY folio_migration_owner_access ON public.%I TO %I USING (true) WITH CHECK (true)', table_name, owner_name);
    EXECUTE format('CREATE POLICY folio_runtime_workspace_scope ON public.%I TO folio_runtime USING (workspace_id = folio.current_workspace_id()) WITH CHECK (workspace_id = folio.current_workspace_id())', table_name);
  END LOOP;
END
$$;