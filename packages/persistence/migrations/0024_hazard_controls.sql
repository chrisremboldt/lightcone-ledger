CREATE UNIQUE INDEX hazard_assessment_identity ON hazard_assessments(tenant_id,hazard_id,id);

CREATE TABLE hazard_controls (
 id text PRIMARY KEY,tenant_id text NOT NULL,hazard_id text NOT NULL,control_id text NOT NULL,
 control_version integer NOT NULL CHECK(control_version>0),accepted_revision bigint NOT NULL CHECK(accepted_revision>1),
 assessment_id text NOT NULL,owner_id text NOT NULL,actor_id text NOT NULL,
 effective_from timestamptz NOT NULL,effective_until timestamptz NOT NULL,
 record jsonb NOT NULL CHECK(jsonb_typeof(record)='object'),recorded_at timestamptz NOT NULL,
 CHECK(isfinite(effective_from) AND isfinite(effective_until) AND effective_from<effective_until),
 CHECK(record->>'version' IS NOT DISTINCT FROM 'hazard.control.1'
  AND record->>'hazardId' IS NOT DISTINCT FROM hazard_id
  AND record->>'controlId' IS NOT DISTINCT FROM control_id),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,hazard_id,accepted_revision),
 UNIQUE(tenant_id,hazard_id,control_id,control_version),
 FOREIGN KEY(tenant_id,id) REFERENCES journal_events(tenant_id,id),
 FOREIGN KEY(tenant_id,hazard_id) REFERENCES hazard_views(tenant_id,id),
 FOREIGN KEY(tenant_id,hazard_id,assessment_id) REFERENCES hazard_assessments(tenant_id,hazard_id,id),
 FOREIGN KEY(tenant_id,owner_id) REFERENCES principals(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES principals(tenant_id,id)
);
CREATE INDEX hazard_control_history ON hazard_controls(tenant_id,hazard_id,recorded_at DESC,id DESC);

ALTER TABLE decisions DROP CONSTRAINT decisions_target;
ALTER TABLE decisions ADD CONSTRAINT decisions_target CHECK(
 (flight_id IS NOT NULL AND subject_id IS NULL AND adoption_id IS NULL AND accepted_revision IS NULL AND record IS NULL)
 OR (flight_id IS NULL AND subject_id IS NOT NULL AND adoption_id IS NOT NULL AND accepted_revision IS NOT NULL
  AND accepted_revision>0 AND record IS NOT NULL AND jsonb_typeof(record)='object' AND kind='adoption.review')
 OR (flight_id IS NULL AND subject_id IS NOT NULL AND adoption_id IS NULL AND accepted_revision IS NOT NULL
  AND accepted_revision>0 AND record IS NOT NULL AND jsonb_typeof(record)='object'
  AND ((kind='risk.assess' AND record->>'version' IS NOT DISTINCT FROM 'hazard.assessment.1')
   OR (kind='risk.accept' AND record->>'version' IS NOT DISTINCT FROM 'hazard.risk-acceptance.1'))
  AND record->>'hazardId' IS NOT DISTINCT FROM subject_id)
);

CREATE TABLE hazard_risk_acceptances (
 id text PRIMARY KEY,tenant_id text NOT NULL,hazard_id text NOT NULL,accepted_revision bigint NOT NULL CHECK(accepted_revision>1),
 assessment_id text NOT NULL,control_id text NOT NULL,control_version integer NOT NULL CHECK(control_version>0),actor_id text NOT NULL,
 effective_from timestamptz NOT NULL,effective_until timestamptz NOT NULL,
 record jsonb NOT NULL CHECK(jsonb_typeof(record)='object'),recorded_at timestamptz NOT NULL,
 CHECK(isfinite(effective_from) AND isfinite(effective_until) AND effective_from<effective_until),
 CHECK(record->>'version' IS NOT DISTINCT FROM 'hazard.risk-acceptance.1'
  AND record->>'hazardId' IS NOT DISTINCT FROM hazard_id),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,hazard_id,accepted_revision),
 FOREIGN KEY(tenant_id,hazard_id,id) REFERENCES decisions(tenant_id,subject_id,id),
 FOREIGN KEY(tenant_id,hazard_id,assessment_id) REFERENCES hazard_assessments(tenant_id,hazard_id,id),
 FOREIGN KEY(tenant_id,hazard_id,control_id,control_version) REFERENCES hazard_controls(tenant_id,hazard_id,control_id,control_version),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES principals(tenant_id,id)
);
CREATE INDEX hazard_risk_acceptance_history ON hazard_risk_acceptances(tenant_id,hazard_id,recorded_at DESC,id DESC);
CREATE INDEX hazard_control_acceptances ON hazard_risk_acceptances(tenant_id,hazard_id,control_id,control_version,accepted_revision DESC);

CREATE FUNCTION ledger_check_risk_acceptance_interval() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE control_from timestamptz;control_until timestamptz;
BEGIN
 SELECT effective_from,effective_until INTO control_from,control_until FROM hazard_controls
  WHERE tenant_id=NEW.tenant_id AND hazard_id=NEW.hazard_id AND control_id=NEW.control_id AND control_version=NEW.control_version;
 IF NEW.effective_from IS DISTINCT FROM control_from OR NEW.effective_until IS DISTINCT FROM control_until THEN
  RAISE EXCEPTION 'Risk acceptance must retain the exact cited control interval' USING ERRCODE='23514';
 END IF;
 IF control_until<=clock_timestamp() THEN
  RAISE EXCEPTION 'The accepted control interval expired before commit' USING ERRCODE='40001';
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION ledger_check_risk_acceptance_interval() FROM PUBLIC,ledger_app;
CREATE CONSTRAINT TRIGGER risk_acceptance_commit_interval AFTER INSERT ON hazard_risk_acceptances
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_risk_acceptance_interval();

CREATE FUNCTION ledger_guard_hazard_evaluated_context() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE flight text;org_id text;selected jsonb;adoption_revision bigint;projected_adoption_revision bigint;
BEGIN
 SELECT origin_flight_id,organization_id INTO flight,org_id FROM hazard_openings
  WHERE tenant_id=NEW.tenant_id AND hazard_id=NEW.hazard_id;
 PERFORM 1 FROM flight_views WHERE tenant_id=NEW.tenant_id AND id=flight FOR UPDATE;
 PERFORM 1 FROM organizations WHERE tenant_id=NEW.tenant_id AND id=org_id FOR SHARE;
 IF NOT EXISTS(SELECT 1 FROM organization_pack_adoptions a WHERE a.tenant_id=NEW.tenant_id AND a.organization_id=org_id
  AND a.pack_id='ledger.demo-procedures' AND a.record->'pack'->>'version'='3'
  AND a.record->'pack'->>'digest'='46f777c1c391b696cffc45b450cb61b8563b28417f67ac087522b57e34e56188') THEN RETURN NEW; END IF;
 SELECT COALESCE(MAX(a.accepted_revision),0),COALESCE(MAX(a.accepted_revision) FILTER(WHERE v.id IS NOT NULL),0)
  INTO adoption_revision,projected_adoption_revision FROM organization_pack_adoptions a
  LEFT JOIN organization_pack_adoption_views v ON v.tenant_id=a.tenant_id AND v.id=a.id
  WHERE a.tenant_id=NEW.tenant_id AND a.organization_id=org_id;
 SELECT s.record INTO selected FROM flight_rule_selection_views v JOIN flight_rule_selections s
  ON s.tenant_id=v.tenant_id AND s.flight_id=v.flight_id AND s.id=v.current_id
  WHERE v.tenant_id=NEW.tenant_id AND v.flight_id=flight;
 IF selected IS NULL
  OR selected->>'version' IS DISTINCT FROM 'flight.rule-selection.2'
  OR (selected->>'adoptionRevision')::bigint IS DISTINCT FROM adoption_revision
  OR (selected->>'projectedAdoptionRevision')::bigint IS DISTINCT FROM projected_adoption_revision
  OR (selected->'nextBoundary'->>'at')::timestamptz<=clock_timestamp()
  OR NEW.record#>>'{assessment,evidence,evaluation,profile}' IS DISTINCT FROM 'ledger.c2-evaluation.2'
  OR NEW.record#>>'{assessment,evidence,evaluation,execution,selection,id}' IS DISTINCT FROM selected->>'id'
  OR NEW.record#>>'{assessment,evidence,evaluation,execution,selection,digest}' IS DISTINCT FROM selected->>'selectionDigest' THEN
  RAISE EXCEPTION 'The assessed rule selection changed before commit; review a current assessment' USING ERRCODE='40001';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ledger_guard_hazard_evaluated_context() FROM PUBLIC,ledger_app;
CREATE CONSTRAINT TRIGGER control_commit_evaluated_context AFTER INSERT ON hazard_controls
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_guard_hazard_evaluated_context();
CREATE CONSTRAINT TRIGGER risk_acceptance_commit_evaluated_context AFTER INSERT ON hazard_risk_acceptances
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_guard_hazard_evaluated_context();

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['hazard_controls','hazard_risk_acceptances'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON %I USING(tenant_id=current_setting(''ledger.tenant_id'',true)) WITH CHECK(tenant_id=current_setting(''ledger.tenant_id'',true))',t);
 EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION ledger_forbid_history_mutation()',t);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO ledger_app',t);
 END LOOP;
END $$;
