import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, LedgerClient } from '@ledger/contracts/client';
import type {
  FlightResponse,
  FlightSummary,
  MissionAvoidanceReviewedCandidate,
  MissionReleaseRecord,
  MissionReleaseValidityResponse,
  Principal,
  MissionReleaseFindingsResponse,
} from '@ledger/contracts';
import { Badge, Button, Notice, Spinner } from '@ledger/ui';
import { aircraftLabel } from './labels.js';
import { errorMessage, json } from './format.js';
import { canonicalDigest } from './safety.js';
import { resolveAreaControl, type AreaControl } from './area-controls.js';
import { AreaControlSummary } from './AreaControlSummary.js';
import { FlightControls } from './FlightControls.js';
import { ReleaseForm } from './ReleaseForm.js';
import { MissionDetour } from './MissionDetour.js';
import { BriefingWorkspace, type BriefingRequest } from './BriefingWorkspace.js';
import { missionTime, releaseReadiness, shouldReadReleaseFindings, type MissionReview } from './missionRelease.js';
import { MissionDemoProgress } from './AvoidanceDemoPanel.js';
import type { AvoidanceDemoMission } from './avoidance-demo.js';
import { FlightPredeparturePanel } from './FlightPredeparturePanel.js';
import { NotApplicableControls } from './NotApplicableControls.js';
import {
  applicabilityCountWords,
  applicabilitySentences,
  avoidanceNotApplicableEntries,
  notApplicableHeading,
} from './flight-controls.js';
import {
  MissionReadFailure,
  missionRead,
  missionReadOutcome,
  readFailureOutcome,
  settledReads,
} from './read-failure.js';

export interface MissionRequest {
  sequence: number;
  flight: FlightSummary;
  releaseId?: string;
  briefingId?: string;
  demo?: AvoidanceDemoMission;
}
export type { AvoidanceDemoMission } from './avoidance-demo.js';
type Control = { candidate: MissionAvoidanceReviewedCandidate; control: AreaControl };
type Snapshot = { review: MissionReview; controls: Control[] };

export function MissionWorkspace({
  active,
  client,
  principal,
  request,
  onReturnToFlight,
  onOpenSafetyRecord,
  onInspectRelease,
}: {
  active: boolean;
  client: LedgerClient;
  principal: Principal;
  request: MissionRequest;
  onReturnToFlight: () => void;
  /** Opens a hazard or control on its safety record page, when the person may read safety records. */
  onOpenSafetyRecord?: (id: string, kind: 'hazard' | 'control') => void;
  onInspectRelease: (id: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accessLost, setAccessLost] = useState(false);
  const [releaseId, setReleaseId] = useState(request.releaseId ?? null);
  const [briefings, setBriefings] = useState<BriefingRequest[]>([]);
  const [activeBriefing, setActiveBriefing] = useState<string | null>(null);
  const reviewActive = active && activeBriefing === null;
  const main = useRef<HTMLDivElement>(null);
  const routeAction = useRef<HTMLDivElement>(null);
  const releaseAction = useRef<HTMLDivElement>(null);
  const controls = useRef(new Map<string, AreaControl>());
  const alive = useRef(true);
  const readSequence = useRef(0);
  const releaseFormOpen = useRef(false);
  const releaseFindings = useRef<{ revision: number; findings: MissionReleaseFindingsResponse } | null>(null);

  const openBriefing = useCallback((exactReleaseId: string, briefingId?: string, controlEventId?: string) => {
    setBriefings((previous) => {
      const existing = previous.find((entry) => entry.releaseId === exactReleaseId);
      const next = {
        releaseId: exactReleaseId,
        briefingId: briefingId ?? (controlEventId ? undefined : existing?.briefingId),
        controlEventId: controlEventId ?? existing?.controlEventId,
        sequence: (existing?.sequence ?? 0) + 1,
      };
      return [...previous.filter((entry) => entry.releaseId !== exactReleaseId), next];
    });
    setActiveBriefing(exactReleaseId);
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(
    async (rereadIfStale = true): Promise<MissionReview> => {
      const sequence = ++readSequence.current;
      try {
        const [flight, mission, preview] = await settledReads([
          missionRead('flight', client.request<FlightResponse>(`/v1/flights/${encodeURIComponent(request.flight.id)}`)),
          missionRead('mission', client.flightMission(request.flight.id)),
          missionRead('preview', client.missionAvoidance(request.flight.id)),
        ]);
        const revision = flight.flight.revision;
        const retained = releaseFindings.current;
        const findings = shouldReadReleaseFindings({
          formOpen: releaseFormOpen.current,
          readAtRevision: retained?.revision ?? null,
          revision,
        })
          ? await missionRead('findings', client.missionReleaseFindings(request.flight.id)).catch(
              (failure: unknown) => {
                // Without the list a release cannot pin it; the rest of the review still shows.
                if (missionReadOutcome(failure) !== 'interrupted') throw failure;
                return null;
              },
            )
          : retained!.findings;
        releaseFindings.current = findings ? { revision, findings } : null;
        if (!alive.current || sequence !== readSequence.current)
          throw new Error('The mission workspace changed. Return to its current record.');
        if (preview.mission) {
          const exact =
            mission.acceptedHead?.record.id === preview.mission.eventId
              ? mission.acceptedHead.record
              : mission.projectedHead?.id === preview.mission.eventId
                ? mission.projectedHead
                : (
                    await missionRead(
                      'mission',
                      client.flightMissionRevision(request.flight.id, preview.mission.sourceRevision),
                    )
                  ).mission;
          if ((await canonicalDigest(exact)) !== preview.mission.recordDigest)
            throw new Error('The exact mission could not be matched. Refresh the mission context.');
          if (
            mission.acceptedHead?.record.id !== preview.mission.eventId ||
            (mission.acceptedHead.processing.status === 'completed' &&
              mission.projectedHead?.id !== preview.mission.eventId)
          )
            throw new Error(
              'The mission changed while its control context was being read. Refresh before reviewing the route.',
            );
        }
        const exactControls = await Promise.all(
          preview.candidates.map(async (candidate) => {
            let control = controls.current.get(candidate.controlDigest);
            if (!control) {
              control = await resolveAreaControl(client, candidate).catch((failure: unknown) => {
                if (failure instanceof ApiError) throw new MissionReadFailure('control', failure);
                throw new Error('An exact accepted control could not be matched. Refresh the mission context.');
              });
              controls.current.set(candidate.controlDigest, control);
            }
            return { candidate, control };
          }),
        );
        const review = { flight: flight.flight, mission, preview, findings };
        if (alive.current && sequence === readSequence.current) {
          setSnapshot({ review, controls: exactControls });
          setAccessLost(false);
          setError(null);
        }
        return review;
      } catch (failed) {
        const outcome = missionReadOutcome(failed);
        const failure = failed instanceof MissionReadFailure ? failed.failure : failed;
        if (alive.current && sequence === readSequence.current) {
          // A control or the findings changed after the preview listed them: one immediate read again, then polling.
          if (outcome === 'stale' && rereadIfStale) return refresh(false);
          if (outcome === 'access_lost') {
            setSnapshot(null);
            controls.current.clear();
            setReleaseId(null);
            setAccessLost(true);
          }
          setError(errorMessage(failure));
        }
        throw failure;
      }
    },
    [client, request.flight.id],
  );

  // An opened release form reads the open findings at once and on every poll while it stays open.
  const releaseFormOpened = useCallback(
    (open: boolean) => {
      if (open === releaseFormOpen.current) return;
      releaseFormOpen.current = open;
      if (open) void refresh().catch(() => undefined);
    },
    [refresh],
  );

  useEffect(() => {
    if (!reviewActive) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        await refresh();
      } catch {
        /* The retained view shows the read failure. */
      }
      if (!stopped) timer = setTimeout(() => void poll(), 3000);
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
      readSequence.current++;
    };
  }, [refresh, reviewActive]);

  useEffect(() => {
    if (request.releaseId) setReleaseId(request.releaseId);
    if (request.releaseId && request.briefingId) openBriefing(request.releaseId, request.briefingId);
    else setActiveBriefing(null);
    main.current?.focus({ preventScroll: true });
  }, [request.sequence, request.releaseId, request.briefingId, openBriefing]);

  const review = snapshot?.review;
  const mission = review?.mission.acceptedHead?.record;
  const preview = review?.preview;
  const readiness = releaseReadiness(review ?? null);
  const notApplicable = useMemo(() => preview?.notApplicable ?? [], [preview]);
  const appliesBecause = useMemo(() => applicabilitySentences(preview?.candidates ?? []), [preview]);
  const label =
    preview?.status === 'outside'
      ? 'Outside accepted avoidance areas'
      : preview?.status === 'intersects'
        ? 'Route intersects an accepted control'
        : 'Comparison incomplete';
  return (
    <section className="mission-workspace" aria-label="Mission review">
      <div className="mission-review-view" hidden={activeBriefing !== null}>
        <nav className="safety-nav" aria-label="Mission navigation">
          <Button kind="quiet" onClick={onReturnToFlight}>
            <span aria-hidden="true">←</span> Return to {request.demo ? 'accepted control' : request.flight.label}
          </Button>
          <span className="safety-nav-divider" />
          <span className="safety-nav-current">Mission review</span>
        </nav>
        <div className="thread-layout">
          <div className="thread-main mission-main" ref={main} tabIndex={-1}>
            <header className="thread-header">
              <p className="thread-crumbs">{request.flight.label} / Planned operation</p>
              <div className="thread-title">
                <h2>Mission route and release</h2>
                {preview && (
                  <Badge tone={!error && preview.status === 'outside' && !readiness.length ? 'planned' : 'attention'}>
                    {error ? 'Comparison unconfirmed' : label}
                  </Badge>
                )}
              </div>
              <p className="thread-facts">
                <strong>{aircraftLabel(review?.flight.aircraft ?? request.flight.aircraft)}</strong>
                <span>Planned geometry · recorded positions remain in the flight map</span>
              </p>
            </header>
            {request.demo && !accessLost && (
              <MissionDemoProgress
                active={reviewActive}
                client={client}
                demo={request.demo}
                flightId={request.flight.id}
                onBriefing={openBriefing}
                onMonitoring={
                  onOpenSafetyRecord && ((control) => onOpenSafetyRecord(control.reference.controlId, 'control'))
                }
              />
            )}
            {!request.demo && !accessLost && (
              <FlightPredeparturePanel
                active={reviewActive}
                client={client}
                flightId={request.flight.id}
                onReviewRoute={() => {
                  routeAction.current?.scrollIntoView({ block: 'start' });
                  routeAction.current?.querySelector('button')?.focus({ preventScroll: true });
                }}
                onReviewRelease={() => {
                  releaseAction.current?.scrollIntoView({ block: 'start' });
                  releaseAction.current?.querySelector('button')?.focus({ preventScroll: true });
                }}
                onReleaseRecord={(id) => {
                  setReleaseId(id);
                  requestAnimationFrame(() => releaseAction.current?.scrollIntoView({ block: 'start' }));
                }}
                onBriefing={openBriefing}
              />
            )}
            {error && (
              <Notice tone="attention" title={accessLost ? 'Mission access changed' : 'Mission updates interrupted'}>
                {error}
                {!accessLost && ' The last received plan stays visible; refresh before recording a release.'}
              </Notice>
            )}
            {!snapshot && !error && <Spinner label="Reading the mission and accepted controls" />}
            {review && (
              <>
                <section className="safety-section mission-plan" aria-label="Current mission">
                  <div className="safety-section-heading">
                    <h3>{mission ? `Mission revision ${mission.sourceRevision}` : 'No mission recorded'}</h3>
                    {review.mission.acceptedHead && (
                      <Badge
                        tone={review.mission.acceptedHead.processing.status === 'completed' ? 'neutral' : 'attention'}
                      >
                        {review.mission.acceptedHead.processing.status === 'completed'
                          ? 'Ready for review'
                          : review.mission.acceptedHead.processing.status === 'failed'
                            ? 'Source review needed'
                            : 'Processing mission'}
                      </Badge>
                    )}
                  </div>
                  {mission ? (
                    <>
                      <p>
                        Operating interval · {missionTime(mission.operatingInterval.start)} –{' '}
                        {missionTime(mission.operatingInterval.end)}
                      </p>
                      <p className="muted">
                        Planned altitude {mission.altitude.minimum}–{mission.altitude.maximum} m AGL · corridor{' '}
                        {mission.lateralToleranceMeters} m either side · recorded {missionTime(mission.recordedAt)}
                      </p>
                      {review.mission.projectedHead?.id !== mission.id && (
                        <Notice tone="attention" title="Latest mission is not ready">
                          {review.mission.acceptedHead?.processing.status === 'failed'
                            ? 'The latest mission failed processing. Review its source and submit a corrected revision before release.'
                            : 'Wait for this revision to finish processing. The older route cannot be released.'}
                        </Notice>
                      )}
                      <div ref={routeAction}>
                        <MissionDetour
                          active={reviewActive}
                          client={client}
                          principal={principal}
                          review={review}
                          controls={snapshot.controls}
                          notApplicable={notApplicable}
                          onRefresh={refresh}
                        />
                      </div>
                    </>
                  ) : (
                    <p>A mission source must submit a planned route for this exact flight before it can be reviewed.</p>
                  )}
                </section>
                <section className="safety-section" aria-label="Route avoidance preview">
                  <div className="safety-section-heading">
                    <h3>{label}</h3>
                    <Badge tone={preview?.status === 'outside' && !readiness.length ? 'planned' : 'attention'}>
                      {preview?.candidateCompleteness.status === 'complete'
                        ? 'Complete selection'
                        : 'Incomplete selection'}
                    </Badge>
                  </div>
                  <p className="muted" data-testid="route-review-count">
                    Checked {missionTime(preview?.evaluatedAt)} ·{' '}
                    {applicabilityCountWords(preview?.candidates.length ?? 0, notApplicable.length)}.
                  </p>
                  {readiness.length > 0 && (
                    <ul className="mission-prerequisites">
                      {readiness.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  )}
                  {snapshot.controls.map(({ candidate, control: area }) => (
                    <article className="mission-candidate" key={candidate.controlEventId}>
                      <div className="safety-section-heading">
                        <h4>{area.title}</h4>
                        <Badge
                          tone={
                            candidate.geometry === 'outside' && candidate.context === 'current'
                              ? 'planned'
                              : 'attention'
                          }
                        >
                          {candidate.geometry === 'outside'
                            ? 'Route outside'
                            : candidate.geometry === 'intersects'
                              ? 'Route intersects'
                              : 'Geometry unconfirmed'}{' '}
                          · {candidate.context === 'current' ? 'Context current' : 'Review needed'}
                        </Badge>
                      </div>
                      <AreaControlSummary
                        control={area}
                        version={candidate.controlVersion}
                        applicability={candidate.applicability}
                      />
                      <p className="muted">
                        Control version {candidate.controlVersion} · effective {missionTime(candidate.interval.start)} –{' '}
                        {missionTime(candidate.interval.end)}
                      </p>
                      {candidate.reasons.length > 0 && (
                        <ul className="mission-prerequisites">
                          {candidate.reasons.map((reason) => (
                            <li key={reason}>{comparisonReason(reason)}</li>
                          ))}
                        </ul>
                      )}
                      {candidate.geometry === 'intersects' && (
                        <p>Revise the planned route or review this control before preparing a release.</p>
                      )}
                      <details className="mission-provenance">
                        <summary>Exact comparison references</summary>
                        <pre>{json({ candidate, control: area })}</pre>
                      </details>
                    </article>
                  ))}
                  {preview?.candidates.length === 0 && (
                    <p>
                      {preview.candidateCompleteness.status !== 'complete'
                        ? 'The applicable control selection is incomplete. Refresh after processing finishes.'
                        : notApplicable.length
                          ? 'No accepted avoidance control applies to this route.'
                          : 'No accepted avoidance controls overlap this operating interval.'}
                    </p>
                  )}
                  {preview?.mission && notApplicable.length > 0 && (
                    <NotApplicableControls
                      key={preview.mission.eventId}
                      heading={notApplicableHeading(notApplicable.length)}
                      entries={avoidanceNotApplicableEntries(notApplicable, preview.mission.sourceRevision)}
                      testId="route-review-not-applicable"
                    />
                  )}
                  <details className="mission-provenance">
                    <summary>Mission and preview provenance</summary>
                    <pre>{json({ mission: review.mission, preview })}</pre>
                  </details>
                </section>
                {!request.demo && (
                  <FlightControls
                    client={client}
                    flightId={request.flight.id}
                    revision={preview?.evaluatedAt}
                    applicability={appliesBecause}
                  />
                )}
              </>
            )}
          </div>
          <aside className="rail mission-rail" aria-label="Mission release actions">
            <div ref={releaseAction}>
              {!accessLost && (
                <ReleaseForm
                  client={client}
                  principal={principal}
                  review={error ? null : (review ?? null)}
                  onRefresh={refresh}
                  onAccepted={setReleaseId}
                  onFormOpen={releaseFormOpened}
                />
              )}
              {releaseId && !accessLost && (
                <RecordedRelease
                  active={reviewActive}
                  client={client}
                  flightId={request.flight.id}
                  releaseId={releaseId}
                  onInspect={() => onInspectRelease(releaseId)}
                  onBrief={() => openBriefing(releaseId)}
                />
              )}
            </div>
          </aside>
        </div>
      </div>
      {briefings.map((briefing) => (
        <BriefingWorkspace
          key={briefing.releaseId}
          client={client}
          principal={principal}
          flight={request.flight}
          request={briefing}
          demo={request.demo}
          onOpenBriefing={openBriefing}
          active={active && activeBriefing === briefing.releaseId}
          onReturn={() => {
            setActiveBriefing(null);
            requestAnimationFrame(() => main.current?.focus({ preventScroll: true }));
          }}
          onInspectRecord={onInspectRelease}
          onInspectMonitoring={
            onOpenSafetyRecord && ((control) => onOpenSafetyRecord(control.reference.controlId, 'control'))
          }
        />
      ))}
    </section>
  );
}

function comparisonReason(reason: string) {
  const labels: Record<string, string> = {
    assessment_changed: 'The hazard assessment changed. Review and accept the current assessed control.',
    evaluation_changed: 'The originating finding has a newer evaluation. Review its evidence.',
    source_evidence_changed: 'New command-link evidence arrived. Review the hazard against that evidence.',
    selection_changed: 'The applicable rule selection changed. Review the hazard again.',
    projection_pending: 'Accepted safety evidence has not finished processing. Wait, then refresh.',
    selection_pending: 'The current rule selection is still processing. Wait, then refresh.',
    unsupported_control_or_authority: 'This control or its retained acceptance authority is unsupported.',
    unsupported_evaluation: 'The originating evaluation cannot be compared by this calculation.',
  };
  return (
    labels[reason] ??
    (reason.startsWith('unsupported_')
      ? 'This geometry is outside the supported local comparison. Review the source route or control.'
      : 'The comparison could not be completed. Review the exact comparison references.')
  );
}

const validityLabels: Record<MissionReleaseValidityResponse['status'], string> = {
  scheduled: 'Departure window has not started',
  current: 'Release context matches now',
  expired: 'Departure window ended',
  changed: 'Release context has changed',
  pending: 'Current release context is unconfirmed',
};

function RecordedRelease({
  active,
  client,
  flightId,
  releaseId,
  onInspect,
  onBrief,
}: {
  client: LedgerClient;
  flightId: string;
  releaseId: string;
  onInspect: () => void;
  onBrief: () => void;
  active: boolean;
}) {
  const [record, setRecord] = useState<MissionReleaseRecord | null>(null);
  const [validity, setValidity] = useState<MissionReleaseValidityResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setRecord(null);
    setValidity(null);
    setError(null);
  }, [client, flightId, releaseId]);
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const [exact, current] = await Promise.all([
          client.missionRelease(flightId, releaseId),
          client.missionReleaseValidity(flightId, releaseId),
        ]);
        if (!stopped) {
          setRecord(exact.release);
          setValidity(current);
          setError(null);
        }
      } catch (failure) {
        if (!stopped) {
          setValidity(null);
          if (readFailureOutcome(failure, true) === 'access_lost') setRecord(null);
          setError(errorMessage(failure));
        }
      }
      if (!stopped) timer = setTimeout(() => void poll(), 3000);
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [client, flightId, releaseId, active]);
  return (
    <section className="mission-recorded" aria-label="Recorded release" aria-live="polite">
      <h3>Recorded release</h3>
      {error && (
        <Notice tone="attention" title="Release details unavailable">
          {error} Retrying shortly.
        </Notice>
      )}
      {!record && !error && <Spinner label="Reading the accepted release" />}
      {record && (
        <>
          <strong>Mission revision {record.basis.mission.sourceRevision}</strong>
          <p>
            Accepted by {record.actor.name} · {missionTime(record.recordedAt)}
          </p>
          <blockquote>{record.note}</blockquote>
          <p>
            Departure window · {missionTime(record.departureWindow.start)} – {missionTime(record.departureWindow.end)}
          </p>
          <div className="mission-current-validity">
            <strong>Current release status</strong>
            <span>{validity ? validityLabels[validity.status] : 'Current status unavailable'}</span>
            {validity && (
              <small>
                Checked {missionTime(validity.evaluatedAt)} ·{' '}
                {validity.processing === 'completed'
                  ? 'Flight record updated'
                  : validity.processing === 'failed'
                    ? 'Flight record update needs attention'
                    : 'Adding to flight record'}
              </small>
            )}
            <p>Historical acceptance stays recorded. Departure authorization is separate.</p>
          </div>
          <Button kind="quiet" onClick={onInspect}>
            View release in flight record →
          </Button>
          <Button kind="next" onClick={onBrief}>
            Prepare briefing →
          </Button>
          <details className="mission-provenance">
            <summary>Exact accepted release</summary>
            <pre>{json(record)}</pre>
          </details>
        </>
      )}
    </section>
  );
}
