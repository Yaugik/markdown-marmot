INSERT INTO jobs(
  id, workspace_id, project_id, kind, payload, deduplication_key,
  status, priority, max_attempts, available_at
)
VALUES(
  gen_random_uuid(), NULL, NULL, 'todo.recurrence.sweep', '{}'::jsonb,
  'todo-recurrence-sweep:bootstrap', 'pending', 50, 10, now()
)
ON CONFLICT DO NOTHING;

CREATE INDEX reminders_recipient_state_idx
  ON reminders(recipient_principal_id, state, remind_at DESC);

CREATE INDEX todos_calendar_projection_idx
  ON todos(project_id, starts_at, due_at)
  WHERE archived_at IS NULL AND status = 'open';

CREATE INDEX issues_calendar_projection_idx
  ON issues(project_id, start_on, due_on)
  WHERE archived_at IS NULL;
