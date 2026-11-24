import { describe, expect, it } from 'vitest';
import {
  checkKindDigest,
  findCheckKind,
  registerCheckKind,
  type CheckKind,
  type CheckObservation,
} from '../src/check-kinds.js';
import {
  dateWithinMonthsV1,
  intervalCoversWindowV1,
  recordCompleteV1,
  valueWithinLimitV1,
} from '../src/check-kind-library.js';

const clock = (evaluatedAt: string) => ({ mode: 'wall' as const, evaluatedAt });

function observation(
  id: string,
  values: Record<string, unknown>,
  occurredAt = '2026-11-02T10:00:00.000Z',
  interval?: { start: string; end?: string },
): CheckObservation {
  return {
    id,
    type: 'made-up.reading',
    version: 1,
    occurredAt,
    ...(interval ? { interval } : {}),
    observation: { type: 'made-up.reading', version: 1, occurredAt, ...(interval ? { interval } : {}), values },
  };
}

describe('check kind registry', () => {
  it('identifies a kind by id, version and a digest of its declared definition', () => {
    const digest = checkKindDigest(valueWithinLimitV1);
    // Built and source copies of the library share one registry; the first registration is kept.
    expect(checkKindDigest(findCheckKind('value.within-limit', 1)!)).toBe(digest);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    // The function body is not part of the identity; the declared definition is.
    expect(checkKindDigest({ ...valueWithinLimitV1, evaluate: () => valueWithinLimitV1.evaluate as never })).toBe(
      digest,
    );
    expect(checkKindDigest({ ...valueWithinLimitV1, description: 'Changed.' })).not.toBe(digest);
  });

  it('refuses a second definition under a published id and version, and malformed ids', () => {
    expect(() => registerCheckKind(valueWithinLimitV1)).not.toThrow();
    expect(() => registerCheckKind({ ...valueWithinLimitV1, title: 'Another' })).toThrow(/another definition/);
    const bad: CheckKind = { ...valueWithinLimitV1, id: 'NotAnId' };
    expect(() => registerCheckKind(bad)).toThrow(/domain.noun/);
  });
});

describe('record.complete', () => {
  const params = { recordType: 'person.standing', recordVersion: 1 };
  const carrier = (id: string, record: Record<string, unknown>, occurredAt?: string) =>
    observation(id, { recordType: 'person.standing', recordVersion: 1, record }, occurredAt);

  it('passes a complete latest record and names thin replay detail', () => {
    const result = recordCompleteV1.evaluate(
      params,
      { record: [carrier('a', { fullName: 'Avery Example', qualificationSummary: 'Remote pilot', duties: 'Flies' })] },
      clock('2026-11-03T00:00:00.000Z'),
    );
    expect(result).toMatchObject({ evidenceState: 'supported', outcome: 'pass', reasonCode: 'record_complete' });
    expect(result.evidence).toEqual(['a']);
    expect(result.summary).toMatch(/Source of the qualification/);
  });

  it('lists missing required fields of the latest record, or only the fields the rule reads', () => {
    const inputs = {
      record: [
        carrier('new', { fullName: 'Avery Example', duties: ' ' }, '2026-11-02T11:00:00.000Z'),
        carrier('old', { fullName: 'Avery Example', qualificationSummary: 'Remote pilot', duties: 'Flies' }),
      ],
    };
    const result = recordCompleteV1.evaluate(params, inputs, clock('2026-11-03T00:00:00.000Z'));
    expect(result).toMatchObject({
      evidenceState: 'insufficient',
      outcome: 'attention',
      reasonCode: 'record_incomplete',
    });
    expect(result.summary).toContain('Qualification, Duties');
    expect(result.evidence).toEqual(['new']);
    const narrow = recordCompleteV1.evaluate(
      { ...params, fields: ['fullName'] },
      inputs,
      clock('2026-11-03T00:00:00.000Z'),
    );
    expect(narrow.outcome).toBe('pass');
  });

  it('reports a missing record of the type, ignoring records of other types', () => {
    const other = observation('x', { recordType: 'person.employment', recordVersion: 1, record: {} });
    expect(recordCompleteV1.evaluate(params, { record: [other] }, clock('2026-11-03T00:00:00.000Z'))).toMatchObject({
      evidenceState: 'insufficient',
      outcome: 'attention',
      reasonCode: 'record_missing',
      evidence: [],
    });
  });
});

describe('value.within-limit', () => {
  const params = { field: 'values.remainingPercent', comparison: 'at_least' as const, limit: 20 };
  const at = clock('2026-11-03T00:00:00.000Z');

  it('compares the latest value with the limit', () => {
    const inputs = (value: number) => ({
      subject: [
        observation('new', { remainingPercent: value }, '2026-11-02T11:00:00.000Z'),
        observation('old', { remainingPercent: 90 }),
      ],
    });
    expect(valueWithinLimitV1.evaluate(params, inputs(25), at)).toMatchObject({
      evidenceState: 'supported',
      outcome: 'pass',
      reasonCode: 'value_within_limit',
      evidence: ['new'],
    });
    expect(valueWithinLimitV1.evaluate(params, inputs(12), at)).toMatchObject({
      evidenceState: 'supported',
      outcome: 'attention',
      reasonCode: 'value_outside_limit',
    });
    expect(valueWithinLimitV1.evaluate({ ...params, comparison: 'above' }, inputs(20), at).outcome).toBe('attention');
    expect(valueWithinLimitV1.evaluate({ ...params, comparison: 'at_most' }, inputs(20), at).outcome).toBe('pass');
  });

  it('is insufficient without a numeric value and conflicting when simultaneous reports disagree', () => {
    expect(valueWithinLimitV1.evaluate(params, { subject: [observation('a', { other: 1 })] }, at)).toMatchObject({
      evidenceState: 'insufficient',
      outcome: 'pending',
      reasonCode: 'value_missing',
    });
    expect(valueWithinLimitV1.evaluate(params, { subject: [] }, at).evidenceState).toBe('insufficient');
    const disagreeing = {
      subject: [observation('a', { remainingPercent: 30 }), observation('b', { remainingPercent: 10 })],
    };
    expect(valueWithinLimitV1.evaluate(params, disagreeing, at)).toMatchObject({
      evidenceState: 'conflicting',
      outcome: 'attention',
      reasonCode: 'values_disagree',
      evidence: ['a', 'b'],
    });
  });
});

describe('date.within-months', () => {
  const params = { field: 'values.completedOn', months: 24 };
  const inputs = (completedOn: unknown) => ({ subject: [observation('a', { completedOn })] });

  it('holds through the last day of month M+N and names the boundary', () => {
    const result = dateWithinMonthsV1.evaluate(params, inputs('2025-03-10'), clock('2027-03-31T23:59:59.000Z'));
    expect(result).toMatchObject({
      evidenceState: 'supported',
      outcome: 'pass',
      reasonCode: 'date_within_months',
      nextBoundary: '2027-04-01T00:00:00.000Z',
    });
    expect(dateWithinMonthsV1.evaluate(params, inputs('2025-03-10'), clock('2027-04-01T00:00:00.000Z'))).toMatchObject({
      evidenceState: 'supported',
      outcome: 'attention',
      reasonCode: 'date_outside_months',
    });
    expect(
      dateWithinMonthsV1.evaluate(params, inputs('2025-03-10T08:00:00Z'), clock('2026-01-01T00:00:00.000Z')).outcome,
    ).toBe('pass');
  });

  it('is insufficient without a valid date, and conflicting for a date after the clock', () => {
    const at = clock('2026-11-03T00:00:00.000Z');
    expect(dateWithinMonthsV1.evaluate(params, inputs('2025-02-30'), at).reasonCode).toBe('date_missing');
    expect(dateWithinMonthsV1.evaluate(params, inputs(undefined), at).evidenceState).toBe('insufficient');
    expect(dateWithinMonthsV1.evaluate(params, inputs('2026-12-01'), at)).toMatchObject({
      evidenceState: 'conflicting',
      outcome: 'attention',
      reasonCode: 'date_after_clock',
    });
  });
});

describe('interval.covers-window', () => {
  const recorded = (id: string, start: string, end?: string, occurredAt = start) =>
    observation(id, {}, occurredAt, end ? { start, end } : { start });

  it('covers the evaluation instant until the joined intervals end', () => {
    const result = intervalCoversWindowV1.evaluate(
      {},
      {
        interval: [
          recorded('b', '2026-11-02T12:00:00.000Z', '2026-11-02T14:00:00.000Z'),
          recorded('a', '2026-11-02T10:00:00.000Z', '2026-11-02T12:00:00.000Z'),
        ],
      },
      clock('2026-11-02T11:00:00.000Z'),
    );
    expect(result).toMatchObject({
      evidenceState: 'supported',
      outcome: 'pass',
      reasonCode: 'window_covered',
      nextBoundary: '2026-11-02T14:00:00.000Z',
      evidence: ['a'],
    });
  });

  it('needs attention at an uncovered instant and names when a later interval begins', () => {
    const result = intervalCoversWindowV1.evaluate(
      {},
      { interval: [recorded('later', '2026-11-02T15:00:00.000Z', '2026-11-02T16:00:00.000Z')] },
      clock('2026-11-02T11:00:00.000Z'),
    );
    expect(result).toMatchObject({
      evidenceState: 'insufficient',
      outcome: 'attention',
      reasonCode: 'window_not_covered',
      nextBoundary: '2026-11-02T15:00:00.000Z',
    });
  });

  it('treats an interval without an end as in effect only up to when it was stated', () => {
    const open = recorded('open', '2026-11-02T10:00:00.000Z', undefined, '2026-11-02T10:30:00.000Z');
    expect(intervalCoversWindowV1.evaluate({}, { interval: [open] }, clock('2026-11-02T10:15:00.000Z')).outcome).toBe(
      'pass',
    );
    expect(intervalCoversWindowV1.evaluate({}, { interval: [open] }, clock('2026-11-02T11:00:00.000Z')).outcome).toBe(
      'attention',
    );
  });

  it('checks a stated window, with no clock boundary', () => {
    const window = recorded('w', '2026-11-02T10:00:00.000Z', '2026-11-02T11:00:00.000Z');
    const covering = recorded('c', '2026-11-02T09:00:00.000Z', '2026-11-02T11:00:00.000Z');
    const short = recorded('s', '2026-11-02T09:00:00.000Z', '2026-11-02T10:30:00.000Z');
    const at = clock('2026-11-01T00:00:00.000Z');
    const pass = intervalCoversWindowV1.evaluate({}, { interval: [covering], window: [window] }, at);
    expect(pass).toMatchObject({ outcome: 'pass', evidence: ['w', 'c'] });
    expect(pass).not.toHaveProperty('nextBoundary');
    expect(intervalCoversWindowV1.evaluate({}, { interval: [short], window: [window] }, at).outcome).toBe('attention');
  });
});
