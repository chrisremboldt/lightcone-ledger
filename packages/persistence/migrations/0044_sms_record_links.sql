-- A record's current links. Changing them is not a new version, so signatures and assessments stay current.
-- Restricted records keep their links inside their restricted content.
ALTER TABLE sms_records ADD COLUMN links jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(links)='array');
UPDATE sms_records r SET links=v.links FROM sms_record_versions v
 WHERE v.tenant_id=r.tenant_id AND v.record_id=r.id AND v.version_number=r.version_number;
ALTER TABLE sms_records ADD CONSTRAINT sms_records_restricted_links CHECK(confidentiality='ordinary' OR links='[]');
CREATE INDEX sms_record_link_targets ON sms_records USING gin(links jsonb_path_ops);
GRANT UPDATE(links) ON sms_records TO ledger_app;

CREATE TABLE sms_link_changes (
 id text PRIMARY KEY,tenant_id text NOT NULL,record_id text NOT NULL,revision bigint NOT NULL CHECK(revision>1),
 confidentiality text NOT NULL DEFAULT 'ordinary' CHECK(confidentiality='ordinary'),
 added jsonb NOT NULL CHECK(jsonb_typeof(added)='array'),
 removed jsonb NOT NULL CHECK(jsonb_typeof(removed)='array'),
 links jsonb NOT NULL CHECK(jsonb_typeof(links)='array'),
 actor_id text NOT NULL,recorded_at timestamptz NOT NULL,
 CHECK(jsonb_array_length(added)+jsonb_array_length(removed)>0),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,record_id,revision),
 FOREIGN KEY(tenant_id,id) REFERENCES journal_events(tenant_id,id),
 FOREIGN KEY(tenant_id,record_id,confidentiality) REFERENCES sms_records(tenant_id,id,confidentiality),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES principals(tenant_id,id)
);
ALTER TABLE sms_link_changes ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON sms_link_changes
 USING(tenant_id=current_setting('ledger.tenant_id',true))
 WITH CHECK(tenant_id=current_setting('ledger.tenant_id',true));
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON sms_link_changes
 FOR EACH ROW EXECUTE FUNCTION ledger_forbid_history_mutation();
GRANT SELECT,INSERT ON sms_link_changes TO ledger_app;
