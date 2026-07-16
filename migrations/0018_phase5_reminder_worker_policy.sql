GRANT SELECT, UPDATE ON TABLE reminders TO folio_worker;

CREATE POLICY folio_worker_reminders ON reminders TO folio_worker
  USING (true)
  WITH CHECK (true);
