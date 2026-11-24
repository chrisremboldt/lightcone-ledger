ALTER TABLE sms_records ADD CONSTRAINT sms_records_confidential_identity UNIQUE(tenant_id,id,confidentiality);
ALTER TABLE sms_records ADD CONSTRAINT sms_records_report_confidentiality
 CHECK(kind<>'report' OR confidentiality='safety_report');
ALTER TABLE sms_record_versions ADD CONSTRAINT sms_record_versions_record_confidentiality
 FOREIGN KEY(tenant_id,record_id,confidentiality) REFERENCES sms_records(tenant_id,id,confidentiality);

-- The salt makes content_digest a commitment, so a published digest cannot confirm a guessed narrative or reporter.
CREATE TABLE sms_restricted_record_versions (
 id text PRIMARY KEY,tenant_id text NOT NULL,record_id text NOT NULL,
 version_number integer NOT NULL CHECK(version_number>0),revision bigint NOT NULL CHECK(revision>0),
 schema text NOT NULL CHECK(schema ~ '^sms\.[a-z-]+\.[0-9]+$'),record_class text NOT NULL,
 confidentiality text NOT NULL CHECK(confidentiality IN ('safety_report','restricted_asset_information')),
 salt text NOT NULL CHECK(salt ~ '^[a-f0-9]{64}$'),
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
 body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'),
 links jsonb NOT NULL CHECK(jsonb_typeof(links)='array'),
 content_canonical text NOT NULL,content_digest text NOT NULL CHECK(content_digest ~ '^[a-f0-9]{64}$'),
 owner_id text NOT NULL,due_at timestamptz,actor_id text NOT NULL,recorded_at timestamptz NOT NULL,
 CHECK(content_canonical::jsonb=jsonb_build_object('salt',salt,'schema',schema,'title',title,'body',body,'links',links)
  AND content_digest=encode(sha256(convert_to(content_canonical,'UTF8')),'hex')),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,record_id,version_number),UNIQUE(tenant_id,record_id,revision),
 FOREIGN KEY(tenant_id,id) REFERENCES journal_events(tenant_id,id),
 FOREIGN KEY(tenant_id,record_id,confidentiality) REFERENCES sms_records(tenant_id,id,confidentiality),
 FOREIGN KEY(tenant_id,owner_id) REFERENCES principals(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES principals(tenant_id,id)
);
ALTER TABLE sms_restricted_record_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON sms_restricted_record_versions
 USING(tenant_id=current_setting('ledger.tenant_id',true))
 WITH CHECK(tenant_id=current_setting('ledger.tenant_id',true));
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON sms_restricted_record_versions
 FOR EACH ROW EXECUTE FUNCTION ledger_forbid_history_mutation();
GRANT INSERT ON sms_restricted_record_versions TO ledger_app;
GRANT SELECT(id,tenant_id,record_id,version_number,revision,schema,record_class,confidentiality,content_digest,
 owner_id,due_at,actor_id,recorded_at) ON sms_restricted_record_versions TO ledger_app;

ALTER TABLE sms_restricted_disclosures ALTER COLUMN attachment_id DROP NOT NULL;
ALTER TABLE sms_restricted_disclosures ADD COLUMN record_version_id text;
ALTER TABLE sms_restricted_disclosures ADD CONSTRAINT sms_restricted_disclosure_target
 CHECK((attachment_id IS NULL)<>(record_version_id IS NULL));
ALTER TABLE sms_restricted_disclosures ADD CONSTRAINT sms_restricted_disclosure_version
 FOREIGN KEY(tenant_id,record_version_id) REFERENCES sms_restricted_record_versions(tenant_id,id);

-- The only way ledger_app reads restricted titles, bodies and links: checks tenant, caller and capability, and
-- retains one disclosure per version shown.
CREATE FUNCTION ledger_disclose_sms_record_content(p_record_id text)
RETURNS TABLE(version_id text,version_number integer,title text,body jsonb,links jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
#variable_conflict use_column
DECLARE
 scope_tenant text:=current_setting('ledger.tenant_id',true);
 caller text:=current_setting('ledger.principal_id',true);
 record_confidentiality text;
 needed text;
BEGIN
 SELECT r.confidentiality INTO record_confidentiality FROM sms_records r
  WHERE r.tenant_id=scope_tenant AND r.id=p_record_id;
 IF record_confidentiality IS NULL OR record_confidentiality='ordinary' THEN
  RAISE EXCEPTION 'restricted record content is unavailable' USING ERRCODE='42501';
 END IF;
 needed:=CASE record_confidentiality WHEN 'safety_report' THEN 'sms:report:read' ELSE 'sms:restricted:read' END;
 IF NOT EXISTS(SELECT 1 FROM principals p WHERE p.tenant_id=scope_tenant AND p.id=caller AND p.active
  AND p.kind='human' AND needed=ANY(p.capabilities)) THEN
  RAISE EXCEPTION 'restricted record content needs %',needed USING ERRCODE='42501';
 END IF;
 INSERT INTO sms_restricted_disclosures(id,tenant_id,principal_id,record_version_id,capability)
  SELECT gen_random_uuid()::text,scope_tenant,caller,v.id,needed FROM sms_restricted_record_versions v
  WHERE v.tenant_id=scope_tenant AND v.record_id=p_record_id;
 RETURN QUERY SELECT v.id,v.version_number,v.title,v.body,v.links FROM sms_restricted_record_versions v
  WHERE v.tenant_id=scope_tenant AND v.record_id=p_record_id ORDER BY v.version_number DESC;
END $$;
REVOKE ALL ON FUNCTION ledger_disclose_sms_record_content(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ledger_disclose_sms_record_content(text) TO ledger_app;
