CREATE TABLE flight_evaluations (
 id text PRIMARY KEY,tenant_id text NOT NULL,flight_id text NOT NULL,
 leaf_id text NOT NULL,leaf_version integer NOT NULL,binding_id text NOT NULL,binding_version integer NOT NULL,
 input_digest text NOT NULL,record jsonb NOT NULL,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,flight_id,leaf_id,leaf_version,binding_id,binding_version,input_digest),
 FOREIGN KEY(tenant_id,id) REFERENCES journal_events(tenant_id,id),
 FOREIGN KEY(tenant_id,flight_id) REFERENCES flight_views(tenant_id,id)
);
CREATE TABLE findings (
 id text PRIMARY KEY,tenant_id text NOT NULL,flight_id text NOT NULL,leaf_id text NOT NULL,
 initial_evaluation_id text NOT NULL,opened_at timestamptz NOT NULL,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,flight_id,leaf_id),
 FOREIGN KEY(tenant_id,flight_id) REFERENCES flight_views(tenant_id,id),
 FOREIGN KEY(tenant_id,initial_evaluation_id) REFERENCES flight_evaluations(tenant_id,id)
);
CREATE TABLE finding_views (
 id text PRIMARY KEY,tenant_id text NOT NULL,flight_id text NOT NULL,latest_evaluation_id text NOT NULL,
 status text NOT NULL CHECK(status IN ('open','acknowledged','responding','resolved')),owner_id text,
 FOREIGN KEY(tenant_id,id) REFERENCES findings(tenant_id,id),
 FOREIGN KEY(tenant_id,flight_id) REFERENCES flight_views(tenant_id,id),
 FOREIGN KEY(tenant_id,latest_evaluation_id) REFERENCES flight_evaluations(tenant_id,id),
 FOREIGN KEY(tenant_id,owner_id) REFERENCES principals(tenant_id,id)
);
CREATE TABLE finding_treatments (
 id text PRIMARY KEY,tenant_id text NOT NULL,finding_id text NOT NULL,evaluation_id text NOT NULL,
 action text NOT NULL CHECK(action IN ('acknowledge','respond','resolve')),actor_id text NOT NULL,
 note text NOT NULL,recorded_at timestamptz NOT NULL,
 FOREIGN KEY(tenant_id,id) REFERENCES command_records(tenant_id,id),
 FOREIGN KEY(tenant_id,finding_id) REFERENCES findings(tenant_id,id),
 FOREIGN KEY(tenant_id,evaluation_id) REFERENCES flight_evaluations(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES principals(tenant_id,id)
);
CREATE INDEX finding_treatment_history ON finding_treatments(tenant_id,finding_id,recorded_at DESC,id DESC);
CREATE INDEX open_finding_flights ON finding_views(tenant_id,flight_id) WHERE status<>'resolved';
ALTER TABLE flight_views ADD COLUMN open_finding_count integer NOT NULL DEFAULT 0,
 ADD COLUMN unowned_finding_count integer NOT NULL DEFAULT 0,ADD COLUMN latest_finding_title text;
CREATE INDEX flight_open_findings ON flight_views(tenant_id,id) WHERE open_finding_count>0;

CREATE TABLE evaluation_deadlines (
 id text PRIMARY KEY,tenant_id text NOT NULL,flight_id text NOT NULL,trigger_event_id text NOT NULL,
 leaf_id text NOT NULL,binding_id text NOT NULL,due_at timestamptz NOT NULL,
 clock_mode text NOT NULL DEFAULT 'wall' CHECK(clock_mode='wall'),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','leased','completed','failed')),
 generation bigint NOT NULL DEFAULT 0,lease_owner text,lease_until timestamptz,
 attempts integer NOT NULL DEFAULT 0,error text,available_at timestamptz NOT NULL,completed_at timestamptz,
 UNIQUE(tenant_id,flight_id,leaf_id,binding_id,due_at),
 FOREIGN KEY(tenant_id,flight_id) REFERENCES flight_views(tenant_id,id),
 FOREIGN KEY(tenant_id,trigger_event_id) REFERENCES journal_events(tenant_id,id)
);
CREATE INDEX evaluation_deadline_ready ON evaluation_deadlines(state,available_at,lease_until);

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['flight_evaluations','findings','finding_views','finding_treatments','evaluation_deadlines'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON %I USING(tenant_id=current_setting(''ledger.tenant_id'',true)) WITH CHECK(tenant_id=current_setting(''ledger.tenant_id'',true))',t);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO ledger_app',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['flight_evaluations','findings','finding_treatments'] LOOP
 EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION ledger_forbid_history_mutation()',t);
 END LOOP;
END $$;
GRANT UPDATE ON finding_views TO ledger_app;
GRANT UPDATE ON evaluation_deadlines TO ledger_worker;

CREATE FUNCTION ledger_lease_evaluations(p_owner text,p_limit integer,p_seconds integer)
RETURNS TABLE(id text,tenant_id text,flight_id text,trigger_event_id text,leaf_id text,binding_id text,
 due_at timestamptz,clock_mode text,state text,generation bigint,lease_owner text,lease_until timestamptz,
 attempts integer,error text,available_at timestamptz,completed_at timestamptz,worker_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN RETURN QUERY WITH candidates AS (
 SELECT d.id FROM evaluation_deadlines d
 WHERE (d.state='pending' AND d.available_at<=clock_timestamp() OR d.state='leased' AND d.lease_until<clock_timestamp())
 AND EXISTS(SELECT 1 FROM principals p WHERE p.tenant_id=d.tenant_id AND p.kind='worker' AND p.active)
 ORDER BY d.available_at,d.id FOR UPDATE SKIP LOCKED LIMIT LEAST(GREATEST(p_limit,1),100)
), leased AS (
 UPDATE evaluation_deadlines d SET state='leased',lease_owner=p_owner,
 lease_until=clock_timestamp()+make_interval(secs=>LEAST(GREATEST(p_seconds,1),300)),
 generation=d.generation+1,attempts=d.attempts+1 FROM candidates c WHERE d.id=c.id RETURNING d.*
)
SELECT l.*,p.id FROM leased l JOIN LATERAL(
 SELECT principal.id FROM principals principal WHERE principal.tenant_id=l.tenant_id
 AND principal.kind='worker' AND principal.active ORDER BY principal.id LIMIT 1
)p ON true;
END $$;
REVOKE ALL ON FUNCTION ledger_lease_evaluations(text,integer,integer) FROM PUBLIC,ledger_app;
GRANT EXECUTE ON FUNCTION ledger_lease_evaluations(text,integer,integer) TO ledger_worker;
