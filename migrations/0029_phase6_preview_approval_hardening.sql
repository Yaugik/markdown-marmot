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

CREATE OR REPLACE FUNCTION normalize_phase6_outbox_aggregate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.event_type='canvas.region_organized.v1' THEN
    IF NEW.aggregate_type <> 'canvas'
      OR NOT (NEW.payload ? 'canvasId')
      OR (NEW.payload->>'canvasId') !~* '^[0-9a-f-]{36}$' THEN
      RAISE EXCEPTION 'Canvas region organization event aggregate is invalid'
        USING ERRCODE='23514';
    END IF;
    NEW.aggregate_id := (NEW.payload->>'canvasId')::uuid;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER outbox_events_normalize_phase6_aggregate
BEFORE INSERT ON outbox_events
FOR EACH ROW EXECUTE FUNCTION normalize_phase6_outbox_aggregate();

CREATE OR REPLACE FUNCTION prevent_private_agent_canvas_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE owner_kind text;
BEGIN
  IF NEW.visibility <> 'private' THEN RETURN NEW; END IF;
  SELECT kind INTO owner_kind FROM principals WHERE id=NEW.owner_principal_id;
  IF owner_kind='agent' THEN
    RAISE EXCEPTION 'Private Canvases require a human or system owner'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER canvases_prevent_private_agent_owner
BEFORE INSERT OR UPDATE OF owner_principal_id,visibility ON canvases
FOR EACH ROW EXECUTE FUNCTION prevent_private_agent_canvas_owner();
