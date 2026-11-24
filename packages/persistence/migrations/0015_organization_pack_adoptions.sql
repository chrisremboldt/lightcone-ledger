CREATE TABLE organizations (
 id text PRIMARY KEY,tenant_id text NOT NULL UNIQUE REFERENCES tenants(id),
 revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
 projected_revision bigint NOT NULL DEFAULT 0 CHECK(projected_revision>=0 AND projected_revision<=revision),
 UNIQUE(tenant_id,id),CHECK(id='organization:'||tenant_id),
 FOREIGN KEY(tenant_id,id) REFERENCES subjects(tenant_id,id)
);

CREATE TABLE organization_pack_adoptions (
 id text PRIMARY KEY,tenant_id text NOT NULL,organization_id text NOT NULL,
 accepted_revision bigint NOT NULL CHECK(accepted_revision>0),pack_id text NOT NULL,
 effective_start timestamptz NOT NULL,effective_end timestamptz NOT NULL,record jsonb NOT NULL,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,organization_id,accepted_revision),
 CHECK(isfinite(effective_start) AND isfinite(effective_end) AND effective_end>effective_start),
 CHECK(jsonb_typeof(record)='object'),
 FOREIGN KEY(tenant_id,id) REFERENCES journal_events(tenant_id,id),
 FOREIGN KEY(tenant_id,organization_id) REFERENCES organizations(tenant_id,id)
);
CREATE INDEX organization_pack_adoption_history ON organization_pack_adoptions(tenant_id,organization_id,accepted_revision DESC);
CREATE INDEX organization_pack_adoption_intervals ON organization_pack_adoptions(tenant_id,organization_id,pack_id,effective_start,effective_end);

CREATE TABLE organization_pack_adoption_views (
 id text PRIMARY KEY,tenant_id text NOT NULL,organization_id text NOT NULL,
 accepted_revision bigint NOT NULL,projected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,id) REFERENCES organization_pack_adoptions(tenant_id,id),
 FOREIGN KEY(tenant_id,organization_id) REFERENCES organizations(tenant_id,id)
);

INSERT INTO subjects(id,tenant_id,kind,label)
SELECT 'organization:'||id,id,'organization',name FROM tenants;
INSERT INTO organizations(id,tenant_id)
SELECT 'organization:'||id,id FROM tenants;

CREATE FUNCTION ledger_provision_organization() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 INSERT INTO subjects(id,tenant_id,kind,label) VALUES('organization:'||NEW.id,NEW.id,'organization',NEW.name);
 INSERT INTO organizations(id,tenant_id) VALUES('organization:'||NEW.id,NEW.id);
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ledger_provision_organization() FROM PUBLIC,ledger_app;
CREATE TRIGGER provision_organization AFTER INSERT ON tenants FOR EACH ROW EXECUTE FUNCTION ledger_provision_organization();

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['organizations','organization_pack_adoptions','organization_pack_adoption_views'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON %I USING(tenant_id=current_setting(''ledger.tenant_id'',true)) WITH CHECK(tenant_id=current_setting(''ledger.tenant_id'',true))',t);
 EXECUTE format('GRANT SELECT ON %I TO ledger_app',t);
 END LOOP;
END $$;
GRANT INSERT ON organization_pack_adoptions TO ledger_app;
GRANT UPDATE(revision) ON organizations TO ledger_app;
GRANT INSERT,UPDATE ON organization_pack_adoption_views TO ledger_worker;
GRANT UPDATE(projected_revision) ON organizations TO ledger_worker;
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON organization_pack_adoptions FOR EACH ROW EXECUTE FUNCTION ledger_forbid_history_mutation();
