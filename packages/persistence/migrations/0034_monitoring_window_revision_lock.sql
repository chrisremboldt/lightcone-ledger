CREATE OR REPLACE FUNCTION ledger_check_monitoring_window() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE
 identity monitoring_windows%ROWTYPE;
 retained_authority jsonb;
 first_source jsonb;
 population jsonb;
 first_population jsonb;
 latest_revision bigint;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('monitoring-window-revision',NEW.tenant_id,NEW.window_id)::text,0));
 SELECT * INTO identity FROM monitoring_windows WHERE tenant_id=NEW.tenant_id AND id=NEW.window_id;
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
