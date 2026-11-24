ALTER TABLE principals ADD COLUMN monitoring_sources text[] NOT NULL DEFAULT '{}';
ALTER TABLE principals ADD CONSTRAINT monitoring_sources_bound
 CHECK(cardinality(monitoring_sources)<=100 AND array_position(monitoring_sources,NULL) IS NULL);

CREATE TABLE monitoring_windows (
 id text PRIMARY KEY,tenant_id text NOT NULL,organization_id text NOT NULL,
 source_id text NOT NULL,source_session_id text NOT NULL,source_window_id text NOT NULL,
 context_digest text NOT NULL CHECK(context_digest ~ '^[a-f0-9]{64}$'),first_event_id text NOT NULL,
 control_event_id text NOT NULL,acceptance_id text NOT NULL,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,id,organization_id),
 UNIQUE(tenant_id,source_id,source_session_id,source_window_id),
 FOREIGN KEY(tenant_id,organization_id) REFERENCES organizations(tenant_id,id),
 FOREIGN KEY(tenant_id,first_event_id) REFERENCES journal_events(tenant_id,id),
 FOREIGN KEY(tenant_id,control_event_id) REFERENCES hazard_controls(tenant_id,id),
 FOREIGN KEY(tenant_id,acceptance_id) REFERENCES hazard_risk_acceptances(tenant_id,id)
);
CREATE TABLE monitoring_window_revisions (
 id text PRIMARY KEY,tenant_id text NOT NULL,window_id text NOT NULL,organization_id text NOT NULL,
 source_revision bigint NOT NULL CHECK(source_revision>0 AND source_revision<=9007199254740991),
 receipt_id text NOT NULL,artifact_id text NOT NULL,actor_id text NOT NULL,
 occurred_at timestamptz NOT NULL,recorded_at timestamptz NOT NULL,
 content_digest text NOT NULL CHECK(content_digest ~ '^[a-f0-9]{64}$'),
 record_digest text NOT NULL CHECK(record_digest ~ '^[a-f0-9]{64}$'),
 record jsonb NOT NULL CHECK(jsonb_typeof(record)='object'),
 CHECK(isfinite(occurred_at) AND isfinite(recorded_at) AND occurred_at<=recorded_at),
 CHECK(octet_length(jsonb_build_object('monitoring',record,'digest',record_digest,'processing','processing')::text)<=262144),
 CHECK(record->>'version' IS NOT DISTINCT FROM 'monitoring.window.2'
  AND record->>'id' IS NOT DISTINCT FROM id AND record->>'organizationId' IS NOT DISTINCT FROM organization_id
  AND (record->>'recordedAt')::timestamptz IS NOT DISTINCT FROM recorded_at
  AND record#>>'{source,version}' IS NOT DISTINCT FROM 'monitoring.window.2'
  AND (record#>>'{source,sourceRevision}')::bigint IS NOT DISTINCT FROM source_revision
  AND (record#>>'{source,occurredAt}')::timestamptz IS NOT DISTINCT FROM occurred_at
  AND record#>>'{authority,principalId}' IS NOT DISTINCT FROM actor_id
  AND record#>>'{authority,tenantId}' IS NOT DISTINCT FROM tenant_id
  AND record#>>'{authority,policyVersion}' IS NOT DISTINCT FROM 'ledger.monitoring-authority.1'
  AND record#>>'{original,artifactId}' IS NOT DISTINCT FROM artifact_id),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,organization_id,id),UNIQUE(tenant_id,receipt_id),
 UNIQUE(tenant_id,window_id,source_revision),
 FOREIGN KEY(tenant_id,id) REFERENCES journal_events(tenant_id,id),
 FOREIGN KEY(tenant_id,window_id,organization_id) REFERENCES monitoring_windows(tenant_id,id,organization_id),
 FOREIGN KEY(tenant_id,receipt_id) REFERENCES receipts(tenant_id,id),
 FOREIGN KEY(tenant_id,artifact_id) REFERENCES artifacts(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES principals(tenant_id,id)
);
CREATE TABLE monitoring_window_projection_views (
 tenant_id text NOT NULL,monitoring_id text NOT NULL,organization_id text NOT NULL,
 projected_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(projected_at)),
 PRIMARY KEY(tenant_id,monitoring_id),
 FOREIGN KEY(tenant_id,organization_id,monitoring_id) REFERENCES monitoring_window_revisions(tenant_id,organization_id,id)
);

CREATE FUNCTION ledger_check_monitoring_window() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE
 identity monitoring_windows%ROWTYPE;
 retained_authority jsonb;
 first_source jsonb;
 population jsonb;
 first_population jsonb;
 latest_revision bigint;
BEGIN
 SELECT * INTO identity FROM monitoring_windows WHERE tenant_id=NEW.tenant_id AND id=NEW.window_id FOR UPDATE;
 IF NOT FOUND OR identity.organization_id IS DISTINCT FROM NEW.organization_id
  OR identity.source_id IS DISTINCT FROM NEW.record->>'sourceId'
  OR identity.source_session_id IS DISTINCT FROM NEW.record#>>'{source,sourceSessionId}'
  OR identity.source_window_id IS DISTINCT FROM NEW.record#>>'{source,sourceWindowId}'
  OR identity.control_event_id IS DISTINCT FROM NEW.record#>>'{source,control,controlEventId}'
  OR identity.acceptance_id IS DISTINCT FROM NEW.record#>>'{source,control,acceptance,id}' THEN
  RAISE EXCEPTION 'Monitoring revision differs from its fixed source window identity' USING ERRCODE='23514';
 END IF;
 SELECT COALESCE(max(source_revision),0) INTO latest_revision FROM monitoring_window_revisions
  WHERE tenant_id=NEW.tenant_id AND window_id=NEW.window_id;
 IF NEW.source_revision<>latest_revision+1 OR (NEW.source_revision=1 AND identity.first_event_id<>NEW.id) THEN
  RAISE EXCEPTION 'Monitoring revisions must begin at one and advance contiguously' USING ERRCODE='23514';
 END IF;
 SELECT payload->'payload' INTO first_source FROM journal_events
  WHERE tenant_id=NEW.tenant_id AND id=identity.first_event_id AND event_type='monitoring.window';
 SELECT COALESCE(jsonb_agg(jsonb_build_object('flightId',entry->'flightId','aircraftId',entry->'aircraftId',
  'mission',entry->'mission','c2SourceId',entry->'c2SourceId','c2SourceSessionId',entry->'c2SourceSessionId','baseline',entry->'baseline')
  ORDER BY entry->>'flightId' COLLATE "C"),'[]'::jsonb) INTO population FROM jsonb_array_elements(NEW.record#>'{source,flights}') entry;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('flightId',entry->'flightId','aircraftId',entry->'aircraftId',
  'mission',entry->'mission','c2SourceId',entry->'c2SourceId','c2SourceSessionId',entry->'c2SourceSessionId','baseline',entry->'baseline')
  ORDER BY entry->>'flightId' COLLATE "C"),'[]'::jsonb) INTO first_population FROM jsonb_array_elements(first_source->'flights') entry;
 IF first_source IS NULL OR first_source->'control' IS DISTINCT FROM NEW.record#>'{source,control}'
  OR first_source->'window' IS DISTINCT FROM NEW.record#>'{source,window}' OR population IS DISTINCT FROM first_population THEN
  RAISE EXCEPTION 'Monitoring window context cannot change between revisions' USING ERRCODE='23514';
 END IF;
 SELECT jsonb_build_object('principalId',p.id,'tenantId',p.tenant_id,'principalRevision',p.revision,
  'capabilities',to_jsonb(p.capabilities),'checkedCapabilities',jsonb_build_array('input:write','monitoring:write'),
  'sourceId',identity.source_id,'grantedSources',to_jsonb(p.monitoring_sources),'policyVersion','ledger.monitoring-authority.1')
 INTO retained_authority FROM principals p WHERE p.tenant_id=NEW.tenant_id AND p.id=NEW.actor_id AND p.active
  AND p.id=current_setting('ledger.principal_id',true) AND p.capabilities @> ARRAY['input:write','monitoring:write']::text[]
  AND identity.source_id=ANY(p.monitoring_sources) FOR SHARE;
 IF NOT FOUND OR retained_authority IS DISTINCT FROM NEW.record->'authority' THEN
  RAISE EXCEPTION 'Monitoring authority differs from its accepting principal' USING ERRCODE='23514';
 END IF;
 PERFORM 1 FROM journal_events e JOIN streams s ON s.tenant_id=e.tenant_id AND s.id=e.stream_id
 JOIN receipts r ON r.tenant_id=e.tenant_id AND r.event_id=e.id AND r.id=NEW.receipt_id
 JOIN artifacts a ON a.tenant_id=e.tenant_id AND a.id=NEW.artifact_id
 WHERE e.tenant_id=NEW.tenant_id AND e.id=NEW.id AND e.event_type='monitoring.window' AND e.principal_id=NEW.actor_id
  AND e.source_id=identity.source_id AND e.source_session_id=identity.source_session_id
  AND e.artifact_id=NEW.artifact_id AND e.occurred_at=NEW.occurred_at AND e.received_at=NEW.recorded_at AND e.effective_at IS NULL
  AND s.name='source:'||NEW.actor_id||':'||identity.source_id||':'||identity.source_session_id
  AND e.payload=jsonb_build_object('sourceId',identity.source_id,'sourceSessionId',identity.source_session_id,
   'kind','monitoring.window','occurredAt',NEW.record#>>'{source,occurredAt}','artifactId',NEW.artifact_id,
   'fidelity','synthetic_contract','payload',(NEW.record->'source')-ARRAY['sourceSessionId','occurredAt'],
   'organizationId',NEW.organization_id,'acceptedAuthority',retained_authority)
  AND r.kind='monitoring.window' AND r.source_id=identity.source_id AND r.source_revision=NEW.source_revision
  AND r.flight_id IS NULL AND r.link_status='linked' AND r.artifact_id=NEW.artifact_id
  AND r.occurred_at=NEW.occurred_at AND r.received_at=NEW.recorded_at
  AND r.payload=(NEW.record->'source')-ARRAY['sourceSessionId','occurredAt']
  AND r.input_subject=jsonb_build_object('organizationId',NEW.organization_id)
  AND a.content_type='application/json' AND a.byte_length BETWEEN 1 AND 131072
  AND NEW.record->'original'=jsonb_build_object('artifactId',a.id,'sha256',a.sha256,'byteLength',a.byte_length);
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Monitoring record differs from its journal, receipt or retained original' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ledger_check_monitoring_window() FROM PUBLIC,ledger_app;
CREATE TRIGGER monitoring_window_acceptance BEFORE INSERT ON monitoring_window_revisions
 FOR EACH ROW EXECUTE FUNCTION ledger_check_monitoring_window();

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['monitoring_windows','monitoring_window_revisions','monitoring_window_projection_views'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON %I USING(tenant_id=current_setting(''ledger.tenant_id'',true)) WITH CHECK(tenant_id=current_setting(''ledger.tenant_id'',true))',t);
 EXECUTE format('GRANT SELECT ON %I TO ledger_app',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['monitoring_windows','monitoring_window_revisions'] LOOP
 EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION ledger_forbid_history_mutation()',t);
 END LOOP;
END $$;
GRANT INSERT ON monitoring_windows,monitoring_window_revisions TO ledger_app;
GRANT INSERT ON monitoring_window_projection_views TO ledger_worker;

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
   'evidence.correct','flight.created','flight.assign','authority.update','mission.release','mission.departure-authorize','mission.brief','mission.briefing-acknowledge','command-link.baseline','monitoring.window'
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
