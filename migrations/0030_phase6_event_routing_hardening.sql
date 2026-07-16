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
