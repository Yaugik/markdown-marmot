ALTER TABLE page_links
  DROP CONSTRAINT IF EXISTS page_links_workspace_id_project_id_source_revision_id_fkey;

COMMENT ON COLUMN page_links.source_revision_id IS
  'Application-level polymorphic revision reference. Native revisions are validated by the native page service; Git revisions are validated by the synchronization service.';

ALTER TABLE page_links
  ADD CONSTRAINT page_links_external_url_length
  CHECK (external_url IS NULL OR length(external_url) <= 2048);

ALTER TABLE page_conversion_previews
  ADD CONSTRAINT page_conversion_previews_executed_state
  CHECK ((state = 'executed') = (executed_at IS NOT NULL));
