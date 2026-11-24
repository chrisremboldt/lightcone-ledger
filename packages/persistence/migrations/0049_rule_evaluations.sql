-- Generic rule evaluations: one adopted rule evaluated for one subject reference. A subject reference is a Ledger
-- subject (scope ledger) or a subject a source names by its own id that Ledger has not resolved (scope source).
-- subject_key is the reference's canonical string. Records are append-only and keyed by the input digest, so the
-- same rule version, subject and inputs are recorded once.
CREATE TABLE rule_evaluations (
 id text PRIMARY KEY,tenant_id text NOT NULL,
 subject_key text NOT NULL CHECK(length(subject_key) BETWEEN 1 AND 1000),
 subject_scope text NOT NULL CHECK(subject_scope IN ('ledger','source')),
 subject_kind text NOT NULL,subject_id text NOT NULL,subject_source_id text,
 subject_ledger_id text GENERATED ALWAYS AS (CASE WHEN subject_scope='ledger' THEN subject_id END) STORED,
 organization_id text NOT NULL,adoption_id text NOT NULL,
 pack_id text NOT NULL,pack_version integer NOT NULL,leaf_id text NOT NULL,leaf_version integer NOT NULL,
 leaf_digest text NOT NULL CHECK(leaf_digest ~ '^[a-f0-9]{64}$'),
 check_kind text NOT NULL,check_version integer NOT NULL,
 check_digest text NOT NULL CHECK(check_digest ~ '^[a-f0-9]{64}$'),
 observation_digest text NOT NULL CHECK(observation_digest ~ '^[a-f0-9]{64}$'),
 input_digest text NOT NULL CHECK(input_digest ~ '^[a-f0-9]{64}$'),
 evidence_state text NOT NULL CHECK(evidence_state IN ('supported','insufficient','conflicting','not_applicable')),
 outcome text NOT NULL CHECK(outcome IN ('pass','attention','pending','not_applicable')),
 evaluated_at timestamptz NOT NULL,next_boundary timestamptz,recorded_at timestamptz NOT NULL,
 record jsonb NOT NULL,
 CHECK((subject_scope='source')=(subject_source_id IS NOT NULL)),
 CHECK(next_boundary IS NULL OR next_boundary>evaluated_at),
 CHECK(jsonb_typeof(record)='object' AND record->>'id' IS NOT DISTINCT FROM id
  AND record->>'subjectKey' IS NOT DISTINCT FROM subject_key
  AND record->>'inputDigest' IS NOT DISTINCT FROM input_digest
  AND record->>'outcome' IS NOT DISTINCT FROM outcome
  AND record->>'evidenceState' IS NOT DISTINCT FROM evidence_state),
 UNIQUE(tenant_id,id),
 UNIQUE(tenant_id,subject_key,pack_id,leaf_id,leaf_version,input_digest),
 FOREIGN KEY(tenant_id,id) REFERENCES journal_events(tenant_id,id),
 FOREIGN KEY(tenant_id,subject_ledger_id) REFERENCES subjects(tenant_id,id),
 FOREIGN KEY(tenant_id,organization_id) REFERENCES organizations(tenant_id,id),
 FOREIGN KEY(tenant_id,adoption_id) REFERENCES organization_pack_adoptions(tenant_id,id)
);
CREATE INDEX rule_evaluations_by_subject ON rule_evaluations(tenant_id,subject_key,recorded_at DESC,id DESC);
CREATE INDEX rule_evaluations_by_inputs ON rule_evaluations
 (tenant_id,subject_key,pack_id,leaf_id,leaf_version,observation_digest,recorded_at DESC);

-- Work for the generic evaluator: an accepted observation a rule reads, or a boundary at which a recorded answer
-- could change. Leased and fenced like the other worker queues.
CREATE TABLE rule_evaluation_work (
 id text PRIMARY KEY,tenant_id text NOT NULL,
 subject_key text NOT NULL CHECK(length(subject_key) BETWEEN 1 AND 1000),
 subject_scope text NOT NULL CHECK(subject_scope IN ('ledger','source')),
 subject_kind text NOT NULL,subject_id text NOT NULL,subject_source_id text,
 pack_id text NOT NULL,leaf_id text NOT NULL,
 trigger_kind text NOT NULL CHECK(trigger_kind IN ('observation','deadline')),
 trigger_event_id text NOT NULL,due_at timestamptz NOT NULL,available_at timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','leased','completed','failed')),
 generation bigint NOT NULL DEFAULT 0,lease_owner text,lease_until timestamptz,
 attempts integer NOT NULL DEFAULT 0,error text,completed_at timestamptz,
 CHECK((subject_scope='source')=(subject_source_id IS NOT NULL)),
 FOREIGN KEY(tenant_id,trigger_event_id) REFERENCES journal_events(tenant_id,id)
);
CREATE UNIQUE INDEX rule_evaluation_work_observation ON rule_evaluation_work
 (tenant_id,trigger_event_id,subject_key,pack_id,leaf_id) WHERE trigger_kind='observation';
CREATE UNIQUE INDEX rule_evaluation_work_deadline ON rule_evaluation_work
 (tenant_id,subject_key,pack_id,leaf_id,due_at) WHERE trigger_kind='deadline';
CREATE INDEX rule_evaluation_work_ready ON rule_evaluation_work(state,available_at,lease_until);

-- One finding concept: a finding belongs either to a flight and a flight evaluation (as before), or to a subject
-- reference and a rule evaluation.
ALTER TABLE findings
 ALTER COLUMN flight_id DROP NOT NULL,
 ALTER COLUMN initial_evaluation_id DROP NOT NULL,
 ADD COLUMN subject_key text,ADD COLUMN subject_scope text,ADD COLUMN subject_kind text,ADD COLUMN subject_id text,
 ADD COLUMN subject_source_id text,ADD COLUMN pack_id text,ADD COLUMN initial_rule_evaluation_id text,
 ADD CONSTRAINT findings_initial_rule_evaluation FOREIGN KEY(tenant_id,initial_rule_evaluation_id)
  REFERENCES rule_evaluations(tenant_id,id),
 ADD CONSTRAINT findings_origin CHECK(
  (subject_key IS NULL AND flight_id IS NOT NULL AND initial_evaluation_id IS NOT NULL
   AND initial_rule_evaluation_id IS NULL AND subject_scope IS NULL AND subject_kind IS NULL AND subject_id IS NULL
   AND subject_source_id IS NULL AND pack_id IS NULL)
  OR (subject_key IS NOT NULL AND flight_id IS NULL AND initial_evaluation_id IS NULL
   AND initial_rule_evaluation_id IS NOT NULL AND subject_scope IN ('ledger','source') AND subject_kind IS NOT NULL
   AND subject_id IS NOT NULL AND pack_id IS NOT NULL AND (subject_scope='source')=(subject_source_id IS NOT NULL)));
CREATE UNIQUE INDEX findings_by_subject_rule ON findings(tenant_id,subject_key,pack_id,leaf_id) WHERE subject_key IS NOT NULL;

ALTER TABLE finding_views
 ALTER COLUMN flight_id DROP NOT NULL,
 ALTER COLUMN latest_evaluation_id DROP NOT NULL,
 ADD COLUMN subject_key text,ADD COLUMN latest_rule_evaluation_id text,
 ADD CONSTRAINT finding_views_latest_rule_evaluation FOREIGN KEY(tenant_id,latest_rule_evaluation_id)
  REFERENCES rule_evaluations(tenant_id,id),
 ADD CONSTRAINT finding_views_origin CHECK(
  (subject_key IS NULL AND flight_id IS NOT NULL AND latest_evaluation_id IS NOT NULL AND latest_rule_evaluation_id IS NULL)
  OR (subject_key IS NOT NULL AND flight_id IS NULL AND latest_evaluation_id IS NULL AND latest_rule_evaluation_id IS NOT NULL));
CREATE INDEX finding_views_by_subject ON finding_views(tenant_id,subject_key) WHERE subject_key IS NOT NULL;

ALTER TABLE finding_treatments
 ALTER COLUMN evaluation_id DROP NOT NULL,
 ADD COLUMN rule_evaluation_id text,
 ADD CONSTRAINT finding_treatments_rule_evaluation FOREIGN KEY(tenant_id,rule_evaluation_id)
  REFERENCES rule_evaluations(tenant_id,id),
 ADD CONSTRAINT finding_treatments_one_evaluation CHECK((evaluation_id IS NULL)<>(rule_evaluation_id IS NULL));

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['rule_evaluations','rule_evaluation_work'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON %I USING(tenant_id=current_setting(''ledger.tenant_id'',true)) WITH CHECK(tenant_id=current_setting(''ledger.tenant_id'',true))',t);
 END LOOP;
END $$;
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON rule_evaluations
 FOR EACH ROW EXECUTE FUNCTION ledger_forbid_history_mutation();
GRANT SELECT ON rule_evaluations TO ledger_app;
GRANT INSERT ON rule_evaluations TO ledger_worker;
GRANT SELECT,INSERT,UPDATE ON rule_evaluation_work TO ledger_worker;

CREATE FUNCTION ledger_lease_rule_evaluations(p_owner text,p_limit integer,p_seconds integer)
RETURNS TABLE(id text,tenant_id text,subject_key text,subject_scope text,subject_kind text,subject_id text,
 subject_source_id text,pack_id text,leaf_id text,trigger_kind text,trigger_event_id text,due_at timestamptz,
 available_at timestamptz,state text,generation bigint,lease_owner text,lease_until timestamptz,attempts integer,
 error text,completed_at timestamptz,worker_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN RETURN QUERY WITH candidates AS (
 SELECT w.id FROM rule_evaluation_work w
 WHERE ((w.state='pending' AND w.available_at<=clock_timestamp() AND w.due_at<=clock_timestamp())
  OR (w.state='leased' AND w.lease_until<clock_timestamp()))
 AND EXISTS(SELECT 1 FROM principals p WHERE p.tenant_id=w.tenant_id AND p.kind='worker' AND p.active)
 ORDER BY w.available_at,w.id FOR UPDATE SKIP LOCKED LIMIT LEAST(GREATEST(p_limit,1),100)
), leased AS (
 UPDATE rule_evaluation_work w SET state='leased',lease_owner=p_owner,
 lease_until=clock_timestamp()+make_interval(secs=>LEAST(GREATEST(p_seconds,1),300)),
 generation=w.generation+1,attempts=w.attempts+1 FROM candidates c WHERE w.id=c.id RETURNING w.*
)
SELECT l.id,l.tenant_id,l.subject_key,l.subject_scope,l.subject_kind,l.subject_id,l.subject_source_id,l.pack_id,
 l.leaf_id,l.trigger_kind,l.trigger_event_id,l.due_at,l.available_at,l.state,l.generation,l.lease_owner,
 l.lease_until,l.attempts,l.error,l.completed_at,p.id
FROM leased l JOIN LATERAL(
 SELECT principal.id FROM principals principal WHERE principal.tenant_id=l.tenant_id
 AND principal.kind='worker' AND principal.active ORDER BY principal.id LIMIT 1
)p ON true;
END $$;
REVOKE ALL ON FUNCTION ledger_lease_rule_evaluations(text,integer,integer) FROM PUBLIC,ledger_app;
GRANT EXECUTE ON FUNCTION ledger_lease_rule_evaluations(text,integer,integer) TO ledger_worker;
