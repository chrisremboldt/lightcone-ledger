import {
  TELEMETRY_DECODER,
  TELEMETRY_FORMAT,
  TELEMETRY_MAX_BYTES,
  TELEMETRY_MAX_SAMPLES,
  type TelemetrySample,
} from '@ledger/contracts';

export type TelemetryRecordSample = Pick<
  TelemetrySample,
  'sequence' | 'occurredAt' | 'latitude' | 'longitude' | 'altitudeMeters' | 'altitudeReference' | 'speedMetersPerSecond'
>;

function invalid(): never {
  throw new Error('Retained telemetry values do not match this segment.');
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200;
}

function sequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function timestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function bounded(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function sample(value: unknown, baseline: number): TelemetryRecordSample {
  if (
    !record(value) ||
    !sequence(value.sequence) ||
    value.sequence < baseline ||
    !timestamp(value.occurredAt) ||
    !bounded(value.latitude, -90, 90) ||
    !bounded(value.longitude, -180, 180) ||
    !(value.altitudeMeters === null || bounded(value.altitudeMeters, -10000, 100000)) ||
    typeof value.altitudeReference !== 'string' ||
    !['ellipsoid', 'relative', 'unknown'].includes(value.altitudeReference) ||
    !(value.speedMetersPerSecond === undefined || bounded(value.speedMetersPerSecond, 0, 500))
  )
    invalid();
  return {
    sequence: value.sequence,
    occurredAt: value.occurredAt,
    latitude: value.latitude,
    longitude: value.longitude,
    altitudeMeters: value.altitudeMeters,
    altitudeReference: value.altitudeReference as TelemetryRecordSample['altitudeReference'],
    ...(value.speedMetersPerSecond === undefined ? {} : { speedMetersPerSecond: value.speedMetersPerSecond }),
  };
}

export function parseTelemetryRecord(
  bytes: Uint8Array,
  expected: { sourceId: string; descriptor: Record<string, unknown> },
): TelemetryRecordSample[] {
  if (!bytes.byteLength || bytes.byteLength > TELEMETRY_MAX_BYTES) invalid();
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    invalid();
  }
  const descriptor = expected.descriptor;
  if (
    !record(value) ||
    !identity(expected.sourceId) ||
    value.sourceId !== expected.sourceId ||
    !identity(value.sourceSessionId) ||
    !identity(value.deviceId) ||
    !identity(value.gatewayId) ||
    value.format !== TELEMETRY_FORMAT ||
    value.decoderVersion !== TELEMETRY_DECODER ||
    value.fidelity !== 'synthetic_contract' ||
    value.coordinateReference !== 'WGS84' ||
    value.sequenceBasis !== 'adapter_capture' ||
    !sequence(value.sessionStartSequence) ||
    !Array.isArray(value.samples) ||
    value.samples.length === 0 ||
    value.samples.length > TELEMETRY_MAX_SAMPLES ||
    !record(descriptor) ||
    !['format', 'deviceId', 'gatewayId', 'decoderVersion', 'sequenceBasis', 'sessionStartSequence'].every(
      (key) => descriptor[key] === value[key],
    ) ||
    descriptor.sampleCount !== value.samples.length ||
    !sequence(descriptor.firstSequence) ||
    !sequence(descriptor.lastSequence) ||
    !timestamp(descriptor.firstOccurredAt) ||
    !timestamp(descriptor.lastOccurredAt)
  )
    invalid();

  const baseline = value.sessionStartSequence;
  const samples = value.samples.map((entry) => sample(entry, baseline));
  const sequences = samples.map((entry) => entry.sequence);
  const times = samples.map((entry) => Date.parse(entry.occurredAt));
  if (
    new Set(sequences).size !== samples.length ||
    descriptor.firstSequence !== Math.min(...sequences) ||
    descriptor.lastSequence !== Math.max(...sequences) ||
    Date.parse(descriptor.firstOccurredAt) !== Math.min(...times) ||
    Date.parse(descriptor.lastOccurredAt) !== Math.max(...times)
  )
    invalid();
  return samples.sort((left, right) => left.sequence - right.sequence);
}
