-- An evaluation of a rule that an active waiver adoption relieves records the result 'relieved'; what the rule would
-- otherwise have reported stays in the record under relief.otherwise. Every row already recorded keeps a value the
-- list admitted before, so nothing is refused.
ALTER TABLE rule_evaluations DROP CONSTRAINT rule_evaluations_outcome_check,
 ADD CONSTRAINT rule_evaluations_outcome_check
  CHECK(outcome IN ('pass','attention','pending','not_applicable','relieved'));
