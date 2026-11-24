import { useEffect, useRef, useState } from 'react';
import { ApiError, LedgerClient } from '@ledger/contracts/client';
import type {
  ErrorResponse,
  FlightResponse,
  FlightSummary,
  Principal,
  SimulationAvoidanceDemoControl,
  SimulationAvoidanceDemoCycleResponse,
  SimulationAvoidanceDemoPrepare,
  SmsDecisionRecord,
  SmsRecordDetailResponse,
} from '@ledger/contracts';
import { Badge, Button, Notice, Spinner } from '@ledger/ui';
import { errorMessage, json, time, timeZoneLabel } from './format.js';
import {
  demoCanRepeat,
  demoControlReference,
  demoPhaseActions,
  demoPhaseLabels,
  retainDemoProgress,
  validateDemoCycle,
  type AvoidanceDemoMission,
  type DemoAreaControl,
} from './avoidance-demo.js';
import { plainError } from './sms-labels.js';
import { readFailureOutcome, readFailureStep } from './read-failure.js';

type Cycle = SimulationAvoidanceDemoCycleResponse;
type Failure = { text: string; uncertain: boolean };
type Attempt = { client: LedgerClient; body: SimulationAvoidanceDemoPrepare; key: string };

function unavailable(failure: unknown): boolean {
  if (!(failure instanceof ApiError)) return false;
  const code = (failure.body as Partial<ErrorResponse>)?.error?.code;
  // Not configured for this organization, or this accepted control is not one a demo flight can exercise.
  return code === 'simulation_demo_not_configured' || code === 'control_not_found';
}

interface HazardRead {
  decisions: SmsDecisionRecord[];
  controls?: { id: string; versionNumber: number; accepted: boolean }[];
}

/**
 * On a control record's page: when the latest risk acceptance on its hazard binds this exact version, the demo flights
 * that exercise it. Opens nothing when the control version is not accepted.
 */
export function ControlDemoSection({
  client,
  principal,
  detail,
  onReviewMission,
}: {
  client: LedgerClient;
  principal: Principal;
  detail: SmsRecordDetailResponse;
  onReviewMission: (flight: FlightSummary, demo: AvoidanceDemoMission) => void;
}) {
  const current = detail.current as { id: string; versionNumber: number; bodyDigest: string; title?: string };
  const body = current as unknown as { body: { hazardId: string; effectiveUntil?: string | null } };
  const hazardId = body.body.hazardId;
  const [control, setControl] = useState<DemoAreaControl | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    let stopped = false;
    client
      .request<HazardRead>(`/v1/sms/records/${encodeURIComponent(hazardId)}`)
      .then((hazard) => {
        if (stopped) return;
        const listed = hazard.controls?.find(
          (entry) => entry.id === detail.record.id && entry.versionNumber === current.versionNumber,
        );
        const acceptance = hazard.decisions.find((decision) => decision.kind === 'risk.accept');
        if (!listed?.accepted || !acceptance) return setControl(null);
        setControl({
          reference: demoControlReference(
            {
              hazardId,
              controlId: detail.record.id,
              versionNumber: current.versionNumber,
              versionId: current.id,
              bodyDigest: current.bodyDigest,
            },
            acceptance,
          ),
          title: detail.record.title,
          effectiveUntil: body.body.effectiveUntil ?? null,
        });
        setFailure(null);
      })
      .catch((error: unknown) => !stopped && setFailure(plainError(error).message));
    return () => {
      stopped = true;
    };
  }, [client, hazardId, detail.record.id, current.id, current.versionNumber, current.bodyDigest]);
  if (failure)
    return (
      <Notice tone="attention" title="Demo flights unconfirmed">
        {failure}
      </Notice>
    );
  if (!control) return null;
  return (
    <AvoidanceDemoPanel
      key={control.reference.controlEventId}
      active
      client={client}
      principal={principal}
      control={control}
      onReviewMission={onReviewMission}
      onAccessLost={() => setControl(null)}
    />
  );
}

export function AvoidanceDemoPanel({
  active,
  client,
  principal,
  control,
  onReviewMission,
  onAccessLost,
}: {
  active: boolean;
  client: LedgerClient;
  principal: Principal;
  control: DemoAreaControl;
  onReviewMission: (flight: FlightSummary, demo: AvoidanceDemoMission) => void;
  onAccessLost: (failure: unknown) => void;
}) {
  const reference = control.reference;
  const [cycles, setCycles] = useState<Record<string, Cycle>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [readAt, setReadAt] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const attempt = useRef<Attempt | null>(null);
  const pending = useRef(false);
  const alive = useRef(true);
  const selectionSequence = useRef(0);
  const earlierLoaded = useRef(false);
  const current = useRef({ active, client, selectedId });
  current.current = { active, client, selectedId };
  const accessLost = useRef(onAccessLost);
  accessLost.current = onAccessLost;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!active || disabled) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const page = await client.hazardSimulationAvoidanceDemos(reference.hazardId, {
          controlEventId: reference.controlEventId,
          acceptanceId: reference.acceptance.id,
          limit: 10,
        });
        await Promise.all(page.cycles.map((cycle) => validateDemoCycle(cycle, reference)));
        if (!stopped) {
          setCycles((previous) => {
            const next = { ...previous };
            for (const cycle of page.cycles) next[cycle.cycle.id] = retainDemoProgress(next[cycle.cycle.id], cycle);
            return next;
          });
          setSelectedId((previous) => previous ?? page.cycles[0]?.cycle.id ?? null);
          if (!earlierLoaded.current) setCursor(page.nextCursor);
          setReadAt(page.readAt);
          setReadError(null);
        }
      } catch (error) {
        if (!stopped) {
          if (unavailable(error)) setDisabled(true);
          else {
            setReadError(errorMessage(error));
            // The demo flights of this exact accepted control are what the panel is about.
            if (readFailureOutcome(error, true) === 'access_lost') {
              setCycles({});
              setSelectedId(null);
              accessLost.current(error);
            }
          }
        }
      }
      if (!stopped) timer = setTimeout(() => void poll(), 5000);
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [active, client, reference, disabled, reload]);

  const selected = selectedId ? cycles[selectedId] : undefined;
  const exact = useDemoCycle(active, client, reference, selectedId, undefined, selected);
  const shown = exact.result;

  async function earlier() {
    if (!cursor || pending.current) return;
    const expectedCursor = cursor;
    setOpening(true);
    try {
      const page = await client.hazardSimulationAvoidanceDemos(reference.hazardId, {
        controlEventId: reference.controlEventId,
        acceptanceId: reference.acceptance.id,
        limit: 10,
        cursor: expectedCursor,
      });
      await Promise.all(page.cycles.map((cycle) => validateDemoCycle(cycle, reference)));
      if (!alive.current) return;
      earlierLoaded.current = true;
      setCycles((previous) => {
        const next = { ...previous };
        for (const cycle of page.cycles) next[cycle.cycle.id] = retainDemoProgress(next[cycle.cycle.id], cycle);
        return next;
      });
      setCursor(page.nextCursor);
    } catch (error) {
      if (alive.current) setReadError(errorMessage(error));
    } finally {
      if (alive.current) setOpening(false);
    }
  }

  async function reviewMission() {
    const cycle = shown;
    const flightId = cycle?.progress?.references.execution?.flightId;
    if (!cycle || !flightId || opening || !active) return;
    const expectedId = cycle.cycle.id;
    const expectedSelection = selectionSequence.current;
    setOpening(true);
    setActionError(null);
    try {
      const result = await client.request<FlightResponse>(`/v1/flights/${encodeURIComponent(flightId)}`);
      if (result.flight.id !== flightId)
        throw new Error('The affected flight could not be matched to this operator. Refresh the demo progress.');
      if (
        !alive.current ||
        !current.current.active ||
        current.current.client !== client ||
        current.current.selectedId !== expectedId ||
        selectionSequence.current !== expectedSelection
      )
        return;
      onReviewMission(structuredClone(result.flight), { cycleId: expectedId, control: structuredClone(control) });
    } catch (error) {
      if (alive.current) setActionError(errorMessage(error));
    } finally {
      if (alive.current) setOpening(false);
    }
  }

  async function send(saved: Attempt, recovering: boolean) {
    const expectedSelection = selectionSequence.current;
    pending.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const result = await saved.client.prepareSimulationAvoidanceDemo(reference.hazardId, saved.body, saved.key);
      await validateDemoCycle(result, saved.body.control);
      if (
        result.cycle.trigger !== saved.body.mode ||
        result.cycle.previousCycleId !== (saved.body.previousCycleId ?? null)
      )
        throw new Error(
          'The accepted request could not be matched to its previous demo flight. Recover the same request.',
        );
      if (!alive.current) return;
      setCycles((previous) => ({
        ...previous,
        [result.cycle.id]: retainDemoProgress(previous[result.cycle.id], result),
      }));
      if (selectionSequence.current === expectedSelection) {
        selectionSequence.current++;
        setSelectedId(result.cycle.id);
      }
      attempt.current = null;
      setReload((value) => value + 1);
    } catch (error) {
      if (alive.current) {
        const uncertain = recovering || !(error instanceof ApiError) || error.status >= 500 || error.status === 408;
        setFailure({ text: errorMessage(error), uncertain });
        if (!uncertain) attempt.current = null;
      }
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  }

  async function prepare(mode: 'initial' | 'repeat') {
    if (
      pending.current ||
      attempt.current ||
      (mode === 'repeat' ? !shown || !demoCanRepeat(shown) : Object.keys(cycles).length > 0)
    )
      return;
    pending.current = true;
    setBusy(true);
    setFailure(null);
    try {
      if (ended(control)) throw new Error('This control’s effective interval has ended. Review its recorded outcome.');
      const session = (await client.request<{ principal: Principal }>('/v1/me')).principal;
      if (
        session.id !== principal.id ||
        session.tenantId !== principal.tenantId ||
        session.revision !== principal.revision ||
        !['flight:read', 'decision:write'].every((capability) =>
          session.capabilities.some((value) => value === capability),
        )
      )
        throw new Error('Your authority changed. Refresh your session before preparing another demo flight.');
      if (mode === 'repeat' && shown) {
        const fresh = await client.simulationAvoidanceDemo(shown.cycle.id);
        await validateDemoCycle(fresh, reference, { cycleId: shown.cycle.id });
        if (!demoCanRepeat(fresh))
          throw new Error('This demo flight is still in progress. Wait for its terminal record.');
      }
      if (!alive.current) return;
      if (ended(control)) throw new Error('This control’s effective interval has ended. Review its recorded outcome.');
      const saved: Attempt = {
        client,
        key: crypto.randomUUID(),
        body: structuredClone({
          version: 'simulation.avoidance-prepare.1',
          mode,
          control: reference,
          ...(mode === 'repeat' && shown ? { previousCycleId: shown.cycle.id } : {}),
          expectedPrincipalRevision: session.revision,
        }),
      };
      attempt.current = saved;
      await send(saved, false);
    } catch (error) {
      if (alive.current) setFailure({ text: errorMessage(error), uncertain: false });
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  }

  const ordered = Object.values(cycles).sort((left, right) =>
    left.cycle.requestedAt.localeCompare(right.cycle.requestedAt),
  );
  const canPrepare = ['flight:read', 'decision:write'].every((capability) =>
    principal.capabilities.some((value) => value === capability),
  );
  const expired = ended(control);
  const historicalMission = expired || Boolean(shown && demoCanRepeat(shown));
  // Demo flights are not configured here, or this accepted control is not one a demo flight can exercise.
  if (disabled) return null;
  return (
    <section className="safety-section avoidance-demo" aria-label="Accepted control demo flight">
      <div className="safety-section-heading">
        <h3>{historicalMission ? 'Recorded control demonstration' : 'Try this accepted control'}</h3>
        <Badge>Live simulation</Badge>
      </div>
      <>
        <p className="avoidance-demo-control">
          {control.title} · control version {reference.controlVersion}
        </p>
        {expired && (
          <p className="muted">
            This control’s effective interval ended {time(control.effectiveUntil ?? undefined, true)} {timeZoneLabel()}.
            Review its recorded outcome before proposing a new control interval. New demo preparation is unavailable.
          </p>
        )}
        {(readError || exact.error) && (
          <Notice tone="attention" title="Demo progress unconfirmed">
            {readError ?? exact.error} Retained progress stays visible.
          </Notice>
        )}
        {!shown && !readError && !exact.error && !readAt && <Spinner label="Reading demo flight preparation" />}
        {!shown && !readError && !exact.error && readAt && (
          <>
            <p>No demo flight has been prepared for this accepted control.</p>
            <Button
              kind="next"
              disabled={busy || Boolean(attempt.current) || !canPrepare || expired}
              onClick={() => void prepare('initial')}
            >
              Prepare demo flight
            </Button>
            {!canPrepare && <p className="muted">Preparing a flight requires decision and flight-read authority.</p>}
          </>
        )}
        {shown && (
          <>
            <DemoProgress result={shown} />
            {shown.progress?.references.execution && (
              <Button
                kind={historicalMission ? 'quiet' : 'next'}
                disabled={opening}
                onClick={() => void reviewMission()}
              >
                {opening
                  ? 'Opening mission…'
                  : historicalMission
                    ? 'Inspect recorded mission →'
                    : 'Review affected mission →'}
              </Button>
            )}
            {shown.progress?.references.controlWindow && (
              <p className="avoidance-demo-window" data-testid="avoidance-demo-control-window">
                Control window {shown.progress.references.controlWindow.id} is open for this flight. Its indicator
                result appears with this control’s indicators.
              </p>
            )}
            {demoCanRepeat(shown) && (
              <div className="avoidance-demo-repeat">
                {!expired && (
                  <p>
                    The recorded cycle remains available. Another cycle creates a new held flight for this same accepted
                    control.
                  </p>
                )}
                <Button
                  kind="next"
                  disabled={busy || Boolean(attempt.current) || !canPrepare || expired}
                  onClick={() => void prepare('repeat')}
                >
                  Prepare another demo flight
                </Button>
                {!canPrepare && (
                  <p className="muted">Preparing another flight requires decision and flight-read authority.</p>
                )}
              </div>
            )}
          </>
        )}
        {actionError && (
          <Notice tone="attention" title="Affected mission unavailable">
            {actionError}
          </Notice>
        )}
        {failure && (
          <Notice tone="attention" title={failure.uncertain ? 'Preparation result unknown' : 'Demo action unavailable'}>
            {failure.text}
            {failure.uncertain && (
              <>
                <p>The original request is retained. Recover it before preparing another flight.</p>
                <Button
                  disabled={busy}
                  onClick={() => {
                    if (attempt.current && !pending.current) void send(attempt.current, true);
                  }}
                >
                  Recover same preparation request
                </Button>
              </>
            )}
          </Notice>
        )}
        {ordered.length > 1 && (
          <details className="safety-history">
            <summary>Demo flight history · {ordered.length} retained cycles</summary>
            <ol className="avoidance-demo-history">
              {ordered.map((cycle) => (
                <li key={cycle.cycle.id}>
                  <button
                    aria-current={cycle.cycle.id === selectedId ? 'true' : undefined}
                    onClick={() => {
                      selectionSequence.current++;
                      setSelectedId(cycle.cycle.id);
                    }}
                  >
                    <strong>{cycle.cycle.trigger === 'initial' ? 'Initial flight' : 'Another flight'}</strong>
                    <span>
                      {time(cycle.cycle.requestedAt, true)} {timeZoneLabel()} ·{' '}
                      {cycle.progress ? demoPhaseLabels[cycle.progress.phase] : 'Preparation requested'}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </details>
        )}
        {cursor && (
          <Button kind="quiet" disabled={opening} onClick={() => void earlier()}>
            Load earlier demo flights
          </Button>
        )}
        {readAt && (
          <p className="muted avoidance-demo-read">
            Progress read {time(readAt, true)} {timeZoneLabel()}
          </p>
        )}
      </>
    </section>
  );
}

/** Whether the control's effective interval has ended; an open-ended control has not. */
function ended(control: DemoAreaControl): boolean {
  return control.effectiveUntil !== null && Date.now() >= Date.parse(control.effectiveUntil);
}

function useDemoCycle(
  active: boolean,
  client: LedgerClient,
  control: SimulationAvoidanceDemoControl,
  cycleId: string | null,
  flightId?: string,
  initial?: Cycle,
) {
  const [result, setResult] = useState<Cycle | undefined>(initial);
  const [failure, setFailure] = useState<{ cycleId: string; text: string; denied: boolean } | null>(null);
  const initialResult = initial?.cycle.id === cycleId ? initial : undefined;
  const visible =
    failure?.cycleId === cycleId && failure.denied
      ? undefined
      : result?.cycle.id === cycleId
        ? retainDemoProgress(initialResult, result)
        : initialResult;
  useEffect(() => {
    if (!active || !cycleId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll(readAgainIfStale = true): Promise<void> {
      try {
        const next = await client.simulationAvoidanceDemo(cycleId!);
        await validateDemoCycle(next, control, { cycleId: cycleId!, ...(flightId ? { flightId } : {}) });
        if (!stopped) {
          setResult((previous) => retainDemoProgress(previous, next));
          setFailure(null);
        }
      } catch (failure) {
        if (!stopped) {
          // The cycle was listed by the control's demo flights or named by the mission that opened it.
          const step = readFailureStep(readFailureOutcome(failure, false), readAgainIfStale);
          if (step === 'read_again') return poll(false);
          const denied = step === 'clear';
          setFailure({ cycleId: cycleId!, text: errorMessage(failure), denied });
          if (denied) setResult(undefined);
        }
      }
      if (!stopped) timer = setTimeout(() => void poll(), 3000);
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [active, client, control, cycleId, flightId]);
  return { result: visible, error: failure?.cycleId === cycleId ? failure.text : null };
}

function DemoProgress({ result }: { result: Cycle }) {
  const progress = result.progress;
  return (
    <div className="avoidance-demo-progress" aria-live="polite">
      <strong>{progress ? demoPhaseLabels[progress.phase] : 'Preparation requested'}</strong>
      {progress && (
        <small className="avoidance-demo-read">
          Coordinator update · {time(progress.recordedAt, true)} {timeZoneLabel()}
        </small>
      )}
      <p>{progress ? demoPhaseActions[progress.phase] : 'Waiting for the simulator to record preparation progress.'}</p>
      {progress &&
        (['blocked', 'departure_unknown', 'abandoned'].includes(progress.phase) ||
          (progress.phase === 'preparing' && progress.code !== 'source_delivery_pending')) && (
          <p className="muted">{progress.reason}</p>
        )}
      {result.processing !== 'completed' && (
        <p className="muted">
          {result.processing === 'failed'
            ? 'The cycle record needs processing review.'
            : 'Adding the cycle record to Ledger.'}
        </p>
      )}
      <details className="mission-provenance">
        <summary>Exact demo association and progress</summary>
        {progress && <p>{progress.reason}</p>}
        <pre>{json(result)}</pre>
      </details>
    </div>
  );
}

export function MissionDemoProgress({
  active,
  client,
  demo,
  flightId,
  onBriefing,
  onMonitoring,
}: {
  active: boolean;
  client: LedgerClient;
  demo: AvoidanceDemoMission;
  flightId: string;
  onBriefing?: (releaseId: string, briefingId?: string) => void;
  /** Opens the control's safety record, where its windows and indicator results are shown. */
  onMonitoring?: (control: DemoAreaControl) => void;
}) {
  const { result, error } = useDemoCycle(active, client, demo.control.reference, demo.cycleId, flightId);
  return (
    <section className="safety-section avoidance-demo" aria-label="Linked demo flight progress">
      <div className="safety-section-heading">
        <h3>Accepted control demo flight</h3>
        <Badge>Live simulation</Badge>
      </div>
      <p className="avoidance-demo-control">
        {demo.control.title} · control version {demo.control.reference.controlVersion}
      </p>
      {error && (
        <Notice tone="attention" title="Demo progress unconfirmed">
          {error}
        </Notice>
      )}
      {!result && !error && <Spinner label="Reading this exact demo flight" />}
      {result && (
        <>
          <DemoProgress result={result} />
          {onBriefing &&
            result.progress?.references.release &&
            ['awaiting_briefing', 'awaiting_acknowledgement'].includes(result.progress.phase) && (
              <Button
                kind="next"
                onClick={() =>
                  onBriefing(result.progress!.references.release!.id, result.progress!.references.briefing?.id)
                }
              >
                {' '}
                {result.progress.phase === 'awaiting_briefing'
                  ? 'Prepare exact briefing →'
                  : 'Open exact personal review →'}
              </Button>
            )}
          {onMonitoring && (result.progress?.references.monitoring || result.progress?.references.controlWindow) && (
            <Button kind="next" onClick={() => onMonitoring(demo.control)}>
              Review the control’s indicators →
            </Button>
          )}
          {result.progress?.references.controlWindow && (
            <p className="avoidance-demo-window" data-testid="avoidance-demo-control-window">
              Control window {result.progress.references.controlWindow.id} is open for this flight. Its indicator result
              appears on the control’s safety record.
            </p>
          )}
        </>
      )}
    </section>
  );
}
