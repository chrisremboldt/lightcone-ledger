-- The HTTP process has scoped application permissions but cannot claim global work.
GRANT ledger_app TO ledger_worker;
DROP FUNCTION ledger_lease_work(text,integer,integer);
CREATE FUNCTION ledger_lease_work(p_owner text,p_limit integer,p_seconds integer)
RETURNS TABLE(id text,tenant_id text,event_id text,stream_id text,stream_sequence bigint,generation bigint,worker_id text,lease_owner text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 BEGIN RETURN QUERY WITH candidates AS (
 SELECT w.id FROM work_items w
 WHERE (w.state='pending' AND w.available_at<=clock_timestamp() OR w.state='leased' AND w.lease_until<clock_timestamp())
 AND EXISTS(SELECT 1 FROM principals p WHERE p.tenant_id=w.tenant_id AND p.kind='worker' AND p.active)
 AND NOT EXISTS(SELECT 1 FROM work_items predecessor WHERE predecessor.tenant_id=w.tenant_id AND predecessor.stream_id=w.stream_id AND predecessor.stream_sequence<w.stream_sequence AND predecessor.state NOT IN ('completed','failed'))
 ORDER BY w.available_at,w.id FOR UPDATE SKIP LOCKED LIMIT LEAST(GREATEST(p_limit,1),100)
 ), leased AS (
 UPDATE work_items w SET state='leased',lease_owner=p_owner,
 lease_until=clock_timestamp()+make_interval(secs=>LEAST(GREATEST(p_seconds,1),300)),
 generation=w.generation+1,attempts=w.attempts+1 FROM candidates c WHERE w.id=c.id
 RETURNING w.id,w.tenant_id,w.event_id,w.stream_id,w.stream_sequence,w.generation,w.lease_owner
 )
 SELECT l.id,l.tenant_id,l.event_id,l.stream_id,l.stream_sequence,l.generation,p.id,l.lease_owner
 FROM leased l JOIN LATERAL(SELECT principal.id FROM principals principal WHERE principal.tenant_id=l.tenant_id AND principal.kind='worker' AND principal.active ORDER BY principal.id LIMIT 1)p ON true;
 END $$;
REVOKE ALL ON FUNCTION ledger_lease_work(text,integer,integer) FROM PUBLIC,ledger_app;
GRANT EXECUTE ON FUNCTION ledger_lease_work(text,integer,integer) TO ledger_worker;
