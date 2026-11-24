-- Current permission for a principal to submit one observation type under one source id. Grants are authority,
-- replaced through authority.update; their history is that command's journal event.
CREATE TABLE observation_grants (
 tenant_id text NOT NULL,principal_id text NOT NULL,source_id text NOT NULL,observation_type text NOT NULL,
 PRIMARY KEY(tenant_id,principal_id,source_id,observation_type),
 CHECK(length(source_id) BETWEEN 1 AND 200),
 CHECK(length(observation_type)<=100 AND observation_type ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*\.[a-z][a-z0-9]*(-[a-z0-9]+)*$'),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES principals(tenant_id,id)
);

-- Every accepted observation of every registered type, append-only. The full observation is retained; the
-- columns are copies of its fields used to find it, plus what intake recorded about it.
CREATE TABLE observations (
 id text PRIMARY KEY,tenant_id text NOT NULL,
 receipt_id text NOT NULL,event_id text NOT NULL,artifact_id text NOT NULL,principal_id text NOT NULL,
 source_id text NOT NULL,source_session_id text,source_event_id text,
 observation_type text NOT NULL,observation_version integer NOT NULL CHECK(observation_version>0),
 subject_kind text NOT NULL,subject_id text NOT NULL,subject_scope text NOT NULL CHECK(subject_scope IN ('ledger','source')),
 subject_ledger_id text,
 subject_resolution text NOT NULL CHECK(subject_resolution IN ('ledger','alias','unresolved','ambiguous')),
 secondary_subject_kind text,secondary_subject_id text,
 secondary_subject_scope text CHECK(secondary_subject_scope IN ('ledger','source')),
 secondary_subject_ledger_id text,
 secondary_subject_resolution text CHECK(secondary_subject_resolution IN ('ledger','alias','unresolved','ambiguous')),
 occurred_at timestamptz NOT NULL,interval_start timestamptz,interval_end timestamptz,
 span_start timestamptz GENERATED ALWAYS AS (COALESCE(interval_start,occurred_at)) STORED,
 received_at timestamptz NOT NULL,
 fidelity text NOT NULL,
 content_digest text NOT NULL CHECK(content_digest ~ '^[a-f0-9]{64}$'),
 observation jsonb NOT NULL CHECK(jsonb_typeof(observation)='object'),
 CHECK(isfinite(occurred_at) AND isfinite(received_at)),
 CHECK(interval_end IS NULL OR (interval_start IS NOT NULL AND interval_start<interval_end)),
 CHECK((subject_resolution IN ('ledger','alias'))=(subject_ledger_id IS NOT NULL)),
 CHECK((subject_resolution='ledger')=(subject_scope='ledger')),
 CHECK((secondary_subject_kind IS NULL)=(secondary_subject_id IS NULL)
  AND (secondary_subject_kind IS NULL)=(secondary_subject_scope IS NULL)
  AND (secondary_subject_kind IS NULL)=(secondary_subject_resolution IS NULL)),
 CHECK(secondary_subject_resolution IS NULL
  OR ((secondary_subject_resolution IN ('ledger','alias'))=(secondary_subject_ledger_id IS NOT NULL)
   AND (secondary_subject_resolution='ledger')=(secondary_subject_scope='ledger'))),
 CHECK(observation->>'type' IS NOT DISTINCT FROM observation_type
  AND (observation->>'version')::integer IS NOT DISTINCT FROM observation_version
  AND observation#>>'{subject,kind}' IS NOT DISTINCT FROM subject_kind
  AND observation#>>'{subject,id}' IS NOT DISTINCT FROM subject_id
  AND observation#>>'{subject,scope}' IS NOT DISTINCT FROM subject_scope
  AND observation#>>'{secondarySubject,kind}' IS NOT DISTINCT FROM secondary_subject_kind
  AND observation#>>'{secondarySubject,id}' IS NOT DISTINCT FROM secondary_subject_id
  AND observation#>>'{secondarySubject,scope}' IS NOT DISTINCT FROM secondary_subject_scope
  AND (observation->>'occurredAt')::timestamptz IS NOT DISTINCT FROM occurred_at
  AND (observation#>>'{interval,start}')::timestamptz IS NOT DISTINCT FROM interval_start
  AND (observation#>>'{interval,end}')::timestamptz IS NOT DISTINCT FROM interval_end
  AND observation->>'sourceSessionId' IS NOT DISTINCT FROM source_session_id
  AND observation->>'sourceEventId' IS NOT DISTINCT FROM source_event_id
  AND observation->>'fidelity' IS NOT DISTINCT FROM fidelity
  AND observation->>'originalArtifactId' IS NOT DISTINCT FROM artifact_id),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,receipt_id),UNIQUE(tenant_id,event_id),
 FOREIGN KEY(tenant_id,receipt_id) REFERENCES receipts(tenant_id,id),
 FOREIGN KEY(tenant_id,event_id) REFERENCES journal_events(tenant_id,id),
 FOREIGN KEY(tenant_id,artifact_id) REFERENCES artifacts(tenant_id,id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES principals(tenant_id,id),
 FOREIGN KEY(tenant_id,subject_ledger_id) REFERENCES subjects(tenant_id,id),
 FOREIGN KEY(tenant_id,secondary_subject_ledger_id) REFERENCES subjects(tenant_id,id)
);
-- A source event is accepted once per type; a resend with the same content returns the original receipt.
CREATE UNIQUE INDEX observations_source_event ON observations
 (tenant_id,source_id,COALESCE(source_session_id,''),observation_type,source_event_id) WHERE source_event_id IS NOT NULL;
CREATE INDEX observations_by_subject ON observations
 (tenant_id,subject_ledger_id,observation_type,span_start,id) WHERE subject_ledger_id IS NOT NULL;
CREATE INDEX observations_by_secondary_subject ON observations
 (tenant_id,secondary_subject_ledger_id,observation_type,span_start,id) WHERE secondary_subject_ledger_id IS NOT NULL;
CREATE INDEX observations_by_source_subject ON observations
 (tenant_id,source_id,subject_kind,subject_id,observation_type,span_start,id) WHERE subject_scope='source';

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['observation_grants','observations'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON %I USING(tenant_id=current_setting(''ledger.tenant_id'',true)) WITH CHECK(tenant_id=current_setting(''ledger.tenant_id'',true))',t);
 END LOOP;
END $$;
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON observations
 FOR EACH ROW EXECUTE FUNCTION ledger_forbid_history_mutation();
GRANT SELECT,INSERT ON observations TO ledger_app;
GRANT SELECT,INSERT,DELETE ON observation_grants TO ledger_app;
GRANT SELECT ON observations,observation_grants TO ledger_worker;
