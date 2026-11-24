ALTER TABLE flight_views ADD COLUMN created_at timestamptz;

UPDATE flight_views f SET created_at=e.received_at
FROM streams s JOIN journal_events e ON e.tenant_id=s.tenant_id AND e.stream_id=s.id
WHERE s.tenant_id=f.tenant_id AND s.name='flight:'||f.id
 AND e.stream_sequence=1 AND e.event_type='flight.created' AND e.payload->>'flightId'=f.id
 AND (NOT (e.payload ? 'originationKey') OR e.payload->>'originationKey'=f.origination_key);

DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM flight_views WHERE created_at IS NULL) THEN
  RAISE EXCEPTION 'Flight creation history requires its original creation event' USING ERRCODE='23514';
 END IF;
END $$;

ALTER TABLE flight_views ALTER COLUMN created_at SET NOT NULL;
CREATE INDEX flight_creation_history ON flight_views(tenant_id,created_at DESC,id COLLATE "C" DESC);

CREATE FUNCTION ledger_protect_flight_creation() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE
 creation_time timestamptz;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
   OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
   RAISE EXCEPTION 'Flight creation identity and time cannot change' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 SELECT e.received_at INTO creation_time FROM streams s
 JOIN journal_events e ON e.tenant_id=s.tenant_id AND e.stream_id=s.id
 WHERE s.tenant_id=NEW.tenant_id AND s.name='flight:'||NEW.id
  AND e.stream_sequence=1 AND e.event_type='flight.created' AND e.payload->>'flightId'=NEW.id
  AND (NOT (e.payload ? 'originationKey') OR e.payload->>'originationKey'=NEW.origination_key);
 IF NOT FOUND OR (NEW.created_at IS NOT NULL AND NEW.created_at IS DISTINCT FROM creation_time) THEN
  RAISE EXCEPTION 'Flight creation time must match its original creation event' USING ERRCODE='23514';
 END IF;
 NEW.created_at:=creation_time;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ledger_protect_flight_creation() FROM PUBLIC,ledger_app;
CREATE TRIGGER immutable_flight_creation BEFORE INSERT OR UPDATE ON flight_views
 FOR EACH ROW EXECUTE FUNCTION ledger_protect_flight_creation();
