import { describe, it, expect } from 'vitest';
import { decodeTelemetry } from './src/telemetry.js';
import type { TelemetrySegment, TelemetrySegmentDescriptor } from '@ledger/contracts';

const original = {
  tid: 'message',
  bid: 'batch',
  gateway: 'dock',
  timestamp: 1790856000000,
  data: { latitude: 41.8, longitude: -87.6, height: 182, horizontal_speed: 3.2 },
};
function fixture(raw = JSON.stringify(original)): { blob: TelemetrySegment; descriptor: TelemetrySegmentDescriptor } {
  const sample = {
    sequence: 1,
    occurredAt: new Date(original.timestamp).toISOString(),
    latitude: 41.8,
    longitude: -87.6,
    altitudeMeters: 182,
    altitudeReference: 'ellipsoid' as const,
    speedMetersPerSecond: 3.2,
    original: { topic: 'thing/product/device/osd', bytesBase64: Buffer.from(raw).toString('base64') },
  };
  const blob: TelemetrySegment = {
    format: 'ledger.telemetry-segment.1',
    sourceId: 'dji',
    sourceSessionId: 'session',
    deviceId: 'device',
    gatewayId: 'dock',
    decoderVersion: 'dji-osd.synthetic.1',
    fidelity: 'synthetic_contract',
    coordinateReference: 'WGS84',
    sequenceBasis: 'adapter_capture',
    sessionStartSequence: 1,
    samples: [sample],
  };
  const descriptor: TelemetrySegmentDescriptor = {
    format: blob.format,
    deviceId: blob.deviceId,
    gatewayId: blob.gatewayId,
    decoderVersion: blob.decoderVersion,
    sequenceBasis: blob.sequenceBasis,
    sessionStartSequence: 1,
    sampleCount: 1,
    firstSequence: 1,
    lastSequence: 1,
    firstOccurredAt: sample.occurredAt,
    lastOccurredAt: sample.occurredAt,
  };
  return { blob, descriptor };
}
const decode = (f: ReturnType<typeof fixture>, text = JSON.stringify(f.blob)) =>
  decodeTelemetry(Buffer.from(text), f.descriptor, 'dji', 'session');
describe('bounded independently checked telemetry decoder', () => {
  it('preserves exact originals and derives ellipsoid scalar values without treating identifiers as sequence', () => {
    const f = fixture(` ${JSON.stringify(original)}\r\n`);
    expect(decode(f)).toEqual(f.blob);
    const missing = fixture(JSON.stringify({ ...original, data: { latitude: 41.8, longitude: -87.6 } }));
    missing.blob.samples[0]!.altitudeMeters = null;
    missing.blob.samples[0]!.altitudeReference = 'unknown';
    delete missing.blob.samples[0]!.speedMetersPerSecond;
    expect(decode(missing)).toEqual(missing.blob);
  });
});
