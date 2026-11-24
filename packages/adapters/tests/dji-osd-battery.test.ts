import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type TranslationContext,
  type VendorMessage,
  InMemoryObservationSink,
  translateAndSubmit,
} from '../src/adapter-contract.js';
import { assertAdapterConformance } from '../src/conformance.js';
import { djiOsdBatteryAdapter, djiOsdBatteryDescriptor, translateDjiOsdBattery } from '../src/dji-osd-battery.js';
import { type DjiOsdBinding, translateDjiOsdPosition } from '../src/dji-osd-position.js';
import { djiOsdBytes, type DjiWorldPoint } from '../../../apps/emulators/src/dji.js';

const binding = { deviceId: 'ALPHA-AIRCRAFT-01', gatewayId: 'ALPHA-DOCK-01' };
const context: TranslationContext<DjiOsdBinding> = { subjects: { scope: 'source' }, binding };
const topic = `thing/product/${binding.deviceId}/osd`;

function osdMessage(point: Omit<DjiWorldPoint, 'occurredAt'>): VendorMessage {
  return {
    bytes: djiOsdBytes({ occurredAt: '2026-10-01T17:00:00.000Z', ...point }, binding.gatewayId, {
      tid: 'tid-battery',
      bid: 'bid-battery',
    }),
    contentType: 'application/json',
    transport: { topic },
    capturedAt: '2026-10-01T17:00:00.300Z',
  };
}

describe('battery state adapter on the contract', () => {
  it('passes the conformance kit against its golden files', async () => {
    const report = await assertAdapterConformance({
      adapter: djiOsdBatteryAdapter,
      context,
      goldenDirectory: join(import.meta.dirname, '../src/golden/dji-osd-battery'),
    });
    expect(report.checked).toMatchObject({ goldens: 20, observations: 8 });
  });

  it('submits one cited battery observation per message, and a replay submits the same one', async () => {
    const message = osdMessage({
      latitude: 41.88,
      longitude: -87.63,
      battery: { capacityPercent: 70, batteries: [{ index: 0, sn: 'PACK-ALPHA-01', capacityPercent: 70 }] },
      windSpeed: 5,
    });
    const sink = new InMemoryObservationSink();
    const first = await translateAndSubmit(djiOsdBatteryAdapter, message, context, sink);
    const replay = await translateAndSubmit(djiOsdBatteryAdapter, message, context, sink);
    expect(replay.submitted.map((entry) => entry.receiptId)).toEqual(first.submitted.map((entry) => entry.receiptId));
    expect(sink.observations).toHaveLength(1);
    expect(first.submitted[0]!.observation).toMatchObject({
      type: 'battery.state',
      originalArtifactId: first.artifactId,
      fidelity: 'synthetic_contract',
      limitations: djiOsdBatteryDescriptor.limitations,
      values: { totalRemainingPercent: 70, packs: [{ serialNumber: 'PACK-ALPHA-01', remainingPercent: 70 }] },
    });
    expect(first.unmapped.map((locator) => locator.value)).toEqual([
      '/bid',
      '/data/latitude',
      '/data/longitude',
      '/data/wind_speed',
    ]);
  });

  it('reads the same message the position adapter reads, each taking only its own fields', () => {
    const message = osdMessage({ latitude: 41.88, longitude: -87.63, battery: { capacityPercent: 70 } });
    const position = translateDjiOsdPosition(message, context);
    const battery = translateDjiOsdBattery(message, context);
    expect(position.drafts.map((draft) => draft.type)).toEqual(['position.fix']);
    expect(position.unmapped.map((locator) => locator.value)).toContain('/data/battery');
    expect(battery.drafts.map((draft) => draft.type)).toEqual(['battery.state']);
  });

  it('gives no battery observation, not a zero one, when the message has no battery state', () => {
    const result = translateDjiOsdBattery(osdMessage({ latitude: 41.88, longitude: -87.63 }), context);
    expect(result.drafts).toEqual([]);
    expect(result.rejections[0]!.reason).toMatch(/no battery state/);
  });

  it('names the vendor in its descriptor but not in what it puts into observations', () => {
    expect(djiOsdBatteryDescriptor.source.vendor).toBe('DJI');
    expect(djiOsdBatteryDescriptor.fidelity).toBe('synthetic_contract');
    expect(djiOsdBatteryDescriptor.produces).toEqual([{ type: 'battery.state', version: 1 }]);
    expect(djiOsdBatteryDescriptor.documentation.every((entry) => /^[0-9a-f]{64}$/.test(entry.sha256))).toBe(true);
    expect(djiOsdBatteryDescriptor.limitations.join(' ')).not.toMatch(/\b(dji|osd|m30|m3d|cloud api)\b/i);
  });
});
