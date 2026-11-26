import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, type LedgerClient } from '@ledger/contracts/client';
import { findingRoleNote } from './finding-role-note.js';
import type {
  FindingClosingReason,
  FindingTreatment,
  OrganizationPerson,
  Principal,
  SubjectFindingRecord,
} from '@ledger/contracts';
import { Button, Notice, Spinner } from '@ledger/ui';
import { counted, time, timeZone, timeZoneLabel, errorMessage } from './format.js';
import {
  actionSentence,
  clearedSentence,
  closingReasonLabels,
  closureSentence,
  today,
  treatmentLabels,
} from './finding-work.js';

type Action = Exclude<FindingTreatment['action'], 'resolve'>;

const formTitles: Record<Action, string> = {
  acknowledge: 'Take responsibility',
  assign: 'Assign to a person',
  plan: 'Record an action',
  respond: 'Record what was done',
  close: 'Close the finding',
};
const noteLabels: Record<Action, string> = {
  acknowledge: 'What you will check',
  assign: 'Why this person',
  plan: 'The action',
  respond: 'What was done',
  close: 'Why it is closed',
};
const consequences: Record<Action, string> = {
  acknowledge: 'You become the owner. The finding stays open.',
  assign: 'The person you choose becomes the owner. The finding stays open.',
  plan: 'The action and its due day are kept with the finding. It shows as overdue once the day has passed.',
  respond: 'What was done is kept with the finding. It stays open until a later record resolves it or you close it.',
  close:
    'The finding closes with your name, your reason and the latest evaluation. Its history stays. A later record that needs attention opens it again.',
};

interface Draft {
  action: Action;
  evaluationId: string;
  note: string;
  assigneeId: string;
  dueOn: string;
  reason: FindingClosingReason | '';
}

/**
 * What a person records on a finding about any subject: take it, assign it, record an action with a due day and later
 * what was done, and close it with a reason. Each is a decision of the signed-in person, pinned to the finding's
 * latest evaluation.
 */
export function FindingActions({
  client,
  principal,
  finding,
  onChanged,
  onOpenHazard,
}: {
  client: LedgerClient;
  principal: Principal | null;
  finding: SubjectFindingRecord;
  onChanged: () => void;
  /** Opens a hazard from this finding; absent for someone who cannot write safety records. */
  onOpenHazard?: () => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [people, setPeople] = useState<OrganizationPerson[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const key = useRef<string | null>(null);
  const closed = finding.status === 'resolved';
  const owned = Boolean(principal && finding.owner?.id === principal.id);
  const canDecide = Boolean(principal?.capabilities.includes('decision:write'));
  const proposed = finding.mode === 'shadow';
  useEffect(() => {
    if (draft?.action !== 'assign' || people) return;
    let current = true;
    client.organizationPeople({ limit: 100 }).then(
      (response) => current && setPeople(response.people),
      (error: unknown) => current && setFailure(errorMessage(error)),
    );
    return () => {
      current = false;
    };
  }, [client, draft?.action, people]);

  function open(action: Action) {
    key.current = null;
    setFailure(null);
    setMessage(null);
    setDraft({
      action,
      evaluationId: finding.latestEvaluation.id,
      note: '',
      assigneeId: '',
      dueOn: today(timeZone()),
      reason: '',
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft || busy || !draft.note.trim()) return;
    const treatment: FindingTreatment = {
      findingId: finding.id,
      evaluationId: draft.evaluationId,
      action: draft.action,
      ...(draft.action === 'assign' ? { assigneeId: draft.assigneeId } : {}),
      ...(draft.action === 'plan' ? { dueOn: draft.dueOn } : {}),
      ...(draft.action === 'close' && draft.reason ? { reason: draft.reason } : {}),
    };
    // The same key retries the same request, so a lost response is recovered rather than recorded twice.
    key.current ??= crypto.randomUUID();
    setBusy(true);
    setFailure(null);
    try {
      await client.command({ kind: 'finding.treat', treatment, note: draft.note.trim() }, key.current);
      key.current = null;
      setMessage(`${formTitles[draft.action]}: recorded with your name.`);
      setDraft(null);
      onChanged();
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) key.current = null;
      setFailure(errorMessage(error));
      if (error instanceof ApiError && error.status === 409) onChanged();
    } finally {
      setBusy(false);
    }
  }

  const ready =
    draft &&
    draft.note.trim() &&
    (draft.action !== 'assign' || draft.assigneeId) &&
    (draft.action !== 'plan' || /^\d{4}-\d{2}-\d{2}$/.test(draft.dueOn)) &&
    (draft.action !== 'close' || draft.reason);

  return (
    <div className="finding-work" data-testid="finding-work">
      <p className="finding-owner" data-testid="finding-owner">
        {finding.owner ? `${finding.owner.name} owns this finding` : 'Nobody owns this finding'}
      </p>
      {finding.action && (
        <p className={`finding-action ${finding.action.overdue ? 'is-overdue' : ''}`} data-testid="finding-action">
          Action: {actionSentence(finding.action)}
          {finding.action.doneAt && ` (recorded ${time(finding.action.doneAt, true)} ${timeZoneLabel()})`}
        </p>
      )}
      {!closed && finding.latestEvaluation.outcome === 'pass' && !finding.latestEvaluation.issues?.length && (
        <p className="finding-check is-clear" data-testid="finding-cleared">
          {clearedSentence}
        </p>
      )}
      {finding.closure && (
        <p className="finding-closure" data-testid="finding-closure">
          {closureSentence(finding.closure)}
        </p>
      )}
      {finding.treatments.length > 0 && (
        <details className="finding-history">
          <summary>
            What was recorded · {finding.treatments.length}
            {finding.hasOlderTreatments ? ' recent' : ''}
          </summary>
          <ol>
            {finding.treatments.map((treatment) => (
              <li key={treatment.id}>
                <strong>{treatmentLabels[treatment.action]}</strong>
                <span>
                  {' '}
                  {treatment.actorName} · {time(treatment.recordedAt, true)} {timeZoneLabel()}
                  {treatment.assignee ? ` · to ${treatment.assignee.name}` : ''}
                  {treatment.dueOn ? ` · due ${treatment.dueOn}` : ''}
                  {treatment.reason ? ` · ${closingReasonLabels[treatment.reason]}` : ''}
                  {treatment.decision
                    ? ` · one decision for ${counted(treatment.decision.findingCount, 'finding')} of this rule`
                    : ''}
                </span>
                <p>{treatment.note}</p>
              </li>
            ))}
          </ol>
        </details>
      )}
      {!closed && !proposed && canDecide && !draft && (
        <div className="finding-actions">
          {!owned && (
            <Button kind={finding.owner ? 'secondary' : 'next'} onClick={() => open('acknowledge')}>
              Take responsibility
            </Button>
          )}
          <Button kind="secondary" onClick={() => open('assign')}>
            Assign to a person
          </Button>
          {owned && (
            <>
              <Button kind="secondary" onClick={() => open('plan')}>
                Record an action
              </Button>
              <Button kind="secondary" onClick={() => open('respond')}>
                Record what was done
              </Button>
              <Button kind="next" onClick={() => open('close')}>
                Close the finding
              </Button>
            </>
          )}
          {!owned && finding.owner && (
            <small>{finding.owner.name} records the action, what was done, and closes it.</small>
          )}
        </div>
      )}
      {!closed && !proposed && !canDecide && (
        <p className="rail-muted">
          {findingRoleNote(principal?.capabilities, {
            who: 'A person who records decisions',
            otherwise: 'A person who records decisions can take it.',
          })}
        </p>
      )}
      {onOpenHazard && !proposed && !closed && (
        <div className="finding-safety-action">
          <Button kind="secondary" onClick={onOpenHazard}>
            Open a hazard from this finding
          </Button>
        </div>
      )}
      {message && (
        <div className="action-success" role="status">
          {message}
        </div>
      )}
      {failure && (
        <Notice tone="alert" title="Not recorded">
          {failure}
        </Notice>
      )}
      {draft && (
        <form className="action-form finding-form" data-testid="finding-work-form" onSubmit={submit}>
          <div className="form-heading">
            <h4>{formTitles[draft.action]}</h4>
            <button type="button" aria-label="Close this form" disabled={busy} onClick={() => setDraft(null)}>
              ×
            </button>
          </div>
          <p className="finding-consequence">{consequences[draft.action]}</p>
          {draft.evaluationId !== finding.latestEvaluation.id && (
            <Notice tone="attention" title="The finding was evaluated again">
              Review the latest evaluation, then open this form again. Your note is kept until you do.
            </Notice>
          )}
          {draft.action === 'assign' && (
            <>
              <label htmlFor="finding-assignee">Person</label>
              {people ? (
                <select
                  id="finding-assignee"
                  required
                  value={draft.assigneeId}
                  onChange={(event) => setDraft({ ...draft, assigneeId: event.target.value })}
                >
                  <option value="">Choose a person</option>
                  {people.map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.name}
                    </option>
                  ))}
                </select>
              ) : (
                <Spinner label="Reading the people of your organization" />
              )}
            </>
          )}
          {draft.action === 'plan' && (
            <>
              <label htmlFor="finding-due">Due on ({timeZoneLabel()})</label>
              <input
                id="finding-due"
                type="date"
                required
                value={draft.dueOn}
                onChange={(event) => setDraft({ ...draft, dueOn: event.target.value })}
              />
            </>
          )}
          {draft.action === 'close' && (
            <fieldset className="finding-reasons">
              <legend>Reason</legend>
              {(Object.keys(closingReasonLabels) as FindingClosingReason[]).map((reason) => (
                <label key={reason}>
                  <input
                    type="radio"
                    name="finding-reason"
                    value={reason}
                    checked={draft.reason === reason}
                    onChange={() => setDraft({ ...draft, reason })}
                  />
                  {closingReasonLabels[reason]}
                </label>
              ))}
            </fieldset>
          )}
          <label htmlFor="finding-work-note">{noteLabels[draft.action]}</label>
          <textarea
            id="finding-work-note"
            rows={3}
            maxLength={4000}
            required
            disabled={busy}
            value={draft.note}
            onChange={(event) => setDraft({ ...draft, note: event.target.value })}
          />
          <Button
            kind="primary"
            type="submit"
            disabled={busy || !ready || draft.evaluationId !== finding.latestEvaluation.id}
          >
            {busy ? <Spinner label="Recording" /> : formTitles[draft.action]}
          </Button>
        </form>
      )}
    </div>
  );
}
