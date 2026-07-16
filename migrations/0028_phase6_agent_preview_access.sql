ALTER TABLE canvas_action_previews
  ADD COLUMN authorizing_principal_id uuid NOT NULL REFERENCES principals(id);

CREATE INDEX canvas_action_previews_authorizer_idx
  ON canvas_action_previews(project_id,authorizing_principal_id,created_at DESC);

DROP POLICY IF EXISTS canvas_action_previews_creator_scope ON canvas_action_previews;
CREATE POLICY canvas_action_previews_actor_chain_scope ON canvas_action_previews
  AS RESTRICTIVE TO folio_runtime
  USING (
    created_by_principal_id=folio.current_principal_id()
    OR authorizing_principal_id=folio.current_principal_id()
  )
  WITH CHECK (created_by_principal_id=folio.current_principal_id());
