CREATE TABLE mission_briefings (
 id text PRIMARY KEY,tenant_id text NOT NULL,flight_id text NOT NULL,organization_id text NOT NULL,
 release_id text NOT NULL,release_digest text NOT NULL CHECK(release_digest ~ '^[a-f0-9]{64}$'),actor_id text NOT NULL,
 register_revision bigint NOT NULL CHECK(register_revision>=0),valid_until timestamptz NOT NULL,
 record jsonb NOT NULL CHECK(jsonb_typeof(record)='object' AND octet_length(record::text)<=131072),
 record_digest text NOT NULL CHECK(record_digest ~ '^[a-f0-9]{64}$'),recorded_at timestamptz NOT NULL,
 CHECK(isfinite(recorded_at) AND isfinite(valid_until) AND recorded_at<valid_until),
 CHECK(record->>'version' IS NOT DISTINCT FROM 'flight.mission-briefing.1'
  AND record->>'id' IS NOT DISTINCT FROM id AND record->>'flightId' IS NOT DISTINCT FROM flight_id
  AND record->>'organizationId' IS NOT DISTINCT FROM organization_id
  AND record->>'purpose' IS NOT DISTINCT FROM 'informational'
  AND record#>>'{actor,id}' IS NOT DISTINCT FROM actor_id
  AND record#>>'{context,release,id}' IS NOT DISTINCT FROM release_id
  AND record#>>'{context,release,digest}' IS NOT DISTINCT FROM release_digest
  AND (record->>'recordedAt')::timestamptz IS NOT DISTINCT FROM recorded_at
  AND record#>>'{population,version}' IS NOT DISTINCT FROM 'briefing.recipient-population.1'
  AND record#>>'{population,organizationId}' IS NOT DISTINCT FROM organization_id
  AND COALESCE(record#>>'{population,digest}' ~ '^[a-f0-9]{64}$',false)),
 CHECK(jsonb_typeof(record#>'{population,recipients}') IS NOT DISTINCT FROM 'array'
  AND jsonb_array_length(record#>'{population,recipients}') BETWEEN 1 AND 32),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,flight_id,id),
 FOREIGN KEY(tenant_id,id) REFERENCES command_records(tenant_id,id),
 FOREIGN KEY(tenant_id,flight_id) REFERENCES flight_views(tenant_id,id),
 FOREIGN KEY(tenant_id,organization_id) REFERENCES organizations(tenant_id,id),
 FOREIGN KEY(tenant_id,flight_id,release_id) REFERENCES mission_releases(tenant_id,flight_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES principals(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES mission_avoidance_register(tenant_id)
);
CREATE TABLE mission_briefing_acknowledgements (
 id text PRIMARY KEY,tenant_id text NOT NULL,flight_id text NOT NULL,briefing_id text NOT NULL,
 briefing_digest text NOT NULL CHECK(briefing_digest ~ '^[a-f0-9]{64}$'),
 population_digest text NOT NULL CHECK(population_digest ~ '^[a-f0-9]{64}$'),
 recipient_principal_id text NOT NULL,actor_id text NOT NULL,
 record jsonb NOT NULL CHECK(jsonb_typeof(record)='object' AND octet_length(record::text)<=16384),
 record_digest text NOT NULL CHECK(record_digest ~ '^[a-f0-9]{64}$'),recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at)),
 CHECK(recipient_principal_id=actor_id),
 CHECK(record->>'version' IS NOT DISTINCT FROM 'flight.mission-briefing-acknowledgement.1'
  AND record->>'id' IS NOT DISTINCT FROM id AND record->>'flightId' IS NOT DISTINCT FROM flight_id
  AND record#>>'{briefing,id}' IS NOT DISTINCT FROM briefing_id
  AND record#>>'{briefing,digest}' IS NOT DISTINCT FROM briefing_digest
  AND record->>'populationDigest' IS NOT DISTINCT FROM population_digest
  AND record->>'recipientPrincipalId' IS NOT DISTINCT FROM recipient_principal_id
  AND record#>>'{actor,id}' IS NOT DISTINCT FROM actor_id
  AND record->>'attestation' IS NOT DISTINCT FROM 'reviewed_exact_briefing'
  AND (record->>'recordedAt')::timestamptz IS NOT DISTINCT FROM recorded_at),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,flight_id,id),
 CONSTRAINT mission_briefing_one_acknowledgement UNIQUE(tenant_id,briefing_id,recipient_principal_id),
 FOREIGN KEY(tenant_id,id) REFERENCES command_records(tenant_id,id),
 FOREIGN KEY(tenant_id,flight_id) REFERENCES flight_views(tenant_id,id),
 FOREIGN KEY(tenant_id,flight_id,briefing_id) REFERENCES mission_briefings(tenant_id,flight_id,id),
 FOREIGN KEY(tenant_id,recipient_principal_id) REFERENCES principals(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES principals(tenant_id,id)
);
CREATE TABLE mission_briefing_projection_views (
 tenant_id text NOT NULL,briefing_id text NOT NULL,flight_id text NOT NULL,
 projected_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(projected_at)),
 PRIMARY KEY(tenant_id,briefing_id),
 FOREIGN KEY(tenant_id,flight_id,briefing_id) REFERENCES mission_briefings(tenant_id,flight_id,id)
);
CREATE TABLE mission_briefing_acknowledgement_projection_views (
 tenant_id text NOT NULL,acknowledgement_id text NOT NULL,flight_id text NOT NULL,
 projected_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(projected_at)),
 PRIMARY KEY(tenant_id,acknowledgement_id),
 FOREIGN KEY(tenant_id,flight_id,acknowledgement_id) REFERENCES mission_briefing_acknowledgements(tenant_id,flight_id,id)
);

CREATE FUNCTION ledger_check_mission_briefing_commit() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE
 flight_aircraft text;
 author principals%ROWTYPE;
 recipient principals%ROWTYPE;
 recipient_ids text[];
 resolved_recipients jsonb:='[]'::jsonb;
 resolved_recipient_ids jsonb;
 request_recipients jsonb;
 current_register_revision bigint;
 release_record jsonb;
 retained_release_digest text;
 release_projected boolean;
 release_work_state text;
 selected_candidate jsonb;
 control_record jsonb;
 latest_mission_id text;
 projected_mission_id text;
 mission_work_state text;
 original_command jsonb;
 context_boundary timestamptz;
 invalid_boundary boolean;
 maximum_until timestamptz;
BEGIN
 SELECT aircraft INTO flight_aircraft FROM flight_views
  WHERE tenant_id=NEW.tenant_id AND id=NEW.flight_id FOR UPDATE;
 IF NOT FOUND OR flight_aircraft IS DISTINCT FROM NEW.record#>>'{context,aircraftId}' THEN
  RAISE EXCEPTION 'Briefing aircraft changed before commit' USING ERRCODE='40001';
 END IF;
 SELECT * INTO author FROM principals WHERE tenant_id=NEW.tenant_id AND id=NEW.actor_id FOR SHARE;
 IF NOT FOUND OR author.active IS NOT TRUE
  OR NEW.actor_id IS DISTINCT FROM current_setting('ledger.principal_id',true)
  OR NOT author.capabilities @> ARRAY['flight:read','briefing:write']::text[]
  OR NEW.record->'actor' IS DISTINCT FROM jsonb_build_object(
   'id',author.id,'name',author.name,'kind',author.kind,'active',true,'principalRevision',author.revision,
   'capabilities',to_jsonb(author.capabilities),'checkedCapabilities',jsonb_build_array('flight:read','briefing:write'),
   'policyVersion','ledger.mission-briefing-authority.1','scope',jsonb_build_object('kind','flight','id',NEW.flight_id)) THEN
  RAISE EXCEPTION 'Briefing authority changed before commit' USING ERRCODE='40001';
 END IF;
 SELECT array_agg(entry->>'principalId') INTO recipient_ids
  FROM jsonb_array_elements(NEW.record#>'{population,recipients}') entry;
 FOR recipient IN SELECT p.* FROM principals p WHERE p.tenant_id=NEW.tenant_id AND p.id=ANY(recipient_ids)
  ORDER BY p.id COLLATE "C" FOR SHARE LOOP
  IF recipient.active IS NOT TRUE OR recipient.kind IS DISTINCT FROM 'human' THEN
   RAISE EXCEPTION 'Briefing recipient is no longer an active human principal' USING ERRCODE='40001';
  END IF;
  resolved_recipients:=resolved_recipients||jsonb_build_array(jsonb_build_object(
   'principalId',recipient.id,'name',recipient.name,'kind','human','principalRevision',recipient.revision));
 END LOOP;
 IF NEW.record->'population' IS DISTINCT FROM jsonb_build_object(
  'version','briefing.recipient-population.1','organizationId',NEW.organization_id,
  'recipients',resolved_recipients,'digest',NEW.record#>>'{population,digest}') THEN
  RAISE EXCEPTION 'Briefing population changed or is not sorted uniquely before commit' USING ERRCODE='40001';
 END IF;
 PERFORM 1 FROM organizations WHERE tenant_id=NEW.tenant_id AND id=NEW.organization_id FOR SHARE;
 SELECT ledger_lock_mission_avoidance_register() INTO current_register_revision;
 IF current_register_revision IS DISTINCT FROM NEW.register_revision THEN
  RAISE EXCEPTION 'Briefing safety register changed before commit' USING ERRCODE='40001';
 END IF;
 SELECT r.record,r.record_digest,p.release_id IS NOT NULL,w.state
 INTO release_record,retained_release_digest,release_projected,release_work_state
 FROM mission_releases r LEFT JOIN mission_release_projection_views p
  ON p.tenant_id=r.tenant_id AND p.release_id=r.id AND p.flight_id=r.flight_id
 LEFT JOIN work_items w ON w.tenant_id=r.tenant_id AND w.event_id=r.id
 WHERE r.tenant_id=NEW.tenant_id AND r.id=NEW.release_id AND r.flight_id=NEW.flight_id;
 IF NOT FOUND OR retained_release_digest IS DISTINCT FROM NEW.release_digest
  OR release_projected IS NOT TRUE OR release_work_state IS DISTINCT FROM 'completed'
  OR release_record->>'organizationId' IS DISTINCT FROM NEW.organization_id
  OR NEW.record#>'{context,mission}' IS DISTINCT FROM release_record#>'{basis,avoidance,mission}'
  OR NEW.record#>>'{context,aircraftId}' IS DISTINCT FROM release_record->>'aircraftId'
  OR NEW.record#>>'{context,contextDigest}' IS DISTINCT FROM release_record#>>'{basis,avoidance,contextDigest}'
  OR NEW.record#>'{context,releasePolicy}' IS DISTINCT FROM jsonb_build_object(
   'id',release_record#>>'{policy,id}','version',release_record#>'{policy,version}','digest',release_record#>>'{policy,digest}') THEN
  RAISE EXCEPTION 'Briefing release differs from its exact completed context' USING ERRCODE='40001';
 END IF;
 SELECT candidate INTO selected_candidate FROM jsonb_array_elements(release_record#>'{basis,avoidance,candidates}') candidate
 WHERE NEW.record#>'{context,control}'=jsonb_build_object(
  'hazardId',candidate->'hazardId','controlId',candidate->'controlId','controlVersion',candidate->'controlVersion',
  'controlEventId',candidate->'controlEventId','controlDigest',candidate->'controlDigest','acceptance',candidate->'acceptance');
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Briefing control is not an exact released candidate' USING ERRCODE='23514';
 END IF;
 SELECT record INTO control_record FROM hazard_controls
 WHERE tenant_id=NEW.tenant_id AND id=selected_candidate->>'controlEventId'
  AND hazard_id=selected_candidate->>'hazardId' AND control_id=selected_candidate->>'controlId'
  AND control_version=(selected_candidate->>'controlVersion')::integer;
 IF NOT FOUND OR NEW.record#>'{content,control}' IS DISTINCT FROM jsonb_build_object(
  'template',control_record->'template','center',control_record->'center','radiusMeters',control_record->'radiusMeters',
  'label',control_record->'label','effectiveFrom',control_record->'effectiveFrom','effectiveUntil',control_record->'effectiveUntil') THEN
  RAISE EXCEPTION 'Briefing instruction differs from its retained control' USING ERRCODE='23514';
 END IF;
 SELECT r.id,v.current_revision_id,w.state INTO latest_mission_id,projected_mission_id,mission_work_state
 FROM missions m JOIN LATERAL(SELECT id FROM mission_revisions r
  WHERE r.tenant_id=m.tenant_id AND r.mission_id=m.id ORDER BY source_revision DESC LIMIT 1)r ON true
 LEFT JOIN mission_projection_views v ON v.tenant_id=m.tenant_id AND v.mission_id=m.id AND v.flight_id=m.flight_id
 LEFT JOIN work_items w ON w.tenant_id=m.tenant_id AND w.event_id=r.id
 WHERE m.tenant_id=NEW.tenant_id AND m.flight_id=NEW.flight_id;
 IF NOT FOUND OR latest_mission_id IS DISTINCT FROM NEW.record#>>'{context,mission,eventId}'
  OR projected_mission_id IS DISTINCT FROM latest_mission_id OR mission_work_state IS DISTINCT FROM 'completed' THEN
  RAISE EXCEPTION 'Briefing mission changed or is not projected before commit' USING ERRCODE='40001';
 END IF;
 SELECT c.payload INTO original_command FROM command_records c JOIN journal_events e ON e.tenant_id=c.tenant_id AND e.id=c.id
 JOIN streams s ON s.tenant_id=e.tenant_id AND s.id=e.stream_id
 WHERE c.tenant_id=NEW.tenant_id AND c.id=NEW.id AND c.kind='mission.brief'
  AND c.flight_id=NEW.flight_id AND c.actor_id=NEW.actor_id AND c.recorded_at=NEW.recorded_at
  AND e.event_type='mission.brief' AND e.principal_id=NEW.actor_id AND e.received_at=NEW.recorded_at
  AND s.name='flight:'||NEW.flight_id
  AND e.payload=c.payload||jsonb_build_object('acceptance',NEW.record-ARRAY['id','recordedAt'],
   'declaredSubjects',jsonb_build_array(NEW.flight_id));
 IF NOT FOUND OR original_command IS DISTINCT FROM jsonb_build_object(
  'kind','mission.brief','flightId',NEW.flight_id,'purpose','informational','release',NEW.record#>'{context,release}',
  'control',NEW.record#>'{context,control}','recipientPrincipalIds',original_command->'recipientPrincipalIds',
  'message',NEW.record#>>'{content,message}','expectedPrincipalRevision',author.revision)
  OR jsonb_typeof(original_command->'recipientPrincipalIds') IS DISTINCT FROM 'array'
  OR jsonb_array_length(original_command->'recipientPrincipalIds') NOT BETWEEN 1 AND 32 THEN
  RAISE EXCEPTION 'Briefing differs from its original journal and command' USING ERRCODE='23514';
 END IF;
 SELECT jsonb_agg(entry ORDER BY (entry#>>'{}') COLLATE "C") INTO request_recipients
 FROM jsonb_array_elements(original_command->'recipientPrincipalIds') entry;
 SELECT jsonb_agg(entry->'principalId' ORDER BY (entry->>'principalId') COLLATE "C") INTO resolved_recipient_ids
 FROM jsonb_array_elements(resolved_recipients) entry;
 IF request_recipients IS DISTINCT FROM resolved_recipient_ids THEN
  RAISE EXCEPTION 'Briefing command recipients differ from its frozen population' USING ERRCODE='23514';
 END IF;
 SELECT min(boundary),COALESCE(bool_or(boundary IS NOT NULL AND NOT isfinite(boundary)),false)
 INTO context_boundary,invalid_boundary FROM (
  SELECT (entry#>>'{context,executionSelection,nextBoundary,at}')::timestamptz AS boundary
  FROM jsonb_array_elements(release_record#>'{basis,candidateContexts}') entry
 )boundaries;
 maximum_until:=LEAST((release_record#>>'{departureWindow,end}')::timestamptz,context_boundary);
 IF invalid_boundary OR NEW.valid_until>maximum_until THEN
  RAISE EXCEPTION 'Briefing extends beyond its retained release or selection boundary' USING ERRCODE='23514';
 END IF;
 IF NEW.valid_until<=clock_timestamp() THEN
  RAISE EXCEPTION 'Briefing context expired before commit' USING ERRCODE='40001';
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION ledger_check_mission_briefing_commit() FROM PUBLIC,ledger_app;
CREATE CONSTRAINT TRIGGER mission_briefing_commit_basis AFTER INSERT ON mission_briefings
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_mission_briefing_commit();

CREATE FUNCTION ledger_check_mission_briefing_acknowledgement_commit() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE
 author principals%ROWTYPE;
 briefing_record jsonb;
 retained_briefing_digest text;
 original_command jsonb;
BEGIN
 PERFORM 1 FROM flight_views WHERE tenant_id=NEW.tenant_id AND id=NEW.flight_id FOR UPDATE;
 SELECT * INTO author FROM principals WHERE tenant_id=NEW.tenant_id AND id=NEW.actor_id FOR SHARE;
 IF NOT FOUND OR author.active IS NOT TRUE OR author.kind IS DISTINCT FROM 'human'
  OR NEW.actor_id IS DISTINCT FROM current_setting('ledger.principal_id',true)
  OR NEW.recipient_principal_id IS DISTINCT FROM author.id
  OR NOT author.capabilities @> ARRAY['flight:read','briefing:ack']::text[]
  OR NEW.record->'actor' IS DISTINCT FROM jsonb_build_object(
   'id',author.id,'name',author.name,'kind','human','active',true,'principalRevision',author.revision,
   'capabilities',to_jsonb(author.capabilities),'checkedCapabilities',jsonb_build_array('flight:read','briefing:ack'),
   'policyVersion','ledger.mission-briefing-acknowledgement-authority.1','scope',jsonb_build_object('kind','flight','id',NEW.flight_id)) THEN
  RAISE EXCEPTION 'Acknowledgement authority changed before commit' USING ERRCODE='40001';
 END IF;
 SELECT record,record_digest INTO briefing_record,retained_briefing_digest FROM mission_briefings
 WHERE tenant_id=NEW.tenant_id AND id=NEW.briefing_id AND flight_id=NEW.flight_id;
 IF NOT FOUND OR retained_briefing_digest IS DISTINCT FROM NEW.briefing_digest
  OR briefing_record#>>'{population,digest}' IS DISTINCT FROM NEW.population_digest
  OR NEW.recorded_at<(briefing_record->>'recordedAt')::timestamptz
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(briefing_record#>'{population,recipients}') recipient
   WHERE recipient->>'principalId'=author.id) THEN
  RAISE EXCEPTION 'Acknowledgement does not identify its exact frozen recipient membership' USING ERRCODE='23514';
 END IF;
 SELECT c.payload INTO original_command FROM command_records c JOIN journal_events e ON e.tenant_id=c.tenant_id AND e.id=c.id
 JOIN streams s ON s.tenant_id=e.tenant_id AND s.id=e.stream_id
 WHERE c.tenant_id=NEW.tenant_id AND c.id=NEW.id AND c.kind='mission.briefing-acknowledge'
  AND c.flight_id=NEW.flight_id AND c.actor_id=NEW.actor_id AND c.recorded_at=NEW.recorded_at
  AND e.event_type='mission.briefing-acknowledge' AND e.principal_id=NEW.actor_id AND e.received_at=NEW.recorded_at
  AND s.name='flight:'||NEW.flight_id
  AND e.payload=c.payload||jsonb_build_object('acceptance',NEW.record-ARRAY['id','recordedAt'],
   'declaredSubjects',jsonb_build_array(NEW.flight_id));
 IF NOT FOUND OR original_command IS DISTINCT FROM jsonb_build_object(
  'kind','mission.briefing-acknowledge','flightId',NEW.flight_id,'briefing',NEW.record->'briefing',
  'populationDigest',NEW.population_digest,'attestation','reviewed_exact_briefing','expectedPrincipalRevision',author.revision) THEN
  RAISE EXCEPTION 'Acknowledgement differs from its original journal and command' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION ledger_check_mission_briefing_acknowledgement_commit() FROM PUBLIC,ledger_app;
CREATE CONSTRAINT TRIGGER mission_briefing_acknowledgement_commit_basis AFTER INSERT ON mission_briefing_acknowledgements
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_mission_briefing_acknowledgement_commit();

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['mission_briefings','mission_briefing_acknowledgements','mission_briefing_projection_views','mission_briefing_acknowledgement_projection_views'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON %I USING(tenant_id=current_setting(''ledger.tenant_id'',true)) WITH CHECK(tenant_id=current_setting(''ledger.tenant_id'',true))',t);
 EXECUTE format('GRANT SELECT ON %I TO ledger_app',t);
 END LOOP;
END $$;
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON mission_briefings
 FOR EACH ROW EXECUTE FUNCTION ledger_forbid_history_mutation();
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON mission_briefing_acknowledgements
 FOR EACH ROW EXECUTE FUNCTION ledger_forbid_history_mutation();
GRANT INSERT ON mission_briefings,mission_briefing_acknowledgements TO ledger_app;
GRANT INSERT ON mission_briefing_projection_views,mission_briefing_acknowledgement_projection_views TO ledger_worker;

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
   'evidence.correct','flight.created','flight.assign','authority.update','mission.release','mission.departure-authorize','mission.brief','mission.briefing-acknowledge'
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
