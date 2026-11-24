-- A control window is a monitored period for one accepted control: the population of subjects it covers, the
-- observation types it expects and the indicator definitions it is for. It sits beside the older source-reported
-- windows (0033), which stay as they are. The window row keeps what never changes; each revision declares the
-- population again and is kept. A control record is checked against the accepted-control rows by foreign key; a
-- flight-side control is checked in code, so retiring the flight-side tables needs no change here.
CREATE TABLE control_windows (
 id text PRIMARY KEY,tenant_id text NOT NULL,organization_id text NOT NULL,
 control_kind text NOT NULL CHECK(control_kind IN ('control_record','flight_control')),
 hazard_id text NOT NULL,control_id text NOT NULL,
 control_version integer NOT NULL CHECK(control_version>0),
 acceptance_id text NOT NULL,
 record_acceptance_id text GENERATED ALWAYS AS (CASE WHEN control_kind='control_record' THEN acceptance_id END) STORED,
 period_start timestamptz NOT NULL,period_end timestamptz NOT NULL,
 subject_kind text NOT NULL CHECK(length(subject_kind) BETWEEN 1 AND 40),
 context jsonb NOT NULL CHECK(jsonb_typeof(context)='object' AND octet_length(context::text)<=65536),
 context_digest text NOT NULL CHECK(context_digest ~ '^[a-f0-9]{64}$'),
 opened_event_id text NOT NULL,opened_by text NOT NULL,opened_at timestamptz NOT NULL,
 CHECK(isfinite(period_start) AND isfinite(period_end) AND period_start<period_end AND isfinite(opened_at)),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,id,organization_id),
 FOREIGN KEY(tenant_id,organization_id) REFERENCES organizations(tenant_id,id),
 FOREIGN KEY(tenant_id,opened_event_id) REFERENCES journal_events(tenant_id,id),
 FOREIGN KEY(tenant_id,opened_by) REFERENCES principals(tenant_id,id),
 FOREIGN KEY(tenant_id,record_acceptance_id,control_id) REFERENCES accepted_hazard_controls(tenant_id,acceptance_id,control_id)
);
CREATE INDEX control_windows_control ON control_windows
 (tenant_id,control_kind,hazard_id,control_id,control_version,opened_at DESC);

CREATE TABLE control_window_revisions (
 id text PRIMARY KEY,tenant_id text NOT NULL,window_id text NOT NULL,organization_id text NOT NULL,
 revision integer NOT NULL CHECK(revision>0),actor_id text NOT NULL,recorded_at timestamptz NOT NULL,
 record jsonb NOT NULL CHECK(jsonb_typeof(record)='object' AND octet_length(record::text)<=131072),
 record_digest text NOT NULL CHECK(record_digest ~ '^[a-f0-9]{64}$'),
 CHECK(isfinite(recorded_at)),
 CHECK(record->>'id' IS NOT DISTINCT FROM id AND record->>'windowId' IS NOT DISTINCT FROM window_id
  AND (record->>'revision')::integer IS NOT DISTINCT FROM revision AND record->>'actorId' IS NOT DISTINCT FROM actor_id
  AND (record->>'recordedAt')::timestamptz IS NOT DISTINCT FROM recorded_at),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,window_id,revision),
 FOREIGN KEY(tenant_id,id) REFERENCES journal_events(tenant_id,id),
 FOREIGN KEY(tenant_id,window_id,organization_id) REFERENCES control_windows(tenant_id,id,organization_id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES principals(tenant_id,id)
);

CREATE FUNCTION ledger_check_control_window_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE
 latest integer;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('control-window-revision',NEW.tenant_id,NEW.window_id)::text,0));
 SELECT COALESCE(max(revision),0) INTO latest FROM control_window_revisions
  WHERE tenant_id=NEW.tenant_id AND window_id=NEW.window_id;
 IF NEW.revision<>latest+1 THEN
  RAISE EXCEPTION 'Control window revisions must begin at one and advance contiguously' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ledger_check_control_window_revision() FROM PUBLIC,ledger_app;
CREATE TRIGGER control_window_revision_order BEFORE INSERT ON control_window_revisions
 FOR EACH ROW EXECUTE FUNCTION ledger_check_control_window_revision();

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['control_windows','control_window_revisions'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON %I USING(tenant_id=current_setting(''ledger.tenant_id'',true)) WITH CHECK(tenant_id=current_setting(''ledger.tenant_id'',true))',t);
 EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION ledger_forbid_history_mutation()',t);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO ledger_app',t);
 END LOOP;
END $$;
