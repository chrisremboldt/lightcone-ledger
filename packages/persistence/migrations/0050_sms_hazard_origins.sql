-- Where each safety-program hazard came from, set when it is opened and never changed. A finding origin names the
-- finding, its subject and the exact evaluation its author reviewed: a flight evaluation for a flight finding, or a
-- generic rule evaluation for a subject finding. A report origin names the report version by its content digest.
-- id is the hazard's opening event. One hazard per finding evaluation.
CREATE TABLE sms_hazard_origins (
 id text PRIMARY KEY,tenant_id text NOT NULL,record_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('finding','report','manual')),
 finding_id text,flight_id text,subject_key text CHECK(length(subject_key) BETWEEN 1 AND 1000),
 flight_evaluation_id text,rule_evaluation_id text,
 evaluation_digest text CHECK(evaluation_digest ~ '^[a-f0-9]{64}$'),
 report_record_id text,report_version_number integer CHECK(report_version_number>0),
 origin jsonb NOT NULL CHECK(jsonb_typeof(origin)='object' AND origin->>'kind' IS NOT DISTINCT FROM kind),
 actor_id text NOT NULL,recorded_at timestamptz NOT NULL,
 CHECK(
  (kind='finding' AND finding_id IS NOT NULL AND subject_key IS NOT NULL AND evaluation_digest IS NOT NULL
   AND (flight_evaluation_id IS NULL)<>(rule_evaluation_id IS NULL)
   AND (flight_id IS NOT NULL)=(flight_evaluation_id IS NOT NULL)
   AND report_record_id IS NULL AND report_version_number IS NULL
   AND origin->>'findingId' IS NOT DISTINCT FROM finding_id
   AND origin->>'evaluationId' IS NOT DISTINCT FROM COALESCE(flight_evaluation_id,rule_evaluation_id)
   AND origin->>'evaluationDigest' IS NOT DISTINCT FROM evaluation_digest)
  OR (kind='report' AND report_record_id IS NOT NULL AND report_version_number IS NOT NULL
   AND finding_id IS NULL AND flight_id IS NULL AND subject_key IS NULL AND flight_evaluation_id IS NULL
   AND rule_evaluation_id IS NULL AND evaluation_digest IS NULL
   AND origin->>'recordId' IS NOT DISTINCT FROM report_record_id)
  OR (kind='manual' AND finding_id IS NULL AND flight_id IS NULL AND subject_key IS NULL
   AND flight_evaluation_id IS NULL AND rule_evaluation_id IS NULL AND evaluation_digest IS NULL
   AND report_record_id IS NULL AND report_version_number IS NULL)),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,record_id),
 FOREIGN KEY(tenant_id,id) REFERENCES journal_events(tenant_id,id),
 FOREIGN KEY(tenant_id,record_id) REFERENCES sms_records(tenant_id,id),
 FOREIGN KEY(tenant_id,finding_id) REFERENCES findings(tenant_id,id),
 FOREIGN KEY(tenant_id,flight_id) REFERENCES flight_views(tenant_id,id),
 FOREIGN KEY(tenant_id,flight_evaluation_id) REFERENCES flight_evaluations(tenant_id,id),
 FOREIGN KEY(tenant_id,rule_evaluation_id) REFERENCES rule_evaluations(tenant_id,id),
 FOREIGN KEY(tenant_id,report_record_id) REFERENCES sms_records(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES principals(tenant_id,id)
);
CREATE UNIQUE INDEX sms_hazard_origin_flight_evaluation ON sms_hazard_origins
 (tenant_id,flight_id,finding_id,flight_evaluation_id) WHERE flight_evaluation_id IS NOT NULL;
CREATE UNIQUE INDEX sms_hazard_origin_rule_evaluation ON sms_hazard_origins
 (tenant_id,subject_key,finding_id,rule_evaluation_id) WHERE rule_evaluation_id IS NOT NULL;
CREATE INDEX sms_hazard_origin_findings ON sms_hazard_origins(tenant_id,finding_id) WHERE finding_id IS NOT NULL;

ALTER TABLE sms_hazard_origins ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON sms_hazard_origins
 USING(tenant_id=current_setting('ledger.tenant_id',true))
 WITH CHECK(tenant_id=current_setting('ledger.tenant_id',true));
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON sms_hazard_origins
 FOR EACH ROW EXECUTE FUNCTION ledger_forbid_history_mutation();
GRANT SELECT,INSERT ON sms_hazard_origins TO ledger_app;

-- Every hazard opened before origins existed was identified by a person.
INSERT INTO sms_hazard_origins(id,tenant_id,record_id,kind,origin,actor_id,recorded_at)
SELECT v.id,r.tenant_id,r.id,'manual','{"kind":"manual"}'::jsonb,v.actor_id,v.recorded_at
FROM sms_records r JOIN sms_record_versions v ON v.tenant_id=r.tenant_id AND v.record_id=r.id AND v.version_number=1
WHERE r.kind='hazard';
