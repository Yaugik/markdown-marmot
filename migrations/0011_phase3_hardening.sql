CREATE OR REPLACE FUNCTION validate_issue_workflow_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM issue_workflow_statuses from_status
    JOIN issue_workflow_statuses to_status
      ON to_status.workspace_id = from_status.workspace_id
     AND to_status.project_id = from_status.project_id
     AND to_status.workflow_id = from_status.workflow_id
    WHERE from_status.workspace_id = NEW.workspace_id
      AND from_status.project_id = NEW.project_id
      AND from_status.workflow_id = NEW.workflow_id
      AND from_status.id = NEW.from_status_id
      AND to_status.id = NEW.to_status_id
      AND from_status.archived_at IS NULL
      AND to_status.archived_at IS NULL
  ) THEN
    RAISE EXCEPTION 'workflow transition statuses must belong to the selected workflow'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER issue_workflow_transitions_validate_statuses
BEFORE INSERT OR UPDATE OF workspace_id, project_id, workflow_id, from_status_id, to_status_id
ON issue_workflow_transitions
FOR EACH ROW EXECUTE FUNCTION validate_issue_workflow_transition();

ALTER TABLE issue_links
  ADD CONSTRAINT issue_links_no_self_issue_target
  CHECK (target_issue_id IS NULL OR target_issue_id <> issue_id);

ALTER TABLE issue_dependencies
  DROP CONSTRAINT issue_dependencies_source_issue_id_target_issue_id_relation_kind_key;

CREATE UNIQUE INDEX issue_dependencies_active_relation_idx
  ON issue_dependencies (source_issue_id, target_issue_id, relation_kind)
  WHERE archived_at IS NULL;

CREATE OR REPLACE FUNCTION validate_issue_portfolio_references()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.milestone_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM milestones
    WHERE workspace_id = NEW.workspace_id AND project_id = NEW.project_id
      AND id = NEW.milestone_id AND archived_at IS NULL
  ) THEN
    RAISE EXCEPTION 'issue milestone must be active in the project'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.cycle_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM cycles
    WHERE workspace_id = NEW.workspace_id AND project_id = NEW.project_id
      AND id = NEW.cycle_id AND archived_at IS NULL
  ) THEN
    RAISE EXCEPTION 'issue cycle must be active in the project'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER issues_validate_portfolio_references
BEFORE INSERT OR UPDATE OF workspace_id, project_id, milestone_id, cycle_id
ON issues
FOR EACH ROW EXECUTE FUNCTION validate_issue_portfolio_references();
