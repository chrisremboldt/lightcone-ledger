import { describe, expect, it } from 'vitest';
import { type TranslationContext, InMemoryObservationSink, translateAndSubmit } from '../src/adapter-contract.js';
import { type DjiOsdBinding, djiOsdPositionAdapter } from '../src/dji-osd-position.js';
import { djiOsdBatteryAdapter } from '../src/dji-osd-battery.js';
import { djiOsdBytes } from '../../../apps/emulators/src/dji.js';

/*
 * FlightHub Sync's telemetry, by its documentation: "matches the device property updates pushed via the Cloud API"
 * (FlightHub 2 user manual, "FlightHub Sync Beta" > "Introduction", "Configure Telemetry Data Transfer", which links
 * to the Cloud API's dock and aircraft property pages). So the adapters for the Cloud API's periodic aircraft state
 * read it, and no second adapter exists. The message below is written by hand in that documented shape: the Cloud
 * API's osd message struct (tid, bid, timestamp, gateway, data) with properties from its aircraft property list.
 *
 * BUILT FROM DOCUMENTATION ONLY: no message forwarded by a real FlightHub 2 organization has been read. The
 * documentation of the current Sync names neither the topics nor the payload it forwards; docs/guides/deploy.md
 * lists what to compare.
 */
const binding = { deviceId: 'RIDGE-AC-1', gatewayId: 'RIDGE-DOCK-1' };
const context: TranslationContext<DjiOsdBinding> = { subjects: { scope: 'source' }, binding };
const forwarded = {
  tid: '65717bf1-aee7-4abb-8ea3-9b1908548d74',
  bid: 'cf5ad2e6-2f32-4b59-980e-d5c9ee412805',
  timestamp: 1795183205000,
  gateway: 'RIDGE-DOCK-1',
  data: {
    mode_code: 5,
    gear: 1,
    horizontal_speed: 8.4,
    vertical_speed: 0.2,
    longitude: -86.1298,
    latitude: 39.9702,
    height: 268.5,
    elevation: 60.5,
    attitude_pitch: -3.1,
    attitude_roll: 0.4,
    attitude_head: 42,
    home_distance: 118.2,
    wind_speed: 3.2,
    wind_direction: 2,
    total_flight_time: 412_300,
    total_flight_distance: 1_820_400,
    total_flight_sorties: 371,
    track_id: 'track-ridge-0001',
    battery: {
      capacity_percent: 71,
      remain_flight_time: 1460,
      return_home_power: 24,
      landing_power: 9,
      batteries: [{ capacity_percent: 71, index: 0, sn: 'RIDGE-PACK-7', voltage: 24_610, temperature: 31.4 }],
    },
    position_state: { is_fixed: 2, quality: 5, gps_number: 21, rtk_number: 0 },
  },
};
const message = {
  bytes: new TextEncoder().encode(JSON.stringify(forwarded)),
  contentType: 'application/json',
  transport: { topic: 'thing/product/RIDGE-AC-1/osd' },
  capturedAt: '2026-11-20T14:00:05.400Z',
};

describe('telemetry forwarded by FlightHub Sync, in the shape its documentation states', () => {
  it('is read by the adapter for the Cloud API’s aircraft state as a position, the rest left in the original', async () => {
    const sink = new InMemoryObservationSink();
    const outcome = await translateAndSubmit(djiOsdPositionAdapter, message, context, sink);
    expect(outcome.rejections).toEqual([]);
    expect(outcome.submitted.map((entry) => entry.observation)).toMatchObject([
      {
        type: 'position.fix',
        subject: { kind: 'aircraft', id: 'RIDGE-AC-1', scope: 'source' },
        occurredAt: '2026-11-20T14:00:05.000Z',
        sourceEventId: forwarded.tid,
        // The Cloud API documents this height as "relative to the Earth ellipsoid height".
        position: {
          latitudeDegrees: 39.9702,
          longitudeDegrees: -86.1298,
          altitude: { meters: 268.5, datum: 'wgs84_ellipsoid' },
        },
        values: { fix: 'unknown', groundSpeedMetersPerSecond: 8.4 },
      },
    ]);
    const unmapped = outcome.unmapped.map((locator) => locator.value);
    expect(unmapped).toEqual(expect.arrayContaining(['/bid', '/data/elevation', '/data/battery', '/data/track_id']));
    expect(sink.originals.get(outcome.artifactId!)?.bytes).toEqual(message.bytes);
  });

  it('is read by the battery adapter too', async () => {
    const sink = new InMemoryObservationSink();
    const outcome = await translateAndSubmit(djiOsdBatteryAdapter, message, context, sink);
    expect(outcome.rejections).toEqual([]);
    expect(outcome.submitted.map((entry) => entry.observation)).toMatchObject([
      {
        type: 'battery.state',
        occurredAt: '2026-11-20T14:00:05.000Z',
        values: { totalRemainingPercent: 71, returnHomeRemainingPercent: 24, forcedLandingRemainingPercent: 9 },
      },
    ]);
  });

  it('has the envelope the Cloud API emulator publishes, so the two cannot drift apart', () => {
    const emulated = JSON.parse(
      new TextDecoder().decode(
        djiOsdBytes(
          { occurredAt: '2026-11-20T14:00:05.000Z', latitude: 39.9702, longitude: -86.1298, height: 268.5 },
          binding.gatewayId,
          { tid: forwarded.tid, bid: forwarded.bid },
        ),
      ),
    ) as Record<string, unknown>;
    expect(Object.keys(emulated).sort()).toEqual(Object.keys(forwarded).sort());
    expect(emulated).toMatchObject({ timestamp: forwarded.timestamp, gateway: forwarded.gateway });
  });

  it('is refused when it names another gateway than the one configured, as any Cloud API message is', async () => {
    const other = { ...message, bytes: new TextEncoder().encode(JSON.stringify({ ...forwarded, gateway: 'OTHER' })) };
    const outcome = await translateAndSubmit(djiOsdPositionAdapter, other, context, new InMemoryObservationSink());
    expect(outcome.submitted).toEqual([]);
    expect(outcome.rejections[0]!.reason).toContain('gateway binding');
  });
});
