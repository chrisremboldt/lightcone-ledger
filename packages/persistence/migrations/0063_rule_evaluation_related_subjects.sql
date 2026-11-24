-- Fan-out and reads about a related subject (docs/design/fan-out-and-related-reads.md).

-- One row per reference field of an accepted observation, written at intake in the same transaction. Which fields
-- are references comes from the observation registry, so a backfill of earlier observations is a command, not SQL.
-- reference_key is the subject reference key of the reference as written; a source reference is the referencing
-- observation's source's own id.
CREATE TABLE observation_references (
 tenant_id text NOT NULL,observation_id text NOT NULL,
 field text NOT NULL CHECK(length(field) BETWEEN 1 AND 400),
 reference_kind text NOT NULL CHECK(length(reference_kind) BETWEEN 1 AND 100),
 reference_scope text NOT NULL CHECK(reference_scope IN ('ledger','source')),
 reference_id text NOT NULL CHECK(length(reference_id) BETWEEN 1 AND 200),
 reference_source_id text,
 reference_key text NOT NULL CHECK(length(reference_key) BETWEEN 1 AND 1000),
 PRIMARY KEY(tenant_id,observation_id,field),
 FOREIGN KEY(tenant_id,observation_id) REFERENCES observations(tenant_id,id),
 CHECK((reference_scope='source')=(reference_source_id IS NOT NULL))
);
CREATE INDEX observation_references_by_key ON observation_references(tenant_id,reference_key,field);
CREATE INDEX observation_references_by_source_identity ON observation_references
 (tenant_id,reference_source_id,reference_kind,reference_id) WHERE reference_scope='source';
ALTER TABLE observation_references ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON observation_references USING(tenant_id=current_setting('ledger.tenant_id',true))
 WITH CHECK(tenant_id=current_setting('ledger.tenant_id',true));
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON observation_references
 FOR EACH ROW EXECUTE FUNCTION ledger_forbid_history_mutation();
GRANT SELECT,INSERT ON observation_references TO ledger_app;
GRANT SELECT ON observation_references TO ledger_worker;

-- A result for one related subject of the evaluated subject. related_key is '' for a result about the subject
-- itself, so every existing evaluation and finding keeps its row and id. A constant default writes no rows, so the
-- immutable-history trigger does not fire.
ALTER TABLE rule_evaluations
 ADD COLUMN related_key text NOT NULL DEFAULT '' CHECK(length(related_key)<=1000),
 ADD COLUMN related_name text,ADD COLUMN related_scope text CHECK(related_scope IN ('ledger','source')),
 ADD COLUMN related_kind text,ADD COLUMN related_id text,ADD COLUMN related_source_id text,
 ADD CONSTRAINT rule_evaluations_related CHECK((related_key='')=(related_scope IS NULL)
  AND (related_key='')=(related_name IS NULL) AND (related_key='')=(related_kind IS NULL)
  AND (related_key='')=(related_id IS NULL) AND (related_scope IS NOT DISTINCT FROM 'source')=(related_source_id IS NOT NULL)
  AND COALESCE(record->'related'->>'subjectKey','')=related_key);
DO $$ DECLARE c text; BEGIN
 SELECT conname INTO STRICT c FROM pg_constraint WHERE conrelid='rule_evaluations'::regclass AND contype='u'
  AND pg_get_constraintdef(oid)='UNIQUE (tenant_id, subject_key, pack_id, leaf_id, leaf_version, input_digest)';
 EXECUTE format('ALTER TABLE rule_evaluations DROP CONSTRAINT %I',c);
END $$;
ALTER TABLE rule_evaluations ADD CONSTRAINT rule_evaluations_inputs_once
 UNIQUE(tenant_id,subject_key,pack_id,leaf_id,leaf_version,related_key,input_digest);
DROP INDEX rule_evaluations_by_inputs;
CREATE INDEX rule_evaluations_by_inputs ON rule_evaluations
 (tenant_id,subject_key,pack_id,leaf_id,related_key,leaf_version,observation_digest,recorded_at DESC);
CREATE INDEX rule_evaluations_by_related ON rule_evaluations(tenant_id,related_key,recorded_at DESC,id DESC)
 WHERE related_key<>'';

ALTER TABLE findings
 ADD COLUMN related_key text NOT NULL DEFAULT '' CHECK(length(related_key)<=1000),
 ADD COLUMN related_name text,ADD COLUMN related_scope text CHECK(related_scope IN ('ledger','source')),
 ADD COLUMN related_kind text,ADD COLUMN related_id text,ADD COLUMN related_source_id text,
 ADD CONSTRAINT findings_related CHECK((related_key='')=(related_scope IS NULL)
  AND (related_key='')=(related_name IS NULL) AND (related_key='')=(related_kind IS NULL)
  AND (related_key='')=(related_id IS NULL) AND (related_scope IS NOT DISTINCT FROM 'source')=(related_source_id IS NOT NULL)
  AND (subject_key IS NOT NULL OR related_key=''));
DROP INDEX findings_by_subject_rule;
CREATE UNIQUE INDEX findings_by_subject_rule ON findings(tenant_id,subject_key,pack_id,leaf_id,related_key)
 WHERE subject_key IS NOT NULL;
CREATE INDEX findings_by_related ON findings(tenant_id,related_key) WHERE related_key<>'';

ALTER TABLE finding_views ADD COLUMN related_key text NOT NULL DEFAULT '' CHECK(length(related_key)<=1000);
CREATE INDEX finding_views_by_related ON finding_views(tenant_id,related_key) WHERE related_key<>'';

-- Re-queueing the targets that name a related subject goes a page at a time: the event that names the subject
-- queues the first page, and a 'related' work row carries the position from which a worker queues the next one, so
-- one event never holds a long transaction. Its subject is the related subject; it evaluates nothing itself.
ALTER TABLE rule_evaluation_work DROP CONSTRAINT rule_evaluation_work_trigger_kind_check,
 ADD CONSTRAINT rule_evaluation_work_trigger_kind_check
  CHECK(trigger_kind IN ('observation','deadline','state','correction','adoption','related')),
 ADD COLUMN continuation jsonb,
 ADD CONSTRAINT rule_evaluation_work_continuation CHECK((trigger_kind='related')=(continuation IS NOT NULL)
  AND (continuation IS NULL OR jsonb_typeof(continuation)='object'));
CREATE UNIQUE INDEX rule_evaluation_work_related ON rule_evaluation_work
 (tenant_id,trigger_event_id,subject_key,pack_id,leaf_id,(continuation->>'relation'),(continuation->>'after'))
 WHERE trigger_kind='related';
