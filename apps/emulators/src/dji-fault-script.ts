import { createHash } from 'node:crypto';
import { djiOsdBytes, type DjiBatteryReport, type DjiWorldPoint } from './dji.js';

/**
 * A scripted flight as data: a straight route, a battery that declines at a set rate, and timed steps that change
 * what the aircraft reports or stop it reporting at all. Offsets are seconds from the start of the flight.
 */
export interface DjiFaultScript {
  name: string;
  description: string;
  durationSeconds: number;
  /** Seconds between messages while publishing. */
  periodSeconds: number;
  route: {
    from: { latitude: number; longitude: number };
    to: { latitude: number; longitude: number };
    heightMeters: number;
    horizontalSpeedMetersPerSecond: number;
  };
  battery: {
    percent: number;
    declinePercentPerMinute: number;
    landingPercent: number;
    returnHomePercent: number;
    lowWarningPercent: number;
    criticalWarningPercent: number;
    packs: { sn: string; index: number; temperatureCelsius: number }[];
  };
  wind?: { speed: number; direction: number };
  steps: DjiFaultStep[];
}

export type DjiFaultStep = { atSeconds: number } &
  /** Sets the total and per-pack percentages and the rate of decline. A total without packs moves every pack by the same amount. */
  (
    | { action: 'battery'; percent?: number; packPercents?: number[]; declinePercentPerMinute?: number }
    /** Drops the total and every pack to marginPercent (default 1) below the forced-landing level. */
    | { action: 'below_forced_landing'; marginPercent?: number }
    /** Messages carry no battery fields at all until restore_battery: lost data, never zeros. */
    | { action: 'omit_battery' }
    | { action: 'restore_battery' }
    | { action: 'wind'; speed: number; direction: number }
    /** No messages until resume_publishing: a link gap. The battery keeps declining meanwhile. */
    | { action: 'stop_publishing' }
    | { action: 'resume_publishing' }
    /** Reports the aircraft this far east and north of where the route puts it; zero returns it to the route. */
    | { action: 'offset'; eastMeters: number; northMeters: number }
  );

export interface DjiScriptClock {
  /** Source time of offset zero. */
  start: string;
  deviceId: string;
  gatewayId: string;
  /** Distinguishes runs of the same script, so their message ids never collide. */
  runId: string;
}

export interface DjiScriptMessage {
  sequence: number;
  offsetMs: number;
  occurredAt: string;
  topic: string;
  bytes: Uint8Array;
  batteryReported: boolean;
}

export interface DjiScriptPlan {
  script: string;
  runId: string;
  start: string;
  durationSeconds: number;
  messages: DjiScriptMessage[];
  /** Spans in which nothing is published, in seconds from the start. */
  linkGaps: { fromSeconds: number; toSeconds: number }[];
}

const MAX_DURATION_SECONDS = 3 * 60 * 60;
const MAX_MESSAGES = 20_000;
const CELLS_PER_PACK = 6;
const MAX_OFFSET_METERS = 10_000;
const METERS_PER_DEGREE_LATITUDE = 111_320;

function invalid(message: string): never {
  throw new Error(`Invalid fault script: ${message}`);
}
const finite = (value: unknown, field: string, min: number, max: number): void => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    invalid(`${field} must be a number from ${min} to ${max}`);
};

export function validateFaultScript(script: DjiFaultScript): DjiFaultScript {
  if (!script || typeof script !== 'object') invalid('expected an object');
  if (typeof script.name !== 'string' || !/^[a-z0-9-]{1,80}$/.test(script.name))
    invalid('name must be lowercase words joined by hyphens');
  finite(script.durationSeconds, 'durationSeconds', 1, MAX_DURATION_SECONDS);
  finite(script.periodSeconds, 'periodSeconds', 0.5, 600);
  if (script.durationSeconds / script.periodSeconds + 1 > MAX_MESSAGES) invalid(`more than ${MAX_MESSAGES} messages`);
  const { route, battery } = script;
  for (const point of [route?.from, route?.to]) {
    finite(point?.latitude, 'route latitude', -90, 90);
    finite(point?.longitude, 'route longitude', -180, 180);
  }
  finite(route.heightMeters, 'route.heightMeters', -1000, 10_000);
  finite(route.horizontalSpeedMetersPerSecond, 'route.horizontalSpeedMetersPerSecond', 0, 100);
  for (const field of [
    'percent',
    'landingPercent',
    'returnHomePercent',
    'lowWarningPercent',
    'criticalWarningPercent',
  ] as const)
    finite(battery?.[field], `battery.${field}`, 0, 100);
  finite(battery.declinePercentPerMinute, 'battery.declinePercentPerMinute', 0, 100);
  if (!Array.isArray(battery.packs) || battery.packs.length > 16) invalid('battery.packs must list up to 16 packs');
  const serials = new Set(battery.packs.map((pack) => pack.sn));
  const slots = new Set(battery.packs.map((pack) => pack.index));
  if (serials.size !== battery.packs.length || slots.size !== battery.packs.length)
    invalid('battery packs need unique sn and index values');
  for (const pack of battery.packs) {
    if (typeof pack.sn !== 'string' || !pack.sn || pack.sn.length > 200) invalid('a pack sn must be a short string');
    if (!Number.isInteger(pack.index) || pack.index < 0 || pack.index > 15) invalid('a pack index must be 0 to 15');
    finite(pack.temperatureCelsius, 'pack temperatureCelsius', -40, 100);
  }
  if (script.wind) {
    finite(script.wind.speed, 'wind.speed', 0, 100);
    if (!Number.isInteger(script.wind.direction) || script.wind.direction < 1 || script.wind.direction > 8)
      invalid('wind.direction must be 1 to 8');
  }
  if (!Array.isArray(script.steps) || script.steps.length > 200) invalid('steps must list up to 200 steps');
  let previous = 0;
  for (const step of script.steps) {
    finite(step.atSeconds, 'step atSeconds', 0, script.durationSeconds);
    if (step.atSeconds < previous) invalid('steps must be in time order');
    previous = step.atSeconds;
    if (step.action === 'battery') {
      if (step.percent !== undefined) finite(step.percent, 'battery step percent', 0, 100);
      if (step.declinePercentPerMinute !== undefined)
        finite(step.declinePercentPerMinute, 'battery step declinePercentPerMinute', 0, 100);
      if (step.packPercents !== undefined) {
        if (!Array.isArray(step.packPercents) || step.packPercents.length !== battery.packs.length)
          invalid('packPercents must give one value per pack');
        step.packPercents.forEach((value) => finite(value, 'battery step packPercents', 0, 100));
      }
    } else if (step.action === 'below_forced_landing') {
      if (step.marginPercent !== undefined) finite(step.marginPercent, 'marginPercent', 0, 100);
    } else if (step.action === 'offset') {
      finite(step.eastMeters, 'offset step eastMeters', -MAX_OFFSET_METERS, MAX_OFFSET_METERS);
      finite(step.northMeters, 'offset step northMeters', -MAX_OFFSET_METERS, MAX_OFFSET_METERS);
    } else if (step.action === 'wind') {
      finite(step.speed, 'wind step speed', 0, 100);
      if (!Number.isInteger(step.direction) || step.direction < 1 || step.direction > 8)
        invalid('wind step direction must be 1 to 8');
    } else if (
      !['omit_battery', 'restore_battery', 'stop_publishing', 'resume_publishing'].includes(
        (step as { action: string }).action,
      )
    )
      invalid(`unknown step action ${(step as { action: string }).action}`);
  }
  return script;
}

interface FlightState {
  percent: number;
  packs: number[];
  decline: number;
  batteryReported: boolean;
  publishing: boolean;
  wind?: { speed: number; direction: number };
  offset: { eastMeters: number; northMeters: number };
}

const clamp = (value: number) => Math.min(100, Math.max(0, value));

function advance(state: FlightState, seconds: number): void {
  const drop = (state.decline * seconds) / 60;
  state.percent = clamp(state.percent - drop);
  state.packs = state.packs.map((pack) => clamp(pack - drop));
}

function apply(state: FlightState, step: DjiFaultStep, script: DjiFaultScript): void {
  switch (step.action) {
    case 'battery': {
      if (step.packPercents) state.packs = [...step.packPercents];
      if (step.percent !== undefined) {
        const shift = step.percent - state.percent;
        if (!step.packPercents) state.packs = state.packs.map((pack) => clamp(pack + shift));
        state.percent = step.percent;
      } else if (step.packPercents && step.packPercents.length > 0)
        state.percent = step.packPercents.reduce((sum, value) => sum + value, 0) / step.packPercents.length;
      if (step.declinePercentPerMinute !== undefined) state.decline = step.declinePercentPerMinute;
      return;
    }
    case 'below_forced_landing': {
      const level = clamp(script.battery.landingPercent - (step.marginPercent ?? 1));
      state.percent = level;
      state.packs = state.packs.map(() => level);
      return;
    }
    case 'omit_battery':
      state.batteryReported = false;
      return;
    case 'restore_battery':
      state.batteryReported = true;
      return;
    case 'wind':
      state.wind = { speed: step.speed, direction: step.direction };
      return;
    case 'stop_publishing':
      state.publishing = false;
      return;
    case 'resume_publishing':
      state.publishing = true;
      return;
    case 'offset':
      state.offset = { eastMeters: step.eastMeters, northMeters: step.northMeters };
  }
}

function batteryReport(state: FlightState, script: DjiFaultScript): DjiBatteryReport {
  const { battery } = script;
  const rate = state.decline > 0 ? state.decline : battery.declinePercentPerMinute;
  const percent = Math.round(state.percent);
  return {
    capacityPercent: percent,
    landingPower: Math.round(battery.landingPercent),
    returnHomePower: Math.round(battery.returnHomePercent),
    // The aircraft's own estimate: time until the forced-landing level at the current rate of decline.
    ...(rate > 0
      ? { remainFlightTimeSeconds: Math.max(0, Math.round(((state.percent - battery.landingPercent) / rate) * 60)) }
      : {}),
    ...(battery.packs.length > 0
      ? {
          batteries: battery.packs.map((pack, position) => ({
            capacityPercent: Math.round(state.packs[position]!),
            index: pack.index,
            sn: pack.sn,
            // A straight line between empty and full cell voltages, not a model of battery chemistry.
            voltageMillivolts: Math.round(CELLS_PER_PACK * (3400 + 9 * state.packs[position]!)),
            temperatureCelsius: pack.temperatureCelsius,
          })),
        }
      : {}),
  };
}

function pointAt(state: FlightState, script: DjiFaultScript, offsetSeconds: number, occurredAt: string): DjiWorldPoint {
  const { from, to, heightMeters, horizontalSpeedMetersPerSecond } = script.route;
  const fraction = offsetSeconds / script.durationSeconds;
  const latitude = from.latitude + (to.latitude - from.latitude) * fraction;
  const longitude = from.longitude + (to.longitude - from.longitude) * fraction;
  // A flat-earth step is close enough for a scripted drift of a few hundred meters.
  const metersPerDegreeLongitude = METERS_PER_DEGREE_LATITUDE * Math.cos((latitude * Math.PI) / 180);
  return {
    occurredAt,
    latitude: Number((latitude + state.offset.northMeters / METERS_PER_DEGREE_LATITUDE).toFixed(7)),
    longitude: Number((longitude + state.offset.eastMeters / metersPerDegreeLongitude).toFixed(7)),
    height: heightMeters,
    horizontalSpeed: horizontalSpeedMetersPerSecond,
    ...(state.batteryReported
      ? {
          battery: batteryReport(state, script),
          lowBatteryWarningThreshold: Math.round(script.battery.lowWarningPercent),
          seriousLowBatteryWarningThreshold: Math.round(script.battery.criticalWarningPercent),
        }
      : {}),
    ...(state.wind ? { windSpeed: state.wind.speed, windDirection: state.wind.direction } : {}),
  };
}

function messageId(runId: string, script: string, sequence: number, kind: 'tid' | 'bid'): string {
  const hex = createHash('sha256').update(`${runId}:${script}:${sequence}:${kind}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The exact messages a script publishes from a given start, without a broker or timers. Pure: the same script and
 * clock give the same bytes. Steps take effect at their offset; a message at the same offset already reflects them.
 */
export function planScriptedFlight(script: DjiFaultScript, clock: DjiScriptClock): DjiScriptPlan {
  validateFaultScript(script);
  const startMs = Date.parse(clock.start);
  if (!Number.isFinite(startMs)) throw new Error('Scripted flight start must be a timestamp');
  if (!clock.runId) throw new Error('Scripted flight needs a run id');
  const state: FlightState = {
    percent: script.battery.percent,
    packs: script.battery.packs.map(() => script.battery.percent),
    decline: script.battery.declinePercentPerMinute,
    batteryReported: true,
    publishing: true,
    ...(script.wind ? { wind: { ...script.wind } } : {}),
    offset: { eastMeters: 0, northMeters: 0 },
  };
  const topic = `thing/product/${clock.deviceId}/osd`;
  const messages: DjiScriptMessage[] = [];
  const linkGaps: DjiScriptPlan['linkGaps'] = [];
  let gapStart: number | undefined;
  let now = 0;
  let nextStep = 0;
  const runTo = (offset: number) => {
    while (nextStep < script.steps.length && script.steps[nextStep]!.atSeconds <= offset) {
      const step = script.steps[nextStep++]!;
      advance(state, step.atSeconds - now);
      now = step.atSeconds;
      const wasPublishing = state.publishing;
      apply(state, step, script);
      if (wasPublishing && !state.publishing) gapStart = now;
      if (!wasPublishing && state.publishing && gapStart !== undefined) {
        linkGaps.push({ fromSeconds: gapStart, toSeconds: now });
        gapStart = undefined;
      }
    }
    advance(state, offset - now);
    now = offset;
  };
  const ticks = Math.floor(script.durationSeconds / script.periodSeconds + 1e-9);
  for (let tick = 0; tick <= ticks; tick++) {
    const offsetSeconds = Number((tick * script.periodSeconds).toFixed(3));
    runTo(offsetSeconds);
    if (!state.publishing) continue;
    const offsetMs = Math.round(offsetSeconds * 1000);
    const occurredAt = new Date(startMs + offsetMs).toISOString();
    const sequence = messages.length + 1;
    messages.push({
      sequence,
      offsetMs,
      occurredAt,
      topic,
      bytes: djiOsdBytes(pointAt(state, script, offsetSeconds, occurredAt), clock.gatewayId, {
        tid: messageId(clock.runId, script.name, sequence, 'tid'),
        bid: messageId(clock.runId, script.name, sequence, 'bid'),
      }),
      batteryReported: state.batteryReported,
    });
  }
  runTo(script.durationSeconds);
  if (gapStart !== undefined) linkGaps.push({ fromSeconds: gapStart, toSeconds: script.durationSeconds });
  return {
    script: script.name,
    runId: clock.runId,
    start: new Date(startMs).toISOString(),
    durationSeconds: script.durationSeconds,
    messages,
    linkGaps,
  };
}

// Named scripts ----------------------------------------------------------------------------------------------------

const route = {
  from: { latitude: 41.8781, longitude: -87.6298 },
  to: { latitude: 41.8935, longitude: -87.6101 },
  heightMeters: 120,
  horizontalSpeedMetersPerSecond: 9,
};
const twoPacks = [
  { sn: 'FICTIONAL-PACK-A1', index: 0, temperatureCelsius: 31.5 },
  { sn: 'FICTIONAL-PACK-A2', index: 1, temperatureCelsius: 32.1 },
];
const battery = (percent: number, declinePercentPerMinute: number): DjiFaultScript['battery'] => ({
  percent,
  declinePercentPerMinute,
  landingPercent: 10,
  returnHomePercent: 25,
  lowWarningPercent: 30,
  criticalWarningPercent: 15,
  packs: twoPacks,
});

export const djiFaultScripts: Readonly<Record<string, DjiFaultScript>> = {
  'normal-flight': {
    name: 'normal-flight',
    description: 'Five minutes of ordinary flight: the battery declines steadily and stays well above every warning.',
    durationSeconds: 300,
    periodSeconds: 2,
    route,
    battery: battery(85, 3),
    wind: { speed: 4.2, direction: 3 },
    steps: [],
  },
  'battery-sag-on-approach': {
    name: 'battery-sag-on-approach',
    description:
      'The battery declines normally until the approach at 150 seconds, then sags: one pack drops faster and the total falls below the low warning and the return-home level before landing.',
    durationSeconds: 240,
    periodSeconds: 5,
    route,
    battery: battery(48, 4),
    steps: [{ atSeconds: 150, action: 'battery', percent: 31, packPercents: [33, 29], declinePercentPerMinute: 9 }],
  },
  'below-forced-landing': {
    name: 'below-forced-landing',
    description: 'A low battery that drops below the forced-landing level at 90 seconds.',
    durationSeconds: 120,
    periodSeconds: 2,
    route,
    battery: battery(22, 6),
    steps: [{ atSeconds: 90, action: 'below_forced_landing' }],
  },
  'battery-data-lost': {
    name: 'battery-data-lost',
    description:
      'Battery fields disappear from the messages from 60 to 120 seconds while position keeps arriving; the battery keeps declining unseen.',
    durationSeconds: 180,
    periodSeconds: 2,
    route,
    battery: battery(70, 3),
    steps: [
      { atSeconds: 60, action: 'omit_battery' },
      { atSeconds: 120, action: 'restore_battery' },
    ],
  },
  'drift-outside-area': {
    name: 'drift-outside-area',
    description:
      'A short survey leg that drifts east of its route from 100 seconds, is more than 500 meters off it from 110 to 135 seconds, and is back on the route by 150 seconds.',
    durationSeconds: 240,
    periodSeconds: 5,
    route: {
      from: { latitude: 41.8781, longitude: -87.6298 },
      to: { latitude: 41.8818, longitude: -87.625 },
      heightMeters: 90,
      horizontalSpeedMetersPerSecond: 3,
    },
    battery: battery(90, 2),
    steps: [
      { atSeconds: 100, action: 'offset', eastMeters: 250, northMeters: 0 },
      { atSeconds: 110, action: 'offset', eastMeters: 550, northMeters: 0 },
      { atSeconds: 120, action: 'offset', eastMeters: 700, northMeters: 50 },
      { atSeconds: 130, action: 'offset', eastMeters: 600, northMeters: 50 },
      { atSeconds: 140, action: 'offset', eastMeters: 250, northMeters: 0 },
      { atSeconds: 150, action: 'offset', eastMeters: 0, northMeters: 0 },
    ],
  },
  'link-drop-40s': {
    name: 'link-drop-40s',
    description: 'Nothing is published from 60 to 100 seconds: a forty-second link gap, then messages resume.',
    durationSeconds: 180,
    periodSeconds: 2,
    route,
    battery: battery(75, 3),
    steps: [
      { atSeconds: 60, action: 'stop_publishing' },
      { atSeconds: 100, action: 'resume_publishing' },
    ],
  },
};

// Running a plan in real time ----------------------------------------------------------------------------------------

export interface DjiFlightPublisher {
  deviceId: string;
  gatewayId: string;
  publishBytes(bytes: Uint8Array): Promise<void>;
}

export interface ScriptedFlightProgress {
  runId: string;
  script: string;
  status: 'running' | 'completed' | 'stopped' | 'failed';
  sourceStart: string;
  speed: number;
  durationSeconds: number;
  elapsedSeconds: number;
  total: number;
  published: number;
  inLinkGap: boolean;
  linkGaps: DjiScriptPlan['linkGaps'];
  lastPublishedAt?: string;
  error?: string;
}

export interface ScriptedFlight {
  progress(): ScriptedFlightProgress;
  stop(): void;
}

/** Publishes a plan's messages at their offsets, divided by speed. Source timestamps do not depend on speed. */
export function runScriptedFlight(
  plan: DjiScriptPlan,
  publisher: DjiFlightPublisher,
  options: { speed?: number; now?: () => number } = {},
): ScriptedFlight {
  const speed = options.speed ?? 1;
  const now = options.now ?? Date.now;
  const wallStart = now();
  let status: ScriptedFlightProgress['status'] = 'running';
  let published = 0;
  let error: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = () => Math.min(plan.durationSeconds, ((now() - wallStart) * speed) / 1000);
  const finish = (final: ScriptedFlightProgress['status']) => {
    if (status !== 'running') return;
    status = final;
    if (timer) clearTimeout(timer);
  };
  const scheduleNext = () => {
    if (status !== 'running') return;
    const message = plan.messages[published];
    const due = message ? message.offsetMs : plan.durationSeconds * 1000;
    timer = setTimeout(
      async () => {
        if (status !== 'running') return;
        if (!message) return finish('completed');
        try {
          await publisher.publishBytes(message.bytes);
          published += 1;
          scheduleNext();
        } catch (cause) {
          error = (cause as Error).message;
          finish('failed');
        }
      },
      Math.max(0, wallStart + due / speed - now()),
    );
  };
  scheduleNext();
  return {
    progress: () => {
      const seconds = status === 'completed' ? plan.durationSeconds : elapsed();
      return {
        runId: plan.runId,
        script: plan.script,
        status,
        sourceStart: plan.start,
        speed,
        durationSeconds: plan.durationSeconds,
        elapsedSeconds: Number(seconds.toFixed(3)),
        total: plan.messages.length,
        published,
        inLinkGap:
          status === 'running' && plan.linkGaps.some((gap) => seconds >= gap.fromSeconds && seconds < gap.toSeconds),
        linkGaps: plan.linkGaps,
        ...(published > 0 ? { lastPublishedAt: plan.messages[published - 1]!.occurredAt } : {}),
        ...(error ? { error } : {}),
      };
    },
    stop: () => finish('stopped'),
  };
}
