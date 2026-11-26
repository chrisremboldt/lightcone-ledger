-- How much work waits in each queue, across every organization, for the workers' metrics. Row-level security shows a
-- worker one organization at a time, so only a security-definer function can count all of them. It returns one row
-- per queue: the items ready to run now (pending and due, or leased with the lease run out), the items held under a
-- live lease, and how long the longest-ready item has waited. Nothing names an organization, a record or a person.
CREATE FUNCTION ledger_queue_figures()
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
  'notice_schedule']) AS q(queue)
 LEFT JOIN classed c ON c.queue=q.queue
 GROUP BY q.queue ORDER BY q.queue;
$$;
REVOKE ALL ON FUNCTION ledger_queue_figures() FROM PUBLIC,ledger_app;
GRANT EXECUTE ON FUNCTION ledger_queue_figures() TO ledger_worker;
