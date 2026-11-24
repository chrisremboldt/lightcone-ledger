import { describe, expect, it } from 'vitest';
import { createWorld } from '../../../packages/simulation-models/src/index.js';
import { runScoped, scenarioConfig, scenarioKey, worldForRun } from '../src/scenario.js';

const originationKeys = (world: ReturnType<typeof createWorld>) =>
  world.flights.map((flight) => `${flight.intentId}:attempt:${flight.attempt}`);
const orderIds = (world: ReturnType<typeof createWorld>) =>
  [...world.orders.alpha, ...world.orders.beta].map((order) => order.order_id);

describe('scenario run identities', () => {
  const seeded = createWorld(71031, '2026-10-01T14:00:00.000Z');

  it('gives every intent, order and order reference the run id and leaves times, aircraft and counts alone', () => {
    const world = worldForRun(seeded, 'run-a');
    expect(world.flights.map((flight) => flight.intentId)).toEqual(
      seeded.flights.map((flight) => `${flight.intentId}-run-a`),
    );
    expect(world.flights.map(({ start, end, aircraftId, tenant }) => ({ start, end, aircraftId, tenant }))).toEqual(
      seeded.flights.map(({ start, end, aircraftId, tenant }) => ({ start, end, aircraftId, tenant })),
    );
    expect(world.expected).toEqual({
      ...seeded.expected,
      logicalIntents: seeded.expected.logicalIntents.map((id) => `${id}-run-a`),
      cancelledOrder: `${seeded.expected.cancelledOrder}-run-a`,
    });
    const intents = new Set(world.flights.map((flight) => flight.intentId));
    const orders = new Set(orderIds(world));
    for (const order of [...world.orders.alpha, ...world.orders.beta])
      for (const flight of order.flights) {
        expect(intents.has(flight.flight_intent_id)).toBe(true);
        expect(flight.order_refs.every((id) => orders.has(id))).toBe(true);
      }
    for (const flight of world.flights) expect(flight.orderIds.every((id) => orders.has(id))).toBe(true);
    expect(
      world.flights.filter((flight) => flight.orderIds.includes(runScoped('order-alpha-split', 'run-a'))),
    ).toHaveLength(2);
    expect(seeded.flights[0]!.intentId).toBe('intent-alpha-01');
  });

  it('shares no origination key, order id or idempotency key between two runs of one seed', () => {
    const first = worldForRun(seeded, 'run-a');
    const second = worldForRun(seeded, 'run-b');
    expect(worldForRun(seeded, 'run-a')).toEqual(first);
    const firstKeys = new Set([...originationKeys(first), ...orderIds(first)]);
    expect([...originationKeys(second), ...orderIds(second)].filter((key) => firstKeys.has(key))).toEqual([]);
    expect(scenarioKey(first, 'run-a', 'decision')).toBe('scenario:71031:run-a:decision');
    expect(scenarioKey(second, 'run-b', 'decision')).not.toBe(scenarioKey(first, 'run-a', 'decision'));
  });

  it('takes a fixed run id from the environment and otherwise draws a fresh one', () => {
    expect(scenarioConfig({ SIMULATOR_RUN_ID: 'recording-1' }).runId).toBe('recording-1');
    const drawn = [scenarioConfig({}).runId, scenarioConfig({}).runId];
    expect(drawn[0]).toMatch(/^[a-f0-9]{12}$/);
    expect(drawn[0]).not.toBe(drawn[1]);
    expect(() => scenarioConfig({ SIMULATOR_RUN_ID: 'run:a' })).toThrow('SIMULATOR_RUN_ID');
  });
});
