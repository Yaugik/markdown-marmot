CREATE OR REPLACE FUNCTION prevent_canvas_action_preview_actor_chain_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.created_by_principal_id <> OLD.created_by_principal_id
    OR NEW.authorizing_principal_id <> OLD.authorizing_principal_id THEN
    RAISE EXCEPTION 'Canvas action preview actor chain is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER canvas_action_previews_actor_chain_immutable
BEFORE UPDATE OF created_by_principal_id,authorizing_principal_id
ON canvas_action_previews
FOR EACH ROW EXECUTE FUNCTION prevent_canvas_action_preview_actor_chain_change();

DROP POLICY IF EXISTS canvas_action_previews_actor_chain_scope ON canvas_action_previews;
CREATE POLICY canvas_action_previews_actor_chain_scope ON canvas_action_previews
  AS RESTRICTIVE TO folio_runtime
  USING (
    created_by_principal_id=folio.current_principal_id()
    OR authorizing_principal_id=folio.current_principal_id()
  )
  WITH CHECK (
    created_by_principal_id=folio.current_principal_id()
    OR authorizing_principal_id=folio.current_principal_id()
  );
