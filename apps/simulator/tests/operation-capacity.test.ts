import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  advanceOperation,
  compactOperation,
  createOperation,
  holdAircraft,
  operationCapacityPreset,
  operationSummary,
  upgradeOperationWorld,
  type OperationArchive,
  type OperationWorld,
} from '../../../packages/simulation-models/src/operation.js';

const start = Date.parse('2026-10-15T14:00:00.000Z');
const tenants = ['alpha', 'beta'] as const;

function pressuredWorld(runId: string): OperationWorld {
  const preset = operationCapacityPreset('illustrative-25.1');
  return createOperation({
    ...preset,
    runId,
    start: new Date(start).toISOString(),
    fleet: { alpha: 5, beta: 4 },
    sampleIntervalMs: 30_000,
    turnaroundMs: 120_000,
    chargeMs: 240_000,
    capacity: {
      ...preset.capacity,
      id: 'capacity-pressure.1',
      demandIntervalMs: { alpha: 10_000, beta: 17_000 },
      flightPeople: { alpha: 3, beta: 2 },
      turnaroundCrews: { alpha: 1, beta: 1 },
      chargers: { alpha: 1, beta: 1 },
      launchPads: { alpha: 1, beta: 1 },
    },
  });
}

function expectFiniteResources(world: OperationWorld): void {
  const resources = world.resources!;
  const capacity = world.config.capacity!;
  const phases = {
    flightPeople: 'flying',
    turnaroundCrews: 'turnaround',
    chargers: 'charging',
    launchPads: 'flying',
  } as const;
  for (const kind of ['flightPeople', 'turnaroundCrews', 'chargers', 'launchPads'] as const) {
    const slots = resources[kind];
    expect(new Set(slots.map((slot) => slot.id)).size).toBe(slots.length);
    for (const tenant of tenants) {
      expect(slots.filter((slot) => slot.tenant === tenant)).toHaveLength(capacity[kind][tenant]);
    }
    const busy = slots.filter((slot) => slot.availableAt > world.now);
    expect(new Set(busy.map((slot) => slot.aircraftId)).size).toBe(busy.length);
    for (const slot of busy) {
      const aircraft = world.aircraft.find((row) => row.id === slot.aircraftId);
      expect(aircraft).toBeDefined();
      expect(aircraft!.tenant).toBe(slot.tenant);
      expect(aircraft!.phase).toBe(phases[kind]);
      if (kind === 'flightPeople') {
        const attempt = world.attempts.find((row) => row.id === aircraft!.attemptId)!;
        expect(attempt.personId).toBe(slot.id);
        expect(Date.parse(attempt.landing)).toBe(slot.availableAt);
      }
    }
  }
  for (const [queue, phase] of [
    ['turnaroundQueue', 'waiting-turnaround'],
    ['chargeQueue', 'waiting-charge'],
  ] as const) {
    expect(new Set(resources[queue]).size).toBe(resources[queue].length);
    for (const aircraftId of resources[queue]) {
      expect(world.aircraft.find((aircraft) => aircraft.id === aircraftId)?.phase).toBe(phase);
    }
  }
  const flying = world.attempts.filter((attempt) => attempt.phase === 'flying');
  expect(new Set(flying.map((attempt) => attempt.personId)).size).toBe(flying.length);
  expect(new Set(flying.map((attempt) => attempt.aircraftId)).size).toBe(flying.length);
  expect(world.counters.demand).toBe(
    world.counters.attempts +
      world.counters.cancelled +
      world.demand.filter((demand) => !demand.attemptId && !demand.cancellation).length,
  );
  for (const tenant of tenants) {
    const queued = world.demand.filter(
      (demand) => demand.tenant === tenant && !demand.attemptId && !demand.cancellation,
    );
    const waitingAllowanceMs = tenant === 'alpha' ? 120_000 : 300_000;
    expect(queued.length).toBeLessThanOrEqual(Math.floor(waitingAllowanceMs / capacity.demandIntervalMs[tenant]) + 1);
  }
}

describe('finite operation capacity', () => {
  it('cancels unreachable maintenance demand while actual returns compete for finite people and ground resources', () => {
    const world = pressuredWorld('capacity-maintenance');
    const release = start + 3 * 60_000;
    for (const aircraft of world.aircraft.filter((row) => row.tenant === 'alpha')) {
      holdAircraft(world, aircraft.id, release);
    }
    advanceOperation(world, release - 1);
    expect(world.attempts.some((attempt) => attempt.tenant === 'alpha')).toBe(false);
    expect(world.attempts.some((attempt) => attempt.tenant === 'beta')).toBe(true);
    expectFiniteResources(world);
    expect(world.demand.some((demand) => demand.tenant === 'alpha' && demand.cancellation)).toBe(true);
    expect(world.demand.some((demand) => demand.tenant === 'alpha' && !demand.attemptId && !demand.cancellation)).toBe(
      true,
    );
    expect(world.resources!.chargers.every((slot) => slot.availableAt <= world.now)).toBe(true);

    const phases = new Set<string>();
    for (let elapsed = 3 * 60_000; elapsed <= 60 * 60_000; elapsed += 5_000) {
      advanceOperation(world, start + elapsed);
      expectFiniteResources(world);
      for (const aircraft of world.aircraft) phases.add(aircraft.phase);
    }
    expect(phases.has('waiting-turnaround')).toBe(true);
    expect(phases.has('waiting-charge')).toBe(true);
    expect(world.people).toHaveLength(world.resources!.flightPeople.length + world.resources!.turnaroundCrews.length);
    expect(world.counters.demand).toBe(Math.floor((60 * 60_000) / 10_000) + Math.floor((60 * 60_000) / 17_000) + 2);
    expect(world.counters.cancelled).toBeGreaterThan(0);

    for (const key of ['personId', 'aircraftId'] as const) {
      const identities = new Set(world.attempts.map((attempt) => attempt[key]));
      for (const id of identities) {
        const attempts = world.attempts
          .filter((attempt) => attempt[key] === id)
          .sort((left, right) => Date.parse(left.departure) - Date.parse(right.departure));
        for (let index = 1; index < attempts.length; index++) {
          const previous = attempts[index - 1]!;
          const earliest =
            Date.parse(previous.landing) +
            (key === 'aircraftId' ? world.config.turnaroundMs + world.config.chargeMs : 0);
          expect(Date.parse(attempts[index]!.departure)).toBeGreaterThanOrEqual(earliest);
        }
      }
    }
    expect(
      world.attempts
        .filter((attempt) => attempt.tenant === 'alpha')
        .every((attempt) => Date.parse(attempt.departure) >= release),
    ).toBe(true);
  });

  it('replays exact facts, assignments and resource queues through JSON checkpoints and compaction', () => {
    const config = {
      ...pressuredWorld('capacity-replay').config,
      profile: 'telemetry-delivery-interruption' as const,
      incident: 'landing-disagreement' as const,
    };
    const uninterrupted = createOperation(config);
    const end = start + 90 * 60_000;
    advanceOperation(uninterrupted, end);
    const expectedSummary = operationSummary(uninterrupted);
    const expectedArchive = compactOperation(uninterrupted);

    let resumed = createOperation(config);
    const archive: OperationArchive = { facts: [], demand: [], attempts: [] };
    for (const elapsed of [0, 45_000, 90_000, 150_000, 201_337, 20 * 60_000, 90 * 60_000]) {
      advanceOperation(resumed, start + elapsed);
      expectFiniteResources(resumed);
      const before = operationSummary(resumed);
      const batch = compactOperation(resumed);
      archive.facts.push(...batch.facts);
      archive.demand.push(...batch.demand);
      archive.attempts.push(...batch.attempts);
      expect(operationSummary(resumed)).toEqual(before);
      resumed = upgradeOperationWorld(JSON.parse(JSON.stringify(resumed)));
    }
    expect(resumed.telemetryDeliveryInterruption).toBeDefined();
    expect(archive.facts.some((fact) => fact.kind === 'landing-report')).toBe(true);
    expect(JSON.stringify(archive.facts)).toBe(JSON.stringify(expectedArchive.facts));
    const byIdentity = (left: { id: string }, right: { id: string }) => left.id.localeCompare(right.id);
    expect(archive.attempts.sort(byIdentity)).toEqual(expectedArchive.attempts.sort(byIdentity));
    expect(archive.demand.sort(byIdentity)).toEqual(expectedArchive.demand.sort(byIdentity));
    expect(operationSummary(resumed)).toEqual(expectedSummary);
    expect(resumed).toEqual(uninterrupted);

    const normal = createOperation({ runId: 'capacity-absent', start: new Date(start).toISOString() });
    expect(Object.hasOwn(JSON.parse(JSON.stringify(normal.config)), 'capacity')).toBe(false);
    expect(Object.hasOwn(normal, 'resources')).toBe(false);
    expect(Object.hasOwn(normal.config, 'profile')).toBe(false);
    expect(createHash('sha256').update(JSON.stringify(normal.config)).digest('hex')).toBe(
      '32a6bf752d0fbaa6d35fda5e9670f3a05f4531c22a9df1f493019d884a2c8ef6',
    );
  });

  it('sustains overlap near 25 flights after warmup without exhausting or inventing finite resources', () => {
    const world = createOperation({
      ...operationCapacityPreset('illustrative-25.1'),
      runId: 'capacity-sustained',
      start: new Date(start).toISOString(),
      sampleIntervalMs: 30_000,
    });
    const flyingByHour = [[], []] as number[][];
    let peak = 0;
    for (let elapsed = 0; elapsed < 3 * 60 * 60_000; elapsed += 30_000) {
      advanceOperation(world, start + elapsed);
      expectFiniteResources(world);
      const flying = world.aircraft.filter((aircraft) => aircraft.phase === 'flying').length;
      if (elapsed >= 60 * 60_000) {
        flyingByHour[Math.floor(elapsed / (60 * 60_000)) - 1]!.push(flying);
        peak = Math.max(peak, flying);
      }
      compactOperation(world);
    }
    for (const samples of flyingByHour) {
      const mean = samples.reduce((sum, count) => sum + count, 0) / samples.length;
      expect(mean).toBeGreaterThanOrEqual(23);
      expect(mean).toBeLessThanOrEqual(29);
    }
    expect(peak).toBeGreaterThanOrEqual(25);
    expect(peak).toBeLessThanOrEqual(32);
    expect(world.counters.landed).toBeGreaterThan(400);
    expect(world.facts).toEqual([]);
  });

  it('reaches 25 Alpha flights with finite people and retains cancelled overload through compaction and restart', () => {
    const legacy = operationCapacityPreset('illustrative-25.1');
    expect(JSON.stringify(legacy)).toBe(
      JSON.stringify({
        fleet: { alpha: 25, beta: 25 },
        capacity: {
          id: 'illustrative-25.1',
          demandIntervalMs: { alpha: 24_000, beta: 30_000 },
          flightPeople: { alpha: 16, beta: 16 },
          turnaroundCrews: { alpha: 4, beta: 3 },
          chargers: { alpha: 8, beta: 6 },
          launchPads: { alpha: 2, beta: 1 },
        },
      }),
    );
    const legacyWorld = createOperation({ ...legacy, runId: 'capacity-legacy', start: new Date(start).toISOString() });
    const legacyConfigBytes = JSON.stringify(legacyWorld.config);
    advanceOperation(legacyWorld, start + 60_000);
    compactOperation(legacyWorld);
    expect(JSON.stringify(upgradeOperationWorld(JSON.parse(JSON.stringify(legacyWorld))).config)).toBe(
      legacyConfigBytes,
    );

    const config = {
      ...operationCapacityPreset('alpha-25.1'),
      runId: 'capacity-alpha-25',
      start: new Date(start).toISOString(),
      seed: 71031,
    };
    let world = createOperation(config);
    expect(world.config).toMatchObject({
      cruiseMetersPerSecond: 12,
      turnaroundMs: 60_000,
      chargeMs: 120_000,
      capacity: {
        demandIntervalMs: { alpha: 8_000, beta: 30_000 },
        flightPeople: { alpha: 25, beta: 16 },
      },
    });
    const alphaFlightPeople = world.resources!.flightPeople.filter((person) => person.tenant === 'alpha');
    expect(new Set(alphaFlightPeople.map((person) => person.id)).size).toBe(25);
    expect(world.people.filter((person) => alphaFlightPeople.some((slot) => slot.id === person.id))).toHaveLength(25);
    const peaks = { alpha: 0, beta: 0 };
    const warmPeaks = { alpha: 0, beta: 0 };
    const archive: OperationArchive = { facts: [], demand: [], attempts: [] };
    const warmup = 20 * 60_000;
    let alphaPeakBeforeWarmup = false;
    let belowAlphaCapacityAfterWarmup = false;
    let cancelledAtWarmup = 0;
    for (let elapsed = 0; elapsed <= 60 * 60_000; elapsed += 4_000) {
      advanceOperation(world, start + elapsed);
      expectFiniteResources(world);
      for (const tenant of tenants) {
        const flying = world.aircraft.filter(
          (aircraft) => aircraft.tenant === tenant && aircraft.phase === 'flying',
        ).length;
        peaks[tenant] = Math.max(peaks[tenant], flying);
        if (elapsed >= warmup) warmPeaks[tenant] = Math.max(warmPeaks[tenant], flying);
        if (tenant === 'alpha') {
          if (elapsed < warmup && flying === 25) alphaPeakBeforeWarmup = true;
          if (elapsed >= warmup && flying < 25) belowAlphaCapacityAfterWarmup = true;
        }
      }
      const batch = compactOperation(world);
      if (elapsed <= warmup) {
        archive.facts.push(...batch.facts);
        archive.demand.push(...batch.demand);
        archive.attempts.push(...batch.attempts);
      }
      if (elapsed === 10 * 60_000) world = upgradeOperationWorld(JSON.parse(JSON.stringify(world)));
      if (elapsed === warmup) {
        cancelledAtWarmup = world.counters.cancelled;
        const uninterrupted = createOperation(config);
        advanceOperation(uninterrupted, start + warmup);
        const expectedArchive = compactOperation(uninterrupted);
        const byIdentity = (left: { id: string }, right: { id: string }) => left.id.localeCompare(right.id);
        expect(archive.facts).toEqual(expectedArchive.facts);
        expect(archive.demand.sort(byIdentity)).toEqual(expectedArchive.demand.sort(byIdentity));
        expect(archive.attempts.sort(byIdentity)).toEqual(expectedArchive.attempts.sort(byIdentity));
        expect(world).toEqual(uninterrupted);
      }
    }
    expect(peaks).toEqual({ alpha: 25, beta: 16 });
    expect(alphaPeakBeforeWarmup).toBe(true);
    expect(warmPeaks.alpha).toBeLessThanOrEqual(25);
    expect(warmPeaks.beta).toBeLessThanOrEqual(16);
    expect(belowAlphaCapacityAfterWarmup).toBe(true);
    expect(cancelledAtWarmup).toBeGreaterThan(0);
    expect(world.counters.cancelled).toBeGreaterThan(cancelledAtWarmup);
    expect(archive.demand.some((demand) => demand.cancellation)).toBe(true);
    expect(archive.facts.some((fact) => fact.kind === 'order' && fact.order.state === 'cancelled')).toBe(true);
  });
});
