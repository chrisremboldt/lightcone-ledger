-- Corrections to accepted observations, each an append-only record with its own journal event. Nothing here
-- changes a stored observation: reads decide what is current at the evidence cut they read at.

-- A replacement is itself an accepted observation that names the one it replaces. An observation is replaced once.
ALTER TABLE observations ADD COLUMN replaces_observation_id text,
 ADD CONSTRAINT observations_replaces FOREIGN KEY(tenant_id,replaces_observation_id) REFERENCES observations(tenant_id,id),
 ADD CONSTRAINT observations_replaces_another CHECK(replaces_observation_id IS DISTINCT FROM id);
CREATE UNIQUE INDEX observations_replacement ON observations(tenant_id,replaces_observation_id)
 WHERE replaces_observation_id IS NOT NULL;

-- An observation stated to be wrong, with no replacement. An observation is withdrawn once.
CREATE TABLE observation_withdrawals (
 id text PRIMARY KEY,tenant_id text NOT NULL,observation_id text NOT NULL,event_id text NOT NULL,
 principal_id text NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 4000),
 recorded_at timestamptz NOT NULL,
 UNIQUE(tenant_id,observation_id),UNIQUE(tenant_id,event_id),
 FOREIGN KEY(tenant_id,observation_id) REFERENCES observations(tenant_id,id),
 FOREIGN KEY(tenant_id,event_id) REFERENCES journal_events(tenant_id,id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES principals(tenant_id,id)
);

-- Which Ledger subject an observation is about, decided after intake. Either one subject role of one observation
-- (attach or move it), or a source identity: every observation unresolved at intake that names that identity under
-- that source, within the alias's validity. The latest resolution inside a reader's evidence cut wins.
CREATE TABLE observation_subject_resolutions (
 id text PRIMARY KEY,tenant_id text NOT NULL,event_id text NOT NULL,principal_id text NOT NULL,
 recorded_at timestamptz NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 4000),
 subject_kind text NOT NULL,ledger_subject_id text NOT NULL,
 observation_id text,role text CHECK(role IN ('subject','secondarySubject')),
 source_id text,external_id text,valid_from timestamptz,valid_to timestamptz,alias_id text,
 CHECK((observation_id IS NOT NULL AND role IS NOT NULL AND source_id IS NULL AND external_id IS NULL
   AND valid_from IS NULL AND valid_to IS NULL AND alias_id IS NULL)
  OR (observation_id IS NULL AND role IS NULL AND source_id IS NOT NULL AND external_id IS NOT NULL
   AND alias_id IS NOT NULL)),
 CHECK(valid_from IS NULL OR valid_to IS NULL OR valid_from<valid_to),
 UNIQUE(tenant_id,event_id),
 FOREIGN KEY(tenant_id,observation_id) REFERENCES observations(tenant_id,id),
 FOREIGN KEY(tenant_id,ledger_subject_id) REFERENCES subjects(tenant_id,id),
 FOREIGN KEY(tenant_id,event_id) REFERENCES journal_events(tenant_id,id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES principals(tenant_id,id),
 FOREIGN KEY(alias_id) REFERENCES aliases(id)
);
CREATE INDEX observation_subject_resolutions_by_observation ON observation_subject_resolutions
 (tenant_id,observation_id) WHERE observation_id IS NOT NULL;
CREATE INDEX observation_subject_resolutions_by_identity ON observation_subject_resolutions
 (tenant_id,source_id,subject_kind,external_id) WHERE observation_id IS NULL;
CREATE INDEX observation_subject_resolutions_by_subject ON observation_subject_resolutions(tenant_id,ledger_subject_id);

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['observation_withdrawals','observation_subject_resolutions'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON %I USING(tenant_id=current_setting(''ledger.tenant_id'',true)) WITH CHECK(tenant_id=current_setting(''ledger.tenant_id'',true))',t);
 EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION ledger_forbid_history_mutation()',t);
 END LOOP;
END $$;
GRANT SELECT,INSERT ON observation_withdrawals,observation_subject_resolutions TO ledger_app;
GRANT SELECT ON observation_withdrawals,observation_subject_resolutions TO ledger_worker;
