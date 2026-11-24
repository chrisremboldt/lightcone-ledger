import { describe, expect, it } from 'vitest';
import {
  advanceOperation,
  compactOperation,
  createOperation,
  enableOperationOrdinaryWork,
  holdAircraft,
  type OperationWorld,
  type WorldFact,
} from '../../../packages/simulation-models/src/operation.js';

const start = Date.parse('2026-10-17T14:00:00.000Z');
const leadMs = 900_000;
type OrderFact = Extract<WorldFact, { kind: 'order' }>;

function ordinaryWorld(runId: string): OperationWorld {
  return createOperation({
    runId,
    start: new Date(start).toISOString(),
    fleet: { alpha: 3, beta: 2 },
    demandIntervalMs: 150_000,
    sampleIntervalMs: 10_000,
  });
}

function orders(facts: WorldFact[], orderId: string): OrderFact[] {
  return facts.filter((fact): fact is OrderFact => fact.kind === 'order' && fact.order.order_id === orderId);
}

describe('prospective ordinary demand windows', () => {
  it('accepts work ahead without assigning resources and dispatches due work behind future requests', () => {
    const world = ordinaryWorld('upcoming-dispatch');
    enableOperationOrdinaryWork(world);
    expect(world.ordinaryWork!.demandLeadMs).toBe(leadMs);
    const aircraft = structuredClone(world.aircraft);
    const pads = structuredClone(world.pads);
    const chargers = structuredClone(world.chargers);
    advanceOperation(world, start);
    const demand = structuredClone(world.demand[0]!);
    const accepted = orders(world.facts, demand.id)[0]!;
    const originalBytes = JSON.stringify(accepted.order);
    expect(accepted).toMatchObject({
      at: new Date(start).toISOString(),
      order: {
        version: 1,
        state: 'accepted',
        flights: [],
        schedule: { start: new Date(start + leadMs).toISOString() },
      },
    });
    expect(accepted).not.toHaveProperty('aircraftId');
    advanceOperation(world, start + leadMs - 1);
    expect(world.attempts).toEqual([]);
    expect(world.aircraft).toEqual(aircraft);
    expect(world.pads).toEqual(pads);
    expect(world.chargers).toEqual(chargers);
    expect(world.demand.every((row) => !row.attemptId && !row.cancellation)).toBe(true);
    world.demand.reverse();
    expect(Date.parse(world.demand[0]!.window!.start)).toBeGreaterThan(start + leadMs);
    advanceOperation(world, start + leadMs);
    const attempt = world.attempts.find((row) => row.demandId === demand.id)!;
    expect(attempt.departure).toBe(demand.window!.start);
    const revisions = orders(world.facts, demand.id);
    expect(revisions.map((fact) => fact.order.version)).toEqual([1, 2]);
    expect(revisions.map((fact) => fact.order.schedule)).toEqual([demand.window, demand.window]);
    expect(JSON.stringify(revisions[0]!.order)).toBe(originalBytes);
    expect(world.attempts).toHaveLength(1);
    expect(world.demand.filter((row) => Date.parse(row.window!.start) > world.now).every((row) => !row.attemptId)).toBe(
      true,
    );
  });

  it('activates prospectively without changing an airborne flight, its promise or retained configuration', () => {
    const world = ordinaryWorld('upcoming-activation');
    advanceOperation(world, start);
    const original = structuredClone(world.attempts[0]!);
    const originalFacts = structuredClone(world.facts);
    const originalEvents = structuredClone(world.events);
    const originalConfig = JSON.stringify(world.config);
    const originalAircraft = structuredClone(world.aircraft);
    enableOperationOrdinaryWork(world);
    expect(JSON.stringify(world.config)).toBe(originalConfig);
    expect(world.attempts).toEqual([original]);
    expect(world.facts).toEqual(originalFacts);
    expect(world.aircraft).toEqual(originalAircraft);
    for (const event of originalEvents) expect(world.events).toContainEqual(event);
    expect(world.events.filter((event) => event.kind === 'landing' && event.attemptId === original.id)).toEqual(
      originalEvents.filter((event) => event.kind === 'landing' && event.attemptId === original.id),
    );
    advanceOperation(world, start + 150_000);
    const next = world.demand.find((demand) => demand.requestedAt === new Date(start + 150_000).toISOString())!;
    expect(next.window!.start).toBe(new Date(start + 150_000 + leadMs).toISOString());
    expect(next.attemptId).toBeUndefined();
    expect(orders(world.facts, original.demandId)).toEqual(orders(originalFacts, original.demandId));
    expect(world.attempts.find((attempt) => attempt.id === original.id)).toEqual(original);
    expect(world.events.filter((event) => event.kind === 'landing' && event.attemptId === original.id)).toEqual(
      originalEvents.filter((event) => event.kind === 'landing' && event.attemptId === original.id),
    );
    const retained = JSON.stringify(world.ordinaryWork);
    enableOperationOrdinaryWork(world);
    expect(JSON.stringify(world.ordinaryWork)).toBe(retained);
    expect(JSON.stringify(world.config)).toBe(originalConfig);
  });

  it('keeps future work bounded and cancels the original promise exactly across restart and compaction', () => {
    let world = ordinaryWorld('upcoming-maintenance');
    enableOperationOrdinaryWork(world);
    for (const aircraft of world.aircraft.filter((row) => row.tenant === 'alpha'))
      holdAircraft(world, aircraft.id, start + 3 * 60 * 60_000);
    const uninterrupted = structuredClone(world);
    advanceOperation(world, start);
    const demand = structuredClone(world.demand[0]!);
    const facts = compactOperation(world).facts;
    const accepted = orders(facts, demand.id)[0]!;
    const originalBytes = JSON.stringify(accepted.order);
    world = JSON.parse(JSON.stringify(world)) as OperationWorld;
    const cancellationAt = start + leadMs + 120_001;
    advanceOperation(world, cancellationAt - 1);
    expect(world.demand.find((row) => row.id === demand.id)?.cancellation).toBeUndefined();
    advanceOperation(world, cancellationAt);
    facts.push(...compactOperation(world).facts);
    const cancellation = orders(facts, demand.id)[1]!;
    expect(cancellation).toMatchObject({
      at: new Date(cancellationAt).toISOString(),
      attemptId: accepted.attemptId,
      sourceSessionId: accepted.sourceSessionId,
      order: {
        version: 2,
        state: 'cancelled',
        flights: [],
        schedule: accepted.order.schedule,
        cancellation: { reason: 'requested_window_unreachable', decidedAt: new Date(cancellationAt).toISOString() },
      },
    });
    expect(world.demand.some((row) => row.id === demand.id)).toBe(false);
    world = JSON.parse(JSON.stringify(world)) as OperationWorld;
    for (let elapsed = 18 * 60_000; elapsed <= 2 * 60 * 60_000; elapsed += 60_000) {
      advanceOperation(world, start + elapsed);
      facts.push(...compactOperation(world).facts);
      expect(world.demand.length).toBeLessThanOrEqual(9);
      expect(world.counters.demand).toBe(world.counters.attempts + world.counters.cancelled + world.demand.length);
    }
    advanceOperation(uninterrupted, start + 2 * 60 * 60_000);
    const expected = compactOperation(uninterrupted);
    const originals = orders(facts, demand.id);
    expect(originals.map((fact) => fact.order.version)).toEqual([1, 2]);
    expect(JSON.stringify(originals[0]!.order)).toBe(originalBytes);
    expect(originals).toEqual(orders(expected.facts, demand.id));
    expect(world.attempts.some((attempt) => attempt.demandId === demand.id)).toBe(false);
    expect(world).toEqual(uninterrupted);
  });
});
