import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createOperation, operationCapacityPreset } from '../../../packages/simulation-models/src/operation.js';
import type { MissionDeparturePlan } from '../src/mission-departure-plan.js';
import type { OperationDepartureResult } from '../src/operation-departure-consumer.js';
import type { PreparedWorldFact } from '../src/operation-delivery.js';
import { runOperation } from '../src/operation.js';
import {
  advanceLiveClock,
  initialOperationCheckpoint,
  OperationStore,
  readOperationCheckpoint,
} from '../src/operation-state.js';

const mocks = vi.hoisted(() => ({
  readiness: vi.fn().mockResolvedValue({}),
  bindings: vi.fn().mockResolvedValue({}),
  lease: vi.fn(),
  release: vi.fn().mockResolvedValue(undefined),
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  interrupted: vi.fn().mockResolvedValue(undefined),
  deliver: vi.fn(),
  loadDeparture: vi.fn(),
}));

vi.mock('../src/operation-readiness.js', () => ({ checkOperationReadiness: mocks.readiness }));
vi.mock('../src/operation-broker.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/operation-broker.js')>()),
  loadOperationBindings: mocks.bindings,
}));
vi.mock('../src/control-lease.js', () => ({ acquireControlLease: mocks.lease }));
vi.mock('../src/operation-transport.js', () => ({
  OperationTransport: class {
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
vi.mock('../src/operation-departure-runtime.js', () => ({ loadOperationDepartureRuntime: mocks.loadDeparture }));

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
        timer = setTimeout(() => reject(new Error('The mocked live runner did not make progress')), 3000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe('selected departure in the live world runner', () => {
  it('keeps background delivery moving during one pending authorization and persists pause before clean shutdown', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-departure-runner-'));
    const path = join(directory, 'world.json');
    const start = Date.parse('2026-10-16T14:00:00.000Z');
    let now = start;
    let stop: (() => void) | undefined;
    let togglePause: (() => void) | undefined;
    let running: Promise<void> | undefined;
    const selected = deferred<OperationStore>();
    const authorization = deferred<OperationDepartureResult>();
    const advancedDelivery = deferred<PreparedWorldFact>();
    const held: OperationDepartureResult = {
      status: 'held',
      code: 'authorization_uncertain',
      reason: 'The selected authorization response remains unavailable',
      flightId: 'selected-ledger-flight',
    };
    try {
      const preset = operationCapacityPreset('illustrative-25.1');
      const world = createOperation({
        ...preset,
        runId: 'departure-runner',
        start: new Date(start).toISOString(),
        fleet: { alpha: 1, beta: 1 },
        capacity: {
          ...preset.capacity,
          demandIntervalMs: { alpha: 120_000, beta: 120_000 },
          flightPeople: { alpha: 1, beta: 1 },
          turnaroundCrews: { alpha: 1, beta: 1 },
          chargers: { alpha: 1, beta: 1 },
          launchPads: { alpha: 1, beta: 1 },
        },
        sampleIntervalMs: 5000,
        predeparture: { version: 'reserve-await-release.1', tenant: 'beta' },
      });
      const initial = new OperationStore(
        path,
        initialOperationCheckpoint(world, { mode: 'live', wallAt: start, paused: false }),
      );
      await initial.update((state) => advanceLiveClock(state, start, false));
      const reservation = initial.state.world.reservations![0]!;
      const plan: MissionDeparturePlan = {
        version: 1,
        apiUrl: 'http://127.0.0.1:14300',
        tenantId: 'tenant-beta',
        principalId: 'selected-beta-human',
        runId: world.config.runId,
        reservationId: reservation.id,
        flightId: held.flightId,
        aircraftId: reservation.aircraftId,
        release: { id: 'selected-release', digest: '1'.repeat(64) },
        mission: {
          missionId: reservation.plan.sourceMissionId,
          sourceRevision: reservation.plan.sourceRevision,
          eventId: 'selected-mission-event',
          contentDigest: '2'.repeat(64),
          recordDigest: '3'.repeat(64),
        },
        departureAttemptId: `${reservation.id}:departure:1`,
        marginMs: 10_000,
        latencyMarginMs: 1000,
        handoffAllowanceMs: 5000,
        allocationDurationMs: 90_000,
      };
      const departureRun = vi.fn((store: OperationStore) => {
        selected.resolve(store);
        return authorization.promise;
      });
      mocks.loadDeparture.mockResolvedValue({ plan, run: departureRun });
      mocks.lease.mockResolvedValue({ headers: () => ({}), release: mocks.release });
      mocks.deliver.mockImplementation(async (prepared: PreparedWorldFact) => {
        if (
          prepared.fact.tenant === 'alpha' &&
          prepared.fact.kind === 'position' &&
          Date.parse(prepared.fact.at) > start
        )
          advancedDelivery.resolve(structuredClone(prepared));
        return { receiptId: `mock-receipt-${prepared.fact.sequence}` };
      });
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const fetcher = vi.fn(() => {
        throw new Error('The runner fixture must not contact a service');
      });
      vi.stubGlobal('fetch', fetcher);
      const on = process.on.bind(process);
      vi.spyOn(process, 'on').mockImplementation((event, listener) => {
        if (event === 'SIGTERM') stop = () => listener();
        else if (event === 'SIGUSR1') togglePause = () => listener();
        else on(event, listener);
        return process;
      });
      const env = {
        SIMULATOR_WORLD_MODE: 'live',
        SIMULATOR_WORLD_STATE: path,
        LEDGER_ENV: 'local',
        LEDGER_API_URL: plan.apiUrl,
        EMULATOR_BASE_URL: 'http://127.0.0.1:14302',
        SIMULATOR_WORLD_MQTT_URL: 'mqtt://127.0.0.1:14383',
        SIMULATOR_WORLD_CALLBACK_PORT: '14303',
        SIMULATOR_WORLD_DEPARTURE_PLAN: join(directory, 'departure-plan.json'),
        SIMULATOR_WORLD_DEPARTURE_STATE: join(directory, 'departure-journal.json'),
        SIMULATOR_WORLD_DEPARTURE_TOKEN: 'mock-selected-human-credential',
      };
      running = runOperation(env);
      const store = await bounded(
        Promise.race([
          selected.promise,
          running.then(() => {
            throw new Error('The live runner stopped before invoking the selected departure');
          }),
        ]),
      );
      expect(store).toBeInstanceOf(OperationStore);
      expect(store).not.toBe(initial);
      expect(store.state.world.config.runId).toBe(plan.runId);
      expect(mocks.loadDeparture).toHaveBeenCalledWith(env, path, plan.apiUrl);
      expect(stop).toBeDefined();
      expect(togglePause).toBeDefined();
      const factsBeforePause = store.state.world.nextFact;

      togglePause!();
      await store.update(() => {});
      expect(store.state.clock.paused).toBe(true);
      expect((await readOperationCheckpoint(path))!.clock.paused).toBe(true);
      now += 15_000;
      await new Promise((resolve) => setTimeout(resolve, 300));
      await store.update(() => {});
      expect(store.state.world.now).toBe(start);
      expect(store.state.world.nextFact).toBe(factsBeforePause);
      togglePause!();
      await store.update(() => {});
      const delivered = await bounded(advancedDelivery.promise);
      await Promise.resolve();
      await store.update(() => {});
      expect(delivered.fact).toMatchObject({ tenant: 'alpha', kind: 'position' });
      expect(Date.parse(delivered.fact.at)).toBeGreaterThan(start);
      expect(
        Object.values(store.state.pending)
          .flat()
          .some((entry) => entry.fact.sequence === delivered.fact.sequence),
      ).toBe(false);
      expect(store.state.world.now).toBe(now);
      expect(store.state.world.nextFact).toBeGreaterThan(factsBeforePause);
      expect(store.state.clock.paused).toBe(false);
      expect(store.state.world.reservations!.find((row) => row.id === reservation.id)).toEqual(reservation);
      expect(store.state.world.departures ?? []).toEqual([]);
      expect(mocks.stop).not.toHaveBeenCalled();
      expect(departureRun).toHaveBeenCalledTimes(1);
      expect(departureRun).toHaveBeenCalledWith(store);

      authorization.resolve(held);
      stop!();
      await bounded(running);
      running = undefined;
      expect(mocks.start).toHaveBeenCalledTimes(1);
      expect(mocks.stop).toHaveBeenCalledTimes(1);
      expect(mocks.release).toHaveBeenCalledTimes(1);
      expect(fetcher).not.toHaveBeenCalled();
      await expect(readFile(`${path}.lock`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      authorization.resolve(held);
      stop?.();
      if (running) await bounded(running).catch(() => {});
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
