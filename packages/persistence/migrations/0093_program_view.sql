-- A program owner's view of the operators it contracts (docs/design/program-owner-view.md). The operator makes a
-- grant whose secret opens one narrow read over the network; the program owner's Ledger keeps what it was told. No
-- table here is read by another organization: row-level security is the same as everywhere.

-- The operator's side. A grant to a named program owner, for a period of a year at most, naming what it covers. Only
-- the SHA-256 of its secret is kept. It is revoked once.
CREATE TABLE program_grants (
 id text PRIMARY KEY,tenant_id text NOT NULL REFERENCES tenants(id),
 program_owner text NOT NULL CHECK(length(program_owner) BETWEEN 1 AND 200 AND program_owner ~ '\S'),
 secret_sha256 text NOT NULL UNIQUE CHECK(secret_sha256 ~ '^[a-f0-9]{64}$'),
 packs text[] NOT NULL CHECK(cardinality(packs)<=20),
 open_findings boolean NOT NULL,
 create_event_id text NOT NULL,created_by text NOT NULL,created_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL CHECK(expires_at>created_at AND expires_at<=created_at+interval '365 days'),
 revoke_event_id text,revoked_by text,revoked_at timestamptz,
 revoke_reason text CHECK(revoke_reason IS NULL OR (length(revoke_reason) BETWEEN 1 AND 1000 AND revoke_reason ~ '\S')),
 UNIQUE(tenant_id,id),
 CHECK((revoke_event_id IS NULL)=(revoked_by IS NULL) AND (revoke_event_id IS NULL)=(revoked_at IS NULL)
  AND (revoke_event_id IS NULL)=(revoke_reason IS NULL)),
 FOREIGN KEY(tenant_id,create_event_id) REFERENCES journal_events(tenant_id,id),
 FOREIGN KEY(tenant_id,created_by) REFERENCES principals(tenant_id,id),
 FOREIGN KEY(tenant_id,revoke_event_id) REFERENCES journal_events(tenant_id,id),
 FOREIGN KEY(tenant_id,revoked_by) REFERENCES principals(tenant_id,id)
);
CREATE INDEX program_grants_listing ON program_grants(tenant_id,created_at DESC,id);
CREATE FUNCTION ledger_program_grant_changes() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE'
  OR (to_jsonb(NEW)-ARRAY['revoke_event_id','revoked_by','revoked_at','revoke_reason'])
   IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['revoke_event_id','revoked_by','revoked_at','revoke_reason'])
  OR OLD.revoked_at IS NOT NULL
 THEN RAISE EXCEPTION 'a program grant is only revoked, once';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER program_grant_changes BEFORE UPDATE OR DELETE ON program_grants
 FOR EACH ROW EXECUTE FUNCTION ledger_program_grant_changes();

-- A produced set a grant names is an ordinary link, made with the grant and ending with it; such a link may run as
-- long as its grant.
ALTER TABLE record_production_links ADD COLUMN program_grant_id text;
ALTER TABLE record_production_links ADD FOREIGN KEY(tenant_id,program_grant_id) REFERENCES program_grants(tenant_id,id);
ALTER TABLE record_production_links DROP CONSTRAINT record_production_links_check;
ALTER TABLE record_production_links ADD CONSTRAINT record_production_links_expiry CHECK(expires_at>created_at
 AND expires_at<=created_at+CASE WHEN program_grant_id IS NULL THEN interval '90 days' ELSE interval '365 days' END);
CREATE INDEX record_production_links_by_grant ON record_production_links(tenant_id,program_grant_id,id)
 WHERE program_grant_id IS NOT NULL;
GRANT SELECT(program_grant_id),INSERT(program_grant_id) ON record_production_links TO ledger_app;

-- Each read of a grant: when, and which parts. Nothing about who read it.
CREATE TABLE program_grant_reads (
 id text PRIMARY KEY,tenant_id text NOT NULL,grant_id text NOT NULL,
 read_at timestamptz NOT NULL,
 parts text[] NOT NULL CHECK(cardinality(parts)<=41),
 FOREIGN KEY(tenant_id,grant_id) REFERENCES program_grants(tenant_id,id)
);
CREATE INDEX program_grant_reads_by_grant ON program_grant_reads(tenant_id,grant_id,read_at DESC,id);
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON program_grant_reads
 FOR EACH ROW EXECUTE FUNCTION ledger_forbid_history_mutation();

-- The program owner's side. An operator it follows: its own name for it, the address of the operator's Ledger and the
-- secret it was given, which the API's role writes and never reads back. Removal is once, and erases the secret.
CREATE TABLE program_operators (
 id text PRIMARY KEY,tenant_id text NOT NULL REFERENCES tenants(id),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200 AND name ~ '\S'),
 address text NOT NULL CHECK(length(address) BETWEEN 10 AND 2000 AND address ~ '^https?://[^\s]+$'),
 secret text CHECK(secret ~ '^ledger-program-[A-Za-z0-9_-]{43}$'),
 add_event_id text NOT NULL,added_by text NOT NULL,added_at timestamptz NOT NULL,
 remove_event_id text,removed_by text,removed_at timestamptz,
 remove_reason text CHECK(remove_reason IS NULL OR (length(remove_reason) BETWEEN 1 AND 1000 AND remove_reason ~ '\S')),
 UNIQUE(tenant_id,id),
 CHECK((remove_event_id IS NULL)=(removed_by IS NULL) AND (remove_event_id IS NULL)=(removed_at IS NULL)
  AND (remove_event_id IS NULL)=(remove_reason IS NULL) AND (remove_event_id IS NULL)=(secret IS NOT NULL)),
 FOREIGN KEY(tenant_id,add_event_id) REFERENCES journal_events(tenant_id,id),
 FOREIGN KEY(tenant_id,added_by) REFERENCES principals(tenant_id,id),
 FOREIGN KEY(tenant_id,remove_event_id) REFERENCES journal_events(tenant_id,id),
 FOREIGN KEY(tenant_id,removed_by) REFERENCES principals(tenant_id,id)
);
CREATE UNIQUE INDEX program_operators_current_name ON program_operators(tenant_id,lower(name)) WHERE removed_at IS NULL;
CREATE FUNCTION ledger_program_operator_changes() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE'
  OR (to_jsonb(NEW)-ARRAY['remove_event_id','removed_by','removed_at','remove_reason','secret'])
   IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['remove_event_id','removed_by','removed_at','remove_reason','secret'])
  OR OLD.removed_at IS NOT NULL
 THEN RAISE EXCEPTION 'an operator followed is only removed, once';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER program_operator_changes BEFORE UPDATE OR DELETE ON program_operators
 FOR EACH ROW EXECUTE FUNCTION ledger_program_operator_changes();

-- When each operator is next read, leased by one worker at a time.
CREATE TABLE program_operator_schedules (
 tenant_id text NOT NULL,operator_id text NOT NULL,
 available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 generation bigint NOT NULL DEFAULT 0,lease_owner text,lease_until timestamptz,
 PRIMARY KEY(tenant_id,operator_id),
 FOREIGN KEY(tenant_id,operator_id) REFERENCES program_operators(tenant_id,id)
);
CREATE INDEX program_operator_schedules_ready ON program_operator_schedules(available_at);

-- Every answer of an operator's Ledger, and every failure to get one.
CREATE TABLE program_operator_answers (
 id text PRIMARY KEY,tenant_id text NOT NULL,operator_id text NOT NULL,
 read_at timestamptz NOT NULL,
 outcome text NOT NULL CHECK(outcome IN ('answered','not_in_use','failed')),
 document jsonb CHECK(document IS NULL OR (jsonb_typeof(document)='object'
  AND document->>'version'='ledger.program-view.1')),
 sha256 text CHECK(sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$'),
 byte_length integer CHECK(byte_length IS NULL OR byte_length BETWEEN 0 AND 1048576),
 reason text CHECK(reason IS NULL OR length(reason) BETWEEN 1 AND 300),
 CHECK((outcome='answered')=(document IS NOT NULL) AND (outcome='answered')=(sha256 IS NOT NULL)
  AND (outcome='answered')=(byte_length IS NOT NULL) AND (outcome='answered')=(reason IS NULL)),
 FOREIGN KEY(tenant_id,operator_id) REFERENCES program_operators(tenant_id,id)
);
CREATE INDEX program_operator_answers_by_operator ON program_operator_answers(tenant_id,operator_id,read_at DESC,id);
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON program_operator_answers
 FOR EACH ROW EXECUTE FUNCTION ledger_forbid_history_mutation();

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['program_grants','program_grant_reads','program_operators','program_operator_schedules',
  'program_operator_answers'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_scope ON %I USING(tenant_id=current_setting(''ledger.tenant_id'',true)) WITH CHECK(tenant_id=current_setting(''ledger.tenant_id'',true))',t);
 END LOOP;
END $$;
-- The API never reads a grant's hash back: an unsigned read reaches a grant only through the functions below.
GRANT SELECT(id,tenant_id,program_owner,packs,open_findings,create_event_id,created_by,created_at,expires_at,
 revoke_event_id,revoked_by,revoked_at,revoke_reason) ON program_grants TO ledger_app;
GRANT INSERT(id,tenant_id,program_owner,secret_sha256,packs,open_findings,create_event_id,created_by,created_at,
 expires_at) ON program_grants TO ledger_app;
GRANT UPDATE(revoke_event_id,revoked_by,revoked_at,revoke_reason) ON program_grants TO ledger_app;
GRANT SELECT ON program_grant_reads TO ledger_app;
-- The API writes an operator's secret and erases it on removal, and never reads it; the workers read it to call.
GRANT SELECT(id,tenant_id,name,address,add_event_id,added_by,added_at,remove_event_id,removed_by,removed_at,
 remove_reason) ON program_operators TO ledger_app;
GRANT INSERT,UPDATE(remove_event_id,removed_by,removed_at,remove_reason,secret) ON program_operators TO ledger_app;
GRANT SELECT(id,tenant_id,name,address,secret,removed_at) ON program_operators TO ledger_worker;
GRANT SELECT,INSERT,UPDATE(available_at) ON program_operator_schedules TO ledger_app;
GRANT SELECT,UPDATE(available_at,lease_owner,lease_until) ON program_operator_schedules TO ledger_worker;
GRANT SELECT ON program_operator_answers TO ledger_app;
GRANT SELECT,INSERT ON program_operator_answers TO ledger_worker;

-- The grant a secret opens while it is in force: its organization, what it covers, and the worker principal whose
-- scope the parts are read in. Called before any organization is known, so it reads across organizations by the hash
-- alone and returns nothing else.
CREATE FUNCTION ledger_program_grant(p_secret_sha256 text)
RETURNS TABLE(grant_id text,tenant_id text,organization_name text,expires_at timestamptz,packs text[],
 open_findings boolean,worker_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT g.id,g.tenant_id,t.name,g.expires_at,g.packs,g.open_findings,w.id
 FROM program_grants g
 JOIN tenants t ON t.id=g.tenant_id
 JOIN LATERAL(SELECT p.id FROM principals p WHERE p.tenant_id=g.tenant_id AND p.kind='worker' AND p.active
  ORDER BY p.id LIMIT 1) w ON true
 WHERE g.secret_sha256=p_secret_sha256 AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp();
$$;
REVOKE ALL ON FUNCTION ledger_program_grant(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ledger_program_grant(text) TO ledger_app;

-- Keeps one read of a grant still in force, and nothing else; false when it is not in force. The grant is found
-- FOR KEY SHARE, so a revocation in progress is waited for and then finds nothing.
CREATE FUNCTION ledger_program_grant_read(p_secret_sha256 text,p_parts text[])
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE found_grant record;
BEGIN
 SELECT g.id,g.tenant_id INTO found_grant FROM program_grants g
  WHERE g.secret_sha256=p_secret_sha256 AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp() FOR KEY SHARE;
 IF NOT FOUND THEN RETURN false; END IF;
 INSERT INTO program_grant_reads(id,tenant_id,grant_id,read_at,parts)
  VALUES(gen_random_uuid()::text,found_grant.tenant_id,found_grant.id,clock_timestamp(),p_parts);
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION ledger_program_grant_read(text,text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ledger_program_grant_read(text,text[]) TO ledger_app;

CREATE FUNCTION ledger_lease_program_reads(p_owner text,p_limit integer,p_seconds integer)
RETURNS TABLE(tenant_id text,operator_id text,generation bigint,lease_owner text,worker_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
#variable_conflict use_column
BEGIN RETURN QUERY WITH candidates AS (
 SELECT s.tenant_id,s.operator_id FROM program_operator_schedules s
 JOIN program_operators o ON o.tenant_id=s.tenant_id AND o.id=s.operator_id AND o.removed_at IS NULL
 WHERE (s.lease_until IS NULL AND s.available_at<=clock_timestamp() OR s.lease_until<clock_timestamp())
 AND EXISTS(SELECT 1 FROM principals p WHERE p.tenant_id=s.tenant_id AND p.kind='worker' AND p.active)
 ORDER BY s.available_at,s.operator_id FOR UPDATE OF s SKIP LOCKED LIMIT LEAST(GREATEST(p_limit,1),100)
), leased AS (
 UPDATE program_operator_schedules s SET lease_owner=p_owner,
  lease_until=clock_timestamp()+make_interval(secs=>LEAST(GREATEST(p_seconds,1),300)),generation=s.generation+1
 FROM candidates c WHERE s.tenant_id=c.tenant_id AND s.operator_id=c.operator_id
 RETURNING s.tenant_id,s.operator_id,s.generation,s.lease_owner
)
SELECT l.tenant_id,l.operator_id,l.generation,l.lease_owner,p.id FROM leased l
 JOIN LATERAL(SELECT principal.id FROM principals principal WHERE principal.tenant_id=l.tenant_id
  AND principal.kind='worker' AND principal.active ORDER BY principal.id LIMIT 1)p ON true;
END $$;
REVOKE ALL ON FUNCTION ledger_lease_program_reads(text,integer,integer) FROM PUBLIC,ledger_app;
GRANT EXECUTE ON FUNCTION ledger_lease_program_reads(text,integer,integer) TO ledger_worker;

-- The queue figures of migration 0092, with the reads of followed operators added.
CREATE OR REPLACE FUNCTION ledger_queue_figures()
RETURNS TABLE(queue text,ready bigint,leased bigint,oldest_ready_seconds double precision)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH items(queue,state,ready_since,lease_until) AS (
  SELECT 'projection',state,available_at,lease_until FROM work_items WHERE state IN ('pending','leased')
  UNION ALL
  SELECT 'rule_selection',state,GREATEST(available_at,due_at),lease_until FROM selection_work
   WHERE state IN ('pending','leased')
  UNION ALL
  SELECT 'evaluation_deadline',state,available_at,lease_until FROM evaluation_deadlines
   WHERE state IN ('pending','leased')
  UNION ALL
  SELECT 'rule_evaluation',state,GREATEST(available_at,due_at),lease_until FROM rule_evaluation_work
   WHERE state IN ('pending','leased')
  UNION ALL
  SELECT 'notice_delivery',state,available_at,lease_until FROM notice_deliveries WHERE state IN ('pending','leased')
  UNION ALL
  SELECT 'notice_schedule',CASE WHEN lease_until IS NULL THEN 'pending' ELSE 'leased' END,available_at,lease_until
   FROM notice_schedules
  UNION ALL
  SELECT 'program_read',CASE WHEN s.lease_until IS NULL THEN 'pending' ELSE 'leased' END,s.available_at,s.lease_until
   FROM program_operator_schedules s
   JOIN program_operators o ON o.tenant_id=s.tenant_id AND o.id=s.operator_id AND o.removed_at IS NULL
 ), classed AS (
  SELECT queue,
   CASE WHEN state='leased' AND lease_until>=now() THEN 'leased'
    WHEN state='leased' THEN 'ready'
    WHEN ready_since<=now() THEN 'ready' END AS class,
   CASE WHEN state='leased' THEN lease_until ELSE ready_since END AS since
  FROM items
 )
 SELECT q.queue,
  count(*) FILTER (WHERE c.class='ready'),
  count(*) FILTER (WHERE c.class='leased'),
  COALESCE(EXTRACT(EPOCH FROM now()-min(c.since) FILTER (WHERE c.class='ready'))::double precision,0)
 FROM unnest(ARRAY['projection','rule_selection','evaluation_deadline','rule_evaluation','notice_delivery',
  'notice_schedule','program_read']) AS q(queue)
 LEFT JOIN classed c ON c.queue=q.queue
 GROUP BY q.queue ORDER BY q.queue;
$$;
REVOKE ALL ON FUNCTION ledger_queue_figures() FROM PUBLIC,ledger_app;
GRANT EXECUTE ON FUNCTION ledger_queue_figures() TO ledger_worker;
