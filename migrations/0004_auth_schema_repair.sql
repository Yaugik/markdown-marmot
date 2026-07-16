-- Canonical public-schema definitions. IF NOT EXISTS is intentional: clean
-- databases already received these from 0003, while an unreleased development
-- build could have created equivalent tables under the `folio` schema.
CREATE TABLE IF NOT EXISTS public.oidc_auth_transactions (
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

CREATE TABLE IF NOT EXISTS public.auth_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.users(id),
  principal_id uuid NOT NULL REFERENCES public.principals(id),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at),
  CHECK (idle_expires_at <= expires_at)
);

CREATE TABLE IF NOT EXISTS public.security_events (
  id uuid PRIMARY KEY,
  actor_principal_id uuid REFERENCES public.principals(id),
  event_type text NOT NULL,
  result text NOT NULL CHECK (result IN ('succeeded', 'failed', 'blocked')),
  request_id uuid,
  trace_id text,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auth_sessions_active_lookup_idx ON public.auth_sessions (token_hash, expires_at)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON public.auth_sessions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS oidc_auth_transactions_expiry_idx ON public.oidc_auth_transactions (expires_at)
  WHERE consumed_at IS NULL;

CREATE OR REPLACE FUNCTION public.prevent_security_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'security_events are append-only';
END;
$$;

DROP TRIGGER IF EXISTS security_events_append_only ON public.security_events;
CREATE TRIGGER security_events_append_only
BEFORE UPDATE OR DELETE ON public.security_events
FOR EACH ROW EXECUTE FUNCTION public.prevent_security_event_mutation();

DROP TRIGGER IF EXISTS security_events_no_truncate ON public.security_events;
CREATE TRIGGER security_events_no_truncate
BEFORE TRUNCATE ON public.security_events
FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_security_event_mutation();

-- Preserve compatible sessions/security history from the development schema.
DO $$
BEGIN
  IF to_regclass('folio.auth_sessions') IS NOT NULL THEN
    INSERT INTO public.auth_sessions
    SELECT * FROM folio.auth_sessions
    ON CONFLICT (id) DO NOTHING;
  END IF;
  IF to_regclass('folio.security_events') IS NOT NULL THEN
    INSERT INTO public.security_events
    SELECT * FROM folio.security_events
    ON CONFLICT (id) DO NOTHING;
  END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE ON TABLE public.users, public.external_identities, public.principals TO folio_runtime;
GRANT SELECT, INSERT, UPDATE ON public.oidc_auth_transactions TO folio_runtime;
GRANT SELECT, INSERT, UPDATE ON public.auth_sessions TO folio_runtime;
GRANT SELECT, INSERT ON public.security_events TO folio_runtime;
