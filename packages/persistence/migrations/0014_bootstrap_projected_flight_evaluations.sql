INSERT INTO evaluation_deadlines(id,tenant_id,flight_id,trigger_event_id,leaf_id,binding_id,due_at,available_at)
SELECT 'evaluation-bootstrap.1:'||f.id,f.tenant_id,f.id,basis.event_id,
 'ledger.demo.missing-landing-evidence','ledger.flight-observation',statement_timestamp(),statement_timestamp()
FROM flight_views f
JOIN LATERAL (
 SELECT retained.event_id FROM (
  SELECT e.id AS event_id,e.received_at FROM timeline_items t
  JOIN journal_events e ON e.tenant_id=t.tenant_id AND e.id=t.id
  JOIN projection_offsets p ON p.tenant_id=e.tenant_id AND p.stream_id=e.stream_id AND p.sequence>=e.stream_sequence
  WHERE t.tenant_id=f.tenant_id AND t.flight_id=f.id
  UNION ALL
  SELECT e.id,e.received_at FROM streams s
  JOIN journal_events e ON e.tenant_id=s.tenant_id AND e.stream_id=s.id AND e.stream_sequence=1 AND e.event_type='flight.created'
  JOIN projection_offsets p ON p.tenant_id=e.tenant_id AND p.stream_id=e.stream_id AND p.sequence>=e.stream_sequence
  WHERE s.tenant_id=f.tenant_id AND s.name='flight:'||f.id
 ) retained ORDER BY retained.received_at DESC,retained.event_id DESC LIMIT 1
) basis ON true
WHERE f.activity IN ('planned','active')
AND NOT EXISTS(SELECT 1 FROM flight_evaluations e WHERE e.tenant_id=f.tenant_id AND e.flight_id=f.id)
ON CONFLICT DO NOTHING;
