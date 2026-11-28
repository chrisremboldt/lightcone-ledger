import { describe, expect, it } from 'vitest';
import { checkParameterProblem, findCheckKind, type CheckObservation } from '../src/check-kinds.js';
import '../src/check-kind-library.js';
import {
  dateWithinMonthsV2,
  dutyWithinLimitsV1,
  intervalCoversWindowV2,
  occurrenceInWindowV1,
  recordCheckKinds,
  recordMadeBeforeV1,
  recordCompleteV2,
  valueOneOfV1,
  valueWithinLimitV2,
} from '../src/check-kind-library-records.js';

const clock = (evaluatedAt: string) => ({ mode: 'wall' as const, evaluatedAt });
const at = clock('2026-11-03T00:00:00.000Z');

interface Made {
  occurredAt?: string;
  interval?: { start: string; end?: string };
  sourceEventId?: string;
}

function observation(id: string, values: Record<string, unknown>, made: Made = {}): CheckObservation {
  const occurredAt = made.occurredAt ?? made.interval?.start ?? '2026-11-02T10:00:00.000Z';
  const time = { occurredAt, ...(made.interval ? { interval: made.interval } : {}) };
  return {
    id,
    type: 'made-up.reading',
    version: 1,
    ...time,
    observation: {
      type: 'made-up.reading',
      version: 1,
      ...time,
      ...(made.sourceEventId ? { sourceEventId: made.sourceEventId } : {}),
      values,
    },
  };
}

function record(id: string, recordType: string, body: Record<string, unknown>, made: Made = {}): CheckObservation {
  return observation(id, { recordType, recordVersion: 1, record: body }, made);
}

const select = (recordType: string, where?: unknown[]) => ({
  recordType,
  recordVersion: 1,
  ...(where ? { where } : {}),
});

describe('record check kinds', () => {
  it('are registered alongside the standard library under new ids or new versions', () => {
    for (const kind of recordCheckKinds) expect(findCheckKind(kind.id, kind.version)).toBeDefined();
    expect(findCheckKind('record.complete', 1)).toBeDefined();
    expect(recordCheckKinds.map((kind) => `${kind.id}@${kind.version}`)).toEqual([
      'record.complete@2',
      'date.within-months@2',
      'interval.covers-window@2',
      'duty.within-limits@1',
      'value.within-limit@2',
      'value.one-of@1',
      'value.one-of@2',
      'occurrence.in-window@1',
      'record.made-before@1',
    ]);
  });

  it('check their parameters against their schemas', () => {
    expect(checkParameterProblem('duty.within-limits', 1, { dutySelect: {}, restSelect: {} })).toBeDefined();
    expect(
      checkParameterProblem('duty.within-limits', 1, { dutySelect: {}, restSelect: {}, minRestHours: 10 }),
    ).toBeDefined();
    expect(
      checkParameterProblem('duty.within-limits', 1, {
        dutySelect: {},
        restSelect: {},
        minRestHours: 10,
        restWithinHours: 24,
      }),
    ).toBeUndefined();
    expect(checkParameterProblem('value.within-limit', 2, { field: 'values.a', comparison: 'at_most' })).toBeDefined();
    expect(
      checkParameterProblem('value.within-limit', 2, {
        field: 'values.a',
        comparison: 'at_most',
        limit: 1,
        limitField: 'values.b',
      }),
    ).toBeDefined();
    expect(
      checkParameterProblem('date.within-months', 2, { field: 'values.a', months: 2, select: { recordType: 'a.b' } }),
    ).toBeDefined();
    expect(
      checkParameterProblem('value.one-of', 1, {
        field: 'values.a',
        expected: [true],
        select: {
          where: [
            { field: 'values.kind', oneOf: ['x'] },
            { field: 'values.who', filled: true },
          ],
        },
      }),
    ).toBeUndefined();
  });
});

describe('record.complete version 2', () => {
  const params = { recordType: 'person.standing', recordVersion: 1 };
  const full = { fullName: 'Avery Example', qualificationSummary: 'Remote pilot', duties: 'Flies' };

  it("reads every record it is given: leaving out replaced records is the observation read's job", () => {
    const incomplete = record(
      'incomplete',
      'person.standing',
      { fullName: 'Avery Example' },
      { occurredAt: '2026-11-02T12:00:00.000Z' },
    );
    // The retired source event id convention no longer hides anything.
    const fixed = record('fixed', 'person.standing', full, { sourceEventId: 'replaces-incomplete' });
    expect(recordCompleteV2.evaluate(params, { record: [fixed] }, at)).toMatchObject({
      evidenceState: 'supported',
      outcome: 'pass',
      reasonCode: 'record_complete',
      evidence: ['fixed'],
    });
    expect(recordCompleteV2.evaluate(params, { record: [incomplete, fixed] }, at)).toMatchObject({
      evidenceState: 'insufficient',
      outcome: 'attention',
      reasonCode: 'record_incomplete',
      evidence: ['incomplete'],
    });
  });

  it('reads only matching records, and the fields the rule lists', () => {
    const training = (id: string, trainingKind: string, body: Record<string, unknown>, occurredAt: string) =>
      record(id, 'person.training', { trainingKind, ...body }, { occurredAt });
    const inputs = {
      record: [
        training('recurrent', 'recurrent', { courseTitle: 'Refresher' }, '2026-11-02T12:00:00.000Z'),
        training('test', 'knowledge_test', { completedOn: '2026-01-10' }, '2026-11-01T12:00:00.000Z'),
      ],
    };
    const params = {
      recordType: 'person.training',
      recordVersion: 1,
      where: [{ field: 'values.record.trainingKind', oneOf: ['knowledge_test'] }],
    };
    expect(recordCompleteV2.evaluate(params, inputs, at)).toMatchObject({
      reasonCode: 'record_incomplete',
      evidence: ['test'],
    });
    expect(recordCompleteV2.evaluate({ ...params, fields: ['completedOn'] }, inputs, at).outcome).toBe('pass');
    expect(recordCompleteV2.evaluate({ ...params, fields: ['instructorName'] }, inputs, at)).toMatchObject({
      evidenceState: 'insufficient',
      outcome: 'pending',
      reasonCode: 'record_type_unavailable',
    });
  });

  it('is insufficient without the record, or not applicable until one is recorded', () => {
    expect(recordCompleteV2.evaluate(params, { record: [] }, at)).toMatchObject({
      evidenceState: 'insufficient',
      outcome: 'attention',
      reasonCode: 'record_missing',
    });
    const ifPresent = { recordType: 'occurrence.security', recordVersion: 1, whenAbsent: 'not_applicable' as const };
    expect(recordCompleteV2.evaluate(ifPresent, { record: [] }, at)).toMatchObject({
      evidenceState: 'not_applicable',
      outcome: 'not_applicable',
      reasonCode: 'record_not_present',
    });
    const event = record('e', 'occurrence.security', { occurredAt: '2026-11-02T10:00:00Z' });
    expect(recordCompleteV2.evaluate(ifPresent, { record: [event] }, at)).toMatchObject({
      evidenceState: 'insufficient',
      reasonCode: 'record_incomplete',
    });
  });

  it('checks each record with scope each', () => {
    const complete = { occurredAt: '2026-11-02T10:00:00Z', summary: 'Gate left open', breachKind: 'physical_access' };
    const inputs = {
      record: [
        record('a', 'occurrence.security', complete, { occurredAt: '2026-11-02T11:00:00.000Z' }),
        record('b', 'occurrence.security', { occurredAt: '2026-11-02T09:00:00Z' }),
      ],
    };
    const params = { recordType: 'occurrence.security', recordVersion: 1, scope: 'each' as const };
    expect(recordCompleteV2.evaluate({ ...params, scope: 'latest' }, inputs, at).outcome).toBe('pass');
    const each = recordCompleteV2.evaluate(params, inputs, at);
    expect(each).toMatchObject({ reasonCode: 'record_incomplete', evidence: ['b'] });
    expect(each.summary).toContain('b (What happened, Kind of breach)');
  });
});

describe('date.within-months version 2', () => {
  const params = {
    select: select('person.training'),
    field: 'values.record.completedOn',
    months: 24,
  };
  const training = (id: string, completedOn: unknown, made: Made = {}) =>
    record(id, 'person.training', { completedOn }, made);

  it('lapses at the first instant of month M+N+1 and names that boundary', () => {
    const inputs = { subject: [training('t', '2025-03-10')] };
    expect(dateWithinMonthsV2.evaluate(params, inputs, clock('2027-03-31T23:59:59.999Z'))).toMatchObject({
      evidenceState: 'supported',
      outcome: 'pass',
      reasonCode: 'date_within_months',
      nextBoundary: '2027-04-01T00:00:00.000Z',
    });
    expect(dateWithinMonthsV2.evaluate(params, inputs, clock('2027-04-01T00:00:00.000Z'))).toMatchObject({
      evidenceState: 'supported',
      outcome: 'attention',
      reasonCode: 'date_outside_months',
    });
  });

  it('places a UTC instant by its UTC calendar date, with no time zone', () => {
    const late = { subject: [training('t', '2025-03-31T23:30:00Z')] };
    const early = { subject: [training('t', '2025-04-01T00:30:00Z')] };
    const oneMonth = { ...params, months: 1 };
    expect(dateWithinMonthsV2.evaluate(oneMonth, late, clock('2025-04-15T00:00:00.000Z')).nextBoundary).toBe(
      '2025-05-01T00:00:00.000Z',
    );
    expect(dateWithinMonthsV2.evaluate(oneMonth, early, clock('2025-04-15T00:00:00.000Z')).nextBoundary).toBe(
      '2025-06-01T00:00:00.000Z',
    );
    // A month-end date carries over a short month and a year end.
    expect(
      dateWithinMonthsV2.evaluate(
        oneMonth,
        { subject: [training('t', '2025-12-31')] },
        clock('2026-01-31T00:00:00.000Z'),
      ).nextBoundary,
    ).toBe('2026-02-01T00:00:00.000Z');
  });

  it('skips records of other types', () => {
    const inputs = {
      subject: [
        record('other', 'person.employment', { completedOn: '2026-10-01' }, { occurredAt: '2026-11-02T12:00:00.000Z' }),
        training('right', '2026-01-01'),
      ],
    };
    expect(dateWithinMonthsV2.evaluate(params, inputs, at)).toMatchObject({ outcome: 'pass', evidence: ['right'] });
  });

  it('is insufficient without a date and conflicting for a date after the clock', () => {
    expect(dateWithinMonthsV2.evaluate(params, { subject: [] }, at)).toMatchObject({
      evidenceState: 'insufficient',
      reasonCode: 'date_missing',
    });
    expect(dateWithinMonthsV2.evaluate(params, { subject: [training('t', '2025-02-30')] }, at).reasonCode).toBe(
      'date_missing',
    );
    expect(dateWithinMonthsV2.evaluate(params, { subject: [training('t', '2026-11-04')] }, at)).toMatchObject({
      evidenceState: 'conflicting',
      reasonCode: 'date_after_clock',
    });
  });
});

describe('interval.covers-window version 2', () => {
  const assignment = (id: string, role: string, interval: { start: string; end?: string }, made: Made = {}) =>
    record(id, 'operation.role-assignment', { personId: { id: 'p-1', scope: 'source' }, role }, { interval, ...made });
  const plan = record(
    'plan',
    'flight.plan',
    {},
    { interval: { start: '2026-11-02T10:00:00.000Z', end: '2026-11-02T11:00:00.000Z' } },
  );
  const roleParams = {
    select: select('operation.role-assignment', [
      { field: 'values.record.role', oneOf: ['pilot_in_command'] },
      { field: 'values.record.personId', filled: true },
    ]),
    openEnd: 'open' as const,
    windowSelect: select('flight.plan'),
  };

  it('answers whether a named role is assigned for the window, joining a handover', () => {
    const first = assignment('first', 'pilot_in_command', {
      start: '2026-11-02T09:00:00.000Z',
      end: '2026-11-02T10:30:00.000Z',
    });
    const second = assignment('second', 'pilot_in_command', { start: '2026-11-02T10:30:00.000Z' });
    const observer = assignment('observer', 'visual_observer', { start: '2026-11-02T09:00:00.000Z' });
    expect(
      intervalCoversWindowV2.evaluate(roleParams, { interval: [second, first, observer], window: [plan] }, at),
    ).toMatchObject({ evidenceState: 'supported', outcome: 'pass', evidence: ['plan', 'second', 'first'] });
    expect(
      intervalCoversWindowV2.evaluate(roleParams, { interval: [first, observer], window: [plan] }, at),
    ).toMatchObject({ evidenceState: 'insufficient', outcome: 'attention', reasonCode: 'window_not_covered' });
    expect(
      intervalCoversWindowV2.evaluate(
        { ...roleParams, openEnd: 'stated' },
        { interval: [second, first], window: [plan] },
        at,
      ).outcome,
    ).toBe('attention');
  });

  it('needs the assigned role and a person', () => {
    const other = assignment('other', 'visual_observer', { start: '2026-11-02T09:00:00.000Z' });
    expect(intervalCoversWindowV2.evaluate(roleParams, { interval: [other], window: [plan] }, at).outcome).toBe(
      'attention',
    );
    const nobody = record(
      'nobody',
      'operation.role-assignment',
      { personId: null, role: 'pilot_in_command' },
      { interval: { start: '2026-11-02T09:00:00.000Z' } },
    );
    expect(intervalCoversWindowV2.evaluate(roleParams, { interval: [nobody], window: [plan] }, at).outcome).toBe(
      'attention',
    );
  });

  it('is insufficient without a window when it reads one, and covers the evaluation instant otherwise', () => {
    expect(intervalCoversWindowV2.evaluate(roleParams, { interval: [], window: [] }, at)).toMatchObject({
      evidenceState: 'insufficient',
      outcome: 'pending',
      reasonCode: 'window_missing',
    });
    const inspection = record(
      'inspection',
      'aircraft.inspection',
      {},
      { interval: { start: '2026-10-01T00:00:00.000Z', end: '2026-11-15T00:00:00.000Z' } },
    );
    expect(
      intervalCoversWindowV2.evaluate(
        { select: select('aircraft.inspection'), openEnd: 'stated' },
        { interval: [inspection] },
        at,
      ),
    ).toMatchObject({ outcome: 'pass', nextBoundary: '2026-11-15T00:00:00.000Z' });
    const open = intervalCoversWindowV2.evaluate(
      roleParams,
      {
        interval: [assignment('open', 'pilot_in_command', { start: '2026-11-01T00:00:00.000Z' })],
      },
      at,
    );
    expect(open.outcome).toBe('pass');
    expect(open).not.toHaveProperty('nextBoundary');
  });
});

describe('duty.within-limits', () => {
  const period = (id: string, kind: string, start: string, end?: string, made: Made = {}) =>
    observation(id, { period: kind }, { interval: end ? { start, end } : { start }, ...made });
  const base = {
    dutySelect: { where: [{ field: 'values.period', oneOf: ['duty', 'flight_duty'] }] },
    restSelect: { where: [{ field: 'values.period', oneOf: ['rest'] }] },
  };
  const evening = clock('2026-11-02T23:00:00.000Z');

  it('checks the length of the assessed duty period', () => {
    const duty = period('d', 'duty', '2026-11-02T06:00:00.000Z', '2026-11-02T20:00:00.000Z');
    expect(dutyWithinLimitsV1.evaluate({ ...base, maxDutyHours: 14 }, { periods: [duty] }, evening)).toMatchObject({
      evidenceState: 'supported',
      outcome: 'pass',
      reasonCode: 'duty_within_limits',
    });
    const long = dutyWithinLimitsV1.evaluate({ ...base, maxDutyHours: 13.5 }, { periods: [duty] }, evening);
    expect(long).toMatchObject({ evidenceState: 'supported', outcome: 'attention', reasonCode: 'duty_limit_exceeded' });
    expect(long.summary).toContain('14 h against at most 13.5 h');
    const open = period('o', 'duty', '2026-11-02T06:00:00.000Z');
    expect(dutyWithinLimitsV1.evaluate({ ...base, maxDutyHours: 14 }, { periods: [open] }, evening)).toMatchObject({
      evidenceState: 'insufficient',
      reasonCode: 'duty_record_insufficient',
    });
  });

  it('needs one continuous recorded rest before the duty period; a gap is not rest unless the record is complete', () => {
    const params = { ...base, minRestHours: 10, restWithinHours: 24 };
    const duty = period('d', 'duty', '2026-11-02T08:00:00.000Z', '2026-11-02T16:00:00.000Z');
    const rest = (id: string, start: string, end: string) => period(id, 'rest', start, end);
    const tenHours = rest('r', '2026-11-01T22:00:00.000Z', '2026-11-02T08:00:00.000Z');
    expect(dutyWithinLimitsV1.evaluate(params, { periods: [duty, tenHours] }, evening)).toMatchObject({
      outcome: 'pass',
      evidence: ['d', 'r'],
    });
    // Two touching rests join; two separated by duty do not.
    const split = [
      rest('r1', '2026-11-01T20:00:00.000Z', '2026-11-02T02:00:00.000Z'),
      rest('r2', '2026-11-02T03:00:00.000Z', '2026-11-02T08:00:00.000Z'),
    ];
    expect(dutyWithinLimitsV1.evaluate(params, { periods: [duty, ...split] }, evening).reasonCode).toBe(
      'duty_limit_exceeded',
    );
    const touching = [
      rest('r1', '2026-11-01T20:00:00.000Z', '2026-11-02T02:00:00.000Z'),
      rest('r2', '2026-11-02T02:00:00.000Z', '2026-11-02T08:00:00.000Z'),
    ];
    expect(dutyWithinLimitsV1.evaluate(params, { periods: [duty, ...touching] }, evening).outcome).toBe('pass');
    // Rest older than the look-back counts only from its start.
    const old = rest('old', '2026-11-01T00:00:00.000Z', '2026-11-01T16:00:00.000Z');
    expect(dutyWithinLimitsV1.evaluate(params, { periods: [duty, old] }, evening).reasonCode).toBe(
      'duty_limit_exceeded',
    );
    const yesterday = period('y', 'duty', '2026-11-01T08:00:00.000Z', '2026-11-01T20:00:00.000Z');
    expect(dutyWithinLimitsV1.evaluate(params, { periods: [duty, yesterday] }, evening)).toMatchObject({
      evidenceState: 'insufficient',
      outcome: 'attention',
      reasonCode: 'duty_record_insufficient',
      summary: 'No rest is recorded in the 24 h before the duty period.',
    });
  });

  it('reads the time between two recorded duty periods as rest when the duty record is complete', () => {
    const params = { ...base, minRestHours: 10, restWithinHours: 24, dutyRecordComplete: true };
    const duty = period('d', 'duty', '2026-11-02T08:00:00.000Z', '2026-11-02T16:00:00.000Z');
    const yesterday = period('y', 'duty', '2026-11-01T08:00:00.000Z', '2026-11-02T00:30:00.000Z');
    expect(dutyWithinLimitsV1.evaluate(params, { periods: [duty, yesterday] }, evening)).toMatchObject({
      evidenceState: 'supported',
      outcome: 'attention',
      reasonCode: 'duty_limit_exceeded',
      evidence: ['d', 'y'],
      summary:
        'The longest continuous rest, taken from the time between recorded duty periods, in the 24 h before the duty period is 7.5 h against at least 10 h.',
    });
    const earlier = period('e', 'duty', '2026-11-01T08:00:00.000Z', '2026-11-01T20:00:00.000Z');
    expect(dutyWithinLimitsV1.evaluate(params, { periods: [duty, earlier] }, evening)).toMatchObject({
      outcome: 'pass',
      summary:
        'The longest continuous rest, taken from the time between recorded duty periods, in the 24 h before the duty period is 12 h against at least 10 h.',
    });
    // Without the statement, the same record has no rest on file.
    expect(
      dutyWithinLimitsV1.evaluate({ ...params, dutyRecordComplete: false }, { periods: [duty, earlier] }, evening),
    ).toMatchObject({ evidenceState: 'insufficient', reasonCode: 'duty_record_insufficient' });
  });

  it('says a person’s first duty period on record has no earlier period, without a finding', () => {
    const params = { ...base, minRestHours: 10, restWithinHours: 24 };
    const first = period('d', 'duty', '2026-11-02T08:00:00.000Z', '2026-11-02T16:00:00.000Z');
    for (const dutyRecordComplete of [true, false])
      expect(
        dutyWithinLimitsV1.evaluate({ ...params, dutyRecordComplete }, { periods: [first] }, evening),
      ).toMatchObject({
        evidenceState: 'supported',
        outcome: 'pass',
        summary: 'No earlier duty or rest period of this person is on record.',
      });
  });

  it('totals duty over a rolling period, joining overlaps', () => {
    const params = { ...base, maxRollingDutyHours: 20, rollingHours: 168 };
    const day = (id: string, date: string, hours: number) =>
      period(id, 'duty', `${date}T08:00:00.000Z`, `${date}T${String(8 + hours).padStart(2, '0')}:00:00.000Z`);
    const periods = [
      day('d3', '2026-11-02', 8),
      day('d2', '2026-10-30', 8),
      period('overlap', 'flight_duty', '2026-10-30T10:00:00.000Z', '2026-10-30T12:00:00.000Z'),
      day('d1', '2026-10-20', 8),
    ];
    const within = dutyWithinLimitsV1.evaluate(params, { periods }, evening);
    expect(within).toMatchObject({ outcome: 'pass', evidence: ['d3', 'd2', 'overlap'] });
    expect(within.summary).toContain('totals 16 h');
    expect(dutyWithinLimitsV1.evaluate({ ...params, maxRollingDutyHours: 15 }, { periods }, evening).reasonCode).toBe(
      'duty_limit_exceeded',
    );
  });

  it('assesses the duty period at the window', () => {
    const plan = observation(
      'w',
      {},
      { interval: { start: '2026-11-02T09:00:00.000Z', end: '2026-11-02T10:00:00.000Z' } },
    );
    const fixed = period('fixed', 'duty', '2026-11-02T08:00:00.000Z', '2026-11-02T16:00:00.000Z');
    const later = period('later', 'duty', '2026-11-03T08:00:00.000Z', '2026-11-03T23:00:00.000Z');
    expect(
      dutyWithinLimitsV1.evaluate({ ...base, maxDutyHours: 14 }, { periods: [later, fixed], window: [plan] }, evening),
    ).toMatchObject({ outcome: 'pass', evidence: ['w', 'fixed'] });
    expect(
      dutyWithinLimitsV1.evaluate({ ...base, maxDutyHours: 14 }, { periods: [later], window: [plan] }, evening),
    ).toMatchObject({ evidenceState: 'insufficient', reasonCode: 'duty_period_missing' });
  });
});

describe('value.within-limit version 2', () => {
  const life = (id: string, body: Record<string, unknown>, interval: { start: string; end?: string }) =>
    record(id, 'component.life-limit', body, { interval });
  const time = (id: string, totalTimeHours: number, occurredAt: string) =>
    record(id, 'aircraft.time-in-service', { totalTimeHours }, { occurredAt });
  const params = {
    select: select('aircraft.time-in-service'),
    field: 'values.record.totalTimeHours',
    comparison: 'at_most' as const,
    limitSelect: select('component.life-limit'),
    limitField: 'values.record.lifeLimitHours',
    offsetField: 'values.record.partTimeAtInstallHours',
    measureFrom: 'limit_start' as const,
  };
  const part = life('part', { lifeLimitHours: 100, partTimeAtInstallHours: 10 }, { start: '2026-06-01T00:00:00.000Z' });
  const quantity = [
    time('now', 150, '2026-11-01T00:00:00.000Z'),
    time('install', 80, '2026-05-30T00:00:00.000Z'),
    time('older', 20, '2026-01-01T00:00:00.000Z'),
  ];

  it('measures use since the limit began, plus the offset, and states the margin', () => {
    const within = valueWithinLimitV2.evaluate(params, { quantity, limit: [part] }, at);
    expect(within).toMatchObject({
      evidenceState: 'supported',
      outcome: 'pass',
      reasonCode: 'value_within_limit',
      evidence: ['part', 'now', 'install'],
    });
    expect(within.summary).toContain('is 80');
    expect(within.summary).toContain('the margin is 20');
    const worn = [time('later', 175, '2026-11-02T00:00:00.000Z'), ...quantity];
    const past = valueWithinLimitV2.evaluate(params, { quantity: worn, limit: [part] }, at);
    expect(past).toMatchObject({ outcome: 'attention', reasonCode: 'value_outside_limit' });
    expect(past.summary).toContain('the margin is -5');
  });

  it('states each quantity in the unit the rule’s text uses, with the stored value beside it', () => {
    const assessment = record('pre', 'flight.preflight-assessment', { visibilityMeters: 4023.36 }, {});
    const visibility = {
      field: 'values.record.visibilityMeters',
      comparison: 'at_least' as const,
      limit: 3 * 1609.344,
      unit: 'm',
      textUnit: 'mi' as const,
    };
    const short = valueWithinLimitV2.evaluate(visibility, { quantity: [assessment] }, at);
    expect(short.outcome).toBe('attention');
    expect(short.summary).toMatch(
      /is 2\.5 mi \(4023\.36 m\); the limit is at least 3 mi \(4828\.03 m\); the margin is -0\.5 mi \(-804\.67 m\)\.$/,
    );
    const { textUnit: _, ...stored } = visibility;
    expect(valueWithinLimitV2.evaluate(stored, { quantity: [assessment] }, at).summary).toContain(
      'is 4023.36 m; the limit is at least 4828.03 m',
    );
    expect(checkParameterProblem('value.within-limit', 2, { ...visibility, unit: undefined })).toBeDefined();
  });

  it('is insufficient without a limit, baseline or offset, and stops applying once the limit ends', () => {
    expect(valueWithinLimitV2.evaluate(params, { quantity, limit: [] }, at).reasonCode).toBe('limit_missing');
    expect(valueWithinLimitV2.evaluate(params, { quantity: quantity.slice(0, 1), limit: [part] }, at)).toMatchObject({
      evidenceState: 'insufficient',
      reasonCode: 'baseline_missing',
    });
    const noOffset = life('bare', { lifeLimitHours: 100 }, { start: '2026-06-01T00:00:00.000Z' });
    expect(valueWithinLimitV2.evaluate(params, { quantity, limit: [noOffset] }, at).reasonCode).toBe('offset_missing');
    const removed = life(
      'removed',
      { lifeLimitHours: 100, partTimeAtInstallHours: 0 },
      { start: '2026-06-01T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z' },
    );
    expect(valueWithinLimitV2.evaluate(params, { quantity, limit: [removed] }, at)).toMatchObject({
      evidenceState: 'not_applicable',
      outcome: 'not_applicable',
      reasonCode: 'limit_ended',
    });
    expect(valueWithinLimitV2.evaluate(params, { quantity: [], limit: [part] }, at).reasonCode).toBe('value_missing');
  });

  it('compares with a fixed limit or a limit in the same record', () => {
    const count = (id: string, simultaneousAircraftCount: number, made: Made = {}) =>
      record(id, 'operation.multiple-aircraft', { simultaneousAircraftCount, manufacturerLimitCount: 3 }, made);
    const fixed = count('fixed', 3);
    const recordLimit = {
      select: select('operation.multiple-aircraft'),
      field: 'values.record.simultaneousAircraftCount',
      comparison: 'at_most' as const,
      limitSelect: select('operation.multiple-aircraft'),
      limitField: 'values.record.manufacturerLimitCount',
    };
    expect(valueWithinLimitV2.evaluate(recordLimit, { quantity: [fixed], limit: [fixed] }, at)).toMatchObject({
      outcome: 'pass',
      evidence: ['fixed'],
    });
    const fixedLimit = { field: 'values.record.simultaneousAircraftCount', comparison: 'below' as const, limit: 3 };
    expect(valueWithinLimitV2.evaluate(fixedLimit, { quantity: [fixed] }, at).outcome).toBe('attention');
  });
});

describe('value.one-of', () => {
  const condition = (id: string, recordedCondition: unknown, made: Made = {}) =>
    record(id, 'aircraft.condition', { recordedCondition }, made);
  const params = {
    select: select('aircraft.condition'),
    field: 'values.record.recordedCondition',
    expected: ['no_unsafe_condition_known'],
    undetermined: ['not_determined'],
  };

  it('separates expected, undetermined and other values', () => {
    expect(valueOneOfV1.evaluate(params, { subject: [condition('a', 'no_unsafe_condition_known')] }, at)).toMatchObject(
      {
        evidenceState: 'supported',
        outcome: 'pass',
        reasonCode: 'value_expected',
      },
    );
    expect(valueOneOfV1.evaluate(params, { subject: [condition('a', 'not_determined')] }, at)).toMatchObject({
      evidenceState: 'insufficient',
      outcome: 'attention',
      reasonCode: 'value_undetermined',
    });
    expect(valueOneOfV1.evaluate(params, { subject: [condition('a', 'unsafe_condition_known')] }, at)).toMatchObject({
      evidenceState: 'supported',
      outcome: 'attention',
      reasonCode: 'value_unexpected',
    });
    expect(
      valueOneOfV1.evaluate(
        { field: 'values.record.hazardousMaterial', expected: [false] },
        { subject: [record('p', 'aircraft.payload', { hazardousMaterial: false })] },
        at,
      ).outcome,
    ).toBe('pass');
  });

  it('is insufficient without a value and conflicting on disagreement', () => {
    expect(valueOneOfV1.evaluate(params, { subject: [condition('a', '  ')] }, at).reasonCode).toBe('value_missing');
    expect(
      valueOneOfV1.evaluate(
        params,
        { subject: [condition('a', 'not_determined'), condition('b', 'no_unsafe_condition_known')] },
        at,
      ).evidenceState,
    ).toBe('conflicting');
    expect(
      valueOneOfV1.evaluate(params, { subject: [condition('fixed', 'no_unsafe_condition_known')] }, at).outcome,
    ).toBe('pass');
  });
});

describe('occurrence.in-window', () => {
  const irregularity = (id: string, occurredAt: string) =>
    record(id, 'occurrence.mechanical-irregularity', {}, { occurredAt });
  const action = (id: string, occurredAt: string, made: Made = {}) =>
    record(id, 'maintenance.action', {}, { occurredAt, ...made });
  const followUp = {
    select: select('maintenance.action'),
    expect: 'present' as const,
    triggerSelect: select('occurrence.mechanical-irregularity'),
  };

  it('needs a later occurrence after each trigger, and does not apply without one', () => {
    const triggers = [irregularity('i2', '2026-10-20T00:00:00.000Z'), irregularity('i1', '2026-10-01T00:00:00.000Z')];
    const between = action('m1', '2026-10-05T00:00:00.000Z');
    const missing = occurrenceInWindowV1.evaluate(followUp, { occurrence: [between], trigger: triggers }, at);
    expect(missing).toMatchObject({ evidenceState: 'insufficient', outcome: 'attention' });
    expect(missing.summary).toContain('1 of 2 triggering record(s): i2');
    expect(
      occurrenceInWindowV1.evaluate(
        followUp,
        { occurrence: [action('m2', '2026-10-20T00:00:00.000Z'), between], trigger: triggers },
        at,
      ),
    ).toMatchObject({ evidenceState: 'supported', outcome: 'pass' });
    expect(occurrenceInWindowV1.evaluate(followUp, { occurrence: [between], trigger: [] }, at)).toMatchObject({
      evidenceState: 'not_applicable',
      outcome: 'not_applicable',
    });
  });

  it('does not count an occurrence before the trigger', () => {
    const trigger = [irregularity('i', '2026-10-01T00:00:00.000Z')];
    const early = action('early', '2026-09-30T00:00:00.000Z');
    expect(occurrenceInWindowV1.evaluate(followUp, { occurrence: [early], trigger }, at).outcome).toBe('attention');
  });

  it('reports an occurrence expected absent from a window, with half-open bounds', () => {
    const params = { select: select('occurrence.accident'), expect: 'absent' as const };
    const window = observation(
      'w',
      {},
      { interval: { start: '2026-11-02T10:00:00.000Z', end: '2026-11-02T11:00:00.000Z' } },
    );
    const accident = (when: string) => record('acc', 'occurrence.accident', {}, { occurredAt: when });
    expect(
      occurrenceInWindowV1.evaluate(
        params,
        { occurrence: [accident('2026-11-02T10:00:00.000Z')], window: [window] },
        at,
      ),
    ).toMatchObject({ evidenceState: 'supported', outcome: 'attention', reasonCode: 'occurrence_recorded' });
    expect(
      occurrenceInWindowV1.evaluate(
        params,
        { occurrence: [accident('2026-11-02T11:00:00.000Z')], window: [window] },
        at,
      ),
    ).toMatchObject({ evidenceState: 'supported', outcome: 'pass', reasonCode: 'occurrence_not_recorded' });
    expect(occurrenceInWindowV1.evaluate(params, { occurrence: [], window: [] }, at).reasonCode).toBe('window_missing');
    expect(occurrenceInWindowV1.evaluate({ ...params, expect: 'present' }, { occurrence: [] }, at)).toMatchObject({
      evidenceState: 'insufficient',
      reasonCode: 'occurrence_not_recorded',
    });
  });
});

describe('record.made-before', () => {
  const plan = record('plan', 'flight.plan', { windowStartsAt: '2026-11-03T12:00:00.000Z' });
  const notice = (id: string, notifiedAt: string, recipient = 'Harbor office') =>
    record(id, 'operation.notification', { notifiedAt, recipient }, { occurredAt: notifiedAt });
  const params = {
    select: select('operation.notification', [{ field: 'values.record.recipient', oneOf: ['Harbor office'] }]),
    windowSelect: select('flight.plan'),
    startField: 'values.record.windowStartsAt',
    leadHours: 24,
  };
  const evaluate = (records: CheckObservation[], now = at) =>
    recordMadeBeforeV1.evaluate(params, { record: records, window: [plan] }, now);

  it('passes when a selected record was made at least the lead before the start', () => {
    const result = evaluate([notice('late', '2026-11-03T00:00:00.000Z'), notice('early', '2026-11-02T11:00:00.000Z')]);
    expect(result).toMatchObject({ evidenceState: 'supported', outcome: 'pass', reasonCode: 'made_in_time' });
    expect(result.evidence).toEqual(['plan', 'early']);
    expect(result.details).toEqual({
      startsAt: '2026-11-03T12:00:00.000Z',
      dueBy: '2026-11-02T12:00:00.000Z',
      notBefore: null,
      madeAt: '2026-11-02T11:00:00.000Z',
    });
  });

  it('counts a record made exactly at the deadline as in time', () => {
    expect(evaluate([notice('due', '2026-11-02T12:00:00.000Z')]).outcome).toBe('pass');
  });

  it('reports a record made after the deadline as late', () => {
    const result = evaluate([notice('late', '2026-11-02T13:00:00.000Z')]);
    expect(result).toMatchObject({ evidenceState: 'supported', outcome: 'attention', reasonCode: 'made_late' });
    expect(result.details?.madeAt).toBe('2026-11-02T13:00:00.000Z');
  });

  it('waits until the deadline when nothing is made yet, then needs attention', () => {
    const early = evaluate([], clock('2026-11-02T08:00:00.000Z'));
    expect(early).toMatchObject({ evidenceState: 'insufficient', outcome: 'pending', reasonCode: 'not_made_yet' });
    expect(early.nextBoundary).toBe('2026-11-02T12:00:00.001Z');
    const after = evaluate([], clock('2026-11-02T12:00:00.001Z'));
    expect(after).toMatchObject({ evidenceState: 'insufficient', outcome: 'attention', reasonCode: 'not_made' });
  });

  it('reads only the selected records', () => {
    expect(evaluate([notice('other', '2026-11-01T00:00:00.000Z', 'Somebody else')]).reasonCode).toBe('not_made');
  });

  it('is insufficient without a valid start', () => {
    const result = recordMadeBeforeV1.evaluate(params, { record: [], window: [] }, at);
    expect(result).toMatchObject({ evidenceState: 'insufficient', outcome: 'pending', reasonCode: 'start_missing' });
  });

  it('reads the instant from a named field when given one', () => {
    const made = record('field', 'operation.notification', {
      recipient: 'Harbor office',
      notifiedAt: '2026-11-01T00:00:00.000Z',
    });
    const result = recordMadeBeforeV1.evaluate(
      { ...params, atField: 'values.record.notifiedAt' },
      { record: [made], window: [plan] },
      at,
    );
    expect(result.details?.madeAt).toBe('2026-11-01T00:00:00.000Z');
  });

  it('refuses parameters without a start field or with a negative lead', () => {
    expect(checkParameterProblem('record.made-before', 1, { leadHours: 1 })).toBeDefined();
    expect(checkParameterProblem('record.made-before', 1, { startField: 'values.at', leadHours: -1 })).toBeDefined();
    expect(checkParameterProblem('record.made-before', 1, { startField: 'values.at', leadHours: 24 })).toBeUndefined();
  });
});
