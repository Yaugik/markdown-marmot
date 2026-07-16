CREATE OR REPLACE FUNCTION validate_active_issue_parent_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM issues child
    LEFT JOIN issues parent
      ON parent.workspace_id = child.workspace_id
     AND parent.project_id = child.project_id
     AND parent.id = child.parent_issue_id
    WHERE child.workspace_id = NEW.workspace_id
      AND child.project_id = NEW.project_id
      AND child.lifecycle = 'active'
      AND child.parent_issue_id IS NOT NULL
      AND (parent.id IS NULL OR parent.lifecycle <> 'active')
  ) THEN
    RAISE EXCEPTION 'active issue requires an active parent'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER issues_active_parent_integrity
AFTER INSERT OR UPDATE OF parent_issue_id, lifecycle
ON issues
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_active_issue_parent_integrity();

DROP POLICY folio_runtime_workspace_scope ON issue_bulk_previews;

CREATE POLICY folio_runtime_creator_scope
ON issue_bulk_previews
TO folio_runtime
USING (
  workspace_id = folio.current_workspace_id()
  AND created_by_principal_id = folio.current_principal_id()
)
WITH CHECK (
  workspace_id = folio.current_workspace_id()
  AND created_by_principal_id = folio.current_principal_id()
);

CREATE INDEX issue_bulk_previews_creator_state_idx
  ON issue_bulk_previews (created_by_principal_id, state, expires_at);
