-- Route avoidance also reads area controls accepted on safety-record hazards (accepted_hazard_controls). A change to
-- what that read returns publishes on the tenant's avoidance register, as a flight-side acceptance does, so a release,
-- briefing or departure prepared against the earlier read conflicts at commit. A change is a new accepted row, or a
-- hazard or control record that accepted rows name moving to another acceptance, assessment, version or status.
CREATE FUNCTION ledger_publish_accepted_control_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 -- NEW has an id only on sms_records, so the test is nested rather than joined with AND.
 IF TG_TABLE_NAME='sms_records' THEN
  IF NOT EXISTS(SELECT 1 FROM accepted_hazard_controls a
   WHERE a.tenant_id=NEW.tenant_id AND (a.hazard_id=NEW.id OR a.control_id=NEW.id)) THEN
   RETURN NEW;
  END IF;
 END IF;
 UPDATE mission_avoidance_register SET revision=revision+1 WHERE tenant_id=NEW.tenant_id;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ledger_publish_accepted_control_change() FROM PUBLIC,ledger_app;

CREATE TRIGGER mission_avoidance_accepted_control AFTER INSERT ON accepted_hazard_controls
 FOR EACH ROW EXECUTE FUNCTION ledger_publish_accepted_control_change();
CREATE TRIGGER mission_avoidance_control_record AFTER UPDATE ON sms_records
 FOR EACH ROW WHEN((OLD.latest_acceptance_id,OLD.latest_assessment_id,OLD.version_number,OLD.status)
  IS DISTINCT FROM (NEW.latest_acceptance_id,NEW.latest_assessment_id,NEW.version_number,NEW.status))
 EXECUTE FUNCTION ledger_publish_accepted_control_change();

-- A briefing may cite a released candidate that is an area control record. Redefined from 0031 with one change:
-- where no flight-side hazard control matches the candidate, the briefed content must match that record's version.
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
 IF FOUND THEN
  IF NEW.record#>'{content,control}' IS DISTINCT FROM jsonb_build_object(
   'template',control_record->'template','center',control_record->'center','radiusMeters',control_record->'radiusMeters',
   'label',control_record->'label','effectiveFrom',control_record->'effectiveFrom','effectiveUntil',control_record->'effectiveUntil') THEN
   RAISE EXCEPTION 'Briefing instruction differs from its retained control' USING ERRCODE='23514';
  END IF;
 ELSE
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
