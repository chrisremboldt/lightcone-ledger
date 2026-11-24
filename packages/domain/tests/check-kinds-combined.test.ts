import { describe, expect, it } from 'vitest';
import { checkKindDigest, checkParameterProblem, findCheckKind, type CheckObservation } from '../src/check-kinds.js';
import '../src/check-kind-library.js';
import {
  businessDaysWithinV1,
  combinedCheckKinds,
  fieldMatchesV1,
  intervalCoversIntersectionV1,
  localDaysTotalV1,
  totalFromOpeningV1,
} from '../src/check-kind-library-combined.js';

// Minimal made-up observations. Record types and field names are invented; the kinds know none of them.

const clock = (evaluatedAt: string) => ({ mode: 'wall' as const, evaluatedAt });

interface Made {
  occurredAt?: string;
  interval?: { start: string; end?: string };
}

function observation(id: string, values: Record<string, unknown>, made: Made = {}): CheckObservation {
  const occurredAt = made.occurredAt ?? made.interval?.start ?? '2026-11-02T10:00:00.000Z';
  const time = { occurredAt, ...(made.interval ? { interval: made.interval } : {}) };
  return {
    id,
    type: 'made-up.reading',
    version: 1,
    ...time,
    observation: { type: 'made-up.reading', version: 1, ...time, values },
  };
}

function spanning(id: string, start: string, end: string | undefined, values: Record<string, unknown> = {}) {
  return observation(id, values, { interval: { start, ...(end ? { end } : {}) } });
}

describe('combined check kinds', () => {
  it('are registered under new ids, compared by digest', () => {
    expect(combinedCheckKinds.map((kind) => `${kind.id}@${kind.version}`)).toEqual([
      'field.matches@1',
      'total.from-opening@1',
      'interval.covers-intersection@1',
      'local-days.total@1',
      'business-days.within@1',
    ]);
    for (const kind of combinedCheckKinds)
      expect(checkKindDigest(findCheckKind(kind.id, kind.version)!)).toBe(checkKindDigest(kind));
  });

  it('name no regulation and use no verdict wording', () => {
    const text = JSON.stringify(combinedCheckKinds.map((kind) => [kind.title, kind.description, kind.details]));
    expect(text).not.toMatch(/\b(compliant|compliance|authori[sz]ed|no-go|go|part \d|section|§|nprm)\b/i);
  });
});

describe('field.matches', () => {
  const reference = (id: string, makeModel: unknown, at?: string) =>
    observation(id, { makeModel }, at ? { occurredAt: at } : {});
  const candidate = (id: string, makeModel: unknown, hours?: number, at?: string) =>
    observation(id, { makeModel, ...(hours === undefined ? {} : { hours }) }, at ? { occurredAt: at } : {});
  const params = {
    referenceField: 'values.makeModel',
    candidateField: 'values.makeModel',
    candidateScope: 'any' as const,
    textMatch: 'case_insensitive' as const,
  };
  const withHours = {
    ...params,
    matchedField: 'values.hours',
    matchedComparison: 'at_least' as const,
    matchedLimit: 5,
  };
  const at = clock('2026-11-03T00:00:00.000Z');

  it('validates its parameters', () => {
    expect(checkParameterProblem('field.matches', 1, withHours)).toBeUndefined();
    expect(checkParameterProblem('field.matches', 1, { ...params, matchedField: 'values.hours' })).toBeDefined();
    expect(checkParameterProblem('field.matches', 1, { ...params, candidateScope: 'some' })).toBeDefined();
  });

  it('passes when a candidate matches, ignoring case and spacing when asked, with a number within the limit', () => {
    const outcome = fieldMatchesV1.evaluate(
      withHours,
      {
        reference: [reference('ref', 'Kestrel K2')],
        candidate: [
          candidate('a', 'Heron H1', 40),
          candidate('b', ' kestrel  k2 ', 3),
          candidate('c', 'KESTREL K2', 6),
        ],
      },
      at,
    );
    expect(outcome).toMatchObject({
      evidenceState: 'supported',
      outcome: 'pass',
      reasonCode: 'values_match',
      evidence: ['ref', 'b', 'c'],
      details: { referenceValue: 'kestrel k2', matchCount: 2, matchedValue: 6 },
    });
  });

  it('needs attention when nothing matches or the matching number is outside the limit', () => {
    expect(
      fieldMatchesV1.evaluate(
        params,
        { reference: [reference('ref', 'Kestrel K2')], candidate: [candidate('a', 'Heron H1')] },
        at,
      ),
    ).toMatchObject({ evidenceState: 'supported', outcome: 'attention', reasonCode: 'values_do_not_match' });
    expect(
      fieldMatchesV1.evaluate(
        withHours,
        { reference: [reference('ref', 'Kestrel K2')], candidate: [candidate('a', 'Kestrel K2', 4.5)] },
        at,
      ),
    ).toMatchObject({
      outcome: 'attention',
      reasonCode: 'matched_value_outside_limit',
      details: { matchedValue: 4.5 },
    });
    expect(
      fieldMatchesV1.evaluate(
        { ...params, textMatch: 'exact' },
        { reference: [reference('ref', 'Kestrel K2')], candidate: [candidate('a', 'kestrel k2')] },
        at,
      ).reasonCode,
    ).toBe('values_do_not_match');
  });

  it('is insufficient when either value is missing, never a pass', () => {
    expect(
      fieldMatchesV1.evaluate(params, { reference: [], candidate: [candidate('a', 'Kestrel K2')] }, at),
    ).toMatchObject({ evidenceState: 'insufficient', outcome: 'pending', reasonCode: 'reference_value_missing' });
    expect(
      fieldMatchesV1.evaluate(params, { reference: [reference('ref', ' ')], candidate: [candidate('a', 'K')] }, at)
        .reasonCode,
    ).toBe('reference_value_missing');
    expect(
      fieldMatchesV1.evaluate(params, { reference: [reference('ref', 'Kestrel K2')], candidate: [] }, at),
    ).toMatchObject({ evidenceState: 'insufficient', reasonCode: 'candidate_value_missing' });
    expect(
      fieldMatchesV1.evaluate(
        withHours,
        { reference: [reference('ref', 'Kestrel K2')], candidate: [candidate('a', 'Kestrel K2')] },
        at,
      ),
    ).toMatchObject({ evidenceState: 'insufficient', outcome: 'attention', reasonCode: 'matched_value_missing' });
  });

  it('matches through a mapping, and is insufficient for a reference value the mapping does not list', () => {
    const mapped = {
      ...params,
      textMatch: 'exact' as const,
      mapping: [{ value: 'Kestrel K2', matches: ['Kestrel K2', 'Kestrel K2 Long Range'] }],
    };
    expect(
      fieldMatchesV1.evaluate(
        mapped,
        { reference: [reference('ref', 'Kestrel K2')], candidate: [candidate('a', 'Kestrel K2 Long Range')] },
        at,
      ).outcome,
    ).toBe('pass');
    expect(
      fieldMatchesV1.evaluate(
        mapped,
        { reference: [reference('ref', 'Heron H1')], candidate: [candidate('a', 'Heron H1')] },
        at,
      ),
    ).toMatchObject({ evidenceState: 'insufficient', outcome: 'attention', reasonCode: 'value_unmapped' });
  });

  it('conflicts when simultaneous reference or latest candidate values disagree', () => {
    expect(
      fieldMatchesV1.evaluate(
        params,
        {
          reference: [reference('r1', 'Kestrel K2'), reference('r2', 'Heron H1')],
          candidate: [candidate('a', 'Kestrel K2')],
        },
        at,
      ),
    ).toMatchObject({ evidenceState: 'conflicting', outcome: 'attention', reasonCode: 'reference_values_disagree' });
    const latest = { ...params, candidateScope: 'latest' as const };
    expect(
      fieldMatchesV1.evaluate(
        latest,
        {
          reference: [reference('ref', 'Kestrel K2')],
          candidate: [candidate('a', 'Kestrel K2'), candidate('b', 'Heron H1')],
        },
        at,
      ),
    ).toMatchObject({ evidenceState: 'conflicting', reasonCode: 'candidate_values_disagree' });
    // With scope latest, an older candidate does not count.
    expect(
      fieldMatchesV1.evaluate(
        latest,
        {
          reference: [reference('ref', 'Kestrel K2')],
          candidate: [
            candidate('new', 'Heron H1', undefined, '2026-11-02T12:00:00.000Z'),
            candidate('old', 'Kestrel K2', undefined, '2026-11-01T12:00:00.000Z'),
          ],
        },
        at,
      ).reasonCode,
    ).toBe('values_do_not_match');
  });
});

describe('total.from-opening', () => {
  const opening = (id: string, total: unknown, at = '2026-10-01T00:00:00.000Z') =>
    observation(id, { totalHours: total, coveredThrough: at }, { occurredAt: at });
  const flight = (id: string, start: string, end: string, hours?: number) =>
    spanning(id, start, end, hours === undefined ? {} : { hours });
  const flights = [
    flight('before', '2026-09-30T10:00:00.000Z', '2026-09-30T11:00:00.000Z', 1),
    flight('f1', '2026-10-02T10:00:00.000Z', '2026-10-02T11:30:00.000Z', 1.5),
    flight('f2', '2026-10-03T10:00:00.000Z', '2026-10-03T12:15:00.000Z', 2.25),
  ];
  const base = { openingField: 'values.totalHours', additionsField: 'values.hours' };
  const at = clock('2026-11-03T00:00:00.000Z');

  it('validates its parameters', () => {
    expect(checkParameterProblem('total.from-opening', 1, base)).toBeUndefined();
    expect(
      checkParameterProblem('total.from-opening', 1, { ...base, comparison: 'at_most', limit: 5 }),
    ).toBeUndefined();
    expect(checkParameterProblem('total.from-opening', 1, { ...base, limit: 5 })).toBeDefined();
    expect(checkParameterProblem('total.from-opening', 1, { ...base, comparison: 'at_most' })).toBeDefined();
    expect(
      checkParameterProblem('total.from-opening', 1, {
        ...base,
        comparison: 'at_most',
        limit: 5,
        limitField: 'values.limit',
      }),
    ).toBeDefined();
    const timed = {
      openingField: 'values.totalHours',
      additionsStartField: 'values.up',
      additionsEndField: 'values.down',
    };
    expect(checkParameterProblem('total.from-opening', 1, timed)).toBeUndefined();
    expect(checkParameterProblem('total.from-opening', 1, { ...timed, additionsField: 'values.hours' })).toBeDefined();
    expect(checkParameterProblem('total.from-opening', 1, { ...base, additionsStartField: 'values.up' })).toBeDefined();
  });

  it('adds the hours between two recorded times of each addition', () => {
    const timed = {
      openingField: 'values.totalHours',
      additionsStartField: 'values.up',
      additionsEndField: 'values.down',
    };
    const report = (id: string, up: string, down?: string) =>
      observation(id, { up, ...(down ? { down } : {}) }, { occurredAt: '2026-10-05T00:00:00.000Z' });
    const reports = [
      report('r0', '2026-09-30T10:00:00.000Z', '2026-09-30T11:00:00.000Z'),
      report('r1', '2026-10-02T10:00:00.000Z', '2026-10-02T11:30:00.000Z'),
      report('r2', '2026-10-03T10:00:00.000Z', '2026-10-03T10:45:00.000Z'),
    ];
    expect(
      totalFromOpeningV1.evaluate(timed, { opening: [opening('open', 100)], additions: reports }, at),
    ).toMatchObject({ outcome: 'pass', evidence: ['open', 'r1', 'r2'], details: { addedValue: 2.25, total: 102.25 } });
    expect(
      totalFromOpeningV1.evaluate(
        timed,
        { opening: [opening('open', 100)], additions: [...reports, report('r3', '2026-10-04T10:00:00.000Z')] },
        at,
      ),
    ).toMatchObject({ evidenceState: 'insufficient', reasonCode: 'addition_value_missing', evidence: ['open', 'r3'] });
    expect(
      totalFromOpeningV1.evaluate(
        timed,
        {
          opening: [opening('open', 100)],
          additions: [...reports, report('twice', '2026-10-02T10:00:00.000Z', '2026-10-02T11:30:00.000Z')],
        },
        at,
      ).reasonCode,
    ).toBe('additions_overlap');
  });

  it('reads the operator’s own records for times no report covers, and names records that differ from a report', () => {
    const timed = {
      openingField: 'values.totalHours',
      additionsStartField: 'values.up',
      additionsEndField: 'values.down',
      recordedStartField: 'values.takeoff',
      recordedEndField: 'values.landing',
    };
    expect(checkParameterProblem('total.from-opening', 1, timed)).toBeUndefined();
    expect(checkParameterProblem('total.from-opening', 1, { ...timed, recordedEndField: undefined })).toBeDefined();
    const report = (id: string, up: string, down: string) =>
      observation(id, { up, down }, { occurredAt: '2026-10-05T00:00:00.000Z' });
    const record = (id: string, takeoff: string, landing: string) =>
      observation(id, { takeoff, landing }, { interval: { start: takeoff, end: landing } });
    const inputs = {
      opening: [opening('open', 100)],
      additions: [report('r1', '2026-10-02T10:00:00.000Z', '2026-10-02T11:30:00.000Z')],
      recordedAdditions: [
        // The same flight as r1, logged a minute later: counted from the report and named.
        record('logged-r1', '2026-10-02T10:01:00.000Z', '2026-10-02T11:30:00.000Z'),
        record('logged-only', '2026-10-03T10:00:00.000Z', '2026-10-03T10:30:00.000Z'),
        record('before', '2026-09-30T10:00:00.000Z', '2026-09-30T11:00:00.000Z'),
      ],
    };
    const outcome = totalFromOpeningV1.evaluate(timed, inputs, at);
    expect(outcome).toMatchObject({
      outcome: 'pass',
      reasonCode: 'total_derived',
      evidence: ['open', 'r1', 'logged-only', 'logged-r1'],
      details: { addedValue: 2, additionCount: 2, recordedAdditionCount: 1, recordedDiffering: 1, total: 102 },
    });
    expect(outcome.summary).toMatch(/from 2 later addition\(s\) \(1 read from the operator’s own records\) is 102\./);
    expect(outcome.summary).toMatch(
      /1 of the operator’s own records state times that differ from the report of the same time, which is counted instead: logged-r1\.$/,
    );
    // Without a report, every record counts; a record agreeing with a report is neither counted nor named.
    expect(totalFromOpeningV1.evaluate(timed, { ...inputs, additions: [] }, at).details).toMatchObject({
      additionCount: 2,
      recordedAdditionCount: 2,
      recordedDiffering: 0,
      total: 101.983333,
    });
    const agreeing = record('logged-same', '2026-10-02T10:00:00.000Z', '2026-10-02T11:30:00.000Z');
    expect(totalFromOpeningV1.evaluate(timed, { ...inputs, recordedAdditions: [agreeing] }, at).details).toMatchObject({
      additionCount: 1,
      recordedAdditionCount: 0,
      recordedDiffering: 0,
      total: 101.5,
    });
  });

  it('derives the total from the opening balance and the additions after it', () => {
    const outcome = totalFromOpeningV1.evaluate(base, { opening: [opening('open', 100)], additions: flights }, at);
    expect(outcome).toMatchObject({
      evidenceState: 'supported',
      outcome: 'pass',
      reasonCode: 'total_derived',
      evidence: ['open', 'f1', 'f2'],
      details: {
        openingValue: 100,
        openingAt: '2026-10-01T00:00:00.000Z',
        addedValue: 3.75,
        additionCount: 2,
        total: 103.75,
        limit: null,
        margin: null,
      },
    });
  });

  it('takes the opening time from a named field', () => {
    const outcome = totalFromOpeningV1.evaluate(
      { ...base, openingAtField: 'values.coveredThrough' },
      { opening: [opening('open', 100, '2026-10-02T12:00:00.000Z')], additions: flights },
      at,
    );
    expect(outcome.details).toMatchObject({ additionCount: 1, total: 102.25 });
  });

  it('compares the total with a fixed or recorded limit and states the margin', () => {
    const inputs = { opening: [opening('open', 100)], additions: flights };
    expect(totalFromOpeningV1.evaluate({ ...base, comparison: 'at_most', limit: 110 }, inputs, at)).toMatchObject({
      outcome: 'pass',
      reasonCode: 'total_within_limit',
      details: { margin: 6.25 },
    });
    expect(totalFromOpeningV1.evaluate({ ...base, comparison: 'at_most', limit: 103 }, inputs, at)).toMatchObject({
      evidenceState: 'supported',
      outcome: 'attention',
      reasonCode: 'total_outside_limit',
      details: { total: 103.75, limit: 103, margin: -0.75 },
    });
    expect(
      totalFromOpeningV1.evaluate(
        { ...base, comparison: 'at_most', limitField: 'values.lifeHours' },
        { ...inputs, limit: [observation('lim', { lifeHours: 120 })] },
        at,
      ),
    ).toMatchObject({ outcome: 'pass', evidence: ['open', 'f1', 'f2', 'lim'], details: { limit: 120 } });
  });

  it('is insufficient without an opening balance, an addition value or a recorded limit', () => {
    expect(totalFromOpeningV1.evaluate(base, { opening: [], additions: flights }, at)).toMatchObject({
      evidenceState: 'insufficient',
      outcome: 'attention',
      reasonCode: 'opening_balance_missing',
    });
    expect(
      totalFromOpeningV1.evaluate(
        base,
        {
          opening: [opening('open', 100)],
          additions: [...flights, flight('f3', '2026-10-04T10:00:00.000Z', '2026-10-04T11:00:00.000Z')],
        },
        at,
      ),
    ).toMatchObject({ evidenceState: 'insufficient', reasonCode: 'addition_value_missing', evidence: ['open', 'f3'] });
    expect(
      totalFromOpeningV1.evaluate(
        { ...base, comparison: 'at_most', limitField: 'values.lifeHours' },
        { opening: [opening('open', 100)], additions: flights, limit: [] },
        at,
      ),
    ).toMatchObject({ evidenceState: 'insufficient', reasonCode: 'limit_missing' });
  });

  it('conflicts on disagreeing openings and on additions that overlap in time', () => {
    expect(
      totalFromOpeningV1.evaluate(base, { opening: [opening('o1', 100), opening('o2', 90)], additions: flights }, at),
    ).toMatchObject({ evidenceState: 'conflicting', outcome: 'attention', reasonCode: 'opening_balances_disagree' });
    expect(
      totalFromOpeningV1.evaluate(
        base,
        {
          opening: [opening('open', 100)],
          additions: [...flights, flight('again', '2026-10-02T11:00:00.000Z', '2026-10-02T11:45:00.000Z', 0.75)],
        },
        at,
      ),
    ).toMatchObject({
      evidenceState: 'conflicting',
      reasonCode: 'additions_overlap',
      evidence: ['open', 'f1', 'again'],
    });
  });
});

describe('interval.covers-intersection', () => {
  const params = { openEnd: 'stated' as const, whenDisjoint: 'not_applicable' as const };
  const plan = spanning('plan', '2026-11-02T10:00:00.000Z', '2026-11-02T12:00:00.000Z');
  const permit = spanning('permit', '2026-11-02T11:00:00.000Z', '2026-11-02T14:00:00.000Z');
  const at = clock('2026-11-03T00:00:00.000Z');

  it('passes when the intervals cover the time both windows share', () => {
    const outcome = intervalCoversIntersectionV1.evaluate(
      params,
      {
        interval: [
          spanning('a', '2026-11-02T10:30:00.000Z', '2026-11-02T11:20:00.000Z'),
          spanning('b', '2026-11-02T11:20:00.000Z', '2026-11-02T12:15:00.000Z'),
        ],
        window: [plan],
        otherWindow: [permit],
      },
      at,
    );
    expect(outcome).toMatchObject({
      evidenceState: 'supported',
      outcome: 'pass',
      reasonCode: 'window_covered',
      evidence: ['plan', 'permit', 'a', 'b'],
      details: {
        windowStart: '2026-11-02T11:00:00.000Z',
        windowEnd: '2026-11-02T12:00:00.000Z',
        uncoveredFrom: null,
      },
    });
  });

  it('needs attention when part of the shared window is not covered', () => {
    const outcome = intervalCoversIntersectionV1.evaluate(
      params,
      {
        interval: [spanning('a', '2026-11-02T10:00:00.000Z', '2026-11-02T11:30:00.000Z')],
        window: [plan],
        otherWindow: [permit],
      },
      at,
    );
    expect(outcome).toMatchObject({
      evidenceState: 'insufficient',
      outcome: 'attention',
      reasonCode: 'window_not_covered',
      details: { uncoveredFrom: '2026-11-02T11:30:00.000Z' },
    });
  });

  it('does not apply, or needs attention when asked, when the windows share no time', () => {
    const later = spanning('later', '2026-11-02T13:00:00.000Z', '2026-11-02T14:00:00.000Z');
    const inputs = { interval: [], window: [plan], otherWindow: [later] };
    expect(intervalCoversIntersectionV1.evaluate(params, inputs, at)).toMatchObject({
      outcome: 'not_applicable',
      reasonCode: 'windows_disjoint',
    });
    expect(intervalCoversIntersectionV1.evaluate({ ...params, whenDisjoint: 'attention' }, inputs, at)).toMatchObject({
      evidenceState: 'supported',
      outcome: 'attention',
      reasonCode: 'windows_disjoint',
    });
  });

  it('is insufficient without either window', () => {
    expect(
      intervalCoversIntersectionV1.evaluate(params, { interval: [], window: [plan], otherWindow: [] }, at),
    ).toMatchObject({ evidenceState: 'insufficient', outcome: 'pending', reasonCode: 'window_missing' });
    expect(
      intervalCoversIntersectionV1.evaluate(params, { interval: [], window: [], otherWindow: [permit] }, at).reasonCode,
    ).toBe('window_missing');
  });

  it('conflicts when simultaneous observations state different windows', () => {
    const other = spanning('plan-2', '2026-11-02T10:00:00.000Z', '2026-11-02T13:00:00.000Z');
    expect(
      intervalCoversIntersectionV1.evaluate(params, { interval: [], window: [plan, other], otherWindow: [permit] }, at),
    ).toMatchObject({ evidenceState: 'conflicting', outcome: 'attention', reasonCode: 'windows_disagree' });
  });
});

describe('local-days.total', () => {
  const zone = 'America/Denver';
  const flight = (id: string, at: string, values: Record<string, unknown> = {}) =>
    observation(id, values, { occurredAt: at });
  // 2026-11-01 is a Sunday; Denver leaves daylight saving at 02:00 that morning, so the local day lasts 25 hours,
  // from 06:00Z to 07:00Z the next day.
  const flights = [
    flight('oct31', '2026-11-01T05:30:00.000Z'), // 23:30 on 31 October, local
    flight('early', '2026-11-01T06:30:00.000Z'), // 00:30 on 1 November, local
    flight('late', '2026-11-02T06:30:00.000Z'), // 23:30 on 1 November, local; 2 November in UTC
    flight('later', '2026-11-02T06:40:00.000Z'),
  ];
  const daily = {
    timeZone: zone,
    measure: 'count' as const,
    days: 1,
    scope: 'total' as const,
    comparison: 'at_most' as const,
    limit: 3,
  };
  const evening = clock('2026-11-02T06:45:00.000Z'); // 23:45 on 1 November, local

  it('validates its parameters, refusing zone abbreviations and offsets', () => {
    expect(checkParameterProblem('local-days.total', 1, daily)).toBeUndefined();
    expect(checkParameterProblem('local-days.total', 1, { ...daily, timeZone: 'MST' })).toBeDefined();
    expect(checkParameterProblem('local-days.total', 1, { ...daily, timeZone: '-07:00' })).toBeDefined();
    expect(checkParameterProblem('local-days.total', 1, { ...daily, measure: 'sum' })).toBeDefined();
    expect(checkParameterProblem('local-days.total', 1, { ...daily, field: 'values.hours' })).toBeDefined();
    expect(checkParameterProblem('local-days.total', 1, { ...daily, weekStartsOn: 1 })).toBeDefined();
    expect(checkParameterProblem('local-days.total', 1, { ...daily, requireDays: 1 })).toBeDefined();
  });

  it('counts on the local calendar day, across the change from daylight saving', () => {
    const outcome = localDaysTotalV1.evaluate(daily, { subject: flights }, evening);
    expect(outcome).toMatchObject({
      evidenceState: 'supported',
      outcome: 'pass',
      reasonCode: 'days_within_limit',
      evidence: ['early', 'late', 'later'],
      nextBoundary: '2026-11-02T07:00:00.000Z',
      details: { timeZone: zone, firstDay: '2026-11-01', lastDay: '2026-11-01', total: 3, limit: 3 },
    });
    // The same instants counted by UTC date would give two on 1 November; the zone is what makes it three.
    expect(
      localDaysTotalV1.evaluate({ ...daily, timeZone: 'UTC' }, { subject: flights }, evening).details,
    ).toMatchObject({ firstDay: '2026-11-02', total: 2 });
  });

  it('needs attention when the total is outside the limit', () => {
    expect(localDaysTotalV1.evaluate({ ...daily, limit: 2 }, { subject: flights }, evening)).toMatchObject({
      evidenceState: 'supported',
      outcome: 'attention',
      reasonCode: 'days_outside_limit',
    });
  });

  it('sums a field over a number of days', () => {
    const hours = flights.map((item, index) => ({
      ...item,
      observation: { ...item.observation, values: { hours: index + 1 } },
    }));
    expect(
      localDaysTotalV1.evaluate(
        { ...daily, measure: 'sum', field: 'values.hours', days: 2, limit: 10 },
        { subject: hours },
        evening,
      ).details,
    ).toMatchObject({ firstDay: '2026-10-31', lastDay: '2026-11-01', total: 10 });
  });

  it('measures hours on days of 25 and 23 hours', () => {
    const duty = [
      spanning('fall', '2026-11-01T06:00:00.000Z', '2026-11-02T07:00:00.000Z'),
      spanning('spring', '2026-03-08T07:00:00.000Z', '2026-03-09T06:00:00.000Z'),
    ];
    const hours = { ...daily, measure: 'hours' as const, limit: 100 };
    expect(
      localDaysTotalV1.evaluate(hours, { subject: duty }, clock('2026-11-02T06:59:00.000Z')).details,
    ).toMatchObject({ total: 25 });
    expect(
      localDaysTotalV1.evaluate(hours, { subject: duty }, clock('2026-03-09T05:00:00.000Z')).details,
    ).toMatchObject({ firstDay: '2026-03-08', total: 23 });
  });

  describe('a whole day of recorded rest in the local week', () => {
    const week = {
      timeZone: zone,
      measure: 'hours_uncovered' as const,
      weekStartsOn: 7,
      scope: 'each_day' as const,
      requireDays: 1,
      comparison: 'at_most' as const,
      limit: 0,
    };

    it('passes when recorded rest covers a whole local day, 25 hours long', () => {
      const rest = [spanning('rest', '2026-11-01T06:00:00.000Z', '2026-11-02T07:00:00.000Z')];
      expect(localDaysTotalV1.evaluate(week, { subject: rest }, clock('2026-11-03T18:00:00.000Z'))).toMatchObject({
        evidenceState: 'supported',
        outcome: 'pass',
        details: { firstDay: '2026-11-01', lastDay: '2026-11-07', daysWithinLimit: 1, daysRequired: 1 },
      });
    });

    it('waits while days of the week remain, then needs attention', () => {
      // Ends an hour short of local midnight: 23:00 MST on 1 November.
      const rest = [spanning('rest', '2026-11-01T06:00:00.000Z', '2026-11-02T06:00:00.000Z')];
      expect(localDaysTotalV1.evaluate(week, { subject: rest }, clock('2026-11-03T18:00:00.000Z'))).toMatchObject({
        evidenceState: 'insufficient',
        outcome: 'pending',
        reasonCode: 'days_remaining',
        nextBoundary: '2026-11-04T07:00:00.000Z',
        details: { daysWithinLimit: 0 },
      });
      expect(localDaysTotalV1.evaluate(week, { subject: rest }, clock('2026-11-08T05:00:00.000Z'))).toMatchObject({
        evidenceState: 'supported',
        outcome: 'attention',
        reasonCode: 'days_outside_limit',
      });
    });

    it('is insufficient for an interval without an end', () => {
      const rest = [spanning('open', '2026-11-01T06:00:00.000Z', undefined)];
      expect(localDaysTotalV1.evaluate(week, { subject: rest }, clock('2026-11-03T18:00:00.000Z'))).toMatchObject({
        evidenceState: 'insufficient',
        reasonCode: 'interval_end_missing',
        evidence: ['open'],
      });
    });
  });

  it('is insufficient with nothing recorded, an unknown zone or a missing value', () => {
    expect(localDaysTotalV1.evaluate(daily, { subject: [] }, evening)).toMatchObject({
      evidenceState: 'insufficient',
      outcome: 'pending',
      reasonCode: 'subject_missing',
    });
    expect(localDaysTotalV1.evaluate({ ...daily, whenNone: 'zero' }, { subject: [] }, evening)).toMatchObject({
      outcome: 'pass',
      details: { total: 0 },
    });
    expect(
      localDaysTotalV1.evaluate({ ...daily, timeZone: 'Mars/Olympus_Mons' }, { subject: flights }, evening),
    ).toMatchObject({ evidenceState: 'insufficient', reasonCode: 'time_zone_unknown' });
    expect(
      localDaysTotalV1.evaluate({ ...daily, measure: 'sum', field: 'values.hours' }, { subject: flights }, evening),
    ).toMatchObject({ evidenceState: 'insufficient', reasonCode: 'value_missing' });
  });

  it('conflicts when an observation records a different time zone', () => {
    const zoned = [flight('a', '2026-11-01T18:00:00.000Z', { zone: 'America/Phoenix' })];
    expect(
      localDaysTotalV1.evaluate({ ...daily, timeZoneField: 'values.zone' }, { subject: zoned }, evening),
    ).toMatchObject({ evidenceState: 'conflicting', outcome: 'attention', reasonCode: 'time_zones_disagree' });
  });
});

describe('business-days.within', () => {
  const params = {
    fromField: 'values.happenedAt',
    toField: 'values.reportedAt',
    timeZone: 'America/Denver',
    days: 10,
    excludedWeekdays: [6, 7],
    excludedDates: ['2026-11-26'],
    calendarFrom: '2026-01-01',
    calendarThrough: '2026-12-31',
  };
  // 20:00 on Friday 20 November, local; already Saturday in UTC. The ten business days after it skip two weekends
  // and the excluded 26 November, so the last is Monday 7 December and the time runs out at its local midnight.
  const event = (reportedAt?: string, id = 'event', happenedAt = '2026-11-21T03:00:00.000Z') =>
    observation(id, { happenedAt, ...(reportedAt ? { reportedAt } : {}) });

  it('validates its parameters', () => {
    expect(checkParameterProblem('business-days.within', 1, params)).toBeUndefined();
    expect(checkParameterProblem('business-days.within', 1, { ...params, excludedWeekdays: [0] })).toBeDefined();
    expect(checkParameterProblem('business-days.within', 1, { ...params, excludedDates: ['26 Nov'] })).toBeDefined();
    expect(checkParameterProblem('business-days.within', 1, { ...params, timeZone: 'Local' })).toBeDefined();
  });

  it('passes when the later time is before the end of the last business day', () => {
    expect(
      businessDaysWithinV1.evaluate(
        params,
        { subject: [event('2026-12-08T06:59:00.000Z')] },
        clock('2026-12-09T00:00:00.000Z'),
      ),
    ).toMatchObject({
      evidenceState: 'supported',
      outcome: 'pass',
      reasonCode: 'within_business_days',
      evidence: ['event'],
      details: {
        startDay: '2026-11-20',
        dueThrough: '2026-12-07',
        dueAt: '2026-12-08T07:00:00.000Z',
        businessDays: 10,
        endRecorded: true,
      },
    });
  });

  it('needs attention when the later time is after it, or when none is recorded by then', () => {
    expect(
      businessDaysWithinV1.evaluate(
        params,
        { subject: [event('2026-12-08T07:00:00.000Z')] },
        clock('2026-12-09T00:00:00.000Z'),
      ),
    ).toMatchObject({ evidenceState: 'supported', outcome: 'attention', reasonCode: 'after_business_days' });
    expect(
      businessDaysWithinV1.evaluate(params, { subject: [event()] }, clock('2026-12-08T07:00:00.000Z')),
    ).toMatchObject({
      evidenceState: 'insufficient',
      outcome: 'attention',
      reasonCode: 'end_overdue',
    });
  });

  it('awaits the later time until the business days run out', () => {
    expect(
      businessDaysWithinV1.evaluate(params, { subject: [event()] }, clock('2026-12-01T00:00:00.000Z')),
    ).toMatchObject({
      evidenceState: 'insufficient',
      outcome: 'pending',
      reasonCode: 'end_awaited',
      nextBoundary: '2026-12-08T07:00:00.000Z',
    });
  });

  it('is insufficient without an earlier time or beyond the stated calendar', () => {
    const at = clock('2026-12-01T00:00:00.000Z');
    expect(businessDaysWithinV1.evaluate(params, { subject: [] }, at)).toMatchObject({
      evidenceState: 'insufficient',
      reasonCode: 'start_missing',
    });
    expect(
      businessDaysWithinV1.evaluate({ ...params, whenAbsent: 'not_applicable' }, { subject: [] }, at),
    ).toMatchObject({ outcome: 'not_applicable', reasonCode: 'start_not_recorded' });
    expect(
      businessDaysWithinV1.evaluate({ ...params, calendarThrough: '2026-12-04' }, { subject: [event()] }, at),
    ).toMatchObject({ evidenceState: 'insufficient', reasonCode: 'calendar_not_covered', details: { dueAt: null } });
    expect(
      businessDaysWithinV1.evaluate({ ...params, excludedDates: ['2026-02-30'] }, { subject: [event()] }, at),
    ).toMatchObject({ evidenceState: 'insufficient', reasonCode: 'calendar_invalid' });
  });

  it('conflicts when the later time is before the earlier one or simultaneous reports disagree', () => {
    const at = clock('2026-12-01T00:00:00.000Z');
    expect(businessDaysWithinV1.evaluate(params, { subject: [event('2026-11-20T00:00:00.000Z')] }, at)).toMatchObject({
      evidenceState: 'conflicting',
      outcome: 'attention',
      reasonCode: 'end_before_start',
    });
    expect(
      businessDaysWithinV1.evaluate(
        params,
        { subject: [event(undefined, 'a'), event(undefined, 'b', '2026-11-22T03:00:00.000Z')] },
        at,
      ),
    ).toMatchObject({ evidenceState: 'conflicting', reasonCode: 'times_disagree' });
  });
});
