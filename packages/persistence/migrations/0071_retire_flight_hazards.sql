-- Retires the flight-side hazard system. Its tables are dropped, and so are the trigger functions that served
-- only them. Nothing recorded is deleted: the migration refuses to run while any table it retires, or any history
-- that pointed at a flight-side control or acceptance, holds rows. Such a database predates the single hazard model
-- and must be recreated.
DO $$
DECLARE
 held text[]:=ARRAY[]::text[];
 t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['hazard_openings','hazard_views','hazard_assessments','hazard_controls',
  'hazard_risk_acceptances','hazard_dispositions','hazard_effectiveness_reviews',
  'hazard_effectiveness_review_projections','monitoring_windows','control_effectiveness_records'] LOOP
  EXECUTE format('SELECT CASE WHEN EXISTS(SELECT 1 FROM %I) THEN $1||ARRAY[%L] ELSE $1 END',t,t) INTO held USING held;
 END LOOP;
 IF EXISTS(SELECT 1 FROM control_windows WHERE control_kind<>'control_record') THEN
  held:=held||ARRAY['control_windows'];
 END IF;
 IF EXISTS(SELECT 1 FROM control_indicator_results WHERE control_kind<>'control_record') THEN
  held:=held||ARRAY['control_indicator_results'];
 END IF;
 IF EXISTS(SELECT 1 FROM control_indicator_reviews WHERE control_kind<>'control_record') THEN
  held:=held||ARRAY['control_indicator_reviews'];
 END IF;
 IF EXISTS(SELECT 1 FROM decisions WHERE record->>'version' LIKE 'hazard.%') THEN
  held:=held||ARRAY['decisions'];
 END IF;
 IF cardinality(held)>0 THEN
  RAISE EXCEPTION 'This database holds records of the retired flight-side hazard system (in %). Recreate the database and run the migrations again.',
   array_to_string(held,', ') USING ERRCODE='55000';
 END IF;
END $$;

-- Route avoidance reads only accepted control records, whose changes publish through
-- ledger_publish_accepted_control_change (0061). The function that published flight-side changes goes with every
-- trigger that called it.
DROP FUNCTION ledger_publish_mission_avoidance_change() CASCADE;

-- A monitoring window cites a control record version and the risk acceptance that binds it.
ALTER TABLE monitoring_windows DROP CONSTRAINT monitoring_windows_tenant_id_control_event_id_fkey;
ALTER TABLE monitoring_windows DROP CONSTRAINT monitoring_windows_tenant_id_acceptance_id_fkey;
ALTER TABLE monitoring_windows ADD CONSTRAINT monitoring_windows_control_version
 FOREIGN KEY(tenant_id,control_event_id) REFERENCES sms_record_versions(tenant_id,id);
ALTER TABLE monitoring_windows ADD CONSTRAINT monitoring_windows_acceptance
 FOREIGN KEY(tenant_id,acceptance_id) REFERENCES decisions(tenant_id,id);

DROP TABLE hazard_effectiveness_review_projections,hazard_effectiveness_reviews,hazard_dispositions,
 hazard_risk_acceptances,hazard_controls,hazard_assessments,hazard_views,hazard_openings CASCADE;
DROP FUNCTION IF EXISTS ledger_check_effectiveness_review_basis();
DROP FUNCTION IF EXISTS ledger_check_hazard_disposition();
DROP FUNCTION IF EXISTS ledger_guard_hazard_status();
DROP FUNCTION IF EXISTS ledger_check_risk_acceptance_interval();
DROP FUNCTION IF EXISTS ledger_guard_hazard_evaluated_context();

-- Windows, results and reviews monitor control records only.
ALTER TABLE control_windows DROP CONSTRAINT control_windows_control_kind_check;
ALTER TABLE control_windows ADD CONSTRAINT control_windows_control_kind_check CHECK(control_kind='control_record');
ALTER TABLE control_indicator_results DROP CONSTRAINT control_indicator_results_control_kind_check;
ALTER TABLE control_indicator_results ADD CONSTRAINT control_indicator_results_control_kind_check
 CHECK(control_kind='control_record');
ALTER TABLE control_indicator_reviews DROP CONSTRAINT control_indicator_reviews_control_kind_check;
ALTER TABLE control_indicator_reviews ADD CONSTRAINT control_indicator_reviews_control_kind_check
 CHECK(control_kind='control_record');

-- Decisions on a subject are adoption reviews or safety-record decisions; the flight-side hazard decision records are
-- no longer admitted.
ALTER TABLE decisions DROP CONSTRAINT decisions_target;
ALTER TABLE decisions ADD CONSTRAINT decisions_target CHECK(
 (flight_id IS NOT NULL AND subject_id IS NULL AND adoption_id IS NULL AND accepted_revision IS NULL AND record IS NULL)
 OR (flight_id IS NULL AND subject_id IS NOT NULL AND adoption_id IS NOT NULL AND accepted_revision IS NOT NULL
  AND accepted_revision>0 AND record IS NOT NULL AND jsonb_typeof(record)='object' AND kind='adoption.review')
 OR (flight_id IS NULL AND subject_id IS NOT NULL AND adoption_id IS NULL AND accepted_revision IS NOT NULL
  AND accepted_revision>0 AND record IS NOT NULL AND jsonb_typeof(record)='object'
  AND kind IN ('risk.assess','risk.accept','matrix.adopt','document.adopt','document.review','document.issue',
   'document.distribute','document.withdraw','document.periodic-review','record.close','record.reopen')
  AND record->>'version' IS NOT DISTINCT FROM 'sms.decision.1'
  AND record->>'subjectId' IS NOT DISTINCT FROM subject_id
  AND record->>'kind' IS NOT DISTINCT FROM kind)
);

-- Redefined from 0069: a briefing cites a released control record; its validity ends with the release.
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
 SELECT candidate INTO selected_candidate FROM jsonb_array_elements(release_record#>'{basis,avoidance,candidates}') candidate
 WHERE NEW.record#>'{context,control}'=jsonb_build_object(
  'hazardId',candidate->'hazardId','controlId',candidate->'controlId','controlVersion',candidate->'controlVersion',
  'controlEventId',candidate->'controlEventId','controlDigest',candidate->'controlDigest','acceptance',candidate->'acceptance');
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Briefing control is not an exact released candidate' USING ERRCODE='23514';
 END IF;
  -- An area control record accepted on a safety-record hazard: the exact version the candidate names. The type's
  -- title, wording and area come from its registered definition and are checked by the application.
  SELECT jsonb_build_object('title',v.title,'body',v.body) INTO control_record FROM sms_record_versions v
  WHERE v.tenant_id=NEW.tenant_id AND v.id=selected_candidate->>'controlEventId' AND v.schema='sms.control.1'
   AND v.record_id=selected_candidate->>'controlId'
   AND v.version_number=(selected_candidate->>'controlVersion')::integer
   AND v.body_digest=selected_candidate->>'controlDigest' AND v.body->>'hazardId'=selected_candidate->>'hazardId';
  IF NOT FOUND
   OR (NEW.record#>'{content,control,controlType}')-'title' IS DISTINCT FROM control_record#>'{body,controlType}'
   OR NEW.record#>'{content,control,title}' IS DISTINCT FROM control_record->'title'
   OR NEW.record#>'{content,control,parameters}' IS DISTINCT FROM control_record#>'{body,parameters}'
   OR NEW.record#>'{content,control,effectiveFrom}' IS DISTINCT FROM control_record#>'{body,effectiveFrom}'
   OR NEW.record#>'{content,control,effectiveUntil}'
    IS DISTINCT FROM COALESCE(control_record#>'{body,effectiveUntil}','null'::jsonb) THEN
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
 IF NOT FOUND OR original_command-'expectedControlsDigest' IS DISTINCT FROM jsonb_build_object(
  'kind','mission.brief','flightId',NEW.flight_id,'purpose','informational','release',NEW.record#>'{context,release}',
  'control',NEW.record#>'{context,control}','recipientPrincipalIds',original_command->'recipientPrincipalIds',
  'message',NEW.record#>>'{content,message}','expectedPrincipalRevision',author.revision)
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

-- Redefined from 0069: a departure lease ends no later than the next instant, after it is issued, at which one of
-- the organization's accepted controls takes effect or ends, since the controls in force change then.
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
  OR NEW.original_command->>'expectedControlsDigest' IS DISTINCT FROM NEW.issuance_basis#>>'{controls,digest}'
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
