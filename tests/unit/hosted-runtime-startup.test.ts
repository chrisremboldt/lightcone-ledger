import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mqtt = vi.hoisted(() => ({
  brokerCommand: vi.fn(),
  prepareBroker: vi.fn(),
  waitForBroker: vi.fn(),
}));
vi.mock('../../infra/scripts/mqtt-runtime.mjs', () => mqtt);

import { createRuntimeProcesses } from '../../infra/scripts/runtime-processes.mjs';
import { startCoreServices, startHostedWorld } from '../../infra/scripts/supervise.mjs';

const runId = 'retained-hosted-world';
const env = { SIMULATOR_WORLD_RUN_ID: runId, SIMULATOR_WORLD_STATE: '/data/ledger/world/operation.json' };
const prepared = {
  configPath: '/data/ledger/world/operation.json.broker/mosquitto.conf',
  readinessBinding: { username: 'fixture-world-reader', password: 'fixture-password-not-a-secret' },
};

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface WorldMessage {
  event: string;
  runId: string;
}

class FakeChild extends EventEmitter {
  connected: boolean;
  exited = false;
  readonly messages: WorldMessage[] = [];

  constructor(
    readonly name: string,
    private readonly events: string[],
    private readonly automaticWorldStop: boolean,
    private readonly selectedRunId: string,
  ) {
    super();
    this.connected = name === 'world';
  }

  send(message: WorldMessage, callback?: (error: Error | null) => void) {
    this.messages.push(structuredClone(message));
    this.events.push(`${this.name}:${message.event}`);
    if (message.event === 'operation_world_stop' && this.automaticWorldStop) this.finishWorld();
    callback?.(null);
    return true;
  }

  kill(signal: NodeJS.Signals) {
    this.events.push(`${this.name}:${signal}`);
    if (this.name !== 'world' || this.automaticWorldStop || signal === 'SIGKILL') this.exit(null, signal);
    return true;
  }

  finishWorld() {
    if (this.exited) return;
    this.events.push('world:stopped');
    this.emit('message', { event: 'operation_world_stopped', runId: this.selectedRunId, pending: 0, drained: true });
    this.exit();
  }

  exit(code: number | null = 0, signal: NodeJS.Signals | null = null) {
    if (this.exited) return;
    this.exited = true;
    this.connected = false;
    this.events.push(`${this.name}:exit`);
    this.emit('exit', code, signal);
  }
}

function runtimeFixture(automaticWorldStop = true, fixtureEnv = env) {
  const children = new Map<string, FakeChild>();
  const events: string[] = [];
  const worldStarted = deferred<FakeChild>();
  const spawnProcess = vi.fn((file: string, _args: string[], _options: { env: NodeJS.ProcessEnv; stdio: unknown }) => {
    const name = file === '/fixture/mosquitto' ? 'world-mqtt' : file === process.execPath ? 'world' : file;
    events.push(`${name}:spawn`);
    const child = new FakeChild(name, events, automaticWorldStop, fixtureEnv.SIMULATOR_WORLD_RUN_ID);
    children.set(name, child);
    if (name === 'world') worldStarted.resolve(child);
    return child;
  });
  const processes = createRuntimeProcesses({ spawnProcess, env: fixtureEnv, log: vi.fn() });
  for (const name of ['mqtt', 'api', 'workers', 'emulators']) processes.start(name, name, []);
  events.length = 0;
  async function close() {
    const closed = processes.stop();
    children.get('world')?.finishWorld();
    await closed;
  }
  return { processes, children, events, spawnProcess, worldStarted, close };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mqtt.brokerCommand.mockReturnValue({ file: '/fixture/mosquitto', args: ['--fixture-loader'] });
  mqtt.prepareBroker.mockImplementation(() => {
    throw new Error('These tests must never prepare a real broker.');
  });
  mqtt.waitForBroker.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

test('hosted core startup gives each dependency CPU before starting later services', async () => {
  const apiProbed = deferred();
  const emulatorProbed = deferred();
  const apiReady = deferred();
  const emulatorReady = deferred();
  const controller = new AbortController();
  const processes = { start: vi.fn(), stopping: false, signal: controller.signal };
  const waitForReady = vi.fn(async (url: string, isReady: (body: unknown) => boolean, signal: AbortSignal) => {
    expect(signal).toBe(controller.signal);
    expect(isReady({ status: 'ready', role: 'ledger_owner' })).toBe(false);
    if (url.endsWith('/readyz')) {
      expect(isReady({ status: 'ready', role: 'ledger_app' })).toBe(true);
      apiProbed.resolve();
      await apiReady.promise;
    } else {
      expect(url).toBe('http://127.0.0.1:4002/healthz');
      expect(isReady({ status: 'ok', simulation: true })).toBe(true);
      emulatorProbed.resolve();
      await emulatorReady.promise;
    }
  });
  const startup = startCoreServices(processes, waitForReady, { emulators: true });
  await apiProbed.promise;
  expect(processes.start.mock.calls.map(([name]) => name)).toEqual(['api']);
  apiReady.resolve();
  await emulatorProbed.promise;
  expect(processes.start.mock.calls.map(([name]) => name)).toEqual(['api', 'emulators']);
  emulatorReady.resolve();
  await startup;
  expect(processes.start.mock.calls.map(([name]) => name)).toEqual(['api', 'emulators', 'workers']);
});

test('shutdown during core readiness cannot start another dependency', async () => {
  const apiReady = deferred();
  const controller = new AbortController();
  const processes = { start: vi.fn(), stopping: false, signal: controller.signal };
  const startup = startCoreServices(processes, async () => apiReady.promise);
  processes.stopping = true;
  controller.abort();
  apiReady.resolve();
  await startup;
  expect(processes.start.mock.calls.map(([name]) => name)).toEqual(['api']);
});

test('hosted startup waits for its prepared broker and exact run IPC without resuming a retained pause', async () => {
  const f = runtimeFixture();
  const probing = deferred();
  const brokerReady = deferred();
  const prepareHostedOperation = vi.fn(async () => prepared);
  const loadHostedOperation = vi.fn(async () => ({ prepareHostedOperation }));
  mqtt.waitForBroker.mockImplementation(async () => {
    f.events.push('world-mqtt:probe');
    probing.resolve(undefined);
    await brokerReady.promise;
    f.events.push('world-mqtt:ready');
  });
  const startup = startHostedWorld(f.processes, env, loadHostedOperation);
  let settled = false;
  void startup.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    await probing.promise;
    expect(prepareHostedOperation).toHaveBeenCalledExactlyOnceWith(env);
    expect(f.events).toEqual(['world-mqtt:spawn', 'world-mqtt:probe']);
    expect(mqtt.waitForBroker).toHaveBeenCalledExactlyOnceWith(prepared.readinessBinding, {
      url: 'mqtt://127.0.0.1:1884',
      signal: f.processes.signal,
    });
    expect(f.spawnProcess.mock.calls[4]).toEqual([
      '/fixture/mosquitto',
      ['--fixture-loader', '-c', prepared.configPath],
      { env: {}, stdio: 'inherit' },
    ]);
    brokerReady.resolve(undefined);
    const world = await f.worldStarted.promise;
    expect(f.events).toEqual(['world-mqtt:spawn', 'world-mqtt:probe', 'world-mqtt:ready', 'world:spawn']);
    expect(f.spawnProcess.mock.calls[5]).toEqual([
      process.execPath,
      ['apps/simulator/dist/hosted-operation.js'],
      { env: { ...env, SIMULATOR_AUTORUN: '0' }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] },
    ]);
    world.emit('message', { event: 'operation_world_ready', runId: 'another-run', paused: true, pending: 7 });
    await Promise.resolve();
    expect(settled).toBe(false);
    world.emit('message', { event: 'operation_world_ready', runId, paused: true, pending: 7 });
    expect(await startup).toEqual({ event: 'operation_world_ready', runId, paused: true, pending: 7 });
    expect(world.connected).toBe(true);
    expect(world.messages).toEqual([]);
    expect(f.processes.resumeWorld()).toBe(true);
    expect(world.messages).toEqual([{ event: 'operation_world_resume', runId }]);
    expect(mqtt.prepareBroker).not.toHaveBeenCalled();
  } finally {
    brokerReady.resolve(undefined);
    await f.close();
    await startup.catch(() => {});
  }
});

test('a named ordinary world keeps its exact path through preparation, broker launch and child readiness', async () => {
  const namedEnv = Object.freeze({
    ...env,
    SIMULATOR_WORLD_STATE: `/data/ledger/world/live/${runId}/world.json`,
  });
  const namedPrepared = {
    ...prepared,
    configPath: `${namedEnv.SIMULATOR_WORLD_STATE}.broker/mosquitto.conf`,
  };
  const f = runtimeFixture(true, namedEnv);
  const prepareHostedOperation = vi.fn(async () => namedPrepared);
  const startup = startHostedWorld(f.processes, namedEnv, async () => ({ prepareHostedOperation }));
  try {
    const world = await f.worldStarted.promise;
    world.emit('message', { event: 'operation_world_ready', runId, paused: false, pending: 0 });
    expect(await startup).toEqual({ event: 'operation_world_ready', runId, paused: false, pending: 0 });
    expect(prepareHostedOperation).toHaveBeenCalledExactlyOnceWith(namedEnv);
    expect(f.spawnProcess.mock.calls[4]).toEqual([
      '/fixture/mosquitto',
      ['--fixture-loader', '-c', namedPrepared.configPath],
      { env: {}, stdio: 'inherit' },
    ]);
    expect(f.spawnProcess.mock.calls[5]![2]).toEqual({
      env: { ...namedEnv, SIMULATOR_AUTORUN: '0' },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    expect(world.messages).toEqual([]);
  } finally {
    await f.close();
    await startup.catch(() => {});
  }
});

test('SMS preparation and its child share scoped credentials without adding aliases to supporting services', async () => {
  const phaseDirectory = '/data/ledger/world/sms/partner/followup';
  const phaseEnv = Object.freeze({
    SIMULATOR_WORLD_RUN_ID: 'partner-followup',
    SIMULATOR_WORLD_STATE: `${phaseDirectory}/world.json`,
    SIMULATOR_WORLD_SMS_PREPARATION: `${phaseDirectory}/preparation.json`,
    SIMULATOR_WORLD_MONITORING_PLAN: `${phaseDirectory}/monitoring.plan.json`,
    SIMULATOR_WORLD_DEPARTURE_PLAN: `${phaseDirectory}/departure.plan.json`,
    SIMULATOR_WORLD_DEPARTURE_STATE: `${phaseDirectory}/departure.journal.json`,
    ALPHA_SOURCE_TOKEN: 'fixture-alpha-source',
    ALPHA_ACTOR_TOKEN: 'fixture-alpha-actor',
  });
  const worldEnv = {
    ...phaseEnv,
    SIMULATOR_WORLD_MONITORING_TOKEN: phaseEnv.ALPHA_SOURCE_TOKEN,
    SIMULATOR_WORLD_DEPARTURE_TOKEN: phaseEnv.ALPHA_ACTOR_TOKEN,
  };
  const f = runtimeFixture(true, phaseEnv);
  const prepareHostedOperation = vi.fn(async () => ({
    ...prepared,
    configPath: `${phaseDirectory}/world.json.broker/mosquitto.conf`,
  }));
  const startup = startHostedWorld(f.processes, phaseEnv, async () => ({ prepareHostedOperation }));
  try {
    const world = await f.worldStarted.promise;
    world.emit('message', {
      event: 'operation_world_ready',
      runId: phaseEnv.SIMULATOR_WORLD_RUN_ID,
      paused: true,
      pending: 0,
    });
    await startup;
    expect(prepareHostedOperation).toHaveBeenCalledExactlyOnceWith(worldEnv);
    expect(f.spawnProcess.mock.calls[5]![2]).toEqual({
      env: { ...worldEnv, SIMULATOR_AUTORUN: '0' },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    for (const call of f.spawnProcess.mock.calls.slice(0, 4)) {
      expect(call[2]!.env).toEqual(phaseEnv);
      expect(call[2]!.env).not.toHaveProperty('SIMULATOR_WORLD_MONITORING_TOKEN');
      expect(call[2]!.env).not.toHaveProperty('SIMULATOR_WORLD_DEPARTURE_TOKEN');
    }
    expect(f.spawnProcess.mock.calls[4]![2]!.env).toEqual({});
    expect(phaseEnv).not.toHaveProperty('SIMULATOR_WORLD_MONITORING_TOKEN');
    expect(phaseEnv).not.toHaveProperty('SIMULATOR_WORLD_DEPARTURE_TOKEN');
  } finally {
    await f.close();
    await startup.catch(() => {});
  }
});

test('stopping during preparation prevents late world and broker processes after preparation resolves', async () => {
  const f = runtimeFixture();
  const preparing = deferred();
  const preparation = deferred<typeof prepared>();
  const prepareHostedOperation = vi.fn(() => {
    preparing.resolve(undefined);
    return preparation.promise;
  });
  const startup = startHostedWorld(f.processes, env, async () => ({ prepareHostedOperation }));
  try {
    await preparing.promise;
    expect(await f.processes.stop()).toBe(0);
    expect(f.processes.signal.aborted).toBe(true);
    preparation.resolve(prepared);
    await startup;
    expect(f.spawnProcess).toHaveBeenCalledTimes(4);
    expect(mqtt.brokerCommand).not.toHaveBeenCalled();
    expect(mqtt.waitForBroker).not.toHaveBeenCalled();
    expect(f.children.has('world')).toBe(false);
    expect(f.children.has('world-mqtt')).toBe(false);
  } finally {
    preparation.resolve(prepared);
    await f.close();
    await startup.catch(() => {});
  }
});

test('stopping a world awaiting ready IPC keeps all dependencies alive through its stopped acknowledgement and exit', async () => {
  const f = runtimeFixture(false);
  const startup = startHostedWorld(f.processes, env, async () => ({
    prepareHostedOperation: async () => prepared,
  }));
  const cancelled = expect(startup).rejects.toThrow(/stopping/);
  try {
    const world = await f.worldStarted.promise;
    f.events.length = 0;
    const closed = f.processes.stop();
    await cancelled;
    expect(f.processes.resumeWorld()).toBe(false);
    expect(f.events).toEqual(['world:operation_world_stop']);
    expect(world.messages).toEqual([{ event: 'operation_world_stop', runId }]);
    for (const name of ['api', 'workers', 'emulators', 'mqtt', 'world-mqtt'])
      expect(f.children.get(name)!.exited).toBe(false);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    const schedule = vi.spyOn(globalThis, 'setTimeout');
    try {
      world.emit('message', { event: 'operation_world_ready', runId, paused: true, pending: 7 });
      expect(world.messages).toHaveLength(2);
      expect(world.messages[1]).toEqual(world.messages[0]);
      expect(schedule).not.toHaveBeenCalled();
    } finally {
      schedule.mockRestore();
    }
    expect(f.spawnProcess).toHaveBeenCalledTimes(6);
    world.finishWorld();
    expect(await closed).toBe(0);
    expect(f.events).toEqual([
      'world:operation_world_stop',
      'world:operation_world_stop',
      'world:stopped',
      'world:exit',
      'api:SIGTERM',
      'api:exit',
      'workers:SIGTERM',
      'workers:exit',
      'emulators:SIGTERM',
      'emulators:exit',
      'mqtt:SIGTERM',
      'mqtt:exit',
      'world-mqtt:SIGTERM',
      'world-mqtt:exit',
    ]);
  } finally {
    await f.close();
    await startup.catch(() => {});
  }
});

test('a world exit without its stopped report cannot confirm a clean startup cancellation', async () => {
  const f = runtimeFixture(false);
  const startup = startHostedWorld(f.processes, env, async () => ({
    prepareHostedOperation: async () => prepared,
  }));
  const cancelled = expect(startup).rejects.toThrow(/stopping/);
  try {
    const world = await f.worldStarted.promise;
    const closed = f.processes.stop();
    await cancelled;
    world.exit();
    expect(await closed).toBe(1);
  } finally {
    await f.close();
    await startup.catch(() => {});
  }
});
