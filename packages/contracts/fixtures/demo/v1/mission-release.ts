import { canonicalDigest } from '../../../../integrity/src/index.js';
import type {
  MissionDepartureAuthorizationCommand,
  MissionDepartureAuthorizationResponse,
  MissionDepartureFitWitness,
  MissionDeparturePermit,
  MissionDeparturePolicy,
  MissionReleaseAvoidance,
  MissionReleaseCommand,
  MissionReleaseCommandResponse,
  MissionReleaseFinding,
  MissionReleaseFindings,
  MissionReleaseFindingsResponse,
  MissionReleasePolicy,
  MissionReleaseRecord,
  MissionReleaseRecordResponse,
  MissionReleaseControlRecordContext,
  MissionReleaseValidityResponse,
} from '../../../src/mission-release.js';
import type { RuleEvaluationRecord } from '../../../src/rule-evaluations.js';
import type { MissionAvoidancePreview, SubjectBasisManifest } from '../../../src/index.js';
import {
  areaControlApplicability,
  areaControlAuthority,
  areaControlContext,
  areaControlOrganizationId,
} from './area-control.js';
import {
  missionAvoidanceCalculation,
  missionAvoidanceConsideredTypes,
  missionAvoidanceIntersects,
  missionAvoidanceOutside,
} from './mission-avoidance.js';
import { missionRecord, missionRevision2Record } from './missions.js';

const avoidanceInstruction =
  'At acceptance, record route-avoidance release for the exact assigned aircraft and accepted and projected mission revision using the complete outside and current avoidance context. Every accepted area control overlapping the mission interval is considered and evaluated by the applicability rule its type declares; only the controls that apply must be outside, and each that does not is recorded with what was measured, the rule that decided it and its inputs by digest. The departure window lies within the mission interval. Current validity is as-of information; final authorization after allocation issues a separate finite lease. This release alone does not permit entering flight.';
const releasePolicy = {
  id: 'ledger.demo.route-avoidance-release',
  version: 2,
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
  instruction: `${avoidanceInstruction} The release also lists the open findings from rules adopted in active mode about the flight, its organization and the subjects its records name, each with its rule, current answer and pinned evaluation, and pins that list by digest. The person releasing attests having seen them; a listed finding is not a verdict and blocks nothing. Findings from rules adopted in shadow mode are shown beside the list, recorded and not counted.`,
} as const;
/** The policy a release is recorded under. */
export const missionReleasePolicy = {
  ...releasePolicy,
  digest: canonicalDigest(releasePolicy),
} satisfies MissionReleasePolicy;

const departurePolicy = {
  id: 'ledger.demo.route-avoidance-departure',
  version: 1,
  clock: 'wall',
  permitSeconds: 30,
  authorization: 'finite_lease_at_authorized_at',
  replay: 'same_original_unexpired_lease',
  renewal: 'unsupported',
  uniqueness: 'tenant_flight_and_attempt_and_allocation',
  operationFit: 'producer_checks_before_authorization_and_at_consumption',
  expiry: 'earliest_of_30_seconds_release_end_or_selection_boundary',
  instruction:
    'After retaining one live exclusive reservation and conservatively checking full remaining operation fit, atomically validate the exact release at authorizedAt and issue at most one nonrenewable lease per tenant and Ledger flight. Tenant/allocation identity binds one flight and attempt, not a pad name. The lease ends at the earliest of 30 seconds, release-window end or relevant selection boundary. Later safety changes do not revoke this issued lease. Exact original-key retries return the same unexpired lease without fresh safety or principal-revision comparison and never extend it; expired retries fail. No new key, attempt or allocation can obtain another authorization for this flight, including when its first lease expired unused. Before POST, the producer checks route duration, known holds, margin and conservative lease handoff delay against mission end. At consumption, it refreshes fit and atomically retains the exact pinned mission, aircraft, route, live exclusive allocation, fit witness, once-per-flight consumption and physical transition across restart. An unused expired lease leaves the flight held or abandoned; there is no replacement protocol. Allocation and operation fit are producer commitments, not Ledger resource or aircraft-performance certification.',
} as const;
export const missionDeparturePolicy = {
  ...departurePolicy,
  digest: canonicalDigest(departurePolicy),
} satisfies MissionDeparturePolicy;

/** What route review read the accepted control record against when the release was accepted. */
export const missionReleaseSafetyContext = areaControlContext satisfies MissionReleaseControlRecordContext;

const mission = {
  missionId: missionRevision2Record.missionId,
  sourceRevision: missionRevision2Record.sourceRevision,
  eventId: missionRevision2Record.id,
  contentDigest: missionRevision2Record.contentDigest,
  recordDigest: canonicalDigest(missionRevision2Record),
};
const candidate = {
  ...missionAvoidanceOutside.candidates[0]!,
  ...areaControlApplicability(missionAvoidanceOutside.candidates[0]!, mission),
  geometry: 'outside',
  context: 'current',
  authority: areaControlAuthority,
  safetyContextDigest: canonicalDigest(missionReleaseSafetyContext),
  reasons: [],
} satisfies MissionReleaseAvoidance['candidates'][number];
const calculation = {
  id: missionAvoidanceCalculation.id,
  version: missionAvoidanceCalculation.version,
  digest: missionAvoidanceCalculation.digest,
};
const candidateCompleteness = {
  status: 'complete',
  count: 1,
  limit: 64,
  considered: 1,
  consideredLimit: 512,
} as const;
const avoidance = {
  version: 'flight.mission-avoidance.1',
  evaluatedAt: '2026-10-15T14:14:30Z',
  status: 'outside',
  mission,
  candidates: [candidate],
  notApplicable: [],
  consideredTypes: missionAvoidanceConsideredTypes,
  candidateCompleteness,
  calculation: missionAvoidanceCalculation,
  contextDigest: canonicalDigest({
    version: 'mission.avoidance-context.1',
    mission,
    calculation,
    candidates: [candidate],
    notApplicable: [],
    consideredTypes: missionAvoidanceConsideredTypes,
    candidateCompleteness,
  }),
  reasons: [],
} satisfies Omit<MissionReleaseAvoidance, 'previewDigest'>;
export const missionReleaseAvoidance = {
  ...avoidance,
  previewDigest: canonicalDigest(avoidance),
} satisfies MissionReleaseAvoidance;

const actor = {
  id: 'resolved-release-author',
  name: 'Taylor Singh',
  kind: 'person',
  active: true,
  principalRevision: 3,
  capabilities: ['decision:write', 'flight:read', 'mission:release'],
  commandLinkSources: [],
  missionSources: [],
  checkedCapabilities: ['decision:write', 'flight:read', 'mission:release'],
  policyVersion: 'ledger.mission-release-authority.1',
  scope: { kind: 'flight', id: missionRevision2Record.flightId },
} satisfies MissionReleaseRecord['actor'];
const fixtureTenant = 'fixture-tenant';
const flightSubject = { scope: 'ledger', kind: 'flight', id: missionRevision2Record.flightId } as const;
const organizationSubject = { scope: 'ledger', kind: 'organization', id: `organization:${fixtureTenant}` } as const;
const aircraftSubject = {
  scope: 'source',
  kind: 'aircraft',
  id: missionRevision2Record.aircraftId,
  sourceId: 'fictional-fleet-source',
} as const;
const subjectKey = (subject: { scope: string; kind: string; id: string; sourceId?: string }) =>
  subject.scope === 'ledger'
    ? `ledger/${subject.kind}/${encodeURIComponent(subject.id)}`
    : `source/${encodeURIComponent(subject.sourceId!)}/${subject.kind}/${encodeURIComponent(subject.id)}`;
/** A rule evaluation a listed finding is pinned to, in the shape the generic evaluator records. */
function evaluationFor(
  subject: { scope: 'ledger' | 'source'; kind: 'flight' | 'aircraft'; id: string; sourceId?: string },
  packId: string,
  rule: { id: string; title: string },
  answer: MissionReleaseFinding['answer'],
  evaluationId: string,
  mode: 'active' | 'shadow',
): RuleEvaluationRecord {
  const text = 'Inspect the aircraft within the adopted interval.';
  return {
    version: 'ledger.rule-evaluation.1',
    id: evaluationId,
    subject,
    subjectKey: subjectKey(subject),
    organizationId: organizationSubject.id,
    adoption: {
      id: `${packId}-adoption`,
      acceptedRevision: 2,
      effectiveInterval: { start: '2026-10-01T00:00:00Z', end: '2026-12-31T00:00:00Z' },
      mode,
    },
    pack: { id: packId, version: 1, digest: canonicalDigest({ fictionalPack: packId }) },
    rule: {
      id: rule.id,
      version: 1,
      digest: canonicalDigest({ fictionalRule: rule.id }),
      title: rule.title,
      source: { kind: 'operator_procedure', reference: 'Fictional procedure 2.1', text, sha256: canonicalDigest(text) },
    },
    check: { kind: 'value.within-limit', version: 1, definitionDigest: canonicalDigest({ fictionalCheck: 1 }) },
    parameters: {},
    applicability: 'applicable',
    evidenceState: answer.evidenceState,
    outcome: answer.outcome,
    reasonCode: answer.outcome === 'attention' ? 'limit_exceeded' : 'evidence_missing',
    summary: answer.summary,
    evidence: [],
    inputs: [],
    clock: { mode: 'wall', evaluatedAt: '2026-10-15T14:09:59Z' },
    trigger: { kind: 'observation' },
    inputCut: { streams: {}, basisRevision: 1, principalRevision: 1 },
    dependencyBasis: canonicalDigest({ fictionalBasis: evaluationId }),
    observationDigest: canonicalDigest({ fictionalObservations: evaluationId }),
    inputDigest: canonicalDigest({ fictionalInputs: evaluationId }),
    recordedAt: '2026-10-15T14:10:00Z',
  };
}
function listed(evaluation: RuleEvaluationRecord): MissionReleaseFinding {
  return {
    id: `finding:${canonicalDigest({ tenant: fixtureTenant, subjectKey: evaluation.subjectKey, packId: evaluation.pack.id, leafId: evaluation.rule.id, scope: 'subject' })}`,
    subject: evaluation.subject as MissionReleaseFinding['subject'],
    subjectKey: evaluation.subjectKey,
    status: 'open',
    rule: {
      packId: evaluation.pack.id,
      id: evaluation.rule.id,
      version: evaluation.rule.version,
      title: evaluation.rule.title,
    },
    answer: { outcome: evaluation.outcome, evidenceState: evaluation.evidenceState, summary: evaluation.summary },
    evaluation: { id: evaluation.id, digest: canonicalDigest(evaluation), recordedAt: evaluation.recordedAt },
  };
}
/** The evaluation the counted finding is pinned to (active) and the proposed one's (shadow). */
export const missionReleaseFindingEvaluation = evaluationFor(
  aircraftSubject,
  'fixture.example-maintenance',
  { id: 'inspection-interval', title: 'Inspection within its interval' },
  {
    outcome: 'attention',
    evidenceState: 'supported',
    summary: 'The last recorded inspection is older than the adopted interval.',
  },
  'resolved-inspection-evaluation',
  'active',
);
export const missionReleaseProposedEvaluation = evaluationFor(
  flightSubject,
  'fixture.example-operations',
  { id: 'battery-reserve', title: 'Battery reserve at landing' },
  { outcome: 'pending', evidenceState: 'insufficient', summary: 'No landing report has been recorded yet.' },
  'resolved-battery-evaluation',
  'shadow',
);
const findingsBody = {
  version: 'mission.release-findings.1',
  subjects: (
    [
      { subject: flightSubject, subjectKey: subjectKey(flightSubject), reason: 'flight' },
      { subject: organizationSubject, subjectKey: subjectKey(organizationSubject), reason: 'organization' },
      { subject: aircraftSubject, subjectKey: subjectKey(aircraftSubject), reason: 'named' },
    ] satisfies MissionReleaseFindings['subjects']
  ).sort((left, right) => (left.subjectKey < right.subjectKey ? -1 : 1)),
  findings: [listed(missionReleaseFindingEvaluation)],
} satisfies Omit<MissionReleaseFindings, 'digest'>;
/** The open findings a version 2 release lists and pins. */
export const missionReleaseFindings = {
  ...findingsBody,
  digest: canonicalDigest(findingsBody),
} satisfies MissionReleaseFindings;
/** A proposed-rule finding: shown beside the list, recorded and not counted. */
export const missionReleaseProposedFinding = listed(missionReleaseProposedEvaluation);
export const missionReleaseFindingsResponse = {
  flightId: missionRevision2Record.flightId,
  readAt: '2026-10-15T14:14:00Z',
  basis: missionReleaseFindings,
  proposed: [missionReleaseProposedFinding],
  proposedComplete: true,
} satisfies MissionReleaseFindingsResponse;

export const missionReleaseCommand = {
  kind: 'mission.release',
  flightId: missionRevision2Record.flightId,
  aircraftId: missionRevision2Record.aircraftId,
  mission,
  calculation,
  policy: { id: missionReleasePolicy.id, version: missionReleasePolicy.version, digest: missionReleasePolicy.digest },
  expectedContextDigest: missionReleaseAvoidance.contextDigest,
  expectedFindingsDigest: missionReleaseFindings.digest,
  expectedPrincipalRevision: actor.principalRevision,
  departureWindow: { start: '2026-10-15T14:15:00Z', end: '2026-10-15T14:19:00Z' },
  note: 'Release this exact planned route outside the recorded accepted avoidance area; obtain final authorization after reservation.',
} satisfies MissionReleaseCommand;
const organizationId = areaControlOrganizationId;
const flightId = missionRevision2Record.flightId;
const missionId = missionRevision2Record.missionId;
const basisManifest = {
  version: 'subject-evidence.1',
  subjectId: flightId,
  principalId: actor.id,
  principalRevision: actor.principalRevision,
  subjects: [organizationId, flightId, missionId],
  edges: [
    { subjectId: flightId, dependencySubjectId: organizationId, eventId: 'resolved-flight-created-event' },
    { subjectId: flightId, dependencySubjectId: missionId, eventId: missionRecord.id },
  ],
  frontiers: [
    { subjectId: organizationId, streamId: 'resolved-organization-stream', sequence: 2, projectedSequence: 2 },
    { subjectId: flightId, streamId: 'resolved-flight-stream', sequence: 1, projectedSequence: 1 },
    { subjectId: flightId, streamId: 'resolved-selection-stream', sequence: 1, projectedSequence: 1 },
    { subjectId: flightId, streamId: 'resolved-mission-stream', sequence: 2, projectedSequence: 2 },
    { subjectId: missionId, streamId: 'resolved-mission-stream', sequence: 2, projectedSequence: 2 },
  ],
  authority: { streamId: 'resolved-release-authority-stream', sequence: 1, projectedSequence: 1 },
} satisfies SubjectBasisManifest;
const cut = {
  streams: {
    ...Object.fromEntries(basisManifest.frontiers.map((frontier) => [frontier.streamId, frontier.projectedSequence])),
    [basisManifest.authority.streamId]: basisManifest.authority.projectedSequence,
  },
  basisRevision: 7,
  principalRevision: actor.principalRevision,
};
export const missionReleaseRecord = {
  version: 'flight.mission-release.2',
  id: 'resolved-mission-release-event',
  flightId: missionReleaseCommand.flightId,
  organizationId,
  aircraftId: missionReleaseCommand.aircraftId,
  acceptedRevision: 8,
  recordedAt: missionReleaseAvoidance.evaluatedAt,
  actor,
  policy: missionReleasePolicy,
  departureWindow: missionReleaseCommand.departureWindow,
  note: missionReleaseCommand.note,
  basis: {
    mission: missionRevision2Record,
    avoidance: missionReleaseAvoidance,
    candidateContexts: [
      {
        controlEventId: candidate.controlEventId,
        acceptanceId: candidate.acceptance.id,
        context: missionReleaseSafetyContext,
      },
    ],
    notApplicableContexts: [],
    renderedInputCut: cut,
    acceptedInputCut: cut,
    basisManifest,
    findings: missionReleaseFindings,
  },
} satisfies MissionReleaseRecord;
export const missionReleaseRecordResponse = {
  release: missionReleaseRecord,
  digest: canonicalDigest(missionReleaseRecord),
} satisfies MissionReleaseRecordResponse;
const releaseReference = { id: missionReleaseRecord.id, digest: missionReleaseRecordResponse.digest };
function actionMeta(id: string, computedAt: string) {
  return {
    requestId: `command-${id}`,
    effectId: id,
    projectionRevision: 7,
    inputCut: cut,
    dependencyBasis: canonicalDigest(basisManifest),
    computedAt,
    outstandingWork: 1,
  };
}
export const missionReleaseCommandResponse = {
  command: {
    id: missionReleaseRecord.id,
    kind: 'mission.release',
    flightId: missionReleaseRecord.flightId,
    actorId: actor.id,
    recordedAt: missionReleaseRecord.recordedAt,
    payload: missionReleaseCommand,
  },
  meta: actionMeta(missionReleaseRecord.id, missionReleaseRecord.recordedAt),
} satisfies MissionReleaseCommandResponse;

function validity(
  status: MissionReleaseValidityResponse['status'],
  evaluatedAt: string,
  overrides: Partial<MissionReleaseValidityResponse> = {},
): MissionReleaseValidityResponse {
  return {
    release: releaseReference,
    evaluatedAt,
    status,
    processing: 'completed',
    currentContextDigest: missionReleaseAvoidance.contextDigest,
    nextBoundary: missionReleaseCommand.departureWindow.end,
    reasons: [],
    ...overrides,
  };
}
export const missionReleaseValidityScheduled = validity('scheduled', '2026-10-15T14:14:31Z', {
  nextBoundary: missionReleaseCommand.departureWindow.start,
});
export const missionReleaseValidityCurrent = validity('current', '2026-10-15T14:16:00Z');
export const missionReleaseValidityExpired = validity('expired', missionReleaseCommand.departureWindow.end, {
  nextBoundary: null,
  reasons: ['departure_window_expired'],
});
/** The control record was revised after release: its candidate now asks for review. */
const changedSafetyContext = {
  ...missionReleaseSafetyContext,
  control: { ...missionReleaseSafetyContext.control, versionNumber: 2 },
} satisfies MissionReleaseControlRecordContext;
const changedCandidateFields: MissionAvoidancePreview['candidates'][number] = {
  ...candidate,
  context: 'review_required',
  safetyContextDigest: canonicalDigest(changedSafetyContext),
  reasons: ['control_changed'],
};
const changedCandidate = {
  ...changedCandidateFields,
  ...areaControlApplicability(changedCandidateFields, mission),
} satisfies MissionAvoidancePreview['candidates'][number];
const changedPreviewBody = {
  ...avoidance,
  evaluatedAt: '2026-10-15T14:16:01Z',
  status: 'insufficient',
  candidates: [changedCandidate],
  contextDigest: canonicalDigest({
    version: 'mission.avoidance-context.1',
    mission,
    calculation,
    candidates: [changedCandidate],
    notApplicable: [],
    consideredTypes: missionAvoidanceConsideredTypes,
    candidateCompleteness,
  }),
} satisfies Omit<MissionAvoidancePreview, 'previewDigest'>;
const changedPreview = {
  ...changedPreviewBody,
  previewDigest: canonicalDigest(changedPreviewBody),
} satisfies MissionAvoidancePreview;
export const missionReleaseValidityChanged = validity('changed', '2026-10-15T14:16:01Z', {
  currentContextDigest: changedPreview.contextDigest,
  reasons: ['safety_context_changed'],
});
export const missionReleaseValidityPending = validity('pending', '2026-10-15T14:16:01Z', {
  processing: 'failed',
  currentContextDigest: null,
  nextBoundary: null,
  reasons: ['matching_evidence_unavailable'],
});

export const missionDepartureAllocation = {
  id: 'resolved-exclusive-pad-reservation',
  tenantId: 'fixture-tenant',
  flightId: missionReleaseCommand.flightId,
  departureAttemptId: 'resolved-departure-attempt',
  padId: 'fictional-pad-two',
  interval: { start: '2026-10-15T14:15:55Z', end: '2026-10-15T14:16:35Z' },
};
export const missionDepartureAuthorization = {
  kind: 'mission.departure-authorize',
  flightId: missionReleaseCommand.flightId,
  aircraftId: missionReleaseCommand.aircraftId,
  release: releaseReference,
  departureAttemptId: missionDepartureAllocation.departureAttemptId,
  allocation: { id: missionDepartureAllocation.id, digest: canonicalDigest(missionDepartureAllocation) },
  expectedPrincipalRevision: actor.principalRevision,
} satisfies MissionDepartureAuthorizationCommand;
export const missionDeparturePermit = {
  version: 'flight.mission-departure-permit.1',
  id: 'resolved-mission-departure-permit',
  flightId: missionDepartureAuthorization.flightId,
  aircraftId: missionDepartureAuthorization.aircraftId,
  release: releaseReference,
  mission,
  contextDigest: missionReleaseAvoidance.contextDigest,
  departureAttemptId: missionDepartureAuthorization.departureAttemptId,
  allocation: missionDepartureAuthorization.allocation,
  authorizedAt: '2026-10-15T14:16:00Z',
  validUntil: '2026-10-15T14:16:30Z',
  policy: missionDeparturePolicy,
  actor: { ...actor, policyVersion: 'ledger.mission-departure-authority.1' },
} satisfies MissionDeparturePermit;
export const missionDepartureAuthorizationResponse = {
  command: {
    id: missionDeparturePermit.id,
    kind: 'mission.departure-authorize',
    flightId: missionDeparturePermit.flightId,
    actorId: missionDeparturePermit.actor.id,
    recordedAt: missionDeparturePermit.authorizedAt,
    payload: { permit: missionDeparturePermit, digest: canonicalDigest(missionDeparturePermit) },
  },
  authorization: {
    permit: missionDeparturePermit,
    digest: canonicalDigest(missionDeparturePermit),
    evaluatedAt: missionDeparturePermit.authorizedAt,
    disposition: 'issued',
  },
  meta: actionMeta(missionDeparturePermit.id, missionDeparturePermit.authorizedAt),
} satisfies MissionDepartureAuthorizationResponse;
export const missionDepartureFitWitness = {
  version: 'mission.departure-fit.1',
  permit: { id: missionDeparturePermit.id, digest: canonicalDigest(missionDeparturePermit) },
  mission,
  aircraftId: missionDeparturePermit.aircraftId,
  evaluatedAt: '2026-10-15T14:16:05Z',
  remainingDurationMs: 180000,
  holdAllowanceMs: 10000,
  marginMs: 10000,
  requiredCompletionAt: '2026-10-15T14:19:25Z',
} satisfies MissionDepartureFitWitness;

function preview(body: Omit<MissionAvoidancePreview, 'contextDigest' | 'previewDigest'>): MissionAvoidancePreview {
  const retained = {
    ...body,
    contextDigest:
      body.mission && body.candidateCompleteness.status === 'complete'
        ? canonicalDigest({
            version: 'mission.avoidance-context.1',
            mission: body.mission,
            calculation,
            candidates: body.candidates,
            notApplicable: body.notApplicable,
            consideredTypes: body.consideredTypes,
            candidateCompleteness: body.candidateCompleteness,
          })
        : null,
  };
  return { ...retained, previewDigest: canonicalDigest(retained) };
}
const { contextDigest: _contextDigest, previewDigest: _previewDigest, ...previewBody } = missionReleaseAvoidance;
const intersectingPreview = preview({
  ...previewBody,
  status: 'intersects',
  candidates: [{ ...missionAvoidanceIntersects.candidates[0]!, safetyContextDigest: candidate.safetyContextDigest }],
});
const pendingPreview = preview({
  ...previewBody,
  status: 'insufficient',
  candidates: [],
  candidateCompleteness: { status: 'incomplete', count: 0, limit: 64, considered: 0, consideredLimit: 512 },
  reasons: ['mission_projection_pending'],
});
const releaseKey = 'fixture-mission-release-1';
const departureKey = 'fixture-mission-departure-1'; // gitleaks:allow (a fixture idempotency key, not a secret)
export const missionReleaseCases = {
  exactReplayAfterChange: {
    request: missionReleaseCommand,
    key: releaseKey,
    evaluatedAt: missionReleaseValidityChanged.evaluatedAt,
    validity: missionReleaseValidityChanged,
    currentPreview: changedPreview,
    currentSafetyContext: changedSafetyContext,
    status: 201,
    response: {
      ...missionReleaseCommandResponse,
      meta: {
        ...missionReleaseCommandResponse.meta,
        requestId: 'recovered-release-after-change',
        computedAt: missionReleaseValidityChanged.evaluatedAt,
      },
    },
    recordRead: missionReleaseRecordResponse,
  },
  exactReplayAfterExpiry: {
    request: missionReleaseCommand,
    key: releaseKey,
    evaluatedAt: missionReleaseValidityExpired.evaluatedAt,
    validity: missionReleaseValidityExpired,
    status: 201,
    response: {
      ...missionReleaseCommandResponse,
      meta: {
        ...missionReleaseCommandResponse.meta,
        requestId: 'recovered-release-after-expiry',
        computedAt: missionReleaseValidityExpired.evaluatedAt,
      },
    },
    recordRead: missionReleaseRecordResponse,
  },
  intersects: {
    request: { ...missionReleaseCommand, expectedContextDigest: intersectingPreview.contextDigest! },
    preview: intersectingPreview,
    status: 409,
    code: 'release_avoidance_intersection',
  },
  pending: { request: missionReleaseCommand, preview: pendingPreview, status: 409, code: 'release_evidence_pending' },
  higherFailedMission: {
    acceptedSourceRevision: 3,
    acceptedMissionProcessing: 'failed',
    validity: {
      ...missionReleaseValidityChanged,
      currentContextDigest: null,
      reasons: ['mission_changed'],
    } satisfies MissionReleaseValidityResponse,
  },
  windowOutsideMission: {
    request: {
      ...missionReleaseCommand,
      departureWindow: { ...missionReleaseCommand.departureWindow, start: '2026-10-15T14:04:59Z' },
    },
    status: 400,
    code: 'invalid_departure_window',
  },
  windowEmpty: {
    request: {
      ...missionReleaseCommand,
      departureWindow: {
        start: missionReleaseCommand.departureWindow.start,
        end: missionReleaseCommand.departureWindow.start,
      },
    },
    status: 400,
    code: 'invalid_departure_window',
  },
  expiredRetry: {
    request: missionDepartureAuthorization,
    key: departureKey,
    evaluatedAt: missionDeparturePermit.validUntil,
    priorResponse: missionDepartureAuthorizationResponse,
    status: 409,
    code: 'departure_permit_expired',
  },
  safetyChangedUnexpiredReplay: {
    request: missionDepartureAuthorization,
    key: departureKey,
    currentValidity: missionReleaseValidityChanged,
    currentPrincipalRevision: actor.principalRevision + 1,
    status: 201,
    response: {
      ...missionDepartureAuthorizationResponse,
      authorization: {
        ...missionDepartureAuthorizationResponse.authorization,
        evaluatedAt: '2026-10-15T14:16:10Z',
        disposition: 'replayed',
      },
      meta: {
        ...actionMeta(missionDeparturePermit.id, '2026-10-15T14:16:10Z'),
        inputCut: { ...cut, principalRevision: actor.principalRevision + 1 },
        dependencyBasis: canonicalDigest({ ...basisManifest, principalRevision: actor.principalRevision + 1 }),
      },
    } satisfies MissionDepartureAuthorizationResponse,
  },
  secondAuthorizationSameFlight: {
    request: {
      ...missionDepartureAuthorization,
      departureAttemptId: 'replacement-departure-attempt',
      allocation: {
        id: 'replacement-exclusive-pad-reservation',
        digest: canonicalDigest({
          ...missionDepartureAllocation,
          id: 'replacement-exclusive-pad-reservation',
          departureAttemptId: 'replacement-departure-attempt',
        }),
      },
    },
    key: 'fixture-mission-departure-second-authorization',
    evaluatedAt: '2026-10-15T14:16:31Z',
    status: 409,
    code: 'departure_flight_already_authorized',
  },
  unusedExpiredPermit: {
    permit: missionDeparturePermit,
    evaluatedAt: missionDeparturePermit.validUntil,
    consumed: false,
    outcome: 'held',
    replacementSupported: false,
  },
  operationPrecheck: {
    evaluatedAt: missionDeparturePermit.authorizedAt,
    missionEnd: missionRevision2Record.operatingInterval.end,
    remainingDurationMs: 180000,
    holdAllowanceMs: 10000,
    marginMs: 10000,
    leaseHandoffAllowanceMs: 30000,
    requiredCompletionAt: '2026-10-15T14:19:50Z',
  },
  insufficientRemainingFit: {
    evaluatedAt: missionDeparturePermit.authorizedAt,
    missionEnd: missionRevision2Record.operatingInterval.end,
    remainingDurationMs: 240000,
    holdAllowanceMs: 10000,
    marginMs: 10000,
    leaseHandoffAllowanceMs: 30000,
    requiredCompletionAt: '2026-10-15T14:20:50Z',
    sent: false,
    outcome: 'held',
    nextAction: 'replan_and_release_before_authorization',
  },
  callerConsumption: {
    mission,
    aircraftId: missionDeparturePermit.aircraftId,
    route: missionRevision2Record.route,
    allocation: missionDepartureAllocation,
    fitWitness: missionDepartureFitWitness,
    oncePerFlight: { tenantId: missionDepartureAllocation.tenantId, flightId: missionDeparturePermit.flightId },
    atomicCommit: {
      retains: ['fit_witness', 'once_per_flight_consumption', 'physical_transition'],
      permit: missionDepartureFitWitness.permit,
      consumedAt: missionDepartureFitWitness.evaluatedAt,
      physicalTransition: { activity: 'airborne', departedAt: missionDepartureFitWitness.evaluatedAt },
    },
    restart: 'resume_same_transition_without_another_departure',
  },
  changedAllocation: {
    original: missionDepartureAuthorization,
    request: {
      ...missionDepartureAuthorization,
      allocation: {
        id: 'another-exclusive-pad-reservation',
        digest: canonicalDigest({ ...missionDepartureAllocation, id: 'another-exclusive-pad-reservation' }),
      },
    },
    key: 'fixture-mission-departure-other-reservation',
    status: 409,
    code: 'departure_attempt_conflict',
  },
  allocationReusedForNewAttempt: {
    original: missionDepartureAuthorization,
    request: { ...missionDepartureAuthorization, departureAttemptId: 'another-departure-attempt' },
    key: 'fixture-mission-departure-other-attempt',
    status: 409,
    code: 'departure_allocation_conflict',
  },
  expiryBounds: [
    {
      authorizedAt: '2026-10-15T14:16:00Z',
      releaseEnd: '2026-10-15T14:19:00Z',
      selectionBoundary: '2026-10-15T14:20:00Z',
      validUntil: '2026-10-15T14:16:30Z',
    },
    {
      authorizedAt: '2026-10-15T14:18:45Z',
      releaseEnd: '2026-10-15T14:19:00Z',
      selectionBoundary: '2026-10-15T14:20:00Z',
      validUntil: '2026-10-15T14:19:00Z',
    },
    {
      authorizedAt: '2026-10-15T14:16:00Z',
      releaseEnd: '2026-10-15T14:19:00Z',
      selectionBoundary: '2026-10-15T14:16:10Z',
      validUntil: '2026-10-15T14:16:10Z',
    },
  ],
};
