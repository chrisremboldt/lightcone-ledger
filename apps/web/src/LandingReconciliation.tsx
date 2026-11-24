import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, LedgerClient } from '@ledger/contracts/client';
import type {
  Command,
  EvaluationRecord,
  FindingRecord,
  Principal,
  TimelineItem,
  TimelineResponse,
} from '@ledger/contracts';
import { Button, Notice, Spinner } from '@ledger/ui';
import type { Basis } from './ActionPanel.js';
import type { FindingEvidenceTarget } from './FindingsPanel.js';
import { LandingReports } from './LandingReports.js';
import { reportPayload } from './correction-presentation.js';
import { errorMessage, json, time, timeZoneLabel } from './format.js';
import { actorLabel, sourceLabel } from './labels.js';
import { useCitedObservations } from './evaluation-reads.js';
import {
  citedLandingReport,
  landingFromLocalInput,
  reportField,
  retainedReportText,
} from './landing-reconciliation.js';
import { landingReportRows, sameSafetyBasis, type LandingReportRow } from './safety.js';

interface Props {
  active: boolean;
  client: LedgerClient;
  data: TimelineResponse;
  finding: FindingRecord;
  principal: Principal | null;
  basis: Basis;
  blocked: boolean;
  onEvidence: (target: FindingEvidenceTarget) => void;
  onChanged: () => void;
  onDraftChange: (present: boolean) => void;
}
interface Draft {
  target: TimelineItem;
  report: LandingReportRow;
  evaluationId: string;
  basis: Basis;
  landingTime: string;
  customTime: string;
  differentTime: boolean;
  note: string;
}

export function LandingReconciliation({
  active,
  client,
  data,
  finding,
  principal,
  basis,
  blocked,
  onEvidence,
  onChanged,
  onDraftChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const [review, setReview] = useState<EvaluationRecord | null>(null);
  const [records, setRecords] = useState<Record<string, TimelineItem>>({});
  const [loading, setLoading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ text: string; unknown: boolean } | null>(null);
  const [acceptedId, setAcceptedId] = useState<string | null>(null);
  const [acceptedDetails, setAcceptedDetails] = useState<{ time: string; actor: string; recordedAt: string } | null>(
    null,
  );
  const result = useRef<HTMLDivElement>(null);
  const attempt = useRef<{
    command: Command;
    key: string;
    client: LedgerClient;
    unknown: boolean;
    landingTime: string;
  } | null>(null);
  const sending = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const latest = finding.latestEvaluation;
  const flight = { kind: 'flight' as const, id: data.flight.id };
  const citedLatest = useCitedObservations(client, flight, latest);
  const citedReview = useCitedObservations(client, flight, review ?? latest);
  const reports = landingReportRows(review ?? latest, citedReview.observations);
  const canCorrect = data.availableCommands.includes('correction:write');
  const clear = latest.outcome === 'pass' || latest.outcome === 'not_applicable';
  const unknown = failure?.unknown ?? false;
  const stale = Boolean(draft && (draft.evaluationId !== latest.id || !sameSafetyBasis(draft.basis, basis)));
  const acceptedVisible = Boolean(
    acceptedId &&
    (data.items.some((item) => item.id === acceptedId) ||
      latest.explanation.evidence.some((evidence) => evidence.eventId === acceptedId)),
  );
  const updating =
    blocked || data.flight.outstandingWork > 0 || !basis.valid || Boolean(acceptedId && !acceptedVisible);
  const activeTarget =
    draft &&
    landingReportRows(latest, citedLatest.observations).some(
      (report) =>
        report.eventId === draft.report.eventId &&
        report.field === draft.report.field &&
        report.value === draft.report.value,
    );
  const confirmedTime = draft?.differentTime ? landingFromLocalInput(draft.customTime) : draft?.landingTime;
  const changedTime = Boolean(confirmedTime && confirmedTime !== draft?.report.reportedTime);
  const locked = busy || unknown;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  useEffect(() => {
    onDraftChange(Boolean(draft || unknown || busy));
  }, [Boolean(draft), unknown, busy, onDraftChange]);

  useEffect(() => {
    if (!active || !acceptedId) return;
    result.current?.scrollIntoView({ block: 'start' });
    result.current?.focus({ preventScroll: true });
  }, [active, acceptedId]);

  useEffect(() => {
    if (!active || !open || !review) return;
    let cancelled = false;
    setLoading(true);
    setReadError(null);
    const cited = landingReportRows(review, citedReview.observations).slice(0, 8);
    const references = [...new Map(cited.map((report) => [report.eventId, report])).values()];
    void Promise.all(
      references.map(async (report) => {
        const suffix = `:${data.flight.id}`;
        const id = report.eventId.endsWith(suffix) ? report.eventId.slice(0, -suffix.length) : report.eventId;
        const response = await client.timeline(data.flight.id, { selectedItemId: id, limit: 1 });
        const item = response.selectedItem ?? response.items.find((candidate) => candidate.id === id);
        // A report recorded as an observation (such as a person's earlier correction) has no source report to
        // correct here; it is shown without a correction.
        return citedLandingReport(item, report, data.flight.id) ? ([[report.eventId, item!]] as const) : [];
      }),
    )
      .then((entries) => {
        if (!cancelled) setRecords(Object.fromEntries(entries.flat()));
      })
      .catch((error) => {
        if (!cancelled) setReadError(errorMessage(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active, client, data.flight.id, open, review, citedReview.observations]);

  function choose(report: LandingReportRow, target: TimelineItem) {
    if (!canCorrect || locked || updating || draft || acceptedId) return;
    setDraft({
      target: structuredClone(target),
      report,
      evaluationId: review!.id,
      basis: structuredClone(basis),
      landingTime: '',
      customTime: '',
      differentTime: false,
      note: '',
    });
    setFailure(null);
    requestAnimationFrame(() => form.current?.scrollIntoView({ block: 'nearest' }));
  }

  async function send() {
    if (!attempt.current || sending.current) return;
    sending.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const response = await attempt.current.client.command(attempt.current.command, attempt.current.key);
      setAcceptedId(response.command.id);
      setAcceptedDetails({
        time: attempt.current.landingTime,
        actor: actorLabel(response.command.actorId, principal),
        recordedAt: response.command.recordedAt,
      });
      attempt.current = null;
      setDraft(null);
      onChanged();
    } catch (error) {
      const unconfirmed =
        attempt.current!.unknown || !(error instanceof ApiError) || error.status === 408 || error.status >= 500;
      setFailure({ text: errorMessage(error), unknown: unconfirmed });
      if (unconfirmed) attempt.current!.unknown = true;
      else attempt.current = null;
      if (error instanceof ApiError && error.status === 409) onChanged();
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (
      !draft ||
      sending.current ||
      !canCorrect ||
      locked ||
      updating ||
      stale ||
      !activeTarget ||
      !changedTime ||
      !confirmedTime ||
      !draft.note.trim()
    )
      return;
    attempt.current = {
      key: crypto.randomUUID(),
      client,
      unknown: false,
      landingTime: confirmedTime,
      command: {
        kind: 'evidence.correct',
        flightId: data.flight.id,
        expectedRevision: draft.basis.revision,
        expectedBasisRevision: draft.basis.basisRevision,
        inputCut: draft.basis.inputCut,
        expectedDependencyBasis: draft.basis.dependencyBasis!,
        correctionOf: draft.target.id,
        occurredAt: draft.target.occurredAt,
        payload: {
          ...structuredClone(reportPayload(draft.target)),
          [reportField(draft.target, draft.report) ?? draft.report.field]: confirmedTime,
        },
        note: draft.note,
      },
    };
    void send();
  }

  return (
    <section
      className="landing-reconciliation"
      data-testid="landing-reconciliation"
      aria-label="Landing report reconciliation"
    >
      {!open && <LandingReports client={client} flightId={data.flight.id} evaluation={latest} />}
      {!open ? (
        <Button
          kind="next"
          onClick={() => {
            setReview(review ?? structuredClone(latest));
            setOpen(true);
          }}
        >
          {clear || finding.status === 'resolved' ? 'Review landing reports' : 'Reconcile landing reports'}
        </Button>
      ) : (
        <>
          <div className="form-heading">
            <h4>Reconcile landing reports</h4>
            <button
              type="button"
              aria-label="Close landing reconciliation"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              ×
            </button>
          </div>
          {!acceptedId && (
            <p className="form-note">
              Compare the source accounts, establish the touchdown time, then correct the inaccurate claim. A response
              note alone leaves the disagreement open.
            </p>
          )}
          {acceptedId && acceptedDetails && (
            <div ref={result} className="action-success landing-correction-result" role="status" tabIndex={-1}>
              <strong>
                Touchdown claim corrected to {time(acceptedDetails.time, true)} {timeZoneLabel()}
              </strong>
              <p>
                Recorded by {acceptedDetails.actor} · {time(acceptedDetails.recordedAt, true)} {timeZoneLabel()}
              </p>
              <p>
                {!acceptedVisible || data.flight.outstandingWork
                  ? 'Waiting for processing and a fresh evidence check.'
                  : finding.status === 'resolved'
                    ? finding.closure?.by === 'record'
                      ? 'The evidence check cleared, so the finding closed by itself.'
                      : 'The finding is closed.'
                    : clear
                      ? 'The evidence check cleared. The finding remains open until its owner closes it.'
                      : 'The latest evidence still needs review.'}
              </p>
              <Button kind="quiet" onClick={() => onEvidence({ eventId: acceptedId })}>
                Show recorded correction
              </Button>
            </div>
          )}
          {acceptedId && <h5>Reports reviewed before this correction</h5>}
          {loading && <Spinner label="Reading the cited source reports" />}
          {readError && (
            <Notice tone="attention" title="Source context unavailable">
              {readError} Review the retained originals before correcting a report.
            </Notice>
          )}
          {reports.slice(0, 8).map((report, index) => {
            const item = citedLandingReport(records[report.eventId], report, data.flight.id);
            const payload = item ? reportPayload(item) : null;
            const person = item ? retainedReportText(item, 'personName', 200) : null;
            const note = item ? retainedReportText(item, 'note', 2000) : null;
            const recordedAt =
              payload &&
              typeof payload.reportRecordedAt === 'string' &&
              Number.isFinite(Date.parse(payload.reportRecordedAt))
                ? payload.reportRecordedAt
                : null;
            return (
              <article
                key={`${report.eventId}:${report.field}:${index}`}
                className="landing-source-card"
                data-testid="reconciliation-report"
                data-source-id={report.sourceId}
              >
                <strong>{person ?? sourceLabel(report.sourceId)}</strong>
                {person && <small>{sourceLabel(report.sourceId)}</small>}
                <p className="landing-claim-time">
                  {acceptedId ? 'Claim before correction' : 'Claimed touchdown'}{' '}
                  <time dateTime={report.reportedTime ?? undefined}>
                    {report.reportedTime
                      ? `${time(report.reportedTime, true)} ${timeZoneLabel()}`
                      : 'Unknown or invalid'}
                  </time>
                </p>
                {item && (
                  <small>
                    Report occurrence {time(item.occurredAt, true)} {timeZoneLabel()} · received{' '}
                    {time(item.receivedAt, true)} {timeZoneLabel()}
                  </small>
                )}
                {recordedAt && (
                  <small>
                    Source recorded this report {time(recordedAt, true)} {timeZoneLabel()}
                  </small>
                )}
                {item && retainedReportText(item, 'aircraft', 200) && (
                  <small>{retainedReportText(item, 'aircraft', 200)}</small>
                )}
                {note ? (
                  <blockquote>
                    <span>Source explanation</span>
                    {note}
                  </blockquote>
                ) : (
                  item && <p className="form-note">No source explanation is retained with this report.</p>
                )}
                <div className="landing-source-actions">
                  <Button
                    kind="quiet"
                    onClick={() =>
                      onEvidence({
                        eventId: report.eventId,
                        ...(report.receiptId ? { receiptId: report.receiptId } : {}),
                      })
                    }
                  >
                    Review source report
                  </Button>
                  {canCorrect && finding.status !== 'resolved' && !clear && (
                    <Button
                      disabled={
                        !item ||
                        loading ||
                        locked ||
                        updating ||
                        Boolean(draft) ||
                        Boolean(acceptedId) ||
                        review?.id !== latest.id
                      }
                      onClick={() => item && choose(report, item)}
                    >
                      Correct this report
                    </Button>
                  )}
                </div>
              </article>
            );
          })}
          {reports.length > 8 && (
            <p className="form-note">
              Showing eight cited claims. Review the full evaluation and source history before proceeding.
            </p>
          )}
          {review?.id !== latest.id && !draft && !acceptedId && (
            <Button
              kind="quiet"
              onClick={() => {
                setRecords({});
                setReview(structuredClone(latest));
              }}
            >
              Review latest evidence
            </Button>
          )}
          {!canCorrect && (
            <p className="form-note">
              A person with correction authority can append a correction after reviewing the sources.
            </p>
          )}
          {acceptedId && acceptedVisible && !data.flight.outstandingWork && !clear && (
            <Button
              kind="quiet"
              onClick={() => {
                setAcceptedId(null);
                setAcceptedDetails(null);
                setRecords({});
                setReview(structuredClone(latest));
              }}
            >
              Continue reconciliation
            </Button>
          )}
          {failure && (
            <Notice tone="attention" title={unknown ? 'Correction result unconfirmed' : 'Correction was not recorded'}>
              {failure.text}
              {unknown && (
                <p>
                  Your original correction is retained. Retry it to confirm the result before making another change.
                </p>
              )}
            </Notice>
          )}
          {unknown && (
            <Button kind="primary" disabled={busy} onClick={() => void send()}>
              Retry original correction
            </Button>
          )}
          {draft && (
            <form ref={form} className="action-form" data-testid="landing-correction-form" onSubmit={submit}>
              <h4>Correct {sourceLabel(draft.report.sourceId)}’s landing claim</h4>
              <p className="form-note">
                Original claim:{' '}
                {draft.report.reportedTime
                  ? `${time(draft.report.reportedTime, true)} ${timeZoneLabel()}`
                  : draft.report.value}
                . The original report stays retained.
              </p>
              <div className={`draft-basis ${stale ? 'is-stale' : ''}`}>
                <span>
                  {stale
                    ? 'The finding or viewed basis changed. Your correction draft is kept.'
                    : 'Pins these source reports and your viewed flight basis.'}
                </span>
                {stale && !unknown && (
                  <Button
                    kind="quiet"
                    disabled={busy || updating}
                    onClick={() => {
                      setDraft({ ...draft, basis: structuredClone(basis), evaluationId: latest.id });
                      setReview(structuredClone(latest));
                      setFailure(null);
                    }}
                  >
                    Refresh basis
                  </Button>
                )}
              </div>
              {!activeTarget && (
                <Notice tone="attention">
                  This claim is no longer active in the latest evaluation. Review its replacement before making another
                  correction.
                </Notice>
              )}
              <fieldset className="landing-time-choice" disabled={locked}>
                <legend>Which touchdown time did you confirm?</legend>
                {[...new Set(reports.flatMap((report) => (report.reportedTime ? [report.reportedTime] : [])))].map(
                  (value) => (
                    <label key={value}>
                      <input
                        type="radio"
                        name={`confirmed-landing-${finding.id}`}
                        value={value}
                        checked={!draft.differentTime && draft.landingTime === value}
                        onChange={() => setDraft({ ...draft, landingTime: value, differentTime: false })}
                      />
                      Use reported landing {time(value, true)} {timeZoneLabel()}
                    </label>
                  ),
                )}
                <label>
                  <input
                    type="radio"
                    name={`confirmed-landing-${finding.id}`}
                    checked={draft.differentTime}
                    onChange={() => setDraft({ ...draft, differentTime: true })}
                  />
                  Enter a different time
                </label>
              </fieldset>
              {draft.differentTime && (
                <label>
                  Confirmed touchdown time ({zone})
                  <input
                    type="datetime-local"
                    step="1"
                    value={draft.customTime}
                    disabled={locked}
                    onChange={(event) => setDraft({ ...draft, customTime: event.target.value })}
                    required
                  />
                  <small>
                    Uses your browser’s time zone. Recorded in UTC, shown below in the organization’s time (
                    {timeZoneLabel()}).
                  </small>
                </label>
              )}
              {confirmedTime && (
                <p className="landing-confirmed-time">
                  New claim:{' '}
                  <strong>
                    {time(confirmedTime, true)} {timeZoneLabel()}
                  </strong>
                </p>
              )}
              {confirmedTime && !changedTime && (
                <p className="form-note">
                  That is this report’s existing time. Choose a different verified time or leave it unchanged.
                </p>
              )}
              <label htmlFor={`landing-correction-note-${finding.id}`}>What confirms this correction?</label>
              <textarea
                id={`landing-correction-note-${finding.id}`}
                value={draft.note}
                rows={4}
                maxLength={4000}
                disabled={locked}
                onChange={(event) => setDraft({ ...draft, note: event.target.value })}
                placeholder="Name the source or person you checked, what they confirmed, and why this claim changes."
                required
              />
              <details>
                <summary>Report clock and exact correction target</summary>
                <p className="form-note">
                  Report occurrence stays {time(draft.target.occurredAt, true)} {timeZoneLabel()}. This correction
                  changes the claimed touchdown time; it does not backdate receipt or change the other reported values.
                </p>
                <pre>
                  {json({
                    eventId: draft.target.id,
                    receiptId: draft.target.receiptId ?? null,
                    field: reportField(draft.target, draft.report) ?? draft.report.field,
                    original: draft.report.value,
                    corrected: confirmedTime ?? null,
                  })}
                </pre>
              </details>
              <Button
                kind="primary"
                type="submit"
                disabled={
                  !canCorrect || locked || updating || stale || !activeTarget || !changedTime || !draft.note.trim()
                }
              >
                Append landing correction
              </Button>
              <Button
                kind="quiet"
                disabled={locked}
                onClick={() => {
                  setDraft(null);
                  setFailure(null);
                  attempt.current = null;
                }}
              >
                Cancel correction
              </Button>
            </form>
          )}
          {!draft && !acceptedId && !clear && (
            <p className="form-note">
              Cannot establish the time? Keep the finding open and record what remains uncertain.
            </p>
          )}
        </>
      )}
    </section>
  );
}
