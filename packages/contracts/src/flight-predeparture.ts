import { Type, type Static } from '@sinclair/typebox';
import { MissionAvoidanceMissionReferenceSchema } from './mission-avoidance.js';
import { MissionBriefingStandingSchema } from './mission-briefing.js';
import { MissionReleaseValidityResponseSchema } from './mission-release.js';

const Closed = { additionalProperties: false };
const Id = Type.String({ minLength: 1, maxLength: 200 });
const Time = Type.String({ format: 'date-time', pattern: 'Z$' });
const Digest = Type.String({ pattern: '^[a-f0-9]{64}$' });
const Reference = Type.Object({ id: Id, digest: Digest }, Closed);
const Processing = Type.Union(
  (['pending', 'processing', 'completed', 'failed'] as const).map((value) => Type.Literal(value)),
);
export const FLIGHT_PREDEPARTURE_LIMITS = {
  bodyBytes: 64 * 1024,
  recordBytes: 128 * 1024,
  responseBytes: 256 * 1024,
  progress: 256,
} as const;
export const FLIGHT_PREDEPARTURE_EVENT = 'flight.predeparture-progress' as const;
export const FlightPredepartureSourceSchema = Type.Object(
  { principalId: Id, missionSourceId: Id, automaticReleasePrincipalId: Id },
  Closed,
);
export type FlightPredepartureSource = Static<typeof FlightPredepartureSourceSchema>;
export const FlightPredepartureConfigSchema = Type.Object(
  {
    version: Type.Literal('flight.predeparture-config.1'),
    tenants: Type.Array(Type.Object({ tenantId: Id, source: FlightPredepartureSourceSchema }, Closed), {
      minItems: 1,
      maxItems: 4,
    }),
  },
  Closed,
);
export type FlightPredepartureConfig = Static<typeof FlightPredepartureConfigSchema>;
export const flightPredeparturePhases = [
  'evaluating',
  'awaiting_route',
  'awaiting_release',
  'awaiting_briefing',
  'awaiting_acknowledgement',
  'ready',
  'departure_unknown',
  'departed',
  'cancelled',
  'blocked',
] as const;
const Phase = Type.Union(flightPredeparturePhases.map((value) => Type.Literal(value)));
export const FlightPredepartureReferencesSchema = Type.Object(
  {
    mission: MissionAvoidanceMissionReferenceSchema,
    release: Type.Optional(Reference),
    briefings: Type.Array(Type.Object({ controlEventId: Id, briefing: Reference }, Closed), { maxItems: 64 }),
    permit: Type.Optional(Reference),
    departureReceipt: Type.Optional(Id),
  },
  Closed,
);
export type FlightPredepartureReferences = Static<typeof FlightPredepartureReferencesSchema>;
export const FlightPredepartureProgressSchema = Type.Object(
  {
    version: Type.Literal('flight.predeparture-progress.1'),
    expectedRevision: Type.Integer({ minimum: 0, maximum: FLIGHT_PREDEPARTURE_LIMITS.progress - 1 }),
    execution: Type.Object({ runId: Id, reservationId: Id, aircraftId: Id, sourceMissionId: Id }, Closed),
    sourceObservedAt: Time,
    phase: Phase,
    code: Type.String({ minLength: 1, maxLength: 100, pattern: '^[a-z][a-z0-9_]*$' }),
    retryable: Type.Boolean(),
    reason: Type.String({ minLength: 1, maxLength: 500 }),
    needsHumanReview: Type.Boolean(),
    references: FlightPredepartureReferencesSchema,
  },
  {
    ...Closed,
    description:
      'Configured mission source only. Immutable execution binding, compare-and-append status and sticky human review. Source observation time is a source report, distinct from server receipt or current read time. This operational report does not grant safety authority or replace a physical departure request.',
  },
);
export type FlightPredepartureProgress = Static<typeof FlightPredepartureProgressSchema>;
export const FlightPredepartureProgressRecordSchema = Type.Object(
  {
    ...Type.Omit(FlightPredepartureProgressSchema, ['expectedRevision']).properties,
    id: Id,
    flightId: Id,
    revision: Type.Integer({ minimum: 1, maximum: FLIGHT_PREDEPARTURE_LIMITS.progress }),
    recordedAt: Time,
    source: FlightPredepartureSourceSchema,
  },
  Closed,
);
export type FlightPredepartureProgressRecord = Static<typeof FlightPredepartureProgressRecordSchema>;
export const FlightPredepartureProgressResponseSchema = Type.Object(
  { progress: FlightPredepartureProgressRecordSchema, digest: Digest },
  Closed,
);
export type FlightPredepartureProgressResponse = Static<typeof FlightPredepartureProgressResponseSchema>;
export const FlightPredepartureSummarySchema = Type.Object(
  {
    progress: Reference,
    phase: Phase,
    code: Type.String({ minLength: 1, maxLength: 100 }),
    retryable: Type.Boolean(),
    needsHumanReview: Type.Boolean(),
    sourceObservedAt: Time,
    recordedAt: Time,
    processing: Processing,
  },
  {
    ...Closed,
    description:
      'Latest accepted source workflow report. Its timestamps do not imply source liveness, current safety validity or reported physical activity.',
  },
);
export type FlightPredepartureSummary = Static<typeof FlightPredepartureSummarySchema>;
export const FlightPredepartureResponseSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    flightId: Id,
    progress: Type.Union([FlightPredepartureProgressRecordSchema, Type.Null()]),
    digest: Type.Union([Digest, Type.Null()]),
    processing: Type.Union([Processing, Type.Null()]),
    readAt: Time,
    current: Type.Object(
      {
        acceptedMission: Type.Union([MissionAvoidanceMissionReferenceSchema, Type.Null()]),
        projectedMission: Type.Union([MissionAvoidanceMissionReferenceSchema, Type.Null()]),
        missionProcessing: Type.Union([Processing, Type.Null()]),
        releaseValidity: Type.Union([MissionReleaseValidityResponseSchema, Type.Null()]),
        briefings: Type.Array(
          Type.Object(
            {
              controlEventId: Id,
              briefing: Reference,
              acknowledged: Type.Integer({ minimum: 0, maximum: 32 }),
              recipients: Type.Integer({ minimum: 1, maximum: 32 }),
              standing: MissionBriefingStandingSchema,
            },
            Closed,
          ),
          { maxItems: 64 },
        ),
      },
      Closed,
    ),
  },
  {
    ...Closed,
    description:
      'Side-effect-free exact flight read. Retained source progress and its processing remain separate from fresh mission/release/acknowledgement reads. Missing progress is null, never inferred held or departed. Reads grant no execution permission.',
  },
);
export type FlightPredepartureResponse = Static<typeof FlightPredepartureResponseSchema>;
