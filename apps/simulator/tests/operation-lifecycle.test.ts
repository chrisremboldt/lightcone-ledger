import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOperation } from '../../../packages/simulation-models/src/operation.js';
import type { PreparedWorldFact } from '../src/operation-delivery.js';
import { runOperation } from '../src/operation.js';
import {
  advanceLiveClock,
  initialOperationCheckpoint,
  OperationStore,
  readOperationCheckpoint,
} from '../src/operation-state.js';

const mocks = vi.hoisted(() => ({
  readiness: vi.fn(),
  bindings: vi.fn(),
  lease: vi.fn(),
  release: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  interrupted: vi.fn(),
  deliver: vi.fn(),
  readCheckpoint: vi.fn(),
  transportSignal: undefined as AbortSignal | undefined,
}));

vi.mock('../src/operation-readiness.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/operation-readiness.js')>()),
  checkOperationReadiness: mocks.readiness,
}));
vi.mock('../src/operation-broker.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/operation-broker.js')>()),
  loadOperationBindings: mocks.bindings,
}));
vi.mock('../src/control-lease.js', () => ({ acquireControlLease: mocks.lease }));
vi.mock('../src/operation-transport.js', () => ({
  OperationTransport: class {
    constructor(config: { signal?: AbortSignal }) {
      mocks.transportSignal = config.signal;
    }
    start = mocks.start;
    stop = mocks.stop;
    setTelemetryDeliveryInterrupted = mocks.interrupted;
  },
}));
vi.mock('../src/operation-delivery.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/operation-delivery.js')>()),
  OperationDelivery: class {
    deliver = mocks.deliver;
  },
}));
vi.mock('../src/operation-state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/operation-state.js')>()),
  readOperationCheckpoint: mocks.readCheckpoint,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('The mocked operation lifecycle did not make progress')), 4000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function progress<T>(event: Promise<T>, running: Promise<void>): Promise<T> {
  return bounded(
    Promise.race([
      event,
      running.then(() => {
        throw new Error('The operation stopped before its expected lifecycle event');
      }),
    ]),
  );
}

async function waitForPaused(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if ((await readOperationCheckpoint(path))?.clock.paused) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('The lifecycle stop did not retain its pause');
}

const start = Date.parse('2026-10-18T12:00:00.000Z');

function environment(path: string) {
  return {
    SIMULATOR_WORLD_MODE: 'live',
    SIMULATOR_WORLD_STATE: path,
    SIMULATOR_WORLD_RUN_ID: 'lifecycle',
    SIMULATOR_WORLD_START: new Date(start).toISOString(),
    LEDGER_ENV: 'local',
    LEDGER_API_URL: 'http://127.0.0.1:14400',
    EMULATOR_BASE_URL: 'http://127.0.0.1:14402',
    SIMULATOR_WORLD_MQTT_URL: 'mqtt://127.0.0.1:14483',
    SIMULATOR_WORLD_CALLBACK_PORT: '14403',
  };
}

async function pendingWorld(path: string, paused: boolean, runId = 'lifecycle') {
  const world = createOperation({
    runId,
    start: new Date(start).toISOString(),
    fleet: { alpha: 1, beta: 1 },
    demandIntervalMs: 120_000,
  });
  const store = new OperationStore(
    path,
    initialOperationCheckpoint(world, { mode: 'live', wallAt: start, paused: false }),
  );
  await store.update((state) => {
    advanceLiveClock(state, start, false);
    state.clock.paused = paused;
  });
  const originals = Object.values(store.state.pending).flat();
  expect(originals.length).toBeGreaterThan(1);
  return {
    originals: structuredClone(originals),
    worldNow: store.state.world.now,
    nextFact: store.state.world.nextFact,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readCheckpoint.mockReset();
  mocks.readCheckpoint.mockImplementation(async (path: string) => {
    const actual = await vi.importActual<typeof import('../src/operation-state.js')>('../src/operation-state.js');
    return actual.readOperationCheckpoint(path);
  });
  mocks.readiness.mockResolvedValue({});
  mocks.bindings.mockResolvedValue({});
  mocks.release.mockResolvedValue(undefined);
  mocks.lease.mockResolvedValue({ headers: () => ({}), release: mocks.release });
  mocks.start.mockResolvedValue(undefined);
  mocks.stop.mockResolvedValue(undefined);
  mocks.interrupted.mockResolvedValue(undefined);
  mocks.deliver.mockImplementation(async (prepared: PreparedWorldFact) => ({
    receiptId: `lifecycle-receipt-${prepared.fact.sequence}`,
  }));
  mocks.transportSignal = undefined;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('Lifecycle tests cannot contact a service'))),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('managed operation lifecycle', () => {
  it('retains a pause and releases its transport, lease and lock when stopped during startup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-operation-lifecycle-'));
    const path = join(directory, 'world.json');
    const controller = new AbortController();
    const enteringStart = deferred<void>();
    const finishStart = deferred<void>();
    const events: string[] = [];
    const ready = vi.fn();
    const stopped = vi.fn((state: { runId: string; pending: number; drained: boolean }) => {
      events.push('stopped');
      expect(existsSync(`${path}.lock`)).toBe(false);
      expect(state).toEqual({ runId: 'lifecycle', pending: 0, drained: true });
    });
    let running: Promise<void> | undefined;
    try {
      vi.spyOn(Date, 'now').mockReturnValue(start);
      mocks.start.mockImplementation(async () => {
        enteringStart.resolve();
        await finishStart.promise;
      });
      mocks.stop.mockImplementation(async () => {
        events.push('transport-stop');
      });
      mocks.release.mockImplementation(async () => {
        events.push('lease-release');
      });
      running = runOperation(environment(path), { signal: controller.signal, onReady: ready, onStopped: stopped });
      await progress(enteringStart.promise, running);
      controller.abort();
      controller.abort();
      finishStart.resolve();
      await bounded(running);
      running = undefined;
      expect(ready).not.toHaveBeenCalled();
      expect(mocks.deliver).not.toHaveBeenCalled();
      expect(mocks.stop).toHaveBeenCalledTimes(1);
      expect(mocks.release).toHaveBeenCalledTimes(1);
      expect(stopped).toHaveBeenCalledTimes(1);
      expect(events).toEqual(['transport-stop', 'lease-release', 'stopped']);
      const retained = (await readOperationCheckpoint(path))!;
      expect(retained.clock.paused).toBe(true);
      expect(retained.world.now).toBe(start);
      expect(retained.world.nextFact).toBe(0);
      await expect(readFile(`${path}.lock`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      controller.abort();
      finishStart.resolve();
      if (running) await bounded(running).catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('becomes ready after initialization and drains exact queued originals before acknowledging repeated stop', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-operation-lifecycle-'));
    const path = join(directory, 'world.json');
    const controller = new AbortController();
    const ready = deferred<{
      state: { runId: string; paused: boolean; pending: number };
      resume: () => Promise<void>;
    }>();
    const allowReadyReturn = deferred<void>();
    const deliveryEntered = deferred<void>();
    const finishDelivery = deferred<void>();
    const events: string[] = [];
    const delivered: PreparedWorldFact[] = [];
    const stopped = vi.fn(() => {
      events.push('stopped');
      expect(existsSync(`${path}.lock`)).toBe(false);
    });
    let running: Promise<void> | undefined;
    try {
      vi.spyOn(Date, 'now').mockReturnValue(start);
      const initial = await pendingWorld(path, true);
      const originals = new Map(initial.originals.map((entry) => [entry.fact.sequence, JSON.stringify(entry)]));
      mocks.start.mockImplementation(async () => {
        events.push('transport-started');
      });
      mocks.stop.mockImplementation(async () => {
        events.push('transport-stop');
      });
      mocks.release.mockImplementation(async () => {
        events.push('lease-release');
      });
      mocks.deliver.mockImplementation(async (prepared: PreparedWorldFact) => {
        expect(JSON.stringify(prepared)).toBe(originals.get(prepared.fact.sequence));
        delivered.push(structuredClone(prepared));
        if (delivered.length === 1) {
          deliveryEntered.resolve();
          await finishDelivery.promise;
        }
        return { receiptId: `lifecycle-receipt-${prepared.fact.sequence}` };
      });
      running = runOperation(environment(path), {
        signal: controller.signal,
        onReady: async (state, resume) => {
          events.push('ready');
          ready.resolve({ state, resume });
          await allowReadyReturn.promise;
        },
        onStopped: stopped,
      });
      const started = await progress(ready.promise, running);
      expect(started.state).toEqual({ runId: 'lifecycle', paused: true, pending: initial.originals.length });
      expect(events).toEqual(['transport-started', 'ready']);
      await started.resume();
      await started.resume();
      controller.abort();
      controller.abort();
      await started.resume();
      allowReadyReturn.resolve();
      await progress(deliveryEntered.promise, running);
      await waitForPaused(path);
      expect(stopped).not.toHaveBeenCalled();
      expect(mocks.stop).not.toHaveBeenCalled();
      const duringStop = (await readOperationCheckpoint(path))!;
      expect(duringStop.world.now).toBe(initial.worldNow);
      expect(JSON.stringify(Object.values(duringStop.pending).flat())).toBe(JSON.stringify(initial.originals));
      finishDelivery.resolve();
      await bounded(running);
      running = undefined;
      expect(delivered.map((entry) => entry.fact.sequence)).toEqual(
        initial.originals.map((entry) => entry.fact.sequence),
      );
      const retained = (await readOperationCheckpoint(path))!;
      expect(retained.pending).toEqual({});
      expect(retained.accepted).toBe(initial.originals.length);
      expect(retained.world.nextFact).toBe(initial.nextFact);
      expect(retained.world.now).toBe(initial.worldNow);
      expect(retained.clock.paused).toBe(true);
      expect(stopped).toHaveBeenCalledExactlyOnceWith({ runId: 'lifecycle', pending: 0, drained: true });
      expect(events.slice(-3)).toEqual(['transport-stop', 'lease-release', 'stopped']);
    } finally {
      controller.abort();
      allowReadyReturn.resolve();
      finishDelivery.resolve();
      if (running) await bounded(running).catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('ends the fixed drain window with paused, unchanged originals and an honest remaining count', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-operation-lifecycle-'));
    const path = join(directory, 'world.json');
    const controller = new AbortController();
    const deliveryEntered = deferred<void>();
    const stopped = vi.fn();
    const aborted = vi.fn();
    let now = start;
    let running: Promise<void> | undefined;
    try {
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      const initial = await pendingWorld(path, false);
      mocks.deliver.mockImplementation(() => {
        deliveryEntered.resolve();
        const signal = mocks.transportSignal!;
        expect(signal).toBeInstanceOf(AbortSignal);
        return new Promise<never>((_resolve, reject) => {
          const cancel = () => {
            aborted();
            reject(new Error('Fixture delivery stopped at its global drain deadline'));
          };
          if (signal.aborted) cancel();
          else signal.addEventListener('abort', cancel, { once: true });
        });
      });
      running = runOperation(environment(path), { signal: controller.signal, onStopped: stopped });
      await progress(deliveryEntered.promise, running);
      controller.abort();
      await waitForPaused(path);
      expect(stopped).not.toHaveBeenCalled();
      expect(aborted).not.toHaveBeenCalled();
      now = start + 120_000;
      await bounded(running);
      running = undefined;
      const retained = (await readOperationCheckpoint(path))!;
      expect(retained.clock.paused).toBe(true);
      expect(retained.world.now).toBe(initial.worldNow);
      expect(retained.world.nextFact).toBe(initial.nextFact);
      expect(retained.accepted).toBe(0);
      expect(JSON.stringify(Object.values(retained.pending).flat())).toBe(JSON.stringify(initial.originals));
      expect(stopped).toHaveBeenCalledExactlyOnceWith({
        runId: 'lifecycle',
        pending: initial.originals.length,
        drained: false,
      });
      expect(mocks.stop).toHaveBeenCalledTimes(1);
      expect(mocks.release).toHaveBeenCalledTimes(1);
      expect(aborted).toHaveBeenCalledTimes(1);
      await expect(readFile(`${path}.lock`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      controller.abort();
      now = start + 240_000;
      if (running) await bounded(running).catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses to pause or acknowledge a foreign checkpoint when stopped before retained identity validation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-operation-lifecycle-'));
    const path = join(directory, 'world.json');
    const controller = new AbortController();
    const readEntered = deferred<void>();
    const allowRead = deferred<void>();
    const stopped = vi.fn();
    let running: Promise<void> | undefined;
    try {
      vi.spyOn(Date, 'now').mockReturnValue(start);
      await pendingWorld(path, false, 'foreign-lifecycle');
      const original = await readFile(path, 'utf8');
      const actual = await vi.importActual<typeof import('../src/operation-state.js')>('../src/operation-state.js');
      mocks.readCheckpoint.mockImplementationOnce(async (selectedPath: string) => {
        readEntered.resolve();
        await allowRead.promise;
        return actual.readOperationCheckpoint(selectedPath);
      });
      running = runOperation(environment(path), { signal: controller.signal, onStopped: stopped });
      await progress(readEntered.promise, running);
      controller.abort();
      allowRead.resolve();
      await expect(bounded(running)).rejects.toThrow('Checkpoint belongs to a different world or clock mode');
      running = undefined;
      expect(await readFile(path, 'utf8')).toBe(original);
      expect((await readOperationCheckpoint(path))!.clock.paused).toBe(false);
      expect(stopped).not.toHaveBeenCalled();
      expect(mocks.readiness).not.toHaveBeenCalled();
      expect(mocks.start).not.toHaveBeenCalled();
      await expect(readFile(`${path}.lock`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      controller.abort();
      allowRead.resolve();
      if (running) await bounded(running).catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('resumes once and prevents repeated resume writes or clock changes during error cleanup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-operation-lifecycle-'));
    const path = join(directory, 'world.json');
    const controller = new AbortController();
    const ready = deferred<() => Promise<void>>();
    const failReady = deferred<void>();
    const cleanupEntered = deferred<void>();
    const allowCleanup = deferred<void>();
    const failure = new Error('Fixture ready callback failed');
    const stopped = vi.fn();
    const previousPauseListeners = new Set(process.listeners('SIGUSR1'));
    let now = start;
    let running: Promise<void> | undefined;
    try {
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      await pendingWorld(path, true);
      now = start + 15_000;
      mocks.stop.mockImplementation(async () => {
        cleanupEntered.resolve();
        await allowCleanup.promise;
      });
      running = runOperation(environment(path), {
        signal: controller.signal,
        onReady: async (_state, resume) => {
          ready.resolve(resume);
          await failReady.promise;
          throw failure;
        },
        onStopped: stopped,
      });
      const resume = await progress(ready.promise, running);
      await resume();
      const resumed = (await readOperationCheckpoint(path))!;
      expect(resumed.clock.paused).toBe(false);
      expect(resumed.world.now).toBe(now);
      const original = await readFile(path, 'utf8');
      now += 15_000;
      await resume();
      expect(await readFile(path, 'utf8')).toBe(original);
      const togglePause = process.listeners('SIGUSR1').find((listener) => !previousPauseListeners.has(listener));
      expect(togglePause).toBeDefined();
      togglePause!();
      await waitForPaused(path);

      failReady.resolve();
      await progress(cleanupEntered.promise, running);
      const beforeCleanupResume = await readFile(path, 'utf8');
      now += 30_000;
      await resume();
      expect(await readFile(path, 'utf8')).toBe(beforeCleanupResume);
      expect(mocks.deliver).not.toHaveBeenCalled();
      allowCleanup.resolve();
      await expect(bounded(running)).rejects.toBe(failure);
      running = undefined;
      expect(stopped).not.toHaveBeenCalled();
      expect(mocks.release).toHaveBeenCalledTimes(1);
      await expect(readFile(`${path}.lock`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      controller.abort();
      failReady.resolve();
      allowCleanup.resolve();
      if (running) await bounded(running).catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  });
});
