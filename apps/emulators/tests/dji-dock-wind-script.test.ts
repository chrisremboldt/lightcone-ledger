import { describe, expect, it } from 'vitest';
import { djiDockOsdBytes } from '../src/dji.js';
import {
  djiDockWindScripts,
  planDockWind,
  validateDockWindScript,
  type DjiDockWindScript,
} from '../src/dji-dock-wind-script.js';

const clock = { start: '2026-10-01T17:00:00.000Z', dockId: 'ALPHA-DOCK-01', runId: 'run-fixed' };
const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes));
const script = djiDockWindScripts['dock-wind-rises-in-flight']!;

describe('dock weather in the message builder', () => {
  it('writes the documented dock weather fields, with the dock as its own gateway', () => {
    const bytes = djiDockOsdBytes(
      {
        occurredAt: clock.start,
        windSpeed: 7.26,
        windDirection: 6,
        rainfall: 0,
        environmentTemperatureCelsius: 14.46,
      },
      clock.dockId,
      { tid: 'tid-1', bid: 'bid-1' },
    );
    expect(new TextDecoder().decode(bytes)).toBe(
      '{"tid":"tid-1","bid":"bid-1","timestamp":1790874000000,"gateway":"ALPHA-DOCK-01","data":{"wind_speed":7.3,"wind_direction":6,"rainfall":0,"environment_temperature":14.5}}',
    );
  });

  it('refuses values the documentation does not allow', () => {
    const point = { occurredAt: clock.start, windSpeed: 3 };
    expect(() => djiDockOsdBytes({ ...point, windSpeed: -1 }, 'd')).toThrow(/non-negative/);
    expect(() => djiDockOsdBytes({ ...point, windDirection: 9 }, 'd')).toThrow(/1 to 8/);
    expect(() => djiDockOsdBytes({ ...point, rainfall: 4 }, 'd')).toThrow(/0 to 3/);
  });
});

describe('dock wind scripts as a pure message sequence', () => {
  it('gives the same bytes for the same script and clock, and new ids for a new run', () => {
    const first = planDockWind(script, clock);
    expect(planDockWind(script, clock).messages.map((message) => message.bytes)).toEqual(
      first.messages.map((message) => message.bytes),
    );
    const other = planDockWind(script, { ...clock, runId: 'run-other' });
    expect(decode(other.messages[0]!.bytes).tid).not.toBe(decode(first.messages[0]!.bytes).tid);
    expect(first).toMatchObject({
      durationSeconds: 600,
      takeoffAt: '2026-10-01T17:02:00.000Z',
      landingAt: '2026-10-01T17:08:00.000Z',
    });
    expect(first.messages).toHaveLength(41);
    expect(first.messages[1]).toMatchObject({ offsetMs: 15_000, topic: 'thing/product/ALPHA-DOCK-01/osd' });
  });

  it('raises the wind above 10 meters per second during the flight and lets it fall back before landing', () => {
    const plan = planDockWind(script, clock);
    const speedAt = (seconds: number) =>
      decode(plan.messages.find((message) => message.offsetMs === seconds * 1000)!.bytes).data.wind_speed;
    expect(speedAt(120)).toBe(4.5);
    expect(speedAt(255)).toBe(9.5);
    const above = plan.messages.filter((message) => message.windSpeedMetersPerSecond > 10);
    expect(above.map((message) => message.offsetMs / 1000)).toEqual([270, 285, 300, 315, 330]);
    expect(Math.max(...plan.messages.map((message) => message.windSpeedMetersPerSecond))).toBe(14.2);
    expect(speedAt(480)).toBe(5.1);
    expect(decode(above[0]!.bytes).data.wind_direction).toBe(7);
  });

  it('refuses a script that does not describe a flight and a wind it can publish', () => {
    const broken = (change: Partial<DjiDockWindScript>) => () => validateDockWindScript({ ...script, ...change });
    expect(broken({ flight: { takeoffSeconds: 300, landingSeconds: 200 } })).toThrow(/land after/);
    expect(broken({ wind: { speedMetersPerSecond: 4, direction: 0 } })).toThrow(/1 to 8/);
    expect(
      broken({
        steps: [
          { atSeconds: 200, action: 'wind', speedMetersPerSecond: 5 },
          { atSeconds: 100, action: 'wind', speedMetersPerSecond: 6 },
        ],
      }),
    ).toThrow(/time order/);
  });
});
