import { useImperativeHandle, useLayoutEffect, useRef, useState, type FormEvent, type Ref } from 'react';
import { ApiError, LedgerClient } from '@ledger/contracts/client';
import type { Command, InputCut, TimelineItem, TimelineResponse } from '@ledger/contracts';
import { Button, Notice, Spinner } from '@ledger/ui';
import { errorMessage, json } from './format.js';
import { decisionLabel, itemSource, recordTitle } from './labels.js';
import { correctionEligibility, landingFields, reportPayload } from './correction-presentation.js';

const judgments = ['acknowledge', 'respond', 'resolve', 'hold', 'proceed', 'cancel', 'reviewed'];
const findingJudgments = new Set(['acknowledge', 'respond', 'resolve']);

const stepLabel: Record<string, string> = {
  acknowledge: 'Take responsibility',
  respond: 'Record the response',
  resolve: 'Mark resolved',
};

const fieldLabels: Record<string, string> = {
  landingTime: 'Landing time',
  landedAt: 'Landing time',
  activity: 'Reported status',
  title: 'Title',
  aircraft: 'Aircraft',
};

function recordedValues(payload: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function scalarFields(values: Record<string, unknown> | null) {
  if (!values) return null;
  const entries = Object.entries(values);
  if (entries.some(([, value]) => value !== null && typeof value === 'object')) return null;
  return Object.fromEntries(entries.map(([key, value]) => [key, value == null ? '' : String(value)]));
}

function utcTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 19) === value.slice(0, 19);
}

export interface RenderedBasis {
  revision: number;
  basisRevision: number;
  inputCut: InputCut;
  dependencyBasis?: string;
}
export interface Basis extends RenderedBasis {
  view: 'record' | 'telemetry';
  valid: boolean;
}
export interface ActionPanelHandle {
  reviewMap: () => void;
}
interface Props {
  client: LedgerClient;
  data: TimelineResponse;
  selectedItem: TimelineItem | null;
  receiptId: string | null;
  onChanged: () => void;
  view?: 'record' | 'telemetry';
  renderedBasis?: RenderedBasis;
  acceptanceBlocked?: boolean;
  reviewRef?: Ref<ActionPanelHandle>;
  suggestedKind?: 'acknowledge' | 'respond' | 'resolve';
}
type Mode = 'decision' | 'correction' | null;

export function captureActionBasis(
  data: TimelineResponse,
  view: 'record' | 'telemetry',
  rendered?: RenderedBasis,
): Basis {
  if (view === 'telemetry')
    return rendered
      ? { ...rendered, inputCut: structuredClone(rendered.inputCut), view, valid: !!rendered.dependencyBasis }
      : {
          revision: data.flight.revision,
          basisRevision: data.flight.basisRevision,
          inputCut: { streams: {} },
          view,
          valid: false,
        };
  return {
    revision: data.flight.revision,
    basisRevision: data.flight.basisRevision,
    inputCut: structuredClone(data.meta.inputCut),
    dependencyBasis: data.meta.dependencyBasis,
    view,
    valid: !!data.meta.dependencyBasis,
  };
}

export function ActionPanel({
  client,
  data,
  selectedItem,
  receiptId,
  onChanged,
  view = 'record',
  renderedBasis,
  acceptanceBlocked = false,
  reviewRef,
  suggestedKind,
}: Props) {
  const hasRecordedFindings = Boolean(data.findings?.length);
  const suggestedDecision = hasRecordedFindings ? undefined : suggestedKind;
  const [mode, setMode] = useState<Mode>(null);
  const [basis, setBasis] = useState<Basis | null>(null);
  const [decisionKind, setDecisionKind] = useState(suggestedDecision ?? 'proceed');
  const [note, setNote] = useState('');
  const [correctionTarget, setCorrectionTarget] = useState<TimelineItem | null>(null);
  const [occurredAt, setOccurredAt] = useState('');
  const [payload, setPayload] = useState('{}');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<{
    text: string;
    conflict: boolean;
    uncertain?: boolean;
    details?: unknown;
  } | null>(null);
  const attempt = useRef<{
    client: LedgerClient;
    command: Command;
    body: string;
    key: string;
    success: string;
    unconfirmed: boolean;
  } | null>(null);
  const pending = useRef(false);
  const draftMode = useRef<Mode>(null);
  const form = useRef<HTMLFormElement>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const canDecide = data.availableCommands.includes('decision:write');
  const canCorrect = data.availableCommands.includes('correction:write');
  const canLink = data.availableCommands.includes('identity:write');
  const uncertain = failure?.uncertain ?? false;
  const locked = busy || uncertain;
  const correction = correctionEligibility(selectedItem);
  const current =
    view === 'telemetry' && renderedBasis
      ? renderedBasis
      : {
          revision: data.flight.revision,
          basisRevision: data.flight.basisRevision,
          inputCut: data.meta.inputCut,
          dependencyBasis: data.meta.dependencyBasis,
        };
  const stale =
    basis &&
    (!basis.valid ||
      basis.view !== view ||
      basis.revision !== current.revision ||
      basis.basisRevision !== current.basisRevision ||
      basis.dependencyBasis !== current.dependencyBasis ||
      basis.inputCut.principalRevision !== current.inputCut.principalRevision);
  const reviewRequired = Boolean(basis && (!basis.valid || basis.view !== view || (view === 'telemetry' && stale)));
  const cannotAccept = acceptanceBlocked || reviewRequired;
  const findingTreatmentRequired = mode === 'decision' && hasRecordedFindings && findingJudgments.has(decisionKind);
  const availableJudgments = judgments.filter(
    (judgment) => !hasRecordedFindings || !findingJudgments.has(judgment) || judgment === decisionKind,
  );

  function open(next: Exclude<Mode, null>) {
    if (locked || (next === 'correction' && !correction.allowed)) return;
    setMode(next);
    if (next === 'decision' && draftMode.current === 'decision' && basis) return;
    draftMode.current = next;
    setBasis(captureActionBasis(data, view, renderedBasis));
    setFailure(null);
    setMessage(null);
    setNote('');
    attempt.current = null;
    if (next === 'correction' && selectedItem) {
      setCorrectionTarget(selectedItem);
      setOccurredAt(selectedItem.occurredAt);
      setPayload(json(reportPayload(selectedItem)));
    }
  }

  useImperativeHandle(
    reviewRef,
    () => ({
      reviewMap() {
        if (locked || !canDecide) return;
        if (mode === 'correction')
          setFailure({ text: 'Finish or close the open correction before reviewing the map.', conflict: false });
        else {
          if (draftMode.current !== 'decision' || !basis) setDecisionKind('reviewed');
          open('decision');
        }
        setFocusRequest((previous) => previous + 1);
      },
    }),
    [locked, canDecide, mode, basis, data, view, renderedBasis],
  );

  useLayoutEffect(() => {
    if (!focusRequest || !form.current) return;
    form.current.scrollIntoView({ block: 'start', behavior: 'auto' });
    form.current.querySelector<HTMLTextAreaElement>('#action-note')?.focus({ preventScroll: true });
  }, [focusRequest]);

  async function send(command: Command, success: string) {
    if (pending.current) return;
    attempt.current ??= {
      client,
      command: structuredClone(command),
      body: JSON.stringify(command),
      key: crypto.randomUUID(),
      success,
      unconfirmed: false,
    };
    const saved = attempt.current;
    pending.current = true;
    setBusy(true);
    setFailure(null);
    setMessage(null);
    try {
      await saved.client.command(JSON.parse(saved.body) as Command, saved.key);
      setMode(null);
      setNote('');
      setMessage(saved.success);
      attempt.current = null;
      draftMode.current = null;
      onChanged();
    } catch (error) {
      const unknownResult =
        saved.unconfirmed || !(error instanceof ApiError) || error.status >= 500 || error.status === 408;
      saved.unconfirmed = unknownResult;
      const conflict = !unknownResult && error instanceof ApiError && error.status === 409;
      const errorBody =
        error instanceof ApiError && typeof error.body === 'object' && error.body
          ? (error.body as { error?: { details?: unknown } })
          : null;
      setFailure({ text: errorMessage(error), conflict, uncertain: unknownResult, details: errorBody?.error?.details });
      if (!unknownResult) attempt.current = null;
      if (conflict) onChanged();
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!basis || !mode || !basis.valid || cannotAccept || findingTreatmentRequired || locked || pending.current)
      return;
    const common = {
      flightId: data.flight.id,
      expectedRevision: basis.revision,
      expectedBasisRevision: basis.basisRevision,
      inputCut: basis.inputCut,
      expectedDependencyBasis: basis.dependencyBasis!,
    };
    if (mode === 'decision')
      void send(
        { kind: 'decision.record', ...common, decision: { kind: decisionKind, note } },
        'Decision recorded with its input basis.',
      );
    if (mode === 'correction' && correctionTarget && correctionEligibility(correctionTarget).allowed) {
      try {
        const parsed: unknown = JSON.parse(payload);
        if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object')
          throw new Error('Corrected values must be a JSON object.');
        if (!utcTimestamp(occurredAt))
          throw new Error('Enter the report occurrence time in UTC with seconds and a final Z.');
        for (const field of landingFields(correctionTarget)) {
          const value = (parsed as Record<string, unknown>)[field];
          if (!utcTimestamp(value)) throw new Error('Enter the landing time in UTC with seconds and a final Z.');
        }
        void send(
          {
            kind: 'evidence.correct',
            ...common,
            correctionOf: correctionTarget.id,
            occurredAt: new Date(occurredAt).toISOString(),
            note,
            payload: parsed as Record<string, unknown>,
          },
          'Correction appended. The original evidence remains retained.',
        );
      } catch (error) {
        setFailure({ text: errorMessage(error), conflict: false });
      }
    }
  }

  function changeField(key: string, value: string) {
    try {
      const parsed: unknown = JSON.parse(payload);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return;
      setPayload(JSON.stringify({ ...parsed, [key]: value }));
    } catch {
      setFailure({ text: 'Restore valid recorded values before editing a field.', conflict: false });
    }
  }

  const landingKeys = correctionTarget ? landingFields(correctionTarget) : [];
  const values = recordedValues(payload);
  const fields = scalarFields(values);
  const inputFields =
    landingKeys.length && values
      ? Object.fromEntries(
          landingKeys.map((key) => [key, typeof values[key] === 'string' ? values[key] : json(values[key])]),
        )
      : fields;
  const annotationOnly = Boolean(
    correctionTarget &&
    ['telemetry.segment', 'command-link.status', 'command-link.baseline'].includes(correctionTarget.kind),
  );
  const correctionReason = correctionEligibility(correctionTarget).reason;

  return (
    <section className="actions-card">
      <h3>Act on this record</h3>
      {!mode && (
        <div className="action-buttons">
          {canDecide && (
            <Button
              kind="primary"
              disabled={locked}
              onClick={() => {
                if (draftMode.current !== 'decision' || !basis) setDecisionKind(suggestedDecision ?? 'proceed');
                open('decision');
              }}
            >
              {suggestedDecision ? stepLabel[suggestedDecision] : 'Record decision'}
            </Button>
          )}
          {canCorrect && (
            <Button onClick={() => open('correction')} disabled={locked || !correction.allowed}>
              Append correction
            </Button>
          )}
          {!canDecide && !canCorrect && <p className="muted">Your current role has read access to this flight.</p>}
          {canCorrect && !correction.allowed && <small>{correction.reason}</small>}
        </div>
      )}
      {message && (
        <div className="action-success" role="status">
          {message}
        </div>
      )}
      {acceptanceBlocked && (
        <p className="action-map-guard" role="status">
          The displayed map and flight record are updating. Review the refreshed basis before accepting.
        </p>
      )}
      {failure && (
        <Notice
          tone={failure.conflict || failure.uncertain ? 'attention' : 'alert'}
          title={
            failure.uncertain
              ? 'Confirm the recorded result'
              : failure.conflict
                ? 'The viewed basis has changed'
                : 'Action was not recorded'
          }
        >
          {failure.text}
          {failure.conflict && <p>Review the current evidence, then refresh the basis. Your note is retained.</p>}
          {failure.uncertain && (
            <>
              <p>The result is unknown. Recover it with the identical retained request before changing this draft.</p>
              <Button
                disabled={busy}
                onClick={() => {
                  if (attempt.current) void send(attempt.current.command, attempt.current.success);
                }}
              >
                Retry same action
              </Button>
            </>
          )}
          {failure.details != null && (
            <details>
              <summary>Conflict details</summary>
              <pre>{json(failure.details)}</pre>
            </details>
          )}
        </Notice>
      )}
      {mode && basis && (
        <form
          ref={form}
          className="action-form"
          data-testid={mode === 'decision' ? 'decision-form' : 'correction-form'}
          onSubmit={submit}
        >
          <div className="form-heading">
            <h4>{mode === 'decision' ? 'Record decision' : 'Append correction'}</h4>
            <button type="button" aria-label="Close action form" disabled={locked} onClick={() => setMode(null)}>
              ×
            </button>
          </div>
          <div className={`draft-basis ${stale ? 'is-stale' : ''}`}>
            <span>
              {basis.valid
                ? `Pins the ${basis.view === 'telemetry' ? 'map' : 'record'} exactly as you see it now`
                : 'Waiting for the displayed map basis'}
            </span>
            {stale ? (
              <>
                <span>{basis.view !== view ? 'The view changed' : 'The record changed'} since you opened this</span>
                <button
                  type="button"
                  disabled={acceptanceBlocked || locked}
                  onClick={() => {
                    setBasis(captureActionBasis(data, view, renderedBasis));
                    attempt.current = null;
                    setFailure(null);
                  }}
                >
                  Refresh basis
                </button>
              </>
            ) : (
              <small>This basis is retained with your action.</small>
            )}
          </div>
          {mode === 'decision' ? (
            <>
              <label htmlFor="decision-kind">Judgment</label>
              <select
                id="decision-kind"
                value={decisionKind}
                onChange={(event) => setDecisionKind(event.target.value)}
                disabled={locked}
                aria-describedby={hasRecordedFindings ? 'finding-actions-guidance' : undefined}
              >
                {availableJudgments.map((judgment) => (
                  <option
                    key={judgment}
                    value={judgment}
                    disabled={hasRecordedFindings && findingJudgments.has(judgment)}
                  >
                    {decisionLabel(judgment)}
                    {hasRecordedFindings && findingJudgments.has(judgment) ? ' · use finding actions' : ''}
                  </option>
                ))}
              </select>
              {hasRecordedFindings && (
                <p id="finding-actions-guidance" className="form-note">
                  {findingTreatmentRequired ? 'Your draft is kept. ' : ''}
                  Take responsibility, respond or resolve in Recorded findings above.
                </p>
              )}
            </>
          ) : (
            <>
              {correctionTarget && (
                <p className="correction-target">
                  Correcting <strong>{recordTitle(correctionTarget)}</strong>
                  <span>{itemSource(correctionTarget)} · the original stays on the record</span>
                </p>
              )}
              <p className="form-note">{correctionReason}</p>
              {landingKeys.length > 0 && (
                <p className="form-note">
                  Correct the reported touchdown time below. Use UTC with seconds and a final Z. The report occurrence
                  time is separate and stays unchanged unless you edit it in advanced details.
                </p>
              )}
              {annotationOnly ? (
                <details className="correction-json">
                  <summary>Retained native input</summary>
                  <pre>{payload}</pre>
                </details>
              ) : inputFields ? (
                Object.entries(inputFields).map(([key, value]) => (
                  <label key={key}>
                    {fieldLabels[key] ?? key}
                    {landingKeys.length > 1 && ` (${key})`}
                    <input
                      value={value}
                      disabled={locked}
                      placeholder={
                        landingKeys.includes(key as 'landingTime' | 'landedAt') ? 'YYYY-MM-DDTHH:mm:ssZ' : undefined
                      }
                      onChange={(event) => changeField(key, event.target.value)}
                    />
                  </label>
                ))
              ) : (
                <label htmlFor="correction-values">
                  Corrected values
                  <textarea
                    id="correction-values"
                    className="json-input"
                    rows={6}
                    value={payload}
                    onChange={(event) => setPayload(event.target.value)}
                    disabled={locked}
                    required
                    spellCheck={false}
                  />
                </label>
              )}
              <details className="correction-json">
                <summary>Advanced report details</summary>
                <label htmlFor="correction-occurred">Report occurrence time (UTC)</label>
                <input
                  id="correction-occurred"
                  value={occurredAt}
                  onChange={(event) => setOccurredAt(event.target.value)}
                  disabled={locked}
                  required
                />
                <p className="form-note">
                  This records when the report says its event occurred. It does not replace a reported landing time or
                  change when Ledger received the original.
                </p>
              </details>
              {inputFields && !annotationOnly && (
                <details className="correction-json">
                  <summary>Edit all recorded values directly</summary>
                  <textarea
                    className="json-input"
                    rows={6}
                    value={payload}
                    onChange={(event) => setPayload(event.target.value)}
                    disabled={locked}
                    spellCheck={false}
                  />
                </details>
              )}
            </>
          )}
          <label htmlFor="action-note">{mode === 'decision' ? 'Decision rationale' : 'Reason for correction'}</label>
          <textarea
            id="action-note"
            rows={4}
            maxLength={4000}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            disabled={locked}
            placeholder={
              mode === 'decision'
                ? decisionKind === 'acknowledge'
                  ? 'What you are taking on, and what you will check.'
                  : decisionKind === 'respond'
                    ? 'What you are doing, and why.'
                    : decisionKind === 'resolve'
                      ? 'What settled it, and the outcome.'
                      : 'What you decided, and the evidence you used.'
                : 'What you are changing, and why.'
            }
            required
          />
          <span className="form-note">
            {mode === 'decision'
              ? 'Your identity and the viewed and accepted bases are retained.'
              : 'Corrections append history; they preserve the original item.'}
          </span>
          <Button
            kind="primary"
            type="submit"
            disabled={locked || !note.trim() || cannotAccept || findingTreatmentRequired || !basis.valid}
          >
            {busy ? <Spinner label="Recording" /> : mode === 'decision' ? 'Record decision' : 'Append correction'}
          </Button>
        </form>
      )}
      {receiptId && canLink && (
        <div className="link-action">
          <h4>Link this input</h4>
          <p>
            Attach the selected unlinked input to <strong>{data.flight.label}</strong>.
          </p>
          <Button
            disabled={locked || acceptanceBlocked}
            onClick={() => {
              if (!acceptanceBlocked && !locked)
                void send(
                  {
                    kind: 'identity.link',
                    flightId: data.flight.id,
                    receiptId,
                    expectedRevision: data.flight.revision,
                  },
                  'Receipt linked to this flight. Original intake is retained.',
                );
            }}
          >
            Link to this flight
          </Button>
        </div>
      )}
    </section>
  );
}
