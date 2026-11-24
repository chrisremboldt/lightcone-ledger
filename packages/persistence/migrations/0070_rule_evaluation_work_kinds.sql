-- 0068 admitted the 'adoption-page' work kind and 0069 the 'control-boundary' kind, each by restating the whole list;
-- 0069's list omits 'adoption-page'. This sets the list to every kind the evaluator's queue holds.
ALTER TABLE rule_evaluation_work DROP CONSTRAINT rule_evaluation_work_trigger_kind_check,
 ADD CONSTRAINT rule_evaluation_work_trigger_kind_check
  CHECK(trigger_kind IN ('observation','deadline','state','correction','adoption','related','adoption-page',
   'control-boundary'));
