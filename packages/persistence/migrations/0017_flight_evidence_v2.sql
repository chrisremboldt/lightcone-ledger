ALTER TABLE export_records DROP CONSTRAINT exports_format_target;
ALTER TABLE export_records ADD CONSTRAINT exports_format_target CHECK(
 (format IN ('ledger.decision-evidence.1','ledger.flight-evidence.2') AND flight_id IS NOT NULL AND subject_id IS NULL)
 OR (format='ledger.subject-evidence.2' AND subject_id IS NOT NULL AND flight_id IS NULL)
);
