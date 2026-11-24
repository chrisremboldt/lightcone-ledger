ALTER TABLE principals ADD COLUMN mission_sources text[] NOT NULL DEFAULT '{}';
ALTER TABLE principals ADD CONSTRAINT mission_sources_bound
 CHECK(cardinality(mission_sources)<=100 AND array_position(mission_sources,NULL) IS NULL);

CREATE TABLE missions (
 id text PRIMARY KEY,tenant_id text NOT NULL,source_id text NOT NULL,source_mission_id text NOT NULL,
 flight_id text NOT NULL,aircraft_id text NOT NULL,first_event_id text NOT NULL,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,source_id,source_mission_id),UNIQUE(tenant_id,flight_id),
 UNIQUE(tenant_id,id,flight_id),
 FOREIGN KEY(tenant_id,id) REFERENCES subjects(tenant_id,id),
 FOREIGN KEY(tenant_id,flight_id) REFERENCES flight_views(tenant_id,id),
 FOREIGN KEY(tenant_id,first_event_id) REFERENCES journal_events(tenant_id,id)
);
CREATE TABLE mission_revisions (
 id text PRIMARY KEY,tenant_id text NOT NULL,mission_id text NOT NULL,flight_id text NOT NULL,
 source_revision bigint NOT NULL CHECK(source_revision>0 AND source_revision<=9007199254740991),
 receipt_id text NOT NULL,artifact_id text NOT NULL,
 content_digest text NOT NULL CHECK(content_digest ~ '^[0-9a-f]{64}$'),
 record jsonb NOT NULL CHECK(jsonb_typeof(record)='object'),recorded_at timestamptz NOT NULL,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,mission_id,source_revision),UNIQUE(tenant_id,receipt_id),
 UNIQUE(tenant_id,mission_id,flight_id,id),
 FOREIGN KEY(tenant_id,id) REFERENCES journal_events(tenant_id,id),
 FOREIGN KEY(tenant_id,mission_id,flight_id) REFERENCES missions(tenant_id,id,flight_id),
 FOREIGN KEY(tenant_id,receipt_id) REFERENCES receipts(tenant_id,id),
 FOREIGN KEY(tenant_id,artifact_id) REFERENCES artifacts(tenant_id,id),
 CHECK(record->>'version' IS NOT DISTINCT FROM 'flight.mission.1'
  AND record->>'id' IS NOT DISTINCT FROM id AND record->>'missionId' IS NOT DISTINCT FROM mission_id
  AND record->>'flightId' IS NOT DISTINCT FROM flight_id AND record->>'receiptId' IS NOT DISTINCT FROM receipt_id
  AND record->>'artifactId' IS NOT DISTINCT FROM artifact_id AND record->>'contentDigest' IS NOT DISTINCT FROM content_digest)
);
CREATE TABLE mission_projection_views (
 tenant_id text NOT NULL,mission_id text NOT NULL,flight_id text NOT NULL,current_revision_id text NOT NULL,
 PRIMARY KEY(tenant_id,mission_id),UNIQUE(tenant_id,flight_id),
 FOREIGN KEY(tenant_id,mission_id,flight_id,current_revision_id) REFERENCES mission_revisions(tenant_id,mission_id,flight_id,id)
);

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['missions','mission_revisions','mission_projection_views'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON %I USING(tenant_id=current_setting(''ledger.tenant_id'',true)) WITH CHECK(tenant_id=current_setting(''ledger.tenant_id'',true))',t);
 EXECUTE format('GRANT SELECT ON %I TO ledger_app',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['missions','mission_revisions'] LOOP
 EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION ledger_forbid_history_mutation()',t);
 END LOOP;
END $$;
GRANT INSERT ON missions,mission_revisions TO ledger_app;
GRANT INSERT ON mission_projection_views TO ledger_worker;
GRANT UPDATE(current_revision_id) ON mission_projection_views TO ledger_worker;
