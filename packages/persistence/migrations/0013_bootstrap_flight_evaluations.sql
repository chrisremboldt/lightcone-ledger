INSERT INTO evaluation_deadlines(id,tenant_id,flight_id,trigger_event_id,leaf_id,binding_id,due_at,available_at)
SELECT 'evaluation-bootstrap.1:'||f.id,f.tenant_id,f.id,basis.event_id,
 'ledger.demo.missing-landing-evidence','ledger.flight-observation',statement_timestamp(),statement_timestamp()
FROM flight_views f
JOIN LATERAL (
 SELECT d.event_id FROM subject_stream_dependencies d
 JOIN journal_events e ON e.tenant_id=d.tenant_id AND e.id=d.event_id
 JOIN projection_offsets p ON p.tenant_id=d.tenant_id AND p.stream_id=d.stream_id AND p.sequence>=d.sequence
 WHERE d.tenant_id=f.tenant_id AND d.subject_id=f.id
 ORDER BY e.received_at DESC,e.id DESC LIMIT 1
) basis ON true
WHERE f.activity IN ('planned','active')
AND NOT EXISTS(SELECT 1 FROM flight_evaluations e WHERE e.tenant_id=f.tenant_id AND e.flight_id=f.id)
ON CONFLICT DO NOTHING;
