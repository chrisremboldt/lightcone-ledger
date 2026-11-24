import { Type, type Static } from '@sinclair/typebox';
import type { ResponseMeta } from './index.js';
import { InputCutSchema } from './input-cut.js';
import { SubjectBasisManifestSchema } from './subject-decisions.js';
import { MissionRevisionRecordSchema } from './missions.js';
import {
  MISSION_AVOIDANCE_CANDIDATE_LIMIT,
  MISSION_AVOIDANCE_CONSIDERED_LIMIT,
  MissionAvoidanceCalculationSchema,
  MissionAvoidanceMissionReferenceSchema,
  MissionAvoidanceNotApplicableSchema,
  MissionAvoidancePreviewSchema,
  MissionAvoidanceReviewedCandidateSchema,
} from './mission-avoidance.js';
import { ControlApplicabilityMeasureSchema, ControlApplicabilityRecordSchema } from './control-applicability.js';
import {
  CheckDetailsSchema,
  EvaluationSummaryWordingSchema,
  evaluationOutcomeValues,
  evidenceStateValues,
  EvaluationReliefSchema,
  RelatedSubjectSchema,
  SubjectReferenceSchema,
} from './rule-evaluations.js';

export const MISSION_RELEASE_MAX_RECORD_BYTES = 4 * 1024 * 1024;
const Closed = { additionalProperties: false };
const Id = Type.String({ minLength: 1, maxLength: 200 });
const Digest = Type.String({ pattern: '^[a-f0-9]{64}$' });
const Revision = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const Time = Type.String({
  format: 'date-time',
  pattern: '^(?!0000)\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:[0-5]\\d(?:\\.\\d{1,3})?Z$',
});
const Reference = Type.Object({ id: Id, digest: Digest }, Closed);
const Reasons = Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 32, uniqueItems: true });
const Note = Type.String({ minLength: 1, maxLength: 4000 });
const CalculationReference = Type.Pick(MissionAvoidanceCalculationSchema, ['id', 'version', 'digest']);

export const MissionReleaseWindowSchema = Type.Object(
  { start: Time, end: Time },
  {
    ...Closed,
    description:
      'Finite half-open departure window [start,end), wholly within the exact mission operating interval. The server checks start < end and end > database commit time; acceptance may precede start.',
  },
);
export const MissionReleasePolicyReferenceSchema = Type.Object(
  {
    id: Type.Literal('ledger.demo.route-avoidance-release'),
    version: Type.Literal(2),
    digest: Digest,
  },
  { ...Closed, description: 'The registered release policy version.' },
);
const PolicyId = MissionReleasePolicyReferenceSchema.properties.id;
const PolicyAvoidance = {
  status: Type.Literal('draft'),
  scope: Type.Literal('recorded_route_avoidance'),
  clock: Type.Literal('wall'),
  mission: Type.Literal('exact_accepted_and_projected_revision'),
  aircraft: Type.Literal('exact_current_assignment'),
  avoidance: Type.Literal('applicable_outside_complete_current'),
  applicability: Type.Literal('considered_controls_recorded'),
  window: Type.Literal('finite_half_open_subset_of_mission'),
  comparison: Type.Literal('mission_aircraft_policy_and_safety_context'),
  validity: Type.Literal('as_of_read_only'),
  departure: Type.Literal('separate_authorization_after_allocation'),
};
export const MissionReleasePolicySchema = Type.Object(
  {
    id: PolicyId,
    version: Type.Literal(2),
    digest: Digest,
    title: Type.Literal('Recorded route avoidance release with open findings and control applicability'),
    ...PolicyAvoidance,
    findings: Type.Literal('open_active_findings_listed_and_attested'),
    instruction: Type.String({ minLength: 1, maxLength: 4000 }),
  },
  {
    ...Closed,
    description:
      'Route avoidance for the considered controls that apply, with an applicability record for each one that does not, plus the open findings from active rule adoptions, pinned by digest. Digest commits the complete policy object excluding digest.',
  },
);
export type MissionReleasePolicy = Static<typeof MissionReleasePolicySchema>;

export const MissionReleaseCommandSchema = Type.Object(
  {
    kind: Type.Literal('mission.release'),
    flightId: Id,
    aircraftId: Id,
    mission: MissionAvoidanceMissionReferenceSchema,
    calculation: CalculationReference,
    policy: MissionReleasePolicyReferenceSchema,
    expectedContextDigest: Digest,
    expectedFindingsDigest: Type.Optional(
      Type.String({
        pattern: '^[a-f0-9]{64}$',
        description: 'Required: the digest of the open findings displayed for this flight. A changed list conflicts.',
      }),
    ),
    expectedPrincipalRevision: Revision,
    departureWindow: MissionReleaseWindowSchema,
    note: Note,
  },
  {
    ...Closed,
    description:
      'Record the exact displayed mission and narrow safety context under flight, authority and register guards. A preview is not permission. Generic telemetry-sensitive flight revisions do not gate this command. Exact original-key retries recover the immutable acceptance even after expiry or context change.',
  },
);
export type MissionReleaseCommand = Static<typeof MissionReleaseCommandSchema>;
export const MissionReleaseAcceptedCommandSchema = Type.Object(
  {
    id: Id,
    kind: Type.Literal('mission.release'),
    flightId: Id,
    actorId: Id,
    recordedAt: Time,
    payload: Type.Record(Type.String(), Type.Unknown()),
  },
  Closed,
);
export interface MissionReleaseCommandResponse {
  command: Static<typeof MissionReleaseAcceptedCommandSchema>;
  meta: ResponseMeta;
}

const ActorFields = {
  id: Id,
  name: Type.String(),
  kind: Type.String(),
  active: Type.Literal(true),
  principalRevision: Revision,
  capabilities: Type.Array(Type.String()),
  commandLinkSources: Type.Array(Id),
  missionSources: Type.Array(Id),
  checkedCapabilities: Type.Tuple([
    Type.Literal('decision:write'),
    Type.Literal('flight:read'),
    Type.Literal('mission:release'),
  ]),
  scope: Type.Object({ kind: Type.Literal('flight'), id: Id }, Closed),
};
export const MissionReleaseActorSchema = Type.Object(
  { ...ActorFields, policyVersion: Type.Literal('ledger.mission-release-authority.1') },
  Closed,
);
export const MissionReleaseAvoidanceSchema = Type.Object(
  {
    ...MissionAvoidancePreviewSchema.properties,
    status: Type.Literal('outside'),
    mission: MissionAvoidanceMissionReferenceSchema,
    candidates: Type.Array(
      Type.Object(
        {
          ...MissionAvoidanceReviewedCandidateSchema.properties,
          geometry: Type.Literal('outside'),
          context: Type.Literal('current'),
          authority: MissionAvoidanceReviewedCandidateSchema.properties.authority.anyOf[0],
          reasons: Type.Array(Type.String(), { maxItems: 0 }),
          applicability: Type.Object(
            { ...ControlApplicabilityRecordSchema.properties, outcome: Type.Literal('applies') },
            Closed,
          ),
        },
        Closed,
      ),
      { maxItems: MISSION_AVOIDANCE_CANDIDATE_LIMIT },
    ),
    notApplicable: Type.Array(
      Type.Object(
        {
          ...MissionAvoidanceNotApplicableSchema.properties,
          context: Type.Literal('current'),
          authority: MissionAvoidanceNotApplicableSchema.properties.authority.anyOf[0],
          reasons: Type.Array(Type.String(), { maxItems: 0 }),
          applicability: Type.Object(
            {
              ...ControlApplicabilityRecordSchema.properties,
              outcome: Type.Literal('does_not_apply'),
              basis: Type.Literal('rule'),
            },
            Closed,
          ),
        },
        Closed,
      ),
      { maxItems: MISSION_AVOIDANCE_CONSIDERED_LIMIT },
    ),
    candidateCompleteness: Type.Object(
      {
        status: Type.Literal('complete'),
        count: Type.Integer({ minimum: 0, maximum: MISSION_AVOIDANCE_CANDIDATE_LIMIT }),
        limit: Type.Literal(MISSION_AVOIDANCE_CANDIDATE_LIMIT),
        considered: Type.Integer({ minimum: 0, maximum: MISSION_AVOIDANCE_CONSIDERED_LIMIT }),
        consideredLimit: Type.Literal(MISSION_AVOIDANCE_CONSIDERED_LIMIT),
      },
      Closed,
    ),
    contextDigest: Digest,
    reasons: Type.Array(Type.String(), { maxItems: 0 }),
  },
  Closed,
);
export type MissionReleaseAvoidance = Static<typeof MissionReleaseAvoidanceSchema>;

export const MissionReleaseControlRecordContextSchema = Type.Object(
  {
    version: Type.Literal('mission.avoidance-control-record-context.1'),
    assessment: Type.Object({ id: Id, acceptedRevision: Revision, digest: Digest }, Closed),
    hazard: Type.Object({ id: Id, latestAcceptanceId: Id }, Closed),
    control: Type.Object({ recordId: Id, versionNumber: Revision, status: Id }, Closed),
  },
  {
    ...Closed,
    description:
      'Retained preimage of one candidate safetyContextDigest at release acceptance, for an area control record accepted on a safety-record hazard: the hazard current assessment and acceptance and the control record current version and status.',
  },
);
export type MissionReleaseControlRecordContext = Static<typeof MissionReleaseControlRecordContextSchema>;
export const MISSION_RELEASE_FINDING_LIMIT = 200;
export const MISSION_RELEASE_FINDING_SUBJECT_LIMIT = 200;
export const missionReleaseFindingStatusValues = ['open', 'acknowledged', 'responding'] as const;
export const MissionReleaseFindingSchema = Type.Object(
  {
    id: Id,
    subject: SubjectReferenceSchema,
    subjectKey: Type.String({ minLength: 1, maxLength: 1000 }),
    related: Type.Optional(RelatedSubjectSchema),
    status: Type.Union(missionReleaseFindingStatusValues.map((status) => Type.Literal(status))),
    rule: Type.Object({ packId: Id, id: Id, version: Revision, title: Id }, Closed),
    answer: Type.Object(
      {
        outcome: Type.Union(evaluationOutcomeValues.map((value) => Type.Literal(value))),
        evidenceState: Type.Union(evidenceStateValues.map((value) => Type.Literal(value))),
        summary: Type.String({ minLength: 1, maxLength: 2000 }),
      },
      Closed,
    ),
    evaluation: Type.Object({ id: Id, digest: Digest, recordedAt: Time }, Closed),
  },
  {
    ...Closed,
    description:
      'One finding not yet resolved, with its rule’s title and the current answer of the evaluation it is pinned to. evaluation.digest is canonicalDigest of that evaluation record.',
  },
);
export type MissionReleaseFinding = Static<typeof MissionReleaseFindingSchema>;
export const MissionReleaseFindingSubjectSchema = Type.Object(
  {
    subject: SubjectReferenceSchema,
    subjectKey: Type.String({ minLength: 1, maxLength: 1000 }),
    reason: Type.Union([Type.Literal('flight'), Type.Literal('organization'), Type.Literal('named')]),
  },
  {
    ...Closed,
    description: 'A subject whose findings were read: the flight, its organization, or a subject its records name.',
  },
);
export type MissionReleaseFindingSubject = Static<typeof MissionReleaseFindingSubjectSchema>;
export const MissionReleaseFindingsSchema = Type.Object(
  {
    version: Type.Literal('mission.release-findings.1'),
    subjects: Type.Array(MissionReleaseFindingSubjectSchema, { maxItems: MISSION_RELEASE_FINDING_SUBJECT_LIMIT }),
    findings: Type.Array(MissionReleaseFindingSchema, { maxItems: MISSION_RELEASE_FINDING_LIMIT }),
    digest: Digest,
  },
  {
    ...Closed,
    description:
      'The open findings from active rule adoptions about the flight, its organization and the subjects its records name, ordered by subject key and finding id. digest is canonicalDigest of the object without digest. Listing a finding issues no verdict and blocks nothing; the person releasing attests having seen them.',
  },
);
export type MissionReleaseFindings = Static<typeof MissionReleaseFindingsSchema>;
export const MissionReleaseRelievedRuleSchema = Type.Object(
  {
    subject: SubjectReferenceSchema,
    subjectKey: Type.String({ minLength: 1, maxLength: 1000 }),
    related: Type.Optional(RelatedSubjectSchema),
    rule: Type.Object({ packId: Id, id: Id, version: Revision, title: Id }, Closed),
    relief: EvaluationReliefSchema,
    statement: Type.String({ minLength: 1, maxLength: 3000 }),
    evaluation: Type.Object({ id: Id, digest: Digest, recordedAt: Time }, Closed),
  },
  {
    ...Closed,
    description:
      'A rule whose latest evaluation about one of the release’s subjects is relieved by an active waiver adoption: who granted it by adopting the waiver, the provision, and what the rule would otherwise have reported. statement is the plain words for it.',
  },
);
export type MissionReleaseRelievedRule = Static<typeof MissionReleaseRelievedRuleSchema>;
export const MissionReleaseFindingsResponseSchema = Type.Object(
  {
    flightId: Id,
    readAt: Time,
    basis: MissionReleaseFindingsSchema,
    proposed: Type.Array(MissionReleaseFindingSchema, { maxItems: MISSION_RELEASE_FINDING_LIMIT }),
    proposedComplete: Type.Boolean(),
    relieved: Type.Optional(
      Type.Array(MissionReleaseRelievedRuleSchema, {
        maxItems: MISSION_RELEASE_FINDING_LIMIT,
        description: 'Always returned by this server; absent in responses recorded before relief existed.',
      }),
    ),
    relievedComplete: Type.Optional(Type.Boolean()),
    summaryWording: Type.Optional(EvaluationSummaryWordingSchema),
    summaryDetails: Type.Optional(
      Type.Record(Type.String(), CheckDetailsSchema, {
        description:
          'For display only, beside the findings and never in the basis or its digest: the recorded details of each evaluation summaryWording names, with the recorded next boundary or evidence times its wording names, by evaluation id, so a screen can fill the wording again.',
      }),
    ),
  },
  {
    ...Closed,
    description:
      'basis is what a release records and its command pins by digest. proposed lists open findings from rules adopted in shadow: recorded, not counted, never in the basis. relieved lists rules an active waiver adoption relieves for these subjects: not counted, never in the basis.',
  },
);
export type MissionReleaseFindingsResponse = Static<typeof MissionReleaseFindingsResponseSchema>;

const ControlRecordContextEntry = Type.Object(
  {
    controlEventId: Id,
    acceptanceId: Id,
    context: MissionReleaseControlRecordContextSchema,
  },
  Closed,
);
const ReleaseBasisFields = {
  mission: MissionRevisionRecordSchema,
  avoidance: MissionReleaseAvoidanceSchema,
  candidateContexts: Type.Array(ControlRecordContextEntry, { maxItems: MISSION_AVOIDANCE_CANDIDATE_LIMIT }),
  notApplicableContexts: Type.Array(ControlRecordContextEntry, {
    maxItems: MISSION_AVOIDANCE_CONSIDERED_LIMIT,
    description: 'The safety context preimage of each avoidance.notApplicable entry, in the same order.',
  }),
  renderedInputCut: InputCutSchema,
  acceptedInputCut: InputCutSchema,
  basisManifest: SubjectBasisManifestSchema,
};
const ReleaseRecordFields = {
  id: Id,
  flightId: Id,
  organizationId: Id,
  aircraftId: Id,
  acceptedRevision: Revision,
  recordedAt: Time,
  actor: MissionReleaseActorSchema,
  departureWindow: MissionReleaseWindowSchema,
  note: Note,
};
export const MissionReleaseRecordSchema = Type.Object(
  {
    version: Type.Literal('flight.mission-release.2'),
    ...ReleaseRecordFields,
    policy: MissionReleasePolicySchema,
    basis: Type.Object({ ...ReleaseBasisFields, findings: MissionReleaseFindingsSchema }, Closed),
  },
  {
    ...Closed,
    description:
      'Immutable route-avoidance release acceptance, separate from risk acceptance, notes, briefing and control implementation. Exact candidate references and safety preimages are retained, and each considered control that does not apply is retained with its applicability record and safety preimage; generic cuts describe acceptance provenance and do not define current validity. It lists the open findings the person releasing attested having seen. A listed finding is not a verdict and blocks nothing.',
  },
);
export type MissionReleaseRecord = Static<typeof MissionReleaseRecordSchema>;
export const FlightMissionReleaseParamsSchema = Type.Object({ id: Id, releaseId: Id }, Closed);
export const FlightMissionReleaseFindingsParamsSchema = Type.Object({ id: Id }, Closed);
export type FlightMissionReleaseFindingsParams = Static<typeof FlightMissionReleaseFindingsParamsSchema>;
export type FlightMissionReleaseParams = Static<typeof FlightMissionReleaseParamsSchema>;
export const MissionReleaseRecordResponseSchema = Type.Object(
  { release: MissionReleaseRecordSchema, digest: Digest },
  { ...Closed, description: 'Exact immutable record; digest is canonicalDigest(release). No current permission.' },
);
export type MissionReleaseRecordResponse = Static<typeof MissionReleaseRecordResponseSchema>;
export const MissionReleaseValidityResponseSchema = Type.Object(
  {
    release: Reference,
    evaluatedAt: Time,
    status: Type.Union(
      (['scheduled', 'current', 'expired', 'changed', 'pending'] as const).map((status) => Type.Literal(status)),
    ),
    processing: Type.Union(
      (['pending', 'processing', 'completed', 'failed'] as const).map((status) => Type.Literal(status)),
    ),
    currentContextDigest: Type.Union([Digest, Type.Null()]),
    nextBoundary: Type.Union([Time, Type.Null()]),
    reasons: Reasons,
  },
  {
    ...Closed,
    description:
      'As-of information only; GET must never trigger departure. Precedence: expired at window end; changed for known mission, aircraft, policy or safety-context mismatch; pending when matching validity cannot be established; then scheduled before window start or current within it. Higher accepted mission/control changes block new authorizations before projection, including a higher failed mission. Matching failed or unsupported evidence cannot establish current validity. nextBoundary is a recheck time, not a guaranteed validity lease. A separately issued finite departure lease retains its original authorization point.',
  },
);
export type MissionReleaseValidityResponse = Static<typeof MissionReleaseValidityResponseSchema>;

export const MissionDeparturePolicySchema = Type.Object(
  {
    id: Type.Literal('ledger.demo.route-avoidance-departure'),
    version: Type.Literal(1),
    digest: Digest,
    clock: Type.Literal('wall'),
    permitSeconds: Type.Literal(30),
    authorization: Type.Literal('finite_lease_at_authorized_at'),
    replay: Type.Literal('same_original_unexpired_lease'),
    renewal: Type.Literal('unsupported'),
    uniqueness: Type.Literal('tenant_flight_and_attempt_and_allocation'),
    operationFit: Type.Literal('producer_checks_before_authorization_and_at_consumption'),
    expiry: Type.Literal('earliest_of_30_seconds_release_end_or_selection_boundary'),
    instruction: Type.String({ minLength: 1, maxLength: 4000 }),
  },
  { ...Closed, description: 'Finite departure authorization policy. Digest commits the full object excluding digest.' },
);
export type MissionDeparturePolicy = Static<typeof MissionDeparturePolicySchema>;
export const MissionDepartureAuthorizationCommandSchema = Type.Object(
  {
    kind: Type.Literal('mission.departure-authorize'),
    flightId: Id,
    aircraftId: Id,
    release: Reference,
    departureAttemptId: Id,
    allocation: Reference,
    expectedPrincipalRevision: Revision,
    expectedControlsDigest: Type.Optional(
      Type.String({
        pattern: '^[a-f0-9]{64}$',
        description:
          'The digest of the controls in scope the authorizer saw (GET /v1/flights/{id}/controls). Required while any control is in scope for the flight: without it the authorization is refused (409 flight_controls_not_seen). When sent, the authorization conflicts if the list changed (409 flight_controls_changed) and its issuance basis pins the list. With no control in scope it may be left out, and the issuance basis pins the empty list.',
      }),
    ),
  },
  {
    ...Closed,
    description:
      'Final authorization after the caller retains a live exclusive allocation and establishes full remaining operation fit. On first issuance, atomically validate the exact release and current authority, including expectedPrincipalRevision, and grant one nonrenewable lease per tenant/Ledger flight. Retain fixed attempt/allocation bindings; tenant/allocation identity binds one flight and attempt. Exact original-key retries recover the same unexpired lease without a new safety-context or principal-revision comparison; current authentication and scope checks remain. Later accepted safety changes do not revoke the issued lease. Expired restart replay fails; no key, attempt or allocation can obtain another authorization for this flight. Allocation and operation fit are producer commitments, not Ledger resource or aircraft-performance certification.',
  },
);
export type MissionDepartureAuthorizationCommand = Static<typeof MissionDepartureAuthorizationCommandSchema>;
export const MissionDeparturePermitSchema = Type.Object(
  {
    version: Type.Literal('flight.mission-departure-permit.1'),
    id: Id,
    flightId: Id,
    aircraftId: Id,
    release: Reference,
    mission: MissionAvoidanceMissionReferenceSchema,
    contextDigest: Digest,
    departureAttemptId: Id,
    allocation: Reference,
    authorizedAt: Time,
    validUntil: Time,
    policy: MissionDeparturePolicySchema,
    actor: Type.Object({ ...ActorFields, policyVersion: Type.Literal('ledger.mission-departure-authority.1') }, Closed),
  },
  {
    ...Closed,
    description:
      'One nonrenewable authorization lease per tenant/Ledger flight during [authorizedAt,validUntil), based on atomic eligibility at authorizedAt. validUntil is the earliest of 30 seconds after authorizedAt, the release departure window end and the next instant at which one of the organization’s accepted controls starts or stops being in force (the policy’s selection boundary). Later safety changes affect subsequent authorizations, not this issued lease. Consume only the exact pinned mission/aircraft/route with the original live exclusive allocation. Atomically retain a fresh fit witness and once-per-flight consumption with the physical transition across restart. An unused expired lease leaves the flight held or abandoned; replacement requires a later explicit protocol or new Ledger flight. No continuous post-takeoff validity or control claim beyond the mission interval is implied.',
  },
);
export type MissionDeparturePermit = Static<typeof MissionDeparturePermitSchema>;
export const MissionDepartureFitWitnessSchema = Type.Object(
  {
    version: Type.Literal('mission.departure-fit.1'),
    permit: Reference,
    mission: MissionAvoidanceMissionReferenceSchema,
    aircraftId: Id,
    evaluatedAt: Time,
    remainingDurationMs: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    holdAllowanceMs: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    marginMs: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    requiredCompletionAt: Time,
  },
  {
    ...Closed,
    description:
      'Caller-retained consume-time commitment, not a second API. The exact mission record digest pins the route. Use checked safe-integer duration arithmetic: requiredCompletionAt equals evaluatedAt plus the full remaining operation, all known holds and margin, and must be at most the pinned mission interval end. The clock must be within the original permit, mission and live allocation intervals. Before requesting authorization, establish conservative fit including lease handoff delay; recompute immediately at consumption and retain this witness atomically with once-per-flight consumption and the physical transition. Unknown or unbounded duration/holds, missing exact plan, lost allocation or insufficient interval means stay held. A fit failure before authorization may be resolved by explicit replan/release before requesting authorization. After issuance, any fit, plan or allocation failure leaves the flight held or abandoned; this profile allows no replacement authorization for that Ledger flight. Never substitute a revised route under an old lease.',
  },
);
export type MissionDepartureFitWitness = Static<typeof MissionDepartureFitWitnessSchema>;
export const MissionDepartureAuthorizationResultSchema = Type.Object(
  {
    permit: MissionDeparturePermitSchema,
    digest: Digest,
    evaluatedAt: Time,
    disposition: Type.Union([Type.Literal('issued'), Type.Literal('replayed')]),
  },
  {
    ...Closed,
    description:
      'Issued lease or exact recovery before its original expiry. Fresh evaluatedAt/disposition describe the response without changing the original authority, basis, permit or expiry. Recovery does not revalidate later safety context or authorize another departure; historical responses cannot be consumed after expiry.',
  },
);
export type MissionDepartureAuthorizationResult = Static<typeof MissionDepartureAuthorizationResultSchema>;
export const MissionDepartureAcceptedCommandSchema = Type.Object(
  {
    ...MissionReleaseAcceptedCommandSchema.properties,
    kind: Type.Literal('mission.departure-authorize'),
  },
  Closed,
);
export interface MissionDepartureAuthorizationResponse {
  command: Static<typeof MissionDepartureAcceptedCommandSchema>;
  authorization: MissionDepartureAuthorizationResult;
  meta: ResponseMeta;
}

export const FLIGHT_CONTROL_LIMIT = 200;
export const flightControlCheckValues = ['rule', 'route_review', 'person'] as const;
export const flightControlPeriodValues = ['upcoming', 'current', 'ended'] as const;
export const flightControlResultValues = [
  'pass',
  'attention',
  'insufficient',
  'not_applicable',
  'needs_confirmation',
] as const;
export const FlightControlApplicabilitySchema = Type.Object(
  {
    outcome: ControlApplicabilityRecordSchema.properties.outcome,
    basis: ControlApplicabilityRecordSchema.properties.basis,
    measured: Type.Array(ControlApplicabilityMeasureSchema, { maxItems: 16 }),
    digest: Digest,
  },
  {
    ...Closed,
    description:
      'What route review recorded about whether this control applies to the flight: the outcome, its basis and what was measured. digest is canonicalDigest of the full applicability record, whose inputs are the list’s mission and this control version. The rule that decided it is the one the control’s pinned type declares, which the type’s digest commits, and what the control declares is in its parameters, so neither is repeated here.',
  },
);
export const FlightControlResultSchema = Type.Object(
  {
    result: Type.Union(flightControlResultValues.map((value) => Type.Literal(value))),
    summary: Type.String({ minLength: 1, maxLength: 2000 }),
    subject: Type.Optional(SubjectReferenceSchema),
    subjectKey: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
    rule: Type.Optional(
      Type.Object({ packId: Id, packVersion: Revision, id: Id, version: Revision, digest: Digest }, Closed),
    ),
    evaluation: Type.Optional(Type.Object({ id: Id, digest: Digest, recordedAt: Time }, Closed)),
    applicability: Type.Optional(FlightControlApplicabilitySchema),
  },
  {
    ...Closed,
    description:
      'The current result of one control for one subject. insufficient: the evidence does not settle it, or the control’s current version has not been evaluated yet. needs_confirmation: nothing checks it automatically; a person confirms it. not_applicable: the control is not in effect for the flight, or its applicability rule found it does not apply, with the recorded sentence as summary. A result is never a verdict and blocks nothing. evaluation.digest is canonicalDigest of the evaluation record.',
  },
);
export type FlightControlResult = Static<typeof FlightControlResultSchema>;
export const FlightControlSchema = Type.Object(
  {
    hazard: Type.Object({ id: Id, title: Type.String({ minLength: 1, maxLength: 400 }) }, Closed),
    control: Type.Object(
      {
        id: Id,
        versionNumber: Revision,
        bodyDigest: Digest,
        title: Type.String({ minLength: 1, maxLength: 400 }),
        type: Type.Object(
          { id: Id, version: Revision, digest: Digest, title: Type.Union([Type.String(), Type.Null()]) },
          Closed,
        ),
        description: Type.String({ minLength: 1, maxLength: 4000 }),
        effectiveFrom: Time,
        effectiveUntil: Type.Union([Time, Type.Null()]),
        period: Type.Union(
          flightControlPeriodValues.map((value) => Type.Literal(value)),
          {
            description:
              'Where the read falls in the control’s effective interval. upcoming: it takes effect at effectiveFrom and is not evaluated before then. ended: its interval ended at effectiveUntil and it is no longer evaluated. Only a current control has results from its check.',
          },
        ),
      },
      Closed,
    ),
    check: Type.Union(
      flightControlCheckValues.map((value) => Type.Literal(value)),
      {
        description:
          'rule: the organization’s rule from this accepted control, run by the evaluator. route_review: route review keeps the planned route clear of its area. person: a person confirms it.',
      },
    ),
    results: Type.Array(FlightControlResultSchema, { minItems: 1, maxItems: MISSION_RELEASE_FINDING_SUBJECT_LIMIT }),
  },
  {
    ...Closed,
    description:
      'One accepted control version in scope for the flight, in its own words: in force now, or accepted to take effect later, or with an interval that has ended.',
  },
);
export type FlightControl = Static<typeof FlightControlSchema>;
const FlightControlsMission = Type.Union([MissionAvoidanceMissionReferenceSchema, Type.Null()], {
  description:
    'The exact mission revision route review read for this list, which every applicability record in it was evaluated against; null when no listed control needed route review.',
});
/**
 * A control route review recorded as not applying to the flight, compactly: what identifies it, its title, its
 * applicability and the recorded sentence. Its wording and parameters are in the control version its digest names.
 */
export const FlightControlNotApplicableSchema = Type.Object(
  {
    hazardId: Id,
    control: Type.Object(
      { id: Id, versionNumber: Revision, bodyDigest: Digest, title: Type.String({ minLength: 1, maxLength: 400 }) },
      Closed,
    ),
    applicability: FlightControlApplicabilitySchema,
    summary: Type.String({ minLength: 1, maxLength: 500 }),
  },
  {
    ...Closed,
    description:
      'One accepted control in force that route review recorded as not applying to the flight, with what was measured and the recorded sentence. It needs no briefing.',
  },
);
export type FlightControlNotApplicable = Static<typeof FlightControlNotApplicableSchema>;
const NotApplicableControls = Type.Array(FlightControlNotApplicableSchema, {
  maxItems: MISSION_AVOIDANCE_CONSIDERED_LIMIT,
  description:
    'The controls route review recorded as not applying, at most as many as one review considers; they are not repeated in controls.',
});
export const FlightControlsSeenSchema = Type.Object(
  {
    version: Type.Literal('flight.controls-seen.1'),
    controls: Type.Array(FlightControlSchema, { maxItems: FLIGHT_CONTROL_LIMIT }),
    notApplicable: NotApplicableControls,
    complete: Type.Boolean(),
    mission: FlightControlsMission,
    digest: Digest,
  },
  {
    ...Closed,
    description:
      'The controls in scope for a flight as a person saw them: each control version, its wording and its result at that moment, with the mission revision route review read. digest is canonicalDigest of {version, controls, notApplicable, complete, mission}. A briefing or departure record that carries it pins this list; it is never a verdict and blocks nothing.',
  },
);
export type FlightControlsSeen = Static<typeof FlightControlsSeenSchema>;
export const FlightControlsResponseSchema = Type.Object(
  {
    flightId: Id,
    readAt: Time,
    controls: Type.Array(FlightControlSchema, { maxItems: FLIGHT_CONTROL_LIMIT }),
    notApplicable: NotApplicableControls,
    complete: Type.Boolean({
      description: 'False when more controls are in force than one read lists, in either part.',
    }),
    mission: FlightControlsMission,
    digest: Type.String({
      pattern: '^[a-f0-9]{64}$',
      description:
        'canonicalDigest of {version: "flight.controls-seen.1", controls, notApplicable, complete, mission}. A briefing or departure command sends it as expectedControlsDigest to pin this list; while the list is not empty the command requires it.',
    }),
    wording: Type.Optional(
      Type.Record(Type.String(), Type.String({ minLength: 1, maxLength: 4000 }), {
        description:
          'For display only, beside the list and never digested or pinned: each listed control version in the words its type gives a person, by body digest. description keeps the recorded wording.',
      }),
    ),
  },
  {
    ...Closed,
    description:
      'The accepted controls in force that are in scope for a flight, each with its current result. The subjects in scope are those a release reads findings about: the flight, its organization and the subjects its records name. Results of the organization’s rules are also ordinary findings, listed in the release basis.',
  },
);
export type FlightControlsResponse = Static<typeof FlightControlsResponseSchema>;
export const FlightControlsParamsSchema = Type.Object({ id: Id }, Closed);
export type FlightControlsParams = Static<typeof FlightControlsParamsSchema>;
