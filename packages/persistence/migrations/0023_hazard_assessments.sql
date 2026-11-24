CREATE TABLE hazard_openings (
 id text PRIMARY KEY,tenant_id text NOT NULL,hazard_id text NOT NULL,organization_id text NOT NULL,
 origin_flight_id text NOT NULL,origin_finding_id text NOT NULL,origin_evaluation_id text NOT NULL,
 actor_id text NOT NULL,record jsonb NOT NULL CHECK(jsonb_typeof(record)='object'),recorded_at timestamptz NOT NULL,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,hazard_id),UNIQUE(tenant_id,hazard_id,id),
 FOREIGN KEY(tenant_id,id) REFERENCES journal_events(tenant_id,id),
 FOREIGN KEY(tenant_id,hazard_id) REFERENCES subjects(tenant_id,id),
 FOREIGN KEY(tenant_id,organization_id) REFERENCES organizations(tenant_id,id),
 FOREIGN KEY(tenant_id,origin_flight_id) REFERENCES flight_views(tenant_id,id),
 FOREIGN KEY(tenant_id,origin_finding_id) REFERENCES findings(tenant_id,id),
 FOREIGN KEY(tenant_id,origin_evaluation_id) REFERENCES flight_evaluations(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES principals(tenant_id,id)
);
CREATE INDEX hazard_origin_citation ON hazard_openings(tenant_id,origin_flight_id,origin_finding_id,origin_evaluation_id,recorded_at DESC,id);

CREATE TABLE hazard_views (
 id text PRIMARY KEY,tenant_id text NOT NULL,opening_id text NOT NULL,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 projected_revision bigint NOT NULL DEFAULT 0 CHECK(projected_revision>=0 AND projected_revision<=revision),
 UNIQUE(tenant_id,id),FOREIGN KEY(tenant_id,id) REFERENCES subjects(tenant_id,id),
 FOREIGN KEY(tenant_id,id,opening_id) REFERENCES hazard_openings(tenant_id,hazard_id,id)
);

ALTER TABLE decisions DROP CONSTRAINT decisions_target;
ALTER TABLE decisions ADD CONSTRAINT decisions_target CHECK(
 (flight_id IS NOT NULL AND subject_id IS NULL AND adoption_id IS NULL AND accepted_revision IS NULL AND record IS NULL)
 OR (flight_id IS NULL AND subject_id IS NOT NULL AND adoption_id IS NOT NULL AND accepted_revision IS NOT NULL
  AND accepted_revision>0 AND record IS NOT NULL AND jsonb_typeof(record)='object' AND kind='adoption.review')
 OR (flight_id IS NULL AND subject_id IS NOT NULL AND adoption_id IS NULL AND accepted_revision IS NOT NULL
  AND accepted_revision>0 AND record IS NOT NULL AND jsonb_typeof(record)='object' AND kind='risk.assess'
  AND record->>'version' IS NOT DISTINCT FROM 'hazard.assessment.1' AND record->>'hazardId' IS NOT DISTINCT FROM subject_id)
);

CREATE TABLE hazard_assessments (
 id text PRIMARY KEY,tenant_id text NOT NULL,hazard_id text NOT NULL,accepted_revision bigint NOT NULL CHECK(accepted_revision>1),
 evaluation_id text NOT NULL,actor_id text NOT NULL,record jsonb NOT NULL CHECK(jsonb_typeof(record)='object'),recorded_at timestamptz NOT NULL,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,hazard_id,accepted_revision),
 FOREIGN KEY(tenant_id,hazard_id) REFERENCES hazard_views(tenant_id,id),
 FOREIGN KEY(tenant_id,hazard_id,id) REFERENCES decisions(tenant_id,subject_id,id),
 FOREIGN KEY(tenant_id,evaluation_id) REFERENCES flight_evaluations(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES principals(tenant_id,id)
);
CREATE INDEX hazard_assessment_history ON hazard_assessments(tenant_id,hazard_id,recorded_at DESC,id DESC);
CREATE INDEX work_items_pending_stream ON work_items(tenant_id,stream_id) WHERE state<>'completed';

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['hazard_openings','hazard_views','hazard_assessments'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON %I USING(tenant_id=current_setting(''ledger.tenant_id'',true)) WITH CHECK(tenant_id=current_setting(''ledger.tenant_id'',true))',t);
 EXECUTE format('GRANT SELECT ON %I TO ledger_app',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['hazard_openings','hazard_assessments'] LOOP
 EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION ledger_forbid_history_mutation()',t);
 END LOOP;
END $$;
GRANT INSERT ON hazard_openings,hazard_views,hazard_assessments TO ledger_app;
GRANT UPDATE(revision) ON hazard_views TO ledger_app;
GRANT UPDATE(projected_revision) ON hazard_views TO ledger_worker;
