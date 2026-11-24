import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type TranslationContext,
  type VendorMessage,
  InMemoryObservationSink,
  translateAndSubmit,
} from '../src/adapter-contract.js';
import { assertAdapterConformance } from '../src/conformance.js';
import {
  type DjiDockBinding,
  djiDockWindAdapter,
  djiDockWindDescriptor,
  translateDjiDockWind,
} from '../src/dji-dock-wind.js';
import { translateDjiOsdBattery } from '../src/dji-osd-battery.js';
import { djiDockOsdBytes, djiOsdBytes } from '../../../apps/emulators/src/dji.js';
import { djiDockWindScripts, planDockWind } from '../../../apps/emulators/src/dji-dock-wind-script.js';

const binding: DjiDockBinding = { dockId: 'ALPHA-DOCK-01', siteId: 'ALPHA-SITE-01', dockModel: 'dock2' };
const context: TranslationContext<DjiDockBinding> = { subjects: { scope: 'source' }, binding };
const topic = `thing/product/${binding.dockId}/osd`;
const message = (bytes: Uint8Array, onTopic = topic): VendorMessage => ({
  bytes,
  contentType: 'application/json',
  transport: { topic: onTopic },
  capturedAt: '2026-10-01T17:00:00.300Z',
});

describe('dock wind adapter on the contract', () => {
  it('passes the conformance kit against its golden files', async () => {
    const report = await assertAdapterConformance({
      adapter: djiDockWindAdapter,
      context,
      goldenDirectory: join(import.meta.dirname, '../src/golden/dji-dock-wind'),
    });
    expect(report.checked).toMatchObject({ goldens: 14, observations: 4 });
  });

  it('submits one cited measured wind per message, and a replay submits the same one', async () => {
    const bytes = djiDockOsdBytes(
      { occurredAt: '2026-10-01T17:00:00.000Z', windSpeed: 11.2, windDirection: 7, rainfall: 0 },
      binding.dockId,
      { tid: 'tid-wind', bid: 'bid-wind' },
    );
    const sink = new InMemoryObservationSink();
    const first = await translateAndSubmit(djiDockWindAdapter, message(bytes), context, sink);
    const replay = await translateAndSubmit(djiDockWindAdapter, message(bytes), context, sink);
    expect(replay.submitted.map((entry) => entry.receiptId)).toEqual(first.submitted.map((entry) => entry.receiptId));
    expect(sink.observations).toHaveLength(1);
    expect(first.submitted[0]!.observation).toMatchObject({
      type: 'weather.wind',
      subject: { kind: 'site', id: 'ALPHA-SITE-01', scope: 'source' },
      originalArtifactId: first.artifactId,
      limitations: djiDockWindDescriptor.limitations,
      values: { method: 'measured', speedMetersPerSecond: 11.2 },
    });
    expect(first.unmapped.map((locator) => locator.value)).toEqual(['/bid', '/data/rainfall', '/data/wind_direction']);
  });

  it('refuses wind without a configured dock model, and from a first-generation dock', () => {
    const bytes = djiDockOsdBytes({ occurredAt: '2026-10-01T17:00:00.000Z', windSpeed: 6 }, binding.dockId);
    const unconfigured = translateDjiDockWind(message(bytes), {
      ...context,
      binding: { dockId: binding.dockId, siteId: binding.siteId },
    });
    expect(unconfigured.drafts).toEqual([]);
    expect(unconfigured.rejections[0]!.reason).toMatch(/dock model is not configured/);
    const firstGeneration = translateDjiDockWind(message(bytes), {
      ...context,
      binding: { ...binding, dockModel: 'dock1' },
    });
    expect(firstGeneration.drafts).toEqual([]);
    expect(firstGeneration.rejections[0]).toMatchObject({
      reason: expect.stringMatching(/first-generation dock/),
      locator: { kind: 'json_pointer', value: '/data/wind_speed' },
    });
  });

  it('leaves the aircraft’s own wind estimate to the aircraft adapters, which keep it unmapped', () => {
    const aircraft = djiOsdBytes(
      {
        occurredAt: '2026-10-01T17:00:00.000Z',
        latitude: 41.88,
        longitude: -87.63,
        battery: { capacityPercent: 70 },
        windSpeed: 32,
        windDirection: 3,
      },
      binding.dockId,
    );
    const onAircraftTopic = message(aircraft, 'thing/product/ALPHA-AIRCRAFT-01/osd');
    expect(translateDjiDockWind(onAircraftTopic, context).rejections[0]!.reason).toMatch(/Topic does not match/);
    const battery = translateDjiOsdBattery(onAircraftTopic, {
      subjects: { scope: 'source' },
      binding: { deviceId: 'ALPHA-AIRCRAFT-01', gatewayId: binding.dockId },
    });
    expect(battery.unmapped.map((locator) => locator.value)).toEqual(
      expect.arrayContaining(['/data/wind_speed', '/data/wind_direction']),
    );
  });

  it('translates every message of the emulator’s dock wind script', () => {
    const plan = planDockWind(djiDockWindScripts['dock-wind-rises-in-flight']!, {
      start: '2026-10-01T17:00:00.000Z',
      dockId: binding.dockId,
      runId: 'adapter-test',
    });
    const speeds = plan.messages.map((item) => {
      const result = translateDjiDockWind(message(item.bytes), context);
      expect(result.rejections).toEqual([]);
      return (result.drafts[0]!.values as { speedMetersPerSecond: number }).speedMetersPerSecond;
    });
    expect(speeds).toEqual(plan.messages.map((item) => item.windSpeedMetersPerSecond));
  });

  it('names the vendor in its descriptor but not in what it puts into observations', () => {
    expect(djiDockWindDescriptor.source.vendor).toBe('DJI');
    expect(djiDockWindDescriptor.produces).toEqual([{ type: 'weather.wind', version: 1 }]);
    expect(djiDockWindDescriptor.limitations.join(' ')).not.toMatch(/\b(dji|osd|cloud api)\b/i);
  });
});
