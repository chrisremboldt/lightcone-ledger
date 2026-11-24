import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOperation, operationCapacityPreset } from '../../../packages/simulation-models/src/operation.js';
import type { PreparedWorldFact } from '../src/operation-delivery.js';
import { createOperationMonitoringRuntimeState } from '../src/operation-monitoring-runtime.js';
import * as revisionConsumer from '../src/operation-reservation-revision.js';
import {
  advanceLiveClock,
  initialOperationCheckpoint,
  OperationStore,
  readOperationCheckpoint,
} from '../src/operation-state.js';
import { HOSTED_WORLD_LIMITS } from '../src/operation-target.js';
import { HOSTED_OPERATION_DRAIN_MS, runOperation } from '../src/operation.js';
import { prepareSmsRevision } from '../src/sms-rehearsal-plan.js';
import { configV3, prepared } from './sms-rehearsal-fixtures.js';

const mocks = vi.hoisted(() => ({
  target: vi.fn(),
  hosted: vi.fn(),
  monitoring: vi.fn(),
  readiness: vi.fn(),
  bindings: vi.fn(),
  lease: vi.fn(),
  release: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  interrupted: vi.fn(),
  deliver: vi.fn(),
}));

vi.mock('../src/operation-target.js', async (original) => ({
  ...(await original<typeof import('../src/operation-target.js')>()),
  operationTarget: mocks.target,
}));
vi.mock('../src/hosted-sms-target.js', async (original) => ({
  ...(await original<typeof import('../src/hosted-sms-target.js')>()),
  loadHostedSmsTarget: mocks.hosted,
}));
vi.mock('../src/operation-monitoring-options.js', () => ({ loadOperationMonitoringRuntime: mocks.monitoring }));
vi.mock('../src/operation-readiness.js', () => ({
  checkOperationReadiness: mocks.readiness,
  assertOperationSourceReadiness: vi.fn(),
}));
vi.mock('../src/operation-broker.js', async (original) => ({
  ...(await original<typeof import('../src/operation-broker.js')>()),
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
vi.mock('../src/operation-delivery.js', async (original) => ({
  ...(await original<typeof import('../src/operation-delivery.js')>()),
  OperationDelivery: class {
    deliver = mocks.deliver;
  },
}));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('The hosted SMS fixture did not make progress')), 6000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function progress<T>(event: Promise<T>, running: Promise<void>): Promise<T> {
  return bounded(Promise.race([event, running.then(() => Promise.reject(new Error('The runner stopped early')))]));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

describe('hosted SMS revision runner', () => {
  it('keeps a retained pause until resumed, catches up in bounded steps, revises once and drains before cleanup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-hosted-sms-runner-'));
    const path = join(directory, 'world.json');
    const { followup } = prepared(configV3());
    if (followup.version !== 3) throw new Error('The hosted fixture must retain version three');
    const world = createOperation({
      ...operationCapacityPreset(followup.config.capacityPreset),
      runId: followup.runId,
      start: followup.start,
      seed: followup.config.seed,
      fleet: followup.config.fleet,
      missionPlan: 'dispatch-plan.1',
      predeparture: followup.profile.predeparture!,
      selectedDemandWindow: {
        attemptId: followup.identities.attemptId,
        ...followup.missionChange.operatingInterval,
      },
      simulatedLink: {
        version: 'simulated-link.1',
        attemptId: followup.identities.attemptId,
        initialState: followup.monitoring.radioInitialState,
      },
    });
    const initial = initialOperationCheckpoint(world, { mode: 'live', wallAt: world.now, paused: false });
    initial.monitoring = createOperationMonitoringRuntimeState(followup.monitoring, world);
    const store = new OperationStore(path, initial);
    await store.update((state) => {
      advanceLiveClock(state, Date.parse(followup.preparedAt), false);
      state.clock.paused = true;
    });
    const selected = store.state.world.reservations!.find((row) => row.id === followup.identities.attemptId)!;
    const revision = prepareSmsRevision(followup, selected);
    const retainedAt = store.state.world.now;
    const wallAt = retainedAt + 4000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(wallAt);
    const events: string[] = [];
    const ready = deferred<() => Promise<void>>();
    const backgroundEntered = deferred();
    const finishBackground = deferred();
    const afterRevisionEntered = deferred();
    const finishAfterRevision = deferred();
    const revised = deferred<revisionConsumer.OperationReservationRevisionResult>();
    const controller = new AbortController();
    const deliveries: PreparedWorldFact[] = [];
    const steps: number[] = [];
    let resumed = false;
    let revisionRetained = false;
    let backgroundCount = 0;
    let heldAfterRevision = false;
    let running: Promise<void> | undefined;
    try {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const fetcher = vi.fn(() => Promise.reject(new Error('The hosted SMS fixture cannot contact services')));
      vi.stubGlobal('fetch', fetcher);
      mocks.target.mockReturnValue({
        environment: 'staging',
        mqttPort: 1884,
        sms: { directory: followup.config.directory, phase: 'followup', preparationPath: 'fixture-preparation' },
      });
      mocks.hosted.mockResolvedValue({ preparation: followup, revision });
      mocks.monitoring.mockResolvedValue({
        plan: followup.monitoring,
        run: vi.fn(async () => ({ status: 'pending', code: 'observation_pending' })),
      });
      mocks.readiness.mockResolvedValue({});
      mocks.bindings.mockResolvedValue({});
      mocks.start.mockResolvedValue(undefined);
      mocks.interrupted.mockResolvedValue(undefined);
      mocks.stop.mockImplementation(async () => {
        events.push('transport-stop');
      });
      mocks.release.mockImplementation(async () => {
        events.push('lease-release');
      });
      mocks.lease.mockResolvedValue({ headers: () => ({}), release: mocks.release });
      const update = OperationStore.prototype.update;
      vi.spyOn(OperationStore.prototype, 'update').mockImplementation(function (this: OperationStore, change) {
        return update.call(this, (state) => {
          const before = state.world.now;
          change(state);
          const elapsed = state.world.now - before;
          expect(elapsed).toBeGreaterThanOrEqual(0);
          expect(elapsed).toBeLessThanOrEqual(HOSTED_WORLD_LIMITS.advanceMs);
          if (elapsed) steps.push(elapsed);
        });
      });
      const revise = revisionConsumer.runOperationReservationRevision;
      const revisionRun = vi
        .spyOn(revisionConsumer, 'runOperationReservationRevision')
        .mockImplementation(async (...args) => {
          expect(resumed).toBe(true);
          const result = await revise(...args);
          revisionRetained = true;
          revised.resolve(result);
          return result;
        });
      mocks.deliver.mockImplementation(async (original: PreparedWorldFact) => {
        deliveries.push(structuredClone(original));
        if (original.fact.tenant === 'beta' && !['mission', 'command-link'].includes(original.fact.kind)) {
          backgroundCount++;
          if (backgroundCount === 1) {
            backgroundEntered.resolve();
            await finishBackground.promise;
          } else if (revisionRetained && !heldAfterRevision) {
            heldAfterRevision = true;
            afterRevisionEntered.resolve();
            await finishAfterRevision.promise;
          }
        }
        return { receiptId: `hosted-sms-receipt-${original.fact.sequence}` };
      });
      const stopped = vi.fn(() => {
        events.push('stopped');
        expect(existsSync(`${path}.lock`)).toBe(false);
      });
      running = runOperation(
        {
          ...followup.environment,
          SIMULATOR_WORLD_MODE: 'live',
          SIMULATOR_WORLD_STATE: path,
          SIMULATOR_WORLD_REVISION_PLAN: join(directory, 'revision.plan.json'),
          SIMULATOR_WORLD_MONITORING_TOKEN: 'fixture-hosted-monitoring-credential',
          EMULATOR_ADMIN_KEY: 'fixture-hosted-emulator-admin-credential',
          PARTNER_API_KEY: 'fixture-hosted-partner-credential',
          AIRSPACE_USER_CLIENT_ID: 'fixture-hosted-user-client',
          AIRSPACE_CALLBACK_SECRET: 'fixture-hosted-callback-credential',
          ALPHA_SOURCE_TOKEN: 'fixture-hosted-alpha-source-credential',
          ALPHA_ACTOR_TOKEN: 'fixture-hosted-alpha-actor-credential',
          BETA_SOURCE_TOKEN: 'fixture-hosted-beta-source-credential',
          BETA_ACTOR_TOKEN: 'fixture-hosted-beta-actor-credential',
        },
        {
          signal: controller.signal,
          onReady(state, resume) {
            expect(state).toMatchObject({ runId: followup.runId, paused: true });
            expect(revisionRun).not.toHaveBeenCalled();
            ready.resolve(resume);
          },
          onStopped: stopped,
        },
      );
      const resume = await progress(ready.promise, running);
      await progress(backgroundEntered.promise, running);
      expect((await readOperationCheckpoint(path))!.clock.paused).toBe(true);
      expect(revisionRun).not.toHaveBeenCalled();
      resumed = true;
      await resume();
      expect(await progress(revised.promise, running)).toMatchObject({ status: 'revised', sourceRevision: 2 });
      expect((await readOperationCheckpoint(path))!.world.now).toBe(wallAt);
      expect(steps.length).toBeGreaterThanOrEqual(4);
      finishBackground.resolve();
      await progress(afterRevisionEntered.promise, running);
      expect(revisionRun).toHaveBeenCalledTimes(1);
      controller.abort();
      expect(stopped).not.toHaveBeenCalled();
      expect(mocks.stop).not.toHaveBeenCalled();
      finishAfterRevision.resolve();
      await bounded(running);
      running = undefined;
      const retained = (await readOperationCheckpoint(path))!;
      expect(retained.clock.paused).toBe(true);
      expect(retained.world.now).toBe(wallAt);
      expect(retained.reservationRevision?.sourceRevision).toBe(2);
      expect(retained.world.reservations!.find((row) => row.id === selected.id)!.plan.sourceRevision).toBe(2);
      expect(retained.departureJob).toBeUndefined();
      expect(retained.pending).toEqual({});
      expect(revisionRun).toHaveBeenCalledTimes(1);
      expect(
        deliveries.filter((entry) => entry.fact.kind === 'mission' && entry.fact.source.sourceRevision === 2),
      ).toHaveLength(1);
      expect(stopped).toHaveBeenCalledExactlyOnceWith({ runId: followup.runId, pending: 0, drained: true });
      expect(events).toEqual(['transport-stop', 'lease-release', 'stopped']);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      finishBackground.resolve();
      finishAfterRevision.resolve();
      now.mockReturnValue(wallAt + HOSTED_OPERATION_DRAIN_MS + 1);
      if (running) await bounded(running).catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  });
});
