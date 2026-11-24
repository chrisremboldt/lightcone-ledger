import {
  MISSION_BRIEFING_MAX_RECIPIENTS,
  type MissionAvoidanceCandidate,
  type MissionAvoidanceReviewedCandidate,
  type MissionBriefingAcknowledgementCommand,
  type MissionBriefingAcknowledgementsResponse,
  type MissionBriefingCommand,
  type MissionBriefingControlReference,
  type MissionBriefingRecordResponse,
  type MissionBriefingStanding,
  type MissionReleaseRecordResponse,
  type MissionReleaseValidityResponse,
  type OrganizationPerson,
  type Principal,
} from '@ledger/contracts';
import type { AreaControl } from './area-controls.js';
import { readFailureOutcome } from './read-failure.js';
import { wordingValue } from './wording.js';

export interface BriefingContext {
  release: MissionReleaseRecordResponse;
  validity: MissionReleaseValidityResponse;
  controls: { candidate: MissionAvoidanceReviewedCandidate; control: AreaControl }[];
}

export function briefingControl(candidate: MissionAvoidanceCandidate): MissionBriefingControlReference {
  return {
    hazardId: candidate.hazardId,
    controlId: candidate.controlId,
    controlVersion: candidate.controlVersion,
    controlEventId: candidate.controlEventId,
    controlDigest: candidate.controlDigest,
    acceptance: { ...candidate.acceptance },
  };
}

export function briefingReadiness(context: BriefingContext | null): string[] {
  if (!context) return ['The selected release is unavailable. Refresh its exact record before preparing a briefing.'];
  const { release, validity } = context;
  const reasons: string[] = [];
  if (validity.release.id !== release.release.id || validity.release.digest !== release.digest)
    reasons.push('Current status does not match this exact release. Refresh the reviewed record.');
  if (validity.status === 'expired')
    reasons.push(
      'This release’s departure window ended. Review the current mission and record a new release before briefing.',
    );
  else if (validity.status === 'changed')
    reasons.push(
      'This release’s safety context changed. Review the current mission and record a current release before briefing.',
    );
  else if (validity.status === 'pending' || validity.processing !== 'completed')
    reasons.push('The exact release is still updating or its current context is unconfirmed. Wait, then refresh.');
  if (
    ['scheduled', 'current'].includes(validity.status) &&
    validity.currentContextDigest !== release.release.basis.avoidance.contextDigest
  )
    reasons.push('The release’s current safety context could not be matched. Refresh the reviewed record.');
  const candidates = release.release.basis.avoidance.candidates;
  if (!candidates.length) reasons.push('This release has no accepted avoidance control to brief.');
  if (
    context.controls.length !== candidates.length ||
    candidates.some(
      (candidate) =>
        !context.controls.some(
          (entry) =>
            entry.candidate.controlEventId === candidate.controlEventId &&
            entry.candidate.controlDigest === candidate.controlDigest &&
            entry.candidate.acceptance.id === candidate.acceptance.id &&
            entry.candidate.acceptance.digest === candidate.acceptance.digest &&
            entry.control.eventId === candidate.controlEventId &&
            entry.control.controlId === candidate.controlId &&
            entry.control.controlVersion === candidate.controlVersion,
        ),
    )
  )
    reasons.push('An exact accepted control could not be matched. Refresh this release’s control records.');
  return reasons;
}

/** A briefing command refused for lost access; it is not a read of the flight, so a 404 is not lost access. */
export function briefingCommandLostAccess(failure: unknown): boolean {
  return readFailureOutcome(failure, false) === 'access_lost';
}

/**
 * Briefing access lost while one release context was shown stays lost until a later read of the flight's release
 * succeeds, which hands the form a context it did not have when access was lost.
 */
export function briefingAccessLost(
  lost: { context: BriefingContext | null } | null,
  context: BriefingContext | null,
): boolean {
  return lost !== null && (context === null || context === lost.context);
}

export function briefingBasis(context: BriefingContext): string {
  return JSON.stringify({
    release: [context.release.release.id, context.release.digest],
    currentContextDigest: context.validity.currentContextDigest,
    controls: context.release.release.basis.avoidance.candidates.map(briefingControl),
    ready: briefingReadiness(context).length === 0,
  });
}

export function buildBriefingCommand(
  context: BriefingContext,
  controlEventIds: readonly string[],
  people: OrganizationPerson[],
  message: string,
  principalRevision: number,
  controlsDigest?: string,
): MissionBriefingCommand {
  const reasons = briefingReadiness(context);
  if (reasons.length) throw new Error(reasons[0]);
  const candidates = context.release.release.basis.avoidance.candidates;
  const selected = new Set(controlEventIds);
  // The release's order, each control once: the order a briefing lists its controls in.
  const covered = candidates.filter((candidate) => selected.has(candidate.controlEventId));
  if (!covered.length || covered.length !== selected.size)
    throw new Error('Select one or more exact accepted controls from this release.');
  if (
    !people.length ||
    people.length > MISSION_BRIEFING_MAX_RECIPIENTS ||
    new Set(people.map((person) => person.id)).size !== people.length
  )
    throw new Error('Select between one and 32 distinct named recipients.');
  if (!message.trim() || [...message.trim()].length > 4000)
    throw new Error('Write a briefing message of at most 4000 characters.');
  if (!Number.isSafeInteger(principalRevision) || principalRevision < 1)
    throw new Error('Current briefing authority is unavailable. Refresh your session.');
  return {
    kind: 'mission.brief',
    flightId: context.release.release.flightId,
    purpose: 'informational',
    release: { id: context.release.release.id, digest: context.release.digest },
    controls: covered.map(briefingControl),
    recipientPrincipalIds: people.map((person) => person.id).sort(),
    message: message.trim(),
    expectedPrincipalRevision: principalRevision,
    // The controls in scope the author saw; the briefing pins them and conflicts if they changed.
    ...(controlsDigest ? { expectedControlsDigest: controlsDigest } : {}),
  };
}

export function acknowledgementBasis(exact: MissionBriefingRecordResponse, principal: Principal): string {
  return JSON.stringify([
    exact.briefing.id,
    exact.digest,
    exact.briefing.population.digest,
    principal.id,
    principal.revision,
  ]);
}

export function acknowledgementCoverageMatches(
  exact: MissionBriefingRecordResponse,
  coverage: MissionBriefingAcknowledgementsResponse | null,
): coverage is MissionBriefingAcknowledgementsResponse {
  return Boolean(
    coverage &&
    coverage.briefing.id === exact.briefing.id &&
    coverage.briefing.digest === exact.digest &&
    coverage.population.digest === exact.briefing.population.digest,
  );
}

export function buildAcknowledgementCommand(
  exact: MissionBriefingRecordResponse,
  principal: Principal,
): MissionBriefingAcknowledgementCommand {
  if (!exact.briefing.population.recipients.some((recipient) => recipient.principalId === principal.id))
    throw new Error('Only a named recipient can acknowledge their own review.');
  if (
    !['flight:read', 'briefing:ack'].every((capability) =>
      principal.capabilities.some((granted) => granted === capability),
    )
  )
    throw new Error('Your current role requires personal briefing acknowledgement authority.');
  if (!Number.isSafeInteger(principal.revision) || principal.revision < 1)
    throw new Error('Current acknowledgement authority is unavailable. Refresh your session.');
  return {
    kind: 'mission.briefing-acknowledge',
    flightId: exact.briefing.flightId,
    briefing: { id: exact.briefing.id, digest: exact.digest },
    populationDigest: exact.briefing.population.digest,
    attestation: 'reviewed_exact_briefing',
    expectedPrincipalRevision: principal.revision,
  };
}

/**
 * The open briefing's standing: from its acknowledgements read when that read matches it, since that read is polled,
 * otherwise from the briefing read.
 */
export function currentBriefingStanding(
  exact: MissionBriefingRecordResponse,
  coverage: MissionBriefingAcknowledgementsResponse | null,
): MissionBriefingStanding {
  return acknowledgementCoverageMatches(exact, coverage) ? coverage.standing : exact.standing;
}

/** Whether a briefing is in force, and until or since when and why, as a person reads it. */
export function briefingStandingWords(standing: MissionBriefingStanding): string {
  const at = wordingValue(standing.validUntil);
  if (standing.status === 'in_force')
    return standing.boundary === 'release_window_end'
      ? `In force until ${at}, when the release's departure window closes.`
      : `In force until ${at}, when an accepted control that can matter to this flight starts or ends.`;
  const cause =
    standing.boundary === 'release_window_end'
      ? "the release's departure window closed"
      : 'an accepted control that can matter to this flight started or ended';
  return `Lapsed at ${at}, when ${cause}. Its picture of the controls is no longer known to hold; a new briefing is needed.`;
}
