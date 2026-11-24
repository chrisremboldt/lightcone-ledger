ALTER TABLE decisions DROP CONSTRAINT decisions_target;
ALTER TABLE decisions ADD CONSTRAINT decisions_target CHECK(
 (flight_id IS NOT NULL AND subject_id IS NULL AND adoption_id IS NULL AND accepted_revision IS NULL AND record IS NULL)
 OR (flight_id IS NULL AND subject_id IS NOT NULL AND adoption_id IS NOT NULL AND accepted_revision IS NOT NULL
  AND accepted_revision>0 AND record IS NOT NULL AND jsonb_typeof(record)='object' AND kind='adoption.review')
 OR (flight_id IS NULL AND subject_id IS NOT NULL AND adoption_id IS NULL AND accepted_revision IS NOT NULL
  AND accepted_revision>0 AND record IS NOT NULL AND jsonb_typeof(record)='object'
  AND ((kind='risk.assess' AND record->>'version' IS NOT DISTINCT FROM 'hazard.assessment.1')
   OR (kind='risk.accept' AND record->>'version' IS NOT DISTINCT FROM 'hazard.risk-acceptance.1')
   OR (kind='control.effectiveness-review' AND record->>'version' IS NOT DISTINCT FROM 'hazard.effectiveness-review.2')
   OR (kind='hazard.disposition' AND record->>'version' IS NOT DISTINCT FROM 'hazard.disposition.1'))
  AND record->>'hazardId' IS NOT DISTINCT FROM subject_id)
);

ALTER TABLE hazard_views ADD COLUMN status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed'));
ALTER TABLE hazard_views ADD COLUMN latest_disposition_id text;

CREATE TABLE hazard_dispositions (
 id text PRIMARY KEY,tenant_id text NOT NULL,hazard_id text NOT NULL,organization_id text NOT NULL,
 accepted_revision bigint NOT NULL,accepted_basis_revision bigint NOT NULL CHECK(accepted_basis_revision>0),
 actor_id text NOT NULL,prior_status text NOT NULL CHECK(prior_status IN ('open','closed')),
 status text NOT NULL CHECK(status IN ('open','closed')),
 effectiveness_review_id text,effectiveness_review_digest text CHECK(effectiveness_review_digest ~ '^[a-f0-9]{64}$'),
 record jsonb NOT NULL CHECK(jsonb_typeof(record)='object'),record_canonical text NOT NULL,
 record_digest text NOT NULL CHECK(record_digest ~ '^[a-f0-9]{64}$'),basis_canonical text NOT NULL,
 dependency_basis text NOT NULL CHECK(dependency_basis ~ '^[a-f0-9]{64}$'),recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at)),
 CHECK(accepted_revision=accepted_basis_revision+1),
 CHECK(record_canonical::jsonb=record AND record_digest=encode(sha256(convert_to(record_canonical,'UTF8')),'hex')),
 CHECK(basis_canonical::jsonb=record->'basisManifest' AND dependency_basis=encode(sha256(convert_to(basis_canonical,'UTF8')),'hex')),
 CHECK((effectiveness_review_id IS NULL)=(effectiveness_review_digest IS NULL)),
 CHECK(record->>'version' IS NOT DISTINCT FROM 'hazard.disposition.1'
  AND record->>'id' IS NOT DISTINCT FROM id AND record->>'hazardId' IS NOT DISTINCT FROM hazard_id
  AND record->>'organizationId' IS NOT DISTINCT FROM organization_id
  AND (record->>'acceptedRevision')::bigint IS NOT DISTINCT FROM accepted_revision
  AND (record->>'acceptedBasisRevision')::bigint IS NOT DISTINCT FROM accepted_basis_revision
  AND record->>'priorStatus' IS NOT DISTINCT FROM prior_status AND record->>'status' IS NOT DISTINCT FROM status
  AND record#>>'{actor,id}' IS NOT DISTINCT FROM actor_id
  AND record->>'dependencyBasis' IS NOT DISTINCT FROM dependency_basis
  AND (record->>'recordedAt')::timestamptz IS NOT DISTINCT FROM recorded_at
  AND jsonb_typeof(record->'note') IS NOT DISTINCT FROM 'string'
  AND length(record->>'note') BETWEEN 1 AND 4000 AND record->>'note' ~ '\S'
  AND ((effectiveness_review_id IS NULL AND NOT(record ? 'effectivenessReview'))
   OR (effectiveness_review_id IS NOT NULL AND record->'effectivenessReview'=jsonb_build_object('id',effectiveness_review_id,'digest',effectiveness_review_digest)))),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,hazard_id,id),UNIQUE(tenant_id,hazard_id,accepted_revision),
 FOREIGN KEY(tenant_id,id) REFERENCES command_records(tenant_id,id),
 FOREIGN KEY(tenant_id,hazard_id,id) REFERENCES decisions(tenant_id,subject_id,id),
 FOREIGN KEY(tenant_id,hazard_id) REFERENCES hazard_views(tenant_id,id),
 FOREIGN KEY(tenant_id,organization_id) REFERENCES organizations(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES principals(tenant_id,id),
 FOREIGN KEY(tenant_id,hazard_id,effectiveness_review_id) REFERENCES hazard_effectiveness_reviews(tenant_id,hazard_id,id)
);
CREATE INDEX hazard_disposition_history ON hazard_dispositions(tenant_id,hazard_id,recorded_at DESC,id DESC);
ALTER TABLE hazard_views ADD CONSTRAINT hazard_latest_disposition
 FOREIGN KEY(tenant_id,id,latest_disposition_id) REFERENCES hazard_dispositions(tenant_id,hazard_id,id);

CREATE FUNCTION ledger_check_hazard_disposition() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
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
 IF opening.organization_id IS DISTINCT FROM NEW.organization_id OR NOT EXISTS(
  SELECT 1 FROM finding_views f JOIN flight_evaluations e ON e.tenant_id=f.tenant_id AND e.id=f.latest_evaluation_id
   AND e.flight_id=f.flight_id WHERE f.tenant_id=NEW.tenant_id AND f.id=opening.origin_finding_id
   AND f.flight_id=opening.origin_flight_id AND NEW.record#>'{evidence,evaluation}'=e.record
   AND NEW.record#>'{evidence,reference}'=jsonb_build_object('flightId',f.flight_id,'findingId',f.id,'evaluationId',e.id)) THEN
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
CREATE TRIGGER hazard_disposition_acceptance BEFORE INSERT ON hazard_dispositions FOR EACH ROW EXECUTE FUNCTION ledger_check_hazard_disposition();
CREATE CONSTRAINT TRIGGER hazard_disposition_commit AFTER INSERT ON hazard_dispositions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_hazard_disposition();

CREATE FUNCTION ledger_guard_hazard_status() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE latest hazard_dispositions%ROWTYPE;
BEGIN
 SELECT * INTO latest FROM hazard_dispositions WHERE tenant_id=NEW.tenant_id AND hazard_id=NEW.id ORDER BY accepted_revision DESC LIMIT 1;
 IF (latest.id IS NULL AND (NEW.status<>'open' OR NEW.latest_disposition_id IS NOT NULL))
  OR (latest.id IS NOT NULL AND (NEW.latest_disposition_id IS DISTINCT FROM latest.id OR NEW.status IS DISTINCT FROM latest.status OR NEW.revision<latest.accepted_revision)) THEN
  RAISE EXCEPTION 'Hazard status must follow its latest recorded disposition' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ledger_guard_hazard_status() FROM PUBLIC,ledger_app;
CREATE TRIGGER hazard_recorded_status BEFORE INSERT OR UPDATE ON hazard_views FOR EACH ROW EXECUTE FUNCTION ledger_guard_hazard_status();
ALTER TABLE hazard_dispositions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON hazard_dispositions USING(tenant_id=current_setting('ledger.tenant_id',true)) WITH CHECK(tenant_id=current_setting('ledger.tenant_id',true));
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON hazard_dispositions FOR EACH ROW EXECUTE FUNCTION ledger_forbid_history_mutation();
GRANT SELECT,INSERT ON hazard_dispositions TO ledger_app;
GRANT UPDATE(status,latest_disposition_id) ON hazard_views TO ledger_app;
