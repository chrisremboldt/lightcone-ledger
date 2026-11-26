import type {
  FlightMissionResponse,
  FlightSummary,
  MissionAvoidanceResponse,
  MissionReleaseCommand,
  MissionReleaseFinding,
  MissionReleaseFindingsResponse,
  MissionReleasePolicy,
  MissionReleaseRecord,
  MissionRevisionRecord,
} from '@ledger/contracts';
import { ctDay, noEndDate, time, timeZoneLabel } from './format.js';

export function missionTime(value?: string) {
  if (noEndDate(value)) return 'no end date';
  return value ? `${ctDay(value)} ${time(value)} ${timeZoneLabel()}` : '—';
}

export interface MissionReview {
  flight: FlightSummary;
  mission: FlightMissionResponse;
  preview: MissionAvoidanceResponse;
  /** The open findings a release lists and the proposed ones shown beside them; null when they could not be read. */
  findings: MissionReleaseFindingsResponse | null;
}

export const RELEASE_POLICY: Readonly<MissionReleasePolicy> = Object.freeze({
  id: 'ledger.demo.route-avoidance-release',
  version: 2,
  digest: '158378d5b0e92e042d9b122ad1c6e7d815104eaa35707c98c4377a9e5fb2e7b1',
  title: 'Recorded route avoidance release with open findings and control applicability',
  status: 'draft',
  scope: 'recorded_route_avoidance',
  clock: 'wall',
  mission: 'exact_accepted_and_projected_revision',
  aircraft: 'exact_current_assignment',
  avoidance: 'applicable_outside_complete_current',
  applicability: 'considered_controls_recorded',
  window: 'finite_half_open_subset_of_mission',
  comparison: 'mission_aircraft_policy_and_safety_context',
  validity: 'as_of_read_only',
  departure: 'separate_authorization_after_allocation',
  findings: 'open_active_findings_listed_and_attested',
  instruction:
    'At acceptance, record route-avoidance release for the exact assigned aircraft and accepted and projected mission revision using the complete outside and current avoidance context. Every accepted area control overlapping the mission interval is considered and evaluated by the applicability rule its type declares; only the controls that apply must be outside, and each that does not is recorded with what was measured, the rule that decided it and its inputs by digest. The departure window lies within the mission interval. Current validity is as-of information; final authorization after allocation issues a separate finite lease. This release alone does not permit entering flight. The release also lists the open findings from rules adopted in active mode about the flight, its organization and the subjects its records name, each with its rule, current answer and pinned evaluation, and pins that list by digest. The person releasing attests having seen them; a listed finding is not a verdict and blocks nothing. Findings from rules adopted in shadow mode are shown beside the list, recorded and not counted.',
});

/**
 * Whether a mission review reads the release findings again. The read looks across every subject the flight's records
 * name, so it runs while the release form is open and otherwise only when the flight's revision changed.
 */
export function shouldReadReleaseFindings(state: {
  formOpen: boolean;
  readAtRevision: number | null;
  revision: number;
}): boolean {
  return state.formOpen || state.readAtRevision !== state.revision;
}

/** How the open findings differ between two reads: what the release form shows after a changed list. */
export function findingChanges(
  before: readonly MissionReleaseFinding[],
  after: readonly MissionReleaseFinding[],
): { added: MissionReleaseFinding[]; removed: MissionReleaseFinding[]; changed: MissionReleaseFinding[] } {
  const earlier = new Map(before.map((finding) => [finding.id, finding]));
  const later = new Map(after.map((finding) => [finding.id, finding]));
  return {
    added: after.filter((finding) => !earlier.has(finding.id)),
    removed: before.filter((finding) => !later.has(finding.id)),
    changed: after.filter((finding) => {
      const previous = earlier.get(finding.id);
      return previous !== undefined && JSON.stringify(previous) !== JSON.stringify(finding);
    }),
  };
}

const outcomeWords: Record<MissionReleaseFinding['answer']['outcome'], string> = {
  attention: 'Needs attention',
  pending: 'Waiting for evidence',
  pass: 'Evidence supports the rule',
  not_applicable: 'Does not apply',
  relieved: 'Relieved by a waiver',
};

/** The current answer of a listed finding in plain words. */
export function findingAnswer(finding: MissionReleaseFinding): string {
  return outcomeWords[finding.answer.outcome];
}

function comparisonReason(reason: string, limit: number): string | null {
  const pending = 'Accepted safety evidence is still processing. Wait for its current evaluation.';
  const changed = 'An accepted control’s safety evidence changed. Review its hazard assessment and acceptance.';
  const unsupported = 'An accepted control or its authority cannot support this release. Review its hazard record.';
  const reasons: Record<string, string> = {
    mission_missing: 'The comparison has no recorded mission. Refresh the current mission review.',
    mission_unavailable: 'The comparison has no usable mission. Review the recorded mission before release.',
    unsupported_mission:
      'This recorded mission is unsupported for avoidance comparison. Review its source mission and route.',
    mission_projection_pending:
      'The latest mission is still updating. Wait for that exact revision to finish processing.',
    record_budget_exceeded:
      'The mission and accepted controls exceed the comparison size limit. Review those source records before release.',
    candidate_limit_exceeded: `More than ${limit} accepted controls apply to this mission. Review the overlapping controls before release.`,
    considered_limit_exceeded:
      'More than 512 accepted area controls overlap this mission. Review the overlapping controls before release.',
    mission_geometry_outside_profile:
      'This mission route is outside the supported comparison area. Review the planned route.',
    mission_tolerance_outside_profile:
      'This mission’s lateral tolerance is outside the supported comparison range. Review its source mission.',
    mission_antimeridian_segment_unsupported:
      'This route crosses the date line, which this comparison cannot evaluate.',
    mission_curve_length_outside_profile:
      'This planned route exceeds the comparison’s supported length. Review its source mission.',
    control_geometry_outside_profile:
      'An avoidance area is outside the supported comparison range. Review that hazard’s control.',
    distance_budget_exhausted:
      'The route comparison could not resolve every avoidance area within its calculation limit. Review the route and controls.',
    distance_budget_invalid: 'The comparison settings are unsupported. Refresh the mission review.',
    distance_calculation_invalid:
      'The route distance could not be calculated. Review the source mission and control geometry.',
    geometry_refinement_uncertain:
      'The route is too close to an avoidance boundary for a conclusive comparison. Review its geometry.',
    projection_pending: pending,
    selection_pending: pending,
    assessment_changed: changed,
    evaluation_changed: changed,
    source_evidence_changed: changed,
    selection_changed: changed,
    candidate_context_not_current: changed,
    unsupported_control_or_authority: unsupported,
    unsupported_evaluation: unsupported,
  };
  return reasons[reason] ?? null;
}

function missionIdentity(record: MissionRevisionRecord | null) {
  return record
    ? [record.flightId, record.missionId, record.id, record.sourceRevision, record.contentDigest, record.aircraftId]
    : null;
}

export function releaseReadiness(review: MissionReview | null): string[] {
  if (!review) return ['The current mission review is unavailable. Refresh it before preparing a release.'];
  const { flight, mission, preview } = review;
  const head = mission.acceptedHead;
  if (!head) return ['A recorded mission is required before release.'];
  // The list is required because the release pins what was shown; a listed finding itself blocks nothing.
  const findingsUnavailable = review.findings
    ? []
    : ['The open findings for this flight could not be read. Refresh the mission review before release.'];
  const reasons = [...preview.reasons, ...preview.candidates.flatMap((candidate) => candidate.reasons)].flatMap(
    (reason) => {
      const message = comparisonReason(reason, preview.candidateCompleteness.limit);
      return message ? [message] : [];
    },
  );
  const record = head.record;
  if (
    record.flightId !== flight.id ||
    !mission.binding ||
    mission.binding.flightId !== flight.id ||
    mission.binding.missionId !== record.missionId ||
    mission.binding.sourceId !== record.sourceId ||
    mission.binding.sourceMissionId !== record.sourceMissionId ||
    mission.binding.aircraftId !== record.aircraftId
  )
    reasons.push('The mission does not match this flight. Refresh and review the current mission.');
  if (head.processing.status === 'failed')
    reasons.push(
      'The latest mission could not be processed. Review its source and submit a corrected revision before release.',
    );
  else if (
    head.processing.status !== 'completed' ||
    JSON.stringify(missionIdentity(mission.projectedHead)) !== JSON.stringify(missionIdentity(record))
  )
    reasons.push('The latest mission is still updating. Wait for that exact revision to finish processing.');
  if (!flight.aircraft || flight.aircraft !== record.aircraftId)
    reasons.push('The assigned aircraft differs from this mission. Review the current assignment.');
  if (
    !preview.mission ||
    preview.mission.missionId !== record.missionId ||
    preview.mission.eventId !== record.id ||
    preview.mission.sourceRevision !== record.sourceRevision ||
    preview.mission.contentDigest !== record.contentDigest
  )
    reasons.push('The avoidance comparison uses a different mission. Refresh the mission review.');
  if (
    preview.candidateCompleteness.status !== 'complete' ||
    preview.candidateCompleteness.count !== preview.candidates.length ||
    !preview.contextDigest
  )
    if (!reasons.length)
      reasons.push('The accepted avoidance controls could not be compared completely. Review the comparison details.');
  if (preview.status === 'intersects' || preview.candidates.some((candidate) => candidate.geometry === 'intersects'))
    reasons.push(
      'The current recorded route intersects an accepted avoidance area. Apply and project a revised route before release. Review the route and affected hazard.',
    );
  if (preview.candidates.some((candidate) => candidate.context === 'pending'))
    reasons.push('Accepted safety evidence is still processing. Wait for its current evaluation.');
  if (preview.candidates.some((candidate) => candidate.context === 'review_required'))
    reasons.push('An accepted control’s safety evidence changed. Review its hazard assessment and acceptance.');
  if (preview.candidates.some((candidate) => candidate.context === 'unsupported' || !candidate.authority))
    reasons.push('An accepted control or its authority cannot support this release. Review its hazard record.');
  if (preview.candidates.some((candidate) => candidate.geometry === 'insufficient'))
    reasons.push('The recorded route comparison is uncertain. Review the mission geometry and avoidance areas.');
  if (
    preview.status !== 'outside' ||
    preview.reasons.length ||
    preview.candidates.some((candidate) => candidate.reasons.length)
  ) {
    if (!reasons.length) reasons.push('Complete current mission and avoidance evidence is required before release.');
  }
  return [...new Set([...reasons, ...findingsUnavailable])];
}

export function releaseBasis(review: MissionReview): string {
  const reference = review.preview.mission;
  return JSON.stringify({
    flight: [review.flight.id, review.flight.aircraft],
    accepted: missionIdentity(review.mission.acceptedHead?.record ?? null),
    processing: review.mission.acceptedHead?.processing.status ?? null,
    projected: missionIdentity(review.mission.projectedHead),
    mission: reference
      ? [
          reference.missionId,
          reference.sourceRevision,
          reference.eventId,
          reference.contentDigest,
          reference.recordDigest,
        ]
      : null,
    calculation: [review.preview.calculation.id, review.preview.calculation.version, review.preview.calculation.digest],
    contextDigest: review.preview.contextDigest,
    findingsDigest: review.findings?.basis.digest ?? null,
    policy: [RELEASE_POLICY.id, RELEASE_POLICY.version, RELEASE_POLICY.digest],
    readiness: releaseReadiness(review),
  });
}

export function releaseWindowProblem(
  review: MissionReview,
  start: string,
  end: string,
  now = Date.now(),
): string | null {
  const mission = review.mission.acceptedHead?.record;
  if (!mission) return 'A recorded mission is required before choosing a departure window.';
  const from = Date.parse(start);
  const until = Date.parse(end);
  if (!Number.isFinite(from) || !Number.isFinite(until)) return 'Enter a valid start and end for the departure window.';
  if (from >= until) return 'The departure window must end after it starts.';
  if (from < Date.parse(mission.operatingInterval.start) || until > Date.parse(mission.operatingInterval.end))
    return 'The departure window must fit within this exact mission’s operating interval.';
  const clocks = [
    now,
    Date.parse(review.preview.evaluatedAt),
    Date.parse(review.preview.meta.computedAt),
    Date.parse(review.mission.meta.computedAt),
  ];
  if (until <= Math.max(...clocks.filter(Number.isFinite)))
    return 'The departure window has ended. Choose a later window within the mission interval.';
  return null;
}

export function buildMissionReleaseCommand(
  review: MissionReview,
  principalRevision: number,
  departureWindow: MissionReleaseCommand['departureWindow'],
  note: string,
): MissionReleaseCommand {
  const reasons = releaseReadiness(review);
  if (reasons.length) throw new Error(reasons[0]);
  if (!Number.isSafeInteger(principalRevision) || principalRevision < 1)
    throw new Error('Current release authority is unavailable. Refresh your session.');
  if (!note.trim() || note.trim().length > 4000) throw new Error('Record a release note of at most 4000 characters.');
  return {
    kind: 'mission.release',
    flightId: review.flight.id,
    aircraftId: review.flight.aircraft!,
    mission: structuredClone(review.preview.mission!),
    calculation: {
      id: review.preview.calculation.id,
      version: review.preview.calculation.version,
      digest: review.preview.calculation.digest,
    },
    policy: { id: RELEASE_POLICY.id, version: RELEASE_POLICY.version, digest: RELEASE_POLICY.digest },
    expectedContextDigest: review.preview.contextDigest!,
    expectedFindingsDigest: review.findings!.basis.digest,
    expectedPrincipalRevision: principalRevision,
    departureWindow: { ...departureWindow },
    note: note.trim(),
  };
}
