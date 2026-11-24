-- A successor adoption takes a pack over at a higher version from a stated time. It names the adoption it succeeds,
-- which ends where the successor starts; neither row changes, so the earlier adoption's own interval stays as it was
-- accepted. Each adoption is succeeded at most once, and an adoption either revises or succeeds another, not both.
ALTER TABLE organization_pack_adoptions
 ADD COLUMN succeeds_id text,
 ADD CONSTRAINT organization_pack_adoption_succeeds FOREIGN KEY(tenant_id,organization_id,succeeds_id)
  REFERENCES organization_pack_adoptions(tenant_id,organization_id,id),
 ADD CONSTRAINT organization_pack_adoption_succeeded_once UNIQUE(tenant_id,succeeds_id),
 ADD CONSTRAINT organization_pack_adoption_succeeds_record CHECK(
  record->>'succeeds' IS NOT DISTINCT FROM succeeds_id AND (succeeds_id IS NULL OR revises_id IS NULL));

-- When an adoption takes effect its rules are queued for the subjects already on record, a page at a time: an
-- 'adoption-page' work row carries the position from which a worker queues the next page, so one adoption never
-- holds a long transaction. It evaluates nothing itself; its trigger event is the adoption.
ALTER TABLE rule_evaluation_work DROP CONSTRAINT rule_evaluation_work_trigger_kind_check,
 ADD CONSTRAINT rule_evaluation_work_trigger_kind_check
  CHECK(trigger_kind IN ('observation','deadline','state','correction','adoption','related','adoption-page')),
 DROP CONSTRAINT rule_evaluation_work_continuation,
 ADD CONSTRAINT rule_evaluation_work_continuation CHECK((trigger_kind IN ('related','adoption-page'))=(continuation IS NOT NULL)
  AND (continuation IS NULL OR jsonb_typeof(continuation)='object'));
CREATE UNIQUE INDEX rule_evaluation_work_adoption_page ON rule_evaluation_work
 (tenant_id,trigger_event_id,pack_id,leaf_id,(continuation->>'step'),(continuation->>'after'))
 WHERE trigger_kind='adoption-page';
