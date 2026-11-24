ALTER TABLE organization_pack_adoptions
 ADD CONSTRAINT organization_pack_adoption_subject_identity UNIQUE(tenant_id,organization_id,id);

ALTER TABLE decisions ALTER COLUMN flight_id DROP NOT NULL;
ALTER TABLE decisions ADD COLUMN subject_id text;
ALTER TABLE decisions ADD COLUMN adoption_id text;
ALTER TABLE decisions ADD COLUMN accepted_revision bigint;
ALTER TABLE decisions ADD COLUMN record jsonb;
ALTER TABLE decisions
 ADD CONSTRAINT decisions_subject_identity UNIQUE(tenant_id,subject_id,id),
 ADD CONSTRAINT decisions_subject_revision UNIQUE(tenant_id,subject_id,accepted_revision),
 ADD CONSTRAINT decisions_subject_reference FOREIGN KEY(tenant_id,subject_id) REFERENCES subjects(tenant_id,id),
 ADD CONSTRAINT decisions_adoption_reference FOREIGN KEY(tenant_id,subject_id,adoption_id)
  REFERENCES organization_pack_adoptions(tenant_id,organization_id,id),
 ADD CONSTRAINT decisions_target CHECK(
  (flight_id IS NOT NULL AND subject_id IS NULL AND adoption_id IS NULL AND accepted_revision IS NULL AND record IS NULL)
  OR
  (flight_id IS NULL AND subject_id IS NOT NULL AND adoption_id IS NOT NULL AND accepted_revision IS NOT NULL
   AND accepted_revision>0 AND record IS NOT NULL AND jsonb_typeof(record)='object' AND kind='adoption.review')
 );
CREATE INDEX organization_decision_history ON decisions(tenant_id,subject_id,accepted_revision DESC)
 WHERE subject_id IS NOT NULL;

CREATE TABLE organization_decision_views (
 id text PRIMARY KEY,tenant_id text NOT NULL,organization_id text NOT NULL,
 accepted_revision bigint NOT NULL CHECK(accepted_revision>0),projected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,organization_id,id) REFERENCES decisions(tenant_id,subject_id,id),
 FOREIGN KEY(tenant_id,organization_id) REFERENCES organizations(tenant_id,id)
);
ALTER TABLE organization_decision_views ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON organization_decision_views
 USING(tenant_id=current_setting('ledger.tenant_id',true)) WITH CHECK(tenant_id=current_setting('ledger.tenant_id',true));
GRANT SELECT ON organization_decision_views TO ledger_app;
GRANT INSERT,UPDATE ON organization_decision_views TO ledger_worker;

ALTER TABLE export_records ALTER COLUMN flight_id DROP NOT NULL;
ALTER TABLE export_records ADD COLUMN subject_id text;
ALTER TABLE export_records ADD COLUMN format text NOT NULL DEFAULT 'ledger.decision-evidence.1';
ALTER TABLE export_records
 ADD CONSTRAINT exports_subject_reference FOREIGN KEY(tenant_id,subject_id) REFERENCES subjects(tenant_id,id),
 ADD CONSTRAINT exports_subject_decision_reference FOREIGN KEY(tenant_id,subject_id,decision_id)
  REFERENCES decisions(tenant_id,subject_id,id),
 ADD CONSTRAINT exports_format_target CHECK(
  (format='ledger.decision-evidence.1' AND flight_id IS NOT NULL AND subject_id IS NULL)
  OR (format='ledger.subject-evidence.2' AND subject_id IS NOT NULL AND flight_id IS NULL)
 );
CREATE INDEX exports_subject_listing ON export_records(tenant_id,subject_id,issued_at DESC,id)
 WHERE subject_id IS NOT NULL;
