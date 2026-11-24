import { describe, expect, it } from 'vitest';
import { checkKindDigest, checkParameterProblem, findCheckKind, type CheckObservation } from '../src/check-kinds.js';
import '../src/check-kind-library.js';
import { dueTimeOrTotalV1 } from '../src/check-kind-library-due.js';
import { recordMadeBeforeV1 } from '../src/check-kind-library-records.js';
import { eventsAnsweredWithinV1 } from '../src/check-kind-library-deadlines.js';
import { businessDaysWithinV1 } from '../src/check-kind-library-combined.js';

// Operator records of the built-in types, as the import stores them: a date alone keeps its day in values.dayOnly.

const clock = (evaluatedAt: string) => ({ mode: 'wall' as const, evaluatedAt, timeZone: 'America/Denver' });
let sequence = 0;

function record(
  recordType: string,
  body: Record<string, unknown>,
  time: { occurredAt?: string; interval?: { start: string; end?: string } },
  subjectId = 'RIDGE-AC-1',
  dayOnly?: Record<string, { day: string; timeZone: string; nextDayAt: string }>,
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
      subject: { kind: 'aircraft', id: subjectId, scope: 'source' },
      ...(time.interval ? { interval: time.interval } : {}),
      values: { recordType, recordVersion: 1, record: body, ...(dayOnly ? { dayOnly } : {}) },
    },
  };
}

const day = (date: string, start: string, next: string) => ({
  day: date,
  timeZone: 'America/Denver',
  nextDayAt: next,
  start,
});
const inspection = (
  inspectedAt: string,
  due: { nextDueAt?: string; hours?: number },
  onlyDate?: ReturnType<typeof day>,
) =>
  record(
    'aircraft.inspection',
    {
      inspectedAt,
      ...(due.nextDueAt ? { nextDueAt: due.nextDueAt } : {}),
      ...(due.hours === undefined ? {} : { nextDueTimeInServiceHours: due.hours }),
    },
    { interval: { start: inspectedAt, ...(due.nextDueAt ? { end: due.nextDueAt } : {}) } },
    'RIDGE-AC-1',
    onlyDate
      ? { inspectedAt: { day: onlyDate.day, timeZone: onlyDate.timeZone, nextDayAt: onlyDate.nextDayAt } }
      : undefined,
  );
const opening = (totalTimeHours: number, coveredThroughAt: string) =>
  record(
    'aircraft.time-in-service',
    { totalTimeHours, coveredThroughAt, coverage: 'complete' },
    { occurredAt: coveredThroughAt },
  );
const flown = (takeoffAt: string, landingAt: string) =>
  record('flight.record', { takeoffAt, landingAt }, { interval: { start: takeoffAt, end: landingAt } }, 'FLT-1');

const params = {
  dueDescribes: 'inspection',
  dueTimeField: 'values.record.nextDueAt',
  dueTotalField: 'values.record.nextDueTimeInServiceHours',
  openingField: 'values.record.totalTimeHours',
  openingAtField: 'values.record.coveredThroughAt',
  additionsStartField: 'values.takeoffAt',
  additionsEndField: 'values.landingAt',
  recordedStartField: 'values.record.takeoffAt',
  recordedEndField: 'values.record.landingAt',
  totalDescribes: 'in service',
  unit: 'h',
  recordedTimeField: 'values.record.takeoffAt',
};

describe('due.time-or-total', () => {
  it('is registered by digest and takes a due time, a due total, or both', () => {
    expect(checkKindDigest(findCheckKind('due.time-or-total', 1)!)).toBe(checkKindDigest(dueTimeOrTotalV1));
    expect(checkParameterProblem('due.time-or-total', 1, params)).toBeUndefined();
    expect(checkParameterProblem('due.time-or-total', 1, { dueDescribes: 'inspection' })).toBeDefined();
    const text = JSON.stringify([dueTimeOrTotalV1.title, dueTimeOrTotalV1.description, dueTimeOrTotalV1.details]);
    expect(text).not.toMatch(/\b(compliant|compliance|authori[sz]ed|no-go|go|airworth\w*)\b/i);
  });

  const due = inspection('2026-05-12T16:00:00Z', { hours: 315 });
  const balance = opening(300, '2026-10-01T06:00:00Z');
  const earlier = [
    flown('2026-10-10T15:00:00Z', '2026-10-10T21:00:00Z'),
    flown('2026-10-20T15:00:00Z', '2026-10-21T03:24:00Z'),
  ];
  const takeoff = flown('2026-11-04T15:00:00Z', '2026-11-04T16:00:00Z');

  it('names the hours in service at takeoff and the hours the inspection in effect was due at', () => {
    const result = dueTimeOrTotalV1.evaluate(
      params,
      {
        due: [due],
        opening: [balance],
        additions: [],
        recordedAdditions: [...earlier, takeoff],
        recordedTime: [takeoff],
      },
      clock('2026-11-23T12:00:00Z'),
    );
    expect(result).toMatchObject({
      evidenceState: 'supported',
      outcome: 'attention',
      reasonCode: 'due_passed',
      details: { basis: 'recorded', total: 318.4, dueTotal: 315, margin: -3.4, subjectId: 'RIDGE-AC-1' },
    });
    expect(result.summary).toBe(
      'RIDGE-AC-1 had 318.4 h in service at takeoff; the inspection recorded at 2026-05-12T16:00:00.000Z was due at 315 h.',
    );
  });

  it('passes within both, and reads the aircraft now when the rule names no time', () => {
    const { recordedTimeField, ...now } = params;
    void recordedTimeField;
    const within = dueTimeOrTotalV1.evaluate(
      now,
      {
        due: [inspection('2026-09-30T16:00:00Z', { hours: 400, nextDueAt: '2027-03-30T16:00:00Z' })],
        opening: [balance],
        additions: [],
        recordedAdditions: earlier,
      },
      clock('2026-11-23T12:00:00Z'),
    );
    expect(within).toMatchObject({
      outcome: 'pass',
      reasonCode: 'within_due',
      nextBoundary: '2027-03-30T16:00:00.001Z',
    });
    expect(within.summary).toBe(
      'The inspection recorded at 2026-09-30T16:00:00.000Z is next due by 2027-03-30T16:00:00.000Z, after now. RIDGE-AC-1 had 318.4 h in service now; the inspection recorded at 2026-09-30T16:00:00.000Z is next due at 400 h, 81.6 h later.',
    );
  });

  it('says a record with neither a due time nor due hours is incomplete, and when no inspection is on file', () => {
    expect(
      dueTimeOrTotalV1.evaluate(
        params,
        { due: [inspection('2026-05-12T16:00:00Z', {})], recordedTime: [takeoff] },
        clock('2026-11-23T12:00:00Z'),
      ),
    ).toMatchObject({
      evidenceState: 'insufficient',
      outcome: 'attention',
      reasonCode: 'due_not_stated',
      summary:
        'The inspection recorded at 2026-05-12T16:00:00.000Z states no next due time and no next due in service; the record is incomplete.',
    });
    expect(
      dueTimeOrTotalV1.evaluate(params, { due: [], recordedTime: [takeoff] }, clock('2026-11-23T12:00:00Z')),
    ).toMatchObject({
      reasonCode: 'due_record_missing',
    });
    expect(
      dueTimeOrTotalV1.evaluate(params, { due: [due], recordedTime: [takeoff] }, clock('2026-11-23T12:00:00Z')),
    ).toMatchObject({ evidenceState: 'insufficient', reasonCode: 'opening_balance_missing' });
  });

  it('reads an inspection placed by a date alone as made at the end of its day', () => {
    // Inspected on the day of the flight, date only: not taken as made before its takeoff.
    const sameDay = inspection(
      '2026-11-04T07:00:00Z',
      { hours: 400 },
      day('2026-11-04', '2026-11-04T07:00:00Z', '2026-11-05T07:00:00Z'),
    );
    const result = dueTimeOrTotalV1.evaluate(
      params,
      {
        due: [due, sameDay],
        opening: [balance],
        additions: [],
        recordedAdditions: [...earlier, takeoff],
        recordedTime: [takeoff],
      },
      clock('2026-11-23T12:00:00Z'),
    );
    expect(result).toMatchObject({ outcome: 'attention', details: { dueTotal: 315 } });
    const later = dueTimeOrTotalV1.evaluate(
      params,
      { due: [due, sameDay], opening: [balance], additions: [], recordedAdditions: earlier },
      clock('2026-11-23T12:00:00Z'),
    );
    expect(later.summary).toBe('No takeoff or planned start is on file, so no inspection can be placed before it.');
  });

  it('reads a next due time given as a date alone, stored as the end of its day, from the start of that day', () => {
    // The import stores a date alone in the column that ends the interval as the end of the day.
    const dueOn = record(
      'aircraft.inspection',
      { inspectedAt: '2026-09-30T16:00:00Z', nextDueAt: '2026-11-05T07:00:00Z' },
      { interval: { start: '2026-09-30T16:00:00Z', end: '2026-11-05T07:00:00Z' } },
      'RIDGE-AC-1',
      { nextDueAt: { day: '2026-11-04', timeZone: 'America/Denver', nextDayAt: '2026-11-05T07:00:00Z' } },
    );
    const result = dueTimeOrTotalV1.evaluate(
      params,
      {
        due: [dueOn],
        opening: [balance],
        additions: [],
        recordedAdditions: [...earlier, takeoff],
        recordedTime: [takeoff],
      },
      clock('2026-11-23T12:00:00Z'),
    );
    expect(result).toMatchObject({ outcome: 'attention' });
    expect(result.summary).toContain('2026-11-04 (only the date is on record; read as the start of that day)');
  });
});

describe('a time placed by a date alone, read for a deadline', () => {
  const notice = (notifiedAt: string, dayOnly?: ReturnType<typeof day>) =>
    record(
      'operation.notification',
      { notifiedAt, recipient: 'Flight Service' },
      { occurredAt: notifiedAt },
      'FLT-1',
      dayOnly
        ? { notifiedAt: { day: dayOnly.day, timeZone: dayOnly.timeZone, nextDayAt: dayOnly.nextDayAt } }
        : undefined,
    );
  const plan = record(
    'flight.plan',
    { windowStartsAt: '2026-12-01T16:00:00Z' },
    { interval: { start: '2026-12-01T16:00:00Z' } },
    'FLT-1',
  );
  const madeBefore = { startField: 'values.record.windowStartsAt', leadHours: 24 };

  it('counts a notice dated the day before a flight as made at the end of that day, and says only the date is on record', () => {
    const dated = notice('2026-11-30T07:00:00Z', day('2026-11-30', '2026-11-30T07:00:00Z', '2026-12-01T07:00:00Z'));
    const result = recordMadeBeforeV1.evaluate(
      madeBefore,
      { record: [dated], window: [plan] },
      clock('2026-11-23T12:00:00Z'),
    );
    expect(result).toMatchObject({ outcome: 'attention', reasonCode: 'made_late' });
    expect(result.summary).toBe(
      'The earliest record was made on 2026-11-30; only the date is on record, so it is read as made at the end of that day, after 2026-11-30T16:00:00.000Z, 24 h before the start at 2026-12-01T16:00:00.000Z.',
    );
    // The same notice with a time on record before the deadline is in time.
    expect(
      recordMadeBeforeV1.evaluate(
        madeBefore,
        { record: [notice('2026-11-30T15:00:00Z')], window: [plan] },
        clock('2026-11-23T12:00:00Z'),
      ),
    ).toMatchObject({ outcome: 'pass', reasonCode: 'made_in_time' });
  });

  it('counts an event’s deadline from the start of its day and an answer dated a day as made at its end', () => {
    const event = record(
      'occurrence.emergency-deviation',
      { occurredAt: '2026-10-06T06:00:00Z' },
      { occurredAt: '2026-10-06T06:00:00Z' },
      'FLT-1',
      { occurredAt: { day: '2026-10-06', timeZone: 'America/Denver', nextDayAt: '2026-10-07T06:00:00Z' } },
    );
    const result = eventsAnsweredWithinV1.evaluate(
      { answerField: 'values.record.reportedToAuthorityAt', hours: 24, answerLabel: 'report' },
      {
        events: [
          {
            ...event,
            observation: {
              ...event.observation,
              values: {
                ...(event.observation.values as object),
                record: { occurredAt: '2026-10-06T06:00:00Z', reportedToAuthorityAt: '2026-10-07T10:00:00Z' },
              },
            },
          },
        ],
      },
      clock('2026-11-23T12:00:00Z'),
    );
    expect(result).toMatchObject({ outcome: 'attention', reasonCode: 'answer_late' });
    expect(result.summary).toContain(
      'The event on 2026-10-06 (only the date is on record; its deadline is counted from the start of that day) has its report at 2026-10-07T10:00:00.000Z, later than within 24 hours, by 2026-10-07T06:00:00.000Z.',
    );
  });

  // An occurrence log writes "FAA notified 8/17/26": the report time is a date alone.
  const deviation = (reportedDay: string) =>
    record(
      'occurrence.emergency-deviation',
      { occurredAt: '2026-08-14T15:30:00Z', reportedToAuthorityAt: `${reportedDay}T06:00:00Z` },
      { occurredAt: '2026-08-14T15:30:00Z' },
      'FLT-1',
      {
        reportedToAuthorityAt: {
          day: reportedDay,
          timeZone: 'America/Denver',
          nextDayAt: new Date(Date.parse(`${reportedDay}T06:00:00Z`) + 86_400_000).toISOString(),
        },
      },
    );

  it('reads a report dated a day on the event itself as made by the end of that day', () => {
    const params = {
      answerField: 'values.record.reportedToAuthorityAt',
      hours: 120,
      answerLabel: 'report to the authority',
    };
    const inTime = eventsAnsweredWithinV1.evaluate(
      params,
      { events: [deviation('2026-08-17')] },
      clock('2026-11-23T12:00:00Z'),
    );
    expect(inTime).toMatchObject({ outcome: 'pass' });
    expect(inTime.summary).toContain(
      'has its report to the authority on 2026-08-17 (only the date is on record; read as the end of that day), within 120 hours',
    );
    // Dated the day the 120 hours run out, the end of that day is after them.
    const late = eventsAnsweredWithinV1.evaluate(
      params,
      { events: [deviation('2026-08-19')] },
      clock('2026-11-23T12:00:00Z'),
    );
    expect(late).toMatchObject({ outcome: 'attention', reasonCode: 'answer_late' });
    expect(late.summary).toContain(
      'on 2026-08-19 (only the date is on record; read as the end of that day), later than',
    );
  });

  it('reads a report dated a day as the later time of business days, and says only the date is on record', () => {
    const params = {
      toField: 'values.record.reportedToAuthorityAt',
      fromField: 'values.record.occurredAt',
      timeZone: 'America/Denver',
      days: 10,
      excludedWeekdays: [6, 7],
      excludedDates: ['2026-09-07'],
      calendarFrom: '2026-01-01',
      calendarThrough: '2026-12-31',
    };
    const result = businessDaysWithinV1.evaluate(
      params,
      { subject: [deviation('2026-08-17')] },
      clock('2026-11-23T12:00:00Z'),
    );
    expect(result).toMatchObject({ outcome: 'pass', reasonCode: 'within_business_days' });
    expect(result.summary).toBe(
      'The emergency deviation’s Reported to the authority at, on 2026-08-17 (only the date is on record; read as the end of that day), is within 10 business days after 2026-08-14 in America/Denver, through 2026-08-28.',
    );
    const late = businessDaysWithinV1.evaluate(
      params,
      { subject: [deviation('2026-09-01')] },
      clock('2026-11-23T12:00:00Z'),
    );
    expect(late).toMatchObject({ outcome: 'attention', reasonCode: 'after_business_days' });
    expect(late.summary).toBe(
      'The emergency deviation’s Reported to the authority at, on 2026-09-01 (only the date is on record; read as the end of that day), is after 10 business days after 2026-08-14 in America/Denver, through 2026-08-28.',
    );
  });
});
