-- Retain the exact lexical envelope prospectively; existing immutable rows remain untouched.
ALTER TABLE journal_events ADD COLUMN immutable_envelope text;
ALTER TABLE decisions ADD CONSTRAINT decisions_tenant_identity UNIQUE(tenant_id,id);
CREATE TABLE export_records (
 id text PRIMARY KEY,tenant_id text NOT NULL REFERENCES tenants(id),decision_id text NOT NULL,flight_id text NOT NULL,issued_by text NOT NULL,
 issued_at timestamptz NOT NULL,object_key text NOT NULL UNIQUE,object_version text,
 bundle_sha256 text NOT NULL CHECK(bundle_sha256 ~ '^[0-9a-f]{64}$'),manifest_digest text NOT NULL CHECK(manifest_digest ~ '^[0-9a-f]{64}$'),
 byte_length integer NOT NULL CHECK(byte_length>0 AND byte_length<=33554432),metadata jsonb NOT NULL,UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,decision_id) REFERENCES decisions(tenant_id,id),FOREIGN KEY(tenant_id,flight_id) REFERENCES flight_views(tenant_id,id),FOREIGN KEY(tenant_id,issued_by) REFERENCES principals(tenant_id,id)
);
CREATE INDEX exports_decision_listing ON export_records(tenant_id,decision_id,issued_at DESC,id);
ALTER TABLE export_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON export_records USING(tenant_id=current_setting('ledger.tenant_id',true)) WITH CHECK(tenant_id=current_setting('ledger.tenant_id',true));
CREATE TRIGGER immutable_exports BEFORE UPDATE OR DELETE ON export_records FOR EACH ROW EXECUTE FUNCTION ledger_forbid_history_mutation();
GRANT SELECT,INSERT ON export_records TO ledger_app;
