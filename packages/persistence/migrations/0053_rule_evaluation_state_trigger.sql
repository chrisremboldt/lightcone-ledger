-- More triggers for the generic evaluator, each recorded by the event that caused it: a change of a subject's own
-- state (state), a replaced, withdrawn or re-attached observation (correction) and a change of an adoption
-- (adoption). An evaluation one of them causes is not labelled as caused by an observation.
ALTER TABLE rule_evaluation_work DROP CONSTRAINT rule_evaluation_work_trigger_kind_check,
 ADD CONSTRAINT rule_evaluation_work_trigger_kind_check
  CHECK(trigger_kind IN ('observation','deadline','state','correction','adoption'));
-- One piece of work per causing event, subject and rule, so a redelivered event queues nothing twice.
CREATE UNIQUE INDEX rule_evaluation_work_event ON rule_evaluation_work
 (tenant_id,trigger_event_id,subject_key,pack_id,leaf_id) WHERE trigger_kind IN ('state','correction','adoption');
