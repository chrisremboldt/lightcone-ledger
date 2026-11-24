import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { afterEach, describe, expect, it } from 'vitest';
import { MissionSourceSchema } from '../../../packages/contracts/src/missions.js';
import {
  advanceOperation,
  compactOperation,
  createOperation,
  operationCapacityPreset,
  operationSummary,
  reviseOperationReservation,
  upgradeOperationWorld,
  type OperationMissionSource,
  type WorldFact,
} from '../../../packages/simulation-models/src/operation.js';
import { prepareWorldFact } from '../src/operation-delivery.js';
import { readOperationHistory } from '../src/operation-history.js';
import {
  advanceLiveClock,
  initialOperationCheckpoint,
  OperationStore,
  readOperationCheckpoint,
  type OperationHistoryBatch,
} from '../src/operation-state.js';

const start = Date.parse('2026-10-15T14:00:00.000Z');
const iso = (at: number) => new Date(at).toISOString();
const directories: string[] = [];
const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const validateSource = ajv.compile(MissionSourceSchema);
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function revisionWorld(runId: string) {
  const preset = operationCapacityPreset('illustrative-25.1');
  const attemptId = `intent-${runId}-alpha-0:attempt:1`;
  return createOperation({
    ...preset,
    runId,
    start: iso(start),
    fleet: { alpha: 1, beta: 1 },
    capacity: {
      ...preset.capacity,
      demandIntervalMs: { alpha: 120_000, beta: 120_000 },
      flightPeople: { alpha: 1, beta: 1 },
      turnaroundCrews: { alpha: 1, beta: 1 },
      chargers: { alpha: 1, beta: 1 },
      launchPads: { alpha: 1, beta: 1 },
    },
    sampleIntervalMs: 60_000,
    predeparture: { version: 'reserve-selected-await-release.1', tenant: 'alpha', attemptId },
    selectedDemandWindow: {
      attemptId,
      start: iso(start + 60_000),
      end: iso(start + 40 * 60_000),
    },
  });
}

function revisedRoute(route: OperationMissionSource['route']): OperationMissionSource['route'] {
  const copy = structuredClone(route);
  const [origin, destination] = copy.geometry.coordinates;
  copy.geometry.coordinates.splice(1, 0, [
    (origin![0] + destination![0]) / 2 + 0.0005,
    (origin![1] + destination![1]) / 2,
  ]);
  return copy;
}

function missions(facts: WorldFact[]) {
  return facts.filter((fact): fact is Extract<WorldFact, { kind: 'mission' }> => fact.kind === 'mission');
}

describe('explicit held mission revisions', () => {
  it('issues an immutable schema-valid revision without changing the original order, reservation identity or physical operation', () => {
    const world = revisionWorld('reserve-revision');
    advanceOperation(world, start + 120_000);
    const before = structuredClone(world);
    const original = before.reservations![0]!;
    expect(original.order.schedule).toEqual({ start: iso(start + 60_000), end: iso(start + 40 * 60_000) });
    const originals = before.facts.map(prepareWorldFact);
    const route = revisedRoute(original.plan.route);
    const interval = { start: iso(start + 600_000), end: iso(start + 900_000) };
    const issued = reviseOperationReservation(world, original.id, {
      sourceRevision: 3,
      route,
      operatingInterval: interval,
    });
    const current = world.reservations![0]!;
    const fact = missions(world.facts).at(-1)!;
    expect(validateSource(current.plan), JSON.stringify(validateSource.errors)).toBe(true);
    expect(current.plan).toEqual({
      ...original.plan,
      sourceRevision: 3,
      occurredAt: iso(world.now),
      route,
      operatingInterval: interval,
    });
    expect({ ...current, plan: original.plan }).toEqual(original);
    expect(fact).toEqual({
      sequence: before.nextFact,
      tenant: original.tenant,
      at: iso(world.now),
      attemptId: original.id,
      aircraftId: original.aircraftId,
      kind: 'mission',
      sourceId: 'mission-planner',
      source: current.plan,
    });
    expect(Buffer.from(prepareWorldFact(fact).bytesBase64, 'base64').toString('utf8')).toBe(
      JSON.stringify(current.plan),
    );
    expect(world.facts.slice(0, -1).map(prepareWorldFact)).toEqual(originals);
    expect(world.nextFact).toBe(before.nextFact + 1);
    for (const key of ['aircraft', 'people', 'resources', 'attempts', 'demand', 'counters'] as const)
      expect(world[key]).toEqual(before[key]);
    expect(world.events.filter((event) => event.kind !== 'reservation-expiry')).toEqual(
      before.events.filter((event) => event.kind !== 'reservation-expiry'),
    );
    expect(
      world.events.filter((event) => event.kind === 'reservation-expiry' && event.attemptId === original.id),
    ).toHaveLength(1);

    const retained = structuredClone(current.plan);
    route.geometry.coordinates[0]![0] += 1;
    interval.start = iso(start + 700_000);
    issued.route.geometry.coordinates[1]![0] += 1;
    expect(current.plan).toEqual(retained);
    expect(fact.source).toEqual(retained);
    current.plan.route.geometry.coordinates[0]![0] += 0.0001;
    expect(fact.source).toEqual(retained);
    current.plan = retained;
    advanceOperation(world, start + 30 * 60_000);
    expect(current.plan).toEqual(retained);
    expect(missions(world.facts).map((entry) => entry.source.sourceRevision)).toEqual([1, 3]);
    expect(operationSummary(world).predeparture!.reservations[0]).toMatchObject({
      sourceRevision: 3,
      planTiming: 'slipped',
    });
    expect(world.attempts.some((attempt) => attempt.tenant === 'beta')).toBe(true);
    expect(world.attempts.some((attempt) => attempt.id === original.id)).toBe(false);
  });

  it('rejects stale or malformed changes and lost reservation ownership without partially changing the world', () => {
    const world = revisionWorld('reserve-reject');
    advanceOperation(world, start);
    const reservation = world.reservations![0]!;
    const interval = { start: iso(start + 600_000), end: iso(start + 900_000) };
    reviseOperationReservation(world, reservation.id, { sourceRevision: 3, operatingInterval: interval });
    const unchangedOnFailure = (change: () => unknown) => {
      const before = JSON.stringify(world);
      expect(change).toThrow();
      expect(JSON.stringify(world)).toBe(before);
    };
    for (const sourceRevision of [3, 2, Number.MAX_SAFE_INTEGER + 1])
      unchangedOnFailure(() =>
        reviseOperationReservation(world, reservation.id, { sourceRevision, operatingInterval: interval }),
      );
    unchangedOnFailure(() => reviseOperationReservation(world, reservation.id, { sourceRevision: 4 }));
    const invalidRoute = structuredClone(reservation.plan.route);
    invalidRoute.geometry.coordinates[0] = [181, 0];
    unchangedOnFailure(() =>
      reviseOperationReservation(world, reservation.id, { sourceRevision: 4, route: invalidRoute }),
    );
    unchangedOnFailure(() =>
      reviseOperationReservation(world, reservation.id, {
        sourceRevision: 4,
        operatingInterval: { start: '2026-10-15T09:10:00-05:00', end: interval.end },
      }),
    );
    const person = world.resources!.flightPeople.find((slot) => slot.id === reservation.personId)!;
    delete person.aircraftId;
    unchangedOnFailure(() =>
      reviseOperationReservation(world, reservation.id, { sourceRevision: 4, operatingInterval: interval }),
    );
  });

  it('retains every original revision and drains missions in order across compacted checkpoints and restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-reservation-revisions-'));
    directories.push(directory);
    const path = join(directory, 'world.json');
    let store = new OperationStore(
      path,
      initialOperationCheckpoint(revisionWorld('reserve-restart'), {
        mode: 'live',
        wallAt: start,
        paused: false,
      }),
    );
    await store.update((state) => advanceLiveClock(state, start, false));
    const original = structuredClone(store.state.world.reservations![0]!);
    const route = revisedRoute(original.plan.route);
    const secondInterval = { start: iso(start + 600_000), end: iso(start + 900_000) };
    const latestInterval = { start: iso(start + 1_200_000), end: iso(start + 1_500_000) };
    await store.update((state) => {
      advanceLiveClock(state, start + 120_000, false);
      reviseOperationReservation(state.world, original.id, {
        sourceRevision: 2,
        route,
        operatingInterval: secondInterval,
      });
    });
    await store.update((state) => {
      advanceLiveClock(state, start + 180_000, false);
      reviseOperationReservation(state.world, original.id, { sourceRevision: 5, operatingInterval: latestInterval });
    });
    const revisions = structuredClone(
      store.state.pending[original.id]!.filter((entry) => entry.fact.kind === 'mission'),
    );
    expect(revisions.map((entry) => entry.fact.kind === 'mission' && entry.fact.source.sourceRevision)).toEqual([
      1, 2, 5,
    ]);
    store = new OperationStore(path, (await readOperationCheckpoint(path))!);
    expect(store.pendingMissionHeads()).toEqual([revisions[0]]);
    expect(store.state.world.facts).toEqual([]);
    const resumed = upgradeOperationWorld(JSON.parse(JSON.stringify(store.state.world)));
    expect(compactOperation(resumed)).toEqual({ facts: [], demand: [], attempts: [] });
    expect(resumed).toEqual(store.state.world);
    expect(resumed.reservations![0]!.plan).toEqual({
      ...original.plan,
      sourceRevision: 5,
      occurredAt: iso(start + 180_000),
      route,
      operatingInterval: latestInterval,
    });
    expect(resumed.reservations![0]!.order).toEqual(original.order);

    const expected = revisionWorld('reserve-restart');
    advanceOperation(expected, start + 120_000);
    reviseOperationReservation(expected, original.id, { sourceRevision: 2, route, operatingInterval: secondInterval });
    advanceOperation(expected, start + 180_000);
    reviseOperationReservation(expected, original.id, { sourceRevision: 5, operatingInterval: latestInterval });
    const expectedArchive = compactOperation(expected);
    expect(store.state.world).toEqual(expected);
    const checkpoint = await readFile(path, 'utf8');
    await expect(store.accept(revisions[2]!, 'canonical-latest')).rejects.toThrow('pending delivery head');
    expect(await readFile(path, 'utf8')).toBe(checkpoint);
    for (const revision of revisions) {
      expect(store.pendingMissionHeads()).toEqual([revision]);
      await store.accept(revision, `canonical-mission-${revision.fact.sequence}`);
      store = new OperationStore(path, (await readOperationCheckpoint(path))!);
    }
    expect(store.pendingMissionHeads()).toEqual([]);
    expect(
      store.pendingHeads().some((entry) => entry.fact.attemptId === original.id && entry.fact.kind === 'order'),
    ).toBe(true);
    expect(store.state.accepted).toBe(3);
    expect(store.state.world).toEqual(expected);
    const batches: OperationHistoryBatch[] = [];
    for await (const batch of readOperationHistory<OperationHistoryBatch>(
      store.historyDirectory,
      store.state.historyBatches,
    ))
      batches.push(batch.value);
    expect(batches.flatMap((batch) => batch.facts)).toEqual(expectedArchive.facts.map(prepareWorldFact));
    expect(batches.flatMap((batch) => batch.facts).filter((entry) => entry.fact.kind === 'mission')).toEqual(revisions);
    expect(batches.flatMap((batch) => batch.receipts)).toEqual(
      revisions.map((revision) => ({
        sequence: revision.fact.sequence,
        attemptId: original.id,
        receiptId: `canonical-mission-${revision.fact.sequence}`,
      })),
    );
  });
});
