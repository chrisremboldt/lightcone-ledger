-- Safety assurance records (docs/design/assurance-records.md): a safety record of kind 'assurance', signed with
-- 'assurance.sign', whose actions are closed with 'action.close'. A hazard can be opened from a finding or an action
-- of one, and keeps that origin. Nothing recorded is rewritten.
ALTER TABLE sms_records DROP CONSTRAINT sms_records_kind_check;
ALTER TABLE sms_records ADD CONSTRAINT sms_records_kind_check CHECK(kind IN
 ('hazard','risk_matrix','document','report','control','assurance','change','investigation','action','audit',
  'training','indicator','review'));

ALTER TABLE decisions DROP CONSTRAINT decisions_target;
ALTER TABLE decisions ADD CONSTRAINT decisions_target CHECK(
 (flight_id IS NOT NULL AND subject_id IS NULL AND adoption_id IS NULL AND accepted_revision IS NULL AND record IS NULL)
 OR (flight_id IS NULL AND subject_id IS NOT NULL AND adoption_id IS NOT NULL AND accepted_revision IS NOT NULL
  AND accepted_revision>0 AND record IS NOT NULL AND jsonb_typeof(record)='object' AND kind='adoption.review')
 OR (flight_id IS NULL AND subject_id IS NOT NULL AND adoption_id IS NULL AND accepted_revision IS NOT NULL
  AND accepted_revision>0 AND record IS NOT NULL AND jsonb_typeof(record)='object'
  AND kind IN ('risk.assess','risk.accept','matrix.adopt','document.adopt','document.review','document.issue',
   'document.distribute','document.withdraw','document.periodic-review','assurance.sign','action.close',
   'record.close','record.reopen')
  AND record->>'version' IS NOT DISTINCT FROM 'sms.decision.1'
  AND record->>'subjectId' IS NOT DISTINCT FROM subject_id
  AND record->>'kind' IS NOT DISTINCT FROM kind)
);

-- An assurance origin names the record and version a hazard was opened from, and the finding or action in it.
ALTER TABLE sms_hazard_origins ADD COLUMN assurance_record_id text,
 ADD COLUMN assurance_version_number integer CHECK(assurance_version_number>0),
 ADD FOREIGN KEY(tenant_id,assurance_record_id) REFERENCES sms_records(tenant_id,id);
ALTER TABLE sms_hazard_origins DROP CONSTRAINT sms_hazard_origins_kind_check;
ALTER TABLE sms_hazard_origins ADD CONSTRAINT sms_hazard_origins_kind_check
 CHECK(kind IN ('finding','report','assurance','manual'));
-- 0050 left two unnamed checks: sms_hazard_origins_check (the origin is an object of the row's kind) stays, and
-- sms_hazard_origins_check1 (the columns each kind fills) is replaced.
ALTER TABLE sms_hazard_origins DROP CONSTRAINT sms_hazard_origins_check1;
ALTER TABLE sms_hazard_origins ADD CONSTRAINT sms_hazard_origins_columns CHECK(
 (kind='finding' AND finding_id IS NOT NULL AND subject_key IS NOT NULL AND evaluation_digest IS NOT NULL
  AND (flight_evaluation_id IS NULL)<>(rule_evaluation_id IS NULL)
  AND (flight_id IS NOT NULL)=(flight_evaluation_id IS NOT NULL)
  AND report_record_id IS NULL AND report_version_number IS NULL
  AND assurance_record_id IS NULL AND assurance_version_number IS NULL
  AND origin->>'findingId' IS NOT DISTINCT FROM finding_id
  AND origin->>'evaluationId' IS NOT DISTINCT FROM COALESCE(flight_evaluation_id,rule_evaluation_id)
  AND origin->>'evaluationDigest' IS NOT DISTINCT FROM evaluation_digest)
 OR (kind='report' AND report_record_id IS NOT NULL AND report_version_number IS NOT NULL
  AND finding_id IS NULL AND flight_id IS NULL AND subject_key IS NULL AND flight_evaluation_id IS NULL
  AND rule_evaluation_id IS NULL AND evaluation_digest IS NULL
  AND assurance_record_id IS NULL AND assurance_version_number IS NULL
  AND origin->>'recordId' IS NOT DISTINCT FROM report_record_id)
 OR (kind='assurance' AND assurance_record_id IS NOT NULL AND assurance_version_number IS NOT NULL
  AND finding_id IS NULL AND flight_id IS NULL AND subject_key IS NULL AND flight_evaluation_id IS NULL
  AND rule_evaluation_id IS NULL AND evaluation_digest IS NULL
  AND report_record_id IS NULL AND report_version_number IS NULL
  AND origin->>'recordId' IS NOT DISTINCT FROM assurance_record_id
  AND (origin->>'versionNumber')::integer IS NOT DISTINCT FROM assurance_version_number
  AND origin#>>'{item,kind}' IN ('finding','action') AND origin#>>'{item,id}' IS NOT NULL)
 OR (kind='manual' AND finding_id IS NULL AND flight_id IS NULL AND subject_key IS NULL
  AND flight_evaluation_id IS NULL AND rule_evaluation_id IS NULL AND evaluation_digest IS NULL
  AND report_record_id IS NULL AND report_version_number IS NULL
  AND assurance_record_id IS NULL AND assurance_version_number IS NULL)
);
CREATE INDEX sms_hazard_origin_assurance ON sms_hazard_origins(tenant_id,assurance_record_id)
 WHERE assurance_record_id IS NOT NULL;
