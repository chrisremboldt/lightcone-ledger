-- Controls are safety records of kind 'control' (already admitted by sms_records_kind_check since 0041). A risk
-- acceptance on a hazard binds each control version its assessment listed; this table keeps one row per accepted
-- control version, written in the acceptance transaction, so later readers can find the controls in effect at a time
-- without reading signed content. Rows are never changed: a later acceptance adds its own rows, and a reader takes
-- the rows of the hazard's latest acceptance.
CREATE TABLE accepted_hazard_controls (
 tenant_id text NOT NULL,acceptance_id text NOT NULL,hazard_id text NOT NULL,
 control_id text NOT NULL,control_version_number integer NOT NULL CHECK(control_version_number>0),
 control_body_digest text NOT NULL CHECK(control_body_digest ~ '^[a-f0-9]{64}$'),
 control_type_id text NOT NULL CHECK(length(control_type_id) BETWEEN 1 AND 200),
 control_type_version integer NOT NULL CHECK(control_type_version>0),
 control_type_digest text NOT NULL CHECK(control_type_digest ~ '^[a-f0-9]{64}$'),
 effective_from timestamptz NOT NULL,effective_until timestamptz,
 accepted_at timestamptz NOT NULL,
 CHECK(effective_until IS NULL OR effective_until>effective_from),
 PRIMARY KEY(tenant_id,acceptance_id,control_id),
 FOREIGN KEY(tenant_id,hazard_id,acceptance_id) REFERENCES decisions(tenant_id,subject_id,id),
 FOREIGN KEY(tenant_id,hazard_id) REFERENCES sms_records(tenant_id,id),
 FOREIGN KEY(tenant_id,control_id,control_version_number) REFERENCES sms_record_versions(tenant_id,record_id,version_number)
);
CREATE INDEX accepted_hazard_controls_effective ON accepted_hazard_controls
 (tenant_id,effective_from,effective_until);
CREATE INDEX accepted_hazard_controls_hazard ON accepted_hazard_controls(tenant_id,hazard_id,acceptance_id);

ALTER TABLE accepted_hazard_controls ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON accepted_hazard_controls
 USING(tenant_id=current_setting('ledger.tenant_id',true))
 WITH CHECK(tenant_id=current_setting('ledger.tenant_id',true));
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON accepted_hazard_controls
 FOR EACH ROW EXECUTE FUNCTION ledger_forbid_history_mutation();
GRANT SELECT,INSERT ON accepted_hazard_controls TO ledger_app;

-- Controls of a hazard are found by the hazard named in their current body.
CREATE INDEX sms_record_versions_control_hazard ON sms_record_versions(tenant_id,(body->>'hazardId'))
 WHERE schema='sms.control.1';
