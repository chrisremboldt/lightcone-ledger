import { Type, type Static } from '@sinclair/typebox';
import type { ResponseMeta } from './index.js';
import {
  MissionAvoidanceMissionReferenceSchema,
  MissionAvoidanceReviewedCandidateSchema,
} from './mission-avoidance.js';
import { MissionRouteSchema } from './missions.js';

const Digest = Type.String({ pattern: '^[a-f0-9]{64}$' });
const Time = Type.String({ format: 'date-time' });
const Reasons = Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 32, uniqueItems: true });
const Milliseconds = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const MissionRouteSuggestionRequestSchema = Type.Object(
  {
    expectedMission: MissionAvoidanceMissionReferenceSchema,
    expectedContextDigest: Digest,
    clearanceMeters: Type.Number({ minimum: 1, maximum: 500 }),
  },
  {
    additionalProperties: false,
    description:
      'Read-only bounded route search pinned to the exact displayed mission and complete avoidance context. Clearance is an authored additional precaution in metres.',
  },
);
export type MissionRouteSuggestionRequest = Static<typeof MissionRouteSuggestionRequestSchema>;
export const MissionRouteTimeFitSchema = Type.Object(
  {
    status: Type.Union([Type.Literal('fits'), Type.Literal('insufficient'), Type.Literal('unsupported')]),
    model: Type.Literal('held-polyline.1'),
    departureAt: Type.Optional(Time),
    requiredCompletionAt: Type.Optional(Time),
    latestDepartureAt: Type.Optional(Time),
    nominalDurationMs: Type.Optional(Milliseconds),
    travelMs: Type.Optional(Milliseconds),
    holdAllowanceMs: Type.Optional(Milliseconds),
    handoffAllowanceMs: Type.Optional(Milliseconds),
    marginMs: Type.Optional(Milliseconds),
    slackMs: Type.Optional(Type.Integer({ minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER })),
    reasons: Reasons,
  },
  {
    additionalProperties: false,
    description:
      'Source-modeled time fit within unchanged mission, customer and modeled resource intervals. This does not establish a live resource allocation or aircraft performance certification.',
  },
);
export type MissionRouteTimeFit = Static<typeof MissionRouteTimeFitSchema>;
export const MissionRouteSuggestionSchema = Type.Object(
  {
    version: Type.Literal('flight.mission-route-suggestion.1'),
    evaluatedAt: Time,
    status: Type.Union([
      Type.Literal('suggested'),
      Type.Literal('unchanged'),
      Type.Literal('infeasible'),
      Type.Literal('unsupported'),
      Type.Literal('search_exhausted'),
    ]),
    mission: Type.Union([MissionAvoidanceMissionReferenceSchema, Type.Null()]),
    contextDigest: Type.Union([Digest, Type.Null()]),
    clearanceMeters: Type.Number({ minimum: 1, maximum: 500 }),
    candidates: Type.Array(MissionAvoidanceReviewedCandidateSchema, { maxItems: 64 }),
    avoids: Type.Literal('every_considered_area', {
      description:
        'A detour keeps clear of every considered area control, including those recorded as not applying to the current route: a control that does not apply to this route may apply to a new one.',
    }),
    consideredAreas: Type.Integer({
      minimum: 0,
      maximum: 512,
      description:
        'How many considered area controls the detour keeps clear of: the candidates and those that do not apply.',
    }),
    originalRoute: Type.Union([MissionRouteSchema, Type.Null()]),
    proposedRoute: Type.Union([MissionRouteSchema, Type.Null()]),
    distance: Type.Union([
      Type.Object(
        {
          model: Type.Literal('held-polyline.1'),
          originalMeters: Type.Number({ minimum: 0 }),
          proposedMeters: Type.Number({ minimum: 0 }),
          changeMeters: Type.Number(),
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    timeFit: MissionRouteTimeFitSchema,
    reasons: Reasons,
  },
  {
    additionalProperties: false,
    description:
      'An explicit human may apply a suggested revision through an authorized mission source. No publication, release or physical command occurs during this read. Every candidate must be current and the corridor plus authored clearance must keep clear of every considered area, whether or not it applies to the current route, by the authoritative WGS84 kernel.',
  },
);
export type MissionRouteSuggestion = Static<typeof MissionRouteSuggestionSchema>;
export interface MissionRouteSuggestionResponse extends MissionRouteSuggestion {
  meta: ResponseMeta;
}
