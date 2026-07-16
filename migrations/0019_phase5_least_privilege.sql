REVOKE UPDATE, DELETE ON TABLE realtime_event_log FROM folio_runtime;
REVOKE DELETE ON TABLE integration_connections FROM folio_runtime;
REVOKE DELETE ON TABLE calendar_external_bindings FROM folio_runtime;
REVOKE DELETE ON TABLE provider_operations FROM folio_runtime;
REVOKE DELETE ON TABLE job_attempts FROM folio_runtime;
REVOKE UPDATE, DELETE ON TABLE operation_metrics FROM folio_runtime;

REVOKE INSERT, UPDATE, DELETE ON TABLE realtime_event_log FROM folio_worker;
REVOKE INSERT, UPDATE, DELETE ON TABLE presence_sessions FROM folio_worker;

CREATE OR REPLACE FUNCTION prevent_realtime_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'realtime_event_log is append-only';
END;
$$;

CREATE TRIGGER realtime_event_log_append_only
BEFORE UPDATE OR DELETE ON realtime_event_log
FOR EACH ROW EXECUTE FUNCTION prevent_realtime_event_mutation();

CREATE TRIGGER realtime_event_log_no_truncate
BEFORE TRUNCATE ON realtime_event_log
FOR EACH STATEMENT EXECUTE FUNCTION prevent_realtime_event_mutation();
