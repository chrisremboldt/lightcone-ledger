import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, LedgerClient } from '@ledger/contracts/client';
import type { MissionReleaseCommand, Principal } from '@ledger/contracts';
import { Button, Notice, Spinner } from '@ledger/ui';
import { errorMessage, json } from './format.js';
import { aircraftLabel } from './labels.js';
import { ReleaseFindings } from './ReleaseFindings.js';
import {
  buildMissionReleaseCommand,
  findingChanges,
  RELEASE_POLICY,
  missionTime,
  releaseBasis,
  releaseReadiness,
  releaseWindowProblem,
  type MissionReview,
} from './missionRelease.js';

interface Props {
  client: LedgerClient;
  principal: Principal;
  review: MissionReview | null;
  onRefresh: () => Promise<MissionReview>;
  onAccepted: (releaseId: string) => void;
  /** Told when the form opens or closes, so the review reads release findings only while it is open. */
  onFormOpen?: (open: boolean) => void;
}
interface Draft {
  review: MissionReview;
  basis: string;
  principalId: string;
  principalRevision: number;
  from: string;
  until: string;
  note: string;
  /** The person recorded that they reviewed the listed open findings. */
  findingsSeen: boolean;
}
interface Failure {
  text: string;
  conflict: boolean;
  uncertain: boolean;
}

function localTime(value: string): string {
  const date = new Date(value);
  const pad = (number: number) => String(number).padStart(2, '0');
  const milliseconds = date.getMilliseconds();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${milliseconds ? `.${String(milliseconds).padStart(3, '0')}` : ''}`;
}

function changesBetween(before: MissionReview, after: MissionReview) {
  if (!before.findings || !after.findings || before.findings.basis.digest === after.findings.basis.digest) return null;
  return findingChanges(before.findings.basis.findings, after.findings.basis.findings);
}

function utcTime(value: string): string | null {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

export function ReleaseForm({ client, principal, review, onRefresh, onAccepted, onFormOpen }: Props) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [acceptedId, setAcceptedId] = useState<string | null>(null);
  const [findingsChanged, setFindingsChanged] = useState<ReturnType<typeof findingChanges> | null>(null);
  const attempt = useRef<{ command: MissionReleaseCommand; key: string } | null>(null);
  const inFlight = useRef(false);
  const startField = useRef<HTMLInputElement>(null);
  const prepareAction = useRef<HTMLDivElement>(null);
  const formWasOpen = useRef(false);
  const alive = useRef(true);
  const scope = useRef({ client, principalId: principal.id, flightId: review?.flight.id });
  scope.current = { client, principalId: principal.id, flightId: review?.flight.id };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    onFormOpen?.(formOpen);
  }, [formOpen, onFormOpen]);
  useEffect(() => {
    if (formOpen) startField.current?.focus();
    else if (formWasOpen.current) prepareAction.current?.querySelector('button')?.focus();
    formWasOpen.current = formOpen;
  }, [formOpen]);

  const canRelease = ['flight:read', 'decision:write', 'mission:release'].every((capability) =>
    principal.capabilities.some((granted) => granted === capability),
  );
  const reasons = releaseReadiness(review);
  const uncertain = failure?.uncertain ?? false;
  const stale = Boolean(
    draft &&
    (!review ||
      draft.basis !== releaseBasis(review) ||
      draft.principalId !== principal.id ||
      draft.principalRevision !== principal.revision),
  );
  const from = draft ? utcTime(draft.from) : null;
  const until = draft ? utcTime(draft.until) : null;
  const windowProblem = draft ? releaseWindowProblem(draft.review, from ?? '', until ?? '') : null;
  const locked = busy || uncertain;
  const liveChanges = draft && review ? changesBetween(draft.review, review) : null;
  const needsAttestation = Boolean(draft?.review.findings?.basis.findings.length);
  const attested = !needsAttestation || Boolean(draft?.findingsSeen);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  function prepare() {
    if (draft) {
      setFormOpen(true);
      return;
    }
    if (!review || reasons.length || !canRelease || inFlight.current) return;
    const mission = review.mission.acceptedHead!.record;
    setDraft({
      review: structuredClone(review),
      basis: releaseBasis(review),
      principalId: principal.id,
      principalRevision: principal.revision,
      from: localTime(mission.operatingInterval.start),
      until: localTime(mission.operatingInterval.end),
      note: '',
      findingsSeen: false,
    });
    setFormOpen(true);
    setFailure(null);
    setFindingsChanged(null);
    setRefreshRequired(false);
    attempt.current = null;
  }

  function change(values: Partial<Pick<Draft, 'from' | 'until' | 'note' | 'findingsSeen'>>) {
    if (locked) return;
    setDraft((previous) => (previous ? { ...previous, ...values } : previous));
  }

  async function refresh() {
    if (!draft || locked || refreshing) return;
    const saved = draft;
    setRefreshing(true);
    try {
      const next = await onRefresh();
      if (
        !alive.current ||
        scope.current.client !== client ||
        scope.current.principalId !== principal.id ||
        (scope.current.flightId && scope.current.flightId !== saved.review.flight.id) ||
        next.flight.id !== saved.review.flight.id
      )
        return;
      const changes = changesBetween(saved.review, next);
      setDraft({
        ...saved,
        review: structuredClone(next),
        basis: releaseBasis(next),
        principalId: principal.id,
        principalRevision: principal.revision,
        // A changed list needs reviewing again before it is attested.
        findingsSeen: changes ? false : saved.findingsSeen,
      });
      setFindingsChanged(changes);
      setFailure(null);
      setRefreshRequired(false);
      attempt.current = null;
    } catch (error) {
      if (alive.current) setFailure({ text: errorMessage(error), conflict: false, uncertain: false });
    } finally {
      if (alive.current) setRefreshing(false);
    }
  }

  async function send(command: MissionReleaseCommand) {
    if (inFlight.current) return;
    attempt.current ??= { command: structuredClone(command), key: crypto.randomUUID() };
    const saved = attempt.current;
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const response = await client.command(saved.command, saved.key);
      if (
        !alive.current ||
        scope.current.client !== client ||
        scope.current.principalId !== principal.id ||
        (scope.current.flightId && scope.current.flightId !== saved.command.flightId)
      )
        return;
      setAcceptedId(response.command.id);
      setDraft(null);
      setFindingsChanged(null);
      setFormOpen(false);
      attempt.current = null;
      setRefreshRequired(false);
      onAccepted(response.command.id);
    } catch (error) {
      if (!alive.current) return;
      const uncertainResult = !(error instanceof ApiError) || error.status >= 500 || error.status === 408;
      const conflict = error instanceof ApiError && error.status === 409;
      setFailure({ text: errorMessage(error), uncertain: uncertainResult, conflict });
      if (!uncertainResult) attempt.current = null;
      if (conflict) setRefreshRequired(true);
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (
      !draft ||
      locked ||
      refreshing ||
      stale ||
      refreshRequired ||
      !canRelease ||
      reasons.length ||
      windowProblem ||
      !attested ||
      !from ||
      !until ||
      !draft.note.trim()
    )
      return;
    try {
      const command = buildMissionReleaseCommand(
        draft.review,
        draft.principalRevision,
        { start: from, end: until },
        draft.note,
      );
      await send(command);
    } catch (error) {
      setFailure({ text: errorMessage(error), conflict: false, uncertain: false });
    }
  }

  return (
    <section className="mission-release-actions" aria-label="Mission release action">
      {acceptedId && (
        <div className="action-success" role="status">
          Mission release recorded.
        </div>
      )}
      {!canRelease && (
        <p className="muted">
          Your role can review this mission. Recording its release requires mission release and decision authority.
        </p>
      )}
      {reasons.length > 0 && (
        <Notice title="Release prerequisite">
          <ul>
            {reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </Notice>
      )}
      {failure && (
        <Notice
          tone={failure.conflict || failure.uncertain ? 'attention' : 'alert'}
          title={
            failure.uncertain
              ? 'Confirm the recorded result'
              : failure.conflict
                ? 'The reviewed release context changed'
                : 'Release was not recorded'
          }
        >
          {failure.text}
          {failure.uncertain && (
            <>
              <p>
                The result is unknown. Your draft is retained. Retry the identical release to recover its recorded
                result.
              </p>
              <Button disabled={busy} onClick={() => attempt.current && void send(attempt.current.command)}>
                Retry same action
              </Button>
            </>
          )}
        </Notice>
      )}
      {!formOpen && (
        <div className="mission-release-next-action" ref={prepareAction}>
          <h3>Record mission release</h3>
          <p>Review this exact route, aircraft and accepted avoidance controls, then choose its departure window.</p>
          <Button kind="next" disabled={busy || (!draft && (!canRelease || reasons.length > 0))} onClick={prepare}>
            {draft ? 'Continue release draft' : acceptedId ? 'Prepare another release' : 'Prepare release'}
          </Button>
        </div>
      )}
      {draft && formOpen && (
        <form
          className="action-form mission-release-form"
          data-testid="mission-release-form"
          onSubmit={(event) => void submit(event)}
        >
          <div className="form-heading">
            <h3>Record mission release</h3>
            <button
              type="button"
              aria-label="Close release form"
              disabled={locked || refreshing}
              onClick={() => setFormOpen(false)}
            >
              ×
            </button>
          </div>
          <p className="finding-consequence">
            Record route-avoidance release for this exact mission and aircraft. Final departure authorization remains a
            separate action.
          </p>
          <div className={`draft-basis ${stale || refreshRequired ? 'is-stale' : ''}`}>
            <span>
              Mission revision {draft.review.mission.acceptedHead?.record.sourceRevision} · aircraft{' '}
              {aircraftLabel(draft.review.flight.aircraft)}
            </span>
            {stale || refreshRequired ? (
              <>
                <span>
                  The mission, aircraft, safety context, open findings or authority changed. Review the latest record,
                  then refresh this basis. Your draft is retained.
                </span>
                <Button kind="next" type="button" disabled={locked || refreshing} onClick={() => void refresh()}>
                  {refreshing ? 'Refreshing…' : 'Refresh basis'}
                </Button>
              </>
            ) : (
              <small>Your identity, exact mission and compared safety context are retained with the release.</small>
            )}
          </div>
          <p className="muted">
            Mission operating interval ·{' '}
            {missionTime(draft.review.mission.acceptedHead!.record.operatingInterval.start)}–
            {missionTime(draft.review.mission.acceptedHead!.record.operatingInterval.end)}
          </p>
          <label htmlFor="release-window-start">Departure window starts</label>
          <input
            id="release-window-start"
            ref={startField}
            type="datetime-local"
            step={0.001}
            required
            disabled={locked || refreshing}
            value={draft.from}
            onChange={(event) => change({ from: event.target.value })}
          />
          <label htmlFor="release-window-end">Departure window ends</label>
          <input
            id="release-window-end"
            type="datetime-local"
            step={0.001}
            required
            disabled={locked || refreshing}
            value={draft.until}
            onChange={(event) => change({ until: event.target.value })}
          />
          <p className="form-note">
            Times use your browser’s local time ({timezone}). The window must fit within this mission interval and end
            in the future.
          </p>
          {windowProblem && (
            <p className="action-map-guard" role="status">
              {windowProblem}
            </p>
          )}
          {draft.review.findings && (
            <ReleaseFindings findings={draft.review.findings} changes={liveChanges ?? findingsChanged} />
          )}
          {needsAttestation && (
            <label className="release-findings-attestation" htmlFor="release-findings-seen">
              <input
                id="release-findings-seen"
                type="checkbox"
                disabled={locked || refreshing}
                checked={draft.findingsSeen}
                onChange={(event) => change({ findingsSeen: event.target.checked })}
              />
              I reviewed the {draft.review.findings!.basis.findings.length} open finding
              {draft.review.findings!.basis.findings.length === 1 ? '' : 's'} listed above.
            </label>
          )}
          <label htmlFor="release-note">Release note</label>
          <textarea
            id="release-note"
            rows={4}
            maxLength={4000}
            required
            disabled={locked || refreshing}
            value={draft.note}
            onChange={(event) => change({ note: event.target.value })}
          />
          <details className="mission-release-basis">
            <summary>Exact mission, comparison and release policy</summary>
            <p>
              {RELEASE_POLICY.title} · version {RELEASE_POLICY.version}
            </p>
            <p>{RELEASE_POLICY.instruction}</p>
            <pre>
              {json({
                mission: draft.review.preview.mission,
                calculation: draft.review.preview.calculation,
                policy: RELEASE_POLICY,
                contextDigest: draft.review.preview.contextDigest,
                findingsDigest: draft.review.findings?.basis.digest ?? null,
                principalRevision: draft.principalRevision,
                candidates: draft.review.preview.candidates,
              })}
            </pre>
          </details>
          <Button
            kind="primary"
            type="submit"
            disabled={
              locked ||
              refreshing ||
              stale ||
              refreshRequired ||
              !canRelease ||
              reasons.length > 0 ||
              Boolean(windowProblem) ||
              !attested ||
              !draft.note.trim()
            }
          >
            {busy ? <Spinner label="Recording mission release" /> : 'Record mission release'}
          </Button>
        </form>
      )}
    </section>
  );
}
