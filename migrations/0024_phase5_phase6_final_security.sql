ALTER TABLE support_access_grants
  ADD CONSTRAINT support_access_grants_confirmation_unique UNIQUE (workspace_id, confirmation_id);

CREATE OR REPLACE FUNCTION validate_support_access_confirmation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  confirmation_state text;
  confirmation_risk text;
  confirmation_authorizer uuid;
  confirmation_operation text;
  confirmation_expiry timestamptz;
BEGIN
  SELECT status,risk_level,authorizing_principal_id,operation,expires_at
    INTO confirmation_state,confirmation_risk,confirmation_authorizer,
      confirmation_operation,confirmation_expiry
  FROM action_confirmations
  WHERE workspace_id=NEW.workspace_id AND id=NEW.confirmation_id
  FOR UPDATE;
  IF confirmation_state <> 'approved' OR confirmation_risk <> 'R3'
    OR confirmation_operation <> 'enterprise.support_access.create'
    OR confirmation_expiry <= now() THEN
    RAISE EXCEPTION 'active support access requires an unexpired approved R3 support confirmation'
      USING ERRCODE='23514';
  END IF;
  IF confirmation_authorizer <> NEW.approved_by_principal_id THEN
    RAISE EXCEPTION 'support access approver must match the confirmation authorizer'
      USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM workspace_memberships
    WHERE workspace_id=NEW.workspace_id AND principal_id=NEW.approved_by_principal_id
      AND role='owner' AND status='active'
  ) THEN
    RAISE EXCEPTION 'support access requires an active workspace owner'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION consume_support_access_confirmation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE action_confirmations
  SET status='consumed',consumed_at=now(),updated_at=now(),revision=revision+1
  WHERE workspace_id=NEW.workspace_id AND id=NEW.confirmation_id AND status='approved';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'support confirmation was not available for consumption'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER support_access_grants_consume_confirmation
AFTER INSERT ON support_access_grants
FOR EACH ROW WHEN (NEW.state='active')
EXECUTE FUNCTION consume_support_access_confirmation();

CREATE OR REPLACE FUNCTION normalize_symmetric_relationship()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  is_symmetric boolean;
  source_type text;
  source_id uuid;
BEGIN
  SELECT symmetric INTO is_symmetric
  FROM relationship_types
  WHERE workspace_id=NEW.workspace_id AND project_id=NEW.project_id
    AND id=NEW.relationship_type_id;
  IF is_symmetric AND (
    NEW.source_entity_type > NEW.target_entity_type
    OR (
      NEW.source_entity_type = NEW.target_entity_type
      AND NEW.source_entity_id::text > NEW.target_entity_id::text
    )
  ) THEN
    source_type := NEW.source_entity_type;
    source_id := NEW.source_entity_id;
    NEW.source_entity_type := NEW.target_entity_type;
    NEW.source_entity_id := NEW.target_entity_id;
    NEW.target_entity_type := source_type;
    NEW.target_entity_id := source_id;
  END IF;
  RETURN NEW;
END;
$$;
