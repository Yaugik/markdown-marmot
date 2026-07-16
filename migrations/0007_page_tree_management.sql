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
  ancestor_depth integer;
BEGIN
  IF NEW.parent_node_id IS NULL THEN
    RETURN