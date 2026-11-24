-- A reader's receipt for one issued revision. It is not a change to the document, so it never advances the
-- document's revision and never makes someone else's open review, signature or issue stale.
CREATE TABLE sms_document_acknowledgements (
 id text PRIMARY KEY,tenant_id text NOT NULL,record_id text NOT NULL,issue_id text NOT NULL,recipient_id text NOT NULL,
 content_digest text NOT NULL CHECK(content_digest ~ '^[a-f0-9]{64}$'),
 record jsonb NOT NULL CHECK(jsonb_typeof(record)='object' AND octet_length(record::text)<=16384),
 recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at)),
 CHECK(record->>'version' IS NOT DISTINCT FROM 'sms.document-acknowledgement.1'
  AND record->>'id' IS NOT DISTINCT FROM id AND record->>'recordId' IS NOT DISTINCT FROM record_id
  AND record->>'issueId' IS NOT DISTINCT FROM issue_id AND record->>'contentDigest' IS NOT DISTINCT FROM content_digest
  AND record#>>'{actor,principalId}' IS NOT DISTINCT FROM recipient_id),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,issue_id,recipient_id),
 FOREIGN KEY(tenant_id,id) REFERENCES journal_events(tenant_id,id),
 FOREIGN KEY(tenant_id,record_id) REFERENCES sms_records(tenant_id,id),
 FOREIGN KEY(tenant_id,record_id,issue_id) REFERENCES decisions(tenant_id,subject_id,id),
 FOREIGN KEY(tenant_id,recipient_id) REFERENCES principals(tenant_id,id)
);
CREATE INDEX sms_document_reader_acknowledgements ON sms_document_acknowledgements(tenant_id,recipient_id);
CREATE INDEX sms_record_acknowledgements ON sms_document_acknowledgements(tenant_id,record_id,recorded_at);

ALTER TABLE sms_document_acknowledgements ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON sms_document_acknowledgements
 USING(tenant_id=current_setting('ledger.tenant_id',true))
 WITH CHECK(tenant_id=current_setting('ledger.tenant_id',true));
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON sms_document_acknowledgements
 FOR EACH ROW EXECUTE FUNCTION ledger_forbid_history_mutation();
GRANT SELECT,INSERT ON sms_document_acknowledgements TO ledger_app;

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
 OR (flight_id IS NULL AND subject_id IS NOT NULL AND adoption_id IS NULL AND accepted_revision IS NOT NULL
  AND accepted_revision>0 AND record IS NOT NULL AND jsonb_typeof(record)='object'
  AND kind IN ('risk.assess','risk.accept','matrix.adopt','document.adopt','document.review','document.issue',
   'document.distribute','document.withdraw','record.close','record.reopen')
  AND record->>'version' IS NOT DISTINCT FROM 'sms.decision.1'
  AND record->>'subjectId' IS NOT DISTINCT FROM subject_id
  AND record->>'kind' IS NOT DISTINCT FROM kind)
);
