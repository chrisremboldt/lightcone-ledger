ALTER TABLE monitoring_window_revisions
 ADD COLUMN control_event_id text GENERATED ALWAYS AS (record#>>'{source,control,controlEventId}') STORED NOT NULL,
 ADD COLUMN window_bounds jsonb GENERATED ALWAYS AS (record#>'{source,window}') STORED NOT NULL;

ALTER TABLE control_effectiveness_records
 ADD COLUMN evidence_state text GENERATED ALWAYS AS (record->>'evidenceState') STORED NOT NULL,
 ADD COLUMN has_evaluation boolean GENERATED ALWAYS AS (record->'evaluation'<>'null'::jsonb) STORED NOT NULL;

ALTER TABLE hazard_effectiveness_reviews
 ADD COLUMN actor_name text GENERATED ALWAYS AS (record#>>'{actor,name}') STORED NOT NULL,
 ADD COLUMN conclusion text GENERATED ALWAYS AS (record#>>'{decision,conclusion}') STORED NOT NULL;

CREATE INDEX monitoring_control_history
 ON monitoring_window_revisions(tenant_id,control_event_id,recorded_at DESC,id COLLATE "C" DESC);
CREATE INDEX monitoring_calculation_history
 ON control_effectiveness_records(tenant_id,monitoring_id,recorded_at DESC,id COLLATE "C" DESC);
CREATE INDEX effectiveness_review_control_history
 ON hazard_effectiveness_reviews(tenant_id,hazard_id,control_event_id,recorded_at DESC,id COLLATE "C" DESC);
CREATE INDEX effectiveness_review_calculation_history
 ON hazard_effectiveness_reviews(tenant_id,hazard_id,control_event_id,calculation_id,recorded_at DESC,id COLLATE "C" DESC);
