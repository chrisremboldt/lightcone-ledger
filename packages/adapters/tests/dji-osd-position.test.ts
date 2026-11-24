import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type TranslationContext,
  type VendorMessage,
  InMemoryObservationSink,
  translateAndSubmit,
} from '../src/adapter-contract.js';
import { assertAdapterConformance } from '../src/conformance.js';
import { decodeDjiOsd } from '../src/dji-osd.js';
import { type DjiOsdBinding, djiOsdPositionAdapter, djiOsdPositionDescriptor } from '../src/dji-osd-position.js';
import { djiOsdBytes } from '../../../apps/emulators/src/dji.js';

const binding = { deviceId: 'ALPHA-AIRCRAFT-01', gatewayId: 'ALPHA-DOCK-01' };
const context: TranslationContext<DjiOsdBinding> = { subjects: { scope: 'source' }, binding };
const topic = `thing/product/${binding.deviceId}/osd`;

describe('telemetry position adapter on the contract', () => {
  it('passes the conformance kit against its golden files', async () => {
    const report = await assertAdapterConformance({
      adapter: djiOsdPositionAdapter,
      context,
      goldenDirectory: join(import.meta.dirname, '../src/golden/dji-osd-position'),
    });
    expect(report.checked).toMatchObject({ goldens: 10, observations: 4 });
  });

  it('turns an emulator message into one cited position fix, and a replay into the same submission', async () => {
    const bytes = djiOsdBytes(
      { occurredAt: '2026-10-01T17:00:00.000Z', latitude: 41.88, longitude: -87.63, height: 220, horizontalSpeed: 10 },
      binding.gatewayId,
      { tid: 'tid-emulated', bid: 'bid-emulated' },
    );
    const message: VendorMessage = {
      bytes,
      contentType: 'application/json',
      transport: { topic },
      capturedAt: '2026-10-01T17:00:00.300Z',
    };
    const sink = new InMemoryObservationSink();
    const first = await translateAndSubmit(djiOsdPositionAdapter, message, context, sink);
    const replay = await translateAndSubmit(djiOsdPositionAdapter, message, context, sink);
    expect(replay.submitted.map((entry) => entry.receiptId)).toEqual(first.submitted.map((entry) => entry.receiptId));
    expect(sink.observations).toHaveLength(1);
    expect(sink.originals.get(first.artifactId!)?.bytes).toEqual(bytes);
    expect(first.unmapped).toEqual([{ kind: 'json_pointer', value: '/bid' }]);
    expect(first.submitted[0]!.observation).toMatchObject({
      type: 'position.fix',
      originalArtifactId: first.artifactId,
      fidelity: 'synthetic_contract',
      limitations: djiOsdPositionDescriptor.limitations,
      position: { altitude: { meters: 220, datum: 'wgs84_ellipsoid' } },
      values: { fix: 'unknown', groundSpeedMetersPerSecond: 10 },
    });
    // The telemetry-segment decoder still reads the same bytes as before.
    expect(decodeDjiOsd(topic, bytes, binding, 1)).toMatchObject({
      altitudeReference: 'ellipsoid',
      altitudeMeters: 220,
    });
  });

  it('names the vendor in its descriptor but not in what it puts into observations', () => {
    expect(djiOsdPositionDescriptor.source.vendor).toBe('DJI');
    expect(djiOsdPositionDescriptor.limitations.join(' ')).not.toMatch(/\b(dji|osd|m30|m3d)\b/i);
  });
});
