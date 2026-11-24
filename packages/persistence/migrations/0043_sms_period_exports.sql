ALTER TABLE sms_exports ALTER COLUMN record_id DROP NOT NULL;
ALTER TABLE sms_exports ADD COLUMN scope_kind text NOT NULL DEFAULT 'record_closure'
 CHECK(scope_kind IN ('record_closure','period'));
ALTER TABLE sms_exports ADD COLUMN period_from timestamptz;
ALTER TABLE sms_exports ADD COLUMN period_to timestamptz;
ALTER TABLE sms_exports ADD CONSTRAINT sms_exports_scope CHECK(
 (scope_kind='record_closure' AND record_id IS NOT NULL AND period_from IS NULL AND period_to IS NULL)
 OR (scope_kind='period' AND record_id IS NULL AND period_from<period_to)
);
