CREATE INDEX IF NOT EXISTS command_link_flight_evidence
 ON command_link_source_events(tenant_id,flight_id,event_id);

CREATE OR REPLACE FUNCTION ledger_lease_evaluations(p_owner text,p_limit integer,p_seconds integer,p_leaf_ids text[])
RETURNS TABLE(id text,tenant_id text,flight_id text,trigger_event_id text,leaf_id text,binding_id text,
 due_at timestamptz,clock_mode text,state text,generation bigint,lease_owner text,lease_until timestamptz,
 attempts integer,error text,available_at timestamptz,completed_at timestamptz,worker_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN RETURN QUERY WITH candidates AS (
 SELECT d.id FROM evaluation_deadlines d
 WHERE (d.state='pending' AND d.available_at<=clock_timestamp() OR d.state='leased' AND d.lease_until<clock_timestamp())
 AND d.leaf_id=ANY(p_leaf_ids)
 AND (d.leaf_id<>'ledger.demo.command-link-loss-review' OR NOT EXISTS(
  SELECT 1 FROM command_link_source_events c
  JOIN journal_events e ON e.tenant_id=c.tenant_id AND e.id=c.event_id
  LEFT JOIN timeline_items t ON t.tenant_id=c.tenant_id AND t.id=e.id AND t.flight_id=c.flight_id
  LEFT JOIN projection_offsets p ON p.tenant_id=e.tenant_id AND p.stream_id=e.stream_id
  WHERE c.tenant_id=d.tenant_id AND c.flight_id=d.flight_id
  AND (t.id IS NULL OR COALESCE(p.sequence,0)<e.stream_sequence)
 ))
 AND EXISTS(SELECT 1 FROM principals p WHERE p.tenant_id=d.tenant_id AND p.kind='worker' AND p.active)
 ORDER BY d.available_at,d.id FOR UPDATE SKIP LOCKED LIMIT LEAST(GREATEST(p_limit,1),100)
), leased AS (
 UPDATE evaluation_deadlines d SET state='leased',lease_owner=p_owner,
 lease_until=clock_timestamp()+make_interval(secs=>LEAST(GREATEST(p_seconds,1),300)),
 generation=d.generation+1,attempts=d.attempts+1 FROM candidates c WHERE d.id=c.id RETURNING d.*
)
SELECT l.*,p.id FROM leased l JOIN LATERAL(
 SELECT principal.id FROM principals principal WHERE principal.tenant_id=l.tenant_id
 AND principal.kind='worker' AND principal.active ORDER BY principal.id LIMIT 1
)p ON true;
END $$;
REVOKE ALL ON FUNCTION ledger_lease_evaluations(text,integer,integer,text[]) FROM PUBLIC,ledger_app;
GRANT EXECUTE ON FUNCTION ledger_lease_evaluations(text,integer,integer,text[]) TO ledger_worker;

CREATE OR REPLACE FUNCTION ledger_lease_evaluations(p_owner text,p_limit integer,p_seconds integer)
RETURNS TABLE(id text,tenant_id text,flight_id text,trigger_event_id text,leaf_id text,binding_id text,
 due_at timestamptz,clock_mode text,state text,generation bigint,lease_owner text,lease_until timestamptz,
 attempts integer,error text,available_at timestamptz,completed_at timestamptz,worker_id text)
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT * FROM ledger_lease_evaluations(p_owner,p_limit,p_seconds,
  ARRAY['ledger.demo.landing-disagreement','ledger.demo.missing-landing-evidence']);
$$;

WITH retained AS MATERIALIZED (
 SELECT DISTINCT ON(c.tenant_id,c.flight_id)
  c.tenant_id,c.flight_id,e.id AS event_id,e.payload->'payload'->>'status' AS status
 FROM command_link_source_events c
 JOIN journal_events e ON e.tenant_id=c.tenant_id AND e.id=c.event_id
 JOIN receipts r ON r.tenant_id=c.tenant_id AND r.id=c.receipt_id AND r.flight_id=c.flight_id AND r.link_status='linked'
 WHERE e.event_type='command-link.status'
 ORDER BY c.tenant_id,c.flight_id,(e.payload->'payload'->>'status'='lost') DESC,e.received_at DESC,e.id DESC
)
INSERT INTO evaluation_deadlines(id,tenant_id,flight_id,trigger_event_id,leaf_id,binding_id,due_at,available_at)
SELECT 'command-link-bootstrap.1:'||p.flight_id,p.tenant_id,p.flight_id,p.event_id,
 'ledger.demo.command-link-loss-review','ledger.command-link-status',statement_timestamp(),statement_timestamp()
FROM retained p
WHERE NOT EXISTS(SELECT 1 FROM findings f WHERE f.tenant_id=p.tenant_id AND f.flight_id=p.flight_id
 AND f.leaf_id='ledger.demo.command-link-loss-review')
AND (p.status='lost' OR NOT EXISTS(SELECT 1 FROM flight_evaluations e WHERE e.tenant_id=p.tenant_id
 AND e.flight_id=p.flight_id AND e.leaf_id='ledger.demo.command-link-loss-review'))
ON CONFLICT DO NOTHING;
