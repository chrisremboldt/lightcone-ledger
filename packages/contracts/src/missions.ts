import { Type, type Static } from '@sinclair/typebox';
import type { ResponseMeta } from './index.js';
import { MissionRoutePlanningSchema } from './mission-route-planning.js';

export const MISSION_SOURCE_MAX_BYTES = 64 * 1024;
export const MISSION_MAX_POSITIONS = 256;
const Id = Type.String({ minLength: 1, maxLength: 200 });
const Revision = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const Digest = Type.String({ pattern: '^[a-f0-9]{64}$' });
const Time = Type.String({
  format: 'date-time',
  pattern: '^(?!0000)\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:[0-5]\\d(?:\\.\\d{1,3})?Z$',
});
export const MissionRouteSchema = Type.Object(
  {
    coordinateReference: Type.Literal('WGS84'),
    coordinateOrder: Type.Literal('longitude_latitude'),
    segmentInterpolation: Type.Literal('linear_longitude_latitude'),
    geometry: Type.Object(
      {
        type: Type.Literal('LineString'),
        coordinates: Type.Array(
          Type.Tuple([Type.Number({ minimum: -180, maximum: 180 }), Type.Number({ minimum: -90, maximum: 90 })]),
          { minItems: 2, maxItems: MISSION_MAX_POSITIONS },
        ),
      },
      { additionalProperties: false },
    ),
  },
  {
    additionalProperties: false,
    description:
      'Planned path through the supplied longitude/latitude numbers, interpolated directly without dateline wrapping or a geodesic interpretation.',
  },
);
export type MissionRoute = Static<typeof MissionRouteSchema>;
export const MissionAltitudeSchema = Type.Object(
  {
    minimum: Type.Number({ minimum: 0, maximum: 10000 }),
    maximum: Type.Number({ minimum: 0, maximum: 10000 }),
    unit: Type.Literal('m'),
    reference: Type.Literal('AGL'),
  },
  { additionalProperties: false, description: 'Reported planned altitude band; minimum must not exceed maximum.' },
);
export const MissionOperatingIntervalSchema = Type.Object(
  { start: Time, end: Time },
  { additionalProperties: false, description: 'Finite UTC half-open interval [start,end); start must precede end.' },
);
const MissionFields = {
  sourceMissionId: Id,
  aircraftId: Id,
  route: MissionRouteSchema,
  lateralToleranceMeters: Type.Number({
    minimum: 0,
    maximum: 1000,
    description:
      'The planned horizontal area is the closed corridor of every horizontal point within lateralToleranceMeters of any point on the declared interpolated centerline, measured by shortest WGS84 ellipsoidal geodesic distance. The boundary and rounded endpoint caps are included. Zero means the declared centerline only.',
  }),
  altitude: MissionAltitudeSchema,
  operatingInterval: MissionOperatingIntervalSchema,
  routePlanning: Type.Optional(MissionRoutePlanningSchema),
};
export const MissionSourceSchema = Type.Object(
  { sourceRevision: Revision, occurredAt: Time, ...MissionFields },
  {
    additionalProperties: false,
    description:
      'Strict UTF-8 mission JSON, without BOM or duplicate keys and at most 64 KiB; exact source bytes are retained. The planned horizontal area follows the lateralToleranceMeters corridor definition.',
  },
);
export type MissionSource = Static<typeof MissionSourceSchema>;
export const MissionInputSchema = Type.Object(
  {
    sourceId: Id,
    kind: Type.Literal('mission.revision'),
    sourceRevision: Revision,
    occurredAt: Time,
    subject: Type.Object({ flightId: Id }, { additionalProperties: false }),
    artifactId: Id,
    fidelity: Type.Literal('synthetic_contract'),
    payload: Type.Object(MissionFields, { additionalProperties: false }),
  },
  {
    additionalProperties: false,
    description:
      'One immutable planned mission revision on an exact existing flight; sourceRevision and occurredAt copy the original source lexically and payload copies its remaining fields.',
  },
);
export type MissionInput = Static<typeof MissionInputSchema>;
export const MissionAuthoritySchema = Type.Object(
  {
    version: Type.Literal('ledger.mission-authority.1'),
    principalId: Id,
    tenantId: Id,
    principalRevision: Revision,
    inputKind: Type.Literal('mission.revision'),
    sourceId: Id,
    requiredCapabilities: Type.Tuple([Type.Literal('input:write'), Type.Literal('mission:write')]),
    grantedSources: Type.Array(Id, { uniqueItems: true, maxItems: 100 }),
  },
  { additionalProperties: false },
);
export type MissionAuthority = Static<typeof MissionAuthoritySchema>;
export const MissionBindingSchema = Type.Object(
  { missionId: Id, flightId: Id, sourceId: Id, sourceMissionId: Id, aircraftId: Id },
  { additionalProperties: false },
);
export type MissionBinding = Static<typeof MissionBindingSchema>;
export const MissionRevisionRecordSchema = Type.Object(
  {
    ...MissionBindingSchema.properties,
    version: Type.Literal('flight.mission.1'),
    id: Id,
    sourceRevision: Revision,
    occurredAt: Time,
    recordedAt: Time,
    receiptId: Id,
    artifactId: Id,
    route: MissionRouteSchema,
    lateralToleranceMeters: MissionFields.lateralToleranceMeters,
    altitude: MissionAltitudeSchema,
    operatingInterval: MissionOperatingIntervalSchema,
    routePlanning: Type.Optional(MissionRoutePlanningSchema),
    original: Type.Object(
      { sha256: Digest, byteLength: Type.Integer({ minimum: 1, maximum: MISSION_SOURCE_MAX_BYTES }) },
      { additionalProperties: false },
    ),
    contentDigest: Digest,
    authority: MissionAuthoritySchema,
  },
  { additionalProperties: false },
);
export type MissionRevisionRecord = Static<typeof MissionRevisionRecordSchema>;
export const MissionProcessingSchema = Type.Object(
  {
    status: Type.Union([
      Type.Literal('pending'),
      Type.Literal('processing'),
      Type.Literal('completed'),
      Type.Literal('failed'),
    ]),
    attempts: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type MissionProcessing = Static<typeof MissionProcessingSchema>;
export interface FlightMissionResponse {
  binding: MissionBinding | null;
  acceptedHead: { record: MissionRevisionRecord; processing: MissionProcessing } | null;
  projectedHead: MissionRevisionRecord | null;
  meta: ResponseMeta;
}
export const FlightMissionParamsSchema = Type.Object({ id: Id }, { additionalProperties: false });
export type FlightMissionParams = Static<typeof FlightMissionParamsSchema>;
export const FlightMissionRevisionParamsSchema = Type.Object(
  { id: Id, revision: Revision },
  { additionalProperties: false },
);
export type FlightMissionRevisionParams = Static<typeof FlightMissionRevisionParamsSchema>;
export const FlightMissionRevisionResponseSchema = Type.Object(
  { mission: MissionRevisionRecordSchema },
  { additionalProperties: false },
);
export type FlightMissionRevisionResponse = Static<typeof FlightMissionRevisionResponseSchema>;
