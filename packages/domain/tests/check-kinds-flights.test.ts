import { describe, expect, it } from 'vitest';
import { checkParameterProblem, type CheckObservation } from '../src/check-kinds.js';
import '../src/check-kind-library.js';
import {
  intervalsAtOnceV1,
  intervalsCountedBeforeV1,
  recordBeforeFlightV1,
  timeWithinDatesV1,
} from '../src/check-kind-library-flights.js';
import { dateWithinMonthsV2, recordMadeBeforeV1 } from '../src/check-kind-library-records.js';
import { positionInAreaV2 } from '../src/check-kind-library-geometry.js';

// Questions asked as of one flight: invented operator records of the built-in types.

const clock = (evaluatedAt: string) => ({ mode: 'wall' as const, evaluatedAt, timeZone: 'America/Chicago' });
let sequence = 0;

function record(
  recordType: string,
  body: Record<string, unknown>,
  time: { occurredAt?: string; interval?: { start: string; end?: string } },
  subject: { kind: string; id: string },
): CheckObservation {
  const occurredAt = time.occurredAt ?? time.interval!.start;
  return {
    id: `${recordType}-${++sequence}`,
    type: 'operator.record',
    version: 1,
    occurredAt,
    ...(time.interval ? { interval: time.interval } : {}),
    observation: {
      type: 'operator.record',
      version: 1,
      occurredAt,
      subject: { ...subject, scope: 'source' },
      ...(time.interval ? { interval: time.interval } : {}),
      values: { recordType, recordVersion: 1, record: body },
    },
  };
}

const aircraft = { kind: 'aircraft', id: 'RIDGE-AC-1' };
const plan = (flight: string, start: string, end: string) =>
  record(
    'flight.plan',
    { windowStartsAt: start, windowEndsAt: end },
    { interval: { start, end } },
    { kind: 'flight', id: flight },
  );
const flown = (flight: string, takeoffAt: string, landingAt: string) =>
  record(
    'flight.record',
    { takeoffAt, landingAt },
    { interval: { start: takeoffAt, end: landingAt } },
    { kind: 'flight', id: flight },
  );
const check = (checkedAt: string, equipmentState: string) =>
  record('aircraft.detect-and-avoid', { checkedAt, equipmentState }, { occurredAt: checkedAt }, aircraft);
const assigned = (flight: string, startsAt: string, endsAt: string, person = 'P-07') =>
  record(
    'operation.role-assignment',
    { personId: { id: person, scope: 'source' }, role: 'pilot_in_command', startsAt, endsAt },
    { interval: { start: startsAt, end: endsAt } },
    { kind: 'flight', id: flight },
  );

const flightTime = {
  recordedStartField: 'values.record.takeoffAt',
  recordedEndField: 'values.record.landingAt',
  plannedStartField: 'values.record.windowStartsAt',
  plannedEndField: 'values.record.windowEndsAt',
};

describe('record.before-flight', () => {
  const params = {
    recordDescribes: 'detect-and-avoid check',
    field: 'values.record.equipmentState',
    expected: ['serviceable'],
    previousEndField: 'values.record.landingAt',
    previousDescribes: 'the aircraft’s previous flight',
    ...flightTime,
  };
  const now = clock('2026-11-20T00:00:00.000Z');
  const thisFlight = flown('F-2', '2026-11-12T15:00:00.000Z', '2026-11-12T15:40:00.000Z');
  const earlier = flown('F-1', '2026-11-12T13:00:00.000Z', '2026-11-12T13:30:00.000Z');

  it('reads the check made since the previous flight and before takeoff', () => {
    const result = recordBeforeFlightV1.evaluate(
      params,
      {
        recorded: [thisFlight],
        records: [check('2026-11-12T14:30:00.000Z', 'serviceable'), check('2026-11-12T12:30:00.000Z', 'serviceable')],
        previous: [thisFlight, earlier],
      },
      now,
    );
    expect(result).toMatchObject({ outcome: 'pass', reasonCode: 'value_expected' });
    expect(result.summary).toContain('of RIDGE-AC-1 made at 2026-11-12T14:30:00.000Z');
    expect(result.summary).toContain('after the aircraft’s previous flight, which ended at 2026-11-12T13:30:00.000Z');
  });

  it('says no check is on file for this flight when the latest is from before the previous flight', () => {
    const result = recordBeforeFlightV1.evaluate(
      params,
      {
        recorded: [thisFlight],
        records: [check('2026-11-12T12:30:00.000Z', 'serviceable'), check('2026-11-12T16:00:00.000Z', 'serviceable')],
        previous: [thisFlight, earlier],
      },
      now,
    );
    expect(result).toMatchObject({
      evidenceState: 'insufficient',
      outcome: 'pending',
      reasonCode: 'record_not_on_file',
    });
    expect(result.summary).toBe(
      'No detect-and-avoid check of RIDGE-AC-1 is on file between the aircraft’s previous flight, which ended at 2026-11-12T13:30:00.000Z, and takeoff at 2026-11-12T15:00:00.000Z in the operator’s flight record; the latest was made at 2026-11-12T12:30:00.000Z.',
    );
  });

  it('never reads a record made after takeoff, and with no record says none is on file', () => {
    const result = recordBeforeFlightV1.evaluate(
      params,
      { recorded: [thisFlight], records: [check('2026-11-12T16:00:00.000Z', 'serviceable')] },
      now,
    );
    expect(result).toMatchObject({ outcome: 'pending', reasonCode: 'record_not_on_file' });
  });

  it('needs attention for a value other than the expected one, and for a record older than allowed', () => {
    const inoperative = recordBeforeFlightV1.evaluate(
      params,
      { recorded: [thisFlight], records: [check('2026-11-12T14:30:00.000Z', 'inoperative')], previous: [earlier] },
      now,
    );
    expect(inoperative).toMatchObject({ outcome: 'attention', reasonCode: 'value_unexpected' });
    const inspected = record(
      'aircraft.inspection',
      { inspectedAt: '2026-09-18T15:00:00.000Z' },
      {
        interval: { start: '2026-09-18T15:00:00.000Z' },
      },
      aircraft,
    );
    const old = recordBeforeFlightV1.evaluate(
      { recordDescribes: 'inspection', maxAgeDays: 30, ...flightTime },
      { recorded: [flown('F-3', '2026-10-19T15:00:00.000Z', '2026-10-19T15:30:00.000Z')], records: [inspected] },
      now,
    );
    expect(old).toMatchObject({ evidenceState: 'supported', outcome: 'attention', reasonCode: 'record_too_old' });
    expect(old.summary).toContain('31 days before it; the rule allows at most 30 days');
    const fresh = recordBeforeFlightV1.evaluate(
      { recordDescribes: 'inspection', maxAgeDays: 30, ...flightTime },
      { recorded: [flown('F-4', '2026-10-10T15:00:00.000Z', '2026-10-10T15:30:00.000Z')], records: [inspected] },
      now,
    );
    expect(fresh).toMatchObject({ outcome: 'pass', reasonCode: 'record_in_effect' });
  });

  it('with no takeoff or plan on file, says so', () => {
    const result = recordBeforeFlightV1.evaluate(params, { records: [] }, now);
    expect(result).toMatchObject({ outcome: 'pending', reasonCode: 'record_not_on_file' });
    expect(checkParameterProblem('record.before-flight', 1, { recordDescribes: 'x' })).toBeDefined();
  });
});

describe('record.before-flight: a check made for a flight', () => {
  // A log with a tick per flight and no time: each tick is a check dated the day, named for its flight or not.
  const params = {
    recordDescribes: 'detect-and-avoid check',
    field: 'values.record.equipmentState',
    expected: ['serviceable'],
    previousEndField: 'values.record.landingAt',
    previousDescribes: 'the aircraft’s previous flight in the operator’s flight records',
    ...flightTime,
  };
  const now = clock('2026-11-20T00:00:00.000Z');
  const nextDay = (day: string) => new Date(Date.parse(`${day}T06:00:00.000Z`) + 86_400_000).toISOString();
  const tick = (day: string, flight?: string, equipmentState = 'serviceable'): CheckObservation => {
    const checked = record(
      'aircraft.detect-and-avoid',
      { checkedAt: `${day}T06:00:00Z`, equipmentState },
      {
        occurredAt: `${day}T06:00:00.000Z`,
      },
      aircraft,
    );
    const values = checked.observation.values as Record<string, unknown>;
    values.dayOnly = { checkedAt: { day, timeZone: 'America/Chicago', nextDayAt: nextDay(day) } };
    if (flight) checked.observation.secondarySubject = { kind: 'flight', id: flight, scope: 'source' };
    return checked;
  };
  // RIDGE-F-10 flies on 9 November; RIDGE-F-11 at 10:15 Chicago on 10 November; RIDGE-F-12 at 08:45 on 12 November.
  const tenth = flown('RIDGE-F-11', '2026-11-10T16:15:00.000Z', '2026-11-10T16:35:00.000Z');
  const twelfth = flown('RIDGE-F-12', '2026-11-12T14:45:00.000Z', '2026-11-12T15:20:00.000Z');
  const ninth = flown('RIDGE-F-10', '2026-11-09T16:00:00.000Z', '2026-11-09T16:30:00.000Z');
  const previous = [ninth, tenth, twelfth];

  it('never credits a check dated one day, naming no flight, to the aircraft’s flight on a later day', () => {
    const result = recordBeforeFlightV1.evaluate(
      params,
      { recorded: [twelfth], records: [tick('2026-11-10')], previous },
      now,
    );
    expect(result).toMatchObject({
      evidenceState: 'insufficient',
      outcome: 'pending',
      reasonCode: 'record_not_on_file',
    });
    expect(result.summary).toBe(
      'No detect-and-avoid check of RIDGE-AC-1 is on file for takeoff at 2026-11-12T14:45:00.000Z in the operator’s flight record; the latest, made on 2026-11-10, names no flight and gives a date only, so it counts only for flights that took off on 2026-11-10.',
    );
  });

  it('counts a check dated the day of the takeoff for the day’s first flight, and says it names no flight', () => {
    const result = recordBeforeFlightV1.evaluate(
      params,
      { recorded: [tenth], records: [tick('2026-11-10')], previous },
      now,
    );
    expect(result).toMatchObject({ outcome: 'pass', reasonCode: 'value_expected' });
    expect(result.summary).toBe(
      'The detect-and-avoid check of RIDGE-AC-1 made on 2026-11-10, which names no flight (only the date is on record, so it counts only for flights that took off that day), after the aircraft’s previous flight in the operator’s flight records, which ended at 2026-11-09T16:30:00.000Z, for takeoff at 2026-11-10T16:15:00.000Z in the operator’s flight record, records the detect-and-avoid equipment’s State as Installed and serviceable.',
    );
  });

  it('does not take a dated check naming no flight as made after a flight that ended the same day', () => {
    const later = flown('RIDGE-F-13', '2026-11-10T19:00:00.000Z', '2026-11-10T19:30:00.000Z');
    const result = recordBeforeFlightV1.evaluate(
      params,
      { recorded: [later], records: [tick('2026-11-10')], previous: [...previous, later] },
      now,
    );
    expect(result).toMatchObject({ outcome: 'pending', reasonCode: 'record_not_on_file' });
    expect(result.summary).toContain(
      'the latest was made on 2026-11-10 and names no flight. Only the date is on record, so it is not taken as made after a flight that ended that same day.',
    );
  });

  it('counts a check that names its flight for that flight only, and names it', () => {
    const ticks = [tick('2026-11-10', 'RIDGE-F-11'), tick('2026-11-10', 'RIDGE-F-13')];
    const own = recordBeforeFlightV1.evaluate(params, { recorded: [tenth], records: ticks, previous }, now);
    expect(own).toMatchObject({ outcome: 'pass', reasonCode: 'value_expected' });
    expect(own.summary).toBe(
      'The detect-and-avoid check of RIDGE-AC-1 made for this flight, RIDGE-F-11, on 2026-11-10 (only the date is on record), for takeoff at 2026-11-10T16:15:00.000Z in the operator’s flight record, records the detect-and-avoid equipment’s State as Installed and serviceable.',
    );
    // RIDGE-F-12 has no tick of its own: the checks made for other flights are never read for it.
    const none = recordBeforeFlightV1.evaluate(params, { recorded: [twelfth], records: ticks, previous }, now);
    expect(none).toMatchObject({ outcome: 'pending', reasonCode: 'record_not_on_file' });
    expect(none.summary).toBe(
      'No detect-and-avoid check of RIDGE-AC-1 is on file at or before takeoff at 2026-11-12T14:45:00.000Z in the operator’s flight record.',
    );
    // A check made for this flight wins over one naming no flight, and its own value is read.
    const named = recordBeforeFlightV1.evaluate(
      params,
      { recorded: [twelfth], records: [tick('2026-11-12'), tick('2026-11-12', 'RIDGE-F-12', 'inoperative')], previous },
      now,
    );
    expect(named).toMatchObject({ outcome: 'attention', reasonCode: 'value_unexpected' });
    expect(named.summary).toContain('made for this flight, RIDGE-F-12, on 2026-11-12');
  });

  it('still reads a check with a time as before, and an inspection dated a day for later flights', () => {
    const timed = check('2026-11-12T14:00:00.000Z', 'serviceable');
    expect(
      recordBeforeFlightV1.evaluate(params, { recorded: [twelfth], records: [timed], previous }, now),
    ).toMatchObject({ outcome: 'pass', reasonCode: 'value_expected' });
    const inspected = tick('2026-11-01');
    expect(
      recordBeforeFlightV1.evaluate(
        { recordDescribes: 'inspection', maxAgeDays: 30, ...flightTime },
        { recorded: [twelfth], records: [inspected] },
        now,
      ),
    ).toMatchObject({ outcome: 'pass', reasonCode: 'record_in_effect' });
  });
});

describe('intervals.at-once', () => {
  const params = { intervalDescribes: 'flights', holderField: 'values.record.personId.id', max: 2, ...flightTime };
  const now = clock('2026-11-20T00:00:00.000Z');
  const own = plan('F-457', '2026-11-10T16:15:00.000Z', '2026-11-10T16:43:00.000Z');
  const intervals = [
    assigned('F-455', '2026-11-10T16:00:00.000Z', '2026-11-10T16:35:00.000Z'),
    assigned('F-456', '2026-11-10T16:08:00.000Z', '2026-11-10T16:38:00.000Z'),
    assigned('F-457', '2026-11-10T16:15:00.000Z', '2026-11-10T16:43:00.000Z'),
    assigned('F-400', '2026-11-09T16:00:00.000Z', '2026-11-09T16:30:00.000Z'),
  ];

  it('names the flights held at once beyond the limit', () => {
    const result = intervalsAtOnceV1.evaluate(params, { planned: [own], intervals }, now);
    expect(result).toMatchObject({ outcome: 'attention', reasonCode: 'too_many_at_once' });
    expect(result.summary).toBe(
      'P-07 held 3 flights at once from 2026-11-10T16:15:00.000Z, during the planned window, 2026-11-10T16:15:00.000Z to 2026-11-10T16:43:00.000Z: this flight and F-455, F-456; the rule allows at most 2.',
    );
  });

  it('passes when the overlapping flights are not in the air at the same moment', () => {
    const result = intervalsAtOnceV1.evaluate(
      params,
      {
        planned: [own],
        intervals: [
          assigned('F-455', '2026-11-10T16:00:00.000Z', '2026-11-10T16:20:00.000Z'),
          assigned('F-456', '2026-11-10T16:30:00.000Z', '2026-11-10T16:50:00.000Z'),
        ],
      },
      now,
    );
    expect(result).toMatchObject({ outcome: 'pass', details: { mostAtOnce: 2 } });
  });
});

describe('intervals.counted-before', () => {
  const params = {
    intervalDescribes: 'flights as remote pilot in command',
    holderField: 'values.record.personId.id',
    days: 90,
    atLeast: 3,
    ...flightTime,
  };
  const now = clock('2026-11-20T00:00:00.000Z');
  const own = plan('F-451', '2026-11-05T16:00:00.000Z', '2026-11-05T16:30:00.000Z');

  it('counts the other flights that start in the days before the flight', () => {
    const intervals = [
      assigned('F-451', '2026-11-05T16:00:00.000Z', '2026-11-05T16:30:00.000Z'),
      assigned('F-420', '2026-10-27T16:00:00.000Z', '2026-10-27T16:30:00.000Z'),
      assigned('F-430', '2026-11-03T16:00:00.000Z', '2026-11-03T16:30:00.000Z'),
      assigned('F-100', '2026-06-01T16:00:00.000Z', '2026-06-01T16:30:00.000Z'),
      assigned('F-470', '2026-11-19T16:00:00.000Z', '2026-11-19T16:30:00.000Z'),
    ];
    const result = intervalsCountedBeforeV1.evaluate(params, { planned: [own], intervals }, now);
    expect(result).toMatchObject({ outcome: 'attention', reasonCode: 'too_few_before', details: { counted: 2 } });
    expect(result.summary).toContain(
      '2 of P-07’s other flights as remote pilot in command on file started in the 90 days before',
    );
    expect(result.summary).toContain(': F-420, F-430; the rule asks for at least 3.');
    const enough = intervalsCountedBeforeV1.evaluate(
      params,
      {
        planned: [own],
        intervals: [...intervals, assigned('F-410', '2026-10-01T16:00:00.000Z', '2026-10-01T16:20:00.000Z')],
      },
      now,
    );
    expect(enough).toMatchObject({ outcome: 'pass', details: { counted: 3 } });
  });
});

describe('time.within-dates', () => {
  const params = {
    field: 'values.record.operatingAuthorityReference',
    expected: ['107W-EX-1'],
    from: '2026-09-28',
    through: '2028-09-27',
    datesDescribe: 'the dates certificate 107W-EX-1 states it is effective',
    ...flightTime,
  };
  const now = clock('2026-11-20T00:00:00.000Z');
  const citing = (start: string) =>
    record(
      'flight.plan',
      { windowStartsAt: start, operatingAuthorityReference: '107W-EX-1' },
      { interval: { start } },
      { kind: 'flight', id: 'F-404' },
    );

  it('needs attention for a flight citing the certificate before its dates, on the local date', () => {
    const subject = citing('2026-09-25T15:00:00.000Z');
    const result = timeWithinDatesV1.evaluate(params, { subject: [subject], planned: [subject] }, now);
    expect(result).toMatchObject({
      outcome: 'attention',
      reasonCode: 'before_dates',
      details: { flightDay: '2026-09-25' },
    });
    expect(result.summary).toContain(
      'before the dates certificate 107W-EX-1 states it is effective, from 2026-09-28 through 2028-09-27.',
    );
    const within = citing('2026-09-28T05:30:00.000Z');
    expect(timeWithinDatesV1.evaluate(params, { subject: [within], planned: [within] }, now)).toMatchObject({
      outcome: 'pass',
      details: { flightDay: '2026-09-28' },
    });
    // 03:30 UTC is still 27 September in Chicago.
    const lateEvening = citing('2026-09-28T03:30:00.000Z');
    expect(timeWithinDatesV1.evaluate(params, { subject: [lateEvening], planned: [lateEvening] }, now)).toMatchObject({
      outcome: 'attention',
    });
  });
});

describe('changed kinds', () => {
  it('record.made-before counts a record made too early as early', () => {
    const window = plan('F-1', '2026-11-10T16:00:00.000Z', '2026-11-10T17:00:00.000Z');
    const notice = (notifiedAt: string) =>
      record('operation.notification', { notifiedAt }, { occurredAt: notifiedAt }, { kind: 'flight', id: 'F-1' });
    const params = { startField: 'values.record.windowStartsAt', leadHours: 0, maxLeadHours: 72 };
    const now = clock('2026-11-20T00:00:00.000Z');
    expect(
      recordMadeBeforeV1.evaluate(params, { window: [window], record: [notice('2026-11-06T16:00:00.000Z')] }, now),
    ).toMatchObject({ outcome: 'attention', reasonCode: 'made_early' });
    expect(
      recordMadeBeforeV1.evaluate(params, { window: [window], record: [notice('2026-11-08T16:00:00.000Z')] }, now),
    ).toMatchObject({ outcome: 'pass', reasonCode: 'made_in_time' });
  });

  it('date.within-months names two records that disagree and says what to correct', () => {
    const training = (completedOn: string, courseTitle: string) =>
      record(
        'person.training',
        { completedOn, courseTitle },
        { occurredAt: '2026-11-01T00:00:00.000Z' },
        {
          kind: 'person',
          id: 'P-07',
        },
      );
    const result = dateWithinMonthsV2.evaluate(
      { field: 'values.record.completedOn', months: 24, nameField: 'values.record.courseTitle' },
      { subject: [training('2025-09-10', 'Recurrent A'), training('2026-03-02', 'Recurrent A')] },
      clock('2026-11-20T00:00:00.000Z'),
    );
    expect(result).toMatchObject({ evidenceState: 'conflicting', reasonCode: 'dates_disagree' });
    expect(result.summary).toContain('2025-09-10 (Recurrent A), 2026-03-02 (Recurrent A)');
    expect(result.summary).toContain('Correct the date that is wrong, or record the older one as replaced');
  });

  it('date.within-months reads three different courses imported together as three courses, not one value', () => {
    const training = (completedOn: string, courseTitle: string, evidenceReference = `TRN-${completedOn}`) =>
      record(
        'person.training',
        { completedOn, courseTitle, evidenceReference },
        { occurredAt: '2026-11-22T18:00:00.000Z' },
        { kind: 'person', id: 'A. Example' },
      );
    const courses = [
      training('2025-03-12', 'BVLOS initial'),
      training('2025-11-04', 'Part 107 recurrent'),
      training('2026-07-22', 'BVLOS recurrent'),
    ];
    const params = {
      field: 'values.record.completedOn',
      months: 24,
      nameField: 'values.record.courseTitle',
      sameWhen: ['values.record.courseTitle', 'values.record.evidenceReference'],
    };
    const result = dateWithinMonthsV2.evaluate(params, { subject: courses }, clock('2026-11-23T00:00:00.000Z'));
    expect(result).toMatchObject({ evidenceState: 'supported', outcome: 'pass', reasonCode: 'date_within_months' });
    expect(result.summary).toBe(
      'The training’s Completed on, 2026-07-22 (BVLOS recurrent), is within the previous 24 calendar months, through 2028-07-31.',
    );
    expect(result.evidence).toEqual([courses[2]!.id]);
    // One course completed twice, with its own evidence each time, is two completions: the later is read.
    const again = dateWithinMonthsV2.evaluate(
      params,
      { subject: [...courses, training('2024-07-10', 'BVLOS recurrent')] },
      clock('2026-11-23T00:00:00.000Z'),
    );
    expect(again).toMatchObject({ outcome: 'pass', reasonCode: 'date_within_months' });
    // The same completion entered twice with two dates is a conflict, and only those two are named.
    const twice = dateWithinMonthsV2.evaluate(
      params,
      { subject: [...courses, training('2026-07-29', 'BVLOS recurrent', 'TRN-2026-07-22')] },
      clock('2026-11-23T00:00:00.000Z'),
    );
    expect(twice).toMatchObject({ evidenceState: 'conflicting', reasonCode: 'dates_disagree' });
    expect(twice.summary).toBe(
      '2 records made at the same time give different dates for the training’s Completed on: 2026-07-22 (BVLOS recurrent), 2026-07-29 (BVLOS recurrent). Correct the date that is wrong, or record the older one as replaced by the newer, so one date stands.',
    );
  });

  it('position.in-area version 2 places positions against several listed areas', () => {
    const fix = (latitude: number, longitude: number, at: string): CheckObservation => ({
      id: `fix-${++sequence}`,
      type: 'position.fix',
      version: 1,
      occurredAt: at,
      observation: { position: { latitudeDegrees: latitude, longitudeDegrees: longitude }, values: { fix: 'gnss' } },
    });
    const areas = [
      { id: 'SITE-A', center: { latitude: 41.88, longitude: -87.63 }, radiusMeters: 500 },
      {
        id: 'LINE-B',
        points: [
          { latitude: 41.9, longitude: -87.7 },
          { latitude: 41.92, longitude: -87.7 },
        ],
        halfWidthMeters: 100,
      },
    ];
    const params = { expect: 'inside' as const, scope: 'any' as const, minPositions: 1, areas };
    expect(checkParameterProblem('position.in-area', 2, params)).toBeUndefined();
    const inside = positionInAreaV2.evaluate(
      params,
      { positions: [fix(41.91, -87.7, '2026-11-10T16:01:00.000Z'), fix(41.8801, -87.63, '2026-11-10T16:00:00.000Z')] },
      clock('2026-11-20T00:00:00.000Z'),
    );
    expect(inside).toMatchObject({ outcome: 'pass', details: { areaShape: 'listed_areas' } });
    const outside = positionInAreaV2.evaluate(
      params,
      { positions: [fix(41.95, -87.7, '2026-11-10T16:02:00.000Z')] },
      clock('2026-11-20T00:00:00.000Z'),
    );
    expect(outside).toMatchObject({ outcome: 'attention', reasonCode: 'excursion' });
    expect(outside.summary).toContain('any of the areas the rule lists (LINE-B, SITE-A)');
  });
});
