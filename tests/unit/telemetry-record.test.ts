import { describe, expect, it } from 'vitest';
import {
  TELEMETRY_DECODER,
  TELEMETRY_FORMAT,
  TELEMETRY_MAX_BYTES,
  TELEMETRY_MAX_SAMPLES,
  type TelemetrySample,
  type TelemetrySegment,
} from '../../packages/contracts/src/telemetry.js';
import { parseTelemetryRecord } from '../../apps/web/src/telemetry-record.js';

function sample(sequence: number, extras: Partial<TelemetrySample> = {}): TelemetrySample {
  const values = {
    sequence,
    occurredAt: `2026-10-18T14:00:${String(sequence).padStart(2, '0')}.000Z`,
    latitude: 41.884,
    longitude: -87.632,
    altitudeMeters: 182,
    altitudeReference: 'ellipsoid' as const,
    speedMetersPerSecond: 12,
    ...extras,
  };
  return {
    ...values,
    original: {
      topic: 'thing/product/aircraft-7/osd',
      bytesBase64: btoa(
        JSON.stringify({
          tid: `capture-${sequence}`,
          bid: 'flight-7',
          timestamp: Date.parse(values.occurredAt),
          gateway: 'gateway-7',
          data: {
            latitude: values.latitude,
            longitude: values.longitude,
            ...(values.altitudeMeters === null ? {} : { height: values.altitudeMeters }),
            horizontal_speed: values.speedMetersPerSecond,
          },
        }),
      ),
    },
  };
}

function fixture(samples = [sample(1)]) {
  const segment: TelemetrySegment = {
    format: TELEMETRY_FORMAT,
    sourceId: 'dji-osd',
    sourceSessionId: 'capture-session-7',
    deviceId: 'aircraft-7',
    gatewayId: 'gateway-7',
    decoderVersion: TELEMETRY_DECODER,
    fidelity: 'synthetic_contract',
    coordinateReference: 'WGS84',
    sequenceBasis: 'adapter_capture',
    sessionStartSequence: 1,
    samples,
  };
  const times = samples.map((entry) => entry.occurredAt).sort();
  const descriptor: Record<string, unknown> = {
    format: segment.format,
    deviceId: segment.deviceId,
    gatewayId: segment.gatewayId,
    decoderVersion: segment.decoderVersion,
    sequenceBasis: segment.sequenceBasis,
    sessionStartSequence: segment.sessionStartSequence,
    sampleCount: samples.length,
    firstSequence: Math.min(...samples.map((entry) => entry.sequence)),
    lastSequence: Math.max(...samples.map((entry) => entry.sequence)),
    firstOccurredAt: times[0],
    lastOccurredAt: times.at(-1),
  };
  return { segment, expected: { sourceId: segment.sourceId, descriptor } };
}

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe('retained telemetry record values', () => {
  it('reads the actual single-sample values without returning vendor envelopes', () => {
    const { segment, expected } = fixture();
    expect(parseTelemetryRecord(bytes(segment), expected)).toEqual([
      {
        sequence: 1,
        occurredAt: '2026-10-18T14:00:01.000Z',
        latitude: 41.884,
        longitude: -87.632,
        altitudeMeters: 182,
        altitudeReference: 'ellipsoid',
        speedMetersPerSecond: 12,
      },
    ]);
  });

  it('orders captures and preserves zero values and explicitly unreported values', () => {
    const { segment, expected } = fixture([
      sample(3, { altitudeMeters: null, altitudeReference: 'unknown', speedMetersPerSecond: undefined }),
      sample(1, { latitude: 0, longitude: 0, altitudeMeters: 0, speedMetersPerSecond: 0 }),
      sample(2),
    ]);
    const parsed = parseTelemetryRecord(bytes(segment), expected);
    expect(parsed.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
    expect(parsed[0]).toMatchObject({ latitude: 0, longitude: 0, altitudeMeters: 0, speedMetersPerSecond: 0 });
    expect(parsed[2]).toMatchObject({ altitudeMeters: null, altitudeReference: 'unknown' });
    expect(parsed[2]!.speedMetersPerSecond).toBeUndefined();
  });

  it('rejects a different source or any mismatched descriptor identity, count, range or time', () => {
    const { segment, expected } = fixture([sample(1), sample(2)]);
    expect(() => parseTelemetryRecord(bytes(segment), { ...expected, sourceId: 'another-source' })).toThrow();
    const changes = {
      format: 'ledger.telemetry-segment.2',
      deviceId: 'another-aircraft',
      gatewayId: 'another-gateway',
      decoderVersion: 'another-decoder',
      sequenceBasis: 'upstream',
      sessionStartSequence: 0,
      sampleCount: 1,
      firstSequence: 0,
      lastSequence: 3,
      firstOccurredAt: '2026-10-18T13:00:00.000Z',
      lastOccurredAt: '2026-10-18T15:00:00.000Z',
    };
    for (const [key, value] of Object.entries(changes))
      expect(() =>
        parseTelemetryRecord(bytes(segment), { ...expected, descriptor: { ...expected.descriptor, [key]: value } }),
      ).toThrow();
  });

  it('rejects malformed, oversized or unsupported segments before returning values', () => {
    const { segment, expected } = fixture();
    for (const raw of [new Uint8Array(), bytes('{'), new Uint8Array([0xff]), new Uint8Array(TELEMETRY_MAX_BYTES + 1)])
      expect(() => parseTelemetryRecord(raw, expected)).toThrow();
    for (const change of [
      { format: 'ledger.telemetry-segment.2' },
      { coordinateReference: 'unknown' },
      { fidelity: 'unknown' },
      { sourceSessionId: '' },
      { samples: [] },
      { samples: Array.from({ length: TELEMETRY_MAX_SAMPLES + 1 }, () => sample(1)) },
    ])
      expect(() => parseTelemetryRecord(bytes({ ...segment, ...change }), expected)).toThrow();
  });

  it('rejects invalid scalar values and duplicate capture sequences', () => {
    const { segment, expected } = fixture([sample(1), sample(2)]);
    for (const change of [
      { sequence: 1.5 },
      { occurredAt: 'not-a-time' },
      { latitude: 91 },
      { longitude: -181 },
      { altitudeMeters: 100001 },
      { altitudeMeters: '182' },
      { altitudeReference: 'AGL' },
      { altitudeReference: ['ellipsoid'] },
      { speedMetersPerSecond: -1 },
      { speedMetersPerSecond: null },
    ]) {
      const invalid = { ...segment, samples: [{ ...segment.samples[0], ...change }, segment.samples[1]] };
      expect(() => parseTelemetryRecord(bytes(invalid), expected)).toThrow();
    }
    const duplicate = fixture([sample(1), sample(1), sample(2)]);
    expect(() => parseTelemetryRecord(bytes(duplicate.segment), duplicate.expected)).toThrow();
    expect(() =>
      parseTelemetryRecord(new TextEncoder().encode(JSON.stringify(segment).replace('41.884', '1e999')), expected),
    ).toThrow();
  });
});
