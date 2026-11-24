import { Type, type Static } from '@sinclair/typebox';
import type { ResponseMeta } from './index.js';
import { ControlApplicabilityRecordSchema } from './control-applicability.js';
import { MissionAvoidanceMissionReferenceSchema } from './mission-reference.js';

export { MissionAvoidanceMissionReferenceSchema, type MissionAvoidanceMissionReference } from './mission-reference.js';

/** At most this many considered controls may apply to one review: the controls a person must read and brief. */
export const MISSION_AVOIDANCE_CANDIDATE_LIMIT = 64;
/** At most this many accepted area controls are evaluated for one review; above it the review is incomplete. */
export const MISSION_AVOIDANCE_CONSIDERED_LIMIT = 512;
const Id = Type.String({ minLength: 1, maxLength: 200 });
const Revision = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const Digest = Type.String({ pattern: '^[a-f0-9]{64}$' });
const Time = Type.String({
  format: 'date-time',
  pattern: '^(?!0000)\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:[0-5]\\d(?:\\.\\d{1,3})?Z$',
});
const Reasons = Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 32, uniqueItems: true });
const RecordReference = Type.Object(
  { id: Id, acceptedRevision: Revision, digest: Digest },
  { additionalProperties: false },
);

export const FlightMissionAvoidanceParamsSchema = Type.Object({ id: Id }, { additionalProperties: false });
export type FlightMissionAvoidanceParams = Static<typeof FlightMissionAvoidanceParamsSchema>;

export const MissionAvoidanceCandidateSchema = Type.Object(
  {
    hazardId: Id,
    controlId: Id,
    controlVersion: Revision,
    controlEventId: Id,
    controlDigest: Digest,
    template: Type.Object({ id: Id, version: Revision, digest: Digest }, { additionalProperties: false }),
    acceptance: RecordReference,
    assessment: RecordReference,
    authority: Type.Union([
      Type.Object(
        {
          policyVersion: Type.Literal('ledger.sms-decision-authority.1'),
          principalId: Id,
          principalRevision: Revision,
          satisfyingCapability: Type.Union([
            Type.Literal('risk:accept:low'),
            Type.Literal('risk:accept:medium'),
            Type.Literal('risk:accept:high'),
          ]),
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    interval: Type.Object({ start: Time, end: Time }, { additionalProperties: false }),
    geometry: Type.Union([Type.Literal('outside'), Type.Literal('intersects'), Type.Literal('insufficient')]),
    context: Type.Union([
      Type.Literal('current'),
      Type.Literal('review_required'),
      Type.Literal('pending'),
      Type.Literal('unsupported'),
    ]),
    safetyContextDigest: Digest,
    reasons: Reasons,
  },
  {
    additionalProperties: false,
    description:
      'One exact risk-accepted area control version overlapping the planned mission interval: a control record whose type describes an area, accepted on a safety-record hazard of any origin. controlEventId is its version event, controlDigest its body digest, template its pinned control type, and an open-ended interval ends with the planned mission interval. Proposals alone are not candidates.',
  },
);
export type MissionAvoidanceCandidate = Static<typeof MissionAvoidanceCandidateSchema>;

const ApplicabilityFields = {
  applicability: ControlApplicabilityRecordSchema,
  applicabilityDigest: Type.String({
    pattern: '^[a-f0-9]{64}$',
    description: 'canonicalDigest of applicability.',
  }),
};
/** A considered control found to apply, with what the applicability evaluation recorded for it. */
export const MissionAvoidanceReviewedCandidateSchema = Type.Object(
  { ...MissionAvoidanceCandidateSchema.properties, ...ApplicabilityFields },
  {
    additionalProperties: false,
    description: `${MissionAvoidanceCandidateSchema.description} It applies to the flight: its applicability record says why, for the exact mission revision.`,
  },
);
export type MissionAvoidanceReviewedCandidate = Static<typeof MissionAvoidanceReviewedCandidateSchema>;
/**
 * A considered control whose applicability rule ran on complete inputs and found it does not apply to the flight. It
 * is not compared with the route and is not a candidate; it stays listed with what was measured.
 */
/** The area a control's pinned type describes for its accepted parameters: a circle in WGS84 degrees. */
export const MissionAvoidanceNotApplicableAreaSchema = Type.Object(
  {
    center: Type.Object(
      {
        latitude: Type.Number({ minimum: -90, maximum: 90 }),
        longitude: Type.Number({ minimum: -180, maximum: 180 }),
      },
      { additionalProperties: false },
    ),
    radiusMeters: Type.Number({ exclusiveMinimum: 0 }),
  },
  { additionalProperties: false },
);
export type MissionAvoidanceNotApplicableArea = Static<typeof MissionAvoidanceNotApplicableAreaSchema>;
export const MissionAvoidanceNotApplicableSchema = Type.Object(
  {
    ...Type.Omit(MissionAvoidanceCandidateSchema, ['geometry']).properties,
    title: Type.String({ minLength: 1, maxLength: 200, description: 'The control version’s title.' }),
    area: Type.Union([MissionAvoidanceNotApplicableAreaSchema, Type.Null()], {
      description:
        'The circle the pinned control type describes for the accepted parameters; null when the type describes none or it cannot be read here.',
    }),
    ...ApplicabilityFields,
  },
  {
    additionalProperties: false,
    description:
      'One considered accepted area control version that does not apply to the exact mission revision, by the applicability rule its pinned type declares, with its title and the area its type describes, so a reader needs no other read to list or place it. The applicability record holds what was measured, what the control declares and the rule by digest. It is not a candidate: route review does not compare it, the release does not need it outside and no briefing lists it.',
  },
);
export type MissionAvoidanceNotApplicable = Static<typeof MissionAvoidanceNotApplicableSchema>;
export const MissionAvoidanceConsideredTypeSchema = Type.Object(
  { id: Id, version: Revision, digest: Digest },
  { additionalProperties: false, description: 'A registered control type that describes an area, by digest.' },
);

export const MissionAvoidanceCalculationSchema = Type.Object(
  {
    id: Type.Literal('ledger.demo.mission-site-avoidance'),
    version: Type.Literal(1),
    digest: Digest,
    profile: Type.Literal('ledger.local-mission-avoidance.1'),
    geometry: Type.Literal('ledger.wgs84-conservative-bounds.1'),
    distanceBudget: Type.Literal(100000),
  },
  {
    additionalProperties: false,
    description:
      'Bounded local preview profile: at most 256 positions, absolute latitude at most 80 degrees, centerline upper bound at most 50 km and no antimeridian crossing. Control radius is at most 10000 metres and mission lateral tolerance at most 1000 metres. Unsupported or uncertain results remain insufficient.',
  },
);
export type MissionAvoidanceCalculation = Static<typeof MissionAvoidanceCalculationSchema>;

export const MissionAvoidancePreviewSchema = Type.Object(
  {
    version: Type.Literal('flight.mission-avoidance.1'),
    evaluatedAt: Time,
    status: Type.Union([Type.Literal('outside'), Type.Literal('intersects'), Type.Literal('insufficient')]),
    mission: Type.Union([MissionAvoidanceMissionReferenceSchema, Type.Null()]),
    candidates: Type.Array(MissionAvoidanceReviewedCandidateSchema, { maxItems: MISSION_AVOIDANCE_CANDIDATE_LIMIT }),
    notApplicable: Type.Array(MissionAvoidanceNotApplicableSchema, { maxItems: MISSION_AVOIDANCE_CONSIDERED_LIMIT }),
    consideredTypes: Type.Array(MissionAvoidanceConsideredTypeSchema, {
      maxItems: 32,
      description:
        'The registered control types read as describing an area: every accepted control of these is considered.',
    }),
    candidateCompleteness: Type.Object(
      {
        status: Type.Union([Type.Literal('complete'), Type.Literal('incomplete')]),
        count: Type.Integer({
          minimum: 0,
          maximum: Number.MAX_SAFE_INTEGER,
          description: 'How many considered controls apply. Above limit the review is incomplete.',
        }),
        limit: Type.Literal(MISSION_AVOIDANCE_CANDIDATE_LIMIT),
        considered: Type.Integer({
          minimum: 0,
          maximum: Number.MAX_SAFE_INTEGER,
          description:
            'How many accepted area controls overlap the operating interval and were evaluated; when complete, candidates plus notApplicable. Above consideredLimit the review is incomplete.',
        }),
        consideredLimit: Type.Literal(MISSION_AVOIDANCE_CONSIDERED_LIMIT),
      },
      { additionalProperties: false },
    ),
    calculation: MissionAvoidanceCalculationSchema,
    contextDigest: Type.Union([Digest, Type.Null()], {
      description:
        "Canonical digest of {version:'mission.avoidance-context.1',mission,calculation:{id,version,digest},candidates,notApplicable,consideredTypes,candidateCompleteness}, excluding clock and metadata. Null when the mission is missing or candidate selection incomplete.",
    }),
    previewDigest: Type.String({
      pattern: '^[a-f0-9]{64}$',
      description:
        'Canonical digest of the entire preview payload excluding previewDigest and meta, including evaluatedAt.',
    }),
    reasons: Reasons,
  },
  {
    additionalProperties: false,
    description:
      'A read-only mission comparison. Every risk-accepted area control version overlapping the mission interval is considered, at most 512; each is evaluated by the applicability rule its pinned type declares. Those that apply are candidates, at most 64, compared with the route; the rest are listed under notApplicable with their applicability records. This is not flight release, implementation, enforcement, risk reduction or evaluator activation.',
  },
);
export type MissionAvoidancePreview = Static<typeof MissionAvoidancePreviewSchema>;
export interface MissionAvoidanceResponse extends MissionAvoidancePreview {
  meta: ResponseMeta;
}
