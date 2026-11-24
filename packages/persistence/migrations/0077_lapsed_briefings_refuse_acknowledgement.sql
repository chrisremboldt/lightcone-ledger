-- A briefing past its valid_until no longer counts. The application refuses to acknowledge a lapsed
-- briefing, by the database clock after it locks the flight; this trigger checks the same at commit, as the briefing
-- commit trigger does for the briefing itself, so an acknowledgement whose commit reaches the briefing's valid_until
-- is not recorded. Redefined from 0031 with that one change: it also reads the briefing's valid_until. The locks it
-- takes, and their order, are unchanged: the flight, then the author.
CREATE OR REPLACE FUNCTION ledger_check_mission_briefing_acknowledgement_commit() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE
 author principals%ROWTYPE;
 briefing_record jsonb;
 retained_briefing_digest text;
 briefing_valid_until timestamptz;
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
 SELECT record,record_digest,valid_until INTO briefing_record,retained_briefing_digest,briefing_valid_until FROM mission_briefings
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
 IF clock_timestamp()>=briefing_valid_until THEN
  RAISE EXCEPTION 'Briefing lapsed before the acknowledgement committed' USING ERRCODE='40001';
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION ledger_check_mission_briefing_acknowledgement_commit() FROM PUBLIC,ledger_app;
