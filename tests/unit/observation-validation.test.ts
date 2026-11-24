import { describe, expect, it } from 'vitest';
import {
  observationRegistryV1,
  registerObservationType,
  registerOperatorRecordType,
  type OperatorRecordTypeDefinition,
} from '../../packages/contracts/src/index.js';
import { validateObservation } from '../../packages/domain/src/observation-registry.js';
import { rotorIcingObservation, rotorIcingType } from './rotor-icing-observation.js';

const registry = registerObservationType(observationRegistryV1, rotorIcingType());
const code = (run: () => unknown): string | undefined => {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

describe('observation validation at intake', () => {
  it('accepts a valid observation of a registered type', () => {
    expect(validateObservation(registry, rotorIcingObservation()).definition.version).toBe(1);
  });

  it('refuses a missing header, an unregistered type and an unregistered version', () => {
    expect(code(() => validateObservation(registry, { values: {} }))).toBe('invalid_observation');
    expect(code(() => validateObservation(registry, rotorIcingObservation({}, 'rotor.unknown')))).toBe(
      'unregistered_observation_type',
    );
    expect(code(() => validateObservation(registry, rotorIcingObservation({ version: 2 })))).toBe(
      'unregistered_observation_type',
    );
  });

  it('refuses additional properties and values outside the schema', () => {
    expect(code(() => validateObservation(registry, rotorIcingObservation({ note: 'extra' })))).toBe(
      'invalid_observation',
    );
    expect(
      code(() => validateObservation(registry, rotorIcingObservation({ values: { severity: 'light', extra: 1 } }))),
    ).toBe('invalid_observation');
  });

  it('refuses an interval that does not start before it ends, and keeps an open interval', () => {
    for (const interval of [
      { start: '2026-11-02T10:10:00.000Z', end: '2026-11-02T10:10:00.000Z' },
      { start: '2026-11-02T10:10:00.000Z', end: '2026-11-02T10:00:00.000Z' },
    ])
      expect(code(() => validateObservation(registry, rotorIcingObservation({ interval })))).toBe(
        'invalid_observation',
      );
    expect(
      validateObservation(registry, rotorIcingObservation({ interval: { start: '2026-11-02T10:00:00.000Z' } }))
        .observation.interval,
    ).toEqual({ start: '2026-11-02T10:00:00.000Z' });
  });

  it('refuses an interval on a type that does not take one, and requires one where the type does', () => {
    const instant = registerObservationType(registry, { ...rotorIcingType('rotor.sample'), timing: 'instant' });
    expect(code(() => validateObservation(instant, rotorIcingObservation({}, 'rotor.sample')))).toBe(
      'invalid_observation',
    );
    const required = registerObservationType(registry, { ...rotorIcingType('rotor.period'), intervalRequired: true });
    expect(
      code(() => validateObservation(required, rotorIcingObservation({ interval: undefined }, 'rotor.period'))),
    ).toBe('invalid_observation');
  });

  it('validates a carried record against its registered record type', () => {
    const carried = {
      type: 'operator.record',
      version: 1,
      subject: { kind: 'aircraft', id: 'tail-7', scope: 'source' },
      occurredAt: '2026-11-02T10:15:00.000Z',
      fidelity: 'synthetic_contract',
      limitations: [],
      originalArtifactId: 'artifact-under-test',
      values: { recordType: 'maintenance.entry', recordVersion: 1, record: { hours: 12 } },
    };
    expect(code(() => validateObservation(observationRegistryV1, carried))).toBe('unregistered_record_type');
    const recordType: OperatorRecordTypeDefinition = {
      recordType: 'maintenance.entry',
      recordVersion: 1,
      subjectKinds: ['aircraft'],
      description: 'Made-up test record.',
      mayInfer: [],
      mayNotInfer: [],
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['hours'],
        properties: { hours: { type: 'number', minimum: 0 } },
      } as unknown as OperatorRecordTypeDefinition['schema'],
    };
    const withRecord = registerOperatorRecordType(observationRegistryV1, recordType);
    expect(validateObservation(withRecord, carried).definition.type).toBe('operator.record');
    expect(
      code(() => validateObservation(withRecord, { ...carried, values: { ...carried.values, record: { hours: -1 } } })),
    ).toBe('invalid_observation');
  });
});
