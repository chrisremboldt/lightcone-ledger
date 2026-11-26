-- Notices (docs/design/notices.md): telling a person by email, and an organization by its webhook, that something is
-- theirs or due. A notice is written once, keyed so that the same notice to the same person by the same channel
-- exists once however often its cause is retried; each attempt to send it is a row of its own.

-- Where a person's notices go and which they want. The address is optional; without one a person gets no email.
CREATE TABLE notice_settings (
 tenant_id text NOT NULL,principal_id text NOT NULL,
 email text CHECK(email IS NULL OR (length(email) BETWEEN 3 AND 254 AND email ~ '^[^@\s<>",;]+@[^@\s<>",;]+\.[^@\s<>",;]+$')),
 assigned boolean NOT NULL DEFAULT true,due boolean NOT NULL DEFAULT true,overdue boolean NOT NULL DEFAULT true,
 acknowledgement boolean NOT NULL DEFAULT true,
 digest text NOT NULL DEFAULT 'none' CHECK(digest IN ('none','daily','weekly')),
 updated_at timestamptz NOT NULL,updated_by text NOT NULL,
 PRIMARY KEY(tenant_id,principal_id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES principals(tenant_id,id),
 FOREIGN KEY(tenant_id,updated_by) REFERENCES principals(tenant_id,id)
);

-- An organization's webhook. The secret signs each call; the API's role can write it but never read it back, so it is
-- shown once, when Ledger makes it, and only the workers' role reads it to sign.
CREATE TABLE notice_webhooks (
 tenant_id text PRIMARY KEY REFERENCES tenants(id),
 url text NOT NULL CHECK(length(url) BETWEEN 10 AND 2000 AND url ~ '^https?://[^\s]+$'),
 secret text NOT NULL CHECK(secret ~ '^[A-Za-z0-9_-]{43,128}$'),
 set_at timestamptz NOT NULL,set_by text NOT NULL,
 FOREIGN KEY(tenant_id,set_by) REFERENCES principals(tenant_id,id)
);

-- The outbox. A notice's content is what it says, fixed when it is written; for a safety report or a restricted
-- record it holds the reference and the link only.
CREATE TABLE notices (
 id text PRIMARY KEY,tenant_id text NOT NULL,
 key text NOT NULL CHECK(length(key) BETWEEN 1 AND 400),
 channel text NOT NULL CHECK(channel IN ('email','webhook')),
 recipient_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('assigned','due','overdue','acknowledgement','digest')),
 address text CHECK((channel='email')=(address IS NOT NULL)),
 record_id text,
 content jsonb NOT NULL CHECK(jsonb_typeof(content)='object' AND octet_length(content::text)<=65536
  AND content->>'version'='notice.1' AND content->>'kind'=kind),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,channel,recipient_id,key),
 FOREIGN KEY(tenant_id,recipient_id) REFERENCES principals(tenant_id,id)
);
CREATE INDEX notices_listing ON notices(tenant_id,created_at DESC,id DESC);
CREATE INDEX notices_by_record ON notices(tenant_id,record_id) WHERE record_id IS NOT NULL;

-- Each attempt to send a notice: when, and how it went. The fifth failure, or a notice that cannot be sent at all,
-- is recorded as given up.
CREATE TABLE notice_attempts (
 id text PRIMARY KEY,tenant_id text NOT NULL,notice_id text NOT NULL,
 attempt integer NOT NULL CHECK(attempt BETWEEN 1 AND 5),
 attempted_at timestamptz NOT NULL,
 outcome text NOT NULL CHECK(outcome IN ('sent','failed','given_up')),
 reason text CHECK(reason IS NULL OR length(reason) BETWEEN 1 AND 300),
 CHECK((outcome='sent')=(reason IS NULL)),
 UNIQUE(tenant_id,notice_id,attempt),
 FOREIGN KEY(tenant_id,notice_id) REFERENCES notices(tenant_id,id)
);

-- The sending queue: one row per notice, leased by a worker like the other queues.
CREATE TABLE notice_deliveries (
 tenant_id text NOT NULL,notice_id text NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','leased','done')),
 available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 generation bigint NOT NULL DEFAULT 0,lease_owner text,lease_until timestamptz,
 PRIMARY KEY(tenant_id,notice_id),
 FOREIGN KEY(tenant_id,notice_id) REFERENCES notices(tenant_id,id)
);
CREATE INDEX notice_deliveries_ready ON notice_deliveries(available_at) WHERE state<>'done';

-- When each organization's dated notices and digests are next looked for, leased by one worker at a time.
CREATE TABLE notice_schedules (
 tenant_id text PRIMARY KEY REFERENCES tenants(id),
 available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 generation bigint NOT NULL DEFAULT 0,lease_owner text,lease_until timestamptz
);

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['notice_settings','notice_webhooks','notices','notice_attempts','notice_deliveries',
  'notice_schedules'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_scope ON %I USING(tenant_id=current_setting(''ledger.tenant_id'',true)) WITH CHECK(tenant_id=current_setting(''ledger.tenant_id'',true))',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['notices','notice_attempts'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION ledger_forbid_history_mutation()',t);
 END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON notice_settings TO ledger_app;
GRANT SELECT(tenant_id,url,set_at,set_by),INSERT,DELETE ON notice_webhooks TO ledger_app;
GRANT SELECT(secret) ON notice_webhooks TO ledger_worker;
GRANT SELECT,INSERT ON notices,notice_attempts,notice_deliveries TO ledger_app;
GRANT UPDATE(state,available_at,lease_owner,lease_until) ON notice_deliveries TO ledger_worker;
GRANT SELECT,UPDATE(available_at,lease_owner,lease_until) ON notice_schedules TO ledger_worker;

CREATE FUNCTION ledger_lease_notices(p_owner text,p_limit integer,p_seconds integer)
RETURNS TABLE(tenant_id text,notice_id text,generation bigint,lease_owner text,worker_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
#variable_conflict use_column
BEGIN RETURN QUERY WITH candidates AS (
 SELECT d.tenant_id,d.notice_id FROM notice_deliveries d
 WHERE (d.state='pending' AND d.available_at<=clock_timestamp() OR d.state='leased' AND d.lease_until<clock_timestamp())
 AND EXISTS(SELECT 1 FROM principals p WHERE p.tenant_id=d.tenant_id AND p.kind='worker' AND p.active)
 ORDER BY d.available_at,d.notice_id FOR UPDATE SKIP LOCKED LIMIT LEAST(GREATEST(p_limit,1),100)
), leased AS (
 UPDATE notice_deliveries d SET state='leased',lease_owner=p_owner,
  lease_until=clock_timestamp()+make_interval(secs=>LEAST(GREATEST(p_seconds,1),300)),generation=d.generation+1
 FROM candidates c WHERE d.tenant_id=c.tenant_id AND d.notice_id=c.notice_id
 RETURNING d.tenant_id,d.notice_id,d.generation,d.lease_owner
)
SELECT l.tenant_id,l.notice_id,l.generation,l.lease_owner,p.id FROM leased l
 JOIN LATERAL(SELECT principal.id FROM principals principal WHERE principal.tenant_id=l.tenant_id
  AND principal.kind='worker' AND principal.active ORDER BY principal.id LIMIT 1)p ON true;
END $$;
REVOKE ALL ON FUNCTION ledger_lease_notices(text,integer,integer) FROM PUBLIC,ledger_app;
GRANT EXECUTE ON FUNCTION ledger_lease_notices(text,integer,integer) TO ledger_worker;

-- Every organization has a schedule row; one made after this migration gets its row the first time a worker looks.
CREATE FUNCTION ledger_lease_notice_schedules(p_owner text,p_limit integer,p_seconds integer)
RETURNS TABLE(tenant_id text,generation bigint,lease_owner text,worker_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
#variable_conflict use_column
BEGIN
 INSERT INTO notice_schedules(tenant_id) SELECT t.id FROM tenants t
  WHERE NOT EXISTS(SELECT 1 FROM notice_schedules s WHERE s.tenant_id=t.id) ON CONFLICT DO NOTHING;
 RETURN QUERY WITH candidates AS (
 SELECT s.tenant_id FROM notice_schedules s
 WHERE (s.lease_until IS NULL AND s.available_at<=clock_timestamp() OR s.lease_until<clock_timestamp())
 AND EXISTS(SELECT 1 FROM principals p WHERE p.tenant_id=s.tenant_id AND p.kind='worker' AND p.active)
 ORDER BY s.available_at,s.tenant_id FOR UPDATE SKIP LOCKED LIMIT LEAST(GREATEST(p_limit,1),100)
), leased AS (
 UPDATE notice_schedules s SET lease_owner=p_owner,
  lease_until=clock_timestamp()+make_interval(secs=>LEAST(GREATEST(p_seconds,1),300)),generation=s.generation+1
 FROM candidates c WHERE s.tenant_id=c.tenant_id
 RETURNING s.tenant_id,s.generation,s.lease_owner
)
SELECT l.tenant_id,l.generation,l.lease_owner,p.id FROM leased l
 JOIN LATERAL(SELECT principal.id FROM principals principal WHERE principal.tenant_id=l.tenant_id
  AND principal.kind='worker' AND principal.active ORDER BY principal.id LIMIT 1)p ON true;
END $$;
REVOKE ALL ON FUNCTION ledger_lease_notice_schedules(text,integer,integer) FROM PUBLIC,ledger_app;
GRANT EXECUTE ON FUNCTION ledger_lease_notice_schedules(text,integer,integer) TO ledger_worker;
