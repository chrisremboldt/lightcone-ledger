import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { afterEach, describe, expect, it } from 'vitest';
import { MissionSourceSchema } from '../../../packages/contracts/src/missions.js';
import {
  advanceOperation,
  capacityStatus,
  compactOperation,
  createOperation,
  operationCapacityPreset,
  operationSummary,
  upgradeOperationWorld,
  type OperationArchive,
  type WorldFact,
} from '../../../packages/simulation-models/src/operation.js';
import { predepartureOptions } from '../src/operation.js';
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

function reservationWorld(runId: string) {
  const preset = operationCapacityPreset('illustrative-25.1');
  return createOperation({
    ...preset,
    runId,
    start: iso(start),
    seed: 71031,
    fleet: { alpha: 5, beta: 4 },
    capacity: {
      ...preset.capacity,
      flightPeople: { alpha: 4, beta: 2 },
      turnaroundCrews: { alpha: 2, beta: 1 },
      chargers: { alpha: 2, beta: 1 },
      launchPads: { alpha: 2, beta: 1 },
    },
    sampleIntervalMs: 60_000,
    commandLinkEpisode: 'canal-market-relay.1',
    predeparture: { version: 'reserve-await-release.1', tenant: 'beta' },
  });
}

function missionFacts(facts: WorldFact[]) {
  return facts.filter((fact): fact is Extract<WorldFact, { kind: 'mission' }> => fact.kind === 'mission');
}

describe('off-pad predeparture reservations', () => {
  it('owns finite resources until the customer deadline then cancels and reuses them while the other tenant flies', () => {
    const world = reservationWorld('reserve-hold');
    advanceOperation(world, start + 45_000);
    const reservations = structuredClone(world.reservations!);
    expect(reservations).toHaveLength(2);
    expect(new Set(reservations.map((reservation) => reservation.aircraftId)).size).toBe(2);
    expect(new Set(reservations.map((reservation) => reservation.personId)).size).toBe(2);
    expect(operationSummary(world).predeparture!.reservations.every((row) => row.planTiming === 'scheduled')).toBe(
      true,
    );
    for (const reservation of reservations) {
      expect(reservation).not.toHaveProperty('departure');
      expect(reservation).not.toHaveProperty('landing');
      expect(reservation.phase).toBe('awaiting-release');
      const aircraft = world.aircraft.find((row) => row.id === reservation.aircraftId)!;
      const person = world.resources!.flightPeople.find((row) => row.id === reservation.personId)!;
      expect(aircraft).toMatchObject({
        phase: 'reserved',
        attemptId: reservation.id,
        personId: reservation.personId,
        availableAt: Date.parse(reservation.reservedAt),
      });
      expect(person).toMatchObject({ aircraftId: aircraft.id, availableAt: Date.parse(reservation.reservedAt) });
      expect(Number.isFinite(person.availableAt)).toBe(true);
      expect(reservation.plan).toMatchObject({
        sourceRevision: 1,
        sourceMissionId: `${reservation.id}:mission`,
        occurredAt: reservation.reservedAt,
        aircraftId: aircraft.id,
        lateralToleranceMeters: 30,
        altitude: { minimum: 0, maximum: 60, unit: 'm', reference: 'AGL' },
      });
      expect(validateSource(reservation.plan), JSON.stringify(validateSource.errors)).toBe(true);
      expect(reservation.plan.route.geometry.coordinates).toEqual([
        [reservation.origin.longitude, reservation.origin.latitude],
        [reservation.destination.longitude, reservation.destination.latitude],
        [reservation.origin.longitude, reservation.origin.latitude],
      ]);
      expect(Date.parse(reservation.plan.operatingInterval.start)).toBe(Date.parse(reservation.reservedAt) + 60_000);
      expect(
        Date.parse(reservation.plan.operatingInterval.end) - Date.parse(reservation.plan.operatingInterval.start),
      ).toBe(reservation.travelMs * 2 + 60_000);
      expect(reservation.order).toMatchObject({
        version: 2,
        updated_at: reservation.reservedAt,
        schedule: world.demand.find((demand) => demand.id === reservation.demandId)!.window,
        flights: [{ flight_intent_id: reservation.intentId, attempt: 1, aircraft_id: aircraft.id }],
      });
      expect(Date.parse(reservation.plan.operatingInterval.start)).toBeGreaterThanOrEqual(
        Date.parse(reservation.order.schedule.start),
      );
      expect(Date.parse(reservation.plan.operatingInterval.end)).toBeLessThanOrEqual(
        Date.parse(reservation.order.schedule.end),
      );
      const source = missionFacts(world.facts).find((fact) => fact.attemptId === reservation.id)!;
      expect(source.source).toEqual(reservation.plan);
      expect(source).not.toHaveProperty('sourceSessionId');
      expect(Buffer.from(prepareWorldFact(source).bytesBase64, 'base64').toString('utf8')).toBe(
        JSON.stringify(reservation.plan),
      );
    }

    advanceOperation(world, start + 30 * 60_000);
    for (const original of reservations) {
      const cancelled = world.reservations!.find((reservation) => reservation.id === original.id)!;
      expect(cancelled.phase).toBe('cancelled');
      expect(cancelled.cancellation?.reason).toBe('requested_window_unreachable');
      expect(cancelled.plan).toEqual(original.plan);
      expect(cancelled.order).toEqual(original.order);
      expect(world.facts).toContainEqual(expect.objectContaining({ kind: 'cancellation', attemptId: original.id }));
    }
    const active = world.reservations!.filter((reservation) => reservation.phase === 'awaiting-release');
    expect(active.length).toBeLessThanOrEqual(2);
    expect(world.counters.cancelled).toBeGreaterThan(0);
    expect(world.attempts.length).toBeGreaterThan(4);
    expect(world.attempts.every((attempt) => attempt.tenant === 'alpha')).toBe(true);
    expect(world.counters.attempts).toBe(world.attempts.length);
    expect(world.counters.landed).toBeGreaterThan(0);
    expect(new Set(world.facts.filter((fact) => fact.kind === 'command-link').map((fact) => fact.status))).toEqual(
      new Set(['lost', 'restored']),
    );
    expect(
      world.facts
        .filter((fact) => fact.tenant === 'beta')
        .every((fact) => ['order', 'mission', 'cancellation'].includes(fact.kind)),
    ).toBe(true);
    expect(missionFacts(world.facts).map((fact) => fact.source)).toEqual(
      expect.arrayContaining(reservations.map((reservation) => reservation.plan)),
    );
    expect(missionFacts(world.facts).length).toBeGreaterThan(reservations.length);
    expect(
      world.facts.filter(
        (fact) =>
          fact.tenant === 'beta' &&
          fact.kind === 'order' &&
          fact.order.version === 2 &&
          fact.order.state === 'accepted',
      ),
    ).toHaveLength(world.reservations!.length);
    expect(
      world.events.some((event) => 'attemptId' in event && reservations.some((row) => row.id === event.attemptId)),
    ).toBe(false);
    for (const kind of ['launchPads', 'turnaroundCrews', 'chargers'] as const) {
      expect(
        world
          .resources![kind].filter((slot) => slot.tenant === 'beta')
          .every((slot) => slot.aircraftId === undefined && slot.availableAt <= world.now),
      ).toBe(true);
    }
    expect(
      [...world.resources!.turnaroundQueue, ...world.resources!.chargeQueue].some((id) =>
        reservations.some((row) => row.aircraftId === id),
      ),
    ).toBe(false);
    const summary = operationSummary(world);
    expect(summary.queued).toBe(world.demand.filter((demand) => !demand.attemptId && !demand.cancellation).length);
    expect(summary).toMatchObject({
      reserved: active.length,
      predeparture: { tenant: 'beta', consumer: 'unavailable' },
    });
    expect(summary.cancelled).toBeGreaterThanOrEqual(reservations.length);
    expect(summary.predeparture!.reservations.every((row) => row.phase === 'awaiting-release')).toBe(true);
    expect(capacityStatus(world)).toMatchObject({
      capacity: {
        tenants: {
          beta: {
            resources: {
              aircraft: { total: 4, busy: active.length, reserved: active.length },
              flightPeople: { total: 2, busy: active.length, reserved: active.length },
              launchPads: { busy: 0 },
              turnaroundCrews: { busy: 0 },
              chargers: { busy: 0 },
            },
            waiting: { release: active.length },
          },
        },
      },
    });
  });

  it('replays identical facts, reservations and resource ownership through compaction and JSON restart', () => {
    const uninterrupted = reservationWorld('reserve-replay');
    advanceOperation(uninterrupted, start + 20 * 60_000);
    const expectedSummary = operationSummary(uninterrupted);
    const expectedArchive = compactOperation(uninterrupted);
    let resumed = reservationWorld('reserve-replay');
    const archive: OperationArchive = { facts: [], demand: [], attempts: [] };
    for (const elapsed of [0, 30_000, 60_000, 90_000, 120_000, 201_337, 20 * 60_000]) {
      advanceOperation(resumed, start + elapsed);
      const before = operationSummary(resumed);
      const batch = compactOperation(resumed);
      archive.facts.push(...batch.facts);
      archive.demand.push(...batch.demand);
      archive.attempts.push(...batch.attempts);
      expect(operationSummary(resumed)).toEqual(before);
      resumed = upgradeOperationWorld(JSON.parse(JSON.stringify(resumed)));
    }
    expect(archive.facts).toEqual(expectedArchive.facts);
    const byId = (left: { id: string }, right: { id: string }) => left.id.localeCompare(right.id);
    expect(archive.demand.sort(byId)).toEqual(expectedArchive.demand.sort(byId));
    expect(archive.attempts.sort(byId)).toEqual(expectedArchive.attempts.sort(byId));
    expect(operationSummary(resumed)).toEqual(expectedSummary);
    expect(resumed).toEqual(uninterrupted);
    expect(missionFacts(archive.facts).length).toBeGreaterThan(2);
    expect(archive.facts.some((fact) => fact.kind === 'cancellation')).toBe(true);
    expect(archive.demand.some((demand) => demand.cancellation)).toBe(true);
    expect(resumed.reservations!.every((reservation) => reservation.phase === 'awaiting-release')).toBe(true);
    expect(archive.attempts.every((attempt) => attempt.tenant === 'alpha')).toBe(true);
  });

  it('keeps paused reservations and original queued bytes durable while order and mission receipts drain', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-predeparture-'));
    directories.push(directory);
    const path = join(directory, 'world.json');
    let store = new OperationStore(
      path,
      initialOperationCheckpoint(reservationWorld('reserve-store'), {
        mode: 'live',
        wallAt: start,
        paused: false,
      }),
    );
    await store.update((state) => advanceLiveClock(state, start + 45_000, false));
    const reservations = structuredClone(store.state.world.reservations!);
    const resources = structuredClone(store.state.world.resources);
    const plans = structuredClone(store.pendingMissionHeads());
    const queued = structuredClone(store.state.pending);
    expect(plans).toHaveLength(2);
    await store.update((state) => advanceLiveClock(state, start + 120_000, true));
    store = new OperationStore(path, (await readOperationCheckpoint(path))!);
    expect(store.state.clock).toEqual({ mode: 'live', wallAt: start + 45_000, paused: true });
    expect(store.state.world.now).toBe(start + 45_000);
    expect(store.state.world.reservations).toEqual(reservations);
    expect(store.state.world.resources).toEqual(resources);
    expect(store.state.pending).toEqual(queued);

    const accepted: number[] = [];
    for (const plan of plans) {
      await store.accept(plan, `canonical-mission-${plan.fact.sequence}`);
      accepted.push(plan.fact.sequence);
    }
    let order = store.pendingHeads().find((entry) => entry.fact.tenant === 'beta');
    while (order) {
      expect(order.fact.kind).toBe('order');
      await store.accept(order, `canonical-order-${order.fact.sequence}`);
      accepted.push(order.fact.sequence);
      order = store.pendingHeads().find((entry) => entry.fact.tenant === 'beta');
    }
    expect(store.pendingHeads().some((entry) => entry.fact.tenant === 'alpha')).toBe(true);
    store = new OperationStore(path, (await readOperationCheckpoint(path))!);
    expect(store.pendingMissionHeads()).toEqual([]);
    expect(store.state.world.reservations).toEqual(reservations);
    expect(store.state.accepted).toBe(accepted.length);
    await store.update((state) => advanceLiveClock(state, start + 10 * 60_000, false));
    expect(
      store.state.world.reservations!.some((reservation) =>
        reservations.some((original) => original.id === reservation.id),
      ),
    ).toBe(false);
    expect(store.state.world.reservations!.length).toBeLessThanOrEqual(2);
    expect(store.pendingMissionHeads().some((entry) => entry.fact.tenant === 'beta')).toBe(true);
    expect(store.state.world.counters.landed).toBeGreaterThan(0);
    expect(store.state.world.counters.cancelled).toBeGreaterThan(0);
    const expected = reservationWorld('reserve-store');
    advanceOperation(expected, start + 10 * 60_000);
    compactOperation(expected);
    expect(store.state.world).toEqual(expected);

    const history: OperationHistoryBatch[] = [];
    for await (const batch of readOperationHistory<OperationHistoryBatch>(
      store.historyDirectory,
      store.state.historyBatches,
    ))
      history.push(batch.value);
    const archivedMissions = history.flatMap((batch) => batch.facts).filter((entry) => entry.fact.kind === 'mission');
    expect(archivedMissions).toEqual(expect.arrayContaining(plans));
    expect(archivedMissions.length).toBeGreaterThan(plans.length);
    expect(history.flatMap((batch) => batch.facts).some((entry) => entry.fact.kind === 'cancellation')).toBe(true);
    const receipts = history.flatMap((batch) => batch.receipts);
    expect(receipts.map((receipt) => receipt.sequence).sort((a, b) => a - b)).toEqual(accepted.sort((a, b) => a - b));
    for (const plan of plans)
      expect(receipts.filter((receipt) => receipt.sequence === plan.fact.sequence)).toEqual([
        {
          sequence: plan.fact.sequence,
          attemptId: plan.fact.attemptId,
          receiptId: `canonical-mission-${plan.fact.sequence}`,
        },
      ]);
  });

  it('requires explicit finite-capacity fresh selection and preserves absent-profile checkpoint shapes', () => {
    const normal = createOperation({ runId: 'reserve-absent', start: iso(start) });
    const originalConfig = JSON.stringify(normal.config);
    const old = structuredClone(normal);
    old.version = 'operation-world.1';
    for (const world of [normal, upgradeOperationWorld(JSON.parse(JSON.stringify(old)))]) {
      advanceOperation(world, start + 180_000);
      expect(Object.hasOwn(world, 'reservations')).toBe(false);
      expect(Object.hasOwn(world.config, 'predeparture')).toBe(false);
      expect(Object.hasOwn(operationSummary(world), 'predeparture')).toBe(false);
      expect(Object.hasOwn(operationSummary(world), 'reserved')).toBe(false);
      expect(JSON.stringify(world.config)).toBe(originalConfig);
    }
    const env = {
      SIMULATOR_WORLD_PREDEPARTURE: 'reserve-await-release.1',
      SIMULATOR_WORLD_PREDEPARTURE_TENANT: 'beta',
    };
    const selected = reservationWorld('reserve-options').config;
    expect(predepartureOptions({})).toEqual({});
    expect(predepartureOptions(env)).toEqual({ predeparture: selected.predeparture });
    expect(predepartureOptions({}, selected)).toEqual({});
    expect(predepartureOptions(env, selected)).toEqual({ predeparture: selected.predeparture });
    expect(() => predepartureOptions(env, normal.config)).toThrow('retained in its checkpoint');
    expect(() => predepartureOptions({ ...env, SIMULATOR_WORLD_PREDEPARTURE_TENANT: 'alpha' }, selected)).toThrow(
      'retained in its checkpoint',
    );
    expect(() => predepartureOptions({ SIMULATOR_WORLD_PREDEPARTURE: env.SIMULATOR_WORLD_PREDEPARTURE })).toThrow(
      'must select alpha or beta',
    );
    expect(() => predepartureOptions({ SIMULATOR_WORLD_PREDEPARTURE_TENANT: 'beta' })).toThrow(
      'must be reserve-await-release.1',
    );
    expect(() => createOperation({ ...normal.config, predeparture: selected.predeparture })).toThrow(
      'finite operation capacity',
    );
  });

  it('pins the selected Alpha attempt in fresh runner settings and refuses changes on resume', () => {
    const runId = 'selected-options';
    const env = {
      SIMULATOR_WORLD_PREDEPARTURE: 'reserve-selected-await-release.1',
      SIMULATOR_WORLD_PREDEPARTURE_TENANT: 'alpha',
      SIMULATOR_WORLD_PREDEPARTURE_ATTEMPT: `intent-${runId}-alpha-0:attempt:1`,
    };
    const selection = predepartureOptions(env);
    const world = createOperation({ ...reservationWorld(runId).config, ...selection });
    const original = JSON.stringify(world.config);
    expect(predepartureOptions(env, world.config)).toEqual(selection);
    expect(predepartureOptions({}, world.config)).toEqual({});
    expect(() =>
      predepartureOptions(
        { ...env, SIMULATOR_WORLD_PREDEPARTURE_ATTEMPT: `intent-${runId}-alpha-1:attempt:1` },
        world.config,
      ),
    ).toThrow('retained in its checkpoint');
    expect(() => predepartureOptions({ ...env, SIMULATOR_WORLD_PREDEPARTURE_TENANT: 'beta' })).toThrow(
      'requires Alpha',
    );
    const { SIMULATOR_WORLD_PREDEPARTURE_ATTEMPT: _attempt, ...missingAttempt } = env;
    expect(() => predepartureOptions(missingAttempt)).toThrow('explicit');
    expect(() => predepartureOptions({ ...env, SIMULATOR_WORLD_PREDEPARTURE: 'reserve-await-release.1' })).toThrow(
      'requires reserve-selected',
    );
    expect(JSON.stringify(world.config)).toBe(original);
    expect(world.facts).toEqual([]);
  });
});
