CREATE TABLE users (
  id uuid PRIMARY KEY,
  display_name text NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 120),
  primary_email text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'archived')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (primary_email)
);

CREATE TABLE external_identities (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  provider text NOT NULL,
  provider_subject text NOT NULL,
  verified_email text,
  claims_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_authenticated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_subject)
);

CREATE TABLE principals (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('human', 'agent', 'api_client', 'worker', 'system')),
  user_id uuid UNIQUE REFERENCES users(id),
  display_name text NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'archived')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CHECK ((kind = 'human' AND user_id IS NOT NULL) OR (kind <> 'human' AND user_id IS NULL))
);

CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'archived')),
  default_time_zone text NOT NULL DEFAULT 'UTC',
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (slug)
);

CREATE TABLE workspace_memberships (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  principal_id uuid NOT NULL REFERENCES principals(id),
  role text NOT NULL CHECK (role IN ('owner', 'member')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('invited', 'active', 'suspended', 'removed')),
  invited_by_principal_id uuid REFERENCES principals(id),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, principal_id)
);

CREATE TABLE projects (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_key text NOT NULL CHECK (project_key ~ '^[A-Z][A-Z0-9]{1,9}$'),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'archived')),
  time_zone text NOT NULL DEFAULT 'UTC',
  default_git_write_policy text NOT NULL DEFAULT 'pull_request_only'
    CHECK (default_git_write_policy IN ('disabled', 'pull_request_only', 'direct_allowed')),
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (workspace_id, project_key),
  UNIQUE (workspace_id, id)
);

CREATE TABLE role_templates (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  template_key text NOT NULL CHECK (template_key ~ '^[a-z][a-z0-9_]{1,39}$'),
  capabilities text[] NOT NULL DEFAULT '{}',
  is_system_template boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (workspace_id, template_key),
  UNIQUE (workspace_id, id)
);

CREATE TABLE project_memberships (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id uuid NOT NULL,
  principal_id uuid NOT NULL REFERENCES principals(id),
  role_template_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('invited', 'active', 'suspended', 'removed')),
  invited_by_principal_id uuid REFERENCES principals(id),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, principal_id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id),
  FOREIGN KEY (workspace_id, role_template_id) REFERENCES role_templates(workspace_id, id)
);

CREATE TABLE capability_grants (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id uuid,
  principal_id uuid NOT NULL REFERENCES principals(id),
  capability text NOT NULL CHECK (capability ~ '^[a-z][a-z0-9_.:-]{2,99}$'),
  effect text NOT NULL CHECK (effect IN ('allow', 'deny')),
  constraints jsonb NOT NULL DEFAULT '{}'::jsonb,
  granted_by_principal_id uuid NOT NULL REFERENCES principals(id),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_until IS NULL OR valid_until > valid_from),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id)
);

CREATE TABLE object_grants (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id uuid NOT NULL,
  principal_id uuid NOT NULL REFERENCES principals(id),
  object_type text NOT NULL CHECK (object_type IN ('page', 'issue', 'saved_view', 'todo_list', 'calendar')),
  object_id uuid NOT NULL,
  capabilities text[] NOT NULL,
  granted_by_principal_id uuid NOT NULL REFERENCES principals(id),
  valid_until timestamptz,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (principal_id, object_type, object_id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id)
);

CREATE TABLE action_confirmations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id uuid,
  actor_principal_id uuid NOT NULL REFERENCES principals(id),
  authorizing_principal_id uuid NOT NULL REFERENCES principals(id),
  operation text NOT NULL,
  action_digest text NOT NULL CHECK (action_digest ~ '^[a-f0-9]{64}$'),
  risk_level text NOT NULL CHECK (risk_level IN ('R2', 'R3')),
  preview jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'consumed', 'revoked')),
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  consumed_at timestamptz,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (authorizing_principal_id, action_digest, status),
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR status = 'consumed'),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id)
);

CREATE TABLE activity_events (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id uuid,
  actor_principal_id uuid NOT NULL REFERENCES principals(id),
  authorizing_principal_id uuid REFERENCES principals(id),
  source text NOT NULL CHECK (source IN ('ui', 'api', 'agent', 'worker', 'system', 'import')),
  action text NOT NULL,
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  input_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_id uuid NOT NULL,
  trace_id text,
  confirmation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id),
  FOREIGN KEY (workspace_id, confirmation_id) REFERENCES action_confirmations(workspace_id, id)
);

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id uuid,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  aggregate_revision bigint NOT NULL CHECK (aggregate_revision > 0),
  event_type text NOT NULL,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  actor_principal_id uuid NOT NULL REFERENCES principals(id),
  authorizing_principal_id uuid REFERENCES principals(id),
  request_id uuid NOT NULL,
  trace_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  publish_attempts integer NOT NULL DEFAULT 0 CHECK (publish_attempts >= 0),
  last_error text,
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id)
);

CREATE TABLE idempotency_records (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id uuid,
  principal_id uuid NOT NULL REFERENCES principals(id),
  operation text NOT NULL,
  idempotency_key text NOT NULL,
  request_digest text NOT NULL,
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  UNIQUE NULLS NOT DISTINCT (workspace_id, project_id, principal_id, operation, idempotency_key),
  CHECK (expires_at > created_at),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id)
);

CREATE TABLE jobs (
  id uuid PRIMARY KEY,
  workspace_id uuid REFERENCES workspaces(id),
  project_id uuid,
  kind text NOT NULL,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  payload jsonb NOT NULL,
  deduplication_key text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'waiting_provider', 'blocked_confirmation', 'succeeded', 'succeeded_with_warnings', 'failed', 'canceled')),
  priority smallint NOT NULL DEFAULT 100,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  leased_until timestamptz,
  leased_by text,
  last_error_code text,
  last_error_message text,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id)
);

CREATE INDEX workspace_memberships_principal_idx ON workspace_memberships (principal_id, status);
CREATE INDEX projects_workspace_status_idx ON projects (workspace_id, status);
CREATE INDEX project_memberships_principal_idx ON project_memberships (principal_id, status);
CREATE INDEX capability_grants_lookup_idx ON capability_grants (workspace_id, project_id, principal_id, capability);
CREATE INDEX object_grants_lookup_idx ON object_grants (project_id, principal_id, object_type, object_id);
CREATE INDEX activity_events_project_time_idx ON activity_events (project_id, created_at DESC);
CREATE INDEX outbox_events_unpublished_idx ON outbox_events (occurred_at) WHERE published_at IS NULL;
CREATE INDEX jobs_claim_idx ON jobs (priority, available_at, created_at)
  WHERE status IN ('pending', 'running', 'waiting_provider');
CREATE UNIQUE INDEX jobs_active_dedup_idx ON jobs (workspace_id, project_id, kind, deduplication_key) NULLS NOT DISTINCT
  WHERE deduplication_key IS NOT NULL
    AND status IN ('pending', 'running', 'waiting_provider', 'blocked_confirmation');

CREATE OR REPLACE FUNCTION prevent_activity_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'activity_events are append-only';
END;
$$;

CREATE TRIGGER activity_events_append_only
BEFORE UPDATE OR DELETE ON activity_events
FOR EACH ROW EXECUTE FUNCTION prevent_activity_event_mutation();

CREATE TRIGGER activity_events_no_truncate
BEFORE TRUNCATE ON activity_events
FOR EACH STATEMENT EXECUTE FUNCTION prevent_activity_event_mutation();
