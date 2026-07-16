GRANT SELECT ON TABLE activity_events TO folio_worker;

CREATE POLICY folio_worker_activity_export_read ON activity_events
TO folio_worker USING (true);

CREATE INDEX activity_events_workspace_created_idx
  ON activity_events(workspace_id,created_at,id);

CREATE INDEX activity_events_project_created_idx
  ON activity_events(project_id,created_at,id)
  WHERE project_id IS NOT NULL;
