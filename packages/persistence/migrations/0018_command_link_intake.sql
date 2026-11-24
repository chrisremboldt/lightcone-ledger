ALTER TABLE principals ADD COLUMN command_link_sources text[] NOT NULL DEFAULT '{}';
ALTER TABLE principals ADD CONSTRAINT command_link_sources_bound
 CHECK(cardinality(command_link_sources)<=100 AND array_position(command_link_sources,NULL) IS NULL);

CREATE TABLE command_link_sessions (
 tenant_id text NOT NULL,source_id text NOT NULL,source_session_id text NOT NULL,
 flight_id text NOT NULL,aircraft_id text NOT NULL,first_event_id text NOT NULL,
 PRIMARY KEY(tenant_id,source_id,source_session_id),
 UNIQUE(tenant_id,source_id,source_session_id,flight_id,aircraft_id),
 FOREIGN KEY(tenant_id,flight_id) REFERENCES flight_views(tenant_id,id),
 FOREIGN KEY(tenant_id,first_event_id) REFERENCES journal_events(tenant_id,id)
);
CREATE TABLE command_link_source_events (
 tenant_id text NOT NULL,source_id text NOT NULL,source_session_id text NOT NULL,source_event_id text NOT NULL,
 flight_id text NOT NULL,aircraft_id text NOT NULL,receipt_id text NOT NULL,event_id text NOT NULL,
 content_digest text NOT NULL CHECK(content_digest ~ '^[0-9a-f]{64}$'),
 PRIMARY KEY(tenant_id,source_id,source_session_id,source_event_id),
 UNIQUE(tenant_id,receipt_id),UNIQUE(tenant_id,event_id),
 FOREIGN KEY(tenant_id,source_id,source_session_id,flight_id,aircraft_id)
  REFERENCES command_link_sessions(tenant_id,source_id,source_session_id,flight_id,aircraft_id),
 FOREIGN KEY(tenant_id,receipt_id) REFERENCES receipts(tenant_id,id),
 FOREIGN KEY(tenant_id,event_id) REFERENCES journal_events(tenant_id,id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['command_link_sessions','command_link_source_events'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON %I USING(tenant_id=current_setting(''ledger.tenant_id'',true)) WITH CHECK(tenant_id=current_setting(''ledger.tenant_id'',true))',t);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO ledger_app',t);
 EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION ledger_forbid_history_mutation()',t);
 END LOOP;
END $$;
