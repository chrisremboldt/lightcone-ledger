CREATE TABLE subject_stream_dependencies (
 tenant_id text NOT NULL,subject_id text NOT NULL,stream_id text NOT NULL,
 sequence bigint NOT NULL CHECK(sequence BETWEEN 1 AND 9007199254740991),event_id text NOT NULL,
 PRIMARY KEY(tenant_id,subject_id,stream_id),
 FOREIGN KEY(tenant_id,subject_id) REFERENCES subjects(tenant_id,id),
 FOREIGN KEY(tenant_id,stream_id) REFERENCES streams(tenant_id,id),
 FOREIGN KEY(tenant_id,event_id) REFERENCES journal_events(tenant_id,id)
);
CREATE TABLE subject_dependencies (
 tenant_id text NOT NULL,subject_id text NOT NULL,dependency_subject_id text NOT NULL,event_id text NOT NULL,
 PRIMARY KEY(tenant_id,subject_id,dependency_subject_id),
 FOREIGN KEY(tenant_id,subject_id) REFERENCES subjects(tenant_id,id),
 FOREIGN KEY(tenant_id,dependency_subject_id) REFERENCES subjects(tenant_id,id),
 FOREIGN KEY(tenant_id,event_id) REFERENCES journal_events(tenant_id,id)
);
CREATE INDEX subject_dependency_dependents ON subject_dependencies(tenant_id,dependency_subject_id,subject_id);
CREATE FUNCTION ledger_protect_subject_frontier() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND (NEW.tenant_id<>OLD.tenant_id OR NEW.subject_id<>OLD.subject_id OR NEW.stream_id<>OLD.stream_id OR NEW.sequence<=OLD.sequence) THEN
  RAISE EXCEPTION 'Subject evidence frontiers may only advance';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM journal_events e WHERE e.tenant_id=NEW.tenant_id AND e.id=NEW.event_id AND e.stream_id=NEW.stream_id AND e.stream_sequence=NEW.sequence) THEN
  RAISE EXCEPTION 'Subject evidence frontier must identify its retained journal event';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER retain_subject_frontier BEFORE INSERT OR UPDATE ON subject_stream_dependencies FOR EACH ROW EXECUTE FUNCTION ledger_protect_subject_frontier();
CREATE TRIGGER immutable_subject_frontier BEFORE DELETE ON subject_stream_dependencies FOR EACH ROW EXECUTE FUNCTION ledger_forbid_history_mutation();
CREATE TRIGGER immutable_subject_dependency BEFORE UPDATE OR DELETE ON subject_dependencies FOR EACH ROW EXECUTE FUNCTION ledger_forbid_history_mutation();
ALTER TABLE subject_stream_dependencies ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON subject_stream_dependencies USING(tenant_id=current_setting('ledger.tenant_id',true)) WITH CHECK(tenant_id=current_setting('ledger.tenant_id',true));
ALTER TABLE subject_dependencies ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON subject_dependencies USING(tenant_id=current_setting('ledger.tenant_id',true)) WITH CHECK(tenant_id=current_setting('ledger.tenant_id',true));
GRANT SELECT,INSERT ON subject_stream_dependencies,subject_dependencies TO ledger_app;
GRANT UPDATE(sequence,event_id) ON subject_stream_dependencies TO ledger_app;

WITH RECURSIVE direct_events(tenant_id,subject_id,event_id) AS (
 SELECT f.tenant_id,f.id,e.id FROM flight_views f JOIN streams s ON s.tenant_id=f.tenant_id AND s.name='flight:'||f.id
 JOIN journal_events e ON e.tenant_id=s.tenant_id AND e.stream_id=s.id AND e.stream_sequence=s.sequence
 UNION
 SELECT t.tenant_id,t.flight_id,t.id FROM timeline_items t
 UNION
 SELECT c.tenant_id,c.flight_id,c.event_id FROM claims c
 UNION
 SELECT r.tenant_id,r.flight_id,r.event_id FROM receipts r WHERE r.flight_id IS NOT NULL
 UNION
 SELECT r.tenant_id,f.id,r.event_id FROM receipts r JOIN flight_views f ON f.tenant_id=r.tenant_id AND (
  r.input_subject->>'flightId'=f.id OR r.input_subject->>'originationKey'=f.origination_key OR
  r.kind='intent.revision' AND COALESCE(r.payload->'intent'->>'originationKey',r.payload->>'originationKey')=f.origination_key)
 UNION
 SELECT r.tenant_id,a.subject_id,r.event_id FROM receipts r JOIN aliases a ON a.tenant_id=r.tenant_id
  AND a.source_id=r.source_id AND a.external_id=r.input_subject->>'externalFlightId'
  AND (a.valid_from IS NULL OR a.valid_from<=r.occurred_at) AND (a.valid_to IS NULL OR a.valid_to>r.occurred_at)
 UNION
 SELECT f.tenant_id,f.flight_id,r.event_id FROM fulfillments f JOIN receipts r ON r.tenant_id=f.tenant_id
  AND r.source_id=f.source_id AND r.kind='order.revision'
  AND COALESCE(r.order_id,r.input_subject->>'orderId',r.payload->>'externalId')=f.order_external_id
 UNION
 SELECT r.tenant_id,f.id,r.event_id FROM receipts r
 CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(r.payload->'fulfillments')='array' THEN r.payload->'fulfillments' ELSE '[]'::jsonb END) fulfillment
 JOIN flight_views f ON f.tenant_id=r.tenant_id AND f.origination_key=fulfillment->>'originationKey'
 WHERE r.kind='order.revision'
 UNION
 SELECT f.tenant_id,f.flight_id,o.event_id FROM fulfillments f JOIN operational_orders o
  ON o.tenant_id=f.tenant_id AND o.source_id=f.source_id AND o.external_id=f.order_external_id
 UNION
 SELECT r.tenant_id,r.flight_id,r.event_id FROM relations r
 UNION
 SELECT f.tenant_id,f.id,r.event_id FROM flight_views f JOIN source_intent_revisions r
  ON r.tenant_id=f.tenant_id AND r.origination_key=f.origination_key
), relevant_events(tenant_id,subject_id,event_id) AS (
 SELECT * FROM direct_events
 UNION
 SELECT r.tenant_id,r.subject_id,e.causation_id FROM relevant_events r
 JOIN journal_events e ON e.tenant_id=r.tenant_id AND e.id=r.event_id
 WHERE e.causation_id IS NOT NULL
)
INSERT INTO subject_stream_dependencies(tenant_id,subject_id,stream_id,sequence,event_id)
SELECT DISTINCT ON(r.tenant_id,r.subject_id,e.stream_id) r.tenant_id,r.subject_id,e.stream_id,e.stream_sequence,e.id
FROM relevant_events r JOIN journal_events e ON e.tenant_id=r.tenant_id AND e.id=r.event_id
JOIN subjects s ON s.tenant_id=r.tenant_id AND s.id=r.subject_id
ORDER BY r.tenant_id,r.subject_id,e.stream_id,e.stream_sequence DESC;

CREATE INDEX view_changes_tenant_revision ON view_changes(tenant_id,id);
CREATE INDEX work_items_tenant_outstanding ON work_items(tenant_id) WHERE state<>'completed';
