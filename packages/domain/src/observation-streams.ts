/**
 * SQL for the latest journal position, per stream, of the events that recorded, withdrew or replaced the observations
 * a query selects. `observations` is an SQL query returning the observations' `tenant_id`, `id` and `event_id`; its
 * parameters are the caller's.
 *
 * Each of the three kinds of event is found through its own index, so the cost follows the observations selected and
 * not the size of the journal, which grows with every evaluation recorded.
 */
export function observationStreamsSql(observations: string): string {
  return `WITH chosen AS MATERIALIZED (${observations})
    SELECT e.stream_id,MAX(e.stream_sequence)::text AS sequence FROM (
      SELECT c.tenant_id,c.event_id FROM chosen c
      UNION ALL SELECT w.tenant_id,w.event_id FROM chosen c
        JOIN observation_withdrawals w ON w.tenant_id=c.tenant_id AND w.observation_id=c.id
      UNION ALL SELECT r.tenant_id,r.event_id FROM chosen c
        JOIN observations r ON r.tenant_id=c.tenant_id AND r.replaces_observation_id=c.id
    ) recorded JOIN journal_events e ON e.tenant_id=recorded.tenant_id AND e.id=recorded.event_id
    GROUP BY e.stream_id`;
}
