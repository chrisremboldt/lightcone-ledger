CREATE TABLE source_declarations (
 tenant_id text NOT NULL, source_id text NOT NULL, event_type text NOT NULL, principal_id text NOT NULL,
 declaration_digest text NOT NULL CHECK(declaration_digest ~ '^[0-9a-f]{64}$'),
 declared_fidelity text, schema_digest text, declared_limitations jsonb, event_id text NOT NULL,
 PRIMARY KEY(tenant_id,source_id,event_type,principal_id,declaration_digest),
 FOREIGN KEY(tenant_id,event_id) REFERENCES journal_events(tenant_id,id)
);
ALTER TABLE source_declarations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON source_declarations USING(tenant_id=current_setting('ledger.tenant_id',true)) WITH CHECK(tenant_id=current_setting('ledger.tenant_id',true));
CREATE TRIGGER immutable_source_declarations BEFORE UPDATE OR DELETE ON source_declarations FOR EACH ROW EXECUTE FUNCTION ledger_forbid_history_mutation();
GRANT SELECT,INSERT ON source_declarations TO ledger_app;

CREATE FUNCTION ledger_project_source_declaration() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 INSERT INTO source_declarations(tenant_id,source_id,event_type,principal_id,declaration_digest,declared_fidelity,schema_digest,declared_limitations,event_id)
 VALUES(NEW.tenant_id,NEW.source_id,NEW.event_type,NEW.principal_id,
  encode(sha256(convert_to(jsonb_build_array(NEW.payload->>'fidelity',NEW.payload->'payload'->>'schemaDigest',NEW.payload->'payload'->'limitations')::text,'UTF8')),'hex'),
  NEW.payload->>'fidelity',NEW.payload->'payload'->>'schemaDigest',NEW.payload->'payload'->'limitations',NEW.id)
 ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ledger_project_source_declaration() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ledger_project_source_declaration() TO ledger_app;
CREATE TRIGGER project_source_declaration AFTER INSERT ON journal_events
FOR EACH ROW WHEN(NEW.source_id IS NOT NULL) EXECUTE FUNCTION ledger_project_source_declaration();

INSERT INTO source_declarations(tenant_id,source_id,event_type,principal_id,declaration_digest,declared_fidelity,schema_digest,declared_limitations,event_id)
SELECT tenant_id,source_id,event_type,principal_id,
 encode(sha256(convert_to(jsonb_build_array(payload->>'fidelity',payload->'payload'->>'schemaDigest',payload->'payload'->'limitations')::text,'UTF8')),'hex'),
 payload->>'fidelity',payload->'payload'->>'schemaDigest',payload->'payload'->'limitations',MIN(id)
FROM journal_events WHERE source_id IS NOT NULL
GROUP BY tenant_id,source_id,event_type,principal_id,payload->>'fidelity',payload->'payload'->>'schemaDigest',payload->'payload'->'limitations'
ON CONFLICT DO NOTHING;
