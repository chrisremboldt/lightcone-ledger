import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import {
  SimulationAvoidanceDemoConfigSchema,
  SimulationAvoidanceDemoCycleSchema,
  SimulationAvoidanceDemoPrepareSchema,
  SimulationAvoidanceDemoProgressSchema,
  SimulationAvoidanceDemoPreparationQuerySchema,
} from '../src/simulation-avoidance-demo.js';
import {
  simulationAvoidanceDemoConfig,
  simulationAvoidanceDemoCycle,
  simulationAvoidanceDemoPrepare,
  simulationAvoidanceDemoProgress,
} from '../fixtures/demo/v1/simulation-avoidance-demo.js';

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
describe('repeatable avoidance demo contract', () => {
  it('retains exact accepted control and explicitly configured source scope', () => {
    for (const [schema, value] of [
      [SimulationAvoidanceDemoConfigSchema, simulationAvoidanceDemoConfig],
      [SimulationAvoidanceDemoCycleSchema, simulationAvoidanceDemoCycle],
      [SimulationAvoidanceDemoPrepareSchema, simulationAvoidanceDemoPrepare],
      [SimulationAvoidanceDemoProgressSchema, simulationAvoidanceDemoProgress],
    ] as const) {
      const valid = ajv.compile(schema);
      expect(valid(value), JSON.stringify(valid.errors)).toBe(true);
      expect(valid({ ...value, tenantId: 'another-tenant' })).toBe(false);
    }
    const valid = ajv.compile(SimulationAvoidanceDemoPrepareSchema);
    expect(
      valid({
        ...simulationAvoidanceDemoPrepare,
        control: { ...simulationAvoidanceDemoPrepare.control, acceptance: null },
      }),
    ).toBe(false);
    expect(
      valid({
        ...simulationAvoidanceDemoPrepare,
        control: { ...simulationAvoidanceDemoPrepare.control, controlDigest: 'unknown' },
      }),
    ).toBe(false);
  });
  it('bounds coordinator reports and keeps human decisions outside progress', () => {
    const valid = ajv.compile(SimulationAvoidanceDemoProgressSchema);
    for (const value of [
      { ...simulationAvoidanceDemoProgress, phase: 'resolved' },
      { ...simulationAvoidanceDemoProgress, expectedRevision: 128 },
      { ...simulationAvoidanceDemoProgress, reason: 'x'.repeat(501) },
      { ...simulationAvoidanceDemoProgress, references: { riskAccepted: true } },
      { ...simulationAvoidanceDemoProgress, references: { mission: { eventId: 'mission' } } },
    ])
      expect(valid(value)).toBe(false);
    const preparation = ajv.compile(SimulationAvoidanceDemoPreparationQuerySchema);
    const interval = { start: '2026-10-18T18:00:00.000Z', end: '2026-10-18T18:30:00.000Z' };
    expect(preparation({ operatingInterval: interval })).toBe(true);
    expect(preparation({ operatingInterval: interval, circles: [] })).toBe(false);
    expect(preparation({ operatingInterval: { ...interval, end: 'unknown' } })).toBe(false);
  });
});
