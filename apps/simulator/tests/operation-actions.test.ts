import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalDigest } from '@ledger/integrity';
import { MissionSourceSchema } from '../../../packages/contracts/src/missions.js';
import {
  createOperation,
  operationCapacityPreset,
  type OperationMissionSource,
} from '../../../packages/simulation-models/src/operation.js';
import { prepareWorldFact } from '../src/operation-delivery.js';
import { readOperationHistory } from '../src/operation-history.js';
import type { OperationReservationRevisionPlan } from '../src/operation-reservation-revision.js';
import { runOperation } from '../src/operation.js';
import {
  advanceLiveClock,
  initialOperationCheckpoint,
  lockOperation,
  OperationStore,
  readOperationCheckpoint,
  type OperationHistoryBatch,
} from '../src/operation-state.js';

const start = Date.parse('2026-10-16T14:00:00.000Z');
const now = start + 30_000;
const iso = (at: number) => new Date(at).toISOString();
const directories: string[] = [];
const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const validateSource = ajv.compile(MissionSourceSchema);

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture(runId: string) {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-operation-actions-'));
  directories.push(directory);
  const statePath = join(directory, 'world.json');
  const planPath = join(directory, 'revision.json');
  const preset = operationCapacityPreset('illustrative-25.1');
  const world = createOperation({
    ...preset,
    runId,
    start: iso(start),
    fleet: { alpha: 1, beta: 2 },
    capacity: {
      ...preset.capacity,
      demandIntervalMs: { alpha: 30_000, beta: 30_000 },
      flightPeople: { alpha: 1, beta: 2 },
      turnaroundCrews: { alpha: 1, beta: 1 },
      chargers: { alpha: 1, beta: 1 },
      launchPads: { alpha: 1, beta: 1 },
    },
    sampleIntervalMs: 60_000,
    predeparture: { version: 'reserve-await-release.1', tenant: 'beta' },
  });
  const store = new OperationStore(
    statePath,
    initialOperationCheckpoint(world, { mode: 'live', wallAt: start, paused: false }),
  );
  await store.update((state) => advanceLiveClock(state, now, false));
  const reservation = structuredClone(store.state.world.reservations![0]!);
  const route = structuredClone(reservation.plan.route);
  const [origin, destination] = route.geometry.coordinates;
  route.geometry.coordinates.splice(1, 0, [
    (origin![0] + destination![0]) / 2 + 0.0005,
    (origin![1] + destination![1]) / 2,
  ]);
  const plan: OperationReservationRevisionPlan = {
    version: 1,
    runId,
    tenant: 'beta',
    reservationId: reservation.id,
    aircraftId: reservation.aircraftId,
    expectedPlan: {
      sourceRevision: reservation.plan.sourceRevision,
      digest: canonicalDigest(reservation.plan),
    },
    change: {
      sourceRevision: 3,
      route,
      operatingInterval: { ...reservation.order.schedule },
    },
  };
  const writePlan = (value: unknown = plan) => writeFile(planPath, JSON.stringify(value), { mode: 0o600 });
  await writePlan();
  return {
    statePath,
    planPath,
    plan,
    reservation,
    store,
    writePlan,
    env: {
      SIMULATOR_WORLD_MODE: 'revise',
      SIMULATOR_WORLD_STATE: statePath,
      SIMULATOR_WORLD_REVISION_PLAN: planPath,
    },
  };
}

async function history(store: OperationStore): Promise<OperationHistoryBatch[]> {
  const batches: OperationHistoryBatch[] = [];
  for await (const batch of readOperationHistory<OperationHistoryBatch>(
    store.historyDirectory,
    store.state.historyBatches,
  ))
    batches.push(batch.value);
  return batches;
}

describe('explicit world actions', () => {
  it('revises one held plan through the runtime lock, retaining exact originals and FIFO across retry and restart', async () => {
    const f = await fixture('runtime-revision');
    const before = structuredClone(f.store.state);
    expect(before.world.reservations).toHaveLength(2);
    const original = before.pending[f.reservation.id]!.find((entry) => entry.fact.kind === 'mission')!;
    const previousHistory = await history(f.store);
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetcher = vi.fn(() => {
      throw new Error('A local revision must not contact a service');
    });
    vi.stubGlobal('fetch', fetcher);

    await runOperation(f.env);
    let store = new OperationStore(f.statePath, (await readOperationCheckpoint(f.statePath))!);
    const source: OperationMissionSource = {
      ...f.reservation.plan,
      ...f.plan.change,
      occurredAt: iso(now),
    };
    expect(validateSource(source), JSON.stringify(validateSource.errors)).toBe(true);
    const prepared = prepareWorldFact({
      sequence: before.world.nextFact,
      kind: 'mission',
      tenant: 'beta',
      at: iso(now),
      attemptId: f.reservation.id,
      aircraftId: f.reservation.aircraftId,
      sourceId: 'mission-planner',
      source,
    });
    expect(Buffer.from(prepared.bytesBase64, 'base64').toString('utf8')).toBe(JSON.stringify(source));
    const { events: _events, nextEvent: _nextEvent, ...expectedWorld } = structuredClone(before.world);
    expectedWorld.reservations!.find((row) => row.id === f.reservation.id)!.plan = source;
    expectedWorld.nextFact++;
    expect(store.state.world).toMatchObject(expectedWorld);
    expect(
      store.state.world.events.filter(
        (event) => event.kind !== 'reservation-expiry' || event.attemptId !== f.reservation.id,
      ),
    ).toEqual(
      before.world.events.filter(
        (event) => event.kind !== 'reservation-expiry' || event.attemptId !== f.reservation.id,
      ),
    );
    expect(store.state.world.attempts.every((attempt) => attempt.tenant === 'alpha')).toBe(true);
    expect(store.state.pending).toEqual({
      ...before.pending,
      [f.reservation.id]: [...before.pending[f.reservation.id]!, prepared],
    });
    expect(store.pendingMissionHeads().find((entry) => entry.fact.attemptId === f.reservation.id)).toEqual(original);
    const receipt = {
      version: 'operation.reservation-revision.1',
      planDigest: canonicalDigest(f.plan),
      runId: f.plan.runId,
      reservationId: f.reservation.id,
      sourceRevision: source.sourceRevision,
      sourceDigest: canonicalDigest(source),
      occurredAt: iso(now),
    };
    expect(store.state.reservationRevision).toEqual(receipt);
    expect(JSON.parse(String(output.mock.calls.at(-1)![0]))).toEqual({ status: 'revised', ...receipt });
    const revisedHistory = await history(store);
    expect(revisedHistory.flatMap((batch) => batch.facts)).toEqual([
      ...previousHistory.flatMap((batch) => batch.facts),
      prepared,
    ]);

    const revised = structuredClone(store.state);
    await runOperation(f.env);
    store = new OperationStore(f.statePath, (await readOperationCheckpoint(f.statePath))!);
    expect(JSON.parse(String(output.mock.calls.at(-1)![0]))).toEqual({ status: 'already-revised', ...receipt });
    expect(store.state.world).toEqual(revised.world);
    expect(store.state.pending).toEqual(revised.pending);
    expect(store.state.historyBatches).toBe(revised.historyBatches);
    expect(store.state.reservationRevision).toEqual(receipt);
    expect(await history(store)).toEqual(revisedHistory);

    const checkpoint = await readFile(f.statePath, 'utf8');
    await expect(store.accept(prepared, 'too-early-revision')).rejects.toThrow('pending delivery head');
    expect(await readFile(f.statePath, 'utf8')).toBe(checkpoint);
    await store.accept(original, 'canonical-original-mission');
    store = new OperationStore(f.statePath, (await readOperationCheckpoint(f.statePath))!);
    expect(store.pendingMissionHeads().find((entry) => entry.fact.attemptId === f.reservation.id)).toEqual(prepared);
    await store.accept(prepared, 'canonical-revised-mission');
    expect((await history(store)).flatMap((batch) => batch.receipts)).toEqual([
      { sequence: original.fact.sequence, attemptId: f.reservation.id, receiptId: 'canonical-original-mission' },
      { sequence: prepared.fact.sequence, attemptId: f.reservation.id, receiptId: 'canonical-revised-mission' },
    ]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('refuses an owned world lock or a changed expected plan/run without changing the valid checkpoint', async () => {
    const f = await fixture('runtime-revision-guards');
    vi.spyOn(Date, 'now').mockReturnValue(now);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetcher = vi.fn(() => {
      throw new Error('Revision guards must not contact a service');
    });
    vi.stubGlobal('fetch', fetcher);
    const checkpoint = await readFile(f.statePath, 'utf8');
    const release = await lockOperation(f.statePath);
    try {
      await expect(runOperation(f.env)).rejects.toThrow('running scheduler');
      expect(await readFile(f.statePath, 'utf8')).toBe(checkpoint);
    } finally {
      await release();
    }
    for (const plan of [
      { ...f.plan, expectedPlan: { ...f.plan.expectedPlan, digest: '0'.repeat(64) } },
      { ...f.plan, runId: 'another-world' },
    ]) {
      await f.writePlan(plan);
      await expect(runOperation(f.env)).rejects.toThrow();
      expect(await readFile(f.statePath, 'utf8')).toBe(checkpoint);
      expect(await readOperationCheckpoint(f.statePath)).toEqual(f.store.state);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});
