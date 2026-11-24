ALTER TABLE decision_packet_records DROP CONSTRAINT decision_packet_records_format_check;
ALTER TABLE decision_packet_records ADD CONSTRAINT decision_packet_records_format_check
 CHECK(format IN ('ledger.decision-packet.1','ledger.decision-packet.2'));

ALTER TABLE selection_work DROP CONSTRAINT selection_work_kind_check;
ALTER TABLE selection_work DROP CONSTRAINT selection_work_check;
ALTER TABLE selection_work ADD CONSTRAINT selection_work_kind_check
 CHECK(kind IN ('bootstrap','adoption','refresh','start','end','execution_bootstrap','execution'));
ALTER TABLE selection_work ADD CONSTRAINT selection_work_check CHECK(
 (kind IN ('bootstrap','execution_bootstrap') AND flight_id IS NULL AND adoption_id IS NULL AND phase IS NULL)
 OR (kind='adoption' AND flight_id IS NULL AND adoption_id IS NOT NULL AND phase IS NOT NULL)
 OR (kind='refresh' AND flight_id IS NOT NULL AND cursor_flight_id IS NULL
  AND (adoption_id IS NULL AND phase IS NULL OR adoption_id IS NOT NULL AND phase IS NOT NULL))
 OR (kind='execution' AND flight_id IS NOT NULL AND adoption_id IS NULL AND phase IS NULL AND cursor_flight_id IS NULL)
 OR (kind IN ('start','end') AND flight_id IS NOT NULL AND adoption_id IS NOT NULL AND phase IS NULL AND cursor_flight_id IS NULL)
);
CREATE UNIQUE INDEX selection_execution_bootstrap_identity ON selection_work(tenant_id,organization_id) WHERE kind='execution_bootstrap';
CREATE UNIQUE INDEX selection_execution_identity ON selection_work(tenant_id,flight_id) WHERE kind='execution';

CREATE OR REPLACE FUNCTION ledger_guard_flight_rule_selection() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE org organizations%ROWTYPE; selected jsonb; adoption_revision bigint; projected_adoption_revision bigint;
BEGIN
 IF NEW.flight_id IS NULL OR NEW.kind NOT IN ('decision.record','evidence.correct','flight.assign') THEN
  RETURN NEW;
 END IF;
 PERFORM 1 FROM flight_views f WHERE f.tenant_id=NEW.tenant_id AND f.id=NEW.flight_id FOR UPDATE;
 SELECT o.* INTO org FROM organizations o WHERE o.tenant_id=NEW.tenant_id FOR SHARE;
 IF NOT EXISTS(
  SELECT 1 FROM organization_pack_adoptions a WHERE a.tenant_id=NEW.tenant_id AND a.organization_id=org.id
  AND a.pack_id='ledger.demo-procedures' AND a.record->'pack'->>'version'='3'
  AND a.record->'pack'->>'digest'='46f777c1c391b696cffc45b450cb61b8563b28417f67ac087522b57e34e56188'
 ) THEN RETURN NEW; END IF;
 SELECT COALESCE(MAX(a.accepted_revision),0),COALESCE(MAX(a.accepted_revision) FILTER(WHERE v.id IS NOT NULL),0)
 INTO adoption_revision,projected_adoption_revision FROM organization_pack_adoptions a
 LEFT JOIN organization_pack_adoption_views v ON v.tenant_id=a.tenant_id AND v.id=a.id
 WHERE a.tenant_id=NEW.tenant_id AND a.organization_id=org.id;
 SELECT s.record INTO selected FROM flight_rule_selection_views v
 JOIN flight_rule_selections s ON s.tenant_id=v.tenant_id AND s.flight_id=v.flight_id AND s.id=v.current_id
 WHERE v.tenant_id=NEW.tenant_id AND v.flight_id=NEW.flight_id;
 IF selected IS NULL
  OR selected->>'version' IS DISTINCT FROM 'flight.rule-selection.2'
  OR selected->'execution'->>'policyVersion' IS DISTINCT FROM 'ledger.company-c2-execution.1'
  OR selected->'execution'->'evaluator'->>'digest' IS DISTINCT FROM 'c25bef5721e555b19b3db564f6999d0fae967db642e7e5a56cd5dba490f46482'
  OR selected->>'flightId' IS DISTINCT FROM NEW.flight_id
  OR selected->>'organizationId' IS DISTINCT FROM org.id
  OR (selected->>'adoptionRevision')::bigint IS DISTINCT FROM adoption_revision
  OR (selected->>'projectedAdoptionRevision')::bigint IS DISTINCT FROM projected_adoption_revision
  OR (selected->'nextBoundary'->>'at')::timestamptz<=clock_timestamp() THEN
  RAISE EXCEPTION 'Flight rule selection changed; refresh and review the current basis' USING ERRCODE='40001';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ledger_guard_flight_rule_selection() FROM PUBLIC,ledger_app;

CREATE FUNCTION ledger_lease_rule_selections(p_owner text,p_limit integer,p_seconds integer,p_kinds text[])
RETURNS TABLE(id text,tenant_id text,organization_id text,kind text,flight_id text,adoption_id text,phase text,
 cursor_flight_id text,due_at timestamptz,available_at timestamptz,state text,generation bigint,
 lease_owner text,lease_until timestamptz,attempts integer,error text,completed_at timestamptz,worker_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN RETURN QUERY WITH candidates AS (
 SELECT w.id FROM selection_work w
 WHERE ((w.state='pending' AND w.available_at<=clock_timestamp() AND w.due_at<=clock_timestamp())
  OR (w.state='leased' AND w.lease_until<clock_timestamp()))
 AND w.kind=ANY(p_kinds)
 AND EXISTS(SELECT 1 FROM principals p WHERE p.tenant_id=w.tenant_id AND p.kind='worker' AND p.active)
 ORDER BY w.available_at,w.id FOR UPDATE SKIP LOCKED LIMIT LEAST(GREATEST(p_limit,1),100)
), leased AS (
 UPDATE selection_work w SET state='leased',lease_owner=p_owner,
 lease_until=clock_timestamp()+make_interval(secs=>LEAST(GREATEST(p_seconds,1),300)),
 generation=w.generation+1,attempts=w.attempts+1 FROM candidates c WHERE w.id=c.id RETURNING w.*
)
SELECT l.id,l.tenant_id,l.organization_id,l.kind,l.flight_id,l.adoption_id,l.phase,l.cursor_flight_id,
 l.due_at,l.available_at,l.state,l.generation,l.lease_owner,l.lease_until,l.attempts,l.error,l.completed_at,p.id
FROM leased l JOIN LATERAL(
 SELECT principal.id FROM principals principal WHERE principal.tenant_id=l.tenant_id
 AND principal.kind='worker' AND principal.active ORDER BY principal.id LIMIT 1
)p ON true;
END $$;
REVOKE ALL ON FUNCTION ledger_lease_rule_selections(text,integer,integer,text[]) FROM PUBLIC,ledger_app;
GRANT EXECUTE ON FUNCTION ledger_lease_rule_selections(text,integer,integer,text[]) TO ledger_worker;


CREATE OR REPLACE FUNCTION ledger_lease_rule_selections(p_owner text,p_limit integer,p_seconds integer)
RETURNS TABLE(id text,tenant_id text,organization_id text,kind text,flight_id text,adoption_id text,phase text,
 cursor_flight_id text,due_at timestamptz,available_at timestamptz,state text,generation bigint,
 lease_owner text,lease_until timestamptz,attempts integer,error text,completed_at timestamptz,worker_id text)
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT * FROM ledger_lease_rule_selections(p_owner,p_limit,p_seconds,
  ARRAY['bootstrap','adoption','refresh','start','end']);
$$;

INSERT INTO selection_work(id,tenant_id,organization_id,kind)
SELECT 'c2-execution-bootstrap.1:'||o.id,o.tenant_id,o.id,'execution_bootstrap' FROM organizations o;
