-- Reads report a subject as settled only when no evaluation about it is due and unfinished, so the API may read the
-- generic evaluator's queue, within its tenant, like it reads projection work.
GRANT SELECT ON rule_evaluation_work TO ledger_app;
