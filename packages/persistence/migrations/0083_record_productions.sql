-- Records produced on request. Each production is an append-only record with its own journal event; the .zip is kept
-- in object storage under archive_object_key and checked against archive_sha256 and byte_length whenever it is read.
CREATE TABLE record_productions (
 id text PRIMARY KEY,tenant_id text NOT NULL,
 format text NOT NULL CHECK(format='ledger.record-production.1'),event_id text NOT NULL,
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200),
 produced_by text NOT NULL,produced_at timestamptz NOT NULL,
 archive_object_key text NOT NULL UNIQUE,object_version text,
 archive_sha256 text NOT NULL CHECK(archive_sha256 ~ '^[0-9a-f]{64}$'),
 manifest_sha256 text NOT NULL CHECK(manifest_sha256 ~ '^[0-9a-f]{64}$'),
 byte_length integer NOT NULL CHECK(byte_length>0 AND byte_length<=100663296),
 record_count integer NOT NULL CHECK(record_count>=0),
 metadata jsonb NOT NULL CHECK(jsonb_typeof(metadata)='object'),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,idempotency_key),UNIQUE(tenant_id,event_id),
 FOREIGN KEY(tenant_id,event_id) REFERENCES journal_events(tenant_id,id),
 FOREIGN KEY(tenant_id,produced_by) REFERENCES principals(tenant_id,id)
);
CREATE INDEX record_production_listing ON record_productions(tenant_id,produced_at DESC,id DESC);
ALTER TABLE record_productions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON record_productions
 USING(tenant_id=current_setting('ledger.tenant_id',true)) WITH CHECK(tenant_id=current_setting('ledger.tenant_id',true));
CREATE TRIGGER immutable_record_productions BEFORE UPDATE OR DELETE ON record_productions
 FOR EACH ROW EXECUTE FUNCTION ledger_forbid_history_mutation();
GRANT SELECT,INSERT ON record_productions TO ledger_app;

-- Records are read by source and time, newest first, for a subject's file and for a production.
CREATE INDEX operator_records_by_time ON observations(tenant_id,source_id,span_start DESC,id DESC)
 WHERE observation_type='operator.record';
