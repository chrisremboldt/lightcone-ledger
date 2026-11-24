-- Rule selection, retained evaluation work and the avoidance register no longer compare against one rule's id or
-- one pack version's digest. Recorded evaluations, findings, hazards, controls and packets are unchanged.

-- Retained evaluation work: any named rule is leased (NULL leases every rule); the worker queues the generic
-- evaluator, which runs the rule only where an adoption in effect holds it.
CREATE OR REPLACE FUNCTION ledger_lease_evaluations(p_owner text,p_limit integer,p_seconds integer,p_leaf_ids text[])
RETURNS TABLE(id text,tenant_id text,flight_id text,trigger_event_id text,leaf_id text,binding_id text,
 due_at timestamptz,clock_mode text,state text,generation bigint,lease_owner text,lease_until timestamptz,
 attempts integer,error text,available_at timestamptz,completed_at timestamptz,worker_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN RETURN QUERY WITH candidates AS (
 SELECT d.id FROM evaluation_deadlines d
 WHERE (d.state='pending' AND d.available_at<=clock_timestamp() OR d.state='leased' AND d.lease_until<clock_timestamp())
 AND (p_leaf_ids IS NULL OR d.leaf_id=ANY(p_leaf_ids))
 AND EXISTS(SELECT 1 FROM principals p WHERE p.tenant_id=d.tenant_id AND p.kind='worker' AND p.active)
 ORDER BY d.available_at,d.id FOR UPDATE SKIP LOCKED LIMIT LEAST(GREATEST(p_limit,1),100)
), leased AS (
 UPDATE evaluation_deadlines d SET state='leased',lease_owner=p_owner,
 lease_until=clock_timestamp()+make_interval(secs=>LEAST(GREATEST(p_seconds,1),300)),
 generation=d.generation+1,attempts=d.attempts+1 FROM candidates c WHERE d.id=c.id RETURNING d.*
)
SELECT l.*,p.id FROM leased l JOIN LATERAL(
 SELECT principal.id FROM principals principal WHERE principal.tenant_id=l.tenant_id
 AND principal.kind='worker' AND principal.active ORDER BY principal.id LIMIT 1
)p ON true;
END $$;
REVOKE ALL ON FUNCTION ledger_lease_evaluations(text,integer,integer,text[]) FROM PUBLIC,ledger_app;
GRANT EXECUTE ON FUNCTION ledger_lease_evaluations(text,integer,integer,text[]) TO ledger_worker;

CREATE OR REPLACE FUNCTION ledger_lease_evaluations(p_owner text,p_limit integer,p_seconds integer)
RETURNS TABLE(id text,tenant_id text,flight_id text,trigger_event_id text,leaf_id text,binding_id text,
 due_at timestamptz,clock_mode text,state text,generation bigint,lease_owner text,lease_until timestamptz,
 attempts integer,error text,available_at timestamptz,completed_at timestamptz,worker_id text)
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT * FROM ledger_lease_evaluations(p_owner,p_limit,p_seconds,NULL::text[]);
$$;

-- An adoption selects for flights when its pack holds a checked rule about flights.
CREATE FUNCTION ledger_selects_for_flights(p_record jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT jsonb_path_exists(p_record,'$.pack.leaves[*] ? (exists(@.check) && @.target.subjectKind == "flight")');
$$;

-- Commands on a flight that has a selection need it current whenever the organization adopted a pack with rules
-- about flights. A flight not yet selected for has nothing to pin.
CREATE OR REPLACE FUNCTION ledger_guard_flight_rule_selection() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE org organizations%ROWTYPE; selected jsonb; adoption_revision bigint; projected_adoption_revision bigint;
BEGIN
 IF NEW.flight_id IS NULL OR NEW.kind NOT IN ('decision.record','evidence.correct','flight.assign') THEN
  RETURN NEW;
 END IF;
 PERFORM 1 FROM flight_views f WHERE f.tenant_id=NEW.tenant_id AND f.id=NEW.flight_id FOR UPDATE;
 SELECT o.* INTO org FROM organizations o WHERE o.tenant_id=NEW.tenant_id FOR SHARE;
 IF NOT EXISTS(
  SELECT 1 FROM organization_pack_adoptions a WHERE a.tenant_id=NEW.tenant_id AND a.organization_id=org.id
  AND ledger_selects_for_flights(a.record)
 ) THEN RETURN NEW; END IF;
 SELECT COALESCE(MAX(a.accepted_revision),0),COALESCE(MAX(a.accepted_revision) FILTER(WHERE v.id IS NOT NULL),0)
 INTO adoption_revision,projected_adoption_revision FROM organization_pack_adoptions a
 LEFT JOIN organization_pack_adoption_views v ON v.tenant_id=a.tenant_id AND v.id=a.id
 WHERE a.tenant_id=NEW.tenant_id AND a.organization_id=org.id;
 SELECT s.record INTO selected FROM flight_rule_selection_views v
 JOIN flight_rule_selections s ON s.tenant_id=v.tenant_id AND s.flight_id=v.flight_id AND s.id=v.current_id
 WHERE v.tenant_id=NEW.tenant_id AND v.flight_id=NEW.flight_id;
 IF selected IS NULL THEN RETURN NEW; END IF;
 IF selected->>'version' IS DISTINCT FROM 'flight.rule-selection.3'
  OR selected->>'flightId' IS DISTINCT FROM NEW.flight_id
  OR selected->>'organizationId' IS DISTINCT FROM org.id
  OR (selected->>'adoptionRevision')::bigint IS DISTINCT FROM adoption_revision
  OR (selected->>'projectedAdoptionRevision')::bigint IS DISTINCT FROM projected_adoption_revision
  OR (selected->'nextBoundary'->>'at')::timestamptz<=clock_timestamp() THEN
  RAISE EXCEPTION 'Flight rule selection changed; refresh and review the current basis' USING ERRCODE='40001';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ledger_guard_flight_rule_selection() FROM PUBLIC,ledger_app;

-- A control or acceptance over an assessment whose evaluation ran under a retained execution selection must still
-- match the flight's current selection; one over a generic evaluation pins its adoption in the evaluation itself.
CREATE OR REPLACE FUNCTION ledger_guard_hazard_evaluated_context() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE flight text;org_id text;selected jsonb;
BEGIN
 IF NEW.record#>'{assessment,evidence,evaluation,execution}' IS NULL THEN RETURN NEW; END IF;
 SELECT origin_flight_id,organization_id INTO flight,org_id FROM hazard_openings
  WHERE tenant_id=NEW.tenant_id AND hazard_id=NEW.hazard_id;
 PERFORM 1 FROM flight_views WHERE tenant_id=NEW.tenant_id AND id=flight FOR UPDATE;
 PERFORM 1 FROM organizations WHERE tenant_id=NEW.tenant_id AND id=org_id FOR SHARE;
 SELECT s.record INTO selected FROM flight_rule_selection_views v JOIN flight_rule_selections s
  ON s.tenant_id=v.tenant_id AND s.flight_id=v.flight_id AND s.id=v.current_id
  WHERE v.tenant_id=NEW.tenant_id AND v.flight_id=flight;
 IF selected IS NULL
  OR NEW.record#>>'{assessment,evidence,evaluation,execution,selection,id}' IS DISTINCT FROM selected->>'id'
  OR NEW.record#>>'{assessment,evidence,evaluation,execution,selection,digest}' IS DISTINCT FROM selected->>'selectionDigest' THEN
  RAISE EXCEPTION 'The assessed rule selection changed before commit; review a current assessment' USING ERRCODE='40001';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ledger_guard_hazard_evaluated_context() FROM PUBLIC,ledger_app;

-- The avoidance register changes with any finding that originated an accepted hazard, from either evaluator, and
-- with any adoption, rather than with one rule and one pack version.
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
  IF EXISTS(SELECT 1 FROM journal_events WHERE tenant_id=NEW.tenant_id AND id=NEW.event_id
   AND event_type='command-link.baseline') THEN RETURN NEW; END IF;
  relevant:=EXISTS(SELECT 1 FROM hazard_openings o JOIN hazard_risk_acceptances a
   ON a.tenant_id=o.tenant_id AND a.hazard_id=o.hazard_id
   WHERE o.tenant_id=NEW.tenant_id AND o.origin_flight_id=NEW.flight_id);
 ELSIF TG_TABLE_NAME='finding_views' THEN
  relevant:=EXISTS(SELECT 1 FROM findings f JOIN hazard_openings o
   ON o.tenant_id=f.tenant_id AND o.origin_finding_id=f.id
   JOIN hazard_risk_acceptances a ON a.tenant_id=o.tenant_id AND a.hazard_id=o.hazard_id
   WHERE f.tenant_id=NEW.tenant_id AND f.id=NEW.id);
 ELSIF TG_TABLE_NAME='flight_rule_selection_views' THEN
  IF TG_OP='UPDATE' AND OLD.current_id IS NOT DISTINCT FROM NEW.current_id THEN RETURN NEW; END IF;
  relevant:=EXISTS(SELECT 1 FROM hazard_openings o JOIN hazard_risk_acceptances a
   ON a.tenant_id=o.tenant_id AND a.hazard_id=o.hazard_id
   WHERE o.tenant_id=NEW.tenant_id AND o.origin_flight_id=NEW.flight_id);
 ELSIF TG_TABLE_NAME='organization_pack_adoptions' THEN
  relevant:=EXISTS(SELECT 1 FROM hazard_openings o JOIN hazard_risk_acceptances a
    ON a.tenant_id=o.tenant_id AND a.hazard_id=o.hazard_id
    WHERE o.tenant_id=NEW.tenant_id AND o.organization_id=NEW.organization_id);
 ELSIF TG_TABLE_NAME='organization_pack_adoption_views' THEN
  relevant:=EXISTS(SELECT 1 FROM organization_pack_adoptions p JOIN hazard_openings o
   ON o.tenant_id=p.tenant_id AND o.organization_id=p.organization_id
   JOIN hazard_risk_acceptances a ON a.tenant_id=o.tenant_id AND a.hazard_id=o.hazard_id
   WHERE p.tenant_id=NEW.tenant_id AND p.id=NEW.id);
 ELSIF TG_TABLE_NAME='work_items' THEN
  SELECT event_type INTO work_type FROM journal_events
   WHERE tenant_id=NEW.tenant_id AND id=NEW.event_id;
  IF FOUND AND work_type IN (
   'telemetry.segment','order.revision','intent.revision','mission.revision',
   'flight.observation','airspace.status','source.observation','identity.link',
   'evidence.correct','flight.created','flight.assign','authority.update','mission.release','mission.departure-authorize','mission.brief','mission.briefing-acknowledge','command-link.baseline','monitoring.window'
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
    WHERE v.tenant_id=NEW.tenant_id AND (v.latest_evaluation_id=NEW.event_id OR v.latest_rule_evaluation_id=NEW.event_id));
 END IF;
 IF relevant THEN
  UPDATE mission_avoidance_register SET revision=revision+1 WHERE tenant_id=NEW.tenant_id;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ledger_publish_mission_avoidance_change() FROM PUBLIC,ledger_app;

CREATE TRIGGER mission_avoidance_rule_evaluation AFTER UPDATE OF latest_rule_evaluation_id ON finding_views
 FOR EACH ROW WHEN(OLD.latest_rule_evaluation_id IS DISTINCT FROM NEW.latest_rule_evaluation_id)
 EXECUTE FUNCTION ledger_publish_mission_avoidance_change();

-- A hazard opened from a generic finding about a flight can be disposed of against its current evaluation, as one
-- opened from a flight evaluation can.
CREATE OR REPLACE FUNCTION ledger_check_hazard_disposition() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE
 author principals%ROWTYPE;
 opening hazard_openings%ROWTYPE;
 hazard hazard_views%ROWTYPE;
 original_command jsonb;
 event_stream text;
 event_sequence bigint;
 closure_subjects text[];
 locked_subjects text[]:='{}';
 missing_subjects text[];
 retained_manifest jsonb;
 current_manifest jsonb;
 accepted_streams jsonb;
 rendered_streams jsonb;
 observed_count integer;
BEGIN
 SELECT * INTO opening FROM hazard_openings WHERE tenant_id=NEW.tenant_id AND hazard_id=NEW.hazard_id;
 PERFORM 1 FROM flight_views WHERE tenant_id=NEW.tenant_id AND id=opening.origin_flight_id FOR UPDATE;
 SELECT * INTO hazard FROM hazard_views WHERE tenant_id=NEW.tenant_id AND id=NEW.hazard_id FOR UPDATE;
 IF NOT FOUND OR hazard.revision IS DISTINCT FROM (CASE WHEN TG_WHEN='BEFORE' THEN NEW.accepted_basis_revision ELSE NEW.accepted_revision END)
  OR (TG_WHEN='BEFORE' AND hazard.status IS DISTINCT FROM NEW.prior_status)
  OR (TG_WHEN='AFTER' AND (hazard.status IS DISTINCT FROM NEW.status OR hazard.latest_disposition_id IS DISTINCT FROM NEW.id)) THEN
  RAISE EXCEPTION 'Hazard disposition basis or status changed before commit' USING ERRCODE='40001';
 END IF;
 PERFORM 1 FROM organizations WHERE tenant_id=NEW.tenant_id AND id=NEW.organization_id FOR SHARE;
 SELECT * INTO author FROM principals WHERE tenant_id=NEW.tenant_id AND id=NEW.actor_id FOR SHARE;
 IF NOT FOUND OR author.active IS NOT TRUE OR author.kind IS DISTINCT FROM 'human'
  OR author.id IS DISTINCT FROM current_setting('ledger.principal_id',true)
  OR opening.record#>>'{owner,id}' IS DISTINCT FROM author.id
  OR NOT author.capabilities @> ARRAY['decision:write','flight:read']::text[]
  OR NEW.record->'owner' IS DISTINCT FROM opening.record->'owner'
  OR NEW.record->'actor' IS DISTINCT FROM jsonb_build_object(
   'id',author.id,'name',author.name,'kind','human','active',true,'principalRevision',author.revision,
   'capabilities',to_jsonb(author.capabilities),'checkedCapabilities',jsonb_build_array('decision:write','flight:read'),
   'policyVersion','ledger.hazard-disposition-authority.1','scope',jsonb_build_object('kind','hazard','id',NEW.hazard_id)) THEN
  RAISE EXCEPTION 'Hazard disposition requires its unchanged active human owner through commit' USING ERRCODE='40001';
 END IF;
 IF NEW.effectiveness_review_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM hazard_effectiveness_reviews
  WHERE tenant_id=NEW.tenant_id AND hazard_id=NEW.hazard_id AND id=NEW.effectiveness_review_id
   AND record_digest=NEW.effectiveness_review_digest) THEN
  RAISE EXCEPTION 'Disposition review must identify the exact immutable judgment in this hazard' USING ERRCODE='23514';
 END IF;
 IF opening.organization_id IS DISTINCT FROM NEW.organization_id OR NOT (EXISTS(
  SELECT 1 FROM finding_views f JOIN flight_evaluations e ON e.tenant_id=f.tenant_id AND e.id=f.latest_evaluation_id
   AND e.flight_id=f.flight_id WHERE f.tenant_id=NEW.tenant_id AND f.id=opening.origin_finding_id
   AND f.flight_id=opening.origin_flight_id AND NEW.record#>'{evidence,evaluation}'=e.record
   AND NEW.record#>'{evidence,reference}'=jsonb_build_object('flightId',f.flight_id,'findingId',f.id,'evaluationId',e.id))
  -- A finding the generic evaluator recorded about the flight is retained in the flight's evaluation shape.
  OR EXISTS(SELECT 1 FROM finding_views f JOIN findings g ON g.tenant_id=f.tenant_id AND g.id=f.id
   WHERE f.tenant_id=NEW.tenant_id AND f.id=opening.origin_finding_id AND f.latest_rule_evaluation_id IS NOT NULL
   AND g.subject_scope='ledger' AND g.subject_kind='flight' AND g.subject_id=opening.origin_flight_id
   AND NEW.record#>>'{evidence,evaluation,id}'=f.latest_rule_evaluation_id
   AND NEW.record#>'{evidence,reference}'=jsonb_build_object('flightId',opening.origin_flight_id,'findingId',f.id,
    'evaluationId',f.latest_rule_evaluation_id))) THEN
  RAISE EXCEPTION 'Disposition must retain the reviewed current hazard evidence' USING ERRCODE='40001';
 END IF;
 LOOP
  WITH RECURSIVE closure(id) AS (
   SELECT NEW.hazard_id UNION SELECT d.dependency_subject_id FROM subject_dependencies d JOIN closure c ON c.id=d.subject_id WHERE d.tenant_id=NEW.tenant_id
  ) SELECT array_agg(id ORDER BY id COLLATE "C") INTO closure_subjects FROM closure;
  SELECT array_agg(id ORDER BY id COLLATE "C") INTO missing_subjects FROM unnest(closure_subjects) id WHERE NOT(id=ANY(locked_subjects));
  EXIT WHEN missing_subjects IS NULL;
  PERFORM 1 FROM subjects WHERE tenant_id=NEW.tenant_id AND id=ANY(missing_subjects) ORDER BY id COLLATE "C" FOR SHARE;
  GET DIAGNOSTICS observed_count=ROW_COUNT;
  IF observed_count<>cardinality(missing_subjects) THEN RAISE EXCEPTION 'Disposition basis contains an unavailable subject' USING ERRCODE='23514'; END IF;
  locked_subjects:=locked_subjects||missing_subjects;
 END LOOP;
 retained_manifest:=NEW.record->'basisManifest';
 SELECT stream_id,stream_sequence INTO event_stream,event_sequence FROM journal_events WHERE tenant_id=NEW.tenant_id AND id=NEW.id;
 WITH normalized AS (
  SELECT d.subject_id,d.stream_id,CASE WHEN d.event_id=NEW.id THEN (prior->>'sequence')::bigint ELSE d.sequence END AS sequence
  FROM subject_stream_dependencies d LEFT JOIN LATERAL(
   SELECT entry AS prior FROM jsonb_array_elements(retained_manifest->'frontiers') entry
   WHERE entry->>'subjectId'=d.subject_id AND entry->>'streamId'=d.stream_id
  ) previous ON d.event_id=NEW.id
  WHERE d.tenant_id=NEW.tenant_id AND d.subject_id=ANY(closure_subjects) AND (d.event_id<>NEW.id OR prior IS NOT NULL)
 ), frontiers AS (
  SELECT n.*,LEAST(n.sequence,COALESCE(p.sequence,0)) AS projected_sequence FROM normalized n
  LEFT JOIN projection_offsets p ON p.tenant_id=NEW.tenant_id AND p.stream_id=n.stream_id
 ), authority AS (
  SELECT s.id,s.sequence,COALESCE(p.sequence,0) AS projected_sequence FROM streams s
  LEFT JOIN projection_offsets p ON p.tenant_id=s.tenant_id AND p.stream_id=s.id
  WHERE s.tenant_id=NEW.tenant_id AND s.name='authority:'||NEW.actor_id
 ) SELECT jsonb_build_object('version','subject-evidence.1','subjectId',NEW.hazard_id,'principalId',NEW.actor_id,
  'principalRevision',author.revision,'subjects',to_jsonb(closure_subjects),
  'edges',COALESCE((SELECT jsonb_agg(jsonb_build_object('subjectId',d.subject_id,'dependencySubjectId',d.dependency_subject_id,'eventId',d.event_id)
   ORDER BY d.subject_id COLLATE "C",d.dependency_subject_id COLLATE "C") FROM subject_dependencies d
   WHERE d.tenant_id=NEW.tenant_id AND d.subject_id=ANY(closure_subjects)),'[]'::jsonb),
  'frontiers',COALESCE((SELECT jsonb_agg(jsonb_build_object('subjectId',subject_id,'streamId',stream_id,'sequence',sequence,'projectedSequence',projected_sequence)
   ORDER BY subject_id COLLATE "C",stream_id COLLATE "C") FROM frontiers),'[]'::jsonb),
  'authority',(SELECT jsonb_build_object('streamId',id,'sequence',sequence,'projectedSequence',projected_sequence) FROM authority)) INTO current_manifest;
 IF retained_manifest IS DISTINCT FROM current_manifest THEN
  RAISE EXCEPTION 'The complete disposition dependency basis changed before commit' USING ERRCODE='40001';
 END IF;
 SELECT COALESCE(jsonb_object_agg(stream_id,sequence),'{}'::jsonb),COALESCE(jsonb_object_agg(stream_id,projected_sequence),'{}'::jsonb)
 INTO accepted_streams,rendered_streams FROM (
  SELECT stream_id,max(sequence) AS sequence,max(projected_sequence) AS projected_sequence FROM (
   SELECT entry->>'streamId' AS stream_id,(entry->>'sequence')::bigint AS sequence,(entry->>'projectedSequence')::bigint AS projected_sequence
   FROM jsonb_array_elements(current_manifest->'frontiers') entry
   UNION ALL SELECT current_manifest#>>'{authority,streamId}',(current_manifest#>>'{authority,sequence}')::bigint,
    (current_manifest#>>'{authority,projectedSequence}')::bigint WHERE current_manifest->'authority'<>'null'::jsonb
  ) positions GROUP BY stream_id
 ) combined;
 IF NEW.record->'renderedInputCut' IS DISTINCT FROM jsonb_build_object('streams',rendered_streams,'basisRevision',NEW.accepted_basis_revision,'principalRevision',author.revision)
  OR NEW.record->'acceptedInputCut' IS DISTINCT FROM jsonb_build_object('streams',accepted_streams,'basisRevision',NEW.accepted_basis_revision,'principalRevision',author.revision) THEN
  RAISE EXCEPTION 'Disposition cuts must retain every rendered and accepted dependency' USING ERRCODE='23514';
 END IF;
 original_command:=jsonb_build_object('kind','decision.record','hazardId',NEW.hazard_id,'subject',jsonb_build_object('kind','hazard','id',NEW.hazard_id),
  'decision',jsonb_build_object('kind','hazard.disposition','status',NEW.status,'note',NEW.record->>'note'),
  'expectedRevision',NEW.accepted_basis_revision,'inputCut',NEW.record->'renderedInputCut','expectedDependencyBasis',NEW.dependency_basis);
 IF NEW.effectiveness_review_id IS NOT NULL THEN original_command:=original_command||jsonb_build_object('effectivenessReview',NEW.record->'effectivenessReview'); END IF;
 IF NOT EXISTS(SELECT 1 FROM command_records c JOIN journal_events e ON e.tenant_id=c.tenant_id AND e.id=c.id
  JOIN streams s ON s.tenant_id=e.tenant_id AND s.id=e.stream_id JOIN decisions d ON d.tenant_id=c.tenant_id AND d.id=c.id
  WHERE c.tenant_id=NEW.tenant_id AND c.id=NEW.id AND c.kind='decision.record' AND c.flight_id IS NULL
   AND c.actor_id=NEW.actor_id AND c.recorded_at=NEW.recorded_at AND c.payload=original_command
   AND e.event_type='decision.record' AND e.principal_id=NEW.actor_id AND e.received_at=NEW.recorded_at AND s.name='hazard:'||NEW.hazard_id
   AND e.payload=original_command||jsonb_build_object('acceptance',NEW.record-ARRAY['id','recordedAt'],'declaredSubjects',jsonb_build_array(NEW.hazard_id))
   AND d.subject_id=NEW.hazard_id AND d.kind='hazard.disposition' AND d.actor_id=NEW.actor_id
   AND d.accepted_revision=NEW.accepted_revision AND d.accepted_basis_revision=NEW.accepted_basis_revision AND d.record=NEW.record
   AND d.note=NEW.record->>'note' AND d.recorded_at=NEW.recorded_at
   AND d.rendered_input_cut=NEW.record->'renderedInputCut' AND d.accepted_input_cut=NEW.record->'acceptedInputCut') THEN
  RAISE EXCEPTION 'Disposition must equal its original command, journal and decision' USING ERRCODE='23514';
 END IF;
 IF TG_WHEN='AFTER' AND NOT EXISTS(SELECT 1 FROM subject_stream_dependencies WHERE tenant_id=NEW.tenant_id
  AND subject_id=NEW.hazard_id AND stream_id=event_stream AND sequence=event_sequence AND event_id=NEW.id) THEN
  RAISE EXCEPTION 'Disposition must retain its accepted hazard evidence frontier' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ledger_check_hazard_disposition() FROM PUBLIC,ledger_app;
