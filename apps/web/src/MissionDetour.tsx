import { useEffect, useRef, useState } from 'react';
import { ApiError, LedgerClient } from '@ledger/contracts/client';
import type {
  MissionAvoidanceCandidate,
  MissionAvoidanceNotApplicable,
  MissionInput,
  MissionRevisionRecord,
  MissionRouteSuggestionRequest,
  MissionRouteSuggestionResponse,
  MissionSource,
  Principal,
  Receipt,
} from '@ledger/contracts';
import type { AreaControl } from './area-controls.js';
import { Badge, Button, Notice } from '@ledger/ui';
import { MissionRoute } from './MissionRoute.js';
import type { MissionReview } from './missionRelease.js';
import { canonicalDigest } from './safety.js';
import { errorMessage, time, timeZoneLabel } from './format.js';
import { sourceLabel } from './labels.js';

type Control = { candidate: MissionAvoidanceCandidate; control: AreaControl };
interface Suggestion {
  request: MissionRouteSuggestionRequest;
  response: MissionRouteSuggestionResponse;
  mission: MissionRevisionRecord;
  controls: Control[];
}
interface Publication {
  client: LedgerClient;
  key: string;
  sourceId: string;
  source: MissionSource;
  bytes: Uint8Array;
  input?: MissionInput;
  receipt?: Receipt;
  basedOn: Suggestion;
}
interface Props {
  active: boolean;
  client: LedgerClient;
  principal: Principal;
  review: MissionReview;
  controls: Control[];
  /** The considered areas route review recorded as not applying to the current mission, with their exact versions. */
  notApplicable?: MissionAvoidanceNotApplicable[];
  onRefresh: () => Promise<MissionReview>;
}
const duration = (milliseconds: number) => `${Math.floor(milliseconds / 1000)} s`;
const distance = (meters: number) => (meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${Math.round(meters)} m`);
const reasonLabels: Record<string, string> = {
  route_planning_context_missing:
    'The mission source has not supplied required stops and a timing model. Ask its routing owner to submit that context.',
  required_location_inside_avoidance_corridor:
    'A required launch, service or return location is inside an avoidance area, including the route corridor and additional clearance. No detour can preserve that location.',
  mission_interval_insufficient: 'The route cannot fit the unchanged mission, customer and modeled resource windows.',
  avoidance_context_incomplete:
    'The mission or accepted-control context needs review before a detour can be suggested.',
  no_route_found_within_search_profile:
    'No route was found within the supported local search. The constraints have not been relaxed.',
  planning_search_budget_exhausted: 'The bounded route search finished without a proven route.',
  planning_route_vertex_limit_exceeded: 'A detour would exceed the supported number of route vertices.',
  planning_candidate_not_proven_clear: 'The proposed corridor could not be proven clear of every applicable area.',
};
function planningReason(reason: string) {
  return (
    reasonLabels[reason] ??
    'This source geometry or planning context is outside the supported local search. Review its details with the routing owner.'
  );
}
function missionSource(suggestion: Suggestion): MissionSource {
  const mission = suggestion.mission;
  if (!suggestion.response.proposedRoute) throw new Error('No proposed route is available.');
  return {
    sourceRevision: mission.sourceRevision + 1,
    occurredAt: new Date().toISOString(),
    sourceMissionId: mission.sourceMissionId,
    aircraftId: mission.aircraftId,
    route: structuredClone(suggestion.response.proposedRoute),
    lateralToleranceMeters: mission.lateralToleranceMeters,
    altitude: structuredClone(mission.altitude),
    operatingInterval: structuredClone(mission.operatingInterval),
    ...(mission.routePlanning ? { routePlanning: structuredClone(mission.routePlanning) } : {}),
  };
}

export function MissionDetour({ active, client, principal, review, controls, notApplicable = [], onRefresh }: Props) {
  const [clearance, setClearance] = useState('50');
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ text: string; unknown: boolean } | null>(null);
  const [accepted, setAccepted] = useState<{ id: string; revision: number } | null>(null);
  const [showCurrent, setShowCurrent] = useState(false);
  const [projected, setProjected] = useState(false);
  const attempt = useRef<Publication | null>(null);
  const inFlight = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const mission = review.mission.acceptedHead?.record ?? null;
  const preview = review.preview;
  const pending = Boolean(
    mission &&
    (review.mission.projectedHead?.id !== mission.id || review.mission.acceptedHead?.processing.status !== 'completed'),
  );
  const uncertain = failure?.unknown ?? false;
  const superseded = Boolean(
    accepted &&
    mission &&
    mission.sourceRevision > accepted.revision &&
    review.mission.projectedHead?.id === mission.id &&
    review.mission.acceptedHead?.processing.status === 'completed',
  );
  const locked = busy || uncertain || Boolean(accepted && !projected && !superseded);
  const authorized = Boolean(
    mission &&
    principal.capabilities.includes('input:write') &&
    principal.capabilities.includes('mission:write') &&
    principal.missionSources.includes(mission.sourceId),
  );
  const stale = Boolean(
    suggestion &&
    (Number(clearance) !== suggestion.request.clearanceMeters ||
      mission?.id !== suggestion.mission.id ||
      preview.contextDigest !== suggestion.request.expectedContextDigest ||
      !preview.mission ||
      preview.mission.recordDigest !== suggestion.request.expectedMission.recordDigest),
  );
  const canSuggest = Boolean(
    mission &&
    preview.mission &&
    preview.contextDigest &&
    !pending &&
    preview.candidateCompleteness.status === 'complete',
  );
  const source = attempt.current?.source;
  useEffect(() => {
    if (!accepted || !mission) return;
    if (
      mission.id === accepted.id &&
      review.mission.projectedHead?.id === accepted.id &&
      review.mission.acceptedHead?.processing.status === 'completed'
    )
      setProjected(true);
  }, [accepted, mission, review.mission.projectedHead, review.mission.acceptedHead]);

  async function suggest() {
    if (inFlight.current || !canSuggest || !mission || !preview.mission || !preview.contextDigest || locked) return;
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    const request: MissionRouteSuggestionRequest = {
      expectedMission: structuredClone(preview.mission),
      expectedContextDigest: preview.contextDigest,
      clearanceMeters: Number(clearance),
    };
    try {
      const response = await client.missionRouteSuggestion(mission.flightId, request);
      if (!alive.current) return;
      setSuggestion({ request, response, mission: structuredClone(mission), controls: structuredClone(controls) });
      setShowCurrent(false);
      setAccepted(null);
      setProjected(false);
      attempt.current = null;
    } catch (error) {
      if (alive.current) setFailure({ text: errorMessage(error), unknown: false });
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function publish(retry = false) {
    if (inFlight.current || busy || !suggestion || (!retry && (uncertain || stale || !authorized))) return;
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    try {
      if (!attempt.current) {
        const current = (await client.request<{ principal: Principal }>('/v1/me')).principal;
        if (
          current.id !== principal.id ||
          current.tenantId !== principal.tenantId ||
          !current.capabilities.includes('input:write') ||
          !current.capabilities.includes('mission:write') ||
          !current.missionSources.includes(suggestion.mission.sourceId)
        )
          throw new Error(
            'Your current role cannot publish for this mission source. Ask its routing owner to apply the route.',
          );
        const fresh = await client.missionRouteSuggestion(suggestion.mission.flightId, suggestion.request);
        if (
          fresh.status !== 'suggested' ||
          fresh.timeFit.status !== 'fits' ||
          !fresh.proposedRoute ||
          (await canonicalDigest(fresh.proposedRoute)) !== (await canonicalDigest(suggestion.response.proposedRoute))
        )
          throw new Error(
            'The suggestion or modeled time fit changed. Review the current mission and request a new detour.',
          );
        const source = missionSource(suggestion);
        const bytes = new TextEncoder().encode(`${JSON.stringify(source)}\n`);
        if (bytes.byteLength > 64 * 1024) throw new Error('This proposed source revision exceeds its supported size.');
        attempt.current = {
          client,
          key: crypto.randomUUID(),
          sourceId: suggestion.mission.sourceId,
          source,
          bytes,
          basedOn: structuredClone(suggestion),
        };
      }
      const retained = attempt.current;
      if (!retained.input) {
        const { artifact } = await retained.client.upload(
          retained.bytes,
          'application/json',
          `${retained.key}:original`,
          'mission-route.json',
        );
        const { sourceRevision, occurredAt, ...payload } = retained.source;
        retained.input = {
          sourceId: retained.sourceId,
          kind: 'mission.revision',
          sourceRevision,
          occurredAt,
          subject: { flightId: retained.basedOn.mission.flightId },
          artifactId: artifact.id,
          fidelity: 'synthetic_contract',
          payload,
        };
      }
      const { receipt } = await retained.client.input(retained.input, `${retained.key}:revision`);
      if (
        receipt.kind !== 'mission.revision' ||
        receipt.sourceId !== retained.input.sourceId ||
        receipt.flightId !== retained.input.subject.flightId ||
        Date.parse(receipt.occurredAt) !== Date.parse(retained.input.occurredAt) ||
        receipt.linkStatus !== 'linked' ||
        !receipt.eventId ||
        (await canonicalDigest(receipt.payload)) !== (await canonicalDigest(retained.input.payload))
      )
        throw new Error(
          'The mission receipt does not match the retained source revision. Retry the identical submission to recover its result.',
        );
      retained.receipt = receipt;
      if (!alive.current) return;
      setAccepted({ id: receipt.eventId, revision: retained.source.sourceRevision });
      void onRefresh().catch(() => undefined);
    } catch (error) {
      if (!alive.current) return;
      const unknown =
        Boolean(attempt.current) && (!(error instanceof ApiError) || error.status === 408 || error.status >= 500);
      setFailure({ text: errorMessage(error), unknown });
      if (!unknown) attempt.current = null;
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  }
  function download() {
    if (!suggestion) return;
    const source = missionSource(suggestion);
    const url = URL.createObjectURL(new Blob([JSON.stringify(source, null, 2) + '\n'], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `mission-revision-${source.sourceRevision}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }
  const displayed = suggestion && !showCurrent ? suggestion.mission : mission;
  const shownControls = suggestion && !showCurrent ? suggestion.controls : controls;
  const response = suggestion?.response;
  return (
    <section className="mission-detour" aria-label="Suggested mission detour" data-testid="mission-detour">
      <div className="safety-section-heading">
        <h3>Suggest an avoidance detour</h3>
        {response && (
          <Badge tone={response.status === 'suggested' || response.status === 'unchanged' ? 'planned' : 'attention'}>
            {response.status === 'suggested'
              ? 'Route suggested'
              : response.status === 'unchanged'
                ? 'Existing route clears the areas'
                : response.status === 'infeasible'
                  ? 'No feasible route'
                  : 'No proven route'}
          </Badge>
        )}
      </div>
      <p>
        Keep required launch, service and return locations. Check the whole corridor against every accepted area for
        this mission interval.
      </p>
      <div className="detour-request">
        <label>
          Additional clearance (m)
          <input
            type="number"
            min={1}
            max={500}
            value={clearance}
            disabled={locked}
            onChange={(event) => setClearance(event.target.value)}
          />
        </label>
        <Button
          kind="next"
          disabled={
            locked ||
            !canSuggest ||
            !Number.isFinite(Number(clearance)) ||
            Number(clearance) < 1 ||
            Number(clearance) > 500
          }
          onClick={() => void suggest()}
        >
          {busy && !attempt.current ? 'Finding a detour…' : 'Suggest detour'}
        </Button>
      </div>
      {response && (
        <>
          <p className="muted">
            Suggestion for mission revision {suggestion!.mission.sourceRevision} · checked{' '}
            {time(response.evaluatedAt, true)} {timeZoneLabel()} · {response.candidates.length} accepted areas ·{' '}
            {response.clearanceMeters} m additional clearance
          </p>
          {response.distance && (
            <dl className="detour-comparison">
              <div>
                <dt>Original distance</dt>
                <dd>{distance(response.distance.originalMeters)}</dd>
              </div>
              <div>
                <dt>Proposed distance</dt>
                <dd>{distance(response.distance.proposedMeters)}</dd>
              </div>
              <div>
                <dt>Distance change</dt>
                <dd>
                  {response.distance.changeMeters >= 0 ? '+' : ''}
                  {distance(response.distance.changeMeters)}
                </dd>
              </div>
              <div>
                <dt>Modeled time fit</dt>
                <dd>
                  {response.timeFit.status === 'fits'
                    ? `Fits · ${duration(response.timeFit.slackMs ?? 0)} spare`
                    : response.timeFit.status === 'insufficient'
                      ? 'Does not fit'
                      : 'Not available'}
                </dd>
              </div>
            </dl>
          )}
          {response.timeFit.status === 'fits' && (
            <p>
              Modeled departure {time(response.timeFit.departureAt!, true)} {timeZoneLabel()} · completion, holds and
              margin by {time(response.timeFit.requiredCompletionAt!, true)} {timeZoneLabel()}. Fresh aircraft and crew
              allocation still happens before departure.
            </p>
          )}
        </>
      )}
      {response && (
        <>
          {response.reasons.length > 0 && (
            <ul className="mission-prerequisites">
              {[...new Set(response.reasons.map(planningReason))].map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
        </>
      )}
      {displayed && (
        <MissionRoute
          mission={displayed}
          controls={shownControls}
          notApplicable={suggestion && !showCurrent ? [] : notApplicable}
          proposedRoute={suggestion && !showCurrent ? response?.proposedRoute : null}
        />
      )}
      {pending && (
        <p role="status">
          Wait for the accepted mission revision to finish processing before requesting a detour or reviewing release.
        </p>
      )}
      {failure && (
        <Notice title={uncertain ? 'Mission revision result unknown' : 'Detour action unavailable'} tone="attention">
          {failure.text}
          {uncertain && (
            <>
              <p>
                The original revision, bytes and request are retained. Recover that same submission before another
                application.
              </p>
              <Button kind="next" disabled={busy || !active} onClick={() => void publish(true)}>
                Retry same mission revision
              </Button>
            </>
          )}
        </Notice>
      )}
      {response && (
        <>
          {stale && !accepted && !uncertain && (
            <Notice title="Suggestion basis changed">
              Review the current mission and controls, then request a new suggestion. This comparison stays visible.
            </Notice>
          )}
          {response.status === 'suggested' && response.timeFit.status === 'fits' && !accepted && (
            <div className="detour-application">
              {authorized ? (
                <>
                  <p>
                    Publish revision {suggestion!.mission.sourceRevision + 1} as {principal.name} for{' '}
                    {sourceLabel(suggestion!.mission.sourceId)}. The original route stays recorded; release is a
                    separate review.
                  </p>
                  <Button kind="next" disabled={locked || stale || !active} onClick={() => void publish()}>
                    Apply suggested mission revision
                  </Button>
                </>
              ) : (
                <>
                  <p>
                    Your role can review this suggestion. Its mission routing owner must apply it through the authorized
                    source.
                  </p>
                  <Button kind="next" disabled={locked || stale} onClick={download}>
                    Download route for routing owner
                  </Button>
                </>
              )}
            </div>
          )}
          {accepted && (
            <div className="action-success" role="status">
              {superseded
                ? `Mission revision ${accepted.revision} stays recorded; a newer completed mission is ready for review.`
                : projected
                  ? `Mission revision ${accepted.revision} projected. Review the revised route and its current control checks before release.`
                  : `Mission revision ${accepted.revision} accepted. Waiting for its exact projection before release review.`}
              {(projected || superseded) && (
                <Button kind="next" onClick={() => setShowCurrent(true)}>
                  Review revised route
                </Button>
              )}
            </div>
          )}
          {accepted && mission && mission.sourceRevision > accepted.revision && (
            <Notice title="A newer mission is accepted">
              Revision {accepted.revision} stays recorded. Review the newer source revision before preparing a release.
            </Notice>
          )}
          <details className="mission-provenance">
            <summary>Suggested route and source details</summary>
            <pre>{JSON.stringify({ suggestion: response, source: source ?? null }, null, 2)}</pre>
          </details>
        </>
      )}
    </section>
  );
}
