import type {
  FlightControlsSeen,
  InputCut,
  MissionReleaseAvoidance,
  MissionReleaseRecord,
  SubjectBasisManifest,
} from '@ledger/contracts';

// The issuance basis embeds the whole release, so its bound is the release's with room for the permit and the rest.
export const MISSION_DEPARTURE_MAX_RECORD_BYTES = 8 * 1024 * 1024;

/**
 * What a departure authorization was issued on, with the controls in scope its authorizer saw. The route review it
 * re-checked is kept without the controls that do not apply: the release records those, and the context digest,
 * which must equal the release's, covers them.
 */
export interface MissionDepartureIssuanceBasis {
  version: 'mission.departure-issuance.2';
  release: MissionReleaseRecord;
  avoidance: Omit<MissionReleaseAvoidance, 'notApplicable'>;
  candidateContexts: MissionReleaseRecord['basis']['candidateContexts'];
  renderedInputCut: InputCut;
  acceptedInputCut: InputCut;
  basisManifest: SubjectBasisManifest;
  controls: FlightControlsSeen;
}
