import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { djiOsdBytes } from '../src/dji.js';
import { djiFaultScripts, planScriptedFlight, type DjiFaultScript } from '../src/dji-fault-script.js';
import { createEmulator, emulatorConfig } from '../src/server.js';

const clock = {
  start: '2026-10-01T17:00:00.000Z',
  deviceId: 'ALPHA-AIRCRAFT-01',
  gatewayId: 'ALPHA-DOCK-01',
  runId: 'run-fixed',
};
const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes));
const plan = (name: string) => planScriptedFlight(djiFaultScripts[name]!, clock);

describe('battery fields in the telemetry message builder', () => {
  it('leaves the message unchanged when no battery data is asked for', () => {
    const point = { occurredAt: clock.start, latitude: 41.88, longitude: -87.63, height: 220 };
    const identity = { tid: 'tid-1', bid: 'bid-1' };
    expect(new TextDecoder().decode(djiOsdBytes(point, clock.gatewayId, identity))).toBe(
      '{"tid":"tid-1","bid":"bid-1","timestamp":1790874000000,"gateway":"ALPHA-DOCK-01","data":{"latitude":41.88,"longitude":-87.63,"height":220}}',
    );
  });

  it('writes the documented battery fields with their documented types', () => {
    const body = decode(
      djiOsdBytes(
        {
          occurredAt: clock.start,
          latitude: 41.88,
          longitude: -87.63,
          battery: {
            capacityPercent: 64,
            landingPower: 10,
            returnHomePower: 25,
            remainFlightTimeSeconds: 960,
            batteries: [
              { capacityPercent: 65, index: 0, sn: 'PACK-1', voltageMillivolts: 23910, temperatureCelsius: 31.46 },
            ],
          },
          lowBatteryWarningThreshold: 30,
          seriousLowBatteryWarningThreshold: 15,
        },
        clock.gatewayId,
      ),
    );
    expect(body.data).toEqual({
      latitude: 41.88,
      longitude: -87.63,
      battery: {
        capacity_percent: 64,
        remain_flight_time: 960,
        return_home_power: 25,
        landing_power: 10,
        batteries: [{ capacity_percent: 65, index: 0, sn: 'PACK-1', voltage: 23910, temperature: 31.5 }],
      },
      low_battery_warning_threshold: 30,
      serious_low_battery_warning_threshold: 15,
    });
  });

  it('refuses values the documentation does not allow', () => {
    const point = { occurredAt: clock.start, latitude: 0, longitude: 0 };
    expect(() => djiOsdBytes({ ...point, battery: { capacityPercent: 50.5 } }, 'g')).toThrow(/integer/);
    expect(() => djiOsdBytes({ ...point, battery: { capacityPercent: 101 } }, 'g')).toThrow(/0 to 100/);
    expect(() =>
      djiOsdBytes(
        {
          ...point,
          battery: {
            capacityPercent: 50,
            batteries: [
              { capacityPercent: 50, sn: 'A' },
              { capacityPercent: 50, sn: 'A' },
            ],
          },
        },
        'g',
      ),
    ).toThrow(/unique sn/);
  });
});

describe('fault scripts as a pure message sequence', () => {
  it('gives the same bytes for the same script and clock, and new ids for a new run', () => {
    const first = plan('normal-flight');
    const again = plan('normal-flight');
    expect(again.messages.map((message) => message.bytes)).toEqual(first.messages.map((message) => message.bytes));
    const other = planScriptedFlight(djiFaultScripts['normal-flight']!, { ...clock, runId: 'run-other' });
    expect(decode(other.messages[0]!.bytes).tid).not.toBe(decode(first.messages[0]!.bytes).tid);
    expect(first.messages).toHaveLength(151);
    expect(first.messages[1]).toMatchObject({ offsetMs: 2000, occurredAt: '2026-10-01T17:00:02.000Z' });
    expect(first.messages[0]!.topic).toBe('thing/product/ALPHA-AIRCRAFT-01/osd');
  });

  it('sags the battery below the low warning and the return-home level on approach', () => {
    const messages = plan('battery-sag-on-approach').messages.map((message) => ({
      offset: message.offsetMs / 1000,
      data: decode(message.bytes).data,
    }));
    expect(messages).toHaveLength(49);
    const at = (offset: number) => messages.find((message) => message.offset === offset)!.data;
    expect(at(0).battery).toMatchObject({ capacity_percent: 48, landing_power: 10, return_home_power: 25 });
    expect(at(145).battery.capacity_percent).toBe(38);
    expect(at(150).battery.capacity_percent).toBe(31);
    expect(at(150).battery.batteries.map((pack: { capacity_percent: number }) => pack.capacity_percent)).toEqual([
      33, 29,
    ]);
    const percents = messages.map((message) => message.data.battery.capacity_percent);
    expect(percents).toEqual([...percents].sort((a, b) => b - a));
    expect(percents.at(-1)).toBeLessThan(25);
    expect(percents.at(-1)).toBeGreaterThan(10);
    expect(at(0).low_battery_warning_threshold).toBe(30);
  });

  it('drops below the forced-landing level when asked', () => {
    const messages = plan('below-forced-landing').messages.map((message) => decode(message.bytes).data);
    expect(messages[44].battery.capacity_percent).toBeGreaterThan(10);
    expect(messages[45].battery.capacity_percent).toBe(9);
    expect(
      messages[45].battery.batteries.every((pack: { capacity_percent: number }) => pack.capacity_percent < 10),
    ).toBe(true);
  });

  it('omits every battery field while battery data is lost, never sending zeros', () => {
    const messages = plan('battery-data-lost').messages;
    const lost = messages.filter((message) => !message.batteryReported).map((message) => decode(message.bytes).data);
    expect(lost).toHaveLength(30);
    for (const data of lost) {
      expect(Object.keys(data).sort()).toEqual(['height', 'horizontal_speed', 'latitude', 'longitude']);
    }
    const after = decode(messages.find((message) => message.offsetMs === 120_000)!.bytes).data;
    expect(after.battery.capacity_percent).toBe(64);
  });

  it('publishes nothing for forty seconds during a link drop', () => {
    const result = plan('link-drop-40s');
    expect(result.linkGaps).toEqual([{ fromSeconds: 60, toSeconds: 100 }]);
    const offsets = result.messages.map((message) => message.offsetMs / 1000);
    expect(offsets.filter((offset) => offset >= 60 && offset < 100)).toEqual([]);
    expect(offsets).toContain(58);
    expect(offsets).toContain(100);
    expect(result.messages.map((message) => message.sequence)).toEqual(offsets.map((_, index) => index + 1));
  });

  it('drifts east of the route and comes back', () => {
    const script = djiFaultScripts['drift-outside-area']!;
    const messages = plan('drift-outside-area').messages.map((message) => ({
      offset: message.offsetMs / 1000,
      data: decode(message.bytes).data,
    }));
    const at = (offset: number) => messages.find((message) => message.offset === offset)!.data;
    const onRoute = (offset: number) => {
      const fraction = offset / script.durationSeconds;
      const { from, to } = script.route;
      return {
        latitude: from.latitude + (to.latitude - from.latitude) * fraction,
        longitude: from.longitude + (to.longitude - from.longitude) * fraction,
      };
    };
    const eastMeters = (offset: number) =>
      (at(offset).longitude - onRoute(offset).longitude) *
      111_320 *
      Math.cos((onRoute(offset).latitude * Math.PI) / 180);
    expect(at(95).latitude).toBeCloseTo(onRoute(95).latitude, 6);
    expect(eastMeters(95)).toBeCloseTo(0, 0);
    expect(eastMeters(110)).toBeCloseTo(550, 0);
    expect(eastMeters(125)).toBeCloseTo(700, 0);
    expect(at(125).latitude - onRoute(125).latitude).toBeCloseTo(50 / 111_320, 6);
    expect(eastMeters(150)).toBeCloseTo(0, 0);
    expect(at(150).latitude).toBeCloseTo(onRoute(150).latitude, 6);
    expect(messages).toHaveLength(49);
  });

  it('refuses a malformed script', () => {
    const script = djiFaultScripts['normal-flight']!;
    const broken = (change: Partial<DjiFaultScript>) => () => planScriptedFlight({ ...script, ...change }, clock);
    expect(broken({ periodSeconds: 0 })).toThrow(/periodSeconds/);
    expect(broken({ steps: [{ atSeconds: 10, action: 'battery', packPercents: [50] }] })).toThrow(/one value per pack/);
    expect(
      broken({
        steps: [
          { atSeconds: 20, action: 'omit_battery' },
          { atSeconds: 10, action: 'restore_battery' },
        ],
      }),
    ).toThrow(/time order/);
    expect(broken({ steps: [{ atSeconds: 10, action: 'explode' } as never] })).toThrow(/unknown step action/);
    expect(broken({ steps: [{ atSeconds: 10, action: 'offset', eastMeters: 20_000, northMeters: 0 }] })).toThrow(
      /eastMeters/,
    );
  });
});

describe('scripted flight controls', () => {
  const config = { ...emulatorConfig({}), port: 0 };
  const published: Uint8Array[] = [];
  const { server } = createEmulator(config, {
    djiFlights: {
      deviceId: clock.deviceId,
      gatewayId: clock.gatewayId,
      publishBytes: async (bytes) => {
        published.push(bytes);
      },
    },
  });
  const unconfigured = createEmulator(config).server;
  let base: string;
  let bare: string;
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}, at = base) =>
    fetch(`${at}${path}`, {
      method,
      headers: { 'x-emulator-admin': config.adminKey, 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const listen = async (target: typeof server) => {
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(target.address() as { port: number }).port}`;
  };
  beforeAll(async () => {
    base = await listen(server);
    bare = await listen(unconfigured);
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => unconfigured.close(resolve));
  });

  it('lists the named scripts and needs the admin header', async () => {
    const listed = await (await call('GET', '/_simulation/dji/scripts')).json();
    expect(listed.scripts.map((script: { name: string }) => script.name)).toEqual(Object.keys(djiFaultScripts));
    const refused = await fetch(`${base}/_simulation/dji/scripts`);
    expect(refused.status).toBe(403);
  });

  it('runs a named script to completion and reports its progress', async () => {
    expect((await call('GET', '/_simulation/dji/flights/current')).status).toBe(404);
    const started = await call('POST', '/_simulation/dji/flights', {
      script: 'link-drop-40s',
      start: clock.start,
      speed: 1000,
    });
    expect(started.status).toBe(202);
    const { flight } = await started.json();
    expect(flight).toMatchObject({ script: 'link-drop-40s', status: 'running', sourceStart: clock.start, speed: 1000 });
    expect((await call('POST', '/_simulation/dji/flights', { script: 'normal-flight' })).status).toBe(409);
    let progress = flight;
    for (let attempt = 0; attempt < 100 && progress.status === 'running'; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      progress = (await (await call('GET', '/_simulation/dji/flights/current')).json()).flight;
    }
    const expected = planScriptedFlight(djiFaultScripts['link-drop-40s']!, { ...clock, runId: flight.runId });
    expect(progress).toMatchObject({ status: 'completed', published: expected.messages.length, inLinkGap: false });
    expect(published.slice(-expected.messages.length)).toEqual(expected.messages.map((message) => message.bytes));
  });

  it('follows the control lease, stops on request and refuses without a publisher', async () => {
    const lease = await (await call('POST', '/_simulation/control-lease', { owner: 'scenario' })).json();
    expect((await call('POST', '/_simulation/dji/flights', { script: 'normal-flight' })).status).toBe(409);
    const started = await call(
      'POST',
      '/_simulation/dji/flights',
      { script: 'normal-flight', speed: 1 },
      { 'x-simulator-lease': lease.leaseId },
    );
    expect(started.status).toBe(202);
    expect((await call('DELETE', '/_simulation/dji/flights/current')).status).toBe(409);
    const stopped = await call('DELETE', '/_simulation/dji/flights/current', undefined, {
      'x-simulator-lease': lease.leaseId,
    });
    expect((await stopped.json()).flight.status).toBe('stopped');
    await call('DELETE', '/_simulation/control-lease', undefined, { 'x-simulator-lease': lease.leaseId });
    expect((await call('POST', '/_simulation/dji/flights', { script: 'no-such-script' })).status).toBe(400);
    expect((await call('POST', '/_simulation/dji/flights', { script: 'normal-flight', speed: 0 })).status).toBe(400);
    const missing = await call('POST', '/_simulation/dji/flights', { script: 'normal-flight' }, {}, bare);
    expect(missing.status).toBe(503);
  });
});
