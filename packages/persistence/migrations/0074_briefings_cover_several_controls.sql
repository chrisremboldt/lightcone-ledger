-- One briefing may cover several controls. A briefing of record version 3 lists one or more exact
-- release candidates under context.controls, each once and in the order the release lists them, with the briefed
-- content of each at the same position under content.controls; one acknowledgement acknowledges all of them.
-- Briefings of versions 1 and 2 keep their rows, shape and checks: each names one control.

-- The record identity check of 0069 with one change: a third version, which lists its controls and may pin the
-- controls in scope its author saw.
DO $$ DECLARE c text; BEGIN
 SELECT conname INTO STRICT c FROM pg_constraint WHERE conrelid='mission_briefings'::regclass AND contype='c'
  AND pg_get_constraintdef(oid) LIKE '%flight.mission-briefing.2%';
 EXECUTE format('ALTER TABLE mission_briefings DROP CONSTRAINT %I',c);
END $$;
ALTER TABLE mission_briefings ADD CONSTRAINT mission_briefings_record_identity
 CHECK(((record->>'version' IS NOT DISTINCT FROM 'flight.mission-briefing.1' AND record->'controls' IS NULL)
   OR (record->>'version' IS NOT DISTINCT FROM 'flight.mission-briefing.2'
    AND record#>>'{controls,version}' IS NOT DISTINCT FROM 'flight.controls-seen.1'
    AND COALESCE(record#>>'{controls,digest}' ~ '^[a-f0-9]{64}$',false))
   OR (record->>'version' IS NOT DISTINCT FROM 'flight.mission-briefing.3'
    AND (record->'controls' IS NULL OR (record#>>'{controls,version}' IS NOT DISTINCT FROM 'flight.controls-seen.1'
     AND COALESCE(record#>>'{controls,digest}' ~ '^[a-f0-9]{64}$',false)))
    AND record#>'{context,control}' IS NULL AND record#>'{content,control}' IS NULL
    AND jsonb_typeof(record#>'{context,controls}') IS NOT DISTINCT FROM 'array'
    AND jsonb_typeof(record#>'{content,controls}') IS NOT DISTINCT FROM 'array'
    AND CASE WHEN jsonb_typeof(record#>'{context,controls}')='array' AND jsonb_typeof(record#>'{content,controls}')='array'
     THEN jsonb_array_length(record#>'{context,controls}') BETWEEN 1 AND 64
      AND jsonb_array_length(record#>'{content,controls}')=jsonb_array_length(record#>'{context,controls}')
     ELSE false END))
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

-- Redefined from 0071 with one change: the controls a briefing names are a list, of one for versions 1 and 2, and
-- each listed control is checked as the one was: an exact candidate of the release whose retained version matches
-- the briefed content. The list may not repeat a control or leave the release's order, and the command must name the
-- same list. The locks it takes, and their order, are unchanged: the flight, the author, the recipients by id, the
-- organization, then the safety register.
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
 command_controls jsonb;
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
 -- Version 3 lists its controls; versions 1 and 2 name one. Each listed control is checked as the one was before.
 IF NEW.record->>'version'='flight.mission-briefing.3' THEN
  listed_controls:=NEW.record#>'{context,controls}';
  listed_contents:=NEW.record#>'{content,controls}';
  command_controls:=jsonb_build_object('controls',listed_controls);
 ELSE
  listed_controls:=jsonb_build_array(NEW.record#>'{context,control}');
  listed_contents:=jsonb_build_array(NEW.record#>'{content,control}');
  command_controls:=jsonb_build_object('control',NEW.record#>'{context,control}');
 END IF;
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
  'message',NEW.record#>>'{content,message}','expectedPrincipalRevision',author.revision)||command_controls
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
