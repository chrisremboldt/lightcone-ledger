-- A credential lets a source or service call the API. An administrator issues and revokes one by a recorded command;
-- Ledger keeps only the SHA-256 hash of its secret. A credential can carry an expiry, and a revoked or expired one is
-- refused at once. A credential the database owner inserts directly (the development seeds and tests do) carries no
-- issue record. Revocation replaces the old enabled flag.
ALTER TABLE api_credentials
  ADD COLUMN id text NOT NULL DEFAULT ('credential-' || gen_random_uuid()),
  ADD COLUMN tenant_id text,
  ADD COLUMN label text,
  ADD COLUMN issue_command_id text,
  ADD COLUMN issued_by text,
  ADD COLUMN issued_at timestamptz,
  ADD COLUMN expires_at timestamptz,
  ADD COLUMN revoke_command_id text,
  ADD COLUMN revoked_by text,
  ADD COLUMN revoked_at timestamptz;
UPDATE api_credentials c SET tenant_id=p.tenant_id FROM principals p WHERE p.id=c.principal_id;
UPDATE api_credentials SET revoked_at=clock_timestamp() WHERE NOT enabled;
ALTER TABLE api_credentials DROP COLUMN enabled;
ALTER TABLE api_credentials
  ALTER COLUMN tenant_id SET NOT NULL,
  ADD CONSTRAINT api_credentials_id_unique UNIQUE (id),
  ADD CONSTRAINT api_credentials_principal FOREIGN KEY (tenant_id,principal_id) REFERENCES principals(tenant_id,id),
  ADD CONSTRAINT api_credentials_label CHECK (label IS NULL OR (length(label) BETWEEN 1 AND 200 AND label ~ '\S')),
  ADD CONSTRAINT api_credentials_issue_record CHECK (
    (issue_command_id IS NULL) = (issued_by IS NULL) AND (issue_command_id IS NULL) = (issued_at IS NULL)
    AND (issue_command_id IS NULL) = (label IS NULL)),
  ADD CONSTRAINT api_credentials_revocation CHECK (
    (revoke_command_id IS NULL) = (revoked_by IS NULL) AND (revoked_at IS NOT NULL OR revoke_command_id IS NULL)),
  ADD CONSTRAINT api_credentials_expiry CHECK (expires_at IS NULL OR issued_at IS NULL OR expires_at>issued_at);
CREATE INDEX api_credentials_by_tenant ON api_credentials(tenant_id,principal_id);

-- The credential belongs to its principal's organization, whoever inserts it.
CREATE FUNCTION ledger_credential_tenant() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 NEW.tenant_id := (SELECT tenant_id FROM principals WHERE id=NEW.principal_id);
 RETURN NEW;
END $$;
CREATE TRIGGER credential_tenant BEFORE INSERT ON api_credentials FOR EACH ROW EXECUTE FUNCTION ledger_credential_tenant();

-- A credential is never deleted or changed, except to be revoked once.
CREATE FUNCTION ledger_credential_revocation_only() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.revoked_at IS NOT NULL
  OR (to_jsonb(NEW) - ARRAY['revoke_command_id','revoked_by','revoked_at'])
   IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['revoke_command_id','revoked_by','revoked_at'])
 THEN RAISE EXCEPTION 'a credential can only be revoked, once';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER credential_revocation_only BEFORE UPDATE OR DELETE ON api_credentials
FOR EACH ROW EXECUTE FUNCTION ledger_credential_revocation_only();

ALTER TABLE api_credentials ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON api_credentials USING (tenant_id=current_setting('ledger.tenant_id',true))
 WITH CHECK (tenant_id=current_setting('ledger.tenant_id',true));
-- The API never reads a hash back: it may write one, and authenticates only through ledger_authenticate.
GRANT SELECT(id,tenant_id,principal_id,label,issue_command_id,issued_by,issued_at,expires_at,revoke_command_id,revoked_by,revoked_at)
 ON api_credentials TO ledger_app;
GRANT INSERT(id,token_hash,principal_id,label,issue_command_id,issued_by,issued_at,expires_at) ON api_credentials TO ledger_app;
GRANT UPDATE(revoke_command_id,revoked_by,revoked_at) ON api_credentials TO ledger_app;

-- As 0081 defines it, with a credential refused once it is revoked or expired.
CREATE OR REPLACE FUNCTION ledger_authenticate(p_hash text, p_issuer text, p_subject text)
RETURNS TABLE(id text,tenant_id text,name text,kind text,capabilities text[],revision bigint,active boolean)
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT p.id,p.tenant_id,p.name,p.kind,p.capabilities,p.revision,p.active FROM principals p
 WHERE (p_hash IS NOT NULL AND EXISTS(SELECT 1 FROM api_credentials c WHERE c.token_hash=p_hash AND c.principal_id=p.id
   AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at>clock_timestamp())))
 OR (p_hash IS NULL AND p_issuer IS NOT NULL AND p_subject IS NOT NULL AND p.sign_in_issuer=p_issuer AND p.sign_in_subject=p_subject);
$$;
