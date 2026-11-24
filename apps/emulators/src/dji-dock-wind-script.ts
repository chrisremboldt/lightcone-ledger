import { createHash } from 'node:crypto';
import { djiDockOsdBytes } from './dji.js';

/**
 * A scripted stretch of dock weather as data: the wind the dock measures, and timed steps that change it. The flight
 * flown from the dock is stated so a test or scene knows when the aircraft is up; the dock reports throughout.
 * Offsets are seconds from the start of the script.
 */
export interface DjiDockWindScript {
  name: string;
  description: string;
  durationSeconds: number;
  /** Seconds between messages. */
  periodSeconds: number;
  flight: { takeoffSeconds: number; landingSeconds: number };
  /** Wind at the start; direction is a sector, 1 true north clockwise to 8 northwest. */
  wind: { speedMetersPerSecond: number; direction: number };
  rainfall: number;
  environmentTemperatureCelsius: number;
  steps: DjiDockWindStep[];
}

export type DjiDockWindStep = { atSeconds: number; action: 'wind'; speedMetersPerSecond: number; direction?: number };

export interface DjiDockScriptClock {
  /** Source time of offset zero. */
  start: string;
  dockId: string;
  /** Distinguishes runs of the same script, so their message ids never collide. */
  runId: string;
}

export interface DjiDockScriptMessage {
  sequence: number;
  offsetMs: number;
  occurredAt: string;
  topic: string;
  bytes: Uint8Array;
  windSpeedMetersPerSecond: number;
}

export interface DjiDockWindPlan {
  script: string;
  runId: string;
  start: string;
  durationSeconds: number;
  /** The flight's takeoff and landing as UTC instants. */
  takeoffAt: string;
  landingAt: string;
  messages: DjiDockScriptMessage[];
}

const MAX_DURATION_SECONDS = 6 * 60 * 60;
const MAX_MESSAGES = 20_000;
const MAX_WIND_METERS_PER_SECOND = 100;

function invalid(message: string): never {
  throw new Error(`Invalid dock wind script: ${message}`);
}
const finite = (value: unknown, field: string, min: number, max: number): void => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    invalid(`${field} must be a number from ${min} to ${max}`);
};
const sector = (value: unknown, field: string): void => {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 8) invalid(`${field} must be 1 to 8`);
};

export function validateDockWindScript(script: DjiDockWindScript): DjiDockWindScript {
  if (!script || typeof script !== 'object') invalid('expected an object');
  if (typeof script.name !== 'string' || !/^[a-z0-9-]{1,80}$/.test(script.name))
    invalid('name must be lowercase words joined by hyphens');
  finite(script.durationSeconds, 'durationSeconds', 1, MAX_DURATION_SECONDS);
  finite(script.periodSeconds, 'periodSeconds', 0.5, 600);
  if (script.durationSeconds / script.periodSeconds + 1 > MAX_MESSAGES) invalid(`more than ${MAX_MESSAGES} messages`);
  finite(script.flight?.takeoffSeconds, 'flight.takeoffSeconds', 0, script.durationSeconds);
  finite(script.flight.landingSeconds, 'flight.landingSeconds', 0, script.durationSeconds);
  if (script.flight.landingSeconds <= script.flight.takeoffSeconds) invalid('the flight must land after it takes off');
  finite(script.wind?.speedMetersPerSecond, 'wind.speedMetersPerSecond', 0, MAX_WIND_METERS_PER_SECOND);
  sector(script.wind.direction, 'wind.direction');
  if (!Number.isInteger(script.rainfall) || script.rainfall < 0 || script.rainfall > 3)
    invalid('rainfall must be 0 to 3');
  finite(script.environmentTemperatureCelsius, 'environmentTemperatureCelsius', -40, 60);
  if (!Array.isArray(script.steps) || script.steps.length > 200) invalid('steps must list up to 200 steps');
  let previous = 0;
  for (const step of script.steps) {
    finite(step.atSeconds, 'step atSeconds', 0, script.durationSeconds);
    if (step.atSeconds < previous) invalid('steps must be in time order');
    previous = step.atSeconds;
    if (step.action !== 'wind') invalid(`unknown step action ${(step as { action: string }).action}`);
    finite(step.speedMetersPerSecond, 'wind step speedMetersPerSecond', 0, MAX_WIND_METERS_PER_SECOND);
    if (step.direction !== undefined) sector(step.direction, 'wind step direction');
  }
  return script;
}

function messageId(runId: string, script: string, sequence: number, kind: 'tid' | 'bid'): string {
  const hex = createHash('sha256').update(`${runId}:dock:${script}:${sequence}:${kind}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The exact messages a dock wind script publishes from a given start, without a broker or timers. Pure: the same
 * script and clock give the same bytes. Steps take effect at their offset; a message at the same offset already
 * reflects them.
 */
export function planDockWind(script: DjiDockWindScript, clock: DjiDockScriptClock): DjiDockWindPlan {
  validateDockWindScript(script);
  const startMs = Date.parse(clock.start);
  if (!Number.isFinite(startMs)) throw new Error('Dock wind script start must be a timestamp');
  if (!clock.runId) throw new Error('Dock wind script needs a run id');
  if (!/^[A-Za-z0-9_-]+$/.test(clock.dockId)) throw new Error('Dock wind script needs a dock id');
  const topic = `thing/product/${clock.dockId}/osd`;
  const wind = { ...script.wind };
  const messages: DjiDockScriptMessage[] = [];
  let nextStep = 0;
  const ticks = Math.floor(script.durationSeconds / script.periodSeconds + 1e-9);
  for (let tick = 0; tick <= ticks; tick++) {
    const offsetSeconds = Number((tick * script.periodSeconds).toFixed(3));
    while (nextStep < script.steps.length && script.steps[nextStep]!.atSeconds <= offsetSeconds) {
      const step = script.steps[nextStep++]!;
      wind.speedMetersPerSecond = step.speedMetersPerSecond;
      if (step.direction !== undefined) wind.direction = step.direction;
    }
    const offsetMs = Math.round(offsetSeconds * 1000);
    const occurredAt = new Date(startMs + offsetMs).toISOString();
    const sequence = messages.length + 1;
    const bytes = djiDockOsdBytes(
      {
        occurredAt,
        windSpeed: wind.speedMetersPerSecond,
        windDirection: wind.direction,
        rainfall: script.rainfall,
        environmentTemperatureCelsius: script.environmentTemperatureCelsius,
      },
      clock.dockId,
      {
        tid: messageId(clock.runId, script.name, sequence, 'tid'),
        bid: messageId(clock.runId, script.name, sequence, 'bid'),
      },
    );
    messages.push({
      sequence,
      offsetMs,
      occurredAt,
      topic,
      bytes,
      windSpeedMetersPerSecond: Math.round(wind.speedMetersPerSecond * 10) / 10,
    });
  }
  return {
    script: script.name,
    runId: clock.runId,
    start: new Date(startMs).toISOString(),
    durationSeconds: script.durationSeconds,
    takeoffAt: new Date(startMs + script.flight.takeoffSeconds * 1000).toISOString(),
    landingAt: new Date(startMs + script.flight.landingSeconds * 1000).toISOString(),
    messages,
  };
}

// Named scripts ----------------------------------------------------------------------------------------------------

export const djiDockWindScripts: Readonly<Record<string, DjiDockWindScript>> = {
  'dock-wind-rises-in-flight': {
    name: 'dock-wind-rises-in-flight',
    description:
      'Ten minutes at a dock with a flight from 120 to 480 seconds. The wind is 4.5 meters per second at takeoff, rises from 240 seconds to above 10 meters per second from 270 to 330 seconds, peaking at 14.2, and falls back to 5.1 by 390 seconds, before the landing.',
    durationSeconds: 600,
    periodSeconds: 15,
    flight: { takeoffSeconds: 120, landingSeconds: 480 },
    wind: { speedMetersPerSecond: 4.5, direction: 6 },
    rainfall: 0,
    environmentTemperatureCelsius: 14.5,
    steps: [
      { atSeconds: 240, action: 'wind', speedMetersPerSecond: 9.5 },
      { atSeconds: 270, action: 'wind', speedMetersPerSecond: 13.4, direction: 7 },
      { atSeconds: 300, action: 'wind', speedMetersPerSecond: 14.2 },
      { atSeconds: 330, action: 'wind', speedMetersPerSecond: 11.8 },
      { atSeconds: 345, action: 'wind', speedMetersPerSecond: 7.2, direction: 6 },
      { atSeconds: 390, action: 'wind', speedMetersPerSecond: 5.1 },
    ],
  },
};
