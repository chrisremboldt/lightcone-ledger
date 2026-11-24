-- A flight-side hazard can be opened from, and assessed against, a finding the generic evaluator recorded about the
-- flight. Each opening and assessment names exactly one evaluation: a flight evaluation or a rule evaluation.
ALTER TABLE hazard_openings
 ALTER COLUMN origin_evaluation_id DROP NOT NULL,
 ADD COLUMN origin_rule_evaluation_id text,
 ADD CONSTRAINT hazard_openings_origin_rule_evaluation FOREIGN KEY(tenant_id,origin_rule_evaluation_id)
  REFERENCES rule_evaluations(tenant_id,id),
 ADD CONSTRAINT hazard_openings_one_evaluation CHECK((origin_evaluation_id IS NULL)<>(origin_rule_evaluation_id IS NULL));

ALTER TABLE hazard_assessments
 ALTER COLUMN evaluation_id DROP NOT NULL,
 ADD COLUMN rule_evaluation_id text,
 ADD CONSTRAINT hazard_assessments_rule_evaluation FOREIGN KEY(tenant_id,rule_evaluation_id)
  REFERENCES rule_evaluations(tenant_id,id),
 ADD CONSTRAINT hazard_assessments_one_evaluation CHECK((evaluation_id IS NULL)<>(rule_evaluation_id IS NULL));
