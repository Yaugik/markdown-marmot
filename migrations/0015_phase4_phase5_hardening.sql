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
    AND id = NEW.parent_todo_id
    AND (NEW.archived_at IS NOT NULL OR archived_at IS NULL);
  IF parent_list IS NULL OR parent_list <> NEW.list_id THEN
    RAISE EXCEPTION 'active todo parent must be active in the same list' USING ERRCODE = '23514';
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

DROP TRIGGER IF EXISTS todos_validate_parent ON todos;
CREATE TRIGGER todos_validate_parent
BEFORE INSERT OR UPDATE OF workspace_id, project_id, list_id, parent_todo_id, archived_at ON todos
FOR EACH ROW EXECUTE FUNCTION validate_todo_parent();

ALTER TABLE reminders ADD CONSTRAINT reminders_lease_state_consistent CHECK (
  (state = 'leased' AND leased_until IS NOT NULL AND leased_by IS NOT NULL)
  OR (state <> 'leased' AND leased_until IS NULL AND leased_by IS NULL)
);

CREATE UNIQUE INDEX todo_occurrences_materialized_todo_idx
  ON todo_occurrences(materialized_todo_id)
  WHERE materialized_todo_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'folio_worker') THEN
    CREATE ROLE folio_worker
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  EXECUTE format('GRANT folio_worker TO %I', current_user);
END
$$;

GRANT USAGE ON SCHEMA public TO folio_worker;
GRANT SELECT, UPDATE ON TABLE jobs TO folio_worker;
GRANT SELECT, INSERT, UPDATE ON TABLE job_attempts TO folio_worker;
GRANT INSERT ON TABLE operation_metrics TO folio_worker;

CREATE POLICY folio_worker_jobs ON jobs TO folio_worker USING (true) WITH CHECK (true);
CREATE POLICY folio_worker_attempts ON job_attempts TO folio_worker USING (true) WITH CHECK (true);
CREATE POLICY folio_worker_metrics ON operation_metrics TO folio_worker USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION claim_folio_jobs(
  worker_name text,
  supported_kinds text[],
  lease_seconds integer,
  claim_limit integer DEFAULT 1
)
RETURNS SETOF jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF worker_name IS NULL OR length(trim(worker_name)) NOT BETWEEN 1 AND 180 THEN
    RAISE EXCEPTION 'worker name is invalid' USING ERRCODE = '22023';
  END IF;
  IF supported_kinds IS NULL OR cardinality(supported_kinds) = 0 THEN
    RAISE EXCEPTION 'supported job kinds are required' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT id
    FROM jobs
    WHERE kind = ANY(supported_kinds)
      AND available_at <= now()
      AND attempt_count < max_attempts
      AND (
        status = 'pending'
        OR (status = 'running' AND leased_until < now())
        OR status = 'waiting_provider'
      )
    ORDER BY priority, available_at, created_at
    FOR UPDATE SKIP LOCKED
    LIMIT greatest(1, least(claim_limit, 100))
  ), claimed AS (
    UPDATE jobs j
    SET status = 'running', leased_by = worker_name,
      leased_until = now() + make_interval(secs => greatest(5, least(lease_seconds, 3600))),
      attempt_count = attempt_count + 1, updated_at = now()
    FROM candidates c
    WHERE j.id = c.id
    RETURNING j.*
  )
  SELECT * FROM claimed;
END;
$$;

REVOKE ALL ON FUNCTION claim_folio_jobs(text, text[], integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_folio_jobs(text, text[], integer, integer) FROM folio_runtime;
GRANT EXECUTE ON FUNCTION claim_folio_jobs(text, text[], integer, integer) TO folio_worker;

DROP POLICY IF EXISTS folio_migration_owner_access ON job_attempts;
DO $$
DECLARE owner_name text;
BEGIN
  SELECT pg_get_userbyid(c.relowner) INTO owner_name
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname='public' AND c.relname='job_attempts' AND c.relkind='r';
  EXECUTE format(
    'CREATE POLICY folio_migration_owner_access ON job_attempts TO %I USING (true) WITH CHECK (true)',
    owner_name
  );
END
$$;

CREATE OR REPLACE FUNCTION validate_calendar_binding_decisions()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.direction = 'two_way' THEN
    RAISE EXCEPTION 'two-way calendar synchronization is decision-gated'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.conflict_policy <> 'manual' THEN
    RAISE EXCEPTION 'automatic calendar conflict policy is decision-gated'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER calendar_bindings_enforce_open_decisions
BEFORE INSERT OR UPDATE OF direction, conflict_policy ON calendar_external_bindings
FOR EACH ROW EXECUTE FUNCTION validate_calendar_binding_decisions();
