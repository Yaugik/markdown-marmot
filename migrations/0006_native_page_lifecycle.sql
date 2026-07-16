CREATE OR REPLACE FUNCTION enforce_active_native_page_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pages
    WHERE workspace_id = NEW.workspace_id
      AND project_id = NEW.project_id
      AND id = NEW.page_id
      AND source_type = 'native'
      AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'native page must be active before creating a revision'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER native_page_revisions_require_active_page
BEFORE INSERT ON native_page_revisions
FOR EACH ROW EXECUTE FUNCTION enforce_active_native_page_revision();
