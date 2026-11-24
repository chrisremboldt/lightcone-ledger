import { Type, type Static } from '@sinclair/typebox';
import {
  MISSION_AVOIDANCE_CANDIDATE_LIMIT,
  MissionAvoidanceCandidateSchema,
  MissionAvoidanceMissionReferenceSchema,
} from './mission-avoidance.js';
import {
  FlightControlsSeenSchema,
  MissionReleasePolicyReferenceSchema,
  MissionReleaseValidityResponseSchema,
} from './mission-release.js';

export const MISSION_BRIEFING_MAX_RECORD_BYTES = 1024 * 1024;
export const MISSION_BRIEFING_ACKNOWLEDGEMENT_MAX_RECORD_BYTES = 16 * 1024;
export const MISSION_BRIEFING_MAX_RECIPIENTS = 32;
export const MISSION_BRIEFING_ACKNOWLEDGEMENTS_MAX_READ_BYTES = 1024 * 1024;
/** One briefing lists at most as many controls as one route review has candidates. */
export const MISSION_BRIEFING_MAX_CONTROLS = MISSION_AVOIDANCE_CANDIDATE_LIMIT;

const Closed = { additionalProperties: false };
const Id = Type.String({ minLength: 1, maxLength: 200 });
const Digest = Type.String({ pattern: '^[a-f0-9]{64}$' });
const Revision = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const Time = Type.String({
  format: 'date-time',
  pattern: '^(?!0000)\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:[0-5]\\d(?:\\.\\d{1,3})?Z$',
});
const Reference = Type.Object({ id: Id, digest: Digest }, Closed);
const Purpose = Type.Literal('informational');
const Message = Type.String({ minLength: 1, maxLength: 4000 });
const Attestation = Type.Literal('reviewed_exact_briefing');
/** The center of an area a control describes. */
export const AreaControlCenterSchema = Type.Object(
  {
    latitude: Type.Number({ minimum: -90, maximum: 90 }),
    longitude: Type.Number({ minimum: -180, maximum: 180 }),
  },
  { additionalProperties: false, description: 'Operator-authored WGS84 circle center in degrees.' },
);
export type AreaControlCenter = Static<typeof AreaControlCenterSchema>;
export const MissionBriefingControlReferenceSchema = Type.Pick(MissionAvoidanceCandidateSchema, [
  'hazardId',
  'controlId',
  'controlVersion',
  'controlEventId',
  'controlDigest',
  'acceptance',
]);
export type MissionBriefingControlReference = Static<typeof MissionBriefingControlReferenceSchema>;
const ControlReference = MissionBriefingControlReferenceSchema;
const ControlReferences = Type.Array(ControlReference, { minItems: 1, maxItems: MISSION_BRIEFING_MAX_CONTROLS });
/**
 * The briefed content of an area control record accepted on a safety-record hazard: its pinned type with the title
 * and wording that type gives it, the record's parameters as retained and the area they describe.
 */
export const MissionBriefingControlRecordContentSchema = Type.Object(
  {
    controlType: Type.Object(
      { id: Id, version: Revision, digest: Digest, title: Type.String({ minLength: 1, maxLength: 120 }) },
      Closed,
    ),
    title: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.String({ minLength: 1, maxLength: 4000 }),
    parameters: Type.Record(Type.String(), Type.Unknown()),
    area: Type.Object(
      {
        center: AreaControlCenterSchema,
        radiusMeters: Type.Number({ exclusiveMinimum: 0, maximum: 10000 }),
        site: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      },
      Closed,
    ),
    effectiveFrom: Type.String({ format: 'date-time' }),
    effectiveUntil: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  },
  Closed,
);
export type MissionBriefingControlRecordContent = Static<typeof MissionBriefingControlRecordContentSchema>;
const ActorFields = {
  id: Id,
  name: Type.String(),
  kind: Type.String(),
  active: Type.Literal(true),
  principalRevision: Revision,
  capabilities: Type.Array(Type.String()),
  scope: Type.Object({ kind: Type.Literal('flight'), id: Id }, Closed),
};
const BriefingActor = Type.Object(
  {
    ...ActorFields,
    checkedCapabilities: Type.Tuple([Type.Literal('flight:read'), Type.Literal('briefing:write')]),
    policyVersion: Type.Literal('ledger.mission-briefing-authority.1'),
  },
  Closed,
);
const AcknowledgementActor = Type.Object(
  {
    ...ActorFields,
    kind: Type.Literal('human'),
    checkedCapabilities: Type.Tuple([Type.Literal('flight:read'), Type.Literal('briefing:ack')]),
    policyVersion: Type.Literal('ledger.mission-briefing-acknowledgement-authority.1'),
  },
  Closed,
);

export const MissionBriefingCommandSchema = Type.Object(
  {
    kind: Type.Literal('mission.brief'),
    flightId: Id,
    purpose: Purpose,
    release: Reference,
    controls: Type.Array(ControlReference, {
      minItems: 1,
      maxItems: MISSION_BRIEFING_MAX_CONTROLS,
      description:
        'The exact accepted control candidates this briefing covers, each once, in the order the release lists its candidates. A command naming one `control` instead is refused (400 briefing_controls_required).',
    }),
    recipientPrincipalIds: Type.Array(Id, {
      minItems: 1,
      maxItems: MISSION_BRIEFING_MAX_RECIPIENTS,
      uniqueItems: true,
    }),
    message: Message,
    expectedPrincipalRevision: Revision,
    expectedControlsDigest: Type.Optional(
      Type.String({
        pattern: '^[a-f0-9]{64}$',
        description:
          'The digest of the controls in scope the author saw (GET /v1/flights/{id}/controls). Required while any control is in scope for the flight: without it the briefing is refused (409 flight_controls_not_seen). When sent, the briefing conflicts if the list changed (409 flight_controls_changed) and pins the list. With no control in scope it may be left out, and the briefing pins no list.',
      }),
    ),
  },
  {
    ...Closed,
    description:
      'One informational briefing for one or more exact accepted control candidates in a scheduled/current completed release. Check author revision/capabilities, exact release validity and resolved active recipients through commit. Resolve a sorted explicit population of active same-tenant human principals; do not infer operational crew or substitute current heads. Changes to content, context or population require another immutable briefing.',
  },
);
export type MissionBriefingCommand = Static<typeof MissionBriefingCommandSchema>;

export const MissionBriefingPopulationSchema = Type.Object(
  {
    version: Type.Literal('briefing.recipient-population.1'),
    organizationId: Id,
    recipients: Type.Array(
      Type.Object(
        {
          principalId: Id,
          name: Type.String(),
          kind: Type.Literal('human'),
          principalRevision: Revision,
        },
        Closed,
      ),
      { minItems: 1, maxItems: MISSION_BRIEFING_MAX_RECIPIENTS },
    ),
    digest: Digest,
  },
  {
    ...Closed,
    description:
      'Server-resolved recipients sorted uniquely by principalId. Digest commits this complete object excluding digest. Retained principalRevision is historical identity, not an acknowledgement authority revision. Membership and its denominator never change with later deactivation, grants or crew assignments.',
  },
);

const BriefingContextFields = {
  release: Reference,
  mission: MissionAvoidanceMissionReferenceSchema,
  aircraftId: Id,
  contextDigest: Digest,
  releasePolicy: MissionReleasePolicyReferenceSchema,
};
const MissionBriefingRecordCommonFields = {
  id: Id,
  flightId: Id,
  organizationId: Id,
  recordedAt: Time,
  purpose: Purpose,
  population: MissionBriefingPopulationSchema,
  actor: BriefingActor,
};
const missionBriefingDescription =
  'Immutable exact briefing content and named recipient population, limited to 1 MiB of serialized JSON. Mission, aircraft, safety context and unchanged release policy derive from the cited release; each selected control and acceptance must match one retained candidate. Digest of the complete record identifies what recipients attest to reviewing. No delivery, operational-crew coverage, control implementation or release/departure prerequisite is established.';
export const MissionBriefingRecordSchema = Type.Object(
  {
    version: Type.Literal('flight.mission-briefing.3'),
    ...MissionBriefingRecordCommonFields,
    context: Type.Object({ ...BriefingContextFields, controls: ControlReferences }, Closed),
    content: Type.Object(
      {
        message: Message,
        controls: Type.Array(MissionBriefingControlRecordContentSchema, {
          minItems: 1,
          maxItems: MISSION_BRIEFING_MAX_CONTROLS,
        }),
      },
      Closed,
    ),
    controls: Type.Optional(FlightControlsSeenSchema),
  },
  {
    ...Closed,
    description: `${missionBriefingDescription} It lists one or more exact controls, each once and in the order of the release's candidates, with the content of each at the same position; one acknowledgement acknowledges all of them. It pins the controls in scope the author saw, by digest, whenever the command named that digest.`,
  },
);
export type MissionBriefingRecord = Static<typeof MissionBriefingRecordSchema>;

/** One control a briefing covers: its exact reference and the content briefed for it. */
export interface MissionBriefingControl {
  reference: MissionBriefingControlReference;
  content: MissionBriefingControlRecordContent;
}
/** The controls a briefing covers, in its own order, each with the content briefed for it. */
export function missionBriefingControls(record: MissionBriefingRecord): MissionBriefingControl[] {
  return record.context.controls.map((reference, index) => ({ reference, content: record.content.controls[index]! }));
}

export const MissionBriefingAcknowledgementCommandSchema = Type.Object(
  {
    kind: Type.Literal('mission.briefing-acknowledge'),
    flightId: Id,
    briefing: Reference,
    populationDigest: Digest,
    attestation: Attestation,
    expectedPrincipalRevision: Revision,
  },
  {
    ...Closed,
    description:
      'The authenticated active human principal must have flight:read and briefing:ack and be the actual member of this exact frozen population. expectedPrincipalRevision checks current authority, not the historical population revision. No actor, recipient or on-behalf selector is accepted. Records review of the pinned historical briefing even after context changes; it grants no current operational permission.',
  },
);
export type MissionBriefingAcknowledgementCommand = Static<typeof MissionBriefingAcknowledgementCommandSchema>;

export const MissionBriefingAcknowledgementRecordSchema = Type.Object(
  {
    version: Type.Literal('flight.mission-briefing-acknowledgement.1'),
    id: Id,
    flightId: Id,
    briefing: Reference,
    populationDigest: Digest,
    recipientPrincipalId: Id,
    attestation: Attestation,
    recordedAt: Time,
    actor: AcknowledgementActor,
  },
  {
    ...Closed,
    description:
      'Immutable self-attestation, limited to 16 KiB of serialized JSON; recipientPrincipalId equals authenticated actor.id and exact retained population membership. Retain actual acceptance-time authority. One record per briefing/recipient; exact-key retry recovers it under authentication/read scope without rewriting its time or carrying it to another briefing.',
  },
);
export type MissionBriefingAcknowledgementRecord = Static<typeof MissionBriefingAcknowledgementRecordSchema>;

export const FlightMissionBriefingParamsSchema = Type.Object({ id: Id, briefingId: Id }, Closed);
export type FlightMissionBriefingParams = Static<typeof FlightMissionBriefingParamsSchema>;
/** Why a briefing's picture of the controls stops being known to hold at its `validUntil`. */
export const missionBriefingBoundaries = ['release_window_end', 'control_boundary'] as const;
export const MissionBriefingStandingSchema = Type.Object(
  {
    status: Type.Union([Type.Literal('in_force'), Type.Literal('lapsed')]),
    validUntil: Time,
    boundary: Type.Union(missionBriefingBoundaries.map((boundary) => Type.Literal(boundary))),
    evaluatedAt: Time,
  },
  {
    ...Closed,
    description:
      'Whether the briefing counts at evaluatedAt, read from the database clock. It is in force before validUntil and lapsed from then on: its release window ends (release_window_end) or an accepted control that can matter to the flight starts or ends (control_boundary). A lapsed briefing cannot be acknowledged and does not count toward departure readiness; acknowledgements recorded before it lapsed stay recorded.',
  },
);
export type MissionBriefingStanding = Static<typeof MissionBriefingStandingSchema>;
export const MissionBriefingRecordResponseSchema = Type.Object(
  { briefing: MissionBriefingRecordSchema, digest: Digest, standing: MissionBriefingStandingSchema },
  Closed,
);
export type MissionBriefingRecordResponse = Static<typeof MissionBriefingRecordResponseSchema>;
export const MissionBriefingAcknowledgementsResponseSchema = Type.Object(
  {
    briefing: Reference,
    evaluatedAt: Time,
    purpose: Purpose,
    scope: Type.Literal('declared_recipients_only'),
    population: MissionBriefingPopulationSchema,
    recipients: Type.Array(
      Type.Object(
        {
          recipientPrincipalId: Id,
          acknowledgement: Type.Union([
            Type.Object({ record: MissionBriefingAcknowledgementRecordSchema, digest: Digest }, Closed),
            Type.Null(),
          ]),
          processing: Type.Union([
            ...(['pending', 'processing', 'completed', 'failed'] as const).map((state) => Type.Literal(state)),
            Type.Null(),
          ]),
        },
        Closed,
      ),
      { minItems: 1, maxItems: MISSION_BRIEFING_MAX_RECIPIENTS },
    ),
    releaseValidity: MissionReleaseValidityResponseSchema,
    standing: MissionBriefingStandingSchema,
  },
  {
    ...Closed,
    description:
      'Exact-briefing as-of read, limited to 1 MiB of serialized JSON: one row per frozen recipient, with accepted acknowledgement and projection processing separate from current release validity. releaseValidity selects this briefing’s exact retained release and uses evaluatedAt, never a replacement release. Null acknowledgement/processing means no accepted record. Historical review remains recorded when context changes; counts never imply all operational crew or message delivery.',
  },
);
export type MissionBriefingAcknowledgementsResponse = Static<typeof MissionBriefingAcknowledgementsResponseSchema>;
