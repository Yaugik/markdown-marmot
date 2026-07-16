CREATE TABLE page_comment_threads (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  page_id uuid NOT NULL,
  page_revision_id uuid,
  anchor jsonb NOT NULL DEFAULT '{}'::jsonb,
  anchor_state text NOT NULL DEFAULT 'current'
    CHECK (anchor_state IN ('current', 'moved', 'stale')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_principal_id uuid NOT NULL REFERENCES principals(id),
  resolved_by_principal_id uuid REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  archived_at timestamptz,
  UNIQUE (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, page_id)
    REFERENCES pages(workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, page_revision_id)
    REFERENCES native_page_revisions(workspace_id, project_id, id),
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL))
);

CREATE TABLE page_comments (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  body jsonb NOT NULL,
  plain_text text NOT NULL CHECK (length(trim(plain_text)) BETWEEN 1 AND 10000),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  author_principal_id uuid NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, thread_id)
    REFERENCES page_comment_threads(workspace_id, project_id, id)
);

CREATE TABLE mentions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  page_id uuid NOT NULL,
  comment_id uuid,
  mentioned_principal_id uuid NOT NULL REFERENCES principals(id),
  created_by_principal_id uuid NOT NULL REFERENCES principals(id),
  state text NOT NULL DEFAULT 'unread' CHECK (state IN ('unread', 'read', 'dismissed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  UNIQUE NULLS NOT DISTINCT (comment_id, mentioned_principal_id),
  FOREIGN KEY (workspace_id, project_id, page_id)
    REFERENCES pages(workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, comment_id)
    REFERENCES page_comments(workspace_id, project_id, id)
);

CREATE TABLE attachments (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  page_id uuid NOT NULL,
  comment_id uuid,
  object_key text NOT NULL,
  file_name text NOT NULL CHECK (length(trim(file_name)) BETWEEN 1 AND 255),
  mime_type text NOT NULL CHECK (length(trim(mime_type)) BETWEEN 1 AND 255),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 0 AND 10485760),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  storage_state text NOT NULL DEFAULT 'pending'
    CHECK (storage_state IN ('pending', 'available', 'failed')),
  scan_state text NOT NULL DEFAULT 'pending'
    CHECK (scan_state IN ('pending', 'clean', 'rejected')),
  uploaded_by_principal_id uuid NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz,
  archived_at timestamptz,
  UNIQUE (workspace_id, object_key),
  UNIQUE (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, page_id)
    REFERENCES pages(workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, comment_id)
    REFERENCES page_comments(workspace_id, project_id, id)
);

CREATE TABLE page_links (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  source_page_id uuid NOT NULL,
  source_revision_id uuid,
  target_page_id uuid,
  external_url text,
  link_kind text NOT NULL CHECK (link_kind IN ('page', 'external')),
  label text,
  locator jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL DEFAULT 'current' CHECK (state IN ('current', 'stale', 'broken')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, project_id, id),
  CHECK (
    (link_kind = 'page' AND target_page_id IS NOT NULL AND external_url IS NULL)
    OR (link_kind = 'external' AND target_page_id IS NULL AND external_url IS NOT NULL)
  ),
  FOREIGN KEY (workspace_id, project_id, source_page_id)
    REFERENCES pages(workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, target_page_id)
    REFERENCES pages(workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, source_revision_id)
    REFERENCES native_page_revisions(workspace_id, project_id, id)
);

CREATE TABLE page_search_documents (
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  page_id uuid NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('git', 'native')),
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  current_revision_id uuid,
  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(body, '')), 'B')
  ) STORED,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, project_id, page_id),
  FOREIGN KEY (workspace_id, project_id, page_id)
    REFERENCES pages(workspace_id, project_id, id)
);

CREATE TABLE page_conversion_previews (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  source_page_id uuid,
  operation text NOT NULL CHECK (operation IN ('git_to_native', 'native_to_git', 'convert')),
  source_descriptor jsonb NOT NULL,
  target_descriptor jsonb NOT NULL,
  relationship_plan jsonb NOT NULL DEFAULT '{}'::jsonb,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  proposal jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL DEFAULT 'prepared'
    CHECK (state IN ('prepared', 'executed', 'expired', 'canceled')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_principal_id uuid NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  executed_at timestamptz,
  UNIQUE (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, source_page_id)
    REFERENCES pages(workspace_id, project_id, id),
  CHECK (expires_at > created_at)
);

CREATE INDEX page_comment_threads_page_idx
  ON page_comment_threads (page_id, status, updated_at DESC) WHERE archived_at IS NULL;
CREATE INDEX page_comments_thread_idx
  ON page_comments (thread_id, created_at, id) WHERE archived_at IS NULL;
CREATE INDEX mentions_principal_state_idx
  ON mentions (mentioned_principal_id, state, created_at DESC);
CREATE INDEX attachments_page_idx
  ON attachments (page_id, created_at DESC) WHERE archived_at IS NULL;
CREATE INDEX page_links_source_idx ON page_links (source_page_id, state);
CREATE INDEX page_links_target_idx ON page_links (target_page_id, state) WHERE target_page_id IS NOT NULL;
CREATE INDEX page_search_documents_vector_idx ON page_search_documents USING gin (search_vector);
CREATE INDEX page_conversion_previews_expiry_idx
  ON page_conversion_previews (state, expires_at) WHERE state = 'prepared';

CREATE OR REPLACE FUNCTION mark_page_knowledge_stale()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE page_comment_threads
     SET anchor_state = 'stale', revision = revision + 1, updated_at = now()
   WHERE workspace_id = NEW.workspace_id
     AND project_id = NEW.project_id
     AND page_id = NEW.page_id
     AND page_revision_id IS DISTINCT FROM NEW.id
     AND status = 'open'
     AND archived_at IS NULL
     AND anchor_state = 'current';

  UPDATE page_links
     SET state = 'stale'
   WHERE workspace_id = NEW.workspace_id
     AND project_id = NEW.project_id
     AND source_page_id = NEW.page_id
     AND source_revision_id IS DISTINCT FROM NEW.id
     AND state = 'current';

  RETURN NEW;
END;
$$;

CREATE TRIGGER native_page_revision_marks_knowledge_stale
AFTER INSERT ON native_page_revisions
FOR EACH ROW EXECUTE FUNCTION mark_page_knowledge_stale();

CREATE OR REPLACE FUNCTION refresh_native_page_search_document()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  page_title text;
BEGIN
  SELECT title INTO page_title
    FROM pages
   WHERE workspace_id = NEW.workspace_id
     AND project_id = NEW.project_id
     AND id = NEW.page_id;

  INSERT INTO page_search_documents (
    workspace_id, project_id, page_id, source_type, title, body,
    current_revision_id, updated_at
  ) VALUES (
    NEW.workspace_id, NEW.project_id, NEW.page_id, 'native', page_title,
    NEW.plain_text, NEW.id, now()
  )
  ON CONFLICT (workspace_id, project_id, page_id)
  DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body,
    current_revision_id = EXCLUDED.current_revision_id, updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER native_page_revision_refreshes_search
AFTER INSERT ON native_page_revisions
FOR EACH ROW EXECUTE FUNCTION refresh_native_page_search_document();

CREATE OR REPLACE FUNCTION refresh_page_search_title()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE page_search_documents
     SET title = NEW.title, updated_at = now()
   WHERE workspace_id = NEW.workspace_id
     AND project_id = NEW.project_id
     AND page_id = NEW.id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER page_title_refreshes_search
AFTER UPDATE OF title ON pages
FOR EACH ROW EXECUTE FUNCTION refresh_page_search_title();

GRANT SELECT, INSERT, UPDATE ON TABLE
  page_comment_threads,
  page_comments,
  mentions,
  attachments,
  page_links,
  page_search_documents,
  page_conversion_previews
TO folio_runtime;
GRANT DELETE ON TABLE page_links TO folio_runtime;

DO $$
DECLARE
  table_name text;
  owner_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'page_comment_threads', 'page_comments', 'mentions', 'attachments',
    'page_links', 'page_search_documents', 'page_conversion_previews'
  ]
  LOOP
    SELECT pg_get_userbyid(c.relowner)
      INTO owner_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
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
