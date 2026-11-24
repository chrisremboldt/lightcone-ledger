import {
  FidelitySchema,
  ObservationIntervalSchema,
  ObservationSubjectSchema,
  type ObservationTypeDefinition,
} from '../../packages/contracts/src/index.js';

// A made-up observation type that exists only in tests. Its schema is plain JSON Schema built from the public
// envelope parts, so nothing in core code knows it.
export function rotorIcingType(type = 'rotor.icing'): ObservationTypeDefinition {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['type', 'version', 'subject', 'occurredAt', 'fidelity', 'limitations', 'originalArtifactId', 'values'],
    properties: {
      type: { const: type },
      version: { const: 1 },
      subject: ObservationSubjectSchema,
      secondarySubject: ObservationSubjectSchema,
      occurredAt: { type: 'string', format: 'date-time' },
      interval: ObservationIntervalSchema,
      sourceEventId: { type: 'string', minLength: 1, maxLength: 200 },
      sourceSessionId: { type: 'string', minLength: 1, maxLength: 200 },
      fidelity: FidelitySchema,
      limitations: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 1000 } },
      originalArtifactId: { type: 'string', minLength: 1, maxLength: 200 },
      values: {
        type: 'object',
        additionalProperties: false,
        required: ['severity'],
        properties: {
          severity: { enum: ['trace', 'light', 'moderate', 'severe'] },
          outsideAirTemperatureCelsius: { type: 'number', minimum: -90, maximum: 60 },
        },
      },
    },
  };
  return {
    type,
    version: 1,
    timing: 'interval',
    intervalRequired: false,
    subjectKinds: ['flight', 'aircraft'],
    secondarySubjectKinds: ['flight', 'aircraft'],
    description: 'Made-up test type: icing reported on the rotors over an interval.',
    mayInfer: ['The source reported icing of this severity.'],
    mayNotInfer: ['Absence of a report is not absence of icing.'],
    schema: schema as unknown as ObservationTypeDefinition['schema'],
  };
}

export function rotorIcingObservation(
  overrides: Record<string, unknown> = {},
  type = 'rotor.icing',
): Record<string, unknown> {
  return {
    type,
    version: 1,
    subject: { kind: 'flight', id: 'flight-under-test', scope: 'ledger' },
    occurredAt: '2026-11-02T10:15:00.000Z',
    interval: { start: '2026-11-02T10:00:00.000Z', end: '2026-11-02T10:10:00.000Z' },
    fidelity: 'synthetic_contract',
    limitations: ['Synthetic test data.'],
    originalArtifactId: 'artifact-under-test',
    values: { severity: 'light', outsideAirTemperatureCelsius: -4 },
    ...overrides,
  };
}
