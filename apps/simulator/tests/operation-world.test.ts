import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  advanceOperation,
  compactOperation,
  createOperation,
  holdAircraft,
  operationSummary,
  upgradeOperationWorld,
  type OperationArchive,
  type OperationWorld,
} from '../../../packages/simulation-models/src/operation.js';
import { places, yards, type Coordinate } from '../../../packages/simulation-models/src/places.js';

const start = Date.parse('2026-10-15T14:00:00.000Z');

function distanceMeters(left: Coordinate, right: Coordinate): number {
  const radians = Math.PI / 180;
  const latitude = Math.sin(((right.latitude - left.latitude) * radians) / 2) ** 2;
  const longitude =
    Math.cos(left.latitude * radians) *
    Math.cos(right.latitude * radians) *
    Math.sin(((right.longitude - left.longitude) * radians) / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(latitude + longitude));
}

describe('restartable operation world', () => {
  it('keeps original facts and every flight moving during an opt-in telemetry delivery interruption', () => {
    const config = { runId: 'delivery-interruption', start: new Date(start).toISOString(), seed: 71031 };
    const normal = createOperation(config);
    const interrupted = createOperation({ ...config, profile: 'telemetry-delivery-interruption' });
    for (const elapsed of [0, 60_000, 120_000, 150_000, 720_000]) {
      advanceOperation(normal, start + elapsed);
      advanceOperation(interrupted, start + elapsed);
      expect(interrupted.facts).toEqual(normal.facts);
      expect(interrupted.aircraft).toEqual(normal.aircraft);
      expect(interrupted.attempts).toEqual(normal.attempts);
      expect(interrupted.events).toEqual(normal.events);
      expect(interrupted.counters).toEqual(normal.counters);
    }
    const first = interrupted.attempts.find((attempt) => attempt.intentId === `intent-${config.runId}-alpha-0`)!;
    expect(interrupted.telemetryDeliveryInterruption).toEqual({
      id: `${first.id}:telemetry-delivery-interruption`,
      aircraftId: first.aircraftId,
      attemptId: first.id,
      sourceSessionId: first.sourceSessionId,
      startsAt: new Date(start + 60_000).toISOString(),
      endsAt: new Date(start + 150_000).toISOString(),
    });
    const positionAt = (at: number) =>
      interrupted.facts.find(
        (fact) => fact.kind === 'position' && fact.attemptId === first.id && Date.parse(fact.at) === at,
      );
    const before = positionAt(start + 60_000);
    const during = positionAt(start + 120_000);
    if (before?.kind !== 'position' || during?.kind !== 'position')
      throw new Error('Interrupted flight positions missing');
    expect(distanceMeters(before.point, during.point)).toBeGreaterThan(100);
    expect(
      interrupted.facts.some(
        (fact) =>
          fact.kind === 'position' &&
          fact.attemptId !== first.id &&
          Date.parse(fact.at) > start + 60_000 &&
          Date.parse(fact.at) < start + 150_000,
      ),
    ).toBe(true);
    expect(Object.hasOwn(normal.config, 'profile')).toBe(false);
    expect(Object.hasOwn(normal, 'telemetryDeliveryInterruption')).toBe(false);
    expect(() =>
      createOperation({ ...config, profile: 'command-link-loss' as 'telemetry-delivery-interruption' }),
    ).toThrow('Unknown world profile');
  });

  it('retains the interruption window through queued dispatch, compaction and pending or recovered restarts', () => {
    const config = {
      runId: 'retained-interruption',
      start: new Date(start).toISOString(),
      fleet: { alpha: 1, beta: 1 },
      profile: 'telemetry-delivery-interruption' as const,
    };
    let world = createOperation(config);
    holdAircraft(world, world.aircraft.find((aircraft) => aircraft.tenant === 'alpha')!.id, start + 30_000);
    advanceOperation(world, start);
    compactOperation(world);
    expect(Object.hasOwn(world, 'telemetryDeliveryInterruption')).toBe(false);
    world = JSON.parse(JSON.stringify(world)) as OperationWorld;
    advanceOperation(world, start + 30_000);
    const retained = structuredClone(world.telemetryDeliveryInterruption!);
    expect(retained.startsAt).toBe(new Date(start + 90_000).toISOString());
    expect(retained.endsAt).toBe(new Date(start + 180_000).toISOString());
    for (const at of [start + 60_000, start + 120_000, start + 180_001, start + 1_200_000]) {
      advanceOperation(world, at);
      compactOperation(world);
      world = upgradeOperationWorld(JSON.parse(JSON.stringify(world)));
      expect(world.telemetryDeliveryInterruption).toEqual(retained);
    }
    expect(world.attempts.some((attempt) => attempt.id === retained.attemptId)).toBe(false);
    const uninterrupted = createOperation(config);
    holdAircraft(
      uninterrupted,
      uninterrupted.aircraft.find((aircraft) => aircraft.tenant === 'alpha')!.id,
      start + 30_000,
    );
    advanceOperation(uninterrupted, start + 1_200_000);
    compactOperation(uninterrupted);
    expect(world).toEqual(uninterrupted);
  });

  it('continues version one worlds with their original source facts and identities', () => {
    const world = createOperation({ runId: 'legacy-replay', start: new Date(start).toISOString() });
    world.version = 'operation-world.1';
    advanceOperation(world, start + 600_000);
    expect(createHash('sha256').update(JSON.stringify(world.facts)).digest('hex')).toBe(
      '572fb9d9ef8043ee07546c4b8ff62fef964e03c474de169ef214748acfa09ecb',
    );
    expect(world.facts.filter((fact) => fact.kind === 'order').every((fact) => fact.order.version === 1)).toBe(true);
    const resumed = JSON.parse(JSON.stringify(world)) as OperationWorld;
    advanceOperation(world, start + 1_200_000);
    advanceOperation(resumed, start + 1_200_000);
    expect(resumed).toEqual(world);
  });

  it('replays a buffered crew disagreement without moving the actual landing or unrelated flights', () => {
    const config = { runId: 'landing-incident', start: new Date(start).toISOString(), seed: 71031 };
    const world = createOperation({ ...config, incident: 'landing-disagreement' });
    advanceOperation(world, start);
    const first = world.attempts[0]!;
    const landingAt = Date.parse(first.landing);
    advanceOperation(world, landingAt + 45_000);
    expect(first.phase).toBe('landed');
    expect(world.facts.find((fact) => fact.kind === 'landing' && fact.attemptId === first.id)?.at).toBe(first.landing);
    expect(world.facts.some((fact) => fact.kind === 'landing-report')).toBe(false);
    const archived = compactOperation(world);
    expect(world.attempts).toContainEqual(first);
    const resumed = JSON.parse(JSON.stringify(world)) as OperationWorld;
    advanceOperation(resumed, landingAt + 90_000);
    const reports = resumed.facts.filter((fact) => fact.kind === 'landing-report');
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      attemptId: first.id,
      aircraftId: first.aircraftId,
      at: new Date(landingAt + 90_000).toISOString(),
      reportAt: new Date(landingAt + 90_000).toISOString(),
      reportedLandingAt: new Date(landingAt + 30_000).toISOString(),
      sourceId: 'simulation-person-alpha-buffered',
      sourceSessionId: `${first.sourceSessionId}-buffered-person`,
      incidentId: `${first.id}:landing-disagreement`,
      incidentCause: 'handset-clock-offset',
      personId: `${config.runId}-person-alpha-ground`,
      personName: 'Avery Collins',
    });
    const uninterrupted = createOperation({ ...config, incident: 'landing-disagreement' });
    advanceOperation(uninterrupted, landingAt + 90_000);
    expect([...archived.facts, ...resumed.facts]).toEqual(uninterrupted.facts);
    const normal = createOperation(config);
    advanceOperation(normal, landingAt + 90_000);
    const byIdentity = (left: { id: string }, right: { id: string }) => left.id.localeCompare(right.id);
    expect([...archived.attempts, ...resumed.attempts].sort(byIdentity)).toEqual(normal.attempts.sort(byIdentity));
    expect(resumed.aircraft).toEqual(normal.aircraft);
    expect(resumed.counters).toEqual(normal.counters);
  });

  it('archives completed history without changing cumulative totals or replay after restart', () => {
    const config = { runId: 'compact', start: new Date(start).toISOString(), seed: 71031 };
    const uninterrupted = createOperation(config);
    advanceOperation(uninterrupted, start + 30 * 60_000);
    const expectedSummary = operationSummary(uninterrupted);
    const expectedArchive = compactOperation(uninterrupted);

    const initial = createOperation(config);
    advanceOperation(initial, start + 7 * 60_000 + 1234);
    const legacy = JSON.parse(JSON.stringify(initial));
    delete legacy.nextFact;
    delete legacy.counters;
    let resumed = upgradeOperationWorld(legacy);
    expect(resumed).toEqual(initial);
    const archives: OperationArchive = { facts: [], demand: [], attempts: [] };
    for (const elapsed of [7 * 60_000 + 1234, 11 * 60_000, 20 * 60_000 + 5678, 30 * 60_000]) {
      advanceOperation(resumed, start + elapsed);
      const before = operationSummary(resumed);
      const archived = compactOperation(resumed);
      archives.facts.push(...archived.facts);
      archives.demand.push(...archived.demand);
      archives.attempts.push(...archived.attempts);
      expect(operationSummary(resumed)).toEqual(before);
      expect(resumed.facts).toEqual([]);
      expect(resumed.demand.every((demand) => !demand.attemptId && !demand.cancellation)).toBe(true);
      expect(resumed.attempts.every((attempt) => attempt.phase === 'flying')).toBe(true);
      resumed = JSON.parse(JSON.stringify(resumed)) as OperationWorld;
    }

    expect(operationSummary(resumed)).toEqual(expectedSummary);
    expect(resumed).toEqual(uninterrupted);
    expect(archives.facts).toEqual(expectedArchive.facts);
    const byIdentity = (left: { id: string }, right: { id: string }) => left.id.localeCompare(right.id);
    expect(archives.demand.sort(byIdentity)).toEqual(expectedArchive.demand.sort(byIdentity));
    expect(archives.attempts.sort(byIdentity)).toEqual(expectedArchive.attempts.sort(byIdentity));
  });

  it('replays the same identities, facts and resource state after a JSON checkpoint', () => {
    const config = { runId: 'replay', start: new Date(start).toISOString(), seed: 71031 };
    const uninterrupted = createOperation(config);
    advanceOperation(uninterrupted, start + 20 * 60_000);

    const initial = createOperation(config);
    advanceOperation(initial, start + 7 * 60_000 + 1234);
    const resumed = JSON.parse(JSON.stringify(initial)) as OperationWorld;
    for (const elapsed of [8 * 60_000, 11 * 60_000 + 5678, 14 * 60_000, 20 * 60_000]) {
      advanceOperation(resumed, start + elapsed);
    }

    expect(resumed).toEqual(uninterrupted);
    expect(new Set(resumed.demand.map((demand) => demand.intentId)).size).toBe(resumed.demand.length);
    expect(new Set(resumed.attempts.map((attempt) => attempt.sourceSessionId)).size).toBe(resumed.attempts.length);
    expect(new Set(resumed.aircraft.map((aircraft) => aircraft.personId)).size).toBe(resumed.people.length);
    expect(new Set(resumed.sites.map((site) => site.id)).size).toBe(resumed.sites.length);
  });

  it('cancels unreachable maintenance demand and dispatches the first remaining feasible promise', () => {
    const world = createOperation({
      runId: 'maintenance',
      start: new Date(start).toISOString(),
      fleet: { alpha: 2, beta: 1 },
      demandIntervalMs: 10_000,
    });
    const release = start + 10 * 60_000;
    for (const aircraft of world.aircraft.filter((aircraft) => aircraft.tenant === 'alpha')) {
      holdAircraft(world, aircraft.id, release);
    }
    advanceOperation(world, release - 1);
    const alphaDemandBeforeRelease = world.demand.filter((demand) => demand.tenant === 'alpha');
    const cancelledBeforeRelease = alphaDemandBeforeRelease.filter((demand) => demand.cancellation);
    const queuedBeforeRelease = alphaDemandBeforeRelease.filter((demand) => !demand.attemptId && !demand.cancellation);
    expect(cancelledBeforeRelease.length).toBeGreaterThan(0);
    expect(alphaDemandBeforeRelease[0]!.cancellation).toBeDefined();
    expect(queuedBeforeRelease.length).toBeGreaterThan(world.config.fleet.alpha);
    expect(alphaDemandBeforeRelease.every((demand) => !demand.attemptId)).toBe(true);
    for (const demand of alphaDemandBeforeRelease) {
      const queuedOrder = world.facts.find((fact) => fact.kind === 'order' && fact.order.order_id === demand.id);
      expect(queuedOrder).toMatchObject({
        kind: 'order',
        at: demand.requestedAt,
        attemptId: `${demand.intentId}:attempt:1`,
        sourceSessionId: `${demand.intentId}-capture-1`,
        order: { version: 1, schedule: demand.window, flights: [] },
      });
      expect(queuedOrder).not.toHaveProperty('aircraftId');
    }
    for (const demand of cancelledBeforeRelease) {
      expect(demand.cancellation?.reason).toBe('requested_window_unreachable');
      expect(world.facts).toContainEqual(
        expect.objectContaining({
          kind: 'order',
          order: expect.objectContaining({
            order_id: demand.id,
            version: 2,
            state: 'cancelled',
            schedule: demand.window,
            cancellation: demand.cancellation,
            flights: [],
          }),
        }),
      );
    }
    expect(world.attempts.some((attempt) => attempt.tenant === 'beta')).toBe(true);

    const firstDemand = queuedBeforeRelease[0]!;
    expect(firstDemand.window).toBeDefined();
    const promisedWindow = structuredClone(firstDemand.window);
    advanceOperation(world, start + 20 * 60_000);
    const alphaAttempts = world.attempts.filter((attempt) => attempt.tenant === 'alpha');
    expect(Date.parse(alphaAttempts[0]!.departure)).toBe(release);
    expect(queuedBeforeRelease[0]!.attemptId).toBe(alphaAttempts[0]!.id);
    expect(firstDemand.window).toEqual(promisedWindow);
    for (const demand of cancelledBeforeRelease) {
      expect(demand.attemptId).toBeUndefined();
      expect(world.attempts.some((attempt) => attempt.demandId === demand.id)).toBe(false);
    }
    const revisions = world.facts.filter((fact) => fact.kind === 'order' && fact.order.order_id === firstDemand.id);
    expect(revisions.map((fact) => fact.order.version)).toEqual([1, 2]);
    expect(revisions[1]).toMatchObject({
      aircraftId: alphaAttempts[0]!.aircraftId,
      attemptId: alphaAttempts[0]!.id,
      sourceSessionId: alphaAttempts[0]!.sourceSessionId,
      order: {
        updated_at: alphaAttempts[0]!.departure,
        schedule: promisedWindow,
        flights: [{ flight_intent_id: firstDemand.intentId, attempt: 1, aircraft_id: alphaAttempts[0]!.aircraftId }],
      },
    });
    expect(world.demand).toHaveLength(121);
    const queued = world.demand.filter((demand) => !demand.attemptId && !demand.cancellation);
    const cancelled = world.demand.filter((demand) => demand.cancellation);
    expect(queued.length).toBeGreaterThan(0);
    expect(world.counters.cancelled).toBe(cancelled.length);
    expect(world.attempts.length + cancelled.length + queued.length).toBe(world.demand.length);
    for (const demand of world.demand.filter((demand) => demand.attemptId)) {
      expect(
        world.attempts.filter((attempt) => attempt.id === demand.attemptId && attempt.demandId === demand.id),
      ).toHaveLength(1);
    }
    for (const aircraft of world.aircraft) {
      const attempts = world.attempts.filter((attempt) => attempt.aircraftId === aircraft.id);
      for (let index = 1; index < attempts.length; index++) {
        expect(Date.parse(attempts[index]!.departure)).toBeGreaterThanOrEqual(
          Date.parse(attempts[index - 1]!.landing) + world.config.turnaroundMs + world.config.chargeMs,
        );
      }
    }
  });

  it('keeps overlapping flights moving and landing on shared routes while facts await delivery', () => {
    const world = createOperation({
      runId: 'undelivered',
      start: new Date(start).toISOString(),
      demandIntervalMs: 10_000,
      sampleIntervalMs: 5_000,
    });
    advanceOperation(world, start + 60_000);
    const awaitingDelivery = structuredClone(world.facts);
    expect(world.attempts.filter((attempt) => attempt.phase === 'flying').length).toBeGreaterThan(1);
    advanceOperation(world, start + 12 * 60_000);

    expect(world.now).toBe(start + 12 * 60_000);
    expect(world.facts.slice(0, awaitingDelivery.length)).toEqual(awaitingDelivery);
    const landed = world.attempts.filter((attempt) => attempt.phase === 'landed');
    expect(landed.length).toBeGreaterThan(1);
    for (const attempt of landed) {
      const origin = yards[`tenant-${attempt.tenant}`]!;
      expect(attempt.origin).toEqual({ latitude: origin.latitude, longitude: origin.longitude });
      expect(Object.values(places)).toContainEqual(attempt.destination);
      const positions = world.facts.filter((fact) => fact.kind === 'position' && fact.attemptId === attempt.id);
      expect(positions[0]!.point).toMatchObject(attempt.origin);
      expect(positions.at(-1)!.point).toMatchObject(attempt.origin);
      expect(positions.some((fact) => distanceMeters(fact.point, attempt.destination) < 1)).toBe(true);
      expect(world.facts.filter((fact) => fact.kind === 'landing' && fact.attemptId === attempt.id)).toHaveLength(1);
      for (let index = 1; index < positions.length; index++) {
        const previous = positions[index - 1]!;
        const current = positions[index]!;
        const seconds = (Date.parse(current.at) - Date.parse(previous.at)) / 1000;
        expect(distanceMeters(previous.point, current.point) / seconds).toBeLessThanOrEqual(
          world.config.cruiseMetersPerSecond + 0.1,
        );
        expect(current.sourceSessionId).toBe(attempt.sourceSessionId);
      }
    }
  });
});
