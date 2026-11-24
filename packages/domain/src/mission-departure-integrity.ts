import type { MissionDeparturePermit, MissionReleaseRecord } from '@ledger/contracts';
import { canonicalDigest, canonicalize } from '@ledger/integrity';
import { DomainError } from '@ledger/persistence';
import { missionDeparturePolicy } from './mission-departure-policy.js';
import { assertMissionReleaseRecord } from './mission-release-integrity.js';
import { acceptedControlBoundaries } from './accepted-control-rules.js';
import { isFlightControlsSeen } from './mission-release-controls.js';
import { MISSION_DEPARTURE_MAX_RECORD_BYTES, type MissionDepartureIssuanceBasis } from './mission-departure-types.js';

const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const same = (left: unknown, right: unknown): boolean => canonicalDigest(left) === canonicalDigest(right);

function failure(): DomainError {
  return new DomainError(
    409,
    'departure_integrity_failure',
    'The retained departure authorization is inconsistent or unsupported',
  );
}

function requireValue(condition: unknown): asserts condition {
  if (!condition) throw failure();
}

function keys(value: unknown, required: string[]): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).length === required.length
  );
}

function time(value: unknown): number {
  requireValue(
    typeof value === 'string' && /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,3})?Z$/.test(value),
  );
  const parsed = Date.parse(value);
  requireValue(Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19));
  return parsed;
}

export function assertMissionDepartureAuthorization(
  permit: MissionDeparturePermit,
  issuanceBasis: MissionDepartureIssuanceBasis,
): void {
  try {
    requireValue(
      Buffer.byteLength(canonicalize({ permit, issuanceBasis }), 'utf8') <= MISSION_DEPARTURE_MAX_RECORD_BYTES,
    );
    requireValue(
      keys(permit, [
        'version',
        'id',
        'flightId',
        'aircraftId',
        'release',
        'mission',
        'contextDigest',
        'departureAttemptId',
        'allocation',
        'authorizedAt',
        'validUntil',
        'policy',
        'actor',
      ]),
    );
    requireValue(
      permit.version === 'flight.mission-departure-permit.1' &&
        [permit.id, permit.flightId, permit.aircraftId, permit.departureAttemptId].every(id),
    );
    requireValue(
      keys(permit.allocation, ['id', 'digest']) && id(permit.allocation.id) && digest(permit.allocation.digest),
    );
    requireValue(
      same(permit.policy, missionDeparturePolicy) &&
        permit.actor.policyVersion === 'ledger.mission-departure-authority.1',
    );
    requireValue(
      keys(issuanceBasis, [
        'version',
        'release',
        'avoidance',
        'candidateContexts',
        'renderedInputCut',
        'acceptedInputCut',
        'basisManifest',
        'controls',
      ]) &&
        issuanceBasis.version === 'mission.departure-issuance.2' &&
        isFlightControlsSeen(issuanceBasis.controls),
    );
    const release = issuanceBasis.release;
    assertMissionReleaseRecord(release);
    requireValue(permit.flightId === release.flightId && permit.aircraftId === release.aircraftId);
    requireValue(
      same(permit.release, { id: release.id, digest: canonicalDigest(release) }) &&
        same(permit.mission, release.basis.avoidance.mission),
    );
    requireValue(
      permit.contextDigest === release.basis.avoidance.contextDigest &&
        permit.contextDigest === issuanceBasis.avoidance.contextDigest,
    );
    // The basis keeps no copy of the controls that do not apply; the release records them and the equal context
    // digest covers them, so the review is checked below with the release's.
    requireValue(!Object.hasOwn(issuanceBasis.avoidance, 'notApplicable'));
    const authorizedAt = time(permit.authorizedAt);
    const validUntil = time(permit.validUntil);
    requireValue(
      time(release.departureWindow.start) <= authorizedAt && authorizedAt < time(release.departureWindow.end),
    );
    requireValue(time(release.recordedAt) <= time(issuanceBasis.avoidance.evaluatedAt));
    assertMissionReleaseRecord({
      ...release,
      id: permit.id,
      recordedAt: permit.authorizedAt,
      actor: { ...permit.actor, policyVersion: 'ledger.mission-release-authority.1' },
      basis: {
        ...release.basis,
        avoidance: { ...issuanceBasis.avoidance, notApplicable: release.basis.avoidance.notApplicable },
        candidateContexts: issuanceBasis.candidateContexts,
        renderedInputCut: issuanceBasis.renderedInputCut,
        acceptedInputCut: issuanceBasis.acceptedInputCut,
        basisManifest: issuanceBasis.basisManifest,
      },
    } as MissionReleaseRecord);
    // The lease ends no later than its fixed length and the release window. It ends earlier where an accepted
    // control of the organization started or stopped being in force; which instant that was is not retained, so
    // only the pinned controls can be checked here.
    const pinned = acceptedControlBoundaries(
      issuanceBasis.controls.controls.map(({ control }) => control),
      authorizedAt,
    ).map((at) => Date.parse(at));
    requireValue(
      validUntil > authorizedAt &&
        validUntil <=
          Math.min(
            authorizedAt + missionDeparturePolicy.permitSeconds * 1000,
            time(release.departureWindow.end),
            ...pinned,
          ),
    );
  } catch {
    throw failure();
  }
}
