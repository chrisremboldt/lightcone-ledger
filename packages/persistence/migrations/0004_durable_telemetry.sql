-- Telemetry claims retain immutable segment provenance. Receipt links remain journaled separately.
CREATE TABLE telemetry_segments (
 id text PRIMARY KEY,tenant_id text NOT NULL,receipt_id text NOT NULL,event_id text NOT NULL,artifact_id text NOT NULL,
 principal_id text NOT NULL,session_id text NOT NULL,source_id text NOT NULL,source_session_id text NOT NULL,device_id text NOT NULL,
 descriptor jsonb NOT NULL,received_at timestamptz NOT NULL,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,receipt_id),
 FOREIGN KEY(tenant_id,receipt_id) REFERENCES receipts(tenant_id,id),FOREIGN KEY(tenant_id,event_id) REFERENCES journal_events(tenant_id,id),
 FOREIGN KEY(tenant_id,artifact_id) REFERENCES artifacts(tenant_id,id),FOREIGN KEY(tenant_id,principal_id) REFERENCES principals(tenant_id,id)
);
CREATE INDEX telemetry_segment_session ON telemetry_segments(tenant_id,session_id,received_at DESC,id);
CREATE TABLE telemetry_samples (
 id text PRIMARY KEY,tenant_id text NOT NULL,segment_id text NOT NULL,session_id text NOT NULL,sample_offset integer NOT NULL CHECK(sample_offset BETWEEN 0 AND 119),
 sequence bigint NOT NULL CHECK(sequence BETWEEN 0 AND 9007199254740991),occurred_at timestamptz NOT NULL,received_at timestamptz NOT NULL,
 sample jsonb NOT NULL,original_topic text NOT NULL,original_sha256 text NOT NULL CHECK(original_sha256 ~ '^[0-9a-f]{64}$'),
 claim_digest text NOT NULL CHECK(claim_digest ~ '^[0-9a-f]{64}$'),position geography(Point,4326) NOT NULL,
 UNIQUE(tenant_id,segment_id,sample_offset),FOREIGN KEY(tenant_id,segment_id) REFERENCES telemetry_segments(tenant_id,id)
);
CREATE INDEX telemetry_samples_session_sequence ON telemetry_samples(tenant_id,session_id,sequence,claim_digest);
CREATE INDEX telemetry_samples_recent ON telemetry_samples(tenant_id,session_id,occurred_at DESC,id);
CREATE INDEX telemetry_samples_position ON telemetry_samples USING gist(position);
-- The head lock lasts through COMMIT, so resume positions cannot overtake an uncommitted notice.
CREATE TABLE flight_live_heads(tenant_id text NOT NULL,flight_id text NOT NULL,sequence bigint NOT NULL DEFAULT 0,PRIMARY KEY(tenant_id,flight_id),FOREIGN KEY(tenant_id,flight_id) REFERENCES flight_views(tenant_id,id));
CREATE TABLE flight_live_changes(tenant_id text NOT NULL,flight_id text NOT NULL,sequence bigint NOT NULL,type text NOT NULL CHECK(type IN ('telemetry.updated','flight.updated')),event_id text NOT NULL,receipt_id text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,flight_id,sequence),FOREIGN KEY(tenant_id,flight_id) REFERENCES flight_views(tenant_id,id),FOREIGN KEY(tenant_id,event_id) REFERENCES journal_events(tenant_id,id));
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['telemetry_segments','telemetry_samples','flight_live_heads','flight_live_changes'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON %I USING(tenant_id=current_setting(''ledger.tenant_id'',true)) WITH CHECK(tenant_id=current_setting(''ledger.tenant_id'',true))',t);
 END LOOP;
END $$;
CREATE TRIGGER immutable_telemetry_segments BEFORE UPDATE OR DELETE ON telemetry_segments FOR EACH ROW EXECUTE FUNCTION ledger_forbid_history_mutation();
CREATE TRIGGER immutable_telemetry_samples BEFORE UPDATE OR DELETE ON telemetry_samples FOR EACH ROW EXECUTE FUNCTION ledger_forbid_history_mutation();
GRANT SELECT,INSERT ON telemetry_segments,telemetry_samples TO ledger_app;
GRANT SELECT,INSERT,UPDATE ON flight_live_heads TO ledger_app;
-- The bounded notification suffix is a delivery index, not immutable source history.
GRANT SELECT,INSERT,DELETE ON flight_live_changes TO ledger_app;
