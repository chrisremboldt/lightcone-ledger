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
  AND kind IN ('risk.assess','risk.accept','matrix.adopt','document.adopt','document.review','document.issue','document.distribute','document.acknowledge','record.close','record.reopen')
  AND record->>'version' IS NOT DISTINCT FROM 'sms.decision.1'
  AND record->>'subjectId' IS NOT DISTINCT FROM subject_id
  AND record->>'kind' IS NOT DISTINCT FROM kind)
);
