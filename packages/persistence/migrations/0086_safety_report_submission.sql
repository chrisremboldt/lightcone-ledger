-- People submit safety reports themselves, signed in or through a reporting link (docs/design/report-submission.md).
-- Each organization has one reporting channel principal. It is the journal principal, actor and owner of every
-- submitted report, so nothing a submission writes names the person who sent it.
ALTER TABLE principals DROP CONSTRAINT principals_kind_check;
ALTER TABLE principals ADD CONSTRAINT principals_kind_check
 CHECK(kind IN ('human','source','worker','service','intake'));
ALTER TABLE principals ADD CONSTRAINT principals_intake_holds_nothing
 CHECK(kind<>'intake' OR (capabilities='{}' AND sign_in_issuer IS NULL AND sign_in_subject IS NULL));
CREATE UNIQUE INDEX principals_one_intake ON principals(tenant_id) WHERE kind='intake';

INSERT INTO principals(id,tenant_id,name,kind,capabilities)
 SELECT 'safety-reports-'||id,id,'Safety reporting channel','intake','{}' FROM tenants;
CREATE FUNCTION ledger_provision_reporting_channel() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 INSERT INTO principals(id,tenant_id,name,kind,capabilities)
  VALUES('safety-reports-'||NEW.id,NEW.id,'Safety reporting channel','intake','{}');
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ledger_provision_reporting_channel() FROM PUBLIC,ledger_app;
CREATE TRIGGER provision_reporting_channel AFTER INSERT ON tenants
 FOR EACH ROW EXECUTE FUNCTION ledger_provision_reporting_channel();

-- As 0082 defines it, and never for the reporting channel.
CREATE OR REPLACE FUNCTION ledger_authenticate(p_hash text, p_issuer text, p_subject text)
RETURNS TABLE(id text,tenant_id text,name text,kind text,capabilities text[],revision bigint,active boolean)
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT p.id,p.tenant_id,p.name,p.kind,p.capabilities,p.revision,p.active FROM principals p
 WHERE p.kind<>'intake' AND (
  (p_hash IS NOT NULL AND EXISTS(SELECT 1 FROM api_credentials c WHERE c.token_hash=p_hash AND c.principal_id=p.id
   AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at>clock_timestamp())))
  OR (p_hash IS NULL AND p_issuer IS NOT NULL AND p_subject IS NOT NULL AND p.sign_in_issuer=p_issuer AND p.sign_in_subject=p_subject));
$$;

-- A reporting link: only the SHA-256 of its token is kept. It is revoked once, and it counts the reports it took in
-- its current hour, never who sent them.
CREATE TABLE safety_report_links (
 id text PRIMARY KEY,tenant_id text NOT NULL REFERENCES tenants(id),
 label text NOT NULL CHECK(length(label) BETWEEN 1 AND 120 AND label ~ '\S'),
 token_sha256 text NOT NULL UNIQUE CHECK(token_sha256 ~ '^[a-f0-9]{64}$'),
 issue_event_id text NOT NULL,issued_by text NOT NULL,issued_at timestamptz NOT NULL,
 expires_at timestamptz CHECK(expires_at IS NULL OR expires_at>issued_at),
 revoke_event_id text,revoked_by text,revoked_at timestamptz,
 window_started_at timestamptz,window_count integer NOT NULL DEFAULT 0 CHECK(window_count>=0),
 UNIQUE(tenant_id,id),
 CHECK((revoke_event_id IS NULL)=(revoked_by IS NULL) AND (revoke_event_id IS NULL)=(revoked_at IS NULL)),
 FOREIGN KEY(tenant_id,issue_event_id) REFERENCES journal_events(tenant_id,id),
 FOREIGN KEY(tenant_id,issued_by) REFERENCES principals(tenant_id,id),
 FOREIGN KEY(tenant_id,revoke_event_id) REFERENCES journal_events(tenant_id,id),
 FOREIGN KEY(tenant_id,revoked_by) REFERENCES principals(tenant_id,id)
);
CREATE INDEX safety_report_links_listing ON safety_report_links(tenant_id,issued_at DESC,id);
CREATE FUNCTION ledger_report_link_changes() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE'
  OR (to_jsonb(NEW)-ARRAY['revoke_event_id','revoked_by','revoked_at','window_started_at','window_count'])
   IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['revoke_event_id','revoked_by','revoked_at','window_started_at','window_count'])
  OR (OLD.revoked_at IS NOT NULL AND (NEW.revoke_event_id,NEW.revoked_by,NEW.revoked_at)
   IS DISTINCT FROM (OLD.revoke_event_id,OLD.revoked_by,OLD.revoked_at))
 THEN RAISE EXCEPTION 'a reporting link is only revoked, once, and counts its reports';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER report_link_changes BEFORE UPDATE OR DELETE ON safety_report_links
 FOR EACH ROW EXECUTE FUNCTION ledger_report_link_changes();

-- A submitter's receipt: the SHA-256 of the code they were shown, and the report it answers for. Nothing else.
CREATE TABLE safety_report_receipts (
 code_sha256 text PRIMARY KEY CHECK(code_sha256 ~ '^[a-f0-9]{64}$'),
 tenant_id text NOT NULL,record_id text NOT NULL,
 UNIQUE(tenant_id,record_id),
 FOREIGN KEY(tenant_id,record_id) REFERENCES sms_records(tenant_id,id)
);
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON safety_report_receipts
 FOR EACH ROW EXECUTE FUNCTION ledger_forbid_history_mutation();

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['safety_report_links','safety_report_receipts'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_scope ON %I USING(tenant_id=current_setting(''ledger.tenant_id'',true)) WITH CHECK(tenant_id=current_setting(''ledger.tenant_id'',true))',t);
 END LOOP;
END $$;
-- The API never reads a token or receipt hash back: it finds a link or a receipt only through the functions below.
GRANT SELECT(id,tenant_id,label,issue_event_id,issued_by,issued_at,expires_at,revoke_event_id,revoked_by,revoked_at,
 window_started_at,window_count) ON safety_report_links TO ledger_app;
GRANT INSERT(id,tenant_id,label,token_sha256,issue_event_id,issued_by,issued_at,expires_at) ON safety_report_links TO ledger_app;
GRANT UPDATE(revoke_event_id,revoked_by,revoked_at,window_started_at,window_count) ON safety_report_links TO ledger_app;
GRANT INSERT ON safety_report_receipts TO ledger_app;

-- The link a token opens, while it is in force, with its organization's reporting channel. Called before any
-- organization is known, so it reads across organizations and returns nothing else.
CREATE FUNCTION ledger_safety_report_link(p_token_sha256 text)
RETURNS TABLE(link_id text,tenant_id text,channel_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT l.id,l.tenant_id,p.id FROM safety_report_links l
 JOIN principals p ON p.tenant_id=l.tenant_id AND p.kind='intake' AND p.active
 WHERE l.token_sha256=p_token_sha256 AND l.revoked_at IS NULL
  AND (l.expires_at IS NULL OR l.expires_at>clock_timestamp());
$$;
REVOKE ALL ON FUNCTION ledger_safety_report_link(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ledger_safety_report_link(text) TO ledger_app;

-- What a receipt code may learn: whether its report is received or closed.
CREATE FUNCTION ledger_safety_report_receipt(p_code_sha256 text)
RETURNS TABLE(status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT CASE WHEN r.status='closed' THEN 'closed' ELSE 'received' END FROM safety_report_receipts c
 JOIN sms_records r ON r.tenant_id=c.tenant_id AND r.id=c.record_id
 WHERE c.code_sha256=p_code_sha256;
$$;
REVOKE ALL ON FUNCTION ledger_safety_report_receipt(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ledger_safety_report_receipt(text) TO ledger_app;
