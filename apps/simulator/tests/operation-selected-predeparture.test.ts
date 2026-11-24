import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalDigest, sha256 } from '@ledger/integrity';
import {
  advanceOperation,
  capacityStatus,
  compactOperation,
  createOperation,
  holdsOperationAttempt,
  operationCapacityPreset,
  operationReservationFit,
  operationSummary,
  reviseOperationReservation,
  type OperationConfig,
  type OperationReservation,
  type OperationWorld,
} from '../../../packages/simulation-models/src/operation.js';
import type { MissionDeparturePlan } from '../src/mission-departure-plan.js';
import { checkOperationDepartureSelection } from '../src/operation-departure-consumer.js';
import { prepareWorldFact } from '../src/operation-delivery.js';
import { readOperationHistory } from '../src/operation-history.js';
import * as operationHistory from '../src/operation-history.js';
import {
  initialOperationCheckpoint,
  OperationStore,
  readOperationCheckpoint,
  type OperationCheckpoint,
  type OperationHistoryBatch,
} from '../src/operation-state.js';

const start = Date.parse('2026-10-15T14:00:00.000Z');
const iso = (at: number) => new Date(at).toISOString();
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function selectedConfig(runId: string) {
  const preset = operationCapacityPreset('illustrative-25.1');
  return {
    ...preset,
    runId,
    start: iso(start),
    fleet: { alpha: 4, beta: 3 },
    capacity: {
      ...preset.capacity,
      flightPeople: { alpha: 3, beta: 2 },
      turnaroundCrews: { alpha: 2, beta: 1 },
      chargers: { alpha: 2, beta: 1 },
      launchPads: { alpha: 1, beta: 1 },
    },
    sampleIntervalMs: 60_000,
    missionPlan: 'dispatch-plan.1' as const,
    predeparture: {
      version: 'reserve-selected-await-release.1' as const,
      tenant: 'alpha' as const,
      attemptId: `intent-${runId}-alpha-1:attempt:1`,
    },
    selectedDemandWindow: {
      attemptId: `intent-${runId}-alpha-1:attempt:1`,
      start: iso(start + 60_000),
      end: iso(start + 40 * 60_000),
    },
  };
}

function expectOwnership(world: OperationWorld, selected: OperationReservation) {
  const flying = world.attempts.filter((attempt) => attempt.phase === 'flying');
  expect(new Set(flying.map((attempt) => attempt.aircraftId)).size).toBe(flying.length);
  expect(new Set(flying.map((attempt) => attempt.personId)).size).toBe(flying.length);
  expect(
    flying.every((attempt) => attempt.aircraftId !== selected.aircraftId && attempt.personId !== selected.personId),
  ).toBe(true);
  expect(world.aircraft.find((aircraft) => aircraft.id === selected.aircraftId)).toMatchObject({
    phase: 'reserved',
    attemptId: selected.id,
    personId: selected.personId,
  });
  expect(world.resources!.flightPeople.find((person) => person.id === selected.personId)).toMatchObject({
    tenant: 'alpha',
    aircraftId: selected.aircraftId,
  });
  for (const attempt of flying) {
    expect(world.resources!.flightPeople.find((person) => person.id === attempt.personId)).toMatchObject({
      tenant: attempt.tenant,
      aircraftId: attempt.aircraftId,
      availableAt: Date.parse(attempt.landing),
    });
  }
  for (const kind of ['launchPads', 'turnaroundCrews', 'chargers'] as const) {
    expect(world.resources![kind].some((slot) => slot.aircraftId === selected.aircraftId)).toBe(false);
    const busy = world.resources![kind].filter((slot) => slot.availableAt > world.now);
    expect(new Set(busy.map((slot) => slot.aircraftId)).size).toBe(busy.length);
    for (const slot of busy)
      expect(world.aircraft.find((aircraft) => aircraft.id === slot.aircraftId)?.tenant).toBe(slot.tenant);
  }
}

function departurePlan(world: OperationWorld, reservation: OperationReservation): MissionDeparturePlan {
  const digest = canonicalDigest(reservation.plan);
  return {
    version: 1,
    apiUrl: 'http://selected-departure.test',
    tenantId: `tenant-${reservation.tenant}`,
    principalId: 'selected-departure-principal',
    runId: world.config.runId,
    reservationId: reservation.id,
    flightId: 'selected-ledger-flight',
    aircraftId: reservation.aircraftId,
    release: { id: 'selected-release', digest },
    mission: {
      missionId: 'selected-ledger-mission',
      sourceRevision: reservation.plan.sourceRevision,
      eventId: 'selected-ledger-mission-event',
      contentDigest: digest,
      recordDigest: digest,
    },
    departureAttemptId: `${reservation.id}:departure:1`,
    marginMs: 10_000,
    latencyMarginMs: 1_000,
    handoffAllowanceMs: 5_000,
    allocationDurationMs: 90_000,
  };
}

function selectedJob(plan: MissionDeparturePlan): NonNullable<OperationCheckpoint['departureJob']> {
  return {
    version: 'operation.departure-job.1',
    flightId: plan.flightId,
    reservationId: plan.reservationId,
    departureAttemptId: plan.departureAttemptId,
    planDigest: canonicalDigest(plan),
  };
}

describe('one selected predeparture reservation', () => {
  it('requires an immutable exact fresh selector while other Alpha and Beta flights own finite resources', () => {
    const configuration = selectedConfig('selected-resources');
    const selectedId = configuration.predeparture.attemptId;
    for (const attemptId of [
      'intent-another-run-alpha-1:attempt:1',
      `intent-${configuration.runId}-beta-1:attempt:1`,
      `intent-${configuration.runId}-alpha-01:attempt:1`,
      `intent-${configuration.runId}-alpha-${Number.MAX_SAFE_INTEGER + 1}:attempt:1`,
      `intent-${configuration.runId}-alpha-1:attempt:2`,
    ])
      expect(() =>
        createOperation({ ...configuration, predeparture: { ...configuration.predeparture, attemptId } }),
      ).toThrow();
    expect(() => createOperation({ ...configuration, capacity: undefined })).toThrow(/finite.*capacity/i);
    expect(() =>
      createOperation({
        ...configuration,
        predeparture: { ...configuration.predeparture, tenant: 'beta' },
      } as unknown as OperationConfig),
    ).toThrow();
    expect(() =>
      createOperation({
        ...configuration,
        predeparture: { ...configuration.predeparture, extra: true },
      } as unknown as OperationConfig),
    ).toThrow();
    const world = createOperation(configuration);
    const retainedConfig = JSON.stringify(world.config);
    configuration.predeparture.attemptId = `intent-${configuration.runId}-alpha-2:attempt:1`;
    configuration.capacity.flightPeople.alpha = 1;
    configuration.fleet.alpha = 1;
    expect(JSON.stringify(world.config)).toBe(retainedConfig);
    advanceOperation(world, start + 30_000);
    expect(world.reservations).toHaveLength(1);
    const selected = structuredClone(world.reservations![0]!);
    expect(selected.id).toBe(selectedId);
    expect(world.attempts.some((attempt) => attempt.tenant === 'alpha')).toBe(true);
    expect(world.attempts.some((attempt) => attempt.tenant === 'beta')).toBe(true);
    for (let elapsed = 30_000; elapsed <= 20 * 60_000; elapsed += 10_000) {
      advanceOperation(world, start + elapsed);
      expect(world.reservations).toEqual([selected]);
      expectOwnership(world, selected);
    }
    expect(world.attempts.some((attempt) => attempt.tenant === 'alpha' && attempt.phase === 'landed')).toBe(true);
    expect(world.attempts.some((attempt) => attempt.tenant === 'beta' && attempt.phase === 'landed')).toBe(true);
    expect(
      world.facts
        .filter((fact) => fact.attemptId === selectedId)
        .every((fact) => ['order', 'mission'].includes(fact.kind)),
    ).toBe(true);
    expect(
      world.events.some(
        (event) => 'attemptId' in event && event.attemptId === selectedId && event.kind !== 'reservation-expiry',
      ),
    ).toBe(false);
    expect(
      world.events.filter((event) => event.kind === 'reservation-expiry' && event.attemptId === selectedId),
    ).toHaveLength(1);
    expect(operationSummary(world).reserved).toBe(1);
    const counts = capacityStatus(world).capacity!.tenants;
    for (const tenant of ['alpha', 'beta'] as const) {
      expect(counts[tenant]).toMatchObject({
        airborne: world.aircraft.filter((aircraft) => aircraft.tenant === tenant && aircraft.phase === 'flying').length,
        held: tenant === 'alpha' ? 1 : 0,
        queued: world.demand.filter((demand) => demand.tenant === tenant && !demand.attemptId && !demand.cancellation)
          .length,
      });
    }
  });

  it('retains selected mission originals through checkpoint compaction and restart while Alpha background flights continue', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-selected-reservation-'));
    directories.push(directory);
    const path = join(directory, 'world.json');
    const configuration = selectedConfig('selected-history');
    let store = new OperationStore(
      path,
      initialOperationCheckpoint(createOperation(configuration), { mode: 'live', wallAt: start, paused: false }),
    );
    await store.update((state) => advanceOperation(state.world, start + 30_000));
    const selected = structuredClone(store.state.world.reservations![0]!);
    const original = structuredClone(
      store.pendingMissionHeads().find((entry) => entry.fact.attemptId === selected.id)!,
    );
    const change = {
      sourceRevision: 2,
      operatingInterval: { start: iso(start + 120_000), end: iso(start + 40 * 60_000) },
    };
    await store.update((state) => reviseOperationReservation(state.world, selected.id, change));
    const revised = structuredClone(store.state.world.reservations![0]!);
    const background = store.state.world.attempts.find((attempt) => attempt.tenant === 'alpha')!;
    const beforeRefusal = JSON.stringify(store.state.world);
    expect(() => reviseOperationReservation(store.state.world, background.id, change)).toThrow(/held reservation/i);
    expect(JSON.stringify(store.state.world)).toBe(beforeRefusal);
    for (const elapsed of [120_000, 201_337, 12 * 60_000]) {
      await store.update((state) => advanceOperation(state.world, start + elapsed));
      const retained = (await readOperationCheckpoint(path))!;
      expect(retained).toEqual(store.state);
      store = new OperationStore(path, retained);
      expect(store.state.world.reservations).toEqual([revised]);
    }
    const expected = createOperation(configuration);
    advanceOperation(expected, start + 30_000);
    reviseOperationReservation(expected, selected.id, change);
    advanceOperation(expected, start + 12 * 60_000);
    const expectedArchive = compactOperation(expected);
    expect(store.state.world).toEqual(expected);
    const history: OperationHistoryBatch[] = [];
    for await (const batch of readOperationHistory<OperationHistoryBatch>(
      store.historyDirectory,
      store.state.historyBatches,
    ))
      history.push(batch.value);
    expect(history.flatMap((batch) => batch.facts)).toEqual(expectedArchive.facts.map(prepareWorldFact));
    const missionOriginals = history
      .flatMap((batch) => batch.facts)
      .filter((entry) => entry.fact.kind === 'mission' && entry.fact.attemptId === selected.id);
    expect(missionOriginals).toHaveLength(2);
    expect(missionOriginals[0]).toEqual(original);
    expect(
      missionOriginals.map((entry) => JSON.parse(Buffer.from(entry.bytesBase64, 'base64').toString('utf8'))),
    ).toEqual([selected.plan, revised.plan]);
    expect(history.flatMap((batch) => batch.attempts).some((attempt) => attempt.tenant === 'alpha')).toBe(true);
    expect(history.flatMap((batch) => batch.attempts).some((attempt) => attempt.id === selected.id)).toBe(false);
    expect(store.pendingMissionHeads().find((entry) => entry.fact.attemptId === selected.id)).toEqual(original);
    const beforeRefusedJob = JSON.stringify(store.state);
    await expect(
      store.update((state) => {
        state.departureJob = {
          ...selectedJob(departurePlan(state.world, revised)),
          reservationId: `intent-${configuration.runId}-alpha-0:attempt:1`,
        };
      }),
    ).rejects.toThrow(/pinned reservation/i);
    expect(JSON.stringify(store.state)).toBe(beforeRefusedJob);
    expect(await readOperationCheckpoint(path)).toEqual(store.state);
  });

  it('restricts fit and consumer recovery to the selected attempt while preserving tenant-wide and absent profiles', () => {
    const world = createOperation(selectedConfig('selected-eligibility'));
    advanceOperation(world, start + 60_000);
    const selected = world.reservations![0]!;
    reviseOperationReservation(world, selected.id, {
      sourceRevision: 2,
      operatingInterval: { start: iso(world.now), end: selected.order.schedule.end },
    });
    const plan = departurePlan(world, selected);
    const state = initialOperationCheckpoint(world, { mode: 'live', wallAt: world.now, paused: false });
    expect(holdsOperationAttempt(world.config, 'alpha', selected.id)).toBe(true);
    expect(holdsOperationAttempt(world.config, 'beta', selected.id)).toBe(false);
    expect(operationReservationFit(world, selected.id, { marginMs: 10_000 })).toMatchObject({ status: 'fits' });
    expect(() => checkOperationDepartureSelection(state, plan)).not.toThrow();
    const background = world.attempts.find((attempt) => attempt.tenant === 'alpha')!;
    expect(holdsOperationAttempt(world.config, 'alpha', background.id)).toBe(false);
    expect(operationReservationFit(world, background.id, { marginMs: 10_000 })).toMatchObject({
      status: 'held',
      reason: 'reservation_not_held',
    });
    const unrelated = {
      ...plan,
      reservationId: background.id,
      aircraftId: background.aircraftId,
      departureAttemptId: `${background.id}:departure:1`,
    };
    expect(() => checkOperationDepartureSelection(state, unrelated)).toThrow();
    const unrelatedRecovery = structuredClone(state);
    unrelatedRecovery.departureJob = selectedJob(unrelated);
    expect(() => checkOperationDepartureSelection(unrelatedRecovery, unrelated)).toThrow();
    const selectedRecovery = structuredClone(state);
    selectedRecovery.departureJob = selectedJob(plan);
    selectedRecovery.world.reservations = [];
    expect(() => checkOperationDepartureSelection(selectedRecovery, plan)).not.toThrow();

    const old = createOperation({
      ...selectedConfig('selected-old'),
      predeparture: { version: 'reserve-await-release.1', tenant: 'alpha' },
    });
    advanceOperation(old, start + 60_000);
    expect(old.reservations).toHaveLength(3);
    expect(old.attempts.every((attempt) => attempt.tenant === 'beta')).toBe(true);
    expect(holdsOperationAttempt(old.config, 'alpha', 'any-alpha-attempt')).toBe(true);
    const oldReservation = old.reservations![0]!;
    reviseOperationReservation(old, oldReservation.id, {
      sourceRevision: 2,
      operatingInterval: { start: iso(old.now), end: oldReservation.order.schedule.end },
    });
    expect(operationReservationFit(old, oldReservation.id, { marginMs: 10_000 })).toMatchObject({ status: 'fits' });
    expect(() =>
      checkOperationDepartureSelection(
        initialOperationCheckpoint(old, { mode: 'live', wallAt: old.now, paused: false }),
        departurePlan(old, oldReservation),
      ),
    ).not.toThrow();
    const {
      predeparture: _predeparture,
      selectedDemandWindow: _selectedDemandWindow,
      ...normalConfig
    } = selectedConfig('selected-absent');
    const normal = createOperation(normalConfig);
    const configBytes = JSON.stringify(normal.config);
    advanceOperation(normal, start + 60_000);
    expect(Object.hasOwn(normal, 'reservations')).toBe(false);
    expect(Object.hasOwn(normal.config, 'predeparture')).toBe(false);
    expect(JSON.stringify(normal.config)).toBe(configBytes);
    expect(holdsOperationAttempt(normal.config, 'alpha', selected.id)).toBe(false);
  });

  it('keeps a future selected pin immutable through commit refusal and interrupted transaction recovery', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-selected-pin-'));
    directories.push(directory);
    const path = join(directory, 'world.json');
    const configuration = selectedConfig('selected-pin');
    configuration.predeparture.attemptId = `intent-${configuration.runId}-alpha-20:attempt:1`;
    configuration.selectedDemandWindow.attemptId = configuration.predeparture.attemptId;
    const replacement = `intent-${configuration.runId}-alpha-21:attempt:1`;
    const store = new OperationStore(
      path,
      initialOperationCheckpoint(createOperation(configuration), { mode: 'live', wallAt: start, paused: false }),
    );
    await store.update(() => {});
    const committed = structuredClone(store.state);
    const headBytes = await readFile(path);
    expect(committed.world.reservations).toEqual([]);
    await expect(
      store.update((state) => {
        state.world.config.predeparture = { ...configuration.predeparture, attemptId: replacement };
      }),
    ).rejects.toThrow(/configuration.*cannot change/i);
    await expect(
      store.update((state) => {
        delete state.world.config.predeparture;
      }),
    ).rejects.toThrow(/configuration.*cannot change/i);
    expect(store.state).toEqual(committed);
    expect(await readFile(path)).toEqual(headBytes);
    await expect(stat(`${path}.pending`)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(store.historyDirectory)).rejects.toMatchObject({ code: 'ENOENT' });

    const interrupted = vi
      .spyOn(operationHistory, 'writeOperationBatch')
      .mockRejectedValueOnce(new Error('Injected archive interruption'));
    try {
      await expect(store.update((state) => advanceOperation(state.world, start + 10_000))).rejects.toThrow(
        'Injected archive interruption',
      );
    } finally {
      interrupted.mockRestore();
    }
    const pendingPath = `${path}.pending`;
    const envelope = JSON.parse(await readFile(pendingPath, 'utf8')) as {
      version: number;
      body: string;
      sha256: string;
    };
    const transaction = JSON.parse(envelope.body) as { next: OperationCheckpoint };
    expect(transaction.next.world.reservations).toEqual([]);
    transaction.next.world.config.predeparture = { ...configuration.predeparture, attemptId: replacement };
    const body = JSON.stringify(transaction);
    await writeFile(pendingPath, JSON.stringify({ ...envelope, body, sha256: sha256(body) }) + '\n', {
      mode: 0o600,
    });
    const pendingBytes = await readFile(pendingPath);
    const resumed = new OperationStore(path, (await readOperationCheckpoint(path))!);
    const archive = vi.spyOn(operationHistory, 'writeOperationBatch');
    try {
      await expect(resumed.update(() => {})).rejects.toThrow(/configuration.*cannot change/i);
      expect(archive).not.toHaveBeenCalled();
    } finally {
      archive.mockRestore();
    }
    expect(resumed.state).toEqual(committed);
    expect(await readFile(path)).toEqual(headBytes);
    expect(await readFile(pendingPath)).toEqual(pendingBytes);
    await expect(stat(store.historyDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
