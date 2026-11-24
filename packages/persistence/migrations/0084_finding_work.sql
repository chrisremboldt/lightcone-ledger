-- What a person records on a finding about any subject: taking it or assigning it to a person, an action with a due
-- date and later what was done, and closing it with a reason. A finding a later record people keep answers closes by
-- itself and keeps the evaluation that closed it.
ALTER TABLE finding_treatments DROP CONSTRAINT finding_treatments_action_check;
ALTER TABLE finding_treatments
 ADD COLUMN assignee_id text,
 ADD COLUMN due_on date,
 ADD COLUMN reason text,
 ADD CONSTRAINT finding_treatments_action_check
  CHECK(action IN ('acknowledge','assign','plan','respond','resolve','close')),
 ADD CONSTRAINT finding_treatments_assignee FOREIGN KEY(tenant_id,assignee_id) REFERENCES principals(tenant_id,id),
 ADD CONSTRAINT finding_treatments_reason
  CHECK(reason IS NULL OR reason IN ('corrected_by_record','accepted','condition_ended','recorded_in_error')),
 ADD CONSTRAINT finding_treatments_shape CHECK(
  (action='assign')=(assignee_id IS NOT NULL) AND (action='plan')=(due_on IS NOT NULL)
  AND (action='close')=(reason IS NOT NULL));

-- The current action and closure are part of the finding's projection; their history is the treatments and the
-- evaluations themselves.
ALTER TABLE finding_views
 ADD COLUMN action_note text CHECK(length(action_note)<=4000),
 ADD COLUMN action_due_on date,
 ADD COLUMN action_done_at timestamptz,
 ADD COLUMN closed_by text CHECK(closed_by IN ('record','person')),
 ADD COLUMN closed_at timestamptz,
 ADD COLUMN closing_rule_evaluation_id text,
 ADD CONSTRAINT finding_views_closing_evaluation FOREIGN KEY(tenant_id,closing_rule_evaluation_id)
  REFERENCES rule_evaluations(tenant_id,id),
 ADD CONSTRAINT finding_views_action CHECK((action_note IS NULL)=(action_due_on IS NULL)),
 ADD CONSTRAINT finding_views_closure CHECK((closed_by IS NULL)=(closed_at IS NULL) AND (closed_by IS NULL OR status='resolved'));

-- Findings closed before closures were recorded were closed by a person.
UPDATE finding_views v SET closed_by='person',closed_at=t.recorded_at,closing_rule_evaluation_id=t.rule_evaluation_id
FROM (SELECT DISTINCT ON(finding_id) tenant_id,finding_id,recorded_at,rule_evaluation_id FROM finding_treatments
      WHERE action='resolve' ORDER BY finding_id,recorded_at DESC,id DESC) t
WHERE v.tenant_id=t.tenant_id AND v.id=t.finding_id AND v.status='resolved';

-- The list of open findings across subjects reads them by organization, oldest first.
CREATE INDEX finding_views_open ON finding_views(tenant_id,owner_id) WHERE status<>'resolved';
