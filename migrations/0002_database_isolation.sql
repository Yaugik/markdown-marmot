CREATE SCHEMA IF NOT EXISTS folio;

CREATE OR REPLACE FUNCTION folio.current_workspace_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT nullif(current_setting('folio.workspace_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION folio.current_principal_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT nullif(current_setting('folio.principal_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION folio.set_transaction_context(workspace_id uuid, principal_id uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
AS $$
BEGIN
  IF workspace_id IS NULL OR principal_id IS NULL THEN
    RAISE EXCEPTION 'workspace and principal context are required'
      USING ERRCODE = '22004';
  END IF;

  -- true makes both settings transaction-local. Callers must establish context in
  -- every transaction; pooled connections cannot retain it for the next request.
  PERFORM set_config('folio.workspace_id', workspace_id::text, true);
  PERFORM set_config('folio.principal_id', principal_id::text, true);
END;
$$;

REVOKE ALL ON SCHEMA folio FROM PUBLIC;
REVOKE ALL ON FUNCTION folio.current_workspace_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION folio.current_principal_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION folio.set_transaction_context(uuid, uuid) FROM PUBLIC;

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'folio_runtime') THEN
    CREATE ROLE folio_runtime
      NOLOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOINHERIT
      NOBYPASSRLS;
  END IF;
END
$$;

-- The migration connection may SET ROLE for smoke tests. Production should give
-- LOGIN to a separate deployment-specific role and grant folio_runtime to it.
DO $$
BEGIN
  EXECUTE format('GRANT folio_runtime TO %I', current_user);
END
$$;

GRANT USAGE ON SCHEMA public, folio TO folio_runtime;
GRANT EXECUTE ON FUNCTION folio.current_workspace_id() TO folio_runtime;
GRANT EXECUTE ON FUNCTION folio.current_principal_id() TO folio_runtime;
GRANT EXECUTE ON FUNCTION folio.set_transaction_context(uuid, uuid) TO folio_runtime;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  workspaces,
  workspace_memberships,
  projects,
  role_templates,
  project_memberships,
  capability_grants,
  object_grants,
  action_confirmations,
  activity_events,
  outbox_events,
  idempotency_records,
  jobs
TO folio_runtime;

DO $$
DECLARE
  table_name text;
  owner_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'workspaces',
    'workspace_memberships',
    'projects',
    'role_templates',
    'project_memberships',
    'capability_grants',
    'object_grants',
    'action_confirmations',
    'activity_events',
    'outbox_events',
    'idempotency_records',
    'jobs'
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

    -- FORCE RLS also applies to the table owner. This explicit owner policy keeps
    -- checksum migrations and data backfills executable without granting the
    -- runtime role BYPASSRLS.
    EXECUTE format(
      'CREATE POLICY folio_migration_owner_access ON public.%I TO %I USING (true) WITH CHECK (true)',
      table_name,
      owner_name
    );

    IF table_name = 'workspaces' THEN
      EXECUTE format(
        'CREATE POLICY folio_runtime_workspace_scope ON public.%I TO folio_runtime USING (id = folio.current_workspace_id()) WITH CHECK (id = folio.current_workspace_id())',
        table_name
      );
    ELSE
      EXECUTE format(
        'CREATE POLICY folio_runtime_workspace_scope ON public.%I TO folio_runtime USING (workspace_id = folio.current_workspace_id()) WITH CHECK (workspace_id = folio.current_workspace_id())',
        table_name
      );
    END IF;
  END LOOP;
END
$$;
