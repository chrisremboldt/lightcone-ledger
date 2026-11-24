CREATE TABLE mission_releases (
 id text PRIMARY KEY,tenant_id text NOT NULL,flight_id text NOT NULL,organization_id text NOT NULL,
 mission_id text NOT NULL,mission_revision_id text NOT NULL,aircraft_id text NOT NULL,actor_id text NOT NULL,
 accepted_revision bigint NOT NULL CHECK(accepted_revision>0 AND accepted_revision<=9007199254740991),
 departure_start timestamptz NOT NULL,departure_end timestamptz NOT NULL,
 register_revision bigint NOT NULL CHECK(register_revision>=0),
 record jsonb NOT NULL CHECK(jsonb_typeof(record)='object' AND octet_length(record::text)<=2097152),
 record_digest text NOT NULL CHECK(record_digest ~ '^[a-f0-9]{64}$'),recorded_at timestamptz NOT NULL,
 CHECK(isfinite(departure_start) AND isfinite(departure_end) AND departure_start<departure_end),
 CHECK(isfinite(recorded_at)),
 CHECK(record->>'version' IS NOT DISTINCT FROM 'flight.mission-release.1'
  AND record->>'id' IS NOT DISTINCT FROM id AND record->>'flightId' IS NOT DISTINCT FROM flight_id
  AND record->>'organizationId' IS NOT DISTINCT FROM organization_id
  AND record->>'aircraftId' IS NOT DISTINCT FROM aircraft_id
  AND record#>>'{actor,id}' IS NOT DISTINCT FROM actor_id
  AND record#>>'{basis,mission,id}' IS NOT DISTINCT FROM mission_revision_id
  AND record#>>'{basis,mission,missionId}' IS NOT DISTINCT FROM mission_id
  AND jsonb_typeof(record->'acceptedRevision') IS NOT DISTINCT FROM 'number'
  AND (record->>'acceptedRevision')::bigint IS NOT DISTINCT FROM accepted_revision
  AND (record->>'recordedAt')::timestamptz IS NOT DISTINCT FROM recorded_at),
 CHECK(jsonb_typeof(record#>'{basis,candidateContexts}') IS NOT DISTINCT FROM 'array'
  AND jsonb_typeof(record#>'{basis,avoidance,candidates}') IS NOT DISTINCT FROM 'array'
  AND jsonb_array_length(record#>'{basis,candidateContexts}')<=64
  AND jsonb_array_length(record#>'{basis,candidateContexts}')=jsonb_array_length(record#>'{basis,avoidance,candidates}')),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,flight_id,id),UNIQUE(tenant_id,flight_id,accepted_revision),
 FOREIGN KEY(tenant_id,id) REFERENCES command_records(tenant_id,id),
 FOREIGN KEY(tenant_id,flight_id) REFERENCES flight_views(tenant_id,id),
 FOREIGN KEY(tenant_id,organization_id) REFERENCES organizations(tenant_id,id),
 FOREIGN KEY(tenant_id,mission_id,flight_id,mission_revision_id) REFERENCES mission_revisions(tenant_id,mission_id,flight_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES principals(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES mission_avoidance_register(tenant_id)
);
CREATE TABLE mission_release_projection_views (
 tenant_id text NOT NULL,release_id text NOT NULL,flight_id text NOT NULL,
 projected_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(projected_at)),PRIMARY KEY(tenant_id,release_id),
 FOREIGN KEY(tenant_id,flight_id,release_id) REFERENCES mission_releases(tenant_id,flight_id,id)
);

CREATE FUNCTION ledger_check_mission_release_commit() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE
 flight_aircraft text;
 author principals%ROWTYPE;
 current_register_revision bigint;
 latest_mission_id text;
 projected_mission_id text;
 mission_work_state text;
 mission_record jsonb;
 context_boundary timestamptz;
 invalid_boundary boolean;
BEGIN
 SELECT aircraft INTO flight_aircraft FROM flight_views
  WHERE tenant_id=NEW.tenant_id AND id=NEW.flight_id FOR UPDATE;
 IF NOT FOUND OR flight_aircraft IS DISTINCT FROM NEW.aircraft_id THEN
  RAISE EXCEPTION 'Mission release aircraft changed before commit' USING ERRCODE='40001';
 END IF;
 SELECT * INTO author FROM principals WHERE tenant_id=NEW.tenant_id AND id=NEW.actor_id FOR SHARE;
 IF NOT FOUND OR author.active IS NOT TRUE
  OR NEW.actor_id IS DISTINCT FROM current_setting('ledger.principal_id',true)
  OR (NEW.record#>>'{actor,principalRevision}')::bigint IS DISTINCT FROM author.revision
  OR NOT author.capabilities @> ARRAY['decision:write','flight:read','mission:release']::text[]
  OR NEW.record#>'{actor,active}' IS DISTINCT FROM 'true'::jsonb
  OR NEW.record#>'{actor,capabilities}' IS DISTINCT FROM to_jsonb(author.capabilities)
  OR NEW.record#>'{actor,commandLinkSources}' IS DISTINCT FROM to_jsonb(author.command_link_sources)
  OR NEW.record#>'{actor,missionSources}' IS DISTINCT FROM to_jsonb(author.mission_sources)
  OR NEW.record#>>'{actor,name}' IS DISTINCT FROM author.name
  OR NEW.record#>>'{actor,kind}' IS DISTINCT FROM author.kind
  OR NEW.record#>>'{actor,policyVersion}' IS DISTINCT FROM 'ledger.mission-release-authority.1'
  OR NEW.record#>'{actor,checkedCapabilities}' IS DISTINCT FROM '["decision:write","flight:read","mission:release"]'::jsonb
  OR NEW.record#>>'{actor,scope,kind}' IS DISTINCT FROM 'flight'
  OR NEW.record#>>'{actor,scope,id}' IS DISTINCT FROM NEW.flight_id THEN
  RAISE EXCEPTION 'Mission release authority changed before commit' USING ERRCODE='40001';
 END IF;
 SELECT ledger_lock_mission_avoidance_register() INTO current_register_revision;
 IF current_register_revision IS DISTINCT FROM NEW.register_revision THEN
  RAISE EXCEPTION 'Mission release safety register changed before commit' USING ERRCODE='40001';
 END IF;
 SELECT r.id,r.record,v.current_revision_id,w.state
 INTO latest_mission_id,mission_record,projected_mission_id,mission_work_state
 FROM missions m JOIN LATERAL(
  SELECT id,record FROM mission_revisions r
   WHERE r.tenant_id=m.tenant_id AND r.mission_id=m.id ORDER BY r.source_revision DESC LIMIT 1
 )r ON true
 LEFT JOIN mission_projection_views v ON v.tenant_id=m.tenant_id AND v.mission_id=m.id AND v.flight_id=m.flight_id
 LEFT JOIN work_items w ON w.tenant_id=m.tenant_id AND w.event_id=r.id
 WHERE m.tenant_id=NEW.tenant_id AND m.id=NEW.mission_id AND m.flight_id=NEW.flight_id;
 IF NOT FOUND OR latest_mission_id IS DISTINCT FROM NEW.mission_revision_id
  OR projected_mission_id IS DISTINCT FROM NEW.mission_revision_id OR mission_work_state IS DISTINCT FROM 'completed'
  OR NEW.record#>'{basis,mission}' IS DISTINCT FROM mission_record
  OR mission_record->>'aircraftId' IS DISTINCT FROM NEW.aircraft_id THEN
  RAISE EXCEPTION 'Mission release mission changed or is not projected before commit' USING ERRCODE='40001';
 END IF;
 IF NOT EXISTS(
  SELECT 1 FROM command_records c JOIN journal_events e ON e.tenant_id=c.tenant_id AND e.id=c.id
   JOIN streams s ON s.tenant_id=e.tenant_id AND s.id=e.stream_id
  WHERE c.tenant_id=NEW.tenant_id AND c.id=NEW.id AND c.kind='mission.release'
   AND c.flight_id=NEW.flight_id AND c.actor_id=NEW.actor_id AND c.recorded_at=NEW.recorded_at
   AND c.payload->>'kind'='mission.release' AND c.payload->>'flightId'=NEW.flight_id
   AND c.payload->>'aircraftId'=NEW.aircraft_id
   AND c.payload#>>'{mission,eventId}'=NEW.mission_revision_id
   AND c.payload#>>'{mission,missionId}'=NEW.mission_id
   AND c.payload->'departureWindow'=NEW.record->'departureWindow'
   AND (c.payload->>'expectedPrincipalRevision')::bigint=author.revision
   AND e.event_type='mission.release' AND e.principal_id=NEW.actor_id
   AND e.stream_sequence=NEW.accepted_revision AND e.received_at=NEW.recorded_at
   AND s.name='flight:'||NEW.flight_id
   AND e.payload->'acceptance'=NEW.record-ARRAY['id','recordedAt','acceptedRevision']
   AND c.payload=e.payload-ARRAY['acceptance','declaredSubjects']
   AND e.payload->'declaredSubjects'=jsonb_build_array(NEW.flight_id)
 ) THEN
  RAISE EXCEPTION 'Mission release differs from its journal and command identity' USING ERRCODE='23514';
 END IF;
 IF (NEW.record#>>'{departureWindow,start}')::timestamptz IS DISTINCT FROM NEW.departure_start
  OR (NEW.record#>>'{departureWindow,end}')::timestamptz IS DISTINCT FROM NEW.departure_end
  OR NEW.departure_start<(NEW.record#>>'{basis,mission,operatingInterval,start}')::timestamptz
  OR NEW.departure_end>(NEW.record#>>'{basis,mission,operatingInterval,end}')::timestamptz THEN
  RAISE EXCEPTION 'Mission release must retain its exact bounded departure window' USING ERRCODE='23514';
 END IF;
 SELECT min(boundary),COALESCE(bool_or(boundary IS NOT NULL AND NOT isfinite(boundary)),false)
 INTO context_boundary,invalid_boundary
 FROM (
  SELECT (entry#>>'{context,executionSelection,nextBoundary,at}')::timestamptz AS boundary
  FROM jsonb_array_elements(NEW.record#>'{basis,candidateContexts}') entry
 )boundaries;
 IF invalid_boundary OR NEW.departure_end<=clock_timestamp() OR context_boundary<=clock_timestamp() THEN
  RAISE EXCEPTION 'Mission release window or evaluated context expired before commit' USING ERRCODE='40001';
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION ledger_check_mission_release_commit() FROM PUBLIC,ledger_app;
CREATE CONSTRAINT TRIGGER mission_release_commit_basis AFTER INSERT ON mission_releases
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_mission_release_commit();

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['mission_releases','mission_release_projection_views'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON %I USING(tenant_id=current_setting(''ledger.tenant_id'',true)) WITH CHECK(tenant_id=current_setting(''ledger.tenant_id'',true))',t);
 EXECUTE format('GRANT SELECT ON %I TO ledger_app',t);
 END LOOP;
END $$;
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON mission_releases
 FOR EACH ROW EXECUTE FUNCTION ledger_forbid_history_mutation();
GRANT INSERT ON mission_releases TO ledger_app;
GRANT INSERT ON mission_release_projection_views TO ledger_worker;
