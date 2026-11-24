import { describe, expect, it } from 'vitest';
import { checkKindDigest, checkParameterProblem, findCheckKind, type CheckObservation } from '../src/check-kinds.js';
import '../src/check-kind-library.js';
import {
  deadlineCheckKinds,
  eventsAnsweredWithinV1,
  periodsEachRecordedV1,
  type EventsAnsweredWithinParams,
  type PeriodsEachRecordedParams,
} from '../src/check-kind-library-deadlines.js';

// Minimal made-up observations. Record types and field names are invented; the kinds know none of them.

const adoption = { start: '2026-01-01T00:00:00.000Z', end: '2028-01-01T00:00:00.000Z' };
const clock = (evaluatedAt: string, dates: { start: string; end: string } | undefined = adoption) => ({
  mode: 'wall' as const,
  evaluatedAt,
  ...(dates ? { adoption: dates } : {}),
});

function observation(id: string, occurredAt: string, values: Record<string, unknown> = {}): CheckObservation {
  return { id, type: 'made-up.event', version: 1, occurredAt, observation: { occurredAt, values } };
}

const HOUR = 3_600_000;
const plus = (time: string, millis: number) => new Date(Date.parse(time) + millis).toISOString();

describe('deadline check kinds', () => {
  it('are registered under new ids, compared by digest, and read the adoption dates', () => {
    expect(deadlineCheckKinds.map((kind) => `${kind.id}@${kind.version}`)).toEqual([
      'events.answered-within@1',
      'periods.each-recorded@1',
    ]);
    for (const kind of deadlineCheckKinds) {
      expect(checkKindDigest(findCheckKind(kind.id, kind.version)!)).toBe(checkKindDigest(kind));
      expect(kind.adoptionDates).toBeTruthy();
    }
  });

  it('name no regulation and use no verdict wording', () => {
    const text = JSON.stringify(deadlineCheckKinds.map((kind) => [kind.title, kind.description, kind.details]));
    expect(text).not.toMatch(/\b(compliant|compliance|authori[sz]ed|no-go|go|part \d|section|§|nprm|report)\b/i);
  });
});

describe('events.answered-within', () => {
  const run = (params: EventsAnsweredWithinParams, inputs: Record<string, CheckObservation[]>, at: string) => {
    expect(checkParameterProblem('events.answered-within', 1, params)).toBeUndefined();
    return eventsAnsweredWithinV1.evaluate(params, inputs, clock(at));
  };

  it('validates its parameters: exactly one deadline, and one kind of answer', () => {
    const problem = (params: unknown) => checkParameterProblem('events.answered-within', 1, params);
    expect(problem({ hours: 96, answerField: 'values.answeredAt' })).toBeUndefined();
    expect(problem({ answerField: 'values.answeredAt' })).toBeDefined();
    expect(problem({ hours: 96, days: 7, timeZone: 'UTC' })).toBeDefined();
    expect(problem({ days: 7 })).toBeDefined();
    expect(problem({ hours: 96, answerField: 'values.a', answerSelect: { where: [] } })).toBeDefined();
    expect(problem({ followingMonthDay: 29, timeZone: 'UTC' })).toBeDefined();
    expect(problem({ days: 10, timeZone: 'UTC', excludedDates: ['2026-11-11'] })).toBeDefined();
    expect(
      problem({ hours: 2, answerCoversFromField: 'values.from', answerCoversThroughField: 'values.to' }),
    ).toBeDefined();
  });

  describe('an event the operator recorded as needing no answer', () => {
    const notDue = {
      anyOf: [{ field: 'values.notDue', oneOf: [true], byField: 'values.decidedBy' }],
      words: 'needing no notice',
    };
    const params = { hours: 96, answerField: 'values.answeredAt', answerLabel: 'notice', notDue };
    const at = '2026-11-02T10:00:00.000Z';
    const later = '2026-11-03T10:00:00.000Z';

    it('is not counted, and the result says so and who decided', () => {
      const marked = observation('e', at, { notDue: true, decidedBy: { id: 'RIDGE-P-2', scope: 'source' } });
      const alone = run(params, { events: [marked] }, '2026-11-20T00:00:00.000Z');
      const sentence = `The event at ${at} is recorded as needing no notice by RIDGE-P-2, so it is not counted.`;
      expect(alone).toMatchObject({
        outcome: 'not_applicable',
        reasonCode: 'events_not_due',
        summary: sentence,
        notCounted: sentence,
        evidence: ['e'],
        details: { eventCount: 0, notDueCount: 1 },
      });
      const unmarked = observation('f', later);
      const both = run(params, { events: [marked, unmarked] }, '2026-11-20T00:00:00.000Z');
      expect(both).toMatchObject({
        outcome: 'attention',
        reasonCode: 'answer_overdue',
        notCounted: sentence,
        details: { eventCount: 1, notDueCount: 1 },
      });
      expect(both.summary).not.toContain(at);
      expect(both.issues).toEqual([`event-at:${later}`]);
    });

    it('says when the record does not name who decided', () => {
      const unnamed = run(params, { events: [observation('e', at, { notDue: true })] }, '2026-11-20T00:00:00.000Z');
      expect(unnamed.summary).toBe(
        `The event at ${at} is recorded as needing no notice; the record does not say who decided, so it is not counted.`,
      );
    });
  });

  describe('hours after the event, answered on the event itself', () => {
    const params = { hours: 96, answerField: 'values.answeredAt', answerLabel: 'notice' };
    const at = '2026-11-02T10:00:00.000Z';
    const event = (answeredAt?: string) => observation('e', at, answeredAt ? { answeredAt } : {});

    it('accepts an answer at the last instant and refuses one a millisecond later', () => {
      const passed = run(params, { events: [event(plus(at, 96 * HOUR))] }, '2026-11-20T00:00:00.000Z');
      expect(passed).toMatchObject({ evidenceState: 'supported', outcome: 'pass', reasonCode: 'answered_within' });
      expect(passed.summary).toMatch(/has its notice at 2026-11-06T10:00:00.000Z, within 96 hours/);
      const late = run(params, { events: [event(plus(at, 96 * HOUR + 1))] }, '2026-11-20T00:00:00.000Z');
      expect(late).toMatchObject({ evidenceState: 'supported', outcome: 'attention', reasonCode: 'answer_late' });
      expect(late.issues).toEqual([`event-at:${at}`]);
    });

    it('awaits an answer until its deadline, then needs attention', () => {
      const awaited = run(params, { events: [event()] }, plus(at, 96 * HOUR));
      expect(awaited).toMatchObject({ outcome: 'pending', reasonCode: 'answer_awaited' });
      expect(awaited.nextBoundary).toBe(plus(at, 96 * HOUR + 1));
      expect(awaited.details).toMatchObject({ awaitingCount: 1, nextDueBy: plus(at, 96 * HOUR) });
      const overdue = run(params, { events: [event()] }, plus(at, 96 * HOUR + 1));
      expect(overdue).toMatchObject({
        evidenceState: 'insufficient',
        outcome: 'attention',
        reasonCode: 'answer_overdue',
      });
    });

    it('conflicts when the answer is before the event, and does not apply without one', () => {
      expect(run(params, { events: [event(plus(at, -1))] }, at)).toMatchObject({
        evidenceState: 'conflicting',
        reasonCode: 'answer_before_event',
      });
      expect(run(params, { events: [] }, at)).toMatchObject({ outcome: 'not_applicable', reasonCode: 'no_events' });
      expect(run({ ...params, whenNone: 'insufficient' }, { events: [] }, at)).toMatchObject({
        outcome: 'pending',
        reasonCode: 'events_missing',
      });
    });

    it('names each event without its answer, and counts only events inside the adoption dates', () => {
      const answered = observation('a', '2026-03-01T00:00:00.000Z', { answeredAt: '2026-03-02T00:00:00.000Z' });
      const missing = observation('b', '2026-04-01T00:00:00.000Z');
      const before = observation('c', '2025-12-31T23:59:59.999Z');
      const outcome = run(params, { events: [missing, answered, before] }, '2026-06-01T00:00:00.000Z');
      expect(outcome).toMatchObject({ outcome: 'attention', reasonCode: 'answer_overdue' });
      expect(outcome.issues).toEqual(['event-at:2026-04-01T00:00:00.000Z']);
      expect(outcome.details).toMatchObject({
        eventCount: 2,
        answeredCount: 1,
        overdueCount: 1,
        outsideAdoptionCount: 1,
      });
      expect(run(params, { events: [before] }, '2026-06-01T00:00:00.000Z')).toMatchObject({
        outcome: 'not_applicable',
        details: { outsideAdoptionCount: 1 },
      });
    });
  });

  describe('days after the event’s local date', () => {
    const params = { days: 7, timeZone: 'America/Denver', answerField: 'values.answeredAt' };
    // 16:30 on Thursday 2026-11-05 in Denver; the seventh day after is Thursday 11-12, which ends at 07:00 UTC on 11-13.
    const at = '2026-11-05T23:30:00.000Z';
    const event = (answeredAt?: string) => observation('e', at, answeredAt ? { answeredAt } : {});

    it('counts calendar days in the zone, the event’s own day not counted', () => {
      const passed = run(params, { events: [event('2026-11-13T06:59:59.999Z')] }, '2026-12-01T00:00:00.000Z');
      expect(passed).toMatchObject({ outcome: 'pass' });
      expect(passed.summary).toMatch(/within 7 days after 2026-11-05 in America\/Denver, through 2026-11-12/);
      expect(run(params, { events: [event('2026-11-13T07:00:00.000Z')] }, '2026-12-01T00:00:00.000Z')).toMatchObject({
        outcome: 'attention',
        reasonCode: 'answer_late',
      });
      const awaited = run(params, { events: [event()] }, '2026-11-13T06:59:59.999Z');
      expect(awaited).toMatchObject({ reasonCode: 'answer_awaited', nextBoundary: '2026-11-13T07:00:00.000Z' });
      expect(awaited.details).toMatchObject({ nextDueThrough: '2026-11-12' });
    });

    it('skips excluded weekdays and dates, and never counts past the stated calendar', () => {
      const business = {
        ...params,
        days: 10,
        excludedWeekdays: [6, 7],
        excludedDates: ['2026-11-11'],
        calendarFrom: '2026-01-01',
        calendarThrough: '2026-12-31',
      };
      expect(run(business, { events: [event()] }, '2026-11-06T00:00:00.000Z').details).toMatchObject({
        nextDueThrough: '2026-11-20',
      });
      const december = observation('d', '2026-12-28T18:00:00.000Z');
      expect(run(business, { events: [december] }, '2026-12-29T00:00:00.000Z')).toMatchObject({
        evidenceState: 'insufficient',
        reasonCode: 'calendar_not_covered',
      });
    });

    it('refuses a zone the platform does not know', () => {
      expect(run({ ...params, timeZone: 'Mars/Olympus' }, { events: [event()] }, at)).toMatchObject({
        reasonCode: 'time_zone_unknown',
      });
    });
  });

  describe('a given day of the following month, answered by a record that covers the event', () => {
    const params = {
      followingMonthDay: 10,
      timeZone: 'UTC',
      answerAtField: 'values.madeAt',
      answerCoversFromField: 'values.from',
      answerCoversThroughField: 'values.through',
    };
    const event = observation('e', '2026-10-31T23:00:00.000Z');
    const answer = (madeAt: string, from = '2026-10-01', through = '2026-10-31') =>
      observation(`a-${madeAt}-${from}`, madeAt, { madeAt, from, through });

    it('is due by the end of that day, and only an answer covering the event’s date counts', () => {
      const passed = run(
        params,
        { events: [event], answers: [answer('2026-11-10T23:59:59.999Z')] },
        '2026-12-01T00:00:00.000Z',
      );
      expect(passed).toMatchObject({ outcome: 'pass' });
      expect(passed.evidence).toEqual(['e', 'a-2026-11-10T23:59:59.999Z-2026-10-01']);
      expect(passed.summary).toMatch(/by the end of 2026-11-10 in UTC, day 10 of the month after 2026-10/);
      expect(
        run(params, { events: [event], answers: [answer('2026-11-11T00:00:00.000Z')] }, '2026-12-01T00:00:00.000Z'),
      ).toMatchObject({ outcome: 'attention', reasonCode: 'answer_late' });
      const other = run(
        params,
        { events: [event], answers: [answer('2026-11-05T00:00:00.000Z', '2026-09-01', '2026-09-30')] },
        '2026-11-11T00:00:00.000Z',
      );
      expect(other).toMatchObject({ outcome: 'attention', reasonCode: 'answer_overdue' });
      // An answer made before the event does not answer it.
      expect(
        run(params, { events: [event], answers: [answer('2026-10-31T22:00:00.000Z')] }, '2026-11-10T00:00:00.000Z'),
      ).toMatchObject({ outcome: 'pending', reasonCode: 'answer_awaited', nextBoundary: '2026-11-11T00:00:00.000Z' });
    });
  });
});

describe('periods.each-recorded', () => {
  const run = (params: PeriodsEachRecordedParams, records: CheckObservation[], at: string, dates = adoption) => {
    expect(checkParameterProblem('periods.each-recorded', 1, params)).toBeUndefined();
    return periodsEachRecordedV1.evaluate(params, { records }, clock(at, dates));
  };
  const made = (at: string) => observation(`r-${at}`, at);

  describe('fixed calendar months', () => {
    const monthly = { timeZone: 'America/Denver', months: 1, periods: 'fixed' as const };
    // Denver midnight on 1 August 2026 is 06:00 UTC.
    const dates = { start: '2026-08-01T06:00:00.000Z', end: '2027-08-01T06:00:00.000Z' };

    it('names each ended month without a record, and waits for the open one', () => {
      const outcome = run(
        monthly,
        [made('2026-08-20T12:00:00.000Z'), made('2026-10-02T12:00:00.000Z')],
        '2026-11-15T00:00:00.000Z',
        dates,
      );
      expect(outcome).toMatchObject({
        evidenceState: 'supported',
        outcome: 'attention',
        reasonCode: 'periods_missing',
      });
      expect(outcome.issues).toEqual(['period:2026-09-01']);
      expect(outcome.details).toMatchObject({
        periodsEnded: 3,
        periodsMissing: 1,
        missingPeriods: '2026-09-01 to 2026-09-30',
        currentPeriodThrough: '2026-11-30',
        currentPeriodRecorded: false,
      });
      // Denver midnight on 1 December, after the change back to standard time, is 07:00 UTC.
      expect(outcome.nextBoundary).toBe('2026-12-01T07:00:00.000Z');
    });

    it('places a record at the last instant of a month in that month, and one a millisecond later in the next', () => {
      const august = made('2026-08-10T00:00:00.000Z');
      const lastOfSeptember = made('2026-10-01T05:59:59.999Z');
      expect(run(monthly, [august, lastOfSeptember], '2026-10-01T06:00:00.000Z', dates)).toMatchObject({
        outcome: 'pass',
        reasonCode: 'periods_recorded',
        details: { periodsEnded: 2, currentPeriodThrough: '2026-10-31' },
      });
      const firstOfOctober = made('2026-10-01T06:00:00.000Z');
      const missed = run(monthly, [august, firstOfOctober], '2026-10-01T06:00:00.000Z', dates);
      expect(missed.issues).toEqual(['period:2026-09-01']);
      // One instant before September ends it is still open.
      expect(run(monthly, [august], '2026-10-01T05:59:59.999Z', dates)).toMatchObject({
        outcome: 'pass',
        nextBoundary: '2026-10-01T06:00:00.000Z',
      });
    });

    it('counts only months wholly inside the adoption dates', () => {
      const midMonth = { start: '2026-08-15T06:00:00.000Z', end: '2026-12-15T07:00:00.000Z' };
      const outcome = run(monthly, [made('2026-10-05T00:00:00.000Z')], '2027-01-20T00:00:00.000Z', midMonth);
      expect(outcome.issues).toEqual(['period:2026-09-01', 'period:2026-11-01']);
      expect(outcome.details).toMatchObject({ periodsEnded: 3 });
    });

    it('is awaited until the first month ends, and insufficient without adoption dates', () => {
      expect(run(monthly, [], '2026-08-10T00:00:00.000Z', dates)).toMatchObject({
        outcome: 'pending',
        reasonCode: 'period_open',
        nextBoundary: '2026-09-01T06:00:00.000Z',
      });
      expect(
        periodsEachRecordedV1.evaluate(
          monthly,
          { records: [] },
          { mode: 'wall', evaluatedAt: '2026-08-10T00:00:00.000Z' },
        ),
      ).toMatchObject({
        evidenceState: 'insufficient',
        reasonCode: 'adoption_dates_missing',
      });
    });
  });

  describe('rolling periods of twelve months', () => {
    const yearly = { timeZone: 'UTC', months: 12, periods: 'rolling' as const };
    const dates = { start: '2026-03-15T00:00:00.000Z', end: '2029-01-01T00:00:00.000Z' };

    it('is first due twelve months from the adoption, counting its month, then twelve after each record', () => {
      expect(run(yearly, [], '2027-02-28T23:59:59.999Z', dates)).toMatchObject({
        outcome: 'pending',
        reasonCode: 'period_open',
        nextBoundary: '2027-03-01T00:00:00.000Z',
      });
      expect(run(yearly, [], '2027-03-01T00:00:00.000Z', dates).issues).toEqual(['period:2026-03-15']);
      const june = made('2026-06-10T00:00:00.000Z');
      const held = run(yearly, [june], '2027-06-30T23:59:59.999Z', dates);
      expect(held).toMatchObject({ outcome: 'pass', nextBoundary: '2027-07-01T00:00:00.000Z' });
      expect(held.details).toMatchObject({ currentPeriodThrough: '2027-06-30' });
      const missed = run(yearly, [june], '2027-07-01T00:00:00.000Z', dates);
      expect(missed.details).toMatchObject({ missingPeriods: '2026-06-10 to 2027-06-30' });
    });

    it('counts a record in a period that runs past a short adoption', () => {
      const short = { start: '2026-03-15T00:00:00.000Z', end: '2026-04-15T00:00:00.000Z' };
      expect(run(yearly, [made('2026-03-20T00:00:00.000Z')], '2026-03-21T00:00:00.000Z', short)).toMatchObject({
        outcome: 'pass',
        details: { periodsEnded: 1 },
      });
      expect(run(yearly, [], '2026-03-21T00:00:00.000Z', short)).toMatchObject({ reasonCode: 'period_open' });
    });

    it('counts from a record made before the adoption', () => {
      const before = made('2025-11-20T00:00:00.000Z');
      const held = run(yearly, [before], '2026-11-30T23:59:59.999Z', dates);
      expect(held).toMatchObject({ outcome: 'pass', evidence: [before.id], nextBoundary: '2026-12-01T00:00:00.000Z' });
      expect(held.summary).toMatch(/makes the next due through 2026-11-30/);
      expect(run(yearly, [before], '2026-12-01T00:00:00.000Z', dates).issues).toEqual(['period:2026-03-15']);
      // One whose next was already due before the adoption leaves only the adoption's first month.
      expect(run(yearly, [made('2024-01-10T00:00:00.000Z')], '2026-04-01T00:00:00.000Z', dates).details).toMatchObject({
        missingPeriods: '2026-03-15 to 2026-03-31',
      });
    });
  });
});
