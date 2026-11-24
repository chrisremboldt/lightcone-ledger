import { describe, expect, it } from 'vitest';
import {
  findObservationType,
  findOperatorRecordDefinition,
  interpretRecordRow,
  observedRecordBody,
  observedRecordValues,
  operatorRecordTypesV1,
  recordCsvTemplate,
  standardObservationRegistry,
} from '../../packages/contracts/src/index.js';
import { validateObservation } from '../../packages/domain/src/observation-registry.js';

const periods = findOperatorRecordDefinition(standardObservationRegistry, 'crew.duty-period', 1)!;

/** The observation import builds for an observed record, as operator-record-import.ts does. */
function observationOf(record: Record<string, unknown>, subjectId: string) {
  return {
    type: 'crew.duty-period',
    version: 1,
    subject: { kind: 'person', id: subjectId, scope: 'source' },
    occurredAt: record.startsAt,
    interval: { start: record.startsAt, ...(record.endsAt ? { end: record.endsAt } : {}) },
    sourceSessionId: 'artifact-1',
    sourceEventId: record.periodId,
    fidelity: 'documented_schema_conformant',
    limitations: [],
    originalArtifactId: 'artifact-1',
    originalLocator: { kind: 'byte_range', value: { offsetBytes: 10, lengthBytes: 40 } },
    values: observedRecordValues(periods, record),
  };
}

describe('duty and rest periods as records', () => {
  it('is a record type recorded as the crew.duty-period observation the duty rules read', () => {
    expect(periods.observed).toEqual({ idField: 'periodId' });
    expect(recordCsvTemplate(periods)).toBe(
      'subjectId,secondarySubjectId,secondarySubjectKind,periodId,period,startsAt,endsAt,role,replaces\r\n',
    );
    // Every observed record type names a registered observation type of the same name and version.
    for (const definition of operatorRecordTypesV1.filter((candidate) => candidate.observed))
      expect(
        findObservationType(standardObservationRegistry, definition.recordType, definition.recordVersion),
      ).toBeDefined();
  });

  it('reads a spreadsheet row in local time into the observation, and back into the record', () => {
    const reading = interpretRecordRow(
      periods,
      {
        subjectId: 'RIDGE-P-01',
        periodId: 'RIDGE-DUTY-0412',
        period: 'Flight duty',
        'startsAt [local]': '2026-11-10 06:00',
        'endsAt [local]': '2026-11-10 16:30',
        role: 'remote_pilot',
      },
      { timeZone: 'America/Denver' },
    );
    expect(reading.problems).toEqual([]);
    expect(reading.record).toEqual({
      periodId: 'RIDGE-DUTY-0412',
      period: 'flight_duty',
      startsAt: '2026-11-10T13:00:00Z',
      endsAt: '2026-11-10T23:30:00Z',
      role: 'remote_pilot',
    });
    const observation = observationOf(reading.record, 'RIDGE-P-01');
    expect(observation.values).toEqual({ period: 'flight_duty', role: 'remote_pilot' });
    expect(() => validateObservation(standardObservationRegistry, observation)).not.toThrow();
    expect(observedRecordBody(periods, observation)).toEqual(reading.record);
  });

  it('is never carried inside operator.record', () => {
    expect(() =>
      validateObservation(standardObservationRegistry, {
        type: 'operator.record',
        version: 1,
        subject: { kind: 'person', id: 'RIDGE-P-01', scope: 'source' },
        occurredAt: '2026-11-10T13:00:00Z',
        interval: { start: '2026-11-10T13:00:00Z', end: '2026-11-10T23:30:00Z' },
        fidelity: 'documented_schema_conformant',
        limitations: [],
        originalArtifactId: 'artifact-1',
        values: {
          recordType: 'crew.duty-period',
          recordVersion: 1,
          record: { periodId: 'X', period: 'duty', startsAt: '2026-11-10T13:00:00Z', endsAt: '2026-11-10T23:30:00Z' },
        },
      }),
    ).toThrow(/recorded as a crew.duty-period observation/);
  });

  it('lets a duty and rest assessment name periods by the operator’s own period ids', () => {
    const assessment = findOperatorRecordDefinition(standardObservationRegistry, 'person.rest-assessment', 1)!;
    const reading = interpretRecordRow(
      assessment,
      {
        subjectId: 'RIDGE-P-01',
        'assessedAt [local]': '2026-11-10 05:45',
        dutyPeriodId: 'RIDGE-DUTY-0412',
        restPeriodId: 'RIDGE-REST-0411',
        weeklyRestPeriodId: 'RIDGE-REST-0405',
      },
      { timeZone: 'America/Denver' },
    );
    expect(reading.problems).toEqual([]);
    expect(reading.record).toMatchObject({
      dutyPeriodId: { id: 'RIDGE-DUTY-0412', scope: 'source' },
      restPeriodId: { id: 'RIDGE-REST-0411', scope: 'source' },
    });
  });
});
