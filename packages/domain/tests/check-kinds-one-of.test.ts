import { describe, expect, it } from 'vitest';
import { declaredRecordDefinition, type DeclaredRecordType } from '../../contracts/src/index.js';
import { checkParameterProblem, registeredCheckKindDigest, type CheckObservation } from '../src/check-kinds.js';
import '../src/check-kind-library.js';
import { valueOneOfV1, valueOneOfV2, type ValueOneOfV2Params } from '../src/check-kind-library-records.js';
import { registerObservationRecordTypes } from '../src/observation-registry.js';

// value.one-of version 2: one rule over many fields of one record. An invented checklist a pack might declare.

const TYPE = 'one-of-test.checklist';
const answers = [
  { value: 'done', label: 'Done' },
  { value: 'not-applicable', label: 'Not applicable' },
  { value: 'defect-found', label: 'Defect found' },
  { value: 'not-checked', label: 'Not checked yet' },
];
const item = (name: string, label: string) => ({
  name,
  label,
  kind: 'select' as const,
  required: true,
  options: answers,
});
const declared: DeclaredRecordType = {
  id: TYPE,
  version: 1,
  title: 'Preflight checklist',
  description: 'An invented checklist completed for a flight.',
  subjectKinds: ['flight'],
  time: { meaning: 'event', atField: 'completedAt' },
  fields: [
    { name: 'completedAt', label: 'Completed at', kind: 'date_time', required: true },
    item('propellers', 'Propellers undamaged and tight'),
    item('batteries', 'Flight batteries charged and latched'),
    item('launchArea', 'Launch area clear of people'),
    item('weather', 'Weather within limits'),
  ],
};
registerObservationRecordTypes(declaredRecordDefinition('one-of-test', { ...declared, digest: '0'.repeat(64) }));

const clock = { mode: 'wall' as const, evaluatedAt: '2026-11-20T00:00:00.000Z' };
let sequence = 0;
function checklist(body: Record<string, unknown>, completedAt = '2026-11-10T14:00:00.000Z'): CheckObservation {
  return {
    id: `checklist-${++sequence}`,
    type: 'operator.record',
    version: 1,
    occurredAt: completedAt,
    observation: {
      type: 'operator.record',
      version: 1,
      occurredAt: completedAt,
      subject: { kind: 'flight', id: 'RIDGE-F-1', scope: 'source' },
      values: { recordType: TYPE, recordVersion: 1, record: { completedAt, ...body } },
    },
  };
}
const done = { propellers: 'done', batteries: 'done', launchArea: 'done', weather: 'done' };
const params: ValueOneOfV2Params = {
  fields: ['values.record.propellers', 'values.record.batteries', 'values.record.launchArea', 'values.record.weather'],
  fieldsDescribe: 'items',
  expected: ['done', 'not-applicable'],
};
const run = (records: CheckObservation[], overrides: Partial<ValueOneOfV2Params> = {}) =>
  valueOneOfV2.evaluate({ ...params, ...overrides }, { subject: records }, clock);

describe('value.one-of version 2', () => {
  it('is a new version beside version 1, which keeps its definition', () => {
    expect(registeredCheckKindDigest('value.one-of', 1)).toBe(
      'cabc03bd68f9cfea4c63827586dd87f1a7b4fe5a8abad2694ff2a1b6fbc9e61f',
    );
    expect(registeredCheckKindDigest('value.one-of', 2)).not.toBe(registeredCheckKindDigest('value.one-of', 1));
  });

  it('takes one field or a list of them, never both and never neither', () => {
    expect(checkParameterProblem('value.one-of', 2, params)).toBeUndefined();
    expect(checkParameterProblem('value.one-of', 2, { field: 'values.record.weather', expected: ['done'] })).toBe(
      undefined,
    );
    expect(checkParameterProblem('value.one-of', 2, { expected: ['done'] })).toBeDefined();
    expect(checkParameterProblem('value.one-of', 2, { ...params, field: 'values.record.weather' })).toBeDefined();
    expect(
      checkParameterProblem('value.one-of', 2, {
        field: 'values.record.weather',
        fieldsDescribe: 'items',
        expected: [1],
      }),
    ).toBeDefined();
  });

  it('passes when every field holds an expected value, and counts each: not applicable is an answer', () => {
    const result = run([checklist({ ...done, batteries: 'not-applicable', weather: 'not-applicable' })]);
    expect(result).toMatchObject({ evidenceState: 'supported', outcome: 'pass', reasonCode: 'value_expected' });
    expect(result.summary).toBe(
      'All 4 items read in the latest preflight checklist hold Done or Not applicable: 2 Done, 2 Not applicable.',
    );
    expect(result.details).toEqual({
      fieldsRead: 4,
      unexpected: null,
      unanswered: null,
      counts: 'done=2; not-applicable=2',
    });
  });

  it('names every field that holds another value, by its label and the answer’s, in its sentence and details', () => {
    const record = checklist({
      ...done,
      propellers: 'defect-found',
      launchArea: 'defect-found',
      weather: 'not-applicable',
    });
    const result = run([record]);
    expect(result).toMatchObject({ evidenceState: 'supported', outcome: 'attention', reasonCode: 'value_unexpected' });
    expect(result.summary).toBe(
      '2 of the 4 items read in the latest preflight checklist hold a value other than Done or Not applicable: Propellers undamaged and tight: Defect found; Launch area clear of people: Defect found. The others that hold a value: 1 Done, 1 Not applicable.',
    );
    expect(result.details).toMatchObject({
      unexpected: 'propellers=defect-found; launchArea=defect-found',
      counts: 'done=1; not-applicable=1; defect-found=2',
    });
    expect(result.evidence).toEqual([record.id]);
    const one = run([checklist({ ...done, weather: 'defect-found' })], { fieldsDescribe: undefined });
    expect(one.summary).toBe(
      '1 of the 4 fields read in the latest preflight checklist holds a value other than Done or Not applicable: Weather within limits: Defect found. The others that hold a value: 3 Done.',
    );
  });

  it('waits, naming them, when fields have no value and none holds an unexpected one', () => {
    const result = run([checklist({ propellers: 'done', batteries: '', weather: 'not-applicable' })]);
    expect(result).toMatchObject({ evidenceState: 'insufficient', outcome: 'pending', reasonCode: 'value_missing' });
    expect(result.summary).toBe(
      'No value is recorded for 2 of the 4 items read in the latest preflight checklist: Flight batteries charged and latched, Launch area clear of people. The others that hold a value: 1 Done, 1 Not applicable.',
    );
    expect(result.details).toMatchObject({ unanswered: 'batteries; launchArea', unexpected: null });
    // An unexpected value is reported first; what is unanswered is still named.
    const both = run([checklist({ propellers: 'defect-found', batteries: 'done', weather: 'done' })]);
    expect(both).toMatchObject({ outcome: 'attention', reasonCode: 'value_unexpected' });
    expect(both.summary).toMatch(/ No value is recorded for: Launch area clear of people\.$/);
    expect(run([])).toMatchObject({
      evidenceState: 'insufficient',
      outcome: 'pending',
      summary: 'No value is recorded for 4 of the 4 items read: Propellers, Batteries, Launch area, Weather.',
    });
  });

  it('is insufficient for a value the rule lists as undetermined, and conflicts when records made together differ', () => {
    const waiting = run([checklist({ ...done, weather: 'not-checked' })], { undetermined: ['not-checked'] });
    expect(waiting).toMatchObject({
      evidenceState: 'insufficient',
      outcome: 'attention',
      reasonCode: 'value_undetermined',
    });
    expect(waiting.summary).toBe(
      '1 of the 4 items read in the latest preflight checklist holds a value that settles nothing either way: Weather within limits: Not checked yet. The others that hold a value: 3 Done.',
    );
    const conflict = run([checklist(done), checklist({ ...done, weather: 'defect-found' })]);
    expect(conflict).toMatchObject({ evidenceState: 'conflicting', reasonCode: 'values_disagree' });
    expect(conflict.summary).toBe('Observations at the same time report different values for: Weather within limits.');
  });

  it('reads only the latest record', () => {
    const earlier = checklist({ ...done, weather: 'defect-found' }, '2026-11-10T13:00:00.000Z');
    const later = checklist(done, '2026-11-10T14:30:00.000Z');
    expect(run([later, earlier])).toMatchObject({ outcome: 'pass', evidence: [later.id] });
  });

  it('with one field, reads and words its result as version 1 does', () => {
    const single = { field: 'values.record.weather', expected: ['done'] };
    for (const body of [done, { ...done, weather: 'defect-found' }, { propellers: 'done' }]) {
      const records = [checklist(body)];
      const first = valueOneOfV1.evaluate(single, { subject: records }, clock);
      const second = valueOneOfV2.evaluate(single, { subject: records }, clock);
      expect({ ...second, details: undefined }).toEqual({ ...first, details: undefined });
      expect(second.details).toMatchObject({ fieldsRead: 1 });
    }
  });

  it('names at most twenty fields in a sentence and says how many more', () => {
    const fields = Array.from({ length: 30 }, (_unused, index) => `values.check${index}`);
    const values = Object.fromEntries(fields.map((_field, index) => [`check${index}`, 'bad']));
    const observed: CheckObservation = {
      id: 'plain-1',
      type: 'example.answers',
      version: 1,
      occurredAt: '2026-11-10T14:00:00.000Z',
      observation: { type: 'example.answers', version: 1, occurredAt: '2026-11-10T14:00:00.000Z', values },
    };
    const result = run([observed], { fields, expected: ['good'] });
    expect(result.summary).toContain('30 of the 30 items read');
    expect(result.summary).toContain('Check19: bad; and 10 more.');
    expect(result.summary.length).toBeLessThan(2000);
  });
});
