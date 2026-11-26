import GeographicLib from 'geographiclib-geodesic';
import { describe, expect, it } from 'vitest';
import { summaryRecordValues } from '@ledger/contracts';
import {
  checkKindDigest,
  checkParameterProblem,
  findCheckKind,
  type CheckObservation,
  type CheckResult,
} from '../src/check-kinds.js';
import '../src/check-kind-library.js';
import { checkSummaryWording } from '../src/checked-rules.js';
import {
  windowCheckKinds,
  windowValuesWithinLimitV1,
  type WindowValuesWithinLimitParams,
} from '../src/check-kind-library-windows.js';
import { positionInAreaV2, type PositionInAreaV2Params } from '../src/check-kind-library-geometry.js';

// Made-up readings and windows. The observation types and field names are invented; the kinds read only the fields
// the parameters name.

const t0 = Date.parse('2026-11-02T10:00:00.000Z');
const at = (second: number) => new Date(t0 + second * 1000).toISOString();
const clockAt = (second: number) => ({ mode: 'wall' as const, evaluatedAt: at(second) });

let sequence = 0;
function reading(second: number, value: unknown, type = 'made-up.reading'): CheckObservation {
  sequence += 1;
  return {
    id: `reading-${String(sequence).padStart(4, '0')}`,
    type,
    version: 1,
    occurredAt: at(second),
    observation: { type, version: 1, occurredAt: at(second), values: { level: value } },
  };
}

/** A made-up report stating a window by its start and, once known, its end. */
function report(start: number | undefined, end?: number, id = 'report'): CheckObservation {
  return {
    id,
    type: 'made-up.report',
    version: 1,
    occurredAt: at(end ?? start ?? 0),
    observation: {
      type: 'made-up.report',
      version: 1,
      values: { ...(start === undefined ? {} : { from: at(start) }), ...(end === undefined ? {} : { to: at(end) }) },
    },
  };
}

const newestFirst = (items: CheckObservation[]) =>
  [...items].sort((left, right) => right.occurredAt.localeCompare(left.occurredAt) || (left.id < right.id ? 1 : -1));

const base: WindowValuesWithinLimitParams = {
  field: 'values.level',
  comparison: 'at_most',
  limit: 10,
  windowStartField: 'values.from',
  windowEndField: 'values.to',
  coverage: 'required',
};

function check(
  params: Partial<WindowValuesWithinLimitParams>,
  values: CheckObservation[],
  window: CheckObservation[],
  evaluatedAt = 10_000,
): CheckResult {
  const merged = { ...base, ...params } as WindowValuesWithinLimitParams;
  expect(checkParameterProblem(windowValuesWithinLimitV1.id, 1, merged)).toBeUndefined();
  return windowValuesWithinLimitV1.evaluate(merged, { values: newestFirst(values), window }, clockAt(evaluatedAt));
}

/** Readings every 15 seconds from the second given, one per value. */
const series = (from: number, levels: number[]) => levels.map((level, index) => reading(from + index * 15, level));

describe('window check kinds', () => {
  it('are registered under new ids, compared by digest, and name no rule, vendor or verdict', () => {
    expect(windowCheckKinds.map((kind) => `${kind.id}@${kind.version}`)).toEqual(['window.values-within-limit@1']);
    for (const kind of [...windowCheckKinds, positionInAreaV2])
      expect(checkKindDigest(findCheckKind(kind.id, kind.version)!)).toBe(checkKindDigest(kind));
    const text = JSON.stringify(
      [...windowCheckKinds, positionInAreaV2].map((kind) => [kind.title, kind.description, kind.details, kind.issues]),
    );
    expect(text).not.toMatch(/\b(compliant|compliance|authori[sz]ed|no-go|go|wind|battery|flight|takeoff|dji)\b/i);
  });

  it('takes one limit and states its tolerance and coverage', () => {
    const problem = (params: Record<string, unknown>) => checkParameterProblem('window.values-within-limit', 1, params);
    expect(problem({ ...base, limitField: 'values.limit' })).toBeDefined();
    expect(problem({ ...base, coverage: undefined })).toBeDefined();
    expect(problem({ ...base, minValues: 0 })).toBeDefined();
    expect(problem({ ...base, limit: undefined, limitField: 'values.limit', limitSelect: {} })).toBeUndefined();
  });

  it('names each run outside the limit in a closed window, with its times, the worst value and the time outside', () => {
    const values = series(0, [4, 12, 13, 5, 6, 11, 14, 12, 7]);
    const result = check({}, values, [report(0, 120)]);
    expect(result).toMatchObject({
      evidenceState: 'supported',
      outcome: 'attention',
      reasonCode: 'values_outside_limit',
      issues: [`outside-from:${at(15)}`, `outside-from:${at(75)}`],
      issueTimes: [
        { issue: `outside-from:${at(15)}`, start: at(15), end: at(45) },
        { issue: `outside-from:${at(75)}`, start: at(75), end: at(120) },
      ],
      details: {
        windowStart: at(0),
        windowEnd: at(120),
        windowClosed: true,
        limit: 10,
        valuesChecked: 9,
        runCount: 2,
        secondsOutside: 75,
        firstRunStartedAt: at(15),
        worstValue: 14,
        worstValueAt: at(90),
        worstMargin: -4,
      },
    });
    expect(result.evidence).toEqual(expect.arrayContaining(['report', values[1]!.id, values[6]!.id]));
    expect(result.evidence).not.toContain(values[0]!.id);
    expect(checkSummaryWording(windowValuesWithinLimitV1, result.summary, result.details)).toBe(
      '2 run(s) of the level outside at most 10 in the window from {windowStart} to {windowEnd}, 75 s in all; the worst is 14 at {worstValueAt}.',
    );
  });

  it('gives the same answer during the window, once closed and when evaluated long after', () => {
    const values = series(0, [4, 12, 13, 5, 6, 11, 14, 12, 7]);
    // During: the window is open and covers the values so far; the second run is still going on.
    const during = check({}, values.slice(0, 8), [report(0)], 110);
    expect(during).toMatchObject({
      outcome: 'attention',
      reasonCode: 'values_outside_limit',
      details: { windowClosed: false, windowEnd: null, runCount: 2 },
      issueTimes: [
        { issue: `outside-from:${at(15)}`, start: at(15), end: at(45) },
        { issue: `outside-from:${at(75)}`, start: at(75) },
      ],
    });
    expect(during.summary).toContain('so far');
    // After, at landing and a day later, with readings after the window that do not count.
    const after = [...values, ...series(130, [30, 40])];
    const closed = check({}, after, [report(0, 120)], 125);
    const later = check({}, after, [report(0, 120)], 86_400);
    expect(closed.issues).toEqual(during.issues);
    expect(later).toEqual(closed);
    expect(closed.details).toMatchObject({ valuesChecked: 9, worstValue: 14 });
  });

  it('tolerates runs shorter than stated and waits on one still going on in an open window', () => {
    const values = series(0, [4, 12, 5, 11, 12]);
    const tolerated = check({ minValues: 2 }, values.slice(0, 3), [report(0, 30)]);
    expect(tolerated).toMatchObject({ outcome: 'pass', reasonCode: 'values_within_limit', issues: [] });
    expect(tolerated.summary).toContain('1 shorter run(s)');
    expect(check({ minSeconds: 30 }, values.slice(0, 3), [report(0, 30)])).toMatchObject({ outcome: 'pass' });
    const unconfirmed = check({ minValues: 3 }, values, [report(0)], 61);
    expect(unconfirmed).toMatchObject({
      evidenceState: 'insufficient',
      outcome: 'pending',
      reasonCode: 'outside_unconfirmed',
    });
    // The run's start is not a detail; it is the recorded time of an observation the result relied on.
    const cited = new Map([...values, report(0)].map((item) => [item.id, item.occurredAt]));
    const recorded = summaryRecordValues({
      ...(unconfirmed.details ? { details: unconfirmed.details } : {}),
      evidence: unconfirmed.evidence.map((id) => ({ occurredAt: cited.get(id)! })),
    });
    expect(checkSummaryWording(windowValuesWithinLimitV1, unconfirmed.summary, recorded)).toMatch(
      /^2 value\(s\) since \{evidence\d+OccurredAt\} are outside the level at most 10, /,
    );
    expect(check({ minValues: 2 }, values, [report(0)], 61)).toMatchObject({
      outcome: 'attention',
      issues: [`outside-from:${at(45)}`],
    });
  });

  it('is insufficient without a window, and conflicting with simultaneous windows that disagree', () => {
    expect(check({}, series(0, [4]), [])).toMatchObject({
      evidenceState: 'insufficient',
      reasonCode: 'window_missing',
    });
    expect(check({}, series(0, [4]), [report(undefined, 60)])).toMatchObject({ reasonCode: 'window_missing' });
    expect(check({}, series(0, [4]), [report(60, 30)])).toMatchObject({ reasonCode: 'window_missing' });
    expect(
      check({}, series(0, [4]), [report(0, 60, 'a'), { ...report(0, 90, 'b'), occurredAt: at(60) }]),
    ).toMatchObject({
      evidenceState: 'conflicting',
      reasonCode: 'windows_disagree',
    });
  });

  it('with no value in a closed window is insufficient when coverage is required, and does not apply otherwise', () => {
    const before = series(-60, [20]);
    expect(check({}, before, [report(0, 60)])).toMatchObject({
      evidenceState: 'insufficient',
      outcome: 'attention',
      reasonCode: 'values_missing',
    });
    expect(check({ coverage: 'optional' }, before, [report(0, 60)])).toMatchObject({
      evidenceState: 'not_applicable',
      reasonCode: 'no_values_in_window',
    });
    expect(check({}, before, [report(0)], 30)).toMatchObject({ outcome: 'pending', reasonCode: 'values_awaited' });
  });

  it('reports missing values and gaps, which make a pass insufficient when coverage is required', () => {
    const values = [...series(0, [4, 5]), reading(30, 'n/a'), reading(120, 6)];
    const result = check({ maxGapSeconds: 60 }, values, [report(0, 150)]);
    expect(result).toMatchObject({
      evidenceState: 'insufficient',
      reasonCode: 'coverage_gap',
      details: { missingValues: 1, gapCount: 1, longestGapSeconds: 105 },
    });
    expect(check({ maxGapSeconds: 60, coverage: 'optional' }, values, [report(0, 150)])).toMatchObject({
      outcome: 'pass',
    });
  });

  it('checks the value in effect at the start of an instant window', () => {
    const values = series(-45, [4, 12, 5]);
    // The latest reading at or before the instant is the one at -15 seconds, outside the limit.
    const result = check({ includeValueAtStart: true }, values.slice(0, 2), [report(0, 0)]);
    expect(result).toMatchObject({
      outcome: 'attention',
      issueTimes: [{ issue: `outside-from:${at(0)}`, start: at(0), end: at(0) }],
      details: { valuesChecked: 1, worstValue: 12 },
    });
    expect(check({ includeValueAtStart: true }, values, [report(0, 0)])).toMatchObject({ outcome: 'pass' });
  });

  it('does not read a station’s report older than the greatest age at the start, and names the station', () => {
    const fromStation = (second: number, value: number, station = 'ZZZA') => {
      const item = reading(second, value);
      (item.observation.values as Record<string, unknown>).station = station;
      return item;
    };
    const atStart = { includeValueAtStart: true, stationField: 'values.station' };
    // A station's report 100 minutes before the start is past the default of 90 minutes: it is not compared.
    const old = check(atStart, [fromStation(-6000, 12)], [report(0, 0)]);
    expect(old).toMatchObject({
      evidenceState: 'insufficient',
      outcome: 'attention',
      reasonCode: 'value_too_old',
      details: {
        valuesChecked: 0,
        maxAgeSeconds: 5400,
        tooOldAt: at(-6000),
        tooOldAgeSeconds: 6000,
        tooOldStation: 'ZZZA',
      },
    });
    expect(old.summary).toContain(
      `before the start was reported at ${at(-6000)} by station ZZZA, 1 h 40 min before it, older than the greatest age of 1 h 30 min: it is not read, and none within that age is on file.`,
    );
    expect(old.evidence).toHaveLength(2);
    // Within the age it is read, and the summary names the station.
    const recent = check(atStart, [fromStation(-3000, 12)], [report(0, 0)]);
    expect(recent).toMatchObject({
      outcome: 'attention',
      details: { valuesChecked: 1, worstValue: 12, stationNote: ' Reported by station ZZZA.', tooOldAt: null },
    });
    expect(recent.summary).toContain('Reported by station ZZZA.');
    // A value that names no station was obtained at the subject: it has no greatest age unless the rule states one.
    expect(check(atStart, [reading(-86_400, 4)], [report(0, 0)])).toMatchObject({
      outcome: 'pass',
      details: { maxAgeSeconds: null, stationNote: '' },
    });
    expect(check({ ...atStart, maxAgeSeconds: 600 }, [reading(-900, 4)], [report(0, 0)]).reasonCode).toBe(
      'value_too_old',
    );
    // The rule's own greatest age replaces the default for a station's report too.
    expect(check({ ...atStart, maxAgeSeconds: 7200 }, [fromStation(-6000, 4)], [report(0, 0)])).toMatchObject({
      outcome: 'pass',
      details: { maxAgeSeconds: 7200 },
    });
    expect(checkParameterProblem('window.values-within-limit', 1, { ...base, maxAgeSeconds: 60 })).toMatch(
      /includeValueAtStart/,
    );
  });

  it('compares with a recorded limit, and conflicts when values at one instant disagree about it', () => {
    const limit = { ...reading(-60, 0, 'made-up.limit'), observation: { values: { max: 8 } } };
    const values = series(0, [4, 9]);
    expect(
      windowValuesWithinLimitV1.evaluate(
        { ...base, limit: undefined, limitField: 'values.max' },
        { values: newestFirst(values), window: [report(0, 30)], limit: [limit] },
        clockAt(100),
      ),
    ).toMatchObject({ outcome: 'attention', details: { limit: 8, runCount: 1 } });
    const split = [...series(0, [4]), reading(15, 12), reading(15, 6)];
    expect(check({}, split, [report(0, 30)])).toMatchObject({
      evidenceState: 'conflicting',
      reasonCode: 'values_disagree',
      details: { disagreeingInstants: 1 },
    });
  });
});

// Position against an area within a window -------------------------------------------------------------------------

const geodesic = GeographicLib.Geodesic.WGS84;
const center = { latitude: 41.88, longitude: -87.63 };
function fix(second: number, meters: number): CheckObservation {
  const line = geodesic.Direct(center.latitude, center.longitude, 90, meters);
  sequence += 1;
  return {
    id: `fix-${String(sequence).padStart(4, '0')}`,
    type: 'made-up.fix',
    version: 1,
    occurredAt: at(second),
    observation: { position: { latitudeDegrees: line.lat2, longitudeDegrees: line.lon2 }, values: {} },
  };
}

const positionBase: PositionInAreaV2Params = {
  expect: 'inside',
  scope: 'any',
  centerLatitude: center.latitude,
  centerLongitude: center.longitude,
  radiusMeters: 500,
  minPositions: 2,
  windowStartField: 'values.from',
  windowEndField: 'values.to',
};

function place(positions: CheckObservation[], window: CheckObservation[], evaluatedAt = 10_000, extra = {}) {
  const params = { ...positionBase, ...extra };
  expect(checkParameterProblem(positionInAreaV2.id, 2, params)).toBeUndefined();
  return positionInAreaV2.evaluate(params, { positions: newestFirst(positions), window }, clockAt(evaluatedAt));
}

describe('position.in-area@2', () => {
  // Out before takeoff, then two excursions in flight, then out again after landing.
  const track = [
    fix(-30, 900),
    fix(-15, 900),
    fix(0, 100),
    fix(10, 800),
    fix(20, 850),
    fix(30, 100),
    fix(40, 700),
    fix(50, 750),
    fix(60, 200),
    fix(80, 900),
    fix(90, 900),
  ];

  it('places only the positions in the window and names each excursion with its times', () => {
    const result = place(track, [report(0, 70)]);
    expect(result).toMatchObject({
      outcome: 'attention',
      reasonCode: 'excursion',
      issues: [`excursion-from:${at(10)}`, `excursion-from:${at(40)}`],
      issueTimes: [
        { issue: `excursion-from:${at(10)}`, start: at(10), end: at(30) },
        { issue: `excursion-from:${at(40)}`, start: at(40), end: at(60) },
      ],
      details: { positionsChecked: 7, excursionCount: 2, secondsOutside: 40, windowClosed: true },
    });
    expect(result.evidence[0]).toBe('report');
  });

  it('gives the same issues during the flight and after it, and continues an excursion while the window is open', () => {
    const during = place(track.slice(0, 8), [report(0)], 55);
    expect(during.issues).toEqual(place(track, [report(0, 70)]).issues);
    expect(during.issueTimes![1]).toEqual({ issue: `excursion-from:${at(40)}`, start: at(40) });
    expect(during.summary).toContain('so far');
  });

  it('is insufficient without a window, and with no position in the window unless coverage is optional', () => {
    expect(place(track, [report(undefined, 70)])).toMatchObject({ reasonCode: 'window_missing', issues: [] });
    expect(place(track, [report(200, 260)])).toMatchObject({ evidenceState: 'insufficient' });
    expect(place(track, [report(200, 260)], 10_000, { coverage: 'optional' })).toMatchObject({
      evidenceState: 'not_applicable',
      reasonCode: 'no_positions_in_window',
    });
    // With optional coverage a window still open with no position yet does not apply either: nothing is awaited.
    expect(place(track, [report(200)], 230, { coverage: 'optional' })).toMatchObject({
      evidenceState: 'not_applicable',
      reasonCode: 'no_positions_in_window',
    });
  });

  it('behaves as version 1 without a window input, and names its excursions', () => {
    const result = positionInAreaV2.evaluate(
      { ...positionBase, windowStartField: undefined, windowEndField: undefined } as PositionInAreaV2Params,
      { positions: newestFirst(track.slice(2, 8)) },
      clockAt(100),
    );
    expect(result).toMatchObject({ outcome: 'attention', details: { excursionCount: 2, windowStart: null } });
  });
});
