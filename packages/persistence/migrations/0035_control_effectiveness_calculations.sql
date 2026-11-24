CREATE INDEX command_link_session_occurrences
 ON journal_events(tenant_id,source_id,source_session_id,occurred_at,id COLLATE "C")
 WHERE event_type IN ('command-link.status','command-link.baseline');

CREATE TABLE control_effectiveness_records (
 id text PRIMARY KEY,tenant_id text NOT NULL,organization_id text NOT NULL,window_id text NOT NULL,
 monitoring_id text NOT NULL,monitoring_digest text NOT NULL CHECK(monitoring_digest ~ '^[a-f0-9]{64}$'),
 actor_id text NOT NULL,recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at)),
 calculation_digest text NOT NULL CHECK(calculation_digest ~ '^[a-f0-9]{64}$'),
 basis_digest text CHECK(basis_digest ~ '^[a-f0-9]{64}$'),
 resolved_input_digest text CHECK(resolved_input_digest ~ '^[a-f0-9]{64}$'),
 selection_digest text NOT NULL CHECK(selection_digest ~ '^[a-f0-9]{64}$'),
 evaluation_digest text CHECK(evaluation_digest ~ '^[a-f0-9]{64}$'),
 record_digest text NOT NULL CHECK(record_digest ~ '^[a-f0-9]{64}$'),
 record jsonb NOT NULL CHECK(jsonb_typeof(record)='object'),
 accepted_currentness jsonb NOT NULL CHECK(jsonb_typeof(accepted_currentness)='object'),
 CHECK(octet_length(accepted_currentness::text)<=16384),
 CHECK(octet_length(jsonb_build_object('record',record,'digest',record_digest,'currentness',accepted_currentness)::text)<=262144),
 CHECK(record ?& ARRAY['version','id','organizationId','recordedAt','monitoring','calculation','evidenceState','evaluation','resolution','authority']
  AND record-ARRAY['version','id','organizationId','recordedAt','monitoring','calculation','evidenceState','evaluation','resolution','authority']='{}'::jsonb
  AND record->>'version' IS NOT DISTINCT FROM 'control.effectiveness-record.2'
  AND record->>'id' IS NOT DISTINCT FROM id
  AND record->>'organizationId' IS NOT DISTINCT FROM organization_id
  AND (record->>'recordedAt')::timestamptz IS NOT DISTINCT FROM recorded_at
  AND record#>>'{monitoring,id}' IS NOT DISTINCT FROM monitoring_id
  AND record#>>'{monitoring,digest}' IS NOT DISTINCT FROM monitoring_digest
  AND record#>>'{authority,principalId}' IS NOT DISTINCT FROM actor_id
  AND record#>>'{authority,tenantId}' IS NOT DISTINCT FROM tenant_id
  AND record#>>'{authority,policyVersion}' IS NOT DISTINCT FROM 'ledger.control-effectiveness-authority.2'
  AND record#>>'{calculation,id}' IS NOT DISTINCT FROM 'ledger.demo.control-effectiveness'
  AND record#>>'{calculation,version}' IS NOT DISTINCT FROM '2'
  AND record#>>'{calculation,digest}' IS NOT DISTINCT FROM calculation_digest
  AND calculation_digest='4d19f7a6afd6e6bf7c08f772e2d7bc634862dfba79012e532004068e48e12a2b'
  AND record#>>'{resolution,resolvedInputDigest}' IS NOT DISTINCT FROM resolved_input_digest
  AND record#>>'{resolution,selectionDigest}' IS NOT DISTINCT FROM selection_digest),
 CHECK(COALESCE(record->>'evidenceState' IN ('supported','insufficient'),false)
  AND jsonb_typeof(record->'evaluation') IN ('object','null')
  AND jsonb_typeof(record#>'{resolution,basis}') IN ('object','null')
  AND (record#>'{resolution,basis}'='null'::jsonb)=(basis_digest IS NULL)
  AND (record->'evaluation'='null'::jsonb)=(evaluation_digest IS NULL)
  AND record->'resolution' ?& ARRAY['complete','reasons','basis','resolvedInputDigest','selectionDigest']
  AND (record->'resolution')-ARRAY['complete','reasons','basis','resolvedInputDigest','selectionDigest']='{}'::jsonb
  AND jsonb_typeof(record#>'{resolution,complete}') IS NOT DISTINCT FROM 'boolean'
  AND jsonb_typeof(record#>'{resolution,reasons}') IS NOT DISTINCT FROM 'array'
  AND jsonb_array_length(record#>'{resolution,reasons}')<=64
  AND (record->'evaluation'<>'null'::jsonb OR (record->>'evidenceState'='insufficient'
   AND record#>'{resolution,complete}'='false'::jsonb
   AND jsonb_array_length(record#>'{resolution,reasons}')>0 AND resolved_input_digest IS NULL))
  AND (record->>'evidenceState'<>'supported' OR (record#>>'{evaluation,evidenceState}'='supported'
   AND record#>'{resolution,complete}'='true'::jsonb AND basis_digest IS NOT NULL AND resolved_input_digest IS NOT NULL))),
 CHECK(accepted_currentness ?& ARRAY['status','checkedAt','latestMonitoring','currentBasisDigest','reasons']
  AND accepted_currentness-ARRAY['status','checkedAt','latestMonitoring','currentBasisDigest','reasons']='{}'::jsonb
  AND COALESCE(accepted_currentness->>'status' IN ('current','stale','unresolved'),false)
  AND jsonb_typeof(accepted_currentness->'checkedAt') IS NOT DISTINCT FROM 'string'
  AND isfinite((accepted_currentness->>'checkedAt')::timestamptz)
  AND (accepted_currentness->>'checkedAt')::timestamptz<=recorded_at
  AND jsonb_typeof(accepted_currentness->'latestMonitoring') IS NOT DISTINCT FROM 'object'
  AND COALESCE(accepted_currentness#>>'{latestMonitoring,digest}' ~ '^[a-f0-9]{64}$',false)
  AND (accepted_currentness->'currentBasisDigest'='null'::jsonb
   OR COALESCE(accepted_currentness->>'currentBasisDigest' ~ '^[a-f0-9]{64}$',false))
  AND jsonb_typeof(accepted_currentness->'reasons') IS NOT DISTINCT FROM 'array'
  AND jsonb_array_length(accepted_currentness->'reasons')<=64),
 UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,id) REFERENCES journal_events(tenant_id,id),
 FOREIGN KEY(tenant_id,organization_id) REFERENCES organizations(tenant_id,id),
 FOREIGN KEY(tenant_id,window_id,organization_id) REFERENCES monitoring_windows(tenant_id,id,organization_id),
 FOREIGN KEY(tenant_id,organization_id,monitoring_id) REFERENCES monitoring_window_revisions(tenant_id,organization_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES principals(tenant_id,id)
);

CREATE FUNCTION ledger_check_control_effectiveness_calculation() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE
 retained_authority jsonb;
 monitored_flights jsonb;
 retained_monitoring monitoring_window_revisions%ROWTYPE;
BEGIN
 SELECT jsonb_build_object('principalId',p.id,'tenantId',p.tenant_id,'principalRevision',p.revision,
  'capabilities',to_jsonb(p.capabilities),'checkedCapabilities',jsonb_build_array('flight:read','decision:write'),
  'policyVersion','ledger.control-effectiveness-authority.2') INTO retained_authority
 FROM principals p WHERE p.tenant_id=NEW.tenant_id AND p.id=NEW.actor_id AND p.active
  AND p.id=current_setting('ledger.principal_id',true)
  AND p.capabilities @> ARRAY['flight:read','decision:write']::text[] FOR SHARE;
 IF NOT FOUND OR NEW.record->'authority' IS DISTINCT FROM retained_authority THEN
  RAISE EXCEPTION 'Calculation authority differs from its accepting principal' USING ERRCODE='23514';
 END IF;
 SELECT * INTO retained_monitoring FROM monitoring_window_revisions
  WHERE tenant_id=NEW.tenant_id AND id=NEW.monitoring_id AND window_id=NEW.window_id AND organization_id=NEW.organization_id;
 IF NOT FOUND OR retained_monitoring.record_digest IS DISTINCT FROM NEW.monitoring_digest THEN
  RAISE EXCEPTION 'Calculation differs from its exact monitoring revision' USING ERRCODE='23514';
 END IF;
 PERFORM 1 FROM monitoring_window_revisions latest WHERE latest.tenant_id=NEW.tenant_id AND latest.window_id=NEW.window_id
  AND latest.id=NEW.accepted_currentness#>>'{latestMonitoring,id}'
  AND latest.record_digest=NEW.accepted_currentness#>>'{latestMonitoring,digest}'
  AND latest.source_revision=(SELECT max(source_revision) FROM monitoring_window_revisions WHERE tenant_id=NEW.tenant_id AND window_id=NEW.window_id);
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Calculation currentness differs from the accepted monitoring head' USING ERRCODE='23514';
 END IF;
 SELECT jsonb_build_array(NEW.organization_id)||COALESCE(jsonb_agg(entry->>'flightId' ORDER BY entry->>'flightId' COLLATE "C"),'[]'::jsonb)
 INTO monitored_flights FROM jsonb_array_elements(retained_monitoring.record#>'{source,flights}') entry;
 PERFORM 1 FROM journal_events e JOIN streams s ON s.tenant_id=e.tenant_id AND s.id=e.stream_id
 WHERE e.tenant_id=NEW.tenant_id AND e.id=NEW.id AND e.event_type='control.effectiveness.recorded'
  AND e.principal_id=NEW.actor_id AND e.received_at=NEW.recorded_at AND e.causation_id=NEW.monitoring_id
  AND e.source_id IS NULL AND e.source_session_id IS NULL AND e.artifact_id IS NULL
  AND e.occurred_at IS NULL AND e.effective_at IS NULL AND s.name='control-effectiveness:'||NEW.window_id
  AND e.payload ?& ARRAY['record','resolvedInput','selection','declaredSubjects']
  AND e.payload-ARRAY['record','resolvedInput','selection','declaredSubjects']='{}'::jsonb
  AND e.payload->'record'=NEW.record AND e.payload->'declaredSubjects'=monitored_flights
  AND jsonb_typeof(e.payload->'selection')='object'
  AND e.payload#>>'{selection,version}'='control.effectiveness-selection.2'
  AND (e.payload->'resolvedInput'='null'::jsonb OR
   (e.payload#>>'{resolvedInput,version}'='control.effectiveness-input.2'
    AND e.payload#>'{resolvedInput,monitoring,record}'=retained_monitoring.record
    AND e.payload#>>'{resolvedInput,organizationId}'=NEW.organization_id))
  AND (NEW.resolved_input_digest IS NULL)=(e.payload->'resolvedInput'='null'::jsonb)
  AND (NEW.record->'evaluation'='null'::jsonb)=(e.payload->'resolvedInput'='null'::jsonb)
  AND octet_length(e.payload::text)<=4194304;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Calculation differs from its journal, selection or retained input' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ledger_check_control_effectiveness_calculation() FROM PUBLIC,ledger_app;
CREATE TRIGGER control_effectiveness_calculation_acceptance BEFORE INSERT ON control_effectiveness_records
 FOR EACH ROW EXECUTE FUNCTION ledger_check_control_effectiveness_calculation();

ALTER TABLE control_effectiveness_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON control_effectiveness_records
 USING(tenant_id=current_setting('ledger.tenant_id',true))
 WITH CHECK(tenant_id=current_setting('ledger.tenant_id',true));
GRANT SELECT,INSERT ON control_effectiveness_records TO ledger_app;
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON control_effectiveness_records
 FOR EACH ROW EXECUTE FUNCTION ledger_forbid_history_mutation();
