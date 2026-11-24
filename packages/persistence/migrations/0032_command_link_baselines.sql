CREATE UNIQUE INDEX command_link_session_first_event
 ON command_link_sessions(tenant_id,source_id,source_session_id,first_event_id);

CREATE TABLE command_link_baselines (
 id text PRIMARY KEY,tenant_id text NOT NULL,receipt_id text NOT NULL,
 flight_id text NOT NULL,aircraft_id text NOT NULL,source_id text NOT NULL,
 source_session_id text NOT NULL,source_event_id text NOT NULL,artifact_id text NOT NULL,actor_id text NOT NULL,
 occurred_at timestamptz NOT NULL,recorded_at timestamptz NOT NULL,
 record jsonb NOT NULL CHECK(jsonb_typeof(record)='object' AND octet_length(record::text)<=65536),
 record_digest text NOT NULL CHECK(record_digest ~ '^[a-f0-9]{64}$'),
 CHECK(isfinite(occurred_at) AND isfinite(recorded_at) AND occurred_at<=recorded_at),
 CHECK(record->>'eventId' IS NOT DISTINCT FROM id AND record->>'receiptId' IS NOT DISTINCT FROM receipt_id
  AND (record->>'recordedAt')::timestamptz IS NOT DISTINCT FROM recorded_at
  AND record#>>'{input,kind}' IS NOT DISTINCT FROM 'command-link.baseline'
  AND record#>>'{input,fidelity}' IS NOT DISTINCT FROM 'synthetic_contract'
  AND record#>>'{input,sourceId}' IS NOT DISTINCT FROM source_id
  AND record#>>'{input,sourceSessionId}' IS NOT DISTINCT FROM source_session_id
  AND record#>>'{input,subject,flightId}' IS NOT DISTINCT FROM flight_id
  AND record#>>'{input,artifactId}' IS NOT DISTINCT FROM artifact_id
  AND (record#>>'{input,occurredAt}')::timestamptz IS NOT DISTINCT FROM occurred_at
  AND record#>>'{input,payload,version}' IS NOT DISTINCT FROM 'command-link.baseline.1'
  AND record#>>'{input,payload,sourceEventId}' IS NOT DISTINCT FROM source_event_id
  AND record#>>'{input,payload,aircraftId}' IS NOT DISTINCT FROM aircraft_id
  AND COALESCE(record#>>'{input,payload,state}' IN ('up','down','unknown'),false)
  AND record#>>'{authority,version}' IS NOT DISTINCT FROM 'ledger.command-link-baseline-authority.1'
  AND record#>>'{authority,principalId}' IS NOT DISTINCT FROM actor_id
  AND record#>>'{authority,tenantId}' IS NOT DISTINCT FROM tenant_id
  AND record#>>'{authority,inputKind}' IS NOT DISTINCT FROM 'command-link.baseline'
  AND record#>>'{authority,sourceId}' IS NOT DISTINCT FROM source_id
  AND record#>>'{original,artifactId}' IS NOT DISTINCT FROM artifact_id),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,receipt_id),UNIQUE(tenant_id,flight_id,id),
 UNIQUE(tenant_id,source_id,source_session_id),
 FOREIGN KEY(tenant_id,id) REFERENCES journal_events(tenant_id,id),
 FOREIGN KEY(tenant_id,id) REFERENCES command_link_source_events(tenant_id,event_id),
 FOREIGN KEY(tenant_id,receipt_id) REFERENCES command_link_source_events(tenant_id,receipt_id),
 FOREIGN KEY(tenant_id,receipt_id) REFERENCES receipts(tenant_id,id),
 FOREIGN KEY(tenant_id,flight_id) REFERENCES flight_views(tenant_id,id),
 FOREIGN KEY(tenant_id,artifact_id) REFERENCES artifacts(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES principals(tenant_id,id),
 FOREIGN KEY(tenant_id,source_id,source_session_id,flight_id,aircraft_id)
  REFERENCES command_link_sessions(tenant_id,source_id,source_session_id,flight_id,aircraft_id),
 FOREIGN KEY(tenant_id,source_id,source_session_id,id)
  REFERENCES command_link_sessions(tenant_id,source_id,source_session_id,first_event_id)
);

CREATE FUNCTION ledger_check_command_link_baseline() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE
 retained_authority jsonb;
BEGIN
 SELECT jsonb_build_object('version','ledger.command-link-baseline-authority.1',
  'principalId',p.id,'tenantId',p.tenant_id,'principalRevision',p.revision,
  'inputKind','command-link.baseline','sourceId',NEW.source_id,
  'requiredCapabilities',jsonb_build_array('input:write','command-link:write'),
  'grantedSources',to_jsonb(p.command_link_sources)) INTO retained_authority
 FROM principals p WHERE p.tenant_id=NEW.tenant_id AND p.id=NEW.actor_id AND p.active
  AND p.id=current_setting('ledger.principal_id',true)
  AND p.capabilities @> ARRAY['input:write','command-link:write']::text[]
  AND NEW.source_id=ANY(p.command_link_sources) FOR SHARE;
 IF NOT FOUND OR NEW.record->'authority' IS DISTINCT FROM retained_authority THEN
  RAISE EXCEPTION 'Baseline authority differs from its accepting principal' USING ERRCODE='23514';
 END IF;
 PERFORM 1 FROM journal_events e JOIN streams s ON s.tenant_id=e.tenant_id AND s.id=e.stream_id
 JOIN receipts r ON r.tenant_id=e.tenant_id AND r.event_id=e.id AND r.id=NEW.receipt_id
 JOIN artifacts a ON a.tenant_id=e.tenant_id AND a.id=NEW.artifact_id
 JOIN command_link_source_events c ON c.tenant_id=e.tenant_id AND c.event_id=e.id AND c.receipt_id=r.id
 WHERE e.tenant_id=NEW.tenant_id AND e.id=NEW.id AND e.event_type='command-link.baseline'
  AND e.principal_id=NEW.actor_id AND e.source_id=NEW.source_id AND e.source_session_id=NEW.source_session_id
  AND e.artifact_id=NEW.artifact_id AND e.occurred_at=NEW.occurred_at AND e.received_at=NEW.recorded_at
  AND e.effective_at IS NULL AND s.name='source:'||NEW.actor_id||':'||NEW.source_id||':'||NEW.source_session_id
  AND e.payload=(NEW.record->'input')||jsonb_build_object('flightId',NEW.flight_id,'acceptedAuthority',retained_authority)
  AND r.kind='command-link.baseline' AND r.source_id=NEW.source_id AND r.flight_id=NEW.flight_id
  AND r.artifact_id=NEW.artifact_id AND r.link_status='linked'
  AND r.occurred_at=NEW.occurred_at AND r.received_at=NEW.recorded_at
  AND r.payload=NEW.record#>'{input,payload}' AND r.input_subject=NEW.record#>'{input,subject}'
  AND a.content_type='application/json' AND a.byte_length BETWEEN 1 AND 65536
  AND NEW.record->'original'=jsonb_build_object('artifactId',a.id,'sha256',a.sha256,'byteLength',a.byte_length)
  AND c.source_id=NEW.source_id AND c.source_session_id=NEW.source_session_id
  AND c.source_event_id=NEW.source_event_id AND c.flight_id=NEW.flight_id AND c.aircraft_id=NEW.aircraft_id;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Baseline differs from its immutable journal, receipt or source binding' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ledger_check_command_link_baseline() FROM PUBLIC,ledger_app;
CREATE TRIGGER command_link_baseline_acceptance BEFORE INSERT ON command_link_baselines
 FOR EACH ROW EXECUTE FUNCTION ledger_check_command_link_baseline();

ALTER TABLE command_link_baselines ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON command_link_baselines
 USING(tenant_id=current_setting('ledger.tenant_id',true))
 WITH CHECK(tenant_id=current_setting('ledger.tenant_id',true));
GRANT SELECT,INSERT ON command_link_baselines TO ledger_app;
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON command_link_baselines
 FOR EACH ROW EXECUTE FUNCTION ledger_forbid_history_mutation();

CREATE OR REPLACE FUNCTION ledger_publish_mission_avoidance_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
 relevant boolean:=false;
 work_type text;
BEGIN
 IF TG_TABLE_NAME='hazard_risk_acceptances' THEN
  relevant:=true;
 ELSIF TG_TABLE_NAME='hazard_assessments' THEN
  relevant:=EXISTS(SELECT 1 FROM hazard_risk_acceptances a WHERE a.tenant_id=NEW.tenant_id AND a.hazard_id=NEW.hazard_id);
 ELSIF TG_TABLE_NAME='command_link_source_events' THEN
  IF EXISTS(SELECT 1 FROM journal_events WHERE tenant_id=NEW.tenant_id AND id=NEW.event_id
   AND event_type='command-link.baseline') THEN RETURN NEW; END IF;
  relevant:=EXISTS(SELECT 1 FROM hazard_openings o JOIN hazard_risk_acceptances a
   ON a.tenant_id=o.tenant_id AND a.hazard_id=o.hazard_id
   WHERE o.tenant_id=NEW.tenant_id AND o.origin_flight_id=NEW.flight_id);
 ELSIF TG_TABLE_NAME='finding_views' THEN
  relevant:=EXISTS(SELECT 1 FROM findings f JOIN hazard_openings o
   ON o.tenant_id=f.tenant_id AND o.origin_finding_id=f.id
   JOIN hazard_risk_acceptances a ON a.tenant_id=o.tenant_id AND a.hazard_id=o.hazard_id
   WHERE f.tenant_id=NEW.tenant_id AND f.id=NEW.id AND f.leaf_id='ledger.demo.command-link-loss-review');
 ELSIF TG_TABLE_NAME='flight_rule_selection_views' THEN
  IF TG_OP='UPDATE' AND OLD.current_id IS NOT DISTINCT FROM NEW.current_id THEN RETURN NEW; END IF;
  relevant:=EXISTS(SELECT 1 FROM hazard_openings o JOIN hazard_risk_acceptances a
   ON a.tenant_id=o.tenant_id AND a.hazard_id=o.hazard_id
   WHERE o.tenant_id=NEW.tenant_id AND o.origin_flight_id=NEW.flight_id);
 ELSIF TG_TABLE_NAME='organization_pack_adoptions' THEN
  relevant:=NEW.pack_id='ledger.demo-procedures' AND NEW.record->'pack'->>'version'='3'
   AND NEW.record->'pack'->>'digest'='46f777c1c391b696cffc45b450cb61b8563b28417f67ac087522b57e34e56188'
   AND EXISTS(SELECT 1 FROM hazard_openings o JOIN hazard_risk_acceptances a
    ON a.tenant_id=o.tenant_id AND a.hazard_id=o.hazard_id
    WHERE o.tenant_id=NEW.tenant_id AND o.organization_id=NEW.organization_id);
 ELSIF TG_TABLE_NAME='organization_pack_adoption_views' THEN
  relevant:=EXISTS(SELECT 1 FROM organization_pack_adoptions p JOIN hazard_openings o
   ON o.tenant_id=p.tenant_id AND o.organization_id=p.organization_id
   JOIN hazard_risk_acceptances a ON a.tenant_id=o.tenant_id AND a.hazard_id=o.hazard_id
   WHERE p.tenant_id=NEW.tenant_id AND p.id=NEW.id AND p.pack_id='ledger.demo-procedures'
   AND p.record->'pack'->>'version'='3'
   AND p.record->'pack'->>'digest'='46f777c1c391b696cffc45b450cb61b8563b28417f67ac087522b57e34e56188');
 ELSIF TG_TABLE_NAME='work_items' THEN
  SELECT event_type INTO work_type FROM journal_events
   WHERE tenant_id=NEW.tenant_id AND id=NEW.event_id;
  IF FOUND AND work_type IN (
   'telemetry.segment','order.revision','intent.revision','mission.revision',
   'flight.observation','airspace.status','source.observation','identity.link',
   'evidence.correct','flight.created','flight.assign','authority.update','mission.release','mission.departure-authorize','mission.brief','mission.briefing-acknowledge','command-link.baseline'
  ) THEN RETURN NEW; END IF;
  relevant:=EXISTS(SELECT 1 FROM hazard_risk_acceptances a
   WHERE a.tenant_id=NEW.tenant_id AND (a.id=NEW.event_id OR a.assessment_id=NEW.event_id
    OR EXISTS(SELECT 1 FROM hazard_controls c WHERE c.tenant_id=a.tenant_id AND c.hazard_id=a.hazard_id
      AND c.control_id=a.control_id AND c.control_version=a.control_version AND c.id=NEW.event_id)))
   OR EXISTS(SELECT 1 FROM hazard_assessments h JOIN hazard_risk_acceptances a
    ON a.tenant_id=h.tenant_id AND a.hazard_id=h.hazard_id WHERE h.tenant_id=NEW.tenant_id AND h.id=NEW.event_id)
   OR EXISTS(SELECT 1 FROM command_link_source_events c JOIN hazard_openings o
    ON o.tenant_id=c.tenant_id AND o.origin_flight_id=c.flight_id
    JOIN hazard_risk_acceptances a ON a.tenant_id=o.tenant_id AND a.hazard_id=o.hazard_id
    WHERE c.tenant_id=NEW.tenant_id AND c.event_id=NEW.event_id)
   OR EXISTS(SELECT 1 FROM finding_views v JOIN hazard_openings o
    ON o.tenant_id=v.tenant_id AND o.origin_finding_id=v.id
    JOIN hazard_risk_acceptances a ON a.tenant_id=o.tenant_id AND a.hazard_id=o.hazard_id
    WHERE v.tenant_id=NEW.tenant_id AND v.latest_evaluation_id=NEW.event_id);
 END IF;
 IF relevant THEN
  UPDATE mission_avoidance_register SET revision=revision+1 WHERE tenant_id=NEW.tenant_id;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ledger_publish_mission_avoidance_change() FROM PUBLIC,ledger_app;
