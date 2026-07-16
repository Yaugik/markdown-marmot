CREATE TABLE oidc_auth_transactions (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{32}$'),
  nonce text NOT NULL,
  pkce_verifier text NOT NULL,
  return_to text NOT NULL DEFAULT '/',
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at),
  CHECK (return_to LIKE '/%' AND return_to NOT LIKE '//%')
);

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  principal_id uuid NOT NULL REFERENCES principals(id),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at),
  CHECK (idle_expires_at <= expires_at)
);

CREATE INDEX auth_sessions_active_lookup_idx ON auth_sessions (token_hash, expires_at)
  WHERE revoked_at IS NULL;
CREATE INDEX auth_sessions_user_idx ON auth_sessions (user_id, created_at DESC);
CREATE INDEX oidc_auth_transactions_expiry_idx ON oidc_auth_transactions (expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE security_events (
  id uuid PRIMARY KEY,
  actor_principal_id uuid REFERENCES principals(id),
  event_type text NOT NULL,
  result text NOT NULL CHECK (result IN ('succeeded', 'failed', 'blocked')),
  request_id uuid,
  trace_id text,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION prevent_security_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'security_events are append-only';
END;
$$;

CREATE TRIGGER security_events_append_only
BEFORE UPDATE OR DELETE ON security_events
FOR EACH ROW EXECUTE FUNCTION prevent_security_event_mutation();

CREATE TRIGGER security_events_no_truncate
BEFORE TRUNCATE ON security_events
FOR EACH STATEMENT EXECUTE FUNCTION prevent_security_event_mutation();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'folio_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON oidc_auth_transactions TO folio_runtime;
    GRANT SELECT, INSERT, UPDATE ON auth_sessions TO folio_runtime;
    GRANT SELECT, INSERT ON security_events TO folio_runtime;
  END IF;
END
$$;
