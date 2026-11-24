-- One version of each mission record. Ledger keeps only the current version of a briefing
-- (flight.mission-briefing.3), a release (flight.mission-release.2 under release policy version 2) and a departure
-- authorization's issuance basis (mission.departure-issuance.2); the record identity checks and commit triggers
-- accept nothing else. Nothing recorded is deleted: the migration refuses to run while any row of a superseded
-- version exists. Such a database must be recreated.
DO $$
DECLARE
 held text[]:=ARRAY[]::text[];
BEGIN
 IF EXISTS(SELECT 1 FROM mission_briefings WHERE record->>'version' IS DISTINCT FROM 'flight.mission-briefing.3') THEN
  held:=held||ARRAY['mission_briefings'];
 END IF;
 IF EXISTS(SELECT 1 FROM mission_releases WHERE record->>'version' IS DISTINCT FROM 'flight.mission-release.2'
  OR record#>'{policy,version}' IS DISTINCT FROM '2'::jsonb) THEN
  held:=held||ARRAY['mission_releases'];
 END IF;
 IF EXISTS(SELECT 1 FROM mission_departure_authorizations
  WHERE issuance_basis->>'version' IS DISTINCT FROM 'mission.departure-issuance.2') THEN
  held:=held||ARRAY['mission_departure_authorizations'];
 END IF;
 IF cardinality(held)>0 THEN
  RAISE EXCEPTION 'This database holds mission records of a superseded version (in %). Recreate the database and run the migrations again.',
   array_to_string(held,', ') USING ERRCODE='55000';
 END IF;
END $$;

-- The record identity checks of 0060, 0074 and 0069, each with one change: only the current version.
DO $$ DECLARE c text; BEGIN
 SELECT conname INTO STRICT c FROM pg_constraint WHERE conrelid='mission_releases'::regclass AND contype='c'
  AND pg_get_constraintdef(oid) LIKE '%flight.mission-release.1%';
 EXECUTE format('ALTER TABLE mission_releases DROP CONSTRAINT %I',c);
 SELECT conname INTO STRICT c FROM pg_constraint WHERE conrelid='mission_briefings'::regclass AND contype='c'
  AND pg_get_constraintdef(oid) LIKE '%flight.mission-briefing.3%';
 EXECUTE format('ALTER TABLE mission_briefings DROP CONSTRAINT %I',c);
 SELECT conname INTO STRICT c FROM pg_constraint WHERE conrelid='mission_departure_authorizations'::regclass
  AND contype='c' AND pg_get_constraintdef(oid) LIKE '%mission.departure-issuance.1%';
 EXECUTE format('ALTER TABLE mission_departure_authorizations DROP CONSTRAINT %I',c);
END $$;
ALTER TABLE mission_releases ADD CONSTRAINT mission_releases_record_identity CHECK(
 record->>'version' IS NOT DISTINCT FROM 'flight.mission-release.2'
 AND record#>'{policy,version}' IS NOT DISTINCT FROM '2'::jsonb
 AND jsonb_typeof(record#>'{basis,findings,findings}') IS NOT DISTINCT FROM 'array'
 AND record#>>'{basis,findings,digest}' ~ '^[a-f0-9]{64}$'
 AND record->>'id' IS NOT DISTINCT FROM id AND record->>'flightId' IS NOT DISTINCT FROM flight_id
 AND record->>'organizationId' IS NOT DISTINCT FROM organization_id
 AND record->>'aircraftId' IS NOT DISTINCT FROM aircraft_id
 AND record#>>'{actor,id}' IS NOT DISTINCT FROM actor_id
 AND record#>>'{basis,mission,id}' IS NOT DISTINCT FROM mission_revision_id
 AND record#>>'{basis,mission,missionId}' IS NOT DISTINCT FROM mission_id
 AND jsonb_typeof(record->'acceptedRevision') IS NOT DISTINCT FROM 'number'
 AND (record->>'acceptedRevision')::bigint IS NOT DISTINCT FROM accepted_revision
 AND (record->>'recordedAt')::timestamptz IS NOT DISTINCT FROM recorded_at
);
ALTER TABLE mission_briefings ADD CONSTRAINT mission_briefings_record_identity
 CHECK(record->>'version' IS NOT DISTINCT FROM 'flight.mission-briefing.3'
  AND (record->'controls' IS NULL OR (record#>>'{controls,version}' IS NOT DISTINCT FROM 'flight.controls-seen.1'
   AND COALESCE(record#>>'{controls,digest}' ~ '^[a-f0-9]{64}$',false)))
  AND record#>'{context,control}' IS NULL AND record#>'{content,control}' IS NULL
  AND jsonb_typeof(record#>'{context,controls}') IS NOT DISTINCT FROM 'array'
  AND jsonb_typeof(record#>'{content,controls}') IS NOT DISTINCT FROM 'array'
  AND CASE WHEN jsonb_typeof(record#>'{context,controls}')='array' AND jsonb_typeof(record#>'{content,controls}')='array'
   THEN jsonb_array_length(record#>'{context,controls}') BETWEEN 1 AND 64
    AND jsonb_array_length(record#>'{content,controls}')=jsonb_array_length(record#>'{context,controls}')
   ELSE false END
  AND record->>'id' IS NOT DISTINCT FROM id AND record->>'flightId' IS NOT DISTINCT FROM flight_id
  AND record->>'organizationId' IS NOT DISTINCT FROM organization_id
  AND record->>'purpose' IS NOT DISTINCT FROM 'informational'
  AND record#>>'{actor,id}' IS NOT DISTINCT FROM actor_id
  AND record#>>'{context,release,id}' IS NOT DISTINCT FROM release_id
  AND record#>>'{context,release,digest}' IS NOT DISTINCT FROM release_digest
  AND (record->>'recordedAt')::timestamptz IS NOT DISTINCT FROM recorded_at
  AND record#>>'{population,version}' IS NOT DISTINCT FROM 'briefing.recipient-population.1'
  AND record#>>'{population,organizationId}' IS NOT DISTINCT FROM organization_id
  AND COALESCE(record#>>'{population,digest}' ~ '^[a-f0-9]{64}$',false));
-- Every departure authorization pins the controls in scope its authorizer saw: the empty list when none was.
ALTER TABLE mission_departure_authorizations ADD CONSTRAINT mission_departure_record_identity
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
  AND issuance_basis->>'version' IS NOT DISTINCT FROM 'mission.departure-issuance.2'
  AND issuance_basis#>>'{controls,version}' IS NOT DISTINCT FROM 'flight.controls-seen.1'
  AND jsonb_typeof(issuance_basis#>'{controls,controls}') IS NOT DISTINCT FROM 'array'
  AND COALESCE(issuance_basis#>>'{controls,digest}' ~ '^[a-f0-9]{64}$',false));

-- Redefined from 0074 with one change: a briefing lists its controls; no branch reads a single named control. The
-- locks it takes, and their order, are unchanged: the flight, the author, the recipients by id, the organization,
-- then the safety register.
CREATE OR REPLACE FUNCTION ledger_check_mission_briefing_commit() RETURNS trigger
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
 candidate_position bigint;
 previous_position bigint:=0;
 listed_controls jsonb;
 listed_contents jsonb;
 listed_index integer;
 control_record jsonb;
 latest_mission_id text;
 projected_mission_id text;
 mission_work_state text;
 original_command jsonb;
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
 listed_controls:=NEW.record#>'{context,controls}';
 listed_contents:=NEW.record#>'{content,controls}';
 IF (CASE WHEN jsonb_typeof(listed_controls)='array' AND jsonb_typeof(listed_contents)='array'
  THEN jsonb_array_length(listed_controls) NOT BETWEEN 1 AND 64
   OR jsonb_array_length(listed_contents)<>jsonb_array_length(listed_controls)
  ELSE true END) THEN
  RAISE EXCEPTION 'Briefing lists between one and 64 controls, each with its content' USING ERRCODE='23514';
 END IF;
 FOR listed_index IN 0..jsonb_array_length(listed_controls)-1 LOOP
  SELECT candidate,ordinal INTO selected_candidate,candidate_position
  FROM jsonb_array_elements(release_record#>'{basis,avoidance,candidates}') WITH ORDINALITY AS c(candidate,ordinal)
  WHERE listed_controls->listed_index=jsonb_build_object(
   'hazardId',candidate->'hazardId','controlId',candidate->'controlId','controlVersion',candidate->'controlVersion',
   'controlEventId',candidate->'controlEventId','controlDigest',candidate->'controlDigest','acceptance',candidate->'acceptance');
  IF NOT FOUND THEN
   RAISE EXCEPTION 'Briefing control is not an exact released candidate' USING ERRCODE='23514';
  END IF;
  -- Each control once, in the order the release lists its candidates.
  IF candidate_position<=previous_position THEN
   RAISE EXCEPTION 'Briefing controls repeat or leave the release order' USING ERRCODE='23514';
  END IF;
  previous_position:=candidate_position;
  -- An area control record accepted on a safety-record hazard: the exact version the candidate names. The type's
  -- title, wording and area come from its registered definition and are checked by the application.
  SELECT jsonb_build_object('title',v.title,'body',v.body) INTO control_record FROM sms_record_versions v
  WHERE v.tenant_id=NEW.tenant_id AND v.id=selected_candidate->>'controlEventId' AND v.schema='sms.control.1'
   AND v.record_id=selected_candidate->>'controlId'
   AND v.version_number=(selected_candidate->>'controlVersion')::integer
   AND v.body_digest=selected_candidate->>'controlDigest' AND v.body->>'hazardId'=selected_candidate->>'hazardId';
  IF NOT FOUND
   OR (listed_contents#>ARRAY[listed_index::text,'controlType'])-'title' IS DISTINCT FROM control_record#>'{body,controlType}'
   OR listed_contents#>ARRAY[listed_index::text,'title'] IS DISTINCT FROM control_record->'title'
   OR listed_contents#>ARRAY[listed_index::text,'parameters'] IS DISTINCT FROM control_record#>'{body,parameters}'
   OR listed_contents#>ARRAY[listed_index::text,'effectiveFrom'] IS DISTINCT FROM control_record#>'{body,effectiveFrom}'
   OR listed_contents#>ARRAY[listed_index::text,'effectiveUntil']
    IS DISTINCT FROM COALESCE(control_record#>'{body,effectiveUntil}','null'::jsonb) THEN
   RAISE EXCEPTION 'Briefing instruction differs from its retained control' USING ERRCODE='23514';
  END IF;
 END LOOP;
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
 IF NOT FOUND OR original_command-'expectedControlsDigest' IS DISTINCT FROM jsonb_build_object(
  'kind','mission.brief','flightId',NEW.flight_id,'purpose','informational','release',NEW.record#>'{context,release}',
  'recipientPrincipalIds',original_command->'recipientPrincipalIds',
  'message',NEW.record#>>'{content,message}','expectedPrincipalRevision',author.revision,
  'controls',listed_controls)
  OR original_command->>'expectedControlsDigest' IS DISTINCT FROM NEW.record#>>'{controls,digest}'
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
 maximum_until:=(release_record#>>'{departureWindow,end}')::timestamptz;
 IF NEW.valid_until>maximum_until THEN
  RAISE EXCEPTION 'Briefing extends beyond its retained release' USING ERRCODE='23514';
 END IF;
 IF NEW.valid_until<=clock_timestamp() THEN
  RAISE EXCEPTION 'Briefing context expired before commit' USING ERRCODE='40001';
 END IF;
 RETURN NULL;
END $$;

-- Redefined from 0071 with one change: the basis always pins a controls list, and the command names its digest
-- unless the list is empty. The locks it takes, and their order, are unchanged: the flight, the author, then the
-- safety register.
CREATE OR REPLACE FUNCTION ledger_check_mission_departure_commit() RETURNS trigger
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
 IF NEW.original_command-'expectedControlsDigest' IS DISTINCT FROM jsonb_build_object(
   'kind','mission.departure-authorize','flightId',NEW.flight_id,'aircraftId',NEW.permit->>'aircraftId',
   'release',NEW.permit->'release','departureAttemptId',NEW.departure_attempt_id,
   'allocation',NEW.permit->'allocation','expectedPrincipalRevision',author.revision)
  OR (NEW.original_command->>'expectedControlsDigest' IS DISTINCT FROM NEW.issuance_basis#>>'{controls,digest}'
   AND (NEW.original_command->'expectedControlsDigest' IS NOT NULL
    OR NEW.issuance_basis#>'{controls,controls}' IS DISTINCT FROM '[]'::jsonb))
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
 SELECT min(boundary) INTO context_boundary FROM accepted_hazard_controls a
  JOIN sms_records h ON h.tenant_id=a.tenant_id AND h.id=a.hazard_id AND h.latest_acceptance_id=a.acceptance_id
  JOIN sms_records c ON c.tenant_id=a.tenant_id AND c.id=a.control_id
  CROSS JOIN LATERAL unnest(ARRAY[a.effective_from,a.effective_until]) boundary
  WHERE a.tenant_id=NEW.tenant_id AND h.status<>'closed' AND c.status<>'closed' AND boundary>NEW.authorized_at;
 expected_until:=LEAST(NEW.authorized_at+interval '30 seconds',
  (release_record#>>'{departureWindow,end}')::timestamptz,context_boundary);
 IF NEW.valid_until IS DISTINCT FROM expected_until THEN
  RAISE EXCEPTION 'Departure authorization must retain its original bounded lease' USING ERRCODE='23514';
 END IF;
 IF NEW.valid_until<=clock_timestamp() THEN
  RAISE EXCEPTION 'Departure authorization expired before commit' USING ERRCODE='40001';
 END IF;
 RETURN NULL;
END $$;
