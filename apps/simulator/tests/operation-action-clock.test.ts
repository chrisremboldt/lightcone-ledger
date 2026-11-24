import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalDigest } from '@ledger/integrity';
import { createOperation, operationCapacityPreset } from '../../../packages/simulation-models/src/operation.js';
import { hostedActionClock } from '../src/operation-action-clock.js';
import {
  runOperationReservationRevision,
  type OperationReservationRevisionPlan,
} from '../src/operation-reservation-revision.js';
import {
  advanceLiveClock,
  initialOperationCheckpoint,
  OperationStore,
  readOperationCheckpoint,
} from '../src/operation-state.js';
import { HOSTED_WORLD_LIMITS } from '../src/operation-target.js';

const start = Date.parse('2026-10-16T14:00:00.000Z');
const iso = (at: number) => new Date(at).toISOString();
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function checkpoint() {
  const world = createOperation({ runId: 'action-clock', start: iso(start), fleet: { alpha: 1, beta: 1 } });
  return initialOperationCheckpoint(world, { mode: 'live', wallAt: start, paused: false });
}

describe('hosted action clock', () => {
  it('advances only an aligned live clock within the scheduler step and refuses unsafe actions without mutation', () => {
    const state = checkpoint();
    hostedActionClock(() => false)(state, start + HOSTED_WORLD_LIMITS.advanceMs);
    expect(state.world.now).toBe(start + HOSTED_WORLD_LIMITS.advanceMs);
    expect(state.clock.wallAt).toBe(state.world.now);
    const cases = [
      { stopping: true, paused: false, lag: 0, pending: 0, code: 'world_stopping' },
      {
        stopping: false,
        paused: false,
        lag: HOSTED_WORLD_LIMITS.advanceMs + 1,
        pending: 0,
        code: 'world_clock_lagging',
      },
      { stopping: false, paused: true, lag: 0, pending: 0, code: 'world_clock_unavailable' },
      { stopping: false, paused: false, lag: 0, pending: HOSTED_WORLD_LIMITS.pendingFacts, code: 'world_backpressure' },
    ];
    for (const example of cases) {
      const refused = checkpoint();
      refused.clock.paused = example.paused;
      refused.world.nextFact = example.pending;
      const original = structuredClone(refused);
      let failure: unknown;
      try {
        hostedActionClock(() => example.stopping)(refused, start + example.lag);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: example.code });
      expect(refused).toEqual(original);
    }
  });

  it('fences a queued revision at commit while retaining exact completed recovery ahead of the clock gate', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-action-revision-'));
    directories.push(directory);
    const path = join(directory, 'world.json');
    const runId = 'action-revision';
    const world = createOperation({
      ...operationCapacityPreset('illustrative-25.1'),
      runId,
      start: iso(start),
      fleet: { alpha: 1, beta: 1 },
      predeparture: {
        version: 'reserve-selected-await-release.1',
        tenant: 'alpha',
        attemptId: `intent-${runId}-alpha-0:attempt:1`,
      },
      selectedDemandWindow: {
        attemptId: `intent-${runId}-alpha-0:attempt:1`,
        start: iso(start + 120_000),
        end: iso(start + 1_200_000),
      },
    });
    let store = new OperationStore(
      path,
      initialOperationCheckpoint(world, { mode: 'live', wallAt: start, paused: false }),
    );
    await store.update((state) => advanceLiveClock(state, start, false));
    const reservation = store.state.world.reservations![0]!;
    const plan: OperationReservationRevisionPlan = {
      version: 1,
      runId,
      tenant: 'alpha',
      reservationId: reservation.id,
      aircraftId: reservation.aircraftId,
      expectedPlan: { sourceRevision: reservation.plan.sourceRevision, digest: canonicalDigest(reservation.plan) },
      change: {
        sourceRevision: 2,
        operatingInterval: { start: iso(start + 120_000), end: iso(start + 1_200_000) },
      },
    };
    let stopping = false;
    const clock = hostedActionClock(() => stopping);
    const original = await readFile(path, 'utf8');
    await expect(runOperationReservationRevision(plan, store, () => start + 1001, clock)).rejects.toMatchObject({
      code: 'world_clock_lagging',
    });
    expect(await readFile(path, 'utf8')).toBe(original);
    const queued = runOperationReservationRevision(plan, store, () => start + 1000, clock);
    stopping = true;
    await expect(queued).rejects.toMatchObject({ code: 'world_stopping' });
    expect(await readFile(path, 'utf8')).toBe(original);
    stopping = false;
    const revised = await runOperationReservationRevision(plan, store, () => start + 1000, clock);
    expect(revised).toMatchObject({ status: 'revised', occurredAt: iso(start + 1000) });
    await store.update((state) => {
      state.clock.paused = true;
    });
    store = new OperationStore(path, (await readOperationCheckpoint(path))!);
    stopping = true;
    const beforeRecovery = structuredClone(store.state);
    expect(await runOperationReservationRevision(plan, store, () => start + 3_600_000, clock)).toEqual({
      ...revised,
      status: 'already-revised',
    });
    expect(store.state.world).toEqual(beforeRecovery.world);
    expect(store.state.pending).toEqual(beforeRecovery.pending);
    expect(store.state.reservationRevision).toEqual(beforeRecovery.reservationRevision);
    expect(store.state.clock.paused).toBe(true);
  });
});
