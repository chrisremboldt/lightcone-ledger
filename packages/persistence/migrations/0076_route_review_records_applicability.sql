-- Route review records applicability. Every accepted area control overlapping a mission's interval is
-- considered (at most 512) and evaluated by the applicability rule its pinned type declares; only the controls that
-- apply are candidates (at most 64). A release, a briefing's controls list and a departure authorization's issuance
-- basis change shape in place, keeping their version ids: a release's avoidance lists the controls that do not apply
-- (basis.avoidance.notApplicable) with their safety context preimages (basis.notApplicableContexts), a controls list
-- names the mission revision route review read (mission) and lists the controls that do not apply in a compact part of
-- their own (notApplicable). An issuance basis keeps the route review it re-checked without the controls that do not
-- apply: the release records them and its context digest covers them. A briefing may now be 1 MiB and a release 4 MiB.
--
-- Nothing recorded is deleted: the migration refuses to run while any row of the earlier shape exists. Such a
-- database must be recreated.
DO $$
DECLARE
 held text[]:=ARRAY[]::text[];
BEGIN
 IF EXISTS(SELECT 1 FROM mission_releases
  WHERE jsonb_typeof(record#>'{basis,notApplicableContexts}') IS DISTINCT FROM 'array'
   OR jsonb_typeof(record#>'{basis,avoidance,notApplicable}') IS DISTINCT FROM 'array'
   OR record#>>'{policy,avoidance}' IS DISTINCT FROM 'applicable_outside_complete_current') THEN
  held:=held||ARRAY['mission_releases'];
 END IF;
 IF EXISTS(SELECT 1 FROM mission_briefings WHERE record->'controls' IS NOT NULL
  AND NOT (record->'controls' ? 'mission' AND record->'controls' ? 'notApplicable')) THEN
  held:=held||ARRAY['mission_briefings'];
 END IF;
 IF EXISTS(SELECT 1 FROM mission_departure_authorizations
  WHERE NOT COALESCE(issuance_basis->'controls' ? 'mission' AND issuance_basis->'controls' ? 'notApplicable',false)) THEN
  held:=held||ARRAY['mission_departure_authorizations'];
 END IF;
 IF cardinality(held)>0 THEN
  RAISE EXCEPTION 'This database holds mission records of an earlier shape (in %). Recreate the database and run the migrations again.',
   array_to_string(held,', ') USING ERRCODE='55000';
 END IF;
END $$;

-- The record identity checks of 0075, each with the new shape's members added.
ALTER TABLE mission_releases DROP CONSTRAINT mission_releases_record_identity;
ALTER TABLE mission_releases ADD CONSTRAINT mission_releases_record_identity CHECK(
 record->>'version' IS NOT DISTINCT FROM 'flight.mission-release.2'
 AND record#>'{policy,version}' IS NOT DISTINCT FROM '2'::jsonb
 AND jsonb_typeof(record#>'{basis,findings,findings}') IS NOT DISTINCT FROM 'array'
 AND record#>>'{basis,findings,digest}' ~ '^[a-f0-9]{64}$'
 AND jsonb_typeof(record#>'{basis,avoidance,notApplicable}') IS NOT DISTINCT FROM 'array'
 AND jsonb_typeof(record#>'{basis,notApplicableContexts}') IS NOT DISTINCT FROM 'array'
 AND CASE WHEN jsonb_typeof(record#>'{basis,avoidance,notApplicable}')='array'
   AND jsonb_typeof(record#>'{basis,notApplicableContexts}')='array'
   AND jsonb_typeof(record#>'{basis,avoidance,candidates}')='array'
  THEN jsonb_array_length(record#>'{basis,notApplicableContexts}')
    =jsonb_array_length(record#>'{basis,avoidance,notApplicable}')
   AND jsonb_array_length(record#>'{basis,avoidance,notApplicable}')
    +jsonb_array_length(record#>'{basis,avoidance,candidates}')<=512
  ELSE false END
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
ALTER TABLE mission_briefings DROP CONSTRAINT mission_briefings_record_identity;
ALTER TABLE mission_briefings ADD CONSTRAINT mission_briefings_record_identity
 CHECK(record->>'version' IS NOT DISTINCT FROM 'flight.mission-briefing.3'
  AND (record->'controls' IS NULL OR (record#>>'{controls,version}' IS NOT DISTINCT FROM 'flight.controls-seen.1'
   AND COALESCE(record#>>'{controls,digest}' ~ '^[a-f0-9]{64}$',false)
   AND COALESCE(jsonb_typeof(record#>'{controls,mission}') IN ('null','object'),false)
   AND jsonb_typeof(record#>'{controls,notApplicable}') IS NOT DISTINCT FROM 'array'))
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
-- A release records every considered control; with 512 of them its bound is 4 MiB (0028).
DO $$ DECLARE c text; BEGIN
 SELECT conname INTO STRICT c FROM pg_constraint WHERE conrelid='mission_releases'::regclass AND contype='c'
  AND pg_get_constraintdef(oid) LIKE '%2097152%';
 EXECUTE format('ALTER TABLE mission_releases DROP CONSTRAINT %I',c);
END $$;
ALTER TABLE mission_releases ADD CONSTRAINT mission_releases_record_size
 CHECK(jsonb_typeof(record)='object' AND octet_length(record::text)<=4194304);
-- A briefing pins the controls list its author saw; with every considered control listed, its bound is 1 MiB (0031).
DO $$ DECLARE c text; BEGIN
 SELECT conname INTO STRICT c FROM pg_constraint WHERE conrelid='mission_briefings'::regclass AND contype='c'
  AND pg_get_constraintdef(oid) LIKE '%131072%';
 EXECUTE format('ALTER TABLE mission_briefings DROP CONSTRAINT %I',c);
END $$;
ALTER TABLE mission_briefings ADD CONSTRAINT mission_briefings_record_size
 CHECK(jsonb_typeof(record)='object' AND octet_length(record::text)<=1048576);
ALTER TABLE mission_departure_authorizations DROP CONSTRAINT mission_departure_record_identity;
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
  AND issuance_basis->'notApplicableContexts' IS NULL AND issuance_basis#>'{avoidance,notApplicable}' IS NULL
  AND issuance_basis#>>'{controls,version}' IS NOT DISTINCT FROM 'flight.controls-seen.1'
  AND jsonb_typeof(issuance_basis#>'{controls,controls}') IS NOT DISTINCT FROM 'array'
  AND COALESCE(jsonb_typeof(issuance_basis#>'{controls,mission}') IN ('null','object'),false)
  AND jsonb_typeof(issuance_basis#>'{controls,notApplicable}') IS NOT DISTINCT FROM 'array'
  AND COALESCE(issuance_basis#>>'{controls,digest}' ~ '^[a-f0-9]{64}$',false));

-- The release and briefing commit triggers are unchanged: a release's trigger reads its mission and candidate
-- contexts, and a briefing's accepts only exact candidates of its release, which are now the controls that apply.
-- Whether a control applies is computed by the application from the control type's registered rule, in the same
-- transaction and under the same locks as the pin; a trigger cannot rerun that code.

-- Redefined from 0075 with two changes: the issuance basis's context digest must equal the release's, which covers
-- the controls that do not apply (the basis keeps no copy of them; its candidates must equal the release's, as
-- before); and a command may name no controls digest only when both parts of the pinned
-- list are empty. The locks it takes, and their order, are unchanged: the flight, the author,
-- then the safety register. It takes no new lock.
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
  OR NEW.issuance_basis#>>'{avoidance,contextDigest}' IS DISTINCT FROM release_record#>>'{basis,avoidance,contextDigest}'
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
    OR NEW.issuance_basis#>'{controls,controls}' IS DISTINCT FROM '[]'::jsonb
    OR NEW.issuance_basis#>'{controls,notApplicable}' IS DISTINCT FROM '[]'::jsonb))
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
