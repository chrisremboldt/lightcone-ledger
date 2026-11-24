-- A person's sign-in account is an OpenID Connect issuer and subject from any provider the deployment configures.
-- The columns are renamed to say so; the pair stays unique, and the authentication function reads the new names.
ALTER TABLE principals RENAME COLUMN clerk_issuer TO sign_in_issuer;
ALTER TABLE principals RENAME COLUMN clerk_subject TO sign_in_subject;
CREATE OR REPLACE FUNCTION ledger_authenticate(p_hash text, p_issuer text, p_subject text)
RETURNS TABLE(id text,tenant_id text,name text,kind text,capabilities text[],revision bigint,active boolean)
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT p.id,p.tenant_id,p.name,p.kind,p.capabilities,p.revision,p.active FROM principals p
 WHERE (p_hash IS NOT NULL AND EXISTS(SELECT 1 FROM api_credentials c WHERE c.token_hash=p_hash AND c.principal_id=p.id AND c.enabled))
 OR (p_hash IS NULL AND p_issuer IS NOT NULL AND p_subject IS NOT NULL AND p.sign_in_issuer=p_issuer AND p.sign_in_subject=p_subject);
$$;
