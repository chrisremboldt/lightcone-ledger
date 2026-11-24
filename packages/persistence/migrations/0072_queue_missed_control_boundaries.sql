-- Controls accepted before 0069 had no 'control-boundary' work queued, so their next start or end waited for the next
-- safety decision. This queues, once, the rows the worker queues when it projects a decision that can change the
-- accepted controls (scheduleAcceptedControlBoundaries): for each organization, one row per instant after its latest
-- such decision at which a bound control's effective interval starts or ends, due at that instant, triggered by that
-- decision. Nothing recorded is rewritten. An instant already queued, by a projection or by an earlier run, is kept as
-- it is through the unique index of 0069, so running this again, or after boundaries were queued, adds nothing. An
-- instant already past is due at once: the worker reassembles from now, as it does for any late row.
WITH latest_decision AS (
 SELECT DISTINCT ON(e.tenant_id) e.tenant_id,e.id,e.received_at FROM journal_events e
 WHERE e.event_type='decision.record' AND e.payload#>>'{subject,kind}'='sms'
  AND e.payload#>>'{decision,kind}' IN ('risk.accept','record.close','record.reopen')
 ORDER BY e.tenant_id,e.received_at DESC,e.id DESC
), bound_instant AS (
 SELECT DISTINCT a.tenant_id,boundary FROM accepted_hazard_controls a
 JOIN sms_records h ON h.tenant_id=a.tenant_id AND h.id=a.hazard_id AND h.latest_acceptance_id=a.acceptance_id
 JOIN sms_records c ON c.tenant_id=a.tenant_id AND c.id=a.control_id
 CROSS JOIN LATERAL unnest(ARRAY[a.effective_from,a.effective_until]) boundary
 WHERE h.status<>'closed' AND c.status<>'closed' AND boundary IS NOT NULL
), organization_subject AS (
 -- The subject key of the organization as subjectReferenceKey writes it: its id encoded as encodeURIComponent does.
 SELECT o.tenant_id,o.id,'ledger/organization/'||(
  SELECT string_agg(CASE WHEN ch ~ '^[A-Za-z0-9_.!~*''()-]$' THEN ch
   ELSE regexp_replace(upper(encode(convert_to(ch,'UTF8'),'hex')),'(..)','%\1','g') END,'' ORDER BY n)
  FROM regexp_split_to_table(o.id,'') WITH ORDINALITY AS t(ch,n)) AS subject_key
 FROM organizations o
)
INSERT INTO rule_evaluation_work(id,tenant_id,subject_key,subject_scope,subject_kind,subject_id,pack_id,leaf_id,
 trigger_kind,trigger_event_id,due_at,available_at)
SELECT gen_random_uuid()::text,o.tenant_id,o.subject_key,'ledger','organization',o.id,'ledger.accepted-controls',
 'ledger.accepted-controls','control-boundary',d.id,b.boundary,b.boundary
FROM latest_decision d
JOIN organization_subject o ON o.tenant_id=d.tenant_id
JOIN bound_instant b ON b.tenant_id=d.tenant_id AND b.boundary>d.received_at
ON CONFLICT DO NOTHING;
