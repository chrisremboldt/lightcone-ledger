-- Issued finding packets. Each issue is an append-only record with its own journal event; the packet bytes are kept in
-- object storage under packet_object_key and checked against packet_sha256 and byte_length whenever they are read.
CREATE TABLE finding_packet_records (
 id text PRIMARY KEY,tenant_id text NOT NULL,finding_id text NOT NULL,subject_key text NOT NULL,
 format text NOT NULL CHECK(format='ledger.finding-packet.1'),event_id text NOT NULL,
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200),
 issued_by text NOT NULL,issued_at timestamptz NOT NULL,
 packet_object_key text NOT NULL UNIQUE,object_version text,
 packet_sha256 text NOT NULL CHECK(packet_sha256 ~ '^[0-9a-f]{64}$'),
 manifest_digest text NOT NULL CHECK(manifest_digest ~ '^[0-9a-f]{64}$'),
 byte_length integer NOT NULL CHECK(byte_length>0 AND byte_length<=4194304),metadata jsonb NOT NULL,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,idempotency_key),UNIQUE(tenant_id,event_id),
 FOREIGN KEY(tenant_id,finding_id) REFERENCES findings(tenant_id,id),
 FOREIGN KEY(tenant_id,event_id) REFERENCES journal_events(tenant_id,id),
 FOREIGN KEY(tenant_id,issued_by) REFERENCES principals(tenant_id,id)
);
CREATE INDEX finding_packet_finding_listing ON finding_packet_records(tenant_id,finding_id,issued_at DESC,id DESC);
ALTER TABLE finding_packet_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON finding_packet_records
 USING(tenant_id=current_setting('ledger.tenant_id',true)) WITH CHECK(tenant_id=current_setting('ledger.tenant_id',true));
CREATE TRIGGER immutable_finding_packets BEFORE UPDATE OR DELETE ON finding_packet_records
 FOR EACH ROW EXECUTE FUNCTION ledger_forbid_history_mutation();
GRANT SELECT,INSERT ON finding_packet_records TO ledger_app;
