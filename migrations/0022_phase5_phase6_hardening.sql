ALTER TABLE page_collaboration_operations ADD CONSTRAINT page_collaboration_operations_size CHECK (pg_column_size(operation) <= 262144);
ALTER TABLE page_collaboration_checkpoints ADD CONSTRAINT page_collaboration_checkpoints_size CHECK (pg_column_size(content) <= 5242880);
ALTER TABLE canvas_revisions ADD CONSTRAINT canvas_revisions_scene_size CHECK (pg_column_size(scene) <= 10485760);
ALTER TABLE canvas_commands ADD CONSTRAINT canvas_commands_size CHECK (pg_column_size(command) <= 262144);
ALTER TABLE canvas_elements ADD CONSTRAINT canvas_elements_geometry_size CHECK (pg_column_size(geometry) <= 65536);
ALTER TABLE canvas_elements ADD CONSTRAINT canvas_elements_content_size CHECK (pg_column_size(content) <= 1048576);

CREATE OR REPLACE FUNCTION folio_entity_exists(
  p_workspace_id uuid,
  p_project_id uuid,
  p_entity_type text,
  p_entity_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  CASE p_entity_type
    WHEN 'page' THEN RETURN EXISTS (
      SELECT 1 FROM pages WHERE workspace_id=p_workspace_id AND project_id=p_project_id AND id=p_entity_id
    );
    WHEN 'issue' THEN RETURN EXISTS (
      SELECT 1 FROM issues WHERE workspace_id=p_workspace_id AND project_id=p_project_id AND id=p_entity_id
    );
    WHEN 'todo' THEN RETURN EXISTS (
      SELECT 1 FROM todos WHERE workspace_id=p_workspace_id AND project_id=p_project_id AND id=p_entity_id
    );
    WHEN 'calendar_entry' THEN RETURN EXISTS (
      SELECT 1 FROM calendar_entries WHERE workspace_id=p_workspace_id AND project_id=p_project_id AND id=p_entity_id
    );
    WHEN 'canvas' THEN RETURN EXISTS (
      SELECT 1 FROM canvases WHERE workspace_id=p_workspace_id AND project_id=p_project_id AND id=p_entity_id
    );
    ELSE RETURN false;
  END CASE;
END;
$$;

CREATE OR REPLACE FUNCTION validate_entity_relationship()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed_sources text[]; allowed_targets text[]; type_state text;
BEGIN
  SELECT source_entity_types,target_entity_types,state
    INTO allowed_sources,allowed_targets,type_state
  FROM relationship_types
  WHERE workspace_id=NEW.workspace_id AND project_id=NEW.project_id AND id=NEW.relationship_type_id;
  IF allowed_sources IS NULL OR type_state <> 'active' THEN
    RAISE EXCEPTION 'active relationship type is required' USING ERRCODE='23514';
  END IF;
  IF NOT NEW.source_entity_type = ANY(allowed_sources) OR NOT NEW.target_entity_type = ANY(allowed_targets) THEN
    RAISE EXCEPTION 'relationship endpoint type is not allowed' USING ERRCODE='23514';
  END IF;
  IF NOT folio_entity_exists(NEW.workspace_id,NEW.project_id,NEW.source_entity_type,NEW.source_entity_id)
    OR NOT folio_entity_exists(NEW.workspace_id,NEW.project_id,NEW.target_entity_type,NEW.target_entity_id) THEN
    RAISE EXCEPTION 'relationship endpoint does not exist in the project' USING ERRCODE='23503';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER entity_relationships_validate
BEFORE INSERT OR UPDATE OF workspace_id,project_id,relationship_type_id,source_entity_type,source_entity_id,target_entity_type,target_entity_id
ON entity_relationships FOR EACH ROW EXECUTE FUNCTION validate_entity_relationship();

CREATE OR REPLACE FUNCTION validate_canvas_entity_card()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.element_kind='entity_card' AND NOT folio_entity_exists(
    NEW.workspace_id,NEW.project_id,NEW.entity_type,NEW.entity_id
  ) THEN
    RAISE EXCEPTION 'canvas entity card target does not exist in the project' USING ERRCODE='23503';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER canvas_elements_validate_entity_card
BEFORE INSERT OR UPDATE OF workspace_id,project_id,element_kind,entity_type,entity_id
ON canvas_elements FOR EACH ROW EXECUTE FUNCTION validate_canvas_entity_card();

CREATE OR REPLACE FUNCTION validate_support_access_confirmation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE confirmation_state text; confirmation_risk text; confirmation_authorizer uuid;
BEGIN
  SELECT status,risk_level,authorizing_principal_id
    INTO confirmation_state,confirmation_risk,confirmation_authorizer
  FROM action_confirmations
  WHERE workspace_id=NEW.workspace_id AND id=NEW.confirmation_id;
  IF confirmation_state NOT IN ('approved','consumed') OR confirmation_risk <> 'R3' THEN
    RAISE EXCEPTION 'active support access requires an approved R3 confirmation' USING ERRCODE='23514';
  END IF;
  IF confirmation_authorizer <> NEW.approved_by_principal_id THEN
    RAISE EXCEPTION 'support access approver must match the confirmation authorizer' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM workspace_memberships
    WHERE workspace_id=NEW.workspace_id AND principal_id=NEW.approved_by_principal_id
      AND role='owner' AND status='active'
  ) THEN
    RAISE EXCEPTION 'support access requires an active workspace owner' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER support_access_grants_validate_confirmation
BEFORE INSERT OR UPDATE OF workspace_id,approved_by_principal_id,confirmation_id,state,valid_until
ON support_access_grants FOR EACH ROW
WHEN (NEW.state='active') EXECUTE FUNCTION validate_support_access_confirmation();

CREATE OR REPLACE FUNCTION enforce_collaboration_room_base_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_revision uuid; page_state text;
BEGIN
  SELECT np.current_revision_id,p.status INTO current_revision,page_state
  FROM native_pages np JOIN pages p
    ON p.workspace_id=np.workspace_id AND p.project_id=np.project_id AND p.id=np.page_id
  WHERE np.workspace_id=NEW.workspace_id AND np.project_id=NEW.project_id AND np.page_id=NEW.page_id;
  IF page_state <> 'active' OR current_revision IS DISTINCT FROM NEW.base_revision_id THEN
    RAISE EXCEPTION 'collaboration room base revision is stale or page is inactive' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER page_collaboration_rooms_validate_base
BEFORE INSERT ON page_collaboration_rooms
FOR EACH ROW EXECUTE FUNCTION enforce_collaboration_room_base_revision();

CREATE OR REPLACE FUNCTION prevent_current_canvas_revision_mismatch()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE revision_canvas uuid;
BEGIN
  IF NEW.current_revision_id IS NULL THEN RETURN NEW; END IF;
  SELECT canvas_id INTO revision_canvas FROM canvas_revisions
  WHERE workspace_id=NEW.workspace_id AND project_id=NEW.project_id AND id=NEW.current_revision_id;
  IF revision_canvas IS DISTINCT FROM NEW.id THEN
    RAISE EXCEPTION 'canvas current revision must belong to the same canvas' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER canvases_validate_current_revision
BEFORE UPDATE OF current_revision_id ON canvases
FOR EACH ROW EXECUTE FUNCTION prevent_current_canvas_revision_mismatch();

REVOKE UPDATE, DELETE ON TABLE page_collaboration_operations FROM folio_runtime;
REVOKE UPDATE, DELETE ON TABLE canvas_revisions, canvas_commands FROM folio_runtime;
REVOKE DELETE ON TABLE support_access_grants, audit_export_requests FROM folio_runtime;
