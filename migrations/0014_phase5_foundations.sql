CREATE TABLE realtime_event_log (
  cursor_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  workspace_id uuid NOT NULL,
  project_id uuid,
  topic_type text NOT NULL CHECK (topic_type ~ '^[a-z][a-z0-9_.:-]{1,79}$'),
  topic_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_.:-]{1,119}$'),
  aggregate_revision bigint NOT NULL CHECK (aggregate_revision > 0),
  actor_principal_id uuid NOT NULL REFERENCES principals(id),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id)
);

CREATE TABLE presence_sessions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  channel_type text NOT NULL CHECK (channel_type IN ('page', 'project', 'calendar', 'todo_list')),
  channel_id uuid NOT NULL,
  principal_id uuid NOT NULL REFERENCES principals(id),
  client_id text NOT NULL CHECK (length(client_id) BETWEEN 1 AND 180),
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  connected_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  UNIQUE (workspace_id, project_id, channel_type, channel_id, principal_id, client_id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id),
  CHECK (expires_at > last_seen_at)
);

CREATE TABLE integration_connections (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  owner_principal_id uuid NOT NULL REFERENCES principals(id),
  provider_kind text NOT NULL CHECK (provider_kind IN ('calendar')),
  provider_key text NOT NULL CHECK (provider_key ~ '^[a-z][a-z0-9_-]{1,39}$'),
  display_name text NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 120),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'active', 'degraded', 'revoked', 'archived')),
  secret_reference text NOT NULL CHECK (length(trim(secret_reference)) BETWEEN 1 AND 500),
  capabilities text[] NOT NULL DEFAULT '{}'::text[],
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  sync_cursor text,
  last_synced_at timestamptz,
  last_error_code text,
  last_error_message text,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (workspace_id, project_id, id),
  UNIQUE (workspace_id, project_id, owner_principal_id, provider_key, display_name),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id)
);

CREATE TABLE calendar_external_bindings (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  calendar_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  external_calendar_id text NOT NULL CHECK (length(trim(external_calendar_id)) BETWEEN 1 AND 500),
  direction text NOT NULL DEFAULT 'pull' CHECK (direction IN ('pull', 'push', 'two_way')),
  conflict_policy text NOT NULL DEFAULT 'manual' CHECK (conflict_policy IN ('manual', 'provider_wins', 'folio_wins')),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'paused', 'error', 'archived')),
  sync_cursor text,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_principal_id uuid NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (workspace_id, project_id, id),
  UNIQUE (connection_id, external_calendar_id),
  FOREIGN KEY (workspace_id, project_id, calendar_id)
    REFERENCES calendars(workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, connection_id)
    REFERENCES integration_connections(workspace_id, project_id, id)
);

CREATE TABLE provider_operations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  binding_id uuid,
  job_id uuid REFERENCES jobs(id),
  operation text NOT NULL CHECK (operation IN ('discover', 'pull', 'push', 'reconcile', 'revoke')),
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'running', 'succeeded', 'succeeded_with_warnings', 'failed', 'canceled')),
  request_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code text,
  last_error_message text,
  created_by_principal_id uuid NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  UNIQUE (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, connection_id)
    REFERENCES integration_connections(workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, binding_id)
    REFERENCES calendar_external_bindings(workspace_id, project_id, id)
);

CREATE TABLE job_attempts (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id),
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  worker_id text NOT NULL CHECK (length(worker_id) BETWEEN 1 AND 180),
  state text NOT NULL CHECK (state IN ('running', 'succeeded', 'failed', 'canceled')),
  error_code text,
  error_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (job_id, attempt_number),
  CHECK ((state = 'running') = (completed_at IS NULL))
);

CREATE TABLE operation_metrics (
  id uuid PRIMARY KEY,
  workspace_id uuid,
  project_id uuid,
  metric_name text NOT NULL CHECK (metric_name ~ '^[a-z][a-z0-9_.:-]{2,119}$'),
  metric_value double precision NOT NULL,
  dimensions jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id)
);

CREATE OR REPLACE FUNCTION mirror_outbox_to_realtime()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO realtime_event_log (
    id, workspace_id, project_id, topic_type, topic_id, event_type,
    aggregate_revision, actor_principal_id, payload, occurred_at
  ) VALUES (
    NEW.id, NEW.workspace_id, NEW.project_id, NEW.aggregate_type, NEW.aggregate_id,
    NEW.event_type, NEW.aggregate_revision, NEW.actor_principal_id, NEW.payload, NEW.occurred_at
  ) ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER outbox_events_mirror_realtime
AFTER INSERT ON outbox_events
FOR EACH ROW EXECUTE FUNCTION mirror_outbox_to_realtime();

CREATE OR REPLACE FUNCTION claim_folio_jobs(
  worker_name text,
  supported_kinds text[],
  lease_seconds integer,
  claim_limit integer DEFAULT 1
)
RETURNS SETOF jobs
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT id
    FROM jobs
    WHERE kind = ANY(supported_kinds)
      AND available_at <= now()
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

CREATE INDEX realtime_event_log_workspace_cursor_idx ON realtime_event_log(workspace_id, cursor_id);
CREATE INDEX realtime_event_log_topic_cursor_idx ON realtime_event_log(topic_type, topic_id, cursor_id);
CREATE INDEX presence_sessions_expiry_idx ON presence_sessions(expires_at);
CREATE INDEX integration_connections_state_idx ON integration_connections(project_id, state, updated_at DESC) WHERE archived_at IS NULL;
CREATE INDEX calendar_external_bindings_sync_idx ON calendar_external_bindings(state, updated_at) WHERE archived_at IS NULL;
CREATE INDEX provider_operations_state_idx ON provider_operations(state, created_at) WHERE state IN ('pending', 'running');
CREATE INDEX job_attempts_job_idx ON job_attempts(job_id, attempt_number DESC);
CREATE INDEX operation_metrics_name_time_idx ON operation_metrics(metric_name, recorded_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  realtime_event_log, presence_sessions, integration_connections,
  calendar_external_bindings, provider_operations, job_attempts, operation_metrics
TO folio_runtime;
GRANT USAGE, SELECT ON SEQUENCE realtime_event_log_cursor_id_seq TO folio_runtime;

DO $$
DECLARE table_name text; owner_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'realtime_event_log','presence_sessions','integration_connections',
    'calendar_external_bindings','provider_operations','operation_metrics'
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

ALTER TABLE job_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_attempts FORCE ROW LEVEL SECURITY;
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
CREATE POLICY folio_runtime_job_access ON job_attempts TO folio_runtime
  USING (EXISTS (
    SELECT 1 FROM jobs j
    WHERE j.id = job_attempts.job_id
      AND (j.workspace_id IS NULL OR j.workspace_id = folio.current_workspace_id())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM jobs j
    WHERE j.id = job_attempts.job_id
      AND (j.workspace_id IS NULL OR j.workspace_id = folio.current_workspace_id())
  ));