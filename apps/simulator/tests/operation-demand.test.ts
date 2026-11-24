import { describe, expect, it } from 'vitest';
import {
  advanceOperation,
  allocateOperationDeparture,
  buildOperationRouteTimeline,
  compactOperation,
  createOperation,
  holdAircraft,
  operationCapacityPreset,
  operationSummary,
  reviseOperationReservation,
  type OperationWorld,
  type WorldFact,
} from '../../../packages/simulation-models/src/operation.js';

const start = Date.parse('2026-10-17T14:00:00.000Z');
type OrderFact = Extract<WorldFact, { kind: 'order' }>;

function orderFacts(facts: WorldFact[], orderId: string): OrderFact[] {
  return facts.filter((fact): fact is OrderFact => fact.kind === 'order' && fact.order.order_id === orderId);
}

function heldDelivery(releaseAfterMs: number): OperationWorld {
  const world = createOperation({
    runId: 'demand-deadline',
    start: new Date(start).toISOString(),
    fleet: { alpha: 1, beta: 1 },
    demandIntervalMs: 3_600_000,
  });
  holdAircraft(world, world.aircraft.find((aircraft) => aircraft.tenant === 'alpha')!.id, start + releaseAfterMs);
  return world;
}

function futureSelectedHold(runId: string): OperationWorld {
  return createOperation({
    runId,
    start: new Date(start).toISOString(),
    fleet: { alpha: 1, beta: 1 },
    capacity: {
      id: 'finite-selected-hold.1',
      demandIntervalMs: { alpha: 3_600_000, beta: 3_600_000 },
      flightPeople: { alpha: 1, beta: 1 },
      turnaroundCrews: { alpha: 1, beta: 1 },
      chargers: { alpha: 1, beta: 1 },
      launchPads: { alpha: 1, beta: 1 },
    },
    predeparture: {
      version: 'reserve-selected-await-release.1',
      tenant: 'alpha',
      attemptId: `intent-${runId}-alpha-0:attempt:1`,
    },
    selectedDemandWindow: {
      attemptId: `intent-${runId}-alpha-0:attempt:1`,
      start: new Date(start + 600_000).toISOString(),
      end: new Date(start + 2_400_000).toISOString(),
    },
  });
}

describe('finite demand promises', () => {
  it('expires a held flight only after its last feasible departure and releases resources without changing originals', () => {
    const world = futureSelectedHold('held-window-expiry');
    advanceOperation(world, start);
    const original = structuredClone(world.reservations![0]!);
    const route = buildOperationRouteTimeline(original, world.config.cruiseMetersPerSecond);
    if (route.status !== 'supported') throw new Error(route.reason);
    const latestDeparture = Date.parse(original.order.schedule.end) - route.timeline.durationMs;
    const sourceFacts = structuredClone(world.facts.filter((fact) => fact.attemptId === original.id));
    advanceOperation(world, start + 300_000);
    expect(world.reservations![0]).toEqual(original);
    expect(operationSummary(world)).toMatchObject({ reserved: 1, cancelled: 0, queued: 0 });
    advanceOperation(world, latestDeparture);
    expect(world.reservations![0]!.phase).toBe('awaiting-release');
    const digest = 'a'.repeat(64);
    const allocation = allocateOperationDeparture(world, {
      id: 'held-window-allocation',
      flightId: 'held-window-flight',
      reservationId: original.id,
      departureAttemptId: 'held-window-departure',
      mission: {
        missionId: 'held-window-mission',
        sourceRevision: original.plan.sourceRevision,
        eventId: 'held-window-mission-event',
        contentDigest: digest,
        recordDigest: digest,
      },
      release: { id: 'held-window-release', digest },
      durationMs: 90_000,
    });
    expect(world.resources!.launchPads.find((pad) => pad.id === allocation.padId)).toMatchObject({
      aircraftId: original.aircraftId,
      availableAt: Date.parse(allocation.endsAt),
    });

    let resumed = JSON.parse(JSON.stringify(world)) as OperationWorld;
    advanceOperation(resumed, latestDeparture + 1);
    const cancelled = resumed.reservations![0]!;
    expect(cancelled).toMatchObject({ phase: 'cancelled', order: original.order, plan: original.plan });
    expect(cancelled.cancellation?.decidedAt).toBe(new Date(latestDeparture + 1).toISOString());
    expect(resumed.departureAllocations).toEqual([allocation]);
    const aircraft = resumed.aircraft.find((row) => row.id === original.aircraftId)!;
    expect(aircraft).toMatchObject({ phase: 'ready', availableAt: latestDeparture + 1 });
    expect(aircraft.attemptId).toBeUndefined();
    for (const [kind, id] of [
      ['flightPeople', original.personId],
      ['launchPads', allocation.padId],
    ] as const) {
      const resource = resumed.resources![kind].find((row) => row.id === id)!;
      expect(resource.availableAt).toBe(latestDeparture + 1);
      expect(resource.aircraftId).toBeUndefined();
    }
    const facts = resumed.facts.filter((fact) => fact.attemptId === original.id);
    expect(facts.slice(0, sourceFacts.length)).toEqual(sourceFacts);
    expect(orderFacts(facts, original.demandId).map((fact) => fact.order.version)).toEqual([1, 2, 3]);
    expect(orderFacts(facts, original.demandId).at(-1)!.order).toMatchObject({
      state: 'cancelled',
      schedule: original.order.schedule,
      flights: original.order.flights,
      cancellation: cancelled.cancellation,
    });
    expect(facts.filter((fact) => fact.kind === 'cancellation')).toEqual([
      expect.objectContaining({
        at: new Date(latestDeparture + 1).toISOString(),
        attemptId: original.id,
        sourceSessionId: original.sourceSessionId,
        reason: 'requested_window_unreachable',
        personId: 'held-window-expiry-dispatcher-alpha',
        personName: 'Alpha dispatch',
      }),
    ]);
    expect(facts.some((fact) => fact.kind === 'departure')).toBe(false);
    expect(operationSummary(resumed)).toMatchObject({ demand: 2, reserved: 0, cancelled: 1, queued: 0 });

    compactOperation(resumed);
    resumed = JSON.parse(JSON.stringify(resumed)) as OperationWorld;
    advanceOperation(resumed, latestDeparture + 90_001);
    expect(resumed.facts.filter((fact) => fact.attemptId === original.id)).toEqual([]);
    expect(resumed.departureAllocations).toEqual([allocation]);
    expect(resumed.reservations![0]).toMatchObject({ phase: 'cancelled', order: original.order, plan: original.plan });
    expect(operationSummary(resumed)).toMatchObject({ reserved: 0, cancelled: 1, queued: 0 });
  });

  it('moves held expiry earlier for a longer revised route while preserving the original customer window', () => {
    const world = futureSelectedHold('revised-window-expiry');
    advanceOperation(world, start);
    const original = structuredClone(world.reservations![0]!);
    const nominal = buildOperationRouteTimeline(original, world.config.cruiseMetersPerSecond);
    if (nominal.status !== 'supported') throw new Error(nominal.reason);
    const route = structuredClone(original.plan.route);
    route.geometry.coordinates.splice(1, 0, [original.origin.longitude + 0.01, original.origin.latitude + 0.01]);
    reviseOperationReservation(world, original.id, { sourceRevision: 2, route });
    const revised = structuredClone(world.reservations![0]!);
    const built = buildOperationRouteTimeline(revised, world.config.cruiseMetersPerSecond);
    if (built.status !== 'supported') throw new Error(built.reason);
    expect(built.timeline.durationMs).toBeGreaterThan(nominal.timeline.durationMs);
    expect(revised.order).toEqual(original.order);
    const latestDeparture = Date.parse(original.order.schedule.end) - built.timeline.durationMs;
    expect(
      world.events.filter((event) => event.kind === 'reservation-expiry' && event.attemptId === original.id),
    ).toEqual([expect.objectContaining({ at: latestDeparture + 1 })]);
    advanceOperation(world, latestDeparture);
    expect(world.reservations![0]).toEqual(revised);
    advanceOperation(world, latestDeparture + 1);
    expect(world.reservations![0]).toMatchObject({ phase: 'cancelled', order: original.order, plan: revised.plan });
    expect(world.facts.filter((fact) => fact.kind === 'cancellation' && fact.attemptId === original.id)).toHaveLength(
      1,
    );
  });

  it('cancels a future request that cannot fit its flight before reserving aircraft or crew', () => {
    const world = createOperation({
      ...operationCapacityPreset('illustrative-25.1'),
      runId: 'impossible-future',
      start: new Date(start).toISOString(),
      fleet: { alpha: 1, beta: 1 },
      predeparture: {
        version: 'reserve-selected-await-release.1',
        tenant: 'alpha',
        attemptId: 'intent-impossible-future-alpha-0:attempt:1',
      },
      selectedDemandWindow: {
        attemptId: 'intent-impossible-future-alpha-0:attempt:1',
        start: new Date(start + 600_000).toISOString(),
        end: new Date(start + 600_001).toISOString(),
      },
    });
    advanceOperation(world, start);
    expect(world.reservations).toEqual([]);
    expect(world.aircraft.find((aircraft) => aircraft.tenant === 'alpha')!.phase).toBe('ready');
    expect(
      world.resources!.flightPeople.filter((person) => person.tenant === 'alpha').every((person) => !person.aircraftId),
    ).toBe(true);
    expect(world.facts).toContainEqual(
      expect.objectContaining({
        kind: 'order',
        order: expect.objectContaining({ state: 'cancelled', version: 2 }),
        attemptId: 'intent-impossible-future-alpha-0:attempt:1',
      }),
    );
  });

  it('dispatches at the last feasible millisecond with the original promise and cancels one millisecond later', () => {
    const onTime = heldDelivery(120_000);
    advanceOperation(onTime, start);
    const demand = onTime.demand[0]!;
    const promise = structuredClone(demand.window!);
    expect(demand.attemptId).toBeUndefined();

    advanceOperation(onTime, start + 120_000);
    const attempt = onTime.attempts.find((row) => row.demandId === demand.id)!;
    expect(attempt.departure).toBe(new Date(start + 120_000).toISOString());
    expect(attempt.landing).toBe(promise.end);
    expect(orderFacts(onTime.facts, demand.id).map((fact) => fact.order.schedule)).toEqual([promise, promise]);
    expect(onTime.counters.cancelled).toBe(0);

    const late = heldDelivery(120_001);
    advanceOperation(late, start + 120_001);
    expect(late.attempts).toEqual([]);
    expect(late.counters.cancelled).toBe(1);
    const revisions = orderFacts(late.facts, demand.id);
    expect(revisions.map((fact) => fact.order.version)).toEqual([1, 2]);
    expect(revisions[1]).toMatchObject({
      at: new Date(start + 120_001).toISOString(),
      order: {
        state: 'cancelled',
        schedule: promise,
        flights: [],
        cancellation: {
          reason: 'requested_window_unreachable',
          decidedAt: new Date(start + 120_001).toISOString(),
          dispatcher: { id: 'demand-deadline-dispatcher-alpha', name: 'Alpha dispatch' },
        },
      },
    });
    expect(revisions[1]!.order.cancellation!.note).toContain('medical delivery');
    expect(late.aircraft.every((aircraft) => !aircraft.attemptId)).toBe(true);
  });

  it('bounds overnight pressure while the hosted cadence serves most demand with overlapping flights', () => {
    const results = [30_000, 150_000].map((demandIntervalMs) => {
      const world = createOperation({
        runId: `demand-overnight-${demandIntervalMs}`,
        start: new Date(start).toISOString(),
        fleet: { alpha: 3, beta: 2 },
        demandIntervalMs,
      });
      let peakFlying = 0;
      let peakQueued = 0;
      for (let elapsed = 0; elapsed <= 24 * 60 * 60_000; elapsed += 30_000) {
        advanceOperation(world, start + elapsed);
        const queued = world.demand.filter((demand) => !demand.attemptId && !demand.cancellation);
        expect(
          queued.every(
            (demand) =>
              start + elapsed - Date.parse(demand.requestedAt) <= (demand.tenant === 'alpha' ? 120_000 : 300_000),
          ),
        ).toBe(true);
        peakQueued = Math.max(peakQueued, queued.length);
        peakFlying = Math.max(peakFlying, world.aircraft.filter((aircraft) => aircraft.phase === 'flying').length);
        expect(world.counters.demand).toBe(world.counters.attempts + world.counters.cancelled + queued.length);
        compactOperation(world);
        expect(world.demand).toEqual(queued);
      }
      return { ...world.counters, peakQueued, peakFlying };
    });
    const pressured = results[0]!;
    const hosted = results[1]!;
    expect(pressured.cancelled).toBeGreaterThan(0);
    expect(pressured.peakQueued).toBeLessThanOrEqual(8);
    expect(hosted.attempts / hosted.demand).toBeGreaterThan(0.9);
    expect(hosted.peakQueued).toBeLessThanOrEqual(3);
    expect(hosted.peakFlying).toBeGreaterThan(1);
    expect(hosted.peakFlying).toBeLessThanOrEqual(5);
  });

  it('retains one exact cancellation through restart and terminal compaction without allocating flight resources', () => {
    const world = createOperation({
      runId: 'demand-restart',
      start: new Date(start).toISOString(),
      fleet: { alpha: 1, beta: 1 },
      capacity: {
        id: 'held-demand.1',
        demandIntervalMs: { alpha: 3_600_000, beta: 3_600_000 },
        flightPeople: { alpha: 1, beta: 1 },
        turnaroundCrews: { alpha: 1, beta: 1 },
        chargers: { alpha: 1, beta: 1 },
        launchPads: { alpha: 1, beta: 1 },
      },
    });
    for (const aircraft of world.aircraft) holdAircraft(world, aircraft.id, start + 600_001);
    const resources = structuredClone(world.resources);
    const uninterrupted = structuredClone(world);
    advanceOperation(world, start);
    const accepted = compactOperation(world);
    const acceptedOrder = accepted.facts.find((fact) => fact.kind === 'order' && fact.tenant === 'alpha')!;
    if (acceptedOrder.kind !== 'order') throw new Error('Initial medical order missing');
    let resumed = JSON.parse(JSON.stringify(world)) as OperationWorld;
    advanceOperation(resumed, start + 120_001);
    const cancelled = compactOperation(resumed);
    const original = orderFacts(cancelled.facts, acceptedOrder.order.order_id);
    expect(original).toHaveLength(1);
    expect(original[0]).toMatchObject({
      attemptId: acceptedOrder.attemptId,
      sourceSessionId: acceptedOrder.sourceSessionId,
      order: { version: 2, state: 'cancelled', schedule: acceptedOrder.order.schedule, flights: [] },
    });
    expect(cancelled.demand.find((demand) => demand.id === acceptedOrder.order.order_id)).toMatchObject({
      cancellation: original[0]!.order.cancellation,
    });
    expect(resumed.demand.some((demand) => demand.id === acceptedOrder.order.order_id)).toBe(false);
    expect(resumed.resources).toEqual(resources);
    expect(resumed.aircraft.every((aircraft) => aircraft.phase === 'ready' && !aircraft.attemptId)).toBe(true);
    expect(resumed.counters.attempts).toBe(0);

    resumed = JSON.parse(JSON.stringify(resumed)) as OperationWorld;
    advanceOperation(resumed, start + 600_001);
    const afterRestart = compactOperation(resumed);
    expect(orderFacts(afterRestart.facts, acceptedOrder.order.order_id)).toEqual([]);
    expect(resumed.resources).toEqual(resources);
    expect(resumed.counters).toMatchObject({ demand: 2, attempts: 0, cancelled: 2 });
    advanceOperation(uninterrupted, start + 600_001);
    const expected = compactOperation(uninterrupted);
    expect([...accepted.facts, ...cancelled.facts, ...afterRestart.facts]).toEqual(expected.facts);
    expect(JSON.stringify(original[0]!.order)).toBe(
      JSON.stringify(orderFacts(expected.facts, acceptedOrder.order.order_id)[1]!.order),
    );
    expect(resumed).toEqual(uninterrupted);
  });
});
