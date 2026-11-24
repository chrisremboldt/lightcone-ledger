-- A recorded indicator result: one calculation of one indicator for one control window revision, kept with the
-- request that produced it (definition and exposure-kind digests, control, window, declared population, evidence
-- cut, counted ids and input digest). It is append-only; a later calculation is a new row. A human review of a
-- control's effectiveness cites one of these by digest.
CREATE TABLE control_indicator_results (
 id text PRIMARY KEY,tenant_id text NOT NULL,organization_id text NOT NULL,
 window_id text NOT NULL,window_revision integer NOT NULL CHECK(window_revision>0),
 control_kind text NOT NULL CHECK(control_kind IN ('control_record','flight_control')),
 hazard_id text NOT NULL,control_id text NOT NULL,control_version integer NOT NULL CHECK(control_version>0),
 definition_id text NOT NULL,definition_version integer NOT NULL CHECK(definition_version>0),
 definition_digest text NOT NULL CHECK(definition_digest ~ '^[a-f0-9]{64}$'),
 exposure_kind_digest text NOT NULL CHECK(exposure_kind_digest ~ '^[a-f0-9]{64}$'),
 recorded_through timestamptz NOT NULL CHECK(isfinite(recorded_through)),
 status text NOT NULL CHECK(status IN ('supported','insufficient','conflicting')),
 input_digest text NOT NULL CHECK(input_digest ~ '^[a-f0-9]{64}$'),
 actor_id text NOT NULL,recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at)),
 record jsonb NOT NULL CHECK(jsonb_typeof(record)='object' AND octet_length(record::text)<=262144),
 record_digest text NOT NULL CHECK(record_digest ~ '^[a-f0-9]{64}$'),
 CHECK(record->>'id' IS NOT DISTINCT FROM id AND record->>'windowId' IS NOT DISTINCT FROM window_id
  AND (record->>'windowRevision')::integer IS NOT DISTINCT FROM window_revision
  AND record#>>'{result,definition,digest}' IS NOT DISTINCT FROM definition_digest
  AND record#>>'{result,exposureKind,digest}' IS NOT DISTINCT FROM exposure_kind_digest
  AND record#>>'{result,status}' IS NOT DISTINCT FROM status
  AND record#>>'{result,inputDigest}' IS NOT DISTINCT FROM input_digest
  AND record->>'actorId' IS NOT DISTINCT FROM actor_id
  AND (record->>'recordedAt')::timestamptz IS NOT DISTINCT FROM recorded_at),
 UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,id) REFERENCES journal_events(tenant_id,id),
 FOREIGN KEY(tenant_id,window_id,organization_id) REFERENCES control_windows(tenant_id,id,organization_id),
 FOREIGN KEY(tenant_id,window_id,window_revision) REFERENCES control_window_revisions(tenant_id,window_id,revision),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES principals(tenant_id,id)
);
CREATE INDEX control_indicator_results_control ON control_indicator_results
 (tenant_id,control_kind,hazard_id,control_id,control_version,recorded_at DESC);
CREATE INDEX control_indicator_results_window ON control_indicator_results(tenant_id,window_id,recorded_at DESC);

-- A human review of a control's effectiveness that binds one recorded indicator result by its digest. Reviews
-- recorded earlier against the draft calculation stay in hazard_effectiveness_reviews (0036), unchanged.
CREATE TABLE control_indicator_reviews (
 id text PRIMARY KEY,tenant_id text NOT NULL,organization_id text NOT NULL,
 result_id text NOT NULL,result_digest text NOT NULL CHECK(result_digest ~ '^[a-f0-9]{64}$'),
 control_kind text NOT NULL CHECK(control_kind IN ('control_record','flight_control')),
 hazard_id text NOT NULL,control_id text NOT NULL,control_version integer NOT NULL CHECK(control_version>0),
 conclusion text NOT NULL CHECK(conclusion IN ('effective','ineffective','inconclusive')),
 actor_id text NOT NULL,recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at)),
 record jsonb NOT NULL CHECK(jsonb_typeof(record)='object' AND octet_length(record::text)<=65536),
 record_digest text NOT NULL CHECK(record_digest ~ '^[a-f0-9]{64}$'),
 CHECK(record->>'id' IS NOT DISTINCT FROM id AND record#>>'{result,id}' IS NOT DISTINCT FROM result_id
  AND record#>>'{result,digest}' IS NOT DISTINCT FROM result_digest
  AND record->>'conclusion' IS NOT DISTINCT FROM conclusion
  AND record#>>'{actor,id}' IS NOT DISTINCT FROM actor_id
  AND (record->>'recordedAt')::timestamptz IS NOT DISTINCT FROM recorded_at),
 UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,id) REFERENCES journal_events(tenant_id,id),
 FOREIGN KEY(tenant_id,result_id) REFERENCES control_indicator_results(tenant_id,id),
 FOREIGN KEY(tenant_id,organization_id) REFERENCES organizations(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES principals(tenant_id,id)
);
CREATE INDEX control_indicator_reviews_result ON control_indicator_reviews(tenant_id,result_id,recorded_at DESC);

-- A review must cite the recorded result exactly, and conclude only what its status allows.
CREATE FUNCTION ledger_check_control_indicator_review() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE
 cited control_indicator_results%ROWTYPE;
BEGIN
 SELECT * INTO cited FROM control_indicator_results WHERE tenant_id=NEW.tenant_id AND id=NEW.result_id;
 IF cited.id IS NULL OR cited.record_digest IS DISTINCT FROM NEW.result_digest
  OR cited.organization_id IS DISTINCT FROM NEW.organization_id
  OR (cited.control_kind,cited.hazard_id,cited.control_id,cited.control_version)
   IS DISTINCT FROM (NEW.control_kind,NEW.hazard_id,NEW.control_id,NEW.control_version)
  OR (cited.status<>'supported' AND NEW.conclusion<>'inconclusive') THEN
  RAISE EXCEPTION 'A review must cite its recorded indicator result exactly' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ledger_check_control_indicator_review() FROM PUBLIC,ledger_app;
CREATE TRIGGER control_indicator_review_citation BEFORE INSERT ON control_indicator_reviews
 FOR EACH ROW EXECUTE FUNCTION ledger_check_control_indicator_review();

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['control_indicator_results','control_indicator_reviews'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON %I USING(tenant_id=current_setting(''ledger.tenant_id'',true)) WITH CHECK(tenant_id=current_setting(''ledger.tenant_id'',true))',t);
 EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION ledger_forbid_history_mutation()',t);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO ledger_app',t);
 END LOOP;
END $$;
