CREATE TABLE mission_departure_authorizations (
 id text PRIMARY KEY,tenant_id text NOT NULL,flight_id text NOT NULL,release_id text NOT NULL,
 release_digest text NOT NULL CHECK(release_digest ~ '^[a-f0-9]{64}$'),departure_attempt_id text NOT NULL,
 allocation_id text NOT NULL,allocation_digest text NOT NULL CHECK(allocation_digest ~ '^[a-f0-9]{64}$'),
 actor_id text NOT NULL,authorized_at timestamptz NOT NULL,valid_until timestamptz NOT NULL,
 register_revision bigint NOT NULL CHECK(register_revision>=0),
 permit jsonb NOT NULL CHECK(jsonb_typeof(permit)='object'),
 permit_digest text NOT NULL CHECK(permit_digest ~ '^[a-f0-9]{64}$'),
 issuance_basis jsonb NOT NULL CHECK(jsonb_typeof(issuance_basis)='object'),
 original_command jsonb NOT NULL CHECK(jsonb_typeof(original_command)='object'),recorded_at timestamptz NOT NULL,
 CHECK(octet_length(permit::text)+octet_length(issuance_basis::text)<=4194304),
 CHECK(isfinite(authorized_at) AND isfinite(valid_until) AND authorized_at<valid_until
  AND valid_until<=authorized_at+interval '30 seconds' AND recorded_at=authorized_at),
 CHECK(permit->>'version' IS NOT DISTINCT FROM 'flight.mission-departure-permit.1'
  AND permit->>'id' IS NOT DISTINCT FROM id AND permit->>'flightId' IS NOT DISTINCT FROM flight_id
  AND permit#>>'{actor,id}' IS NOT DISTINCT FROM actor_id
  AND permit#>>'{release,id}' IS NOT DISTINCT FROM release_id
  AND permit#>>'{release,digest}' IS NOT DISTINCT FROM release_digest
  AND permit->>'departureAttemptId' IS NOT DISTINCT FROM departure_attempt_id
  AND permit#>>'{allocation,id}' IS NOT DISTINCT FROM allocation_id
  AND permit#>>'{allocation,digest}' IS NOT DISTINCT FROM allocation_digest
  AND (permit->>'authorizedAt')::timestamptz IS NOT DISTINCT FROM authorized_at
  AND (permit->>'validUntil')::timestamptz IS NOT DISTINCT FROM valid_until
  AND issuance_basis->>'version' IS NOT DISTINCT FROM 'mission.departure-issuance.1'),
 CHECK(jsonb_typeof(issuance_basis->'candidateContexts') IS NOT DISTINCT FROM 'array'
  AND jsonb_array_length(issuance_basis->'candidateContexts')<=64),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,flight_id,id),
 CONSTRAINT mission_departure_one_per_flight UNIQUE(tenant_id,flight_id),
 CONSTRAINT mission_departure_attempt_binding UNIQUE(tenant_id,departure_attempt_id),
 CONSTRAINT mission_departure_allocation_binding UNIQUE(tenant_id,allocation_id),
 FOREIGN KEY(tenant_id,id) REFERENCES command_records(tenant_id,id),
 FOREIGN KEY(tenant_id,flight_id) REFERENCES flight_views(tenant_id,id),
 FOREIGN KEY(tenant_id,flight_id,release_id) REFERENCES mission_releases(tenant_id,flight_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES principals(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES mission_avoidance_register(tenant_id)
);
CREATE TABLE mission_departure_projection_views (
 tenant_id text NOT NULL,authorization_id text NOT NULL,flight_id text NOT NULL,
 projected_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(projected_at)),
 PRIMARY KEY(tenant_id,authorization_id),
 FOREIGN KEY(tenant_id,flight_id,authorization_id) REFERENCES mission_departure_authorizations(tenant_id,flight_id,id)
);

CREATE FUNCTION ledger_check_mission_departure_commit() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE
 flight_aircraft text;
 author principals%ROWTYPE;
 current_register_revision bigint;
 release_record jsonb;
 retained_release_digest text;
 release_projected boolean;
 release_work_state text;
 latest_mission_id text;
 projected_mission_id text;
 mission_work_state text;
 context_boundary timestamptz;
 invalid_boundary boolean;
 expected_until timestamptz;
BEGIN
 SELECT aircraft INTO flight_aircraft FROM flight_views
  WHERE tenant_id=NEW.tenant_id AND id=NEW.flight_id FOR UPDATE;
 IF NOT FOUND OR flight_aircraft IS DISTINCT FROM NEW.permit->>'aircraftId' THEN
  RAISE EXCEPTION 'Departure aircraft changed before commit' USING ERRCODE='40001';
 END IF;
 SELECT * INTO author FROM principals WHERE tenant_id=NEW.tenant_id AND id=NEW.actor_id FOR SHARE;
 IF NOT FOUND OR author.active IS NOT TRUE
  OR NEW.actor_id IS DISTINCT FROM current_setting('ledger.principal_id',true)
  OR (NEW.permit#>>'{actor,principalRevision}')::bigint IS DISTINCT FROM author.revision
  OR NOT author.capabilities @> ARRAY['decision:write','flight:read','mission:release']::text[]
  OR NEW.permit#>'{actor,active}' IS DISTINCT FROM 'true'::jsonb
  OR NEW.permit#>'{actor,capabilities}' IS DISTINCT FROM to_jsonb(author.capabilities)
  OR NEW.permit#>'{actor,commandLinkSources}' IS DISTINCT FROM to_jsonb(author.command_link_sources)
  OR NEW.permit#>'{actor,missionSources}' IS DISTINCT FROM to_jsonb(author.mission_sources)
  OR NEW.permit#>>'{actor,name}' IS DISTINCT FROM author.name
  OR NEW.permit#>>'{actor,kind}' IS DISTINCT FROM author.kind
  OR NEW.permit#>>'{actor,policyVersion}' IS DISTINCT FROM 'ledger.mission-departure-authority.1'
  OR NEW.permit#>'{actor,checkedCapabilities}' IS DISTINCT FROM '["decision:write","flight:read","mission:release"]'::jsonb
  OR NEW.permit#>>'{actor,scope,kind}' IS DISTINCT FROM 'flight'
  OR NEW.permit#>>'{actor,scope,id}' IS DISTINCT FROM NEW.flight_id THEN
  RAISE EXCEPTION 'Departure authority changed before commit' USING ERRCODE='40001';
 END IF;
 SELECT ledger_lock_mission_avoidance_register() INTO current_register_revision;
 IF current_register_revision IS DISTINCT FROM NEW.register_revision THEN
  RAISE EXCEPTION 'Departure safety register changed before commit' USING ERRCODE='40001';
 END IF;
 SELECT r.record,r.record_digest,p.release_id IS NOT NULL,w.state
 INTO release_record,retained_release_digest,release_projected,release_work_state
 FROM mission_releases r LEFT JOIN mission_release_projection_views p
  ON p.tenant_id=r.tenant_id AND p.release_id=r.id AND p.flight_id=r.flight_id
 LEFT JOIN work_items w ON w.tenant_id=r.tenant_id AND w.event_id=r.id
 WHERE r.tenant_id=NEW.tenant_id AND r.id=NEW.release_id AND r.flight_id=NEW.flight_id;
 IF NOT FOUND OR retained_release_digest IS DISTINCT FROM NEW.release_digest
  OR release_projected IS NOT TRUE OR release_work_state IS DISTINCT FROM 'completed'
  OR NEW.issuance_basis->'release' IS DISTINCT FROM release_record
  OR NEW.permit->>'aircraftId' IS DISTINCT FROM release_record->>'aircraftId'
  OR NEW.permit->'mission' IS DISTINCT FROM release_record#>'{basis,avoidance,mission}'
  OR NEW.permit->>'contextDigest' IS DISTINCT FROM release_record#>>'{basis,avoidance,contextDigest}'
  OR NEW.issuance_basis#>>'{avoidance,contextDigest}' IS DISTINCT FROM NEW.permit->>'contextDigest'
  OR NEW.issuance_basis#>'{avoidance,candidates}' IS DISTINCT FROM release_record#>'{basis,avoidance,candidates}'
  OR NEW.issuance_basis->'candidateContexts' IS DISTINCT FROM release_record#>'{basis,candidateContexts}'
  OR NEW.authorized_at<(release_record#>>'{departureWindow,start}')::timestamptz
  OR NEW.authorized_at>=(release_record#>>'{departureWindow,end}')::timestamptz THEN
  RAISE EXCEPTION 'Departure release is not exact and current before commit' USING ERRCODE='40001';
 END IF;
 SELECT r.id,v.current_revision_id,w.state INTO latest_mission_id,projected_mission_id,mission_work_state
 FROM missions m JOIN LATERAL(SELECT id FROM mission_revisions r
  WHERE r.tenant_id=m.tenant_id AND r.mission_id=m.id ORDER BY source_revision DESC LIMIT 1)r ON true
 LEFT JOIN mission_projection_views v ON v.tenant_id=m.tenant_id AND v.mission_id=m.id AND v.flight_id=m.flight_id
 LEFT JOIN work_items w ON w.tenant_id=m.tenant_id AND w.event_id=r.id
 WHERE m.tenant_id=NEW.tenant_id AND m.flight_id=NEW.flight_id;
 IF NOT FOUND OR latest_mission_id IS DISTINCT FROM NEW.permit#>>'{mission,eventId}'
  OR projected_mission_id IS DISTINCT FROM latest_mission_id OR mission_work_state IS DISTINCT FROM 'completed' THEN
  RAISE EXCEPTION 'Departure mission changed or is not projected before commit' USING ERRCODE='40001';
 END IF;
 IF NEW.original_command IS DISTINCT FROM jsonb_build_object(
   'kind','mission.departure-authorize','flightId',NEW.flight_id,'aircraftId',NEW.permit->>'aircraftId',
   'release',NEW.permit->'release','departureAttemptId',NEW.departure_attempt_id,
   'allocation',NEW.permit->'allocation','expectedPrincipalRevision',author.revision)
  OR NOT EXISTS(
   SELECT 1 FROM command_records c JOIN journal_events e ON e.tenant_id=c.tenant_id AND e.id=c.id
   JOIN streams s ON s.tenant_id=e.tenant_id AND s.id=e.stream_id
   WHERE c.tenant_id=NEW.tenant_id AND c.id=NEW.id AND c.kind='mission.departure-authorize'
    AND c.flight_id=NEW.flight_id AND c.actor_id=NEW.actor_id AND c.recorded_at=NEW.recorded_at
    AND c.payload=jsonb_build_object('permit',NEW.permit,'digest',NEW.permit_digest)
    AND e.event_type='mission.departure-authorize' AND e.principal_id=NEW.actor_id
    AND e.received_at=NEW.authorized_at AND s.name='flight:'||NEW.flight_id
    AND e.payload=NEW.original_command||jsonb_build_object('acceptance',jsonb_build_object(
     'permit',NEW.permit-ARRAY['id','authorizedAt','validUntil'],'issuanceBasis',NEW.issuance_basis),
     'declaredSubjects',jsonb_build_array(NEW.flight_id))
  ) THEN
  RAISE EXCEPTION 'Departure authorization differs from its journal and command' USING ERRCODE='23514';
 END IF;
 SELECT min(boundary),COALESCE(bool_or(boundary IS NOT NULL AND NOT isfinite(boundary)),false)
 INTO context_boundary,invalid_boundary FROM (
  SELECT (entry#>>'{context,executionSelection,nextBoundary,at}')::timestamptz AS boundary
  FROM jsonb_array_elements(NEW.issuance_basis->'candidateContexts') entry
 )boundaries;
 expected_until:=LEAST(NEW.authorized_at+interval '30 seconds',
  (release_record#>>'{departureWindow,end}')::timestamptz,context_boundary);
 IF invalid_boundary OR NEW.valid_until IS DISTINCT FROM expected_until THEN
  RAISE EXCEPTION 'Departure authorization must retain its original bounded lease' USING ERRCODE='23514';
 END IF;
 IF NEW.valid_until<=clock_timestamp() THEN
  RAISE EXCEPTION 'Departure authorization expired before commit' USING ERRCODE='40001';
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION ledger_check_mission_departure_commit() FROM PUBLIC,ledger_app;
CREATE CONSTRAINT TRIGGER mission_departure_commit_basis AFTER INSERT ON mission_departure_authorizations
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_mission_departure_commit();

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['mission_departure_authorizations','mission_departure_projection_views'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON %I USING(tenant_id=current_setting(''ledger.tenant_id'',true)) WITH CHECK(tenant_id=current_setting(''ledger.tenant_id'',true))',t);
 EXECUTE format('GRANT SELECT ON %I TO ledger_app',t);
 END LOOP;
END $$;
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON mission_departure_authorizations
 FOR EACH ROW EXECUTE FUNCTION ledger_forbid_history_mutation();
GRANT INSERT ON mission_departure_authorizations TO ledger_app;
GRANT INSERT ON mission_departure_projection_views TO ledger_worker;

CREATE OR REPLACE FUNCTION ledger_publish_mission_avoidance_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
 relevant boolean:=false;
 work_type text;
BEGIN
 IF TG_TABLE_NAME='hazard_risk_acceptances' THEN
  relevant:=true;
 ELSIF TG_TABLE_NAME='hazard_assessments' THEN
  relevant:=EXISTS(SELECT 1 FROM hazard_risk_acceptances a WHERE a.tenant_id=NEW.tenant_id AND a.hazard_id=NEW.hazard_id);
 ELSIF TG_TABLE_NAME='command_link_source_events' THEN
  relevant:=EXISTS(SELECT 1 FROM hazard_openings o JOIN hazard_risk_acceptances a
   ON a.tenant_id=o.tenant_id AND a.hazard_id=o.hazard_id
   WHERE o.tenant_id=NEW.tenant_id AND o.origin_flight_id=NEW.flight_id);
 ELSIF TG_TABLE_NAME='finding_views' THEN
  relevant:=EXISTS(SELECT 1 FROM findings f JOIN hazard_openings o
   ON o.tenant_id=f.tenant_id AND o.origin_finding_id=f.id
   JOIN hazard_risk_acceptances a ON a.tenant_id=o.tenant_id AND a.hazard_id=o.hazard_id
   WHERE f.tenant_id=NEW.tenant_id AND f.id=NEW.id AND f.leaf_id='ledger.demo.command-link-loss-review');
 ELSIF TG_TABLE_NAME='flight_rule_selection_views' THEN
  IF TG_OP='UPDATE' AND OLD.current_id IS NOT DISTINCT FROM NEW.current_id THEN RETURN NEW; END IF;
  relevant:=EXISTS(SELECT 1 FROM hazard_openings o JOIN hazard_risk_acceptances a
   ON a.tenant_id=o.tenant_id AND a.hazard_id=o.hazard_id
   WHERE o.tenant_id=NEW.tenant_id AND o.origin_flight_id=NEW.flight_id);
 ELSIF TG_TABLE_NAME='organization_pack_adoptions' THEN
  relevant:=NEW.pack_id='ledger.demo-procedures' AND NEW.record->'pack'->>'version'='3'
   AND NEW.record->'pack'->>'digest'='46f777c1c391b696cffc45b450cb61b8563b28417f67ac087522b57e34e56188'
   AND EXISTS(SELECT 1 FROM hazard_openings o JOIN hazard_risk_acceptances a
    ON a.tenant_id=o.tenant_id AND a.hazard_id=o.hazard_id
    WHERE o.tenant_id=NEW.tenant_id AND o.organization_id=NEW.organization_id);
 ELSIF TG_TABLE_NAME='organization_pack_adoption_views' THEN
  relevant:=EXISTS(SELECT 1 FROM organization_pack_adoptions p JOIN hazard_openings o
   ON o.tenant_id=p.tenant_id AND o.organization_id=p.organization_id
   JOIN hazard_risk_acceptances a ON a.tenant_id=o.tenant_id AND a.hazard_id=o.hazard_id
   WHERE p.tenant_id=NEW.tenant_id AND p.id=NEW.id AND p.pack_id='ledger.demo-procedures'
   AND p.record->'pack'->>'version'='3'
   AND p.record->'pack'->>'digest'='46f777c1c391b696cffc45b450cb61b8563b28417f67ac087522b57e34e56188');
 ELSIF TG_TABLE_NAME='work_items' THEN
  SELECT event_type INTO work_type FROM journal_events
   WHERE tenant_id=NEW.tenant_id AND id=NEW.event_id;
  IF FOUND AND work_type IN (
   'telemetry.segment','order.revision','intent.revision','mission.revision',
   'flight.observation','airspace.status','source.observation','identity.link',
   'evidence.correct','flight.created','flight.assign','authority.update','mission.release','mission.departure-authorize'
  ) THEN RETURN NEW; END IF;
  relevant:=EXISTS(SELECT 1 FROM hazard_risk_acceptances a
   WHERE a.tenant_id=NEW.tenant_id AND (a.id=NEW.event_id OR a.assessment_id=NEW.event_id
    OR EXISTS(SELECT 1 FROM hazard_controls c WHERE c.tenant_id=a.tenant_id AND c.hazard_id=a.hazard_id
      AND c.control_id=a.control_id AND c.control_version=a.control_version AND c.id=NEW.event_id)))
   OR EXISTS(SELECT 1 FROM hazard_assessments h JOIN hazard_risk_acceptances a
    ON a.tenant_id=h.tenant_id AND a.hazard_id=h.hazard_id WHERE h.tenant_id=NEW.tenant_id AND h.id=NEW.event_id)
   OR EXISTS(SELECT 1 FROM command_link_source_events c JOIN hazard_openings o
    ON o.tenant_id=c.tenant_id AND o.origin_flight_id=c.flight_id
    JOIN hazard_risk_acceptances a ON a.tenant_id=o.tenant_id AND a.hazard_id=o.hazard_id
    WHERE c.tenant_id=NEW.tenant_id AND c.event_id=NEW.event_id)
   OR EXISTS(SELECT 1 FROM finding_views v JOIN hazard_openings o
    ON o.tenant_id=v.tenant_id AND o.origin_finding_id=v.id
    JOIN hazard_risk_acceptances a ON a.tenant_id=o.tenant_id AND a.hazard_id=o.hazard_id
    WHERE v.tenant_id=NEW.tenant_id AND v.latest_evaluation_id=NEW.event_id);
 END IF;
 IF relevant THEN
  UPDATE mission_avoidance_register SET revision=revision+1 WHERE tenant_id=NEW.tenant_id;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ledger_publish_mission_avoidance_change() FROM PUBLIC,ledger_app;
