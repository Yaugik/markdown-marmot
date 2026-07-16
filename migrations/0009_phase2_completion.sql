ALTER TABLE page_links
  DROP CONSTRAINT IF EXISTS page_links_workspace_id_project_id_source_revision_id_fkey;

ALTER TABLE page_links
  ALTER COLUMN source_revision_id TYPE text USING source_revision_id::text;

COMMENT ON COLUMN page_links.source_revision_id IS
  'Application-level polymorphic revision reference. Native revision UUIDs and Git commit/blob identifiers are stored as text and validated by the source-specific service.';

ALTER TABLE page_search_documents
  ALTER COLUMN current_revision_id TYPE text USING current_revision_id::text;

COMMENT ON COLUMN page_search_documents.current_revision_id IS
  'Polymorphic current source revision: native revision UUID text or Git snapshot/commit/blob identifier.';

ALTER TABLE page_links
  ADD CONSTRAINT page_links_external_url_length
  CHECK (external_url IS NULL OR length(external_url) <= 2048);

ALTER TABLE page_conversion_previews
  ADD CONSTRAINT page_conversion_previews_executed_state
  CHECK ((state = 'executed') = (executed_at IS NOT NULL));

CREATE OR REPLACE FUNCTION validate_active_page_tree_placement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.node_kind IN ('page', 'alias') AND NEW.archived_at IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM pages
      WHERE workspace_id = NEW.workspace_id
        AND project_id = NEW.project_id
        AND id = NEW.page_id
        AND status = 'active'
    ) THEN
    RAISE EXCEPTION 'active page tree placement requires an active page'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER page_tree_nodes_require_active_page
BEFORE INSERT OR UPDATE OF workspace_id, project_id, page_id, archived_at
ON page_tree_nodes
FOR EACH ROW EXECUTE FUNCTION validate_active_page_tree_placement();
