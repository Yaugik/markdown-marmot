CREATE OR REPLACE FUNCTION validate_canvas_action_preview_elements()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE requested_count integer;
DECLARE matched_count integer;
BEGIN
  SELECT cardinality(NEW.source_element_ids) INTO requested_count;
  SELECT count(*) INTO matched_count
  FROM canvas_elements element
  WHERE element.workspace_id=NEW.workspace_id
    AND element.project_id=NEW.project_id
    AND element.canvas_id=NEW.canvas_id
    AND element.id=ANY(NEW.source_element_ids)
    AND element.archived_at IS NULL;
  IF requested_count IS NULL OR requested_count <> matched_count THEN
    RAISE EXCEPTION 'Canvas action preview elements must be active on the selected Canvas'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER canvas_action_previews_validate_elements
BEFORE INSERT OR UPDATE OF workspace_id,project_id,canvas_id,source_element_ids
ON canvas_action_previews
FOR EACH ROW EXECUTE FUNCTION validate_canvas_action_preview_elements();

CREATE OR REPLACE FUNCTION validate_promoted_canvas_connector()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE relationship_id uuid;
DECLARE from_element_id uuid;
DECLARE to_element_id uuid;
DECLARE from_type text;
DECLARE from_id uuid;
DECLARE to_type text;
DECLARE to_id uuid;
DECLARE relationship_record record;
DECLARE relationship_symmetric boolean;
BEGIN
  IF NEW.archived_at IS NOT NULL THEN
    NEW.promoted_relationship_id := NULL;
    RETURN NEW;
  END IF;
  IF NEW.element_kind <> 'connector' OR NOT (NEW.content ? 'promotedRelationshipId') THEN
    NEW.promoted_relationship_id := NULL;
    RETURN NEW;
  END IF;

  BEGIN
    relationship_id := (NEW.content->>'promotedRelationshipId')::uuid;
    from_element_id := (NEW.content->>'fromElementId')::uuid;
    to_element_id := (NEW.content->>'toElementId')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'Promoted Canvas connector references are invalid' USING ERRCODE='23514';
  END;

  SELECT entity_type,entity_id INTO from_type,from_id
  FROM canvas_elements
  WHERE workspace_id=NEW.workspace_id AND project_id=NEW.project_id
    AND canvas_id=NEW.canvas_id AND id=from_element_id
    AND element_kind='entity_card' AND archived_at IS NULL;
  SELECT entity_type,entity_id INTO to_type,to_id
  FROM canvas_elements
  WHERE workspace_id=NEW.workspace_id AND project_id=NEW.project_id
    AND canvas_id=NEW.canvas_id AND id=to_element_id
    AND element_kind='entity_card' AND archived_at IS NULL;
  IF from_id IS NULL OR to_id IS NULL THEN
    RAISE EXCEPTION 'Promoted connectors require two active entity-card endpoints' USING ERRCODE='23514';
  END IF;

  SELECT relationship.*,relationship_type.symmetric
    INTO relationship_record
  FROM entity_relationships relationship
  JOIN relationship_types relationship_type
    ON relationship_type.workspace_id=relationship.workspace_id
    AND relationship_type.project_id=relationship.project_id
    AND relationship_type.id=relationship.relationship_type_id
  WHERE relationship.workspace_id=NEW.workspace_id
    AND relationship.project_id=NEW.project_id
    AND relationship.id=relationship_id
    AND relationship.provenance='explicit'
    AND relationship.state='accepted'
    AND relationship.archived_at IS NULL;
  IF relationship_record.id IS NULL THEN
    RAISE EXCEPTION 'Promoted connector relationship is not an active explicit relationship'
      USING ERRCODE='23514';
  END IF;
  relationship_symmetric := relationship_record.symmetric;

  IF NOT (
    relationship_record.source_entity_type=from_type
    AND relationship_record.source_entity_id=from_id
    AND relationship_record.target_entity_type=to_type
    AND relationship_record.target_entity_id=to_id
  ) AND NOT (
    relationship_symmetric
    AND relationship_record.source_entity_type=to_type
    AND relationship_record.source_entity_id=to_id
    AND relationship_record.target_entity_type=from_type
    AND relationship_record.target_entity_id=from_id
  ) THEN
    RAISE EXCEPTION 'Promoted connector endpoints do not match the relationship endpoints'
      USING ERRCODE='23514';
  END IF;

  NEW.promoted_relationship_id := relationship_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER canvas_elements_validate_promoted_connector
BEFORE INSERT OR UPDATE OF element_kind,content,archived_at
ON canvas_elements
FOR EACH ROW EXECUTE FUNCTION validate_promoted_canvas_connector();

CREATE OR REPLACE FUNCTION validate_relationship_derivation_actor()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE actor_kind text;
BEGIN
  SELECT kind INTO actor_kind FROM principals WHERE id=NEW.created_by_principal_id;
  IF NEW.source_kind='agent_synthesis' AND actor_kind <> 'agent' THEN
    RAISE EXCEPTION 'Agent synthesis derivations require an agent principal'
      USING ERRCODE='23514';
  END IF;
  IF NEW.source_kind<>'agent_synthesis' AND actor_kind <> 'system' THEN
    RAISE EXCEPTION 'Revision and provider derivations require a system principal'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER relationship_derivation_runs_validate_actor
BEFORE INSERT OR UPDATE OF source_kind,created_by_principal_id
ON relationship_derivation_runs
FOR EACH ROW EXECUTE FUNCTION validate_relationship_derivation_actor();

CREATE OR REPLACE FUNCTION supersede_relationship_derivation_runs()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE relationship_derivation_runs
  SET state='superseded',completed_at=coalesce(completed_at,now())
  WHERE workspace_id=NEW.workspace_id AND project_id=NEW.project_id
    AND rebuild_key=NEW.rebuild_key AND id<>NEW.id
    AND state='succeeded';
  RETURN NEW;
END;
$$;

CREATE TRIGGER relationship_derivation_runs_supersede_previous
AFTER INSERT ON relationship_derivation_runs
FOR EACH ROW EXECUTE FUNCTION supersede_relationship_derivation_runs();
