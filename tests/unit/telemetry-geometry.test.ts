import { expect, test } from 'vitest';
import type { TelemetrySampleView } from '../../packages/contracts/src/telemetry.js';
import { lateTelemetrySamples, telemetryTrackEdges } from '../../apps/web/src/telemetry-geometry.js';

const start = Date.parse('2026-10-18T14:00:00.000Z');
function sample(sequence: number, occurred = sequence, extras: Partial<TelemetrySampleView> = {}): TelemetrySampleView {
  return {
    id: `capture-${sequence}`,
    sequence,
    occurredAt: new Date(start + occurred * 1000).toISOString(),
    receivedAt: new Date(start + 60_000).toISOString(),
    latitude: 41.88,
    longitude: -87.64,
    altitudeMeters: null,
    altitudeReference: 'unknown',
    original: { topic: 'retained' },
    segmentId: 'segment',
    receiptId: 'receipt',
    eventId: 'event',
    artifactId: 'original',
    sourceId: 'source',
    sourceSessionId: 'capture-session',
    deviceId: 'aircraft-device',
    sampleOffset: 0,
    originalSha256: 'a'.repeat(64),
    durable: true,
    conflict: false,
    ...extras,
  };
}

test('shared map edges preserve capture gaps, conflicts and source-time regression boundaries', () => {
  const samples = [
    sample(1),
    sample(2),
    sample(4),
    sample(5, 5, { conflict: true }),
    sample(6),
    sample(7),
    sample(8, 3),
    sample(9, 4),
    sample(10),
    sample(11),
  ];
  expect(telemetryTrackEdges(samples).map(({ from, to }) => [from.sequence, to.sequence])).toEqual([
    [1, 2],
    [6, 7],
    [10, 11],
  ]);
  expect(samples.map((entry) => entry.sequence)).toEqual([1, 2, 4, 5, 6, 7, 8, 9, 10, 11]);
});

test('shared map never joins different source, session or device identities', () => {
  for (const extras of [{ sourceId: 'other' }, { sourceSessionId: 'other' }, { deviceId: 'other' }])
    expect(telemetryTrackEdges([sample(1), sample(2, 2, extras)])).toEqual([]);
});

test('late marks compare occurrence clocks across receipt batches within one exact track', () => {
  const samples = [
    sample(1, 10),
    sample(2, 5),
    sample(3, 6, { receivedAt: new Date(start + 61_000).toISOString() }),
    sample(4, 1, { sourceSessionId: 'other', receivedAt: new Date(start + 62_000).toISOString() }),
  ];
  expect([...lateTelemetrySamples(samples)]).toEqual(['capture-3']);
});
