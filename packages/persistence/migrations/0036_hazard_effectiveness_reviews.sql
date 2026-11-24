ALTER TABLE decisions DROP CONSTRAINT decisions_target;
ALTER TABLE decisions ADD CONSTRAINT decisions_target CHECK(
 (flight_id IS NOT NULL AND subject_id IS NULL AND adoption_id IS NULL AND accepted_revision IS NULL AND record IS NULL)
 OR (flight_id IS NULL AND subject_id IS NOT NULL AND adoption_id IS NOT NULL AND accepted_revision IS NOT NULL
  AND accepted_revision>0 AND record IS NOT NULL AND jsonb_typeof(record)='object' AND kind='adoption.review')
 OR (flight_id IS NULL AND subject_id IS NOT NULL AND adoption_id IS NULL AND accepted_revision IS NOT NULL
  AND accepted_revision>0 AND record IS NOT NULL AND jsonb_typeof(record)='object'
  AND ((kind='risk.assess' AND record->>'version' IS NOT DISTINCT FROM 'hazard.assessment.1')
   OR (kind='risk.accept' AND record->>'version' IS NOT DISTINCT FROM 'hazard.risk-acceptance.1')
   OR (kind='control.effectiveness-review' AND record->>'version' IS NOT DISTINCT FROM 'hazard.effectiveness-review.2'))
  AND record->>'hazardId' IS NOT DISTINCT FROM subject_id)
);

CREATE TABLE hazard_effectiveness_reviews (
 id text PRIMARY KEY,tenant_id text NOT NULL,hazard_id text NOT NULL,organization_id text NOT NULL,
 accepted_revision bigint NOT NULL CHECK(accepted_revision>1),accepted_basis_revision bigint NOT NULL CHECK(accepted_basis_revision>0),
 actor_id text NOT NULL,calculation_id text NOT NULL,
 calculation_digest text NOT NULL CHECK(calculation_digest ~ '^[a-f0-9]{64}$'),
 monitoring_id text NOT NULL,monitoring_digest text NOT NULL CHECK(monitoring_digest ~ '^[a-f0-9]{64}$'),
 control_event_id text NOT NULL,dependency_basis text NOT NULL CHECK(dependency_basis ~ '^[a-f0-9]{64}$'),
 record_digest text NOT NULL CHECK(record_digest ~ '^[a-f0-9]{64}$'),
 record jsonb NOT NULL CHECK(jsonb_typeof(record)='object' AND octet_length(record::text)<=393216),
 record_canonical text NOT NULL CHECK(octet_length(record_canonical)<=393216),
 basis_canonical text NOT NULL CHECK(octet_length(basis_canonical)<=131072),
 recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at)),
 CHECK(accepted_revision=accepted_basis_revision+1),
 CHECK(record_canonical::jsonb=record AND record_digest=encode(sha256(convert_to(record_canonical,'UTF8')),'hex')),
 CHECK(basis_canonical::jsonb=record->'basisManifest' AND dependency_basis=encode(sha256(convert_to(basis_canonical,'UTF8')),'hex')),
 CHECK(record ?& ARRAY['version','id','hazardId','organizationId','control','calculation','actor','acceptedRevision',
  'acceptedBasisRevision','renderedInputCut','acceptedInputCut','dependencyBasis','basisManifest','decision','recordedAt']
  AND record-ARRAY['version','id','hazardId','organizationId','control','calculation','actor','acceptedRevision',
   'acceptedBasisRevision','renderedInputCut','acceptedInputCut','dependencyBasis','basisManifest','decision','recordedAt']='{}'::jsonb
  AND record->>'version' IS NOT DISTINCT FROM 'hazard.effectiveness-review.2'
  AND record->>'id' IS NOT DISTINCT FROM id AND record->>'hazardId' IS NOT DISTINCT FROM hazard_id
  AND record->>'organizationId' IS NOT DISTINCT FROM organization_id
  AND (record->>'acceptedRevision')::bigint IS NOT DISTINCT FROM accepted_revision
  AND (record->>'acceptedBasisRevision')::bigint IS NOT DISTINCT FROM accepted_basis_revision
  AND (record->>'recordedAt')::timestamptz IS NOT DISTINCT FROM recorded_at
  AND record->>'dependencyBasis' IS NOT DISTINCT FROM dependency_basis
  AND record#>>'{actor,id}' IS NOT DISTINCT FROM actor_id
  AND record#>>'{calculation,id}' IS NOT DISTINCT FROM calculation_id
  AND record#>>'{calculation,digest}' IS NOT DISTINCT FROM calculation_digest
  AND record#>>'{calculation,record,version}' IS NOT DISTINCT FROM 'control.effectiveness-record.2'
  AND record#>>'{calculation,record,id}' IS NOT DISTINCT FROM calculation_id
  AND record#>>'{calculation,record,monitoring,id}' IS NOT DISTINCT FROM monitoring_id
  AND record#>>'{calculation,record,monitoring,digest}' IS NOT DISTINCT FROM monitoring_digest
  AND record#>>'{control,controlEventId}' IS NOT DISTINCT FROM control_event_id
  AND record#>>'{control,hazardId}' IS NOT DISTINCT FROM hazard_id),
 CHECK(jsonb_typeof(record->'basisManifest') IS NOT DISTINCT FROM 'object'
  AND octet_length((record->'basisManifest')::text)<=131072
  AND record#>>'{basisManifest,version}' IS NOT DISTINCT FROM 'control.effectiveness-review-basis.2'
  AND record#>'{basisManifest,hazard}'=jsonb_build_object('id',hazard_id,'revision',accepted_basis_revision)
  AND record#>>'{basisManifest,organizationId}' IS NOT DISTINCT FROM organization_id
  AND record#>'{basisManifest,calculation}'=jsonb_build_object('id',calculation_id,'digest',calculation_digest)
  AND record#>'{basisManifest,monitoring}'=jsonb_build_object('id',monitoring_id,'digest',monitoring_digest)
  AND record#>'{basisManifest,control}'=record->'control'
  AND record#>>'{basisManifest,manifest,version}' IS NOT DISTINCT FROM 'subject-evidence.1'
  AND jsonb_typeof(record#>'{basisManifest,flights}') IS NOT DISTINCT FROM 'array'
  AND jsonb_array_length(record#>'{basisManifest,flights}') BETWEEN 1 AND 33
  AND jsonb_typeof(record#>'{basisManifest,manifest,subjects}') IS NOT DISTINCT FROM 'array'
  AND jsonb_array_length(record#>'{basisManifest,manifest,subjects}')<=128
  AND jsonb_typeof(record#>'{basisManifest,manifest,edges}') IS NOT DISTINCT FROM 'array'
  AND jsonb_array_length(record#>'{basisManifest,manifest,edges}')<=256
  AND jsonb_typeof(record#>'{basisManifest,manifest,frontiers}') IS NOT DISTINCT FROM 'array'
  AND jsonb_array_length(record#>'{basisManifest,manifest,frontiers}')<=512),
 CHECK(record#>>'{decision,kind}' IS NOT DISTINCT FROM 'control.effectiveness-review'
  AND COALESCE(record#>>'{decision,conclusion}' IN ('effective','ineffective','inconclusive'),false)
  AND jsonb_typeof(record#>'{decision,note}') IS NOT DISTINCT FROM 'string'
  AND length(record#>>'{decision,note}') BETWEEN 1 AND 4000
  AND record#>'{calculation,record,resolution,complete}'='true'::jsonb
  AND jsonb_typeof(record#>'{calculation,record,evaluation}') IS NOT DISTINCT FROM 'object'
  AND (record#>>'{calculation,record,evidenceState}'='supported'
   OR (record#>>'{calculation,record,evidenceState}'='insufficient' AND record#>>'{decision,conclusion}'='inconclusive'))),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,hazard_id,id),UNIQUE(tenant_id,hazard_id,accepted_revision),
 FOREIGN KEY(tenant_id,id) REFERENCES command_records(tenant_id,id),
 FOREIGN KEY(tenant_id,hazard_id,id) REFERENCES decisions(tenant_id,subject_id,id),
 FOREIGN KEY(tenant_id,hazard_id) REFERENCES hazard_views(tenant_id,id),
 FOREIGN KEY(tenant_id,organization_id) REFERENCES organizations(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES principals(tenant_id,id),
 FOREIGN KEY(tenant_id,calculation_id) REFERENCES control_effectiveness_records(tenant_id,id),
 FOREIGN KEY(tenant_id,monitoring_id) REFERENCES monitoring_window_revisions(tenant_id,id),
 FOREIGN KEY(tenant_id,control_event_id) REFERENCES hazard_controls(tenant_id,id)
);
CREATE INDEX hazard_effectiveness_review_history ON hazard_effectiveness_reviews(tenant_id,hazard_id,recorded_at DESC,id DESC);

CREATE TABLE hazard_effectiveness_review_projections (
 tenant_id text NOT NULL,review_id text NOT NULL,hazard_id text NOT NULL,
 projected_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(projected_at)),
 PRIMARY KEY(tenant_id,review_id),
 FOREIGN KEY(tenant_id,hazard_id,review_id) REFERENCES hazard_effectiveness_reviews(tenant_id,hazard_id,id)
);

CREATE FUNCTION ledger_check_effectiveness_review_basis() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE
 author principals%ROWTYPE;
 calculation control_effectiveness_records%ROWTYPE;
 monitoring monitoring_window_revisions%ROWTYPE;
 original_flight text;
 protected_flights text[];
 declared_subjects text[];
 root_subjects text[];
 closure_subjects text[];
 locked_subjects text[]:='{}';
 missing_subjects text[];
 retained_manifest jsonb;
 current_manifest jsonb;
 current_flights jsonb;
 expected_cut jsonb;
 rendered_streams jsonb;
 accepted_streams jsonb;
 original_command jsonb;
 calculation_selection jsonb;
 selected_ids text[];
 retained_ids text[];
 observed_count integer;
 observed_revision bigint;
 event_stream text;
 event_sequence bigint;
 selected_record record;
BEGIN
 SELECT * INTO calculation FROM control_effectiveness_records
 WHERE tenant_id=NEW.tenant_id AND id=NEW.calculation_id;
 SELECT * INTO monitoring FROM monitoring_window_revisions
 WHERE tenant_id=NEW.tenant_id AND id=NEW.monitoring_id;
 IF calculation.id IS NULL OR monitoring.id IS NULL
  OR calculation.record_digest IS DISTINCT FROM NEW.calculation_digest
  OR calculation.monitoring_id IS DISTINCT FROM NEW.monitoring_id
  OR calculation.monitoring_digest IS DISTINCT FROM NEW.monitoring_digest
  OR calculation.organization_id IS DISTINCT FROM NEW.organization_id
  OR monitoring.organization_id IS DISTINCT FROM NEW.organization_id
  OR monitoring.record_digest IS DISTINCT FROM NEW.monitoring_digest
  OR NEW.record#>'{calculation,record}' IS DISTINCT FROM calculation.record
  OR NEW.record->'calculation' IS DISTINCT FROM jsonb_build_object('id',calculation.id,'digest',calculation.record_digest,'record',calculation.record)
  OR NEW.record->'control' IS DISTINCT FROM monitoring.record#>'{source,control}'
  OR NEW.record->'control' IS DISTINCT FROM calculation.record#>'{evaluation,control}'
  OR calculation.record#>'{resolution,complete}' IS DISTINCT FROM 'true'::jsonb
  OR jsonb_typeof(calculation.record->'evaluation') IS DISTINCT FROM 'object'
  OR NEW.recorded_at<calculation.recorded_at THEN
  RAISE EXCEPTION 'Review must retain its exact resolved calculation, monitoring and control' USING ERRCODE='23514';
 END IF;
 SELECT origin_flight_id INTO original_flight FROM hazard_openings
 WHERE tenant_id=NEW.tenant_id AND hazard_id=NEW.hazard_id AND organization_id=NEW.organization_id;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Review hazard must belong to the same organization' USING ERRCODE='23514';
 END IF;
 SELECT array_agg(id ORDER BY id COLLATE "C") INTO protected_flights FROM (
  SELECT original_flight AS id UNION SELECT entry->>'flightId' FROM jsonb_array_elements(monitoring.record#>'{source,flights}') entry
 ) ids;
 PERFORM 1 FROM flight_views WHERE tenant_id=NEW.tenant_id AND id=ANY(protected_flights) ORDER BY id COLLATE "C" FOR UPDATE;
 SELECT revision INTO observed_revision FROM hazard_views WHERE tenant_id=NEW.tenant_id AND id=NEW.hazard_id FOR UPDATE;
 IF NOT FOUND OR observed_revision IS DISTINCT FROM (CASE WHEN TG_WHEN='BEFORE' THEN NEW.accepted_basis_revision ELSE NEW.accepted_revision END) THEN
  RAISE EXCEPTION 'Hazard revision changed before the review committed' USING ERRCODE='40001';
 END IF;
 PERFORM 1 FROM organizations WHERE tenant_id=NEW.tenant_id AND id=NEW.organization_id FOR SHARE;
 SELECT * INTO author FROM principals WHERE tenant_id=NEW.tenant_id AND id=NEW.actor_id FOR SHARE;
 IF NOT FOUND OR author.active IS NOT TRUE OR author.kind IS DISTINCT FROM 'human'
  OR author.id IS DISTINCT FROM current_setting('ledger.principal_id',true)
  OR NOT author.capabilities @> ARRAY['decision:write','flight:read']::text[]
  OR NEW.record->'actor' IS DISTINCT FROM jsonb_build_object(
   'id',author.id,'name',author.name,'kind','human','active',true,'principalRevision',author.revision,
   'capabilities',to_jsonb(author.capabilities),'checkedCapabilities',jsonb_build_array('decision:write','flight:read'),
   'policyVersion','ledger.control-effectiveness-review-authority.2','scope',jsonb_build_object('kind','hazard','id',NEW.hazard_id)) THEN
  RAISE EXCEPTION 'Review requires unchanged active human authority through commit' USING ERRCODE='40001';
 END IF;
 PERFORM 1 FROM monitoring_window_revisions latest WHERE latest.tenant_id=NEW.tenant_id AND latest.window_id=monitoring.window_id
  AND latest.id=NEW.monitoring_id AND latest.source_revision=(SELECT max(source_revision) FROM monitoring_window_revisions
   WHERE tenant_id=NEW.tenant_id AND window_id=monitoring.window_id);
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Monitoring changed; refresh the calculation and review context' USING ERRCODE='40001';
 END IF;
 PERFORM 1 FROM hazard_controls c JOIN hazard_risk_acceptances a
  ON a.tenant_id=c.tenant_id AND a.hazard_id=c.hazard_id AND a.control_id=c.control_id AND a.control_version=c.control_version
 WHERE c.tenant_id=NEW.tenant_id AND c.id=NEW.control_event_id AND c.hazard_id=NEW.hazard_id
  AND c.control_id=NEW.record#>>'{control,controlId}' AND c.control_version=(NEW.record#>>'{control,controlVersion}')::integer
  AND a.id=NEW.record#>>'{control,acceptance,id}' AND a.accepted_revision=(NEW.record#>>'{control,acceptance,acceptedRevision}')::bigint;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Review control must retain its exact hazard and risk acceptance' USING ERRCODE='23514';
 END IF;
 SELECT array_agg(id ORDER BY id COLLATE "C") INTO declared_subjects FROM (
  SELECT NEW.hazard_id AS id UNION SELECT NEW.organization_id
  UNION SELECT entry->>'flightId' FROM jsonb_array_elements(monitoring.record#>'{source,flights}') entry
 ) ids;
 SELECT array_agg(id ORDER BY id COLLATE "C") INTO root_subjects FROM (
  SELECT unnest(declared_subjects) AS id UNION SELECT unnest(protected_flights)
 ) ids;
 LOOP
  WITH RECURSIVE closure(id) AS (
   SELECT unnest(root_subjects)
   UNION SELECT d.dependency_subject_id FROM subject_dependencies d JOIN closure c ON c.id=d.subject_id WHERE d.tenant_id=NEW.tenant_id
  ) SELECT array_agg(id ORDER BY id COLLATE "C") INTO closure_subjects FROM (SELECT id FROM closure LIMIT 129) bounded;
  IF cardinality(closure_subjects)>128 THEN
   RAISE EXCEPTION 'Review basis exceeds its subject bound' USING ERRCODE='23514';
  END IF;
  SELECT array_agg(id ORDER BY id COLLATE "C") INTO missing_subjects FROM unnest(closure_subjects) id WHERE NOT(id=ANY(locked_subjects));
  EXIT WHEN missing_subjects IS NULL;
  PERFORM 1 FROM subjects WHERE tenant_id=NEW.tenant_id AND id=ANY(missing_subjects) ORDER BY id COLLATE "C" FOR UPDATE;
  GET DIAGNOSTICS observed_count=ROW_COUNT;
  IF observed_count<>cardinality(missing_subjects) THEN
   RAISE EXCEPTION 'Review basis contains an unavailable subject' USING ERRCODE='23514';
  END IF;
  locked_subjects:=locked_subjects||missing_subjects;
 END LOOP;
 SELECT count(*) INTO observed_count FROM (SELECT 1 FROM subject_dependencies WHERE tenant_id=NEW.tenant_id AND subject_id=ANY(closure_subjects) LIMIT 257) bounded;
 IF observed_count>256 THEN RAISE EXCEPTION 'Review basis exceeds its edge bound' USING ERRCODE='23514'; END IF;
 SELECT count(*) INTO observed_count FROM (SELECT 1 FROM subject_stream_dependencies WHERE tenant_id=NEW.tenant_id AND subject_id=ANY(closure_subjects) AND event_id<>NEW.id LIMIT 513) bounded;
 IF observed_count>512 THEN RAISE EXCEPTION 'Review basis exceeds its frontier bound' USING ERRCODE='23514'; END IF;
 retained_manifest:=NEW.record#>'{basisManifest,manifest}';
 SELECT e.stream_id,e.stream_sequence INTO event_stream,event_sequence FROM journal_events e WHERE e.tenant_id=NEW.tenant_id AND e.id=NEW.id;
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
  RAISE EXCEPTION 'The complete review dependency basis changed before commit' USING ERRCODE='40001';
 END IF;
 SELECT jsonb_agg(jsonb_build_object('flightId',id,'revision',revision,'basisRevision',basis_revision) ORDER BY id COLLATE "C")
 INTO current_flights FROM flight_views WHERE tenant_id=NEW.tenant_id AND id=ANY(protected_flights);
 IF NEW.record#>'{basisManifest,flights}' IS DISTINCT FROM current_flights THEN
  RAISE EXCEPTION 'A protected flight changed before the review committed' USING ERRCODE='40001';
 END IF;
 IF NEW.record->'basisManifest' IS DISTINCT FROM jsonb_build_object(
  'version','control.effectiveness-review-basis.2','hazard',jsonb_build_object('id',NEW.hazard_id,'revision',NEW.accepted_basis_revision),
  'organizationId',NEW.organization_id,'calculation',jsonb_build_object('id',NEW.calculation_id,'digest',NEW.calculation_digest),
  'monitoring',jsonb_build_object('id',NEW.monitoring_id,'digest',NEW.monitoring_digest),'control',NEW.record->'control',
  'flights',current_flights,'manifest',current_manifest) THEN
  RAISE EXCEPTION 'Review must retain its exact full basis preimage' USING ERRCODE='23514';
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
 expected_cut:=jsonb_build_object('streams',rendered_streams,'basisRevision',NEW.accepted_basis_revision,'principalRevision',author.revision);
 IF NEW.record->'renderedInputCut' IS DISTINCT FROM expected_cut
  OR NEW.record->'acceptedInputCut' IS DISTINCT FROM jsonb_build_object('streams',accepted_streams,'basisRevision',NEW.accepted_basis_revision,'principalRevision',author.revision) THEN
  RAISE EXCEPTION 'Review cuts must retain every rendered and accepted dependency' USING ERRCODE='23514';
 END IF;
 SELECT c.payload INTO original_command FROM command_records c JOIN journal_events e ON e.tenant_id=c.tenant_id AND e.id=c.id
 JOIN streams s ON s.tenant_id=e.tenant_id AND s.id=e.stream_id JOIN decisions d ON d.tenant_id=c.tenant_id AND d.id=c.id
 WHERE c.tenant_id=NEW.tenant_id AND c.id=NEW.id AND c.kind='decision.record' AND c.flight_id IS NULL
  AND c.actor_id=NEW.actor_id AND c.recorded_at=NEW.recorded_at
  AND e.event_type='decision.record' AND e.schema_version=1 AND e.principal_id=NEW.actor_id AND e.received_at=NEW.recorded_at
  AND e.causation_id=NEW.calculation_id AND e.source_id IS NULL AND e.source_session_id IS NULL
  AND e.artifact_id IS NULL AND e.occurred_at IS NULL AND e.effective_at IS NULL AND s.name='hazard:'||NEW.hazard_id
  AND octet_length(e.payload::text)<=524288 AND octet_length(c.payload::text)<=524288
  AND e.payload=c.payload||jsonb_build_object('acceptance',NEW.record-ARRAY['id','recordedAt'],'declaredSubjects',to_jsonb(declared_subjects))
  AND d.subject_id=NEW.hazard_id AND d.flight_id IS NULL AND d.adoption_id IS NULL
  AND d.actor_id=NEW.actor_id AND d.kind='control.effectiveness-review' AND d.recorded_at=NEW.recorded_at
  AND d.accepted_revision=NEW.accepted_revision AND d.accepted_basis_revision=NEW.accepted_basis_revision
  AND d.record=NEW.record AND d.note=NEW.record#>>'{decision,note}'
  AND d.rendered_input_cut=NEW.record->'renderedInputCut' AND d.accepted_input_cut=NEW.record->'acceptedInputCut';
 IF NOT FOUND OR original_command IS DISTINCT FROM jsonb_build_object(
  'kind','decision.record','hazardId',NEW.hazard_id,'subject',jsonb_build_object('kind','hazard','id',NEW.hazard_id),
  'control',NEW.record->'control','calculation',jsonb_build_object('id',NEW.calculation_id,'digest',NEW.calculation_digest),
  'decision',NEW.record->'decision','expectedRevision',NEW.accepted_basis_revision,'inputCut',NEW.record->'renderedInputCut',
  'expectedDependencyBasis',NEW.dependency_basis) THEN
  RAISE EXCEPTION 'Review must equal its original command, journal and decision' USING ERRCODE='23514';
 END IF;
 IF TG_WHEN='AFTER' AND EXISTS(SELECT 1 FROM unnest(declared_subjects) id WHERE NOT EXISTS(
  SELECT 1 FROM subject_stream_dependencies d WHERE d.tenant_id=NEW.tenant_id AND d.subject_id=id
   AND d.stream_id=event_stream AND d.sequence=event_sequence AND d.event_id=NEW.id)) THEN
  RAISE EXCEPTION 'Review must retain its evidence frontier for every declared subject' USING ERRCODE='23514';
 END IF;
 SELECT octet_length(payload::text) INTO observed_count FROM journal_events WHERE tenant_id=NEW.tenant_id AND id=NEW.calculation_id;
 IF observed_count IS NULL OR observed_count>4194304 THEN
  RAISE EXCEPTION 'Review calculation history exceeds its retained bound' USING ERRCODE='23514';
 END IF;
 SELECT payload->'selection' INTO calculation_selection FROM journal_events WHERE tenant_id=NEW.tenant_id AND id=NEW.calculation_id;
 WITH scopes AS MATERIALIZED(
  SELECT entry->>'c2SourceId' AS source_id,entry->>'c2SourceSessionId' AS session_id FROM jsonb_array_elements(monitoring.record#>'{source,flights}') entry
 ), selected AS MATERIALIZED(
  SELECT candidate.id FROM scopes scope CROSS JOIN LATERAL(
   SELECT id,occurred_at FROM journal_events e WHERE e.tenant_id=NEW.tenant_id AND e.source_id=scope.source_id
    AND e.source_session_id=scope.session_id AND e.occurred_at<(monitoring.record#>>'{source,window,end}')::timestamptz
    AND e.event_type IN ('command-link.baseline','command-link.status') ORDER BY e.occurred_at,e.id COLLATE "C" LIMIT 129
  ) candidate ORDER BY candidate.occurred_at,candidate.id COLLATE "C" LIMIT 129
 ) SELECT array_agg(id ORDER BY id COLLATE "C") INTO selected_ids FROM selected;
 SELECT array_agg(entry->>'eventId' ORDER BY entry->>'eventId' COLLATE "C") INTO retained_ids
 FROM jsonb_array_elements(calculation_selection->'evidence') entry;
 IF calculation_selection->'complete' IS DISTINCT FROM 'true'::jsonb OR cardinality(selected_ids)>128
  OR selected_ids IS DISTINCT FROM retained_ids THEN
  RAISE EXCEPTION 'Command-link evidence changed; refresh the calculation and review context' USING ERRCODE='40001';
 END IF;
 FOR selected_record IN SELECT value FROM jsonb_array_elements(calculation_selection->'evidence') LOOP
  PERFORM 1 FROM journal_events e JOIN command_link_source_events c ON c.tenant_id=e.tenant_id AND c.event_id=e.id
  JOIN command_link_sessions session ON session.tenant_id=e.tenant_id AND session.source_id=e.source_id AND session.source_session_id=e.source_session_id
  JOIN artifacts a ON a.tenant_id=e.tenant_id AND a.id=e.artifact_id
  JOIN work_items w ON w.tenant_id=e.tenant_id AND w.event_id=e.id
  JOIN projection_offsets p ON p.tenant_id=e.tenant_id AND p.stream_id=e.stream_id
  WHERE e.tenant_id=NEW.tenant_id AND e.id=selected_record.value->>'eventId'
   AND e.event_type=selected_record.value->>'kind' AND e.source_id=selected_record.value->>'sourceId' AND e.source_session_id=selected_record.value->>'sourceSessionId'
   AND c.source_event_id=selected_record.value->>'sourceEventId' AND c.receipt_id=selected_record.value->>'receiptId'
   AND c.flight_id=selected_record.value->>'flightId' AND c.aircraft_id=selected_record.value->>'aircraftId'
   AND session.flight_id=c.flight_id AND session.aircraft_id=c.aircraft_id AND c.content_digest=selected_record.value->>'contentDigest'
   AND a.id=selected_record.value#>>'{original,artifactId}' AND a.sha256=selected_record.value#>>'{original,sha256}'
   AND a.byte_length=(selected_record.value#>>'{original,byteLength}')::integer
   AND w.state='completed' AND p.sequence>=e.stream_sequence
   AND selected_record.value->>'processing'='completed' AND selected_record.value->'projected'='true'::jsonb
   AND (e.event_type='command-link.baseline' OR EXISTS(SELECT 1 FROM timeline_items t WHERE t.tenant_id=e.tenant_id AND t.flight_id=c.flight_id AND t.id=e.id));
  IF NOT FOUND THEN RAISE EXCEPTION 'Selected command-link evidence is no longer complete' USING ERRCODE='40001'; END IF;
 END LOOP;
 FOR selected_record IN SELECT value FROM jsonb_array_elements(calculation_selection->'references') LOOP
  PERFORM 1 FROM journal_events e JOIN work_items w ON w.tenant_id=e.tenant_id AND w.event_id=e.id
  JOIN projection_offsets p ON p.tenant_id=e.tenant_id AND p.stream_id=e.stream_id
  WHERE e.tenant_id=NEW.tenant_id AND e.id=selected_record.value->>'id' AND w.state='completed' AND p.sequence>=e.stream_sequence
   AND selected_record.value->>'processing'='completed' AND selected_record.value->'projected'='true'::jsonb;
  IF NOT FOUND THEN RAISE EXCEPTION 'A calculation prerequisite is no longer complete' USING ERRCODE='40001'; END IF;
 END LOOP;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ledger_check_effectiveness_review_basis() FROM PUBLIC,ledger_app;
CREATE TRIGGER effectiveness_review_acceptance BEFORE INSERT ON hazard_effectiveness_reviews
 FOR EACH ROW EXECUTE FUNCTION ledger_check_effectiveness_review_basis();
CREATE CONSTRAINT TRIGGER effectiveness_review_commit_basis AFTER INSERT ON hazard_effectiveness_reviews
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_effectiveness_review_basis();

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['hazard_effectiveness_reviews','hazard_effectiveness_review_projections'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_scope ON %I USING(tenant_id=current_setting(''ledger.tenant_id'',true)) WITH CHECK(tenant_id=current_setting(''ledger.tenant_id'',true))',t);
  EXECUTE format('GRANT SELECT ON %I TO ledger_app',t);
  EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION ledger_forbid_history_mutation()',t);
 END LOOP;
END $$;
GRANT INSERT ON hazard_effectiveness_reviews TO ledger_app;
GRANT INSERT ON hazard_effectiveness_review_projections TO ledger_worker;
