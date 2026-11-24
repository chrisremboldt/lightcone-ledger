import { Type, type Static } from '@sinclair/typebox';
import type { ResponseMeta } from './index.js';

const Id = Type.String({ minLength: 1, maxLength: 200 });
const Time = Type.String({ format: 'date-time' });
const Sequence = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const TELEMETRY_FORMAT = 'ledger.telemetry-segment.1' as const;
export const TELEMETRY_DECODER = 'dji-osd.synthetic.1' as const;
export const TELEMETRY_MAX_SAMPLES = 120;
export const TELEMETRY_MAX_BYTES = 1024 * 1024;

export const TelemetrySampleSchema = Type.Object(
  {
    sequence: Sequence,
    occurredAt: Time,
    latitude: Type.Number({ minimum: -90, maximum: 90 }),
    longitude: Type.Number({ minimum: -180, maximum: 180 }),
    altitudeMeters: Type.Union([Type.Number({ minimum: -10000, maximum: 100000 }), Type.Null()]),
    altitudeReference: Type.Union(['ellipsoid', 'relative', 'unknown'].map((value) => Type.Literal(value))),
    speedMetersPerSecond: Type.Optional(Type.Number({ minimum: 0, maximum: 500 })),
    original: Type.Object(
      {
        topic: Type.String({ minLength: 1, maxLength: 300 }),
        bytesBase64: Type.String({ minLength: 4, maxLength: 87384 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type TelemetrySample = Static<typeof TelemetrySampleSchema>;

export const TelemetrySegmentSchema = Type.Object(
  {
    format: Type.Literal(TELEMETRY_FORMAT),
    sourceId: Id,
    sourceSessionId: Id,
    deviceId: Id,
    gatewayId: Id,
    decoderVersion: Type.Literal(TELEMETRY_DECODER),
    fidelity: Type.Literal('synthetic_contract'),
    coordinateReference: Type.Literal('WGS84'),
    sequenceBasis: Type.Literal('adapter_capture'),
    sessionStartSequence: Sequence,
    samples: Type.Array(TelemetrySampleSchema, { minItems: 1, maxItems: TELEMETRY_MAX_SAMPLES }),
  },
  { additionalProperties: false },
);
export type TelemetrySegment = Static<typeof TelemetrySegmentSchema>;

export const TelemetrySegmentDescriptorSchema = Type.Object(
  {
    format: Type.Literal(TELEMETRY_FORMAT),
    deviceId: Id,
    gatewayId: Id,
    decoderVersion: Type.Literal(TELEMETRY_DECODER),
    sequenceBasis: Type.Literal('adapter_capture'),
    sessionStartSequence: Sequence,
    sampleCount: Type.Integer({ minimum: 1, maximum: TELEMETRY_MAX_SAMPLES }),
    firstSequence: Sequence,
    lastSequence: Sequence,
    firstOccurredAt: Time,
    lastOccurredAt: Time,
  },
  { additionalProperties: false },
);
export type TelemetrySegmentDescriptor = Static<typeof TelemetrySegmentDescriptorSchema>;

export const TelemetrySampleViewSchema = Type.Object(
  {
    ...TelemetrySampleSchema.properties,
    original: Type.Object({ topic: Type.String({ minLength: 1, maxLength: 300 }) }, { additionalProperties: false }),
    id: Id,
    segmentId: Id,
    receiptId: Id,
    eventId: Id,
    artifactId: Id,
    sourceId: Id,
    sourceSessionId: Id,
    deviceId: Id,
    sampleOffset: Type.Integer({ minimum: 0, maximum: TELEMETRY_MAX_SAMPLES - 1 }),
    receivedAt: Time,
    originalSha256: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    durable: Type.Literal(true),
    conflict: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type TelemetrySampleView = Static<typeof TelemetrySampleViewSchema>;

export const TelemetrySessionViewSchema = Type.Object(
  {
    id: Id,
    sourceId: Id,
    sourceSessionId: Id,
    deviceId: Id,
    sequenceBasis: Type.Literal('adapter_capture'),
    sessionStartSequence: Sequence,
    highestSequence: Sequence,
    latestSample: Type.Union([TelemetrySampleViewSchema, Type.Null()]),
    lastReceivedAt: Time,
    gapCount: Sequence,
    missingSequenceCount: Sequence,
    duplicateCount: Sequence,
    conflictCount: Sequence,
  },
  { additionalProperties: false },
);
export type TelemetrySessionView = Static<typeof TelemetrySessionViewSchema>;

export const TelemetrySegmentViewSchema = Type.Object(
  {
    id: Id,
    receiptId: Id,
    eventId: Id,
    artifactId: Id,
    sourceId: Id,
    sourceSessionId: Id,
    deviceId: Id,
    sampleCount: Type.Integer({ minimum: 1, maximum: TELEMETRY_MAX_SAMPLES }),
    firstSequence: Sequence,
    lastSequence: Sequence,
    firstOccurredAt: Time,
    lastOccurredAt: Time,
    receivedAt: Time,
    processing: Type.Object(
      {
        status: Type.Union(['pending', 'processing', 'completed', 'failed'].map((value) => Type.Literal(value))),
        attempts: Type.Integer({ minimum: 0 }),
        error: Type.Optional(Type.String({ maxLength: 500 })),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type TelemetrySegmentView = Static<typeof TelemetrySegmentViewSchema>;

export const TelemetryGapSchema = Type.Object(
  {
    sessionId: Id,
    sourceId: Id,
    sourceSessionId: Id,
    deviceId: Id,
    fromSequence: Sequence,
    toSequence: Sequence,
  },
  { additionalProperties: false },
);
export type TelemetryGap = Static<typeof TelemetryGapSchema>;

export const TelemetryQuerySchema = Type.Object(
  {
    around: Type.Optional(Time),
    windowSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 300 })),
  },
  {
    additionalProperties: false,
    allOf: [{ if: { required: ['windowSeconds'] }, then: { required: ['around'] } }],
    description:
      'With around, read a bounded historical occurrence window extending windowSeconds on each side (default 60, maximum 300). Without query parameters the existing recent snapshot is unchanged. A window is not a coverage or aircraft-session assertion.',
  },
);
export type TelemetryQuery = Static<typeof TelemetryQuerySchema>;

export const TelemetryDataSchema = Type.Object(
  {
    flightId: Id,
    flightRevision: Sequence,
    status: Type.Literal('durable_only'),
    samples: Type.Array(TelemetrySampleViewSchema, { maxItems: 240 }),
    sessions: Type.Array(TelemetrySessionViewSchema, { maxItems: 16 }),
    segments: Type.Array(TelemetrySegmentViewSchema, { maxItems: 20 }),
    gaps: Type.Array(TelemetryGapSchema, { maxItems: 128 }),
    cursor: Type.String({ minLength: 1, maxLength: 2048 }),
    window: Type.Object(
      {
        sampleLimit: Type.Literal(240),
        sessionLimit: Type.Literal(16),
        segmentLimit: Type.Literal(20),
        gapLimit: Type.Literal(128),
        truncated: Type.Boolean(),
        occurrence: Type.Optional(
          Type.Object(
            { around: Time, from: Time, until: Time },
            {
              additionalProperties: false,
              description:
                'Requested historical occurrence interval, inclusive. Returned claims remain bounded; missing claims are not interpolated by the API.',
            },
          ),
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type TelemetryResponse = Static<typeof TelemetryDataSchema> & { meta: ResponseMeta };

export type FlightWatchMessage =
  | {
      type: 'telemetry.updated' | 'flight.updated';
      flightId: string;
      revision: number;
      cursor: string;
      eventId: string;
      receiptId?: string;
    }
  | {
      type: 'resync_required';
      flightId: string;
      reason: 'expired_cursor' | 'backlog' | 'slow_client' | 'scope_changed';
    }
  | { type: 'stream.closed'; flightId: string; reason: 'authentication_expired' | 'access_revoked' | 'shutdown' };
export interface FlightWatchEvent {
  id?: string;
  event: FlightWatchMessage['type'];
  data: FlightWatchMessage;
}
