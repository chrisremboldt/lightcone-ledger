-- A link to one produced set of records, for someone who does not sign in (docs/design/shared-links.md). Only the
-- SHA-256 of its secret is kept. It expires, is revoked once, and each opening is kept; who opened it is not.
CREATE TABLE record_production_links (
 id text PRIMARY KEY,tenant_id text NOT NULL REFERENCES tenants(id),
 production_id text NOT NULL,
 note text NOT NULL CHECK(length(note) BETWEEN 1 AND 300 AND note ~ '\S'),
 secret_sha256 text NOT NULL UNIQUE CHECK(secret_sha256 ~ '^[a-f0-9]{64}$'),
 create_event_id text NOT NULL,created_by text NOT NULL,created_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL CHECK(expires_at>created_at AND expires_at<=created_at+interval '90 days'),
 revoke_event_id text,revoked_by text,revoked_at timestamptz,
 revoke_reason text CHECK(revoke_reason IS NULL OR (length(revoke_reason) BETWEEN 1 AND 1000 AND revoke_reason ~ '\S')),
 UNIQUE(tenant_id,id),
 CHECK((revoke_event_id IS NULL)=(revoked_by IS NULL) AND (revoke_event_id IS NULL)=(revoked_at IS NULL)
  AND (revoke_event_id IS NULL)=(revoke_reason IS NULL)),
 FOREIGN KEY(tenant_id,production_id) REFERENCES record_productions(tenant_id,id),
 FOREIGN KEY(tenant_id,create_event_id) REFERENCES journal_events(tenant_id,id),
 FOREIGN KEY(tenant_id,created_by) REFERENCES principals(tenant_id,id),
 FOREIGN KEY(tenant_id,revoke_event_id) REFERENCES journal_events(tenant_id,id),
 FOREIGN KEY(tenant_id,revoked_by) REFERENCES principals(tenant_id,id)
);
CREATE INDEX record_production_links_by_production ON record_production_links(tenant_id,production_id,created_at DESC,id);
CREATE FUNCTION ledger_record_production_link_changes() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE'
  OR (to_jsonb(NEW)-ARRAY['revoke_event_id','revoked_by','revoked_at','revoke_reason'])
   IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['revoke_event_id','revoked_by','revoked_at','revoke_reason'])
  OR OLD.revoked_at IS NOT NULL
 THEN RAISE EXCEPTION 'a record production link is only revoked, once';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER record_production_link_changes BEFORE UPDATE OR DELETE ON record_production_links
 FOR EACH ROW EXECUTE FUNCTION ledger_record_production_link_changes();

-- Each opening of a link: when, and what was opened. Nothing about who opened it.
CREATE TABLE record_production_link_openings (
 id text PRIMARY KEY,tenant_id text NOT NULL,link_id text NOT NULL,
 opened_at timestamptz NOT NULL,
 opened text NOT NULL CHECK(opened IN ('page','file','archive')),
 path text CHECK((opened='file')=(path IS NOT NULL) AND (path IS NULL OR length(path) BETWEEN 1 AND 500)),
 FOREIGN KEY(tenant_id,link_id) REFERENCES record_production_links(tenant_id,id)
);
CREATE INDEX record_production_link_openings_by_link ON record_production_link_openings(tenant_id,link_id,opened_at DESC,id);
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON record_production_link_openings
 FOR EACH ROW EXECUTE FUNCTION ledger_forbid_history_mutation();

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['record_production_links','record_production_link_openings'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_scope ON %I USING(tenant_id=current_setting(''ledger.tenant_id'',true)) WITH CHECK(tenant_id=current_setting(''ledger.tenant_id'',true))',t);
 END LOOP;
END $$;
-- The API never reads a secret's hash back: an unsigned request reaches a link only through the functions below.
GRANT SELECT(id,tenant_id,production_id,note,create_event_id,created_by,created_at,expires_at,revoke_event_id,revoked_by,
 revoked_at,revoke_reason) ON record_production_links TO ledger_app;
GRANT INSERT(id,tenant_id,production_id,note,secret_sha256,create_event_id,created_by,created_at,expires_at)
 ON record_production_links TO ledger_app;
GRANT UPDATE(revoke_event_id,revoked_by,revoked_at,revoke_reason) ON record_production_links TO ledger_app;
GRANT SELECT ON record_production_link_openings TO ledger_app;

-- The produced set a secret opens while its link is in force, with the organization's name. Called before any
-- organization is known, so it reads across organizations by the hash alone and returns nothing else.
CREATE FUNCTION ledger_record_production_link(p_secret_sha256 text)
RETURNS TABLE(link_id text,tenant_id text,organization_name text,expires_at timestamptz,production_id text,
 metadata jsonb,archive_object_key text,archive_sha256 text,manifest_sha256 text,byte_length integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT l.id,l.tenant_id,t.name,l.expires_at,p.id,p.metadata,p.archive_object_key,p.archive_sha256,p.manifest_sha256,
  p.byte_length
 FROM record_production_links l
 JOIN record_productions p ON p.tenant_id=l.tenant_id AND p.id=l.production_id
 JOIN tenants t ON t.id=l.tenant_id
 WHERE l.secret_sha256=p_secret_sha256 AND l.revoked_at IS NULL AND l.expires_at>clock_timestamp();
$$;
REVOKE ALL ON FUNCTION ledger_record_production_link(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ledger_record_production_link(text) TO ledger_app;

-- Keeps one opening of a link still in force, and nothing else; false when the link is not in force.
CREATE FUNCTION ledger_record_production_link_opened(p_secret_sha256 text,p_opened text,p_path text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE found_link record;
BEGIN
 SELECT l.id,l.tenant_id INTO found_link FROM record_production_links l
  WHERE l.secret_sha256=p_secret_sha256 AND l.revoked_at IS NULL AND l.expires_at>clock_timestamp();
 IF NOT FOUND THEN RETURN false; END IF;
 INSERT INTO record_production_link_openings(id,tenant_id,link_id,opened_at,opened,path)
  VALUES(gen_random_uuid()::text,found_link.tenant_id,found_link.id,clock_timestamp(),p_opened,p_path);
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION ledger_record_production_link_opened(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ledger_record_production_link_opened(text,text,text) TO ledger_app;
