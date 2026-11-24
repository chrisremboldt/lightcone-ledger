CREATE EXTENSION IF NOT EXISTS postgis;
CREATE TABLE IF NOT EXISTS tenants (id text PRIMARY KEY, name text NOT NULL);
CREATE TABLE IF NOT EXISTS principals (
  id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('human','source','worker','service')), capabilities text[] NOT NULL,
  revision bigint NOT NULL DEFAULT 1, active boolean NOT NULL DEFAULT true,
  clerk_issuer text, clerk_subject text, UNIQUE(clerk_issuer,clerk_subject), UNIQUE(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS api_credentials (token_hash text PRIMARY KEY, principal_id text NOT NULL REFERENCES principals(id), enabled boolean NOT NULL DEFAULT true);
CREATE TABLE IF NOT EXISTS subjects (id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), kind text NOT NULL, label text NOT NULL, UNIQUE(tenant_id,id));
CREATE TABLE IF NOT EXISTS aliases (id text PRIMARY KEY, tenant_id text NOT NULL, subject_id text NOT NULL, source_id text NOT NULL, external_id text NOT NULL, valid_from timestamptz, valid_to timestamptz,
 FOREIGN KEY(tenant_id,subject_id) REFERENCES subjects(tenant_id,id), CHECK(valid_to IS NULL OR valid_from IS NULL OR valid_to>valid_from));
CREATE INDEX IF NOT EXISTS aliases_lookup ON aliases(tenant_id,source_id,external_id);
CREATE TABLE IF NOT EXISTS streams (id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), name text NOT NULL, sequence bigint NOT NULL DEFAULT 0, head_hash text NOT NULL DEFAULT '', UNIQUE(tenant_id,name), UNIQUE(tenant_id,id));
CREATE TABLE IF NOT EXISTS uploads (id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), principal_id text NOT NULL, content_type text NOT NULL, byte_length integer NOT NULL CHECK(byte_length>0 AND byte_length<=10485760), filename text, object_key text NOT NULL UNIQUE,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','stored','finalized','failed')), sha256 text, artifact_id text, expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 hours', UNIQUE(tenant_id,id), FOREIGN KEY(tenant_id,principal_id) REFERENCES principals(tenant_id,id));
CREATE TABLE IF NOT EXISTS artifacts (id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), upload_id text NOT NULL UNIQUE, object_key text NOT NULL UNIQUE, sha256 text NOT NULL, byte_length integer NOT NULL, content_type text NOT NULL, object_version text,
 UNIQUE(tenant_id,id), FOREIGN KEY(tenant_id,upload_id) REFERENCES uploads(tenant_id,id));
CREATE TABLE IF NOT EXISTS journal_events (tenant_id text NOT NULL, id text NOT NULL, stream_id text NOT NULL, stream_sequence bigint NOT NULL, event_type text NOT NULL, schema_version integer NOT NULL DEFAULT 1,
 principal_id text NOT NULL, source_id text, source_session_id text, occurred_at timestamptz, effective_at timestamptz, received_at timestamptz NOT NULL DEFAULT clock_timestamp(), causation_id text, payload jsonb NOT NULL,
 artifact_id text, envelope_digest text NOT NULL, previous_hash text NOT NULL, entry_hash text NOT NULL, encoding_version text NOT NULL,
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,stream_id,stream_sequence), FOREIGN KEY(tenant_id,stream_id) REFERENCES streams(tenant_id,id), FOREIGN KEY(tenant_id,principal_id) REFERENCES principals(tenant_id,id), FOREIGN KEY(tenant_id,artifact_id) REFERENCES artifacts(tenant_id,id)) PARTITION BY HASH(tenant_id);
DO $$ BEGIN FOR i IN 0..7 LOOP EXECUTE format('CREATE TABLE IF NOT EXISTS journal_events_p%s PARTITION OF journal_events FOR VALUES WITH (MODULUS 8, REMAINDER %s)',i,i); END LOOP; END $$;
CREATE INDEX IF NOT EXISTS journal_stream_lookup ON journal_events(tenant_id,stream_id,stream_sequence);
CREATE TABLE IF NOT EXISTS idempotency_keys (tenant_id text NOT NULL, principal_id text NOT NULL, endpoint text NOT NULL, producer_key text NOT NULL, digest text NOT NULL, effect_id text NOT NULL,
 PRIMARY KEY(tenant_id,principal_id,endpoint,producer_key), FOREIGN KEY(tenant_id,principal_id) REFERENCES principals(tenant_id,id));
CREATE TABLE IF NOT EXISTS receipts (id text PRIMARY KEY, tenant_id text NOT NULL, event_id text NOT NULL, source_id text NOT NULL, kind text NOT NULL, occurred_at timestamptz, received_at timestamptz NOT NULL,
 source_revision bigint, flight_id text, order_id text, artifact_id text, link_status text NOT NULL DEFAULT 'unresolved', payload jsonb NOT NULL, input_subject jsonb NOT NULL, UNIQUE(tenant_id,id), FOREIGN KEY(tenant_id,event_id) REFERENCES journal_events(tenant_id,id), FOREIGN KEY(tenant_id,artifact_id) REFERENCES artifacts(tenant_id,id));
CREATE INDEX IF NOT EXISTS receipts_listing ON receipts(tenant_id,received_at,id);
CREATE TABLE IF NOT EXISTS outbox (id text PRIMARY KEY, tenant_id text NOT NULL, event_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(tenant_id,event_id), FOREIGN KEY(tenant_id,event_id) REFERENCES journal_events(tenant_id,id));
CREATE TABLE IF NOT EXISTS work_items (id text PRIMARY KEY, tenant_id text NOT NULL, event_id text NOT NULL, stream_id text NOT NULL, stream_sequence bigint NOT NULL, state text NOT NULL DEFAULT 'pending', generation bigint NOT NULL DEFAULT 0,
 lease_owner text, lease_until timestamptz, attempts integer NOT NULL DEFAULT 0, error text, available_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz, UNIQUE(tenant_id,event_id), FOREIGN KEY(tenant_id,event_id) REFERENCES journal_events(tenant_id,id));
CREATE INDEX IF NOT EXISTS work_ready ON work_items(state,available_at,lease_until);
CREATE TABLE IF NOT EXISTS flight_views (id text PRIMARY KEY, tenant_id text NOT NULL, origination_key text NOT NULL, label text NOT NULL, revision bigint NOT NULL DEFAULT 1, basis_revision bigint NOT NULL DEFAULT 1,
 activity text NOT NULL DEFAULT 'planned', coverage text NOT NULL DEFAULT 'unknown', aircraft text, scheduled_start timestamptz, scheduled_end timestamptz, last_occurred_at timestamptz, last_received_at timestamptz,
 source_ids text[] NOT NULL DEFAULT '{}', conflict_count integer NOT NULL DEFAULT 0, intent_revision bigint NOT NULL DEFAULT 0, UNIQUE(tenant_id,id), UNIQUE(tenant_id,origination_key), FOREIGN KEY(tenant_id,id) REFERENCES subjects(tenant_id,id));
CREATE INDEX IF NOT EXISTS flight_list ON flight_views(tenant_id,id);
CREATE TABLE IF NOT EXISTS operational_orders (id text PRIMARY KEY, tenant_id text NOT NULL, source_id text NOT NULL, external_id text NOT NULL, revision bigint NOT NULL, status text NOT NULL, payload jsonb NOT NULL, event_id text NOT NULL,
 UNIQUE(tenant_id,source_id,external_id), UNIQUE(tenant_id,id), FOREIGN KEY(tenant_id,id) REFERENCES subjects(tenant_id,id));
CREATE TABLE IF NOT EXISTS fulfillments (id text PRIMARY KEY, tenant_id text NOT NULL, flight_id text NOT NULL, source_id text NOT NULL, order_external_id text NOT NULL, order_revision bigint NOT NULL, quantity numeric,
 UNIQUE(tenant_id,flight_id,source_id,order_external_id), FOREIGN KEY(tenant_id,flight_id) REFERENCES flight_views(tenant_id,id));
CREATE TABLE IF NOT EXISTS relations (id text PRIMARY KEY, tenant_id text NOT NULL, flight_id text NOT NULL, kind text NOT NULL, revision bigint NOT NULL, payload jsonb NOT NULL, event_id text NOT NULL, FOREIGN KEY(tenant_id,flight_id) REFERENCES flight_views(tenant_id,id));
CREATE TABLE IF NOT EXISTS claims (id text PRIMARY KEY, tenant_id text NOT NULL, event_id text NOT NULL, receipt_id text, flight_id text NOT NULL, kind text NOT NULL, payload jsonb NOT NULL, source_revision bigint, occurred_at timestamptz, FOREIGN KEY(tenant_id,event_id) REFERENCES journal_events(tenant_id,id), FOREIGN KEY(tenant_id,flight_id) REFERENCES flight_views(tenant_id,id));
ALTER TABLE claims ADD COLUMN IF NOT EXISTS correction_of text;
CREATE TABLE IF NOT EXISTS timeline_items (id text NOT NULL, tenant_id text NOT NULL, flight_id text NOT NULL, lane text NOT NULL, kind text NOT NULL, title text NOT NULL, occurred_at timestamptz NOT NULL, received_at timestamptz NOT NULL, actor_id text NOT NULL, source_id text,
 payload jsonb NOT NULL, receipt_id text, artifact_id text, correction_of text, link_status text NOT NULL DEFAULT 'linked', PRIMARY KEY(tenant_id,flight_id,id), FOREIGN KEY(tenant_id,flight_id) REFERENCES flight_views(tenant_id,id));
CREATE INDEX IF NOT EXISTS timeline_pagination ON timeline_items(tenant_id,flight_id,received_at,id);
CREATE TABLE IF NOT EXISTS command_records (id text PRIMARY KEY, tenant_id text NOT NULL, kind text NOT NULL, flight_id text, actor_id text NOT NULL, recorded_at timestamptz NOT NULL, payload jsonb NOT NULL, UNIQUE(tenant_id,id), FOREIGN KEY(tenant_id,id) REFERENCES journal_events(tenant_id,id));
CREATE TABLE IF NOT EXISTS decisions (id text PRIMARY KEY, tenant_id text NOT NULL, flight_id text NOT NULL, actor_id text NOT NULL, kind text NOT NULL, note text NOT NULL, recorded_at timestamptz NOT NULL,
 rendered_input_cut jsonb NOT NULL, accepted_input_cut jsonb NOT NULL, accepted_basis_revision bigint NOT NULL, FOREIGN KEY(tenant_id,id) REFERENCES journal_events(tenant_id,id), FOREIGN KEY(tenant_id,flight_id) REFERENCES flight_views(tenant_id,id));
CREATE TABLE IF NOT EXISTS projection_offsets (tenant_id text NOT NULL, stream_id text NOT NULL, sequence bigint NOT NULL, projector_version text NOT NULL DEFAULT 'thread.1', PRIMARY KEY(tenant_id,stream_id));
CREATE TABLE IF NOT EXISTS view_changes (id bigserial PRIMARY KEY, tenant_id text NOT NULL, flight_id text, event_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp());

CREATE OR REPLACE FUNCTION ledger_authenticate(p_hash text, p_issuer text, p_subject text)
RETURNS TABLE(id text,tenant_id text,name text,kind text,capabilities text[],revision bigint,active boolean)
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT p.id,p.tenant_id,p.name,p.kind,p.capabilities,p.revision,p.active FROM principals p
 WHERE (p_hash IS NOT NULL AND EXISTS(SELECT 1 FROM api_credentials c WHERE c.token_hash=p_hash AND c.principal_id=p.id AND c.enabled))
 OR (p_hash IS NULL AND p_issuer IS NOT NULL AND p_subject IS NOT NULL AND p.clerk_issuer=p_issuer AND p.clerk_subject=p_subject);
$$;
REVOKE ALL ON FUNCTION ledger_authenticate(text,text,text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION ledger_lease_work(p_owner text,p_limit integer,p_seconds integer)
RETURNS TABLE(id text,tenant_id text,event_id text,stream_id text,stream_sequence bigint,generation bigint,worker_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 BEGIN RETURN QUERY WITH candidates AS (
 SELECT w.id FROM work_items w WHERE (w.state='pending' AND w.available_at<=clock_timestamp() OR w.state='leased' AND w.lease_until<clock_timestamp())
 AND NOT EXISTS (SELECT 1 FROM work_items predecessor WHERE predecessor.tenant_id=w.tenant_id AND predecessor.stream_id=w.stream_id AND predecessor.stream_sequence<w.stream_sequence AND predecessor.state NOT IN ('completed','failed'))
 ORDER BY w.available_at,w.id FOR UPDATE SKIP LOCKED LIMIT LEAST(GREATEST(p_limit,1),100)
 ), leased AS (UPDATE work_items w SET state='leased',lease_owner=p_owner,lease_until=clock_timestamp()+make_interval(secs=>LEAST(GREATEST(p_seconds,1),300)),generation=w.generation+1,attempts=w.attempts+1 FROM candidates c WHERE w.id=c.id
 RETURNING w.id,w.tenant_id,w.event_id,w.stream_id,w.stream_sequence,w.generation)
 SELECT l.id,l.tenant_id,l.event_id,l.stream_id,l.stream_sequence,l.generation,p.id FROM leased l JOIN principals p ON p.tenant_id=l.tenant_id AND p.kind='worker' AND p.active;
 END $$;
REVOKE ALL ON FUNCTION ledger_lease_work(text,integer,integer) FROM PUBLIC;

CREATE OR REPLACE FUNCTION ledger_forbid_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'append-only history cannot be modified'; END $$;
DROP TRIGGER IF EXISTS immutable_journal ON journal_events;
CREATE TRIGGER immutable_journal BEFORE UPDATE OR DELETE ON journal_events FOR EACH ROW EXECUTE FUNCTION ledger_forbid_history_mutation();
DROP TRIGGER IF EXISTS immutable_decisions ON decisions;
CREATE TRIGGER immutable_decisions BEFORE UPDATE OR DELETE ON decisions FOR EACH ROW EXECUTE FUNCTION ledger_forbid_history_mutation();
DROP TRIGGER IF EXISTS immutable_artifacts ON artifacts;
CREATE TRIGGER immutable_artifacts BEFORE UPDATE OR DELETE ON artifacts FOR EACH ROW EXECUTE FUNCTION ledger_forbid_history_mutation();
DROP TRIGGER IF EXISTS immutable_claims ON claims;
CREATE TRIGGER immutable_claims BEFORE UPDATE OR DELETE ON claims FOR EACH ROW EXECUTE FUNCTION ledger_forbid_history_mutation();
DROP TRIGGER IF EXISTS immutable_commands ON command_records;
CREATE TRIGGER immutable_commands BEFORE UPDATE OR DELETE ON command_records FOR EACH ROW EXECUTE FUNCTION ledger_forbid_history_mutation();
CREATE OR REPLACE FUNCTION ledger_protect_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.id IS DISTINCT FROM NEW.id OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id OR OLD.event_id IS DISTINCT FROM NEW.event_id OR OLD.source_id IS DISTINCT FROM NEW.source_id OR OLD.kind IS DISTINCT FROM NEW.kind OR OLD.occurred_at IS DISTINCT FROM NEW.occurred_at OR OLD.received_at IS DISTINCT FROM NEW.received_at OR OLD.source_revision IS DISTINCT FROM NEW.source_revision OR OLD.artifact_id IS DISTINCT FROM NEW.artifact_id OR OLD.payload IS DISTINCT FROM NEW.payload OR OLD.input_subject IS DISTINCT FROM NEW.input_subject THEN RAISE EXCEPTION 'immutable receipt context cannot be modified'; END IF;
 RETURN NEW;
 END $$;
DROP TRIGGER IF EXISTS immutable_receipt_context ON receipts;
CREATE TRIGGER immutable_receipt_context BEFORE UPDATE ON receipts FOR EACH ROW EXECUTE FUNCTION ledger_protect_receipt();

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['tenants','principals','subjects','aliases','streams','uploads','artifacts','journal_events','idempotency_keys','receipts','outbox','work_items','flight_views','operational_orders','fulfillments','relations','claims','timeline_items','command_records','decisions','projection_offsets','view_changes'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('DROP POLICY IF EXISTS tenant_scope ON %I',t);
 IF t='tenants' THEN
 EXECUTE format('CREATE POLICY tenant_scope ON %I USING (id=current_setting(''ledger.tenant_id'',true)) WITH CHECK (id=current_setting(''ledger.tenant_id'',true))',t);
 ELSE
 EXECUTE format('CREATE POLICY tenant_scope ON %I USING (tenant_id=current_setting(''ledger.tenant_id'',true)) WITH CHECK (tenant_id=current_setting(''ledger.tenant_id'',true))',t);
 END IF;
 END LOOP;
END $$;
GRANT USAGE ON SCHEMA public TO ledger_app;
GRANT SELECT,INSERT,UPDATE ON tenants,principals,subjects,aliases,streams,uploads,idempotency_keys,receipts,outbox,work_items,flight_views,operational_orders,fulfillments,relations,claims,timeline_items,command_records,projection_offsets,view_changes TO ledger_app;
GRANT SELECT,INSERT ON journal_events,decisions,artifacts TO ledger_app;
REVOKE UPDATE ON receipts,claims,command_records FROM ledger_app;
GRANT UPDATE(flight_id,link_status) ON receipts TO ledger_app;
GRANT USAGE,SELECT ON SEQUENCE view_changes_id_seq TO ledger_app;
GRANT EXECUTE ON FUNCTION ledger_authenticate(text,text,text) TO ledger_app;
GRANT EXECUTE ON FUNCTION ledger_lease_work(text,integer,integer) TO ledger_app;
