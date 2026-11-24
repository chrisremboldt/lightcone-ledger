import { describe, expect, it } from 'vitest';
import { recordInForceV1, valuesOnFileV1, type ValuesOnFileParams } from '../src/check-kind-library-on-file.js';
import { checkParameterProblem, observationMatches, type CheckObservation } from '../src/check-kinds.js';
import '../src/check-kind-library.js';

const clock = { mode: 'wall' as const, evaluatedAt: '2026-10-20T12:00:00.000Z' };
let sequence = 0;

function inForce(values: Record<string, unknown>, interval: { start: string; end?: string }): CheckObservation {
  return {
    id: `record-${++sequence}`,
    type: 'organization.record-in-force',
    version: 1,
    occurredAt: interval.start,
    interval,
    observation: { occurredAt: interval.start, interval, values: { purposes: [], ...values } },
  };
}

function procedure(body: Record<string, unknown>): CheckObservation {
  return {
    id: `procedure-${++sequence}`,
    type: 'operator.record',
    version: 1,
    occurredAt: '2026-09-01T00:00:00.000Z',
    observation: {
      occurredAt: '2026-09-01T00:00:00.000Z',
      values: { recordType: 'organization.procedure', recordVersion: 1, record: body },
    },
  };
}

const complete = {
  procedureKind: 'emergency',
  title: 'Emergency procedure',
  documentReference: 'OPS-7',
  revision: 'C',
  effectiveAt: '2026-09-01T00:00:00Z',
};
const alternative = { recordType: 'organization.procedure', recordVersion: 1 };

describe('record.in-force@1', () => {
  it('names the records in effect, with the earliest end as the next boundary', () => {
    const records = [
      inForce(
        { title: 'Manual', revision: '2' },
        { start: '2026-01-01T00:00:00.000Z', end: '2026-12-01T00:00:00.000Z' },
      ),
      inForce({ title: 'Policy' }, { start: '2026-02-01T00:00:00.000Z' }),
    ];
    const result = recordInForceV1.evaluate({ recordLabel: 'document' }, { records }, clock);
    expect(result).toMatchObject({
      outcome: 'pass',
      summary: 'In force: “Manual”, revision 2, since 2026-01-01; “Policy”, since 2026-02-01.',
      nextBoundary: '2026-12-01T00:00:00.000Z',
      details: { recordsInForce: 2, title: 'Manual', revision: '2', inForceSince: '2026-01-01', basis: 'in_force' },
    });
  });

  it('lets a complete operator record stand when none is in effect, and needs attention for an incomplete one', () => {
    const read = recordInForceV1.evaluate(
      { recordLabel: 'emergency procedure', alternative },
      { records: [], record: [procedure(complete)] },
      clock,
    );
    expect(read).toMatchObject({
      outcome: 'pass',
      reasonCode: 'operator_record_on_file',
      details: { basis: 'operator_record' },
    });
    expect(read.summary).toBe(
      'No controlled document serving this is in force; read the operator record instead: “Emergency procedure”, revision C, in effect from 2026-09-01.',
    );
    const thin = recordInForceV1.evaluate(
      { recordLabel: 'emergency procedure', alternative },
      { records: [], record: [procedure({ ...complete, revision: '' })] },
      clock,
    );
    expect(thin).toMatchObject({ outcome: 'attention', reasonCode: 'record_incomplete' });
    expect(
      recordInForceV1.evaluate({ recordLabel: 'emergency procedure', alternative }, { records: [], record: [] }, clock),
    ).toMatchObject({
      outcome: 'pending',
      reasonCode: 'record_not_on_file',
      summary: 'No emergency procedure on file.',
    });
  });

  it('reads a condition on a list field as the list holding one of the values', () => {
    const record = inForce({ purposes: ['a.policy', 'a.manual'] }, { start: '2026-01-01T00:00:00.000Z' });
    expect(observationMatches(record, [{ field: 'values.purposes', oneOf: ['a.manual'] }])).toBe(true);
    expect(observationMatches(record, [{ field: 'values.purposes', oneOf: ['a.other'] }])).toBe(false);
  });
});

describe('values.on-file@1', () => {
  function report(values: Record<string, unknown>, at = '2026-10-15T15:00:00.000Z'): CheckObservation {
    return {
      id: `report-${++sequence}`,
      type: 'flight.report',
      version: 1,
      occurredAt: at,
      observation: { type: 'flight.report', version: 1, occurredAt: at, values },
    };
  }
  function record(recordType: string, body: Record<string, unknown>): CheckObservation {
    return {
      id: `${recordType}-${++sequence}`,
      type: 'operator.record',
      version: 1,
      occurredAt: '2026-10-16T09:00:00.000Z',
      observation: {
        type: 'operator.record',
        version: 1,
        occurredAt: '2026-10-16T09:00:00.000Z',
        values: { recordType, recordVersion: 1, record: body },
      },
    };
  }
  const times: ValuesOnFileParams = {
    describes: 'takeoff and landing times',
    subjectDescribes: 'flight',
    values: [
      { field: 'values.takeoffAt', fallbackField: 'values.record.takeoffAt', describes: 'takeoff' },
      { field: 'values.landingAt', fallbackField: 'values.record.landingAt', describes: 'landing' },
    ],
    primaryDescribes: 'the flight’s reports',
    fallbackDescribes: 'the operator’s flight record',
    interval: true,
  };
  const logged = (takeoffAt: string, landingAt: string) => record('flight.record', { takeoffAt, landingAt });
  const run = (params: ValuesOnFileParams, primary: CheckObservation[], fallback: CheckObservation[] = []) =>
    valuesOnFileV1.evaluate(params, { primary, fallback }, clock);

  it('accepts its parameters', () => {
    expect(checkParameterProblem('values.on-file', 1, times)).toBeUndefined();
    expect(checkParameterProblem('values.on-file', 1, { ...times, values: [] })).toBeDefined();
  });

  it('reads the operator’s record where no report states the times, and states the duration', () => {
    const result = run(times, [], [logged('2026-10-15T14:02:00Z', '2026-10-15T14:31:00Z')]);
    expect(result).toMatchObject({
      evidenceState: 'supported',
      outcome: 'pass',
      reasonCode: 'values_on_file',
      details: { basis: 'fallback', valuesOnFile: 2, differing: 0, durationMinutes: 29 },
    });
    expect(result.summary).toBe(
      'On file for this flight, from the operator’s flight record: takeoff 2026-10-15T14:02:00Z, landing 2026-10-15T14:31:00Z, a duration of 29 minutes.',
    );
  });

  it('reads the reported times first and names a record that differs, never mixing the two', () => {
    const reports = [
      report({ activity: 'active', takeoffAt: '2026-10-15T14:00:00.000Z' }),
      report({ activity: 'landed', takeoffAt: '2026-10-15T14:00:00.000Z', landingAt: '2026-10-15T14:31:00.000Z' }),
    ];
    const result = run(times, reports, [logged('2026-10-15T14:02:00Z', '2026-10-15T14:31:00Z')]);
    expect(result).toMatchObject({
      outcome: 'pass',
      details: { basis: 'primary', differing: 1, durationMinutes: 31 },
    });
    expect(result.summary).toBe(
      'On file for this flight, from the flight’s reports: takeoff 2026-10-15T14:00:00.000Z, landing 2026-10-15T14:31:00.000Z, a duration of 31 minutes. The takeoff in the operator’s flight record is 2026-10-15T14:02:00Z, which differs; the one in the flight’s reports is read.',
    );
    // A report with a takeoff only: the landing comes from the record, and the result says which came from where.
    const mixed = run(times, [reports[0]!], [logged('2026-10-15T14:00:00Z', '2026-10-15T14:30:00Z')]);
    expect(mixed.details).toMatchObject({ basis: 'both', differing: 0, durationMinutes: 30 });
    expect(mixed.summary).toMatch(
      /takeoff .* \(from the flight’s reports\), landing .* \(from the operator’s flight record\)/,
    );
  });

  it('says what is not on file, and where it was looked for', () => {
    const none = run(times, []);
    expect(none).toMatchObject({ evidenceState: 'insufficient', outcome: 'pending', reasonCode: 'record_not_on_file' });
    expect(none.summary).toBe(
      'No takeoff or landing on file for this flight in the flight’s reports or the operator’s flight record.',
    );
    const half = run(times, [report({ takeoffAt: '2026-10-15T14:00:00.000Z' })]);
    expect(half.summary).toBe(
      'No landing on file for this flight in the flight’s reports or the operator’s flight record. On file: takeoff 2026-10-15T14:00:00.000Z.',
    );
  });

  it('conflicts on a landing not after its takeoff, or on reports that disagree', () => {
    expect(run(times, [], [logged('2026-10-15T14:02:00Z', '2026-10-15T14:02:00Z')]).reasonCode).toBe(
      'end_not_after_start',
    );
    const disagreeing = run(times, [
      report({ takeoffAt: '2026-10-15T14:00:00.000Z' }),
      report({ takeoffAt: '2026-10-15T14:05:00.000Z' }),
    ]);
    expect(disagreeing).toMatchObject({ evidenceState: 'conflicting', reasonCode: 'values_disagree' });
    expect(disagreeing.summary).toMatch(/^The flight’s reports state different takeoff for this flight: /);
  });

  it('shows an option by its label and a reference by its id, and lists each record with scope each', () => {
    const kind = run(
      {
        describes: 'type of operation',
        subjectDescribes: 'flight',
        values: [{ field: 'values.record.operationKind', describes: 'type of operation' }],
        primaryDescribes: 'its flight plan',
      },
      [record('flight.plan', { operationKind: 'aerial_survey' })],
    );
    expect(kind.summary).toBe('On file for this flight, from its flight plan: type of operation Aerial survey.');
    const people: ValuesOnFileParams = {
      describes: 'designated operations personnel',
      subjectDescribes: 'flight',
      values: [
        { field: 'values.record.personId', describes: 'person' },
        { field: 'values.record.role', describes: 'role' },
      ],
      primaryDescribes: 'its role assignments',
      scope: 'each',
    };
    const assigned = run(people, [
      record('operation.role-assignment', { personId: { id: 'EX-P-1', scope: 'source' }, role: 'pilot_in_command' }),
      record('operation.role-assignment', { personId: { id: 'EX-P-2', scope: 'source' }, role: 'visual_observer' }),
      record('operation.role-assignment', { role: 'visual_observer' }),
    ]);
    expect(assigned).toMatchObject({ outcome: 'pass', details: { valuesOnFile: 2 } });
    expect(assigned.summary).toBe(
      'On file for this flight, from its role assignments: EX-P-1, Pilot in command; EX-P-2, Visual observer.',
    );
    expect(run(people, []).summary).toBe(
      'No designated operations personnel on file for this flight in its role assignments.',
    );
  });
});
