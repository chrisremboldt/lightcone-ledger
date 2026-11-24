import { EventEmitter } from 'node:events';
import { afterEach, expect, test, vi } from 'vitest';
import {
  hostedWorldEnvironment,
  runtimeDirectories,
  simulatorRuntimeMode,
  WORLD_STATE_PATH,
} from '../../infra/scripts/runtime-config.mjs';
import { createRuntimeProcesses } from '../../infra/scripts/runtime-processes.mjs';

class FakeChild extends EventEmitter {
  private exited = false;

  constructor(
    private readonly name: string,
    private readonly signals: string[],
    private readonly exitOnTerm: boolean,
  ) {
    super();
  }

  kill(signal: NodeJS.Signals) {
    this.signals.push(`${this.name}:${signal}`);
    if (signal === 'SIGKILL' || this.exitOnTerm) this.exit(null, signal);
    return true;
  }

  exit(code: number | null = 0, signal: NodeJS.Signals | null = null) {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', code, signal);
  }
}

function runtimeFixture() {
  const children = new Map<string, FakeChild>();
  const signals: string[] = [];
  const log = vi.fn();
  const spawnProcess = vi.fn((file: string) => {
    const child = children.get(file);
    if (!child) throw new Error('The test must register every fake child.');
    return child;
  });
  const runtime = createRuntimeProcesses({
    spawnProcess,
    env: {},
    log,
    worldDrainMs: 90,
    serviceDrainMs: 30,
    brokerDrainMs: 20,
  });
  function start(name: string, exitOnTerm = true) {
    const child = new FakeChild(name, signals, exitOnTerm);
    children.set(name, child);
    expect(runtime.start(name, name, [])).toBe(child);
    return child;
  }
  return { runtime, start, signals, spawnProcess, log };
}

afterEach(() => {
  vi.useRealTimers();
});

test('one simulator mode preserves legacy autorun and world state requires its fixed private volume path', () => {
  expect(simulatorRuntimeMode({})).toBe('off');
  expect(simulatorRuntimeMode({ SIMULATOR_AUTORUN: '1' })).toBe('trickle');
  expect(simulatorRuntimeMode({ SIMULATOR_RUNTIME_MODE: 'world', SIMULATOR_AUTORUN: '1' })).toBe('world');
  expect(simulatorRuntimeMode({ SIMULATOR_RUNTIME_MODE: 'off', SIMULATOR_AUTORUN: '1' })).toBe('off');
  expect(() => simulatorRuntimeMode({ SIMULATOR_RUNTIME_MODE: 'both' })).toThrow(/off, trickle or world/);
  expect(runtimeDirectories({ SIMULATOR_AUTORUN: '1' })).toEqual([]);
  expect(
    runtimeDirectories({
      SIMULATOR_RUNTIME_MODE: 'world',
      SIMULATOR_WORLD_STATE: WORLD_STATE_PATH,
      DJI_MQTT_ENABLED: '1',
      DJI_CHECKPOINT_DIR: '/data/ledger/dji-checkpoints',
      DJI_REPORT_DIR: '/data/ledger/dji-reports',
    }),
  ).toEqual([
    '/data/ledger',
    '/data/ledger/mqtt',
    '/data/ledger/dji-checkpoints',
    '/data/ledger/dji-reports',
    '/data/ledger/world',
  ]);
  expect(() =>
    runtimeDirectories({ SIMULATOR_RUNTIME_MODE: 'world', SIMULATOR_WORLD_STATE: '/tmp/operation.json' }),
  ).toThrow(/fixed private volume path/);
  expect(() => runtimeDirectories({ SIMULATOR_RUNTIME_MODE: 'world' })).toThrow(/fixed private volume path/);
  expect(() =>
    runtimeDirectories({
      DJI_MQTT_ENABLED: '1',
      DJI_CHECKPOINT_DIR: '/tmp/dji-checkpoints',
      DJI_REPORT_DIR: '/data/ledger/dji-reports',
    }),
  ).toThrow(/fixed private volume directories/);
});

test('named ordinary state keeps every private ancestor and requires its exact run without SMS preparation', () => {
  const runId = 'A9_-'.padEnd(100, 'z');
  const directory = `/data/ledger/world/live/${runId}`;
  const env = Object.freeze({
    SIMULATOR_RUNTIME_MODE: 'world',
    SIMULATOR_WORLD_STATE: `${directory}/world.json`,
    SIMULATOR_WORLD_RUN_ID: runId,
  });
  expect(runtimeDirectories(env)).toEqual(['/data/ledger', '/data/ledger/world', '/data/ledger/world/live', directory]);
  const copied = hostedWorldEnvironment(env);
  expect(copied).toEqual(env);
  expect(copied).not.toBe(env);
  expect(() => runtimeDirectories({ ...env, SIMULATOR_WORLD_RUN_ID: undefined })).toThrow(/exact run ID/);
  expect(() => runtimeDirectories({ ...env, SIMULATOR_WORLD_RUN_ID: 'another-run' })).toThrow(/exact run ID/);
  expect(() => runtimeDirectories({ ...env, SIMULATOR_WORLD_SMS_PREPARATION: '' })).toThrow(/SMS preparation/);
  for (const state of [
    '/data/ledger/world/live/../world.json',
    '/data/ledger/world/live/a%2Fb/world.json',
    `/data/ledger/world/live/${'a'.repeat(101)}/world.json`,
    '/data/ledger/world/live/ordinary/other.json',
    '/data/ledger/world/live/caf\u00e9/world.json',
    `${directory}/world.json\n`,
  ])
    expect(() => runtimeDirectories({ ...env, SIMULATOR_WORLD_STATE: state })).toThrow(/fixed private volume path/);
});

test('SMS state accepts only its exact rehearsal, phase, preparation and run with every private ancestor', () => {
  const rehearsalId = 'A9-'.padEnd(30, 'z');
  const rehearsalDir = `/data/ledger/world/sms/${rehearsalId}`;
  const sms = (phase: 'incident' | 'followup') => ({
    SIMULATOR_RUNTIME_MODE: 'world',
    SIMULATOR_WORLD_STATE: `${rehearsalDir}/${phase}/world.json`,
    SIMULATOR_WORLD_SMS_PREPARATION: `${rehearsalDir}/${phase}/preparation.json`,
    SIMULATOR_WORLD_RUN_ID: `${rehearsalId}-${phase}`,
  });
  for (const phase of ['incident', 'followup'] as const) {
    const env = sms(phase);
    expect(runtimeDirectories(env)).toEqual([
      '/data/ledger',
      '/data/ledger/world',
      '/data/ledger/world/sms',
      rehearsalDir,
      `${rehearsalDir}/${phase}`,
    ]);
    expect(() => runtimeDirectories({ ...env, SIMULATOR_WORLD_SMS_PREPARATION: undefined })).toThrow();
    expect(() =>
      runtimeDirectories({ ...env, SIMULATOR_WORLD_SMS_PREPARATION: `${rehearsalDir}/other/preparation.json` }),
    ).toThrow();
    expect(() => runtimeDirectories({ ...env, SIMULATOR_WORLD_RUN_ID: `${rehearsalId}-other` })).toThrow();
  }
  for (const state of [
    `${rehearsalDir}/incident/../followup/world.json`,
    '/data/ledger/world/sms/../incident/world.json',
    '/data/ledger/world/sms/invalid_id/incident/world.json',
    `/data/ledger/world/sms/${'a'.repeat(31)}/incident/world.json`,
    `${rehearsalDir}/other/world.json`,
    `${rehearsalDir}/incident/arbitrary.json`,
    `${rehearsalDir}/incident/world.json\n`,
    '/tmp/incident/world.json',
  ])
    expect(() => runtimeDirectories({ ...sms('incident'), SIMULATOR_WORLD_STATE: state })).toThrow();
});

test('hosted SMS credentials are copied and bound only to explicitly configured follow-up plans', () => {
  const rehearsalId = 'sms-credentials';
  const sms = (phase: 'incident' | 'followup') => ({
    SIMULATOR_RUNTIME_MODE: 'world',
    SIMULATOR_WORLD_STATE: `/data/ledger/world/sms/${rehearsalId}/${phase}/world.json`,
    SIMULATOR_WORLD_SMS_PREPARATION: `/data/ledger/world/sms/${rehearsalId}/${phase}/preparation.json`,
    SIMULATOR_WORLD_RUN_ID: `${rehearsalId}-${phase}`,
  });
  const inherited = {
    ALPHA_SOURCE_TOKEN: 'fixture-alpha-source',
    ALPHA_ACTOR_TOKEN: 'fixture-alpha-actor',
    SIMULATOR_WORLD_MONITORING_TOKEN: 'fixture-inherited-monitoring',
    SIMULATOR_WORLD_DEPARTURE_TOKEN: 'fixture-inherited-departure',
    UNRELATED_SETTING: 'retained',
  };
  const base = Object.freeze({
    SIMULATOR_RUNTIME_MODE: 'world',
    SIMULATOR_WORLD_STATE: WORLD_STATE_PATH,
    ...inherited,
  });
  const baseCopy = hostedWorldEnvironment(base);
  expect(baseCopy).toEqual(base);
  expect(baseCopy).not.toBe(base);

  for (const phase of ['incident', 'followup'] as const) {
    const env = Object.freeze({ ...sms(phase), ...inherited });
    const copied = hostedWorldEnvironment(env);
    expect(copied).not.toBe(env);
    expect(copied).toEqual({
      ...sms(phase),
      ALPHA_SOURCE_TOKEN: inherited.ALPHA_SOURCE_TOKEN,
      ALPHA_ACTOR_TOKEN: inherited.ALPHA_ACTOR_TOKEN,
      UNRELATED_SETTING: inherited.UNRELATED_SETTING,
    });
    expect(env).toEqual({ ...sms(phase), ...inherited });
  }
  for (const [planName, tokenName, credentialName, filename] of [
    ['SIMULATOR_WORLD_MONITORING_PLAN', 'SIMULATOR_WORLD_MONITORING_TOKEN', 'ALPHA_SOURCE_TOKEN', 'monitoring'],
    ['SIMULATOR_WORLD_DEPARTURE_PLAN', 'SIMULATOR_WORLD_DEPARTURE_TOKEN', 'ALPHA_ACTOR_TOKEN', 'departure'],
  ] as const) {
    expect(() =>
      hostedWorldEnvironment({
        ...sms('incident'),
        ...inherited,
        [planName]: `/data/ledger/world/sms/${rehearsalId}/incident/${filename}.plan.json`,
      }),
    ).toThrow();
    const configured = Object.freeze({
      ...sms('followup'),
      ...inherited,
      [planName]: `/data/ledger/world/sms/${rehearsalId}/followup/${filename}.plan.json`,
    });
    const prepared = hostedWorldEnvironment(configured);
    expect(prepared[tokenName]).toBe(inherited[credentialName]);
    const otherToken =
      tokenName === 'SIMULATOR_WORLD_MONITORING_TOKEN'
        ? 'SIMULATOR_WORLD_DEPARTURE_TOKEN'
        : 'SIMULATOR_WORLD_MONITORING_TOKEN';
    expect(prepared).not.toHaveProperty(otherToken);
    expect(configured[tokenName]).toBe(inherited[tokenName]);
    expect(() => hostedWorldEnvironment({ ...configured, [credentialName]: undefined })).toThrow();
  }
});

test('world shutdown keeps API, workers, emulator and brokers alive until the world has exited', async () => {
  vi.useFakeTimers();
  const f = runtimeFixture();
  f.start('mqtt');
  f.start('world-mqtt');
  f.start('api');
  f.start('workers');
  f.start('emulators');
  const world = f.start('world', false);
  const stopping = f.runtime.stop();
  expect(f.runtime.stopping).toBe(true);
  expect(f.signals).toEqual(['world:SIGTERM']);
  await vi.advanceTimersByTimeAsync(40);
  expect(f.signals).toEqual(['world:SIGTERM']);

  world.exit();
  expect(await stopping).toBe(0);
  expect(await f.runtime.closed).toBe(0);
  expect(f.signals).toEqual([
    'world:SIGTERM',
    'api:SIGTERM',
    'workers:SIGTERM',
    'emulators:SIGTERM',
    'mqtt:SIGTERM',
    'world-mqtt:SIGTERM',
  ]);
  expect(f.log).not.toHaveBeenCalled();
});

test('a child failure shares one shutdown with concurrent stops and cannot start replacement writers', async () => {
  vi.useFakeTimers();
  const f = runtimeFixture();
  f.start('mqtt');
  const api = f.start('api');
  f.start('workers');
  f.start('world');
  api.exit(7);
  const first = f.runtime.stop();
  const second = f.runtime.stop();
  expect(first).toBe(second);
  expect(() => f.runtime.start('replacement-world', 'replacement-world', [])).toThrow(/Runtime is stopping/);
  expect(await first).toBe(7);
  expect(await f.runtime.closed).toBe(7);
  expect(f.spawnProcess).toHaveBeenCalledTimes(4);
  expect(f.signals).toEqual(['world:SIGTERM', 'workers:SIGTERM', 'mqtt:SIGTERM']);
  expect(f.log).toHaveBeenCalledWith({ event: 'process_exit', process: 'api', code: 7, signal: null });
});

test('a world that exceeds its drain deadline is killed and shutdown reports failure', async () => {
  vi.useFakeTimers();
  const f = runtimeFixture();
  f.start('mqtt');
  f.start('api');
  f.start('world', false);
  const stopping = f.runtime.stop();
  await vi.advanceTimersByTimeAsync(89);
  expect(f.signals).toEqual(['world:SIGTERM']);
  await vi.advanceTimersByTimeAsync(1);
  expect(await stopping).toBe(1);
  expect(await f.runtime.closed).toBe(1);
  expect(f.signals).toEqual(['world:SIGTERM', 'world:SIGKILL', 'api:SIGTERM', 'mqtt:SIGTERM']);
  expect(f.log).toHaveBeenCalledWith({ event: 'process_drain_timeout', processes: ['world'] });
});

test('a dependency failure during world drain cannot report a clean shutdown', async () => {
  for (const [code, signal, expected] of [
    [3, null, 3],
    [null, 'SIGKILL', 1],
  ] as const) {
    const f = runtimeFixture();
    const api = f.start('api');
    const world = f.start('world', false);
    const stopping = f.runtime.stop();
    api.exit(code, signal);
    world.exit();
    expect(await stopping).toBe(expected);
    expect(await f.runtime.closed).toBe(expected);
  }
});
