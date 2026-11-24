import { useRef, useState, type FormEvent } from 'react';
import { ApiError, type LedgerClient } from '@ledger/contracts/client';
import {
  FINDING_SET_LIMIT,
  type FindingClosingReason,
  type FindingSetTreatmentCommand,
  type OpenFinding,
  type OpenFindingGroup,
  type OpenFindingsQuery,
  type Principal,
} from '@ledger/contracts';
import { Button, Notice, Spinner } from '@ledger/ui';
import { errorMessage } from './format.js';
import { closingReasonLabels } from './finding-work.js';

type SetAction = 'acknowledge' | 'close';

/** What the decision is about besides its rule: a kind of subject and the days the findings are about. */
export interface FindingSetNarrowing {
  subjectKind?: OpenFindingsQuery['subjectKind'];
  aboutFrom?: string;
  aboutUntil?: string;
}

interface Shown {
  action: SetAction;
  findings: OpenFinding[];
  matching: number;
}

const titles: Record<SetAction, (count: number) => string> = {
  acknowledge: (count) => `Take responsibility for all ${count}`,
  close: (count) => `Close all ${count}`,
};

/**
 * One decision about every counted open finding of one rule, narrowed as the person narrowed the list: take them all,
 * or close them all with one reason. The form names each finding it was shown; Ledger refuses it if that set changed.
 */
export function FindingSetActions({
  client,
  principal,
  group,
  narrowing,
  onChanged,
}: {
  client: LedgerClient;
  principal: Principal | null;
  group: OpenFindingGroup;
  narrowing: FindingSetNarrowing;
  onChanged: () => void;
}) {
  const [shown, setShown] = useState<Shown | null>(null);
  const [reading, setReading] = useState(false);
  const [note, setNote] = useState('');
  const [reason, setReason] = useState<FindingClosingReason | ''>('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const key = useRef<string | null>(null);
  if (!principal?.capabilities.includes('decision:write') || (principal.kind && principal.kind !== 'human'))
    return (
      <p className="rail-muted" data-testid="finding-set-review-only">
        Taking and closing these findings are decisions of a person who records decisions.
      </p>
    );

  async function open(action: SetAction) {
    key.current = null;
    setFailure(null);
    setMessage(null);
    setReading(true);
    try {
      const findings: OpenFinding[] = [];
      let cursor: string | undefined;
      let matching = 0;
      do {
        const page = await client.openFindings({
          shown: 'counted',
          packId: group.packId,
          ruleId: group.ruleId,
          ...narrowing,
          limit: 200,
          ...(cursor ? { cursor } : {}),
        });
        matching = page.matching;
        if (matching > FINDING_SET_LIMIT) break;
        findings.push(...page.findings);
        cursor = page.page.hasMore ? (page.page.nextCursor ?? undefined) : undefined;
      } while (cursor);
      setShown({ action, findings, matching });
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setReading(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!shown || busy || !note.trim() || (shown.action === 'close' && !reason)) return;
    const command: FindingSetTreatmentCommand = {
      kind: 'finding.treat-many',
      selection: {
        packId: group.packId,
        ruleId: group.ruleId,
        ...(narrowing.subjectKind ? { subjectKind: narrowing.subjectKind } : {}),
        ...(narrowing.aboutFrom ? { aboutFrom: narrowing.aboutFrom } : {}),
        ...(narrowing.aboutUntil ? { aboutUntil: narrowing.aboutUntil } : {}),
      },
      action: shown.action,
      ...(shown.action === 'close' && reason ? { reason } : {}),
      findings: shown.findings.map((item) => ({ findingId: item.id, evaluationId: item.evaluationId })),
      shownCount: shown.findings.length,
      note: note.trim(),
    };
    // The same key retries the same request, so a lost response is recovered rather than recorded twice.
    key.current ??= crypto.randomUUID();
    setBusy(true);
    setFailure(null);
    try {
      await client.command(command, key.current);
      key.current = null;
      setMessage(`${titles[shown.action](shown.findings.length)}: recorded with your name as one decision.`);
      setShown(null);
      setNote('');
      setReason('');
      onChanged();
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) key.current = null;
      setFailure(errorMessage(error));
      if (error instanceof ApiError && error.status === 409) setShown(null);
    } finally {
      setBusy(false);
    }
  }

  const owned = shown ? shown.findings.filter((item) => item.owner?.id === principal.id).length : 0;
  const subjects = shown ? new Set(shown.findings.map((item) => `${item.subject.kind}:${item.subject.id}`)).size : 0;
  const tooMany = Boolean(shown && shown.matching > FINDING_SET_LIMIT);
  const notOwned = Boolean(shown && shown.action === 'close' && owned !== shown.findings.length);

  return (
    <div className="finding-work finding-set" data-testid="finding-set">
      {!shown && (
        <div className="finding-actions">
          <Button kind="next" disabled={reading} onClick={() => void open('acknowledge')}>
            Take responsibility for all of them
          </Button>
          <Button kind="secondary" disabled={reading} onClick={() => void open('close')}>
            Close all of them
          </Button>
          {reading && <Spinner label="Reading the findings of this rule" />}
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
      {shown && (
        <form className="action-form finding-form" data-testid="finding-set-form" onSubmit={submit}>
          <div className="form-heading">
            <h4>{titles[shown.action](shown.findings.length)}</h4>
            <button type="button" aria-label="Close this form" disabled={busy} onClick={() => setShown(null)}>
              ×
            </button>
          </div>
          {tooMany ? (
            <Notice tone="attention" title="Too many for one decision">
              {shown.matching} open findings of this rule match; one decision covers at most {FINDING_SET_LIMIT}. Narrow
              them by the days they are about or by subject, and decide on each part.
            </Notice>
          ) : (
            <>
              <p className="finding-consequence" data-testid="finding-set-scope">
                One decision about {shown.findings.length} counted open{' '}
                {shown.findings.length === 1 ? 'finding' : 'findings'} of {group.ruleTitle} ({group.paragraph}), about{' '}
                {subjects} {subjects === 1 ? 'subject' : 'subjects'}. It names each of them; if any changes before you
                record it, Ledger refuses it and you read them again.
              </p>
              <p className="finding-consequence">
                {shown.action === 'acknowledge'
                  ? 'You become the owner of each. Each stays open.'
                  : 'Each closes with your name, your reason and its latest evaluation, and shows this decision. A later result that needs attention opens it again, and a later subject the rule finds the same about opens a new finding.'}
              </p>
              {notOwned && (
                <Notice tone="attention" title="Take them first">
                  You own {owned} of these {shown.findings.length}. Only a finding’s owner closes it: take
                  responsibility for all of them first, as one decision.
                </Notice>
              )}
              {shown.action === 'close' && (
                <fieldset className="finding-reasons">
                  <legend>Reason</legend>
                  {(Object.keys(closingReasonLabels) as FindingClosingReason[]).map((value) => (
                    <label key={value}>
                      <input
                        type="radio"
                        name="finding-set-reason"
                        value={value}
                        checked={reason === value}
                        onChange={() => setReason(value)}
                      />
                      {closingReasonLabels[value]}
                    </label>
                  ))}
                </fieldset>
              )}
              <label htmlFor="finding-set-note">
                {shown.action === 'acknowledge' ? 'What you will check' : 'Why they are closed'}
              </label>
              <textarea
                id="finding-set-note"
                rows={3}
                maxLength={4000}
                required
                disabled={busy}
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
              <Button
                kind="primary"
                type="submit"
                disabled={
                  busy || !note.trim() || notOwned || !shown.findings.length || (shown.action === 'close' && !reason)
                }
              >
                {busy ? <Spinner label="Recording" /> : titles[shown.action](shown.findings.length)}
              </Button>
            </>
          )}
        </form>
      )}
    </div>
  );
}
