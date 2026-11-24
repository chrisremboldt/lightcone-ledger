import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, LedgerClient } from '@ledger/contracts/client';
import type {
  Command,
  EvaluationRecord,
  FindingClosingReason,
  FindingRecord,
  FindingTreatment,
  Principal,
  TimelineResponse,
} from '@ledger/contracts';
import { Badge, Button, Notice, Spinner } from '@ledger/ui';
import { captureActionBasis, type Basis, type RenderedBasis } from './ActionPanel.js';
import { errorMessage, json, time, timeZoneLabel } from './format.js';
import { decisionLabel, sourceLabel } from './labels.js';
import { orderAndSelectFindings } from './findings.js';
import {
  actionSentence,
  clearedSentence,
  closingReasonLabels,
  closureSentence,
  findingStatusLabels,
  treatmentLabels,
} from './finding-work.js';
import { EvaluationReads } from './EvaluationReads.js';
import { summaryText, withReadContext } from './evaluation-reads.js';
import { LandingReconciliation } from './LandingReconciliation.js';
import { isLandingDisagreementFinding } from './safety.js';
import type { FlightFinding } from './safety-navigation.js';

const statusLabels: Record<FindingRecord['status'], string> = findingStatusLabels;
type PanelAction = 'acknowledge' | 'respond' | 'close';
const actionLabels: Record<PanelAction, string> = {
  acknowledge: 'Take responsibility',
  respond: 'Record response',
  close: 'Close the finding',
};
const consequences: Record<PanelAction, string> = {
  acknowledge: 'You become the owner. The finding stays open while you investigate.',
  respond:
    'Your response is appended. The finding stays open until a record your organization keeps answers it or you close it with a reason.',
  close:
    'The finding closes with your reason, your explanation and the latest evaluation. Its original finding and treatment history remain; a later record that needs attention opens it again.',
};

interface Draft {
  findingId: string;
  evaluationId: string;
  action: PanelAction;
  basis: Basis;
  note: string;
  reason: FindingClosingReason | '';
}
export interface FindingEvidenceTarget {
  eventId: string;
  receiptId?: string;
}
interface Props {
  active: boolean;
  client: LedgerClient;
  data: TimelineResponse;
  principal: Principal | null;
  view: 'record' | 'telemetry';
  renderedBasis?: RenderedBasis;
  acceptanceBlocked: boolean;
  onChanged: () => void;
  onEvidence: (target: FindingEvidenceTarget) => void;
  /** Opens the safety workspace from a finding; absent for someone who cannot read safety records. */
  onSafety?: (finding: FlightFinding) => void;
  focusedFinding?: { id: string; sequence: number };
}

export function FindingsPanel({
  active,
  client,
  data,
  principal,
  view,
  renderedBasis,
  acceptanceBlocked,
  onChanged,
  onEvidence,
  onSafety,
  focusedFinding,
}: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [landingDraft, setLandingDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [acceptedCommandId, setAcceptedCommandId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ text: string; conflict: boolean; uncertain: boolean } | null>(null);
  const attempt = useRef<{ command: Command; key: string } | null>(null);
  useEffect(() => {
    if (!focusedFinding) return;
    if (
      (draft && formOpen && draft.findingId !== focusedFinding.id) ||
      (landingDraft && focusedFinding.id !== selectedId)
    ) {
      setMessage(
        'Your treatment draft is retained. Finish or close it before selecting the hazard’s originating finding.',
      );
      return;
    }
    setSelectedId(focusedFinding.id);
  }, [focusedFinding]);
  const { findings, selected } = orderAndSelectFindings(data.findings ?? [], selectedId);
  const acceptedTreatmentVisible = findings.some((finding) =>
    finding.treatments.some((treatment) => treatment.id === acceptedCommandId),
  );
  const flightUpdating = data.flight.outstandingWork > 0 || Boolean(acceptedCommandId && !acceptedTreatmentVisible);
  useEffect(() => {
    if (acceptedCommandId && acceptedTreatmentVisible && !data.flight.outstandingWork) setAcceptedCommandId(null);
  }, [acceptedCommandId, acceptedTreatmentVisible, data.flight.outstandingWork]);
  if (!selected) return null;
  const current = captureActionBasis(data, view, renderedBasis);
  const latest = selected.latestEvaluation;
  const original = selected.initialEvaluation.explanation;
  const triggeringEvidence =
    'kind' in original && original.kind === 'command_link'
      ? original.evidence.find(
          (evidence) =>
            evidence.status === 'lost' &&
            original.groups.some((group) => group.lossEventIds.includes(evidence.eventId)),
        )
      : original.evidence.find((evidence) => Boolean(evidence.eventId));
  const clear = latest.outcome === 'pass' || latest.outcome === 'not_applicable' || latest.outcome === 'relieved';
  const owned = selected.owner?.id === principal?.id;
  const canWrite = data.availableCommands.includes('decision:write');
  const stale = Boolean(
    draft &&
    (!draft.basis.valid ||
      draft.basis.view !== view ||
      draft.basis.revision !== current.revision ||
      draft.basis.basisRevision !== current.basisRevision ||
      draft.basis.dependencyBasis !== current.dependencyBasis ||
      draft.basis.inputCut.principalRevision !== current.inputCut.principalRevision ||
      draft.evaluationId !== latest.id),
  );
  const uncertain = failure?.uncertain ?? false;

  function open(action: PanelAction) {
    if (busy || flightUpdating) return;
    setSelectedId(selected!.id);
    if (draft?.findingId !== selected!.id || draft.action !== action) {
      setDraft({ findingId: selected!.id, evaluationId: latest.id, action, basis: current, note: '', reason: '' });
      attempt.current = null;
      setFailure(null);
    }
    setMessage(null);
    setFormOpen(true);
  }

  async function send(command: Command) {
    attempt.current ??= { command, key: crypto.randomUUID() };
    setBusy(true);
    setFailure(null);
    try {
      const response = await client.command(attempt.current.command, attempt.current.key);
      setAcceptedCommandId(response.command.id);
      setMessage('Finding treatment recorded with your identity and viewed basis.');
      setFormOpen(false);
      setDraft(null);
      attempt.current = null;
      onChanged();
    } catch (error) {
      const conflict = error instanceof ApiError && error.status === 409;
      const unknownResult = !(error instanceof ApiError) || error.status >= 500;
      setFailure({ text: errorMessage(error), conflict, uncertain: unknownResult });
      if (!unknownResult) attempt.current = null;
      if (conflict) onChanged();
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (
      !draft ||
      busy ||
      flightUpdating ||
      stale ||
      acceptanceBlocked ||
      !current.valid ||
      uncertain ||
      !draft.note.trim() ||
      (draft.action === 'close' && !draft.reason)
    )
      return;
    const treatment: FindingTreatment = {
      findingId: draft.findingId,
      evaluationId: draft.evaluationId,
      action: draft.action,
      ...(draft.action === 'close' && draft.reason ? { reason: draft.reason } : {}),
    };
    void send({
      kind: 'decision.record',
      flightId: data.flight.id,
      expectedRevision: draft.basis.revision,
      expectedBasisRevision: draft.basis.basisRevision,
      inputCut: draft.basis.inputCut,
      expectedDependencyBasis: draft.basis.dependencyBasis!,
      findingTreatment: treatment,
      decision: { kind: `finding.${draft.action}`, note: draft.note },
    });
  }

  return (
    <section className="findings-panel" aria-label="Recorded findings" data-testid="findings-panel">
      <h3>Recorded findings · {findings.length}</h3>
      {findings.length > 1 && (
        <div className="finding-selector" aria-label="Choose a finding">
          {findings.map((finding) => (
            <button
              key={finding.id}
              aria-pressed={finding.id === selected.id}
              disabled={formOpen || busy || uncertain || landingDraft}
              onClick={() => setSelectedId(finding.id)}
            >
              <span>{finding.initialEvaluation.title}</span>
              <small>{statusLabels[finding.status]}</small>
            </button>
          ))}
        </div>
      )}
      <div
        className={`rail-card finding-card ${selected.status === 'resolved' ? 'is-resolved' : ''}`}
        data-testid="finding-detail"
      >
        <div className="finding-heading">
          <Badge tone={selected.status === 'resolved' ? 'neutral' : 'attention'}>{statusLabels[selected.status]}</Badge>
          <span className="mono">{time(selected.openedAt)}</span>
        </div>
        <h4>{selected.initialEvaluation.title}</h4>
        <p className="finding-explanation">{summaryText(withReadContext(latest, data))}</p>
        {isLandingDisagreementFinding(latest) ? (
          <LandingReconciliation
            key={selected.id}
            active={active}
            client={client}
            data={data}
            finding={selected}
            principal={principal}
            basis={current}
            blocked={flightUpdating || acceptanceBlocked}
            onEvidence={onEvidence}
            onChanged={onChanged}
            onDraftChange={setLandingDraft}
          />
        ) : (
          <EvaluationReads
            client={client}
            subject={{ kind: 'flight', id: data.flight.id }}
            evaluation={withReadContext(latest, data)}
          />
        )}
        <p className="finding-owner">
          {selected.owner ? `${selected.owner.name} owns this finding` : 'Nobody has taken responsibility'}
        </p>
        {selected.status !== 'resolved' && (
          <p className={`finding-check ${clear ? 'is-clear' : ''}`}>
            {latest.outcome === 'relieved'
              ? `${latest.explanation.summary} Not counted while the waiver is adopted · the owner may close it`
              : latest.outcome === 'pass'
                ? clearedSentence
                : clear
                  ? 'Evidence check cleared · the owner may close it'
                  : 'Evidence check still needs attention'}
          </p>
        )}
        {selected.action && (
          <p className="finding-action" data-testid="finding-action">
            Action: {actionSentence(selected.action)}
          </p>
        )}
        {selected.closure && (
          <p className="finding-closure" data-testid="finding-closure">
            {closureSentence(selected.closure)}
          </p>
        )}
        {triggeringEvidence ? (
          <div className="finding-evidence-action">
            <Button
              kind="next"
              onClick={() =>
                onEvidence({
                  eventId: triggeringEvidence.eventId,
                  ...(triggeringEvidence.receiptId ? { receiptId: triggeringEvidence.receiptId } : {}),
                })
              }
            >
              Show triggering evidence
            </Button>
          </div>
        ) : (
          <p className="rail-muted">No triggering source record was retained in the original evaluation.</p>
        )}
        <EvaluationDetails
          evaluation={withReadContext(latest, data)}
          label="Latest evaluation and evidence"
          onEvidence={onEvidence}
        />
        {selected.initialEvaluation.id !== latest.id && (
          <EvaluationDetails
            evaluation={withReadContext(selected.initialEvaluation, data)}
            label="Original finding and evidence"
            onEvidence={onEvidence}
          />
        )}
        {selected.treatments.length > 0 && (
          <details className="finding-history">
            <summary>
              Treatment history · {selected.treatments.length}
              {selected.hasOlderTreatments ? ' recent' : ''}
            </summary>
            <ol>
              {selected.treatments.map((treatment) => (
                <li key={treatment.id}>
                  <strong>{treatmentLabels[treatment.action] ?? decisionLabel(treatment.action)}</strong>
                  <span>
                    {treatment.actorName} · {time(treatment.recordedAt, true)}
                  </span>
                  <p>{treatment.note}</p>
                  <small>
                    {treatment.evaluationId === latest.id
                      ? 'Based on the latest evaluation'
                      : 'Based on an earlier evaluation'}
                  </small>
                </li>
              ))}
            </ol>
            {selected.hasOlderTreatments && (
              <p className="rail-muted">Earlier treatment remains in the flight decision history below.</p>
            )}
          </details>
        )}
        {!formOpen && selected.status !== 'resolved' && canWrite && (
          <div className="finding-actions">
            {!selected.owner ? (
              <Button kind="next" disabled={flightUpdating} onClick={() => open('acknowledge')}>
                Take responsibility
              </Button>
            ) : owned ? (
              <>
                <Button kind={clear ? 'secondary' : 'next'} disabled={flightUpdating} onClick={() => open('respond')}>
                  Record response
                </Button>
                <Button kind={clear ? 'next' : 'secondary'} disabled={flightUpdating} onClick={() => open('close')}>
                  Close the finding
                </Button>
                {!clear && (
                  <small>A later record your organization keeps that answers the check closes it by itself.</small>
                )}
              </>
            ) : (
              <p className="rail-muted">{selected.owner.name} can record a response or close this finding.</p>
            )}
          </div>
        )}
        {!canWrite && selected.status !== 'resolved' && (
          <p className="rail-muted">Your role can review this finding. An operator can take responsibility.</p>
        )}
        {onSafety && (
          <div className="finding-safety-action">
            <Button
              kind="next"
              disabled={flightUpdating}
              onClick={() =>
                onSafety({ flightId: data.flight.id, flightLabel: data.flight.label, findingId: selected.id })
              }
            >
              Open safety workspace
            </Button>
            <small>
              {flightUpdating
                ? 'Wait for the displayed flight record to finish updating.'
                : isLandingDisagreementFinding(latest)
                  ? 'If these reports reveal a wider safety risk, record a hazard from this finding.'
                  : 'Record a hazard from this finding, or open the one already recorded.'}
            </small>
          </div>
        )}
        {flightUpdating && (
          <p className="rail-muted" role="status">
            Updating the flight record
          </p>
        )}
        {message && (
          <div className="action-success" role="status">
            {message}
          </div>
        )}
        {failure && (
          <Notice
            tone={failure.conflict || failure.uncertain ? 'attention' : 'alert'}
            title={
              failure.conflict
                ? 'The finding basis changed'
                : failure.uncertain
                  ? 'Confirm the recorded result'
                  : 'Treatment was not recorded'
            }
          >
            {failure.text}
            {failure.conflict && <p>Review the latest evaluation, then refresh the basis. Your note is retained.</p>}
            {failure.uncertain && (
              <>
                <p>The result is unknown. Retry the identical action to recover its recorded result.</p>
                <Button disabled={busy} onClick={() => attempt.current && void send(attempt.current.command)}>
                  Retry same action
                </Button>
              </>
            )}
          </Notice>
        )}
        {formOpen && draft && (
          <form className="action-form finding-form" data-testid="finding-treatment-form" onSubmit={submit}>
            <div className="form-heading">
              <h4>{actionLabels[draft.action]}</h4>
              <button
                type="button"
                aria-label="Close finding action"
                disabled={busy || uncertain}
                onClick={() => setFormOpen(false)}
              >
                ×
              </button>
            </div>
            <p className="finding-consequence">{consequences[draft.action]}</p>
            <div className={`draft-basis ${stale ? 'is-stale' : ''}`}>
              <span>Pins this finding and the displayed {draft.basis.view === 'telemetry' ? 'map' : 'record'}</span>
              {stale ? (
                <>
                  <span>The finding or viewed basis changed. Your note is retained.</span>
                  <Button
                    kind="next"
                    type="button"
                    disabled={acceptanceBlocked || busy || flightUpdating || uncertain || !current.valid}
                    onClick={() => {
                      setDraft({ ...draft, evaluationId: latest.id, basis: current });
                      attempt.current = null;
                      setFailure(null);
                    }}
                  >
                    Refresh basis
                  </Button>
                </>
              ) : (
                <small>Your identity and this evaluation are retained with the treatment.</small>
              )}
            </div>
            {acceptanceBlocked && (
              <p className="action-map-guard">
                The displayed map and record are updating. Review them before recording treatment.
              </p>
            )}
            {draft.action === 'close' && (
              <fieldset className="finding-reasons">
                <legend>Reason</legend>
                {(Object.keys(closingReasonLabels) as FindingClosingReason[]).map((reason) => (
                  <label key={reason}>
                    <input
                      type="radio"
                      name="finding-close-reason"
                      value={reason}
                      checked={draft.reason === reason}
                      disabled={busy || uncertain}
                      onChange={() => setDraft({ ...draft, reason })}
                    />
                    {closingReasonLabels[reason]}
                  </label>
                ))}
              </fieldset>
            )}
            <label htmlFor="finding-treatment-note">
              {draft.action === 'acknowledge'
                ? 'What you will check'
                : draft.action === 'respond'
                  ? 'Response and reason'
                  : 'Why it is closed'}
            </label>
            <textarea
              id="finding-treatment-note"
              rows={4}
              maxLength={4000}
              required
              disabled={busy || uncertain}
              value={draft.note}
              onChange={(event) => setDraft({ ...draft, note: event.target.value })}
            />
            <Button
              kind="primary"
              type="submit"
              disabled={
                busy ||
                flightUpdating ||
                uncertain ||
                stale ||
                acceptanceBlocked ||
                !current.valid ||
                !draft.note.trim() ||
                (draft.action === 'close' && !draft.reason)
              }
            >
              {busy ? <Spinner label="Recording treatment" /> : actionLabels[draft.action]}
            </Button>
          </form>
        )}
      </div>
    </section>
  );
}

function EvaluationDetails({
  evaluation,
  label,
  onEvidence,
}: {
  evaluation: EvaluationRecord;
  label: string;
  onEvidence: (target: FindingEvidenceTarget) => void;
}) {
  const explanation = evaluation.explanation;
  const commandLink = 'kind' in explanation && explanation.kind === 'command_link' ? explanation : null;
  return (
    <details className="finding-evaluation">
      <summary>{label}</summary>
      <p>{summaryText(evaluation)}</p>
      <p className="finding-evaluation-time">
        Evaluated {time(evaluation.clock.evaluatedAt, true)} {timeZoneLabel()} · recorded{' '}
        {time(evaluation.recordedAt, true)} {timeZoneLabel()}
      </p>
      {'dueAt' in explanation && explanation.dueAt && (
        <p className="finding-evaluation-time">
          Evidence due {time(explanation.dueAt, true)} {timeZoneLabel()}
        </p>
      )}
      {'kind' in explanation && explanation.kind === 'rule' && explanation.nextBoundary && (
        <p className="finding-evaluation-time">
          Answer may change {time(explanation.nextBoundary, true)} {timeZoneLabel()}
        </p>
      )}
      {'kind' in explanation && explanation.kind === 'rule' && explanation.readAsPlans && (
        <p className="finding-evaluation-time" data-testid="finding-read-as-plan">
          Read as a plan: about {time(explanation.readAsPlans.from, true)} {timeZoneLabel()}, a time that had not come
          when it was evaluated.
        </p>
      )}
      {evaluation.explanation.evidence.length > 0 ? (
        <ul className="finding-evidence">
          {evaluation.explanation.evidence.map((evidence) => {
            const commandLinkReport = commandLink?.evidence.find((report) => report.eventId === evidence.eventId);
            return (
              <li key={evidence.eventId}>
                {evidence.eventId ? (
                  <button
                    onClick={() =>
                      onEvidence({
                        eventId: evidence.eventId,
                        ...(evidence.receiptId ? { receiptId: evidence.receiptId } : {}),
                      })
                    }
                  >
                    {evidence.receiptId ? sourceLabel(evidence.sourceId) : 'Recorded correction'} ·{' '}
                    {time(evidence.occurredAt, true)} {timeZoneLabel()} <span aria-hidden="true">↗</span>
                  </button>
                ) : (
                  <span>
                    {commandLink ? 'Reported command link' : 'Recorded correction'} · {time(evidence.occurredAt, true)}{' '}
                    {timeZoneLabel()}
                  </span>
                )}
                {commandLinkReport && (
                  <>
                    <small>
                      Reported command link {commandLinkReport.status} · aircraft {commandLinkReport.aircraftId}
                    </small>
                    <small>
                      Session {commandLinkReport.sourceSessionId} · incident {commandLinkReport.incidentId}
                    </small>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="rail-muted">No supporting receipt was available at this evaluation.</p>
      )}
      <details className="finding-provenance">
        <summary>Rule and retained basis</summary>
        <p>
          {'kind' in explanation && explanation.kind === 'rule'
            ? `Adopted procedure · ${explanation.ruleEvaluation.mode} mode`
            : evaluation.execution?.mode === 'adopted'
              ? 'Company procedure · adopted for this evaluation'
              : 'Built-in draft procedure · adoption not applied'}
        </p>
        {evaluation.rule ? (
          <>
            <p>{evaluation.rule.reference}</p>
            <p>{evaluation.rule.text}</p>
          </>
        ) : (
          <p>Source text is retained in the evaluation journal.</p>
        )}
        <p>
          {evaluation.leafId} · version {evaluation.leafVersion}
          <br />
          {evaluation.bindingId} · version {evaluation.bindingVersion}
        </p>
        <pre>
          {json({
            evaluationId: evaluation.id,
            applicability: evaluation.applicability,
            evidenceState: evaluation.evidenceState,
            outcome: evaluation.outcome,
            rule: evaluation.rule,
            inputCut: evaluation.inputCut,
            dependencyBasis: evaluation.dependencyBasis,
            ...(commandLink ? { groups: commandLink.groups } : {}),
          })}
        </pre>
      </details>
    </details>
  );
}
