CREATE TABLE decision_packet_records (
 id text PRIMARY KEY,tenant_id text NOT NULL,flight_id text NOT NULL,decision_id text NOT NULL,
 format text NOT NULL CHECK(format='ledger.decision-packet.1'),issued_by text NOT NULL,issued_at timestamptz NOT NULL,
 object_key text NOT NULL UNIQUE,object_version text,packet_sha256 text NOT NULL CHECK(packet_sha256 ~ '^[0-9a-f]{64}$'),
 manifest_digest text NOT NULL CHECK(manifest_digest ~ '^[0-9a-f]{64}$'),byte_length integer NOT NULL CHECK(byte_length>0 AND byte_length<=4194304),metadata jsonb NOT NULL,
 UNIQUE(tenant_id,id),FOREIGN KEY(tenant_id,decision_id) REFERENCES decisions(tenant_id,id),
 FOREIGN KEY(tenant_id,flight_id) REFERENCES flight_views(tenant_id,id),FOREIGN KEY(tenant_id,issued_by) REFERENCES principals(tenant_id,id)
);
CREATE INDEX decision_packet_listing ON decision_packet_records(tenant_id,issued_at DESC,id);
CREATE INDEX decision_packet_flight_listing ON decision_packet_records(tenant_id,flight_id,issued_at DESC,id);
CREATE INDEX decision_packet_decision_listing ON decision_packet_records(tenant_id,decision_id,issued_at DESC,id);
ALTER TABLE decision_packet_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON decision_packet_records
 USING(tenant_id=current_setting('ledger.tenant_id',true)) WITH CHECK(tenant_id=current_setting('ledger.tenant_id',true));
CREATE TRIGGER immutable_decision_packets BEFORE UPDATE OR DELETE ON decision_packet_records
 FOR EACH ROW EXECUTE FUNCTION ledger_forbid_history_mutation();
GRANT SELECT,INSERT ON decision_packet_records TO ledger_app;
