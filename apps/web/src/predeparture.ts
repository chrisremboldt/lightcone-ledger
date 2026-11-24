import type { FlightPredepartureResponse, FlightPredepartureSummary, MissionReleaseRecord } from '@ledger/contracts';
import type { AreaControl } from './area-controls.js';

type State = Pick<FlightPredepartureSummary, 'phase' | 'needsHumanReview'>;

export function predeparturePresentation(state: State) {
  const labels: Record<State['phase'], string> = {
    evaluating: state.needsHumanReview ? 'Held · departure checks updating' : 'Checking departure prerequisites',
    awaiting_route: 'Held · route review required',
    awaiting_release: 'Held · human release required',
    awaiting_briefing: 'Held · control briefings needed',
    awaiting_acknowledgement: 'Held · personal review needed',
    ready: state.needsHumanReview
      ? 'Human review recorded · departure checks pending'
      : 'Checks clear · departure checks pending',
    departure_unknown: 'Departure result unconfirmed',
    departed: 'Source reported departure',
    cancelled: 'Source reported cancellation',
    blocked: 'Held · departure needs attention',
  };
  const attention =
    [
      'awaiting_route',
      'awaiting_release',
      'awaiting_briefing',
      'awaiting_acknowledgement',
      'departure_unknown',
      'blocked',
    ].includes(state.phase) ||
    (state.phase === 'evaluating' && state.needsHumanReview);
  return { label: labels[state.phase], attention };
}

export function predepartureReleaseCurrent(response: FlightPredepartureResponse, release: MissionReleaseRecord | null) {
  const progress = response.progress;
  const current = response.current;
  const reference = progress?.references.release;
  return Boolean(
    progress &&
    release &&
    reference &&
    release.id === reference.id &&
    release.flightId === response.flightId &&
    release.basis.mission.id === progress.references.mission.eventId &&
    release.basis.mission.missionId === progress.references.mission.missionId &&
    release.basis.mission.sourceRevision === progress.references.mission.sourceRevision &&
    release.basis.mission.contentDigest === progress.references.mission.contentDigest &&
    release.basis.avoidance.mission.recordDigest === progress.references.mission.recordDigest &&
    current.acceptedMission?.recordDigest === progress.references.mission.recordDigest &&
    current.projectedMission?.recordDigest === progress.references.mission.recordDigest &&
    current.missionProcessing === 'completed' &&
    current.releaseValidity?.release.id === reference.id &&
    current.releaseValidity.release.digest === reference.digest &&
    current.releaseValidity.processing === 'completed' &&
    ['scheduled', 'current'].includes(current.releaseValidity.status),
  );
}

export function predepartureReadyAttention(
  response: FlightPredepartureResponse,
  release: MissionReleaseRecord | null,
  interrupted = false,
): string | null {
  if (response.progress?.phase !== 'ready') return null;
  if (interrupted) return 'The latest departure update could not be confirmed. Review the current mission and release.';
  if (predepartureReleaseCurrent(response, release)) {
    const lapsed = response.current.briefings.some((entry) => entry.standing.status === 'lapsed');
    return lapsed ? 'A briefing this departure relies on has lapsed. A new briefing is needed.' : null;
  }
  const status = response.current.releaseValidity?.status;
  if (status === 'expired') return 'The recorded departure window has expired. Review the current mission and release.';
  if (status === 'changed') return 'The mission or accepted-control context changed after this release was recorded.';
  if (status === 'pending') return 'The exact release and its current safety context are not yet confirmed.';
  return 'The exact current mission and source-linked release could not be confirmed.';
}

export function predepartureBriefings(
  response: FlightPredepartureResponse,
  release: MissionReleaseRecord,
  controls: AreaControl[],
) {
  return release.basis.avoidance.candidates.map((candidate) => {
    const control = controls.find((entry) => entry.eventId === candidate.controlEventId);
    const retained = response.progress?.references.briefings.find(
      (entry) => entry.controlEventId === candidate.controlEventId,
    );
    const current =
      retained &&
      response.current.briefings.find(
        (entry) =>
          entry.controlEventId === candidate.controlEventId &&
          entry.briefing.id === retained.briefing.id &&
          entry.briefing.digest === retained.briefing.digest,
      );
    return {
      controlEventId: candidate.controlEventId,
      label: control?.title ?? `Accepted area · version ${candidate.controlVersion}`,
      briefing: retained?.briefing,
      acknowledged: current?.acknowledged,
      recipients: current?.recipients,
      standing: current?.standing,
      // A lapsed briefing no longer counts, though its reviews stay recorded: the control needs a new briefing.
      lapsed: current?.standing.status === 'lapsed',
      complete: Boolean(
        current && current.standing.status === 'in_force' && current.acknowledged === current.recipients,
      ),
    };
  });
}
