import { describe, expect, it } from 'vitest';
import { createWorld, entityRandom } from '../../../packages/simulation-models/src/index.js';
import { scenarioConfig } from '../src/scenario.js';

describe('independent seeded world', () => {
  it('reproduces ten overlapping operations with separate demand identities', () => {
    const world = createWorld(71031);
    expect(createWorld(71031)).toEqual(world);
    expect(world.flights).toHaveLength(10);
    expect(new Set(world.flights.map((flight) => flight.intentId)).size).toBe(10);
    const anchor = Date.parse(world.start);
    const window = (index: number) => ({
      start: Date.parse(world.flights[index]!.start),
      end: Date.parse(world.flights[index]!.end),
    });
    expect(window(0).end).toBeLessThan(anchor);
    expect(window(1).start).toBeLessThan(anchor);
    expect(window(1).end).toBeGreaterThan(anchor);
    expect(window(8).start).toBeLessThan(anchor);
    expect(window(8).end).toBeGreaterThan(anchor);
    expect(window(4).start).toBeGreaterThan(anchor);
    expect(world.flights.every((flight) => Date.parse(flight.end) > Date.parse(flight.start))).toBe(true);
    expect(world.flights.filter((flight) => flight.orderIds.includes('order-alpha-split'))).toHaveLength(2);
    expect(world.flights.find((flight) => flight.intentId === 'intent-alpha-03')!.orderIds).toHaveLength(2);
  });
  it('extra randomness consumed by one entity cannot move another entity', () => {
    const first = entityRandom(71031, 'aircraft-a');
    const second = entityRandom(71031, 'aircraft-b');
    const expected = entityRandom(71031, 'aircraft-b');
    for (let index = 0; index < 50; index++) first();
    expect(Array.from({ length: 10 }, () => second())).toEqual(Array.from({ length: 10 }, () => expected()));
    expect(createWorld(71032).flights.map((flight) => flight.end)).not.toEqual(
      createWorld(71031).flights.map((flight) => flight.end),
    );
  });
  it('cannot accidentally use local fixed credentials against a remote target', () => {
    expect(() => scenarioConfig({ LEDGER_API_URL: 'https://production.example.invalid' })).toThrow('isolated');
    expect(() =>
      scenarioConfig({ LEDGER_API_URL: 'https://simulation.example.invalid', LEDGER_SIMULATION_TARGET: 'isolated' }),
    ).toThrow('must be supplied');
    expect(() => scenarioConfig({ LEDGER_ENV: 'staging', LEDGER_SIMULATION_TARGET: 'isolated' })).toThrow(
      'must be supplied',
    );
    expect(scenarioConfig({}).callbackHost).toBe('127.0.0.1');
  });
});
