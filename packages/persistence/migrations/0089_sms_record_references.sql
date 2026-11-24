-- The organization's own id for a safety record, such as H-001, set once when the record is opened. A second import
-- of the same file finds it and opens nothing twice.
ALTER TABLE sms_records ADD COLUMN reference text
 CHECK(reference IS NULL OR (length(reference) BETWEEN 1 AND 80 AND reference ~ '^\S(.*\S)?$'));
CREATE UNIQUE INDEX sms_record_references ON sms_records(tenant_id,kind,reference) WHERE reference IS NOT NULL;
