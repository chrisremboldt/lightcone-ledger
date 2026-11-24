import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, LedgerClient } from '@ledger/contracts/client';
import type {
  FlightControlsResponse,
  FlightSummary,
  MissionAvoidanceCandidate,
  MissionBriefingAcknowledgementsResponse,
  MissionBriefingControlRecordContent,
  MissionBriefingRecord,
  MissionBriefingRecordResponse,
  MissionReleaseValidityResponse,
  Principal,
} from '@ledger/contracts';
import { missionBriefingControls } from '@ledger/contracts';
import { Badge, Button, Notice, Spinner } from '@ledger/ui';
import { BriefingForm, ReleaseNotApplicable } from './BriefingForm.js';
import { AcknowledgementForm } from './AcknowledgementForm.js';
import { briefingStandingWords, currentBriefingStanding, type BriefingContext } from './briefing.js';
import { errorMessage, json } from './format.js';
import { aircraftLabel } from './labels.js';
import { missionTime } from './missionRelease.js';
import { canonicalDigest } from './safety.js';
import { resolveAreaControl, type AreaControl } from './area-controls.js';
import { AreaControlSummary } from './AreaControlSummary.js';
import { MissionDemoProgress } from './AvoidanceDemoPanel.js';
import type { AvoidanceDemoMission, DemoAreaControl } from './avoidance-demo.js';
import { FlightPredeparturePanel } from './FlightPredeparturePanel.js';
import { FlightControls } from './FlightControls.js';
import { useFlightPredeparture } from './useFlightPredeparture.js';
import { predepartureBriefings } from './predeparture.js';
import { applicabilitySentences } from './flight-controls.js';
import { MissionReadFailure, readFailureCause, readFailureStep, subjectReadOutcome } from './read-failure.js';

export interface BriefingRequest {
  releaseId: string;
  briefingId?: string;
  controlEventId?: string;
  sequence: number;
}

const validityLabels: Record<MissionReleaseValidityResponse['status'], string> = {
  scheduled: 'Departure window has not started',
  current: 'Release context matches now',
  expired: 'Departure window ended',
  changed: 'Release context has changed',
  pending: 'Current release context is unconfirmed',
};

export function BriefingWorkspace({
  client,
  principal,
  flight,
  request,
  active,
  onReturn,
  onInspectRecord,
  demo,
  onInspectMonitoring,
  onOpenBriefing,
}: {
  client: LedgerClient;
  principal: Principal;
  flight: FlightSummary;
  request: BriefingRequest;
  active: boolean;
  onReturn: () => void;
  onInspectRecord: (id: string) => void;
  demo?: AvoidanceDemoMission;
  /** Opens the control's safety record, where its windows and indicator results are shown. */
  onInspectMonitoring?: (control: DemoAreaControl) => void;
  onOpenBriefing?: (releaseId: string, briefingId?: string, controlEventId?: string) => void;
}) {
  const predeparture = useFlightPredeparture(active && !demo, client, flight.id);
  const humanHeld =
    predeparture.read?.response.progress?.needsHumanReview &&
    !['departed', 'cancelled'].includes(predeparture.read.response.progress.phase);
  const [context, setContext] = useState<BriefingContext | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);
  const [briefingId, setBriefingId] = useState(request.briefingId ?? null);
  const [exact, setExact] = useState<MissionBriefingRecordResponse | null>(null);
  const [coverage, setCoverage] = useState<MissionBriefingAcknowledgementsResponse | null>(null);
  const [briefingError, setBriefingError] = useState<string | null>(null);
  // The release and the open briefing are what this screen is about; either read can find access lost.
  const [contextLost, setContextLost] = useState(false);
  const [lostBriefingId, setLostBriefingId] = useState<string | null>(null);
  const accessLost = contextLost || (lostBriefingId !== null && lostBriefingId === briefingId);
  const [controlsSeen, setControlsSeen] = useState<{ flightId: string; digest: string } | null>(null);
  const [controlsFailure, setControlsFailure] = useState<{ flightId: string; message: string } | null>(null);
  const [controlsAttempt, setControlsAttempt] = useState(0);
  const onControlsRead = useCallback((response: FlightControlsResponse) => {
    setControlsSeen({ flightId: response.flightId, digest: response.digest });
    setControlsFailure(null);
  }, []);
  const onControlsReadFailed = useCallback(
    (message: string) => setControlsFailure({ flightId: flight.id, message }),
    [flight.id],
  );
  const controls = useRef(new Map<string, AreaControl>());
  const exactBriefings = useRef(new Map<string, MissionBriefingRecordResponse>());
  const main = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const contextSequence = useRef(0);
  const briefingSequence = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const clearPrivate = useCallback(() => {
    setContext(null);
    setExact(null);
    setCoverage(null);
    controls.current.clear();
    exactBriefings.current.clear();
  }, []);

  const refreshContext = useCallback(
    async (readAgainIfStale = true): Promise<BriefingContext> => {
      const sequence = ++contextSequence.current;
      try {
        const [release, validity] = await Promise.all([
          client.missionRelease(flight.id, request.releaseId),
          client.missionReleaseValidity(flight.id, request.releaseId),
        ]);
        if (!alive.current || sequence !== contextSequence.current)
          throw new Error('The briefing workspace changed. Return to its current record.');
        if (
          release.release.id !== request.releaseId ||
          release.release.flightId !== flight.id ||
          (await canonicalDigest(release.release)) !== release.digest ||
          validity.release.id !== release.release.id ||
          validity.release.digest !== release.digest
        )
          throw new Error('The exact release could not be matched. Refresh before preparing a briefing.');
        const resolved = await Promise.all(
          release.release.basis.avoidance.candidates.map(async (candidate) => {
            let control = controls.current.get(candidate.controlDigest);
            if (!control) {
              control = await resolveAreaControl(client, candidate).catch((failure: unknown) => {
                if (failure instanceof ApiError) throw new MissionReadFailure('control', failure);
                throw new Error('An exact released control could not be matched. Refresh the release details.');
              });
              controls.current.set(candidate.controlDigest, control);
            }
            return { candidate, control };
          }),
        );
        const next = { release, validity, controls: resolved };
        if (alive.current && sequence === contextSequence.current) {
          setContext(next);
          setContextError(null);
          setContextLost(false);
        }
        return next;
      } catch (failed) {
        const failure = readFailureCause(failed);
        if (alive.current && sequence === contextSequence.current) {
          // A control changed after the release listed it: one immediate read again, then polling.
          const step = readFailureStep(subjectReadOutcome(failed), readAgainIfStale);
          if (step === 'read_again') return refreshContext(false);
          if (step === 'clear') {
            setContextLost(true);
            clearPrivate();
          }
          setContextError(errorMessage(failure));
        }
        throw failure;
      }
    },
    [client, flight.id, request.releaseId, clearPrivate],
  );

  const refreshBriefing = useCallback(async (): Promise<void> => {
    if (!briefingId) return;
    const sequence = ++briefingSequence.current;
    try {
      let retained = exactBriefings.current.get(briefingId);
      if (!retained) {
        retained = await client.missionBriefing(flight.id, briefingId);
        if (
          retained.briefing.id !== briefingId ||
          retained.briefing.flightId !== flight.id ||
          retained.briefing.context.release.id !== request.releaseId ||
          (await canonicalDigest(retained.briefing)) !== retained.digest
        )
          throw new Error('The exact briefing could not be matched. Retry its retained record.');
        const { digest, ...population } = retained.briefing.population;
        if ((await canonicalDigest(population)) !== digest)
          throw new Error('The briefing’s frozen recipients could not be matched. Retry its retained record.');
        exactBriefings.current.set(briefingId, retained);
      }
      if (alive.current && sequence === briefingSequence.current) setExact(retained);
      if (!alive.current || sequence !== briefingSequence.current)
        throw new Error('The selected briefing changed. Return to its current record.');
      const current = await client.missionBriefingAcknowledgements(flight.id, briefingId);
      await validateCoverage(retained, current);
      if (alive.current && sequence === briefingSequence.current) {
        setExact(retained);
        setCoverage(current);
        setBriefingError(null);
        setLostBriefingId(null);
      }
    } catch (failure) {
      if (alive.current && sequence === briefingSequence.current) {
        if (subjectReadOutcome(failure) === 'access_lost') {
          setLostBriefingId(briefingId);
          clearPrivate();
        }
        setCoverage(null);
        setBriefingError(errorMessage(failure));
      }
      throw failure;
    }
  }, [client, flight.id, request.releaseId, briefingId, clearPrivate]);

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      await Promise.allSettled([refreshContext(), refreshBriefing()]);
      if (!stopped) timer = setTimeout(() => void poll(), 3000);
    }
    // Polling goes on after access is lost, so a later read of the release or briefing can restore the view.
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
      contextSequence.current++;
      briefingSequence.current++;
    };
  }, [refreshContext, refreshBriefing, active]);

  useEffect(() => {
    if (request.briefingId) {
      setBriefingId(request.briefingId);
      setExact(exactBriefings.current.get(request.briefingId) ?? null);
      setCoverage(null);
    } else if (request.controlEventId) {
      setBriefingId(null);
      setExact(null);
      setCoverage(null);
    }
  }, [request.briefingId, request.controlEventId, request.sequence]);
  useEffect(() => {
    if (active) main.current?.focus({ preventScroll: true });
  }, [active, request.sequence]);

  const release = context?.release.release;
  const briefing = exact?.briefing;
  const standing = exact ? currentBriefingStanding(exact, coverage) : undefined;
  // A request to prepare a briefing covers every control of the release that still has none.
  const read = predeparture.read;
  const unbriefed =
    read?.release && read.release.id === request.releaseId
      ? predepartureBriefings(read.response, read.release, read.controls)
          .filter((entry) => !entry.briefing || entry.lapsed)
          .map((entry) => entry.controlEventId)
      : [];
  const requestedControls = request.controlEventId
    ? unbriefed.includes(request.controlEventId)
      ? unbriefed
      : [request.controlEventId]
    : undefined;
  const validity = coverage?.releaseValidity ?? context?.validity;
  const releaseSentences = useMemo(
    () => applicabilitySentences(context?.release.release.basis.avoidance.candidates ?? []),
    [context],
  );
  const releaseBasis = release && context && !accessLost && (
    <section className="safety-section briefing-release" aria-label="Briefing release basis">
      <div className="safety-section-heading">
        <h3>Release basis · mission revision {release.basis.mission.sourceRevision}</h3>
      </div>
      <p>
        Accepted by {release.actor.name} · {missionTime(release.recordedAt)}
      </p>
      <blockquote>{release.note}</blockquote>
      <p className="muted">
        Departure window · {missionTime(release.departureWindow.start)} – {missionTime(release.departureWindow.end)}
      </p>
      {context.controls.map(({ candidate, control }) => (
        <article className="mission-candidate" key={candidate.controlEventId}>
          <AreaControlSummary
            control={control}
            version={candidate.controlVersion}
            applicability={candidate.applicability}
          />
        </article>
      ))}
      {!context.controls.length && <p>This release contains no accepted avoidance control to brief.</p>}
      <ReleaseNotApplicable release={release} />
      <details className="mission-provenance">
        <summary>Exact release and control references</summary>
        <pre>{json(context)}</pre>
      </details>
    </section>
  );
  return (
    <section className="briefing-workspace" aria-label="Mission briefing" hidden={!active}>
      <nav className="safety-nav" aria-label="Briefing navigation">
        <Button kind="quiet" onClick={onReturn}>
          ← Return to mission review
        </Button>
        <span className="safety-nav-divider" />
        <span className="safety-nav-current">Informational briefing</span>
      </nav>
      <div className="thread-layout">
        <div className="thread-main briefing-main" ref={main} tabIndex={-1}>
          <header className="thread-header">
            <p className="thread-crumbs">{flight.label} / Released operation</p>
            <div className="thread-title">
              <h2>Mission briefing</h2>
              <Badge tone="neutral">Informational</Badge>
            </div>
            <p className="thread-facts">
              <strong>{aircraftLabel(briefing?.context.aircraftId ?? release?.aircraftId ?? flight.aircraft)}</strong>
              <span>Exact content · named recipients · personal acknowledgement</span>
            </p>
          </header>
          {demo && !accessLost && (
            <MissionDemoProgress
              active={active}
              client={client}
              demo={demo}
              flightId={flight.id}
              onMonitoring={onInspectMonitoring}
            />
          )}
          <p className="safety-intro">
            Record what people were asked to review and who acknowledged it. Briefing does not grant release or
            departure permission.
          </p>
          {accessLost && (
            <Notice tone="attention" title="Briefing access changed">
              Private details have been cleared. Return to the flight and refresh your session.
            </Notice>
          )}
          {contextError && !accessLost && (
            <Notice tone="attention" title="Release updates interrupted">
              {contextError} New briefings need a confirmed release context.
            </Notice>
          )}
          {briefingError && !accessLost && (
            <Notice tone="attention" title="Briefing updates interrupted">
              {briefingError}{' '}
              <Button kind="quiet" onClick={() => void refreshBriefing().catch(() => {})}>
                Retry briefing details
              </Button>
            </Notice>
          )}
          {!context && !contextError && !accessLost && (
            <Spinner label="Reading the exact release and accepted controls" />
          )}
          {briefingId && !briefing && !briefingError && !accessLost && (
            <Spinner label="Reading the recorded briefing" />
          )}
          {briefing && !accessLost && (
            <section className="safety-section briefing-recorded" aria-label="Recorded briefing">
              <div className="safety-section-heading">
                <h3>Recorded briefing</h3>
                {standing?.status === 'lapsed' ? (
                  <Badge tone="attention">Lapsed</Badge>
                ) : (
                  <Badge tone="planned">Content retained</Badge>
                )}
              </div>
              <p>
                Recorded by {briefing.actor.name} · {missionTime(briefing.recordedAt)}
              </p>
              {standing && (
                <p className={standing.status === 'lapsed' ? undefined : 'muted'} data-testid="briefing-standing">
                  {briefingStandingWords(standing)}
                </p>
              )}
              <blockquote className="briefing-message">{briefing.content.message}</blockquote>
              <BriefedControls
                briefing={briefing}
                candidates={
                  context?.release.release.id === briefing.context.release.id
                    ? context.release.release.basis.avoidance.candidates
                    : undefined
                }
              />
              {context?.release.release.id === briefing.context.release.id && (
                <ReleaseNotApplicable release={context.release.release} />
              )}
              {briefing.controls && (
                <p className="muted" data-testid="briefing-pinned-controls">
                  Pinned with this briefing: the {briefing.controls.controls.length} controls in scope its author saw,
                  with their results at that moment.
                </p>
              )}
              <FrozenRecipients briefing={briefing} coverage={coverage} />
              <Button kind="quiet" onClick={() => onInspectRecord(briefing.id)}>
                View briefing in flight record →
              </Button>
              <details className="mission-provenance">
                <summary>Exact briefing and acknowledgement references</summary>
                <pre>{json({ ...exact, coverage })}</pre>
              </details>
            </section>
          )}
          {!demo && !accessLost && (
            <FlightPredeparturePanel
              active={active}
              client={client}
              flightId={flight.id}
              status={predeparture}
              onBriefing={onOpenBriefing}
              compact
            />
          )}
          {/* Shown on the guided demonstration too: a briefing pins the list its author saw, and requires it. */}
          {!accessLost && (
            <FlightControls
              client={client}
              flightId={flight.id}
              applicability={releaseSentences}
              revision={`${validity?.evaluatedAt ?? ''}:${controlsAttempt}`}
              onRead={onControlsRead}
              onReadFailed={onControlsReadFailed}
            />
          )}
          {releaseBasis &&
            (briefing ? (
              <details className="briefing-release-details">
                <summary>Full release basis · mission revision {release!.basis.mission.sourceRevision}</summary>
                {releaseBasis}
              </details>
            ) : (
              releaseBasis
            ))}
        </div>
        <aside className="rail mission-rail briefing-rail" aria-label="Briefing actions">
          {!accessLost && (
            <>
              {demo && (
                <p className="avoidance-demo-consequence">
                  After every named recipient’s personal review is recorded, this held demo flight can depart under its
                  recorded release.
                </p>
              )}
              {!demo && humanHeld && (
                <p className="avoidance-demo-consequence">
                  After every required control briefing and each named recipient’s personal review are recorded, the
                  source can check this held flight for departure under its recorded release.
                </p>
              )}
              {validity && (
                <section className="briefing-validity" aria-label="Current release status">
                  <h3>Current release status</h3>
                  <Badge tone={['scheduled', 'current'].includes(validity.status) ? 'planned' : 'attention'}>
                    {validityLabels[validity.status]}
                  </Badge>
                  <p>Checked {missionTime(validity.evaluatedAt)}</p>
                  <p className="muted">
                    Historical briefing and personal review stay recorded when this status changes.
                  </p>
                </section>
              )}
              {[...exactBriefings.current.values()].map((retained) => (
                <div key={retained.briefing.id} hidden={retained.briefing.id !== briefing?.id}>
                  <AcknowledgementForm
                    client={client}
                    principal={principal}
                    exact={retained}
                    coverage={retained.briefing.id === briefing?.id ? coverage : null}
                    onRefresh={refreshBriefing}
                    onAccepted={() => void refreshBriefing().catch(() => {})}
                  />
                </div>
              ))}
              {principal.capabilities.includes('briefing:write') ? (
                <BriefingForm
                  client={client}
                  principal={principal}
                  context={contextError ? null : context}
                  requestedControlEventIds={requestedControls}
                  controlsDigest={controlsSeen?.flightId === flight.id ? controlsSeen.digest : undefined}
                  controlsFailure={controlsFailure?.flightId === flight.id ? controlsFailure.message : undefined}
                  onRetryControls={() => setControlsAttempt((value) => value + 1)}
                  onRefresh={refreshContext}
                  onAccepted={(id) => {
                    setBriefingId(id);
                    setExact(null);
                    setCoverage(null);
                    setBriefingError(null);
                    main.current?.focus({ preventScroll: true });
                  }}
                />
              ) : !exact ? (
                <p className="muted">
                  Your role can review briefings. Recording one requires current briefing author authority.
                </p>
              ) : null}
            </>
          )}
        </aside>
      </div>
    </section>
  );
}

const routeRelations: Record<MissionAvoidanceCandidate['geometry'], string> = {
  outside: 'Route outside this area',
  intersects: 'Route intersects this area',
  insufficient: 'Route comparison unconfirmed',
};

/**
 * Every control a briefing lists, in its order: what each asks and, as its release recorded, how the reviewed route
 * related to it. One acknowledgement covers all of them.
 */
function BriefedControls({
  briefing,
  candidates,
}: {
  briefing: MissionBriefingRecord;
  candidates?: MissionAvoidanceCandidate[];
}) {
  const controls = missionBriefingControls(briefing);
  return (
    <div className="briefing-controls-covered" data-testid="briefing-controls-covered">
      <h4>
        {controls.length === 1
          ? 'The control this briefing covers'
          : `The ${controls.length} controls this briefing covers`}
      </h4>
      {controls.map(({ reference, content }) => {
        const candidate = candidates?.find((entry) => entry.controlEventId === reference.controlEventId);
        return (
          <article className="mission-candidate" key={reference.controlEventId}>
            <ControlContent content={content} version={reference.controlVersion} />
            <p className="muted">
              {candidate
                ? `${routeRelations[candidate.geometry]} · as recorded in the release`
                : 'Route relation as recorded in the release · reading the release'}
            </p>
          </article>
        );
      })}
    </div>
  );
}

function ControlContent({ content, version }: { content: MissionBriefingControlRecordContent; version: number }) {
  return (
    <div className="briefing-control">
      <strong>
        {content.title} · {content.controlType.title} · control version {version}
      </strong>
      <span>
        {content.area.radiusMeters} m radius · all altitudes{content.area.site ? ` · ${content.area.site}` : ''}
      </span>
      <span>
        Center {content.area.center.latitude.toFixed(5)}, {content.area.center.longitude.toFixed(5)}
      </span>
      <span>
        Effective {missionTime(content.effectiveFrom)} –{' '}
        {content.effectiveUntil ? missionTime(content.effectiveUntil) : 'until withdrawn'}
      </span>
      <p>{content.description}</p>
    </div>
  );
}

function FrozenRecipients({
  briefing,
  coverage,
}: {
  briefing: MissionBriefingRecord;
  coverage: MissionBriefingAcknowledgementsResponse | null;
}) {
  const count = coverage?.recipients.filter((row) => row.acknowledgement).length;
  const names = new Map<string, number>();
  for (const person of briefing.population.recipients) names.set(person.name, (names.get(person.name) ?? 0) + 1);
  return (
    <div className="briefing-population">
      <h4>
        Named recipients · {count ?? '—'} / {briefing.population.recipients.length} acknowledged
      </h4>
      <p className="muted">This population was fixed when the briefing was recorded. Delivery is not recorded.</p>
      <ul>
        {briefing.population.recipients.map((person) => {
          const row = coverage?.recipients.find((entry) => entry.recipientPrincipalId === person.principalId);
          const acknowledgement = row?.acknowledgement?.record;
          return (
            <li key={person.principalId}>
              <div>
                <strong>{person.name}</strong>
                {(names.get(person.name) ?? 0) > 1 && (
                  <span className="recipient-picker-identity-suffix"> · {person.principalId.slice(-8)}</span>
                )}
                <details className="recipient-picker-identity">
                  <summary>Identity details</summary>
                  <span>
                    {person.principalId} · identity revision {person.principalRevision}
                  </span>
                </details>
              </div>
              <div>
                <span>
                  {acknowledgement
                    ? `Acknowledged ${missionTime(acknowledgement.recordedAt)}`
                    : coverage
                      ? 'No acknowledgement recorded'
                      : 'Checking acknowledgements…'}
                </span>
                {acknowledgement && (
                  <small>
                    {row?.processing === 'completed'
                      ? 'Flight record updated'
                      : row?.processing === 'failed'
                        ? 'Flight record update needs attention'
                        : 'Adding to flight record'}
                  </small>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

async function validateCoverage(
  exact: MissionBriefingRecordResponse,
  coverage: MissionBriefingAcknowledgementsResponse,
) {
  const record = exact.briefing;
  const expected = new Set(record.population.recipients.map((person) => person.principalId));
  if (
    coverage.briefing.id !== record.id ||
    coverage.briefing.digest !== exact.digest ||
    (await canonicalDigest(coverage.population)) !== (await canonicalDigest(record.population)) ||
    coverage.releaseValidity.release.id !== record.context.release.id ||
    coverage.releaseValidity.release.digest !== record.context.release.digest ||
    coverage.recipients.length !== expected.size ||
    new Set(coverage.recipients.map((row) => row.recipientPrincipalId)).size !== expected.size
  )
    throw new Error('Acknowledgements do not match this exact briefing and frozen population. Retry the details.');
  for (const row of coverage.recipients) {
    const ack = row.acknowledgement;
    if (
      !expected.has(row.recipientPrincipalId) ||
      (ack &&
        (ack.record.flightId !== record.flightId ||
          ack.record.briefing.id !== record.id ||
          ack.record.briefing.digest !== exact.digest ||
          ack.record.populationDigest !== record.population.digest ||
          ack.record.recipientPrincipalId !== row.recipientPrincipalId ||
          ack.record.actor.id !== row.recipientPrincipalId ||
          (await canonicalDigest(ack.record)) !== ack.digest))
    )
      throw new Error('An acknowledgement does not match its named recipient and exact briefing. Retry the details.');
  }
}
