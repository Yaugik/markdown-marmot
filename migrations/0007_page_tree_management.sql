ALTER TABLE page_tree_nodes
  ADD CONSTRAINT page_tree_nodes_rank_nonnegative CHECK (rank >= 0),
  ADD CONSTRAINT page_tree_nodes_folder_title_required
    CHECK (node_kind <> 'folder' OR display_title IS NOT NULL);

CREATE OR REPLACE FUNCTION validate_page_tree_parent()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_kind text;
  cycle_found boolean;
BEGIN
  IF NEW.parent_node_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT node_kind
    INTO parent_kind
    FROM page_tree_nodes
   WHERE workspace_id = NEW.workspace_id
     AND project_id = NEW.project_id
     AND id = NEW.parent_node_id
     AND archived_at IS NULL;

  IF parent_kind IS NULL THEN
    RAISE EXCEPTION 'page tree parent was not found'
      USING ERRCODE = '23503';
  END IF;

  IF parent_kind <> 'folder' THEN
    RAISE EXCEPTION 'page tree parent must be a folder'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.parent_node_id = NEW.id THEN
    RAISE EXCEPTION 'page tree cycle detected'
      USING ERRCODE = '23514';
  END IF;

  WITH RECURSIVE ancestors AS (
    SELECT id, parent_node_id
      FROM page_tree_nodes
     WHERE workspace_id = NEW.workspace_id
       AND project_id = NEW.project_id
       AND id = NEW.parent_node_id
    UNION ALL
    SELECT parent.id, parent.parent_node_id
      FROM page_tree_nodes parent
      JOIN ancestors child ON child.parent_node_id = parent.id
     WHERE parent.workspace_id = NEW.workspace_id
       AND parent.project_id = NEW.project_id
  )
  SELECT EXISTS (SELECT 1 FROM ancestors WHERE id = NEW.id)
    INTO cycle_found;

  IF cycle_found THEN
    RAISE EXCEPTION 'page tree cycle detected'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER page_tree_nodes_validate_parent
BEFORE INSERT OR UPDATE OF workspace_id, project_id, parent_node_id
ON page_tree_nodes
FOR EACH ROW EXECUTE FUNCTION validate_page_tree_parent();
