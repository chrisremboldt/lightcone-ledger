import type { CheckDetails } from '@ledger/contracts';
import {
  addDays,
  calendarDateSchema,
  dayStart,
  iso,
  isoWeekday,
  localDate,
  result,
  timeZoneSchema,
  validCalendarDate,
  zoneCalendar,
  zoneMissing,
} from './check-kind-library-combined.js';
import { current, fieldPath, selectionSchema, type Selection } from './check-kind-library-records.js';
import {
  observationField,
  registerCheckKind,
  spanStart,
  utcMillis,
  type CheckClock,
  type CheckKind,
  type CheckObservation,
  type CheckResult,
} from './check-kinds.js';
import { notDueSchema, notDueSentence, type NotDue } from './check-kind-not-due.js';
import { placedTime } from './day-precision.js';

// Check kinds over deadlines: each recorded event answered within a period after it, and a record made in each period
// of calendar months. Each kind, its parameters and inputs are listed in docs/design/record-check-kinds.md.

const HOUR = 3_600_000;
const SHOWN = 10;

function recordTime(observation: CheckObservation, field: string | undefined): number | undefined {
  return field === undefined ? utcMillis(spanStart(observation)) : utcMillis(observationField(observation, field));
}

function adoptionWindow(clock: CheckClock): { start: number; end: number } | undefined {
  const start = utcMillis(clock.adoption?.start);
  const end = utcMillis(clock.adoption?.end);
  return start === undefined || end === undefined || end <= start ? undefined : { start, end };
}

/** At most SHOWN items, then how many more. */
function listedSentences(items: readonly string[]): string {
  const shown = items.slice(0, SHOWN).join(' ');
  return items.length > SHOWN ? `${shown} And ${items.length - SHOWN} more.` : shown;
}

// Local calendar months -------------------------------------------------------------------------------------------

/** Months counted from year 0: a local date's month as one number. */
function monthIndex(date: string): number {
  return Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
}

function firstDayOf(month: number): string {
  return `${String(Math.floor(month / 12)).padStart(4, '0')}-${String((month % 12) + 1).padStart(2, '0')}-01`;
}

function lastDayOf(month: number): string {
  return addDays(firstDayOf(month + 1), -1);
}

// Each event answered within a period after it ------------------------------------------------------------------

export interface EventsAnsweredWithinParams {
  select?: Selection;
  atField?: string;
  answerField?: string;
  answerSelect?: Selection;
  answerAtField?: string;
  answerCoversFromField?: string;
  answerCoversThroughField?: string;
  answerLabel?: string;
  timeZone?: string;
  hours?: number;
  days?: number;
  excludedWeekdays?: number[];
  excludedDates?: string[];
  calendarFrom?: string;
  calendarThrough?: string;
  followingMonthDay?: number;
  whenNone?: 'not_applicable' | 'insufficient';
  notDue?: NotDue;
}

type EventState = 'answered' | 'late' | 'overdue' | 'awaiting' | 'not_counted';

interface EventAnswer {
  event: CheckObservation;
  at: number;
  /** The event's day, when only a date is on record for it. */
  day?: string;
  /** The answer's day, when only a date is on record for it. */
  answeredDay?: string;
  state: EventState;
  answer?: CheckObservation;
  answeredAt?: number;
  /** The last instant an answer is in time. */
  lastAllowed?: number;
  dueThrough?: string;
  allowed: string;
}

/** The last local date allowed after the event's local date, or undefined past the stated calendar. */
function lastCountedDay(params: EventsAnsweredWithinParams, startDate: string): string | undefined {
  const excluded = new Set(params.excludedDates ?? []);
  const weekdays = params.excludedWeekdays ?? [];
  let date = startDate;
  let counted = 0;
  while (counted < params.days!) {
    date = addDays(date, 1);
    if (excluded.size && (date < params.calendarFrom! || date > params.calendarThrough!)) return undefined;
    if (!weekdays.includes(isoWeekday(date)) && !excluded.has(date)) counted += 1;
  }
  return date;
}

/** When the answer to an event at `at` is due, and the words for it; undefined when it cannot be counted. */
function deadlineOf(
  params: EventsAnsweredWithinParams,
  calendar: Intl.DateTimeFormat | undefined,
  at: number,
): { lastAllowed: number; dueThrough?: string; allowed: string } | undefined {
  if (params.hours !== undefined) {
    const lastAllowed = at + params.hours * HOUR;
    return { lastAllowed, allowed: `within ${params.hours} hours, by ${iso(lastAllowed)}` };
  }
  const startDay = localDate(calendar!, at);
  if (params.days !== undefined) {
    const through = lastCountedDay(params, startDay);
    if (through === undefined) return undefined;
    const skipped =
      params.excludedWeekdays?.length || params.excludedDates?.length ? ' not counting excluded days' : '';
    return {
      lastAllowed: dayStart(calendar!, addDays(through, 1)) - 1,
      dueThrough: through,
      allowed: `within ${params.days} days after ${startDay}${skipped} in ${params.timeZone}, through ${through}`,
    };
  }
  const month = monthIndex(startDay);
  const through = `${firstDayOf(month + 1).slice(0, 8)}${String(params.followingMonthDay).padStart(2, '0')}`;
  return {
    lastAllowed: dayStart(calendar!, addDays(through, 1)) - 1,
    dueThrough: through,
    allowed: `by the end of ${through} in ${params.timeZone}, day ${params.followingMonthDay} of the month after ${firstDayOf(month).slice(0, 7)}`,
  };
}

function coversDate(answer: CheckObservation, params: EventsAnsweredWithinParams, date: string | undefined): boolean {
  if (params.answerCoversFromField === undefined) return true;
  const from = observationField(answer, params.answerCoversFromField);
  const through = observationField(answer, params.answerCoversThroughField!);
  return (
    date !== undefined &&
    typeof from === 'string' &&
    typeof through === 'string' &&
    validCalendarDate(from) &&
    validCalendarDate(through) &&
    from <= date &&
    date <= through
  );
}

/** The answer recorded as a time on the event itself; a date alone there is read as the end of that day. */
function answerOnEvent(event: CheckObservation, field: string): { at: number | undefined; day: string | undefined } {
  const time = placedTime(event, field, 'latest');
  return { at: time?.at, day: time?.day };
}

function eventWords(at: number, day: string | undefined): string {
  return day === undefined
    ? `The event at ${iso(at)}`
    : `The event on ${day} (only the date is on record; its deadline is counted from the start of that day)`;
}

function eventSentence(item: EventAnswer, label: string): string {
  const event = eventWords(item.at, item.day);
  const answered =
    item.answeredDay === undefined
      ? `at ${iso(item.answeredAt)}`
      : `on ${item.answeredDay} (only the date is on record; read as the end of that day)`;
  switch (item.state) {
    case 'answered':
      return `${event} has its ${label} ${answered}, ${item.allowed}.`;
    case 'late':
      return `${event} has its ${label} ${answered}, later than ${item.allowed}.`;
    case 'overdue':
      return `${event} has no ${label} recorded ${item.allowed}.`;
    case 'awaiting':
      return `${event} has no ${label} recorded yet; it is due ${item.allowed}.`;
    case 'not_counted':
      return `${event}: ${item.allowed}.`;
  }
}

export const eventsAnsweredWithinV1: CheckKind<EventsAnsweredWithinParams> = {
  id: 'events.answered-within',
  version: 1,
  title: 'Each recorded event answered within a period after it',
  description:
    'Every selected event inside the adoption’s dates must have its answer by a deadline counted from the event’s time (atField, or its span start). The answer is an instant on the event itself (answerField), or the earliest selected observation of the answers input at or after the event (answerAtField, or its span start) that, with answerCoversFromField and answerCoversThroughField, covers the event’s local date. The deadline is exactly one of: hours after the event (an answer at the last instant is in time); days after the event’s local date in the stated time zone, the event’s own day not counted, optionally skipping excluded weekdays (1 Monday to 7 Sunday) and excluded dates trusted only from calendarFrom through calendarThrough; or the end of a given day of the month after the event’s local month. An event placed by a date alone is read at the first instant of that day, and an answer given as a date alone (an answer record placed by one, or a time on the event itself in answerField) at its last instant, and the summary says only the date is on record. An answer after its deadline, or none by it, needs attention and names the event; one not yet due is awaited until its deadline. An event matching notDue (such as an occurrence the operator recorded as not reportable) is not counted; the summary says so and who decided, from byField. With no event the rule does not apply (or is insufficient with whenNone insufficient). Counting past the stated calendar is insufficient, never guessed.',
  inputs: [
    { name: 'events', description: 'The records of the events that each need an answer.' },
    {
      name: 'answers',
      description: 'Records that answer the events, when the answer is not a time on the event itself.',
      optional: true,
    },
  ],
  details: [
    { name: 'timeZone', description: 'The time zone days are counted in; null when the deadline is in hours.' },
    { name: 'eventCount', description: 'Events inside the adoption’s dates.' },
    { name: 'answeredCount', description: 'Events answered in time.' },
    { name: 'lateCount', description: 'Events answered after their deadline.' },
    { name: 'overdueCount', description: 'Events with no answer by their deadline.' },
    { name: 'awaitingCount', description: 'Events whose deadline has not yet come, with no answer yet.' },
    { name: 'outsideAdoptionCount', description: 'Events before or after the adoption’s dates, not counted.' },
    { name: 'notDueCount', description: 'Events recorded as needing no answer (notDue), not counted.' },
    { name: 'nextDueBy', description: 'The last instant in time for the earliest awaited answer, UTC; else null.' },
    { name: 'nextDueThrough', description: 'The last local date of the earliest awaited answer; else null.' },
  ],
  issues: {
    description:
      'One event with no answer by its deadline, or with an answer after it, named event-at:<the event time, UTC>.',
  },
  adoptionDates: 'Events before the adoption’s start or from its end on are not counted.',
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      select: selectionSchema,
      atField: fieldPath,
      answerField: fieldPath,
      answerSelect: selectionSchema,
      answerAtField: fieldPath,
      answerCoversFromField: fieldPath,
      answerCoversThroughField: fieldPath,
      answerLabel: { type: 'string', minLength: 1, maxLength: 100 },
      timeZone: timeZoneSchema,
      hours: { type: 'integer', minimum: 1, maximum: 8784 },
      days: { type: 'integer', minimum: 1, maximum: 366 },
      excludedWeekdays: {
        type: 'array',
        maxItems: 6,
        uniqueItems: true,
        items: { type: 'integer', minimum: 1, maximum: 7 },
      },
      excludedDates: { type: 'array', maxItems: 1000, uniqueItems: true, items: calendarDateSchema },
      calendarFrom: calendarDateSchema,
      calendarThrough: calendarDateSchema,
      followingMonthDay: { type: 'integer', minimum: 1, maximum: 28 },
      whenNone: { enum: ['not_applicable', 'insufficient'] },
      notDue: notDueSchema,
    },
    oneOf: [{ required: ['hours'] }, { required: ['days'] }, { required: ['followingMonthDay'] }],
    allOf: [
      { not: { required: ['answerField', 'answerSelect'] } },
      { not: { required: ['answerField', 'answerAtField'] } },
      { not: { required: ['answerField', 'answerCoversFromField'] } },
    ],
    dependencies: {
      days: ['timeZone'],
      followingMonthDay: ['timeZone'],
      answerCoversFromField: ['answerCoversThroughField', 'timeZone'],
      answerCoversThroughField: ['answerCoversFromField'],
      excludedWeekdays: ['days'],
      excludedDates: ['days', 'calendarFrom', 'calendarThrough'],
      calendarFrom: ['excludedDates'],
      calendarThrough: ['excludedDates'],
    },
  },
  evaluate(params, inputs, clock) {
    const now = utcMillis(clock.evaluatedAt)!;
    const label = params.answerLabel ?? 'answer';
    const details: CheckDetails = {
      timeZone: params.timeZone ?? null,
      eventCount: 0,
      answeredCount: 0,
      lateCount: 0,
      overdueCount: 0,
      awaitingCount: 0,
      outsideAdoptionCount: 0,
      notDueCount: 0,
      nextDueBy: null,
      nextDueThrough: null,
    };
    const calendar = params.timeZone === undefined ? undefined : zoneCalendar(params.timeZone);
    if (params.timeZone !== undefined && !calendar) return zoneMissing(params.timeZone, details);
    const badDate = [params.calendarFrom, params.calendarThrough, ...(params.excludedDates ?? [])].find(
      (date) => date !== undefined && !validCalendarDate(date),
    );
    if (badDate)
      return result(
        'insufficient',
        'pending',
        'calendar_invalid',
        `The stated calendar holds ${badDate}, which is not a calendar date.`,
        [],
        details,
      );
    const adoption = adoptionWindow(clock);
    const events = current(inputs.events, params.select).flatMap((event) => {
      const time = placedTime(event, params.atField, 'earliest');
      return time === undefined ? [] : [{ event, ...time }];
    });
    const inside = events.filter(({ at }) => !adoption || (at >= adoption.start && at < adoption.end));
    details.outsideAdoptionCount = events.length - inside.length;
    const notDue = inside.flatMap(({ event, at, day }) => {
      const sentence = notDueSentence(event, params.notDue, eventWords(at, day));
      return sentence ? [{ event, sentence }] : [];
    });
    const counted = inside.filter(({ event }) => !notDue.some((item) => item.event === event));
    details.notDueCount = notDue.length;
    details.eventCount = counted.length;
    const notCounted = notDue.length ? listedSentences(notDue.map((item) => item.sentence)) : undefined;
    const withNotDue = (outcome: CheckResult): CheckResult =>
      notCounted
        ? { ...outcome, evidence: [...outcome.evidence, ...notDue.map((item) => item.event.id)], notCounted }
        : outcome;
    if (!counted.length) {
      const outside =
        events.length > inside.length
          ? ` ${events.length - inside.length} recorded event(s) fall outside the adoption’s dates.`
          : '';
      if (notCounted)
        return withNotDue(result('not_applicable', 'not_applicable', 'events_not_due', notCounted, [], details));
      return params.whenNone === 'insufficient'
        ? result('insufficient', 'pending', 'events_missing', `No event is recorded.${outside}`, [], details)
        : result('not_applicable', 'not_applicable', 'no_events', `No event is recorded.${outside}`, [], details);
    }
    const answers = current(inputs.answers, params.answerSelect)
      .flatMap((answer) => {
        const time = placedTime(answer, params.answerAtField, 'latest');
        return time === undefined ? [] : [{ answer, at: time.at, day: time.day }];
      })
      .sort((left, right) => left.at - right.at || (left.answer.id < right.answer.id ? -1 : 1));
    const items: EventAnswer[] = counted
      .sort((left, right) => left.at - right.at || (left.event.id < right.event.id ? -1 : 1))
      .map(({ event, at, day }) => {
        const deadline = deadlineOf(params, calendar, at);
        if (!deadline)
          return {
            event,
            at,
            ...(day === undefined ? {} : { day }),
            state: 'not_counted',
            allowed: `counting ${params.days} days after it runs outside the stated calendar, ${params.calendarFrom} to ${params.calendarThrough}`,
          };
        const eventDay = calendar ? localDate(calendar, at) : undefined;
        const found =
          params.answerField !== undefined
            ? { ...answerOnEvent(event, params.answerField), answer: undefined }
            : (answers.find((item) => item.at >= at && coversDate(item.answer, params, eventDay)) ?? {
                at: undefined,
                answer: undefined,
                day: undefined,
              });
        const base = {
          event,
          at,
          ...(day === undefined ? {} : { day }),
          ...deadline,
          answer: found.answer,
          answeredAt: found.at,
          ...(found.day === undefined ? {} : { answeredDay: found.day }),
        };
        if (found.at !== undefined)
          return { ...base, state: found.at <= deadline.lastAllowed ? 'answered' : 'late' } as EventAnswer;
        return { ...base, state: now > deadline.lastAllowed ? 'overdue' : 'awaiting' } as EventAnswer;
      });
    const evidence = items.flatMap((item) => [item.event, ...(item.answer ? [item.answer] : [])]);
    const before = items.find((item) => item.answeredAt !== undefined && item.answeredAt < item.at);
    if (before)
      return withNotDue(
        result(
          'conflicting',
          'attention',
          'answer_before_event',
          `The ${label} of the event at ${iso(before.at)} is recorded at ${iso(before.answeredAt)}, before the event.`,
          [before.event],
          details,
        ),
      );
    const count = (state: EventState) => items.filter((item) => item.state === state).length;
    Object.assign(details, {
      answeredCount: count('answered'),
      lateCount: count('late'),
      overdueCount: count('overdue'),
      awaitingCount: count('awaiting'),
    });
    const awaiting = items
      .filter((item) => item.state === 'awaiting')
      .sort((left, right) => left.lastAllowed! - right.lastAllowed!)[0];
    if (awaiting)
      Object.assign(details, { nextDueBy: iso(awaiting.lastAllowed), nextDueThrough: awaiting.dueThrough ?? null });
    const boundary = awaiting ? awaiting.lastAllowed! + 1 : undefined;
    const summary = listedSentences(items.map((item) => eventSentence(item, label)));
    const flagged = items.filter((item) => item.state === 'late' || item.state === 'overdue');
    if (flagged.length) {
      const outcome = result(
        count('overdue') ? 'insufficient' : 'supported',
        'attention',
        count('overdue') ? 'answer_overdue' : 'answer_late',
        summary,
        evidence,
        details,
        boundary,
      );
      return withNotDue({ ...outcome, issues: flagged.map((item) => `event-at:${iso(item.at)}`) });
    }
    if (count('not_counted'))
      return withNotDue(
        result('insufficient', 'pending', 'calendar_not_covered', summary, evidence, details, boundary),
      );
    if (awaiting)
      return withNotDue(result('insufficient', 'pending', 'answer_awaited', summary, evidence, details, boundary));
    return withNotDue(result('supported', 'pass', 'answered_within', summary, evidence, details));
  },
};

// A record made in each period of calendar months ------------------------------------------------------------------

export interface PeriodsEachRecordedParams {
  select?: Selection;
  atField?: string;
  timeZone: string;
  months: number;
  periods: 'fixed' | 'rolling';
}

interface Period {
  firstDay: string;
  lastDay: string;
  start: number;
  end: number;
  /** When the period is over: its end, or for a rolling period the record that closes it. */
  over: number;
  record?: CheckObservation;
}

interface Made {
  record: CheckObservation;
  at: number;
}

function periodFrom(calendar: Intl.DateTimeFormat, firstMonth: number, lastMonth: number, start?: number) {
  const firstDay = firstDayOf(firstMonth);
  return {
    firstDay: start === undefined ? firstDay : localDate(calendar, start),
    lastDay: lastDayOf(lastMonth),
    start: start ?? dayStart(calendar, firstDay),
    end: dayStart(calendar, firstDayOf(lastMonth + 1)),
  };
}

/**
 * Fixed periods: runs of N months counted from January of year 0, wholly inside the adoption, through the one open at
 * `until` and the next.
 */
function fixedPeriods(
  calendar: Intl.DateTimeFormat,
  params: PeriodsEachRecordedParams,
  adoption: { start: number; end: number },
  made: readonly Made[],
  until: number,
): Period[] {
  const periods: Period[] = [];
  let month = Math.floor(monthIndex(localDate(calendar, adoption.start)) / params.months) * params.months;
  for (; ; month += params.months) {
    const period = periodFrom(calendar, month, month + params.months - 1);
    if (period.start < adoption.start) continue;
    if (period.end > adoption.end) return periods;
    const record = made.find((item) => item.at >= period.start && item.at < period.end)?.record;
    periods.push({ ...period, over: period.end, ...(record ? { record } : {}) });
    if (period.start > until) return periods;
  }
}

/**
 * Rolling periods: each record closes its period and makes the next due by the end of the Nth month after its own;
 * the first is due by the end of the Nth month counting the adoption's start month as the first, or N months after
 * the latest record before the adoption. A period that ends with none is followed by another of N months.
 */
function rollingPeriods(
  calendar: Intl.DateTimeFormat,
  params: PeriodsEachRecordedParams,
  adoption: { start: number; end: number },
  made: readonly Made[],
  until: number,
): Period[] {
  const periods: Period[] = [];
  const earlier = made.filter((item) => item.at <= adoption.start).at(-1);
  let start = adoption.start;
  const startMonth = monthIndex(localDate(calendar, adoption.start));
  // A record from before the adoption whose next was already due by then leaves the adoption's first month.
  let lastMonth = earlier
    ? Math.max(monthIndex(localDate(calendar, earlier.at)) + params.months, startMonth)
    : startMonth + params.months - 1;
  for (;;) {
    const period = periodFrom(calendar, monthIndex(localDate(calendar, start)), lastMonth, start);
    if (period.start >= adoption.end) return periods;
    // A period may run past the adoption's end; only records inside the adoption's dates close it.
    const record = made.filter((item) => item.at > start && item.at < Math.min(period.end, adoption.end)).at(-1);
    periods.push({ ...period, over: record ? record.at : period.end, ...(record ? { record: record.record } : {}) });
    if (period.start > until) return periods;
    if (record) {
      start = record.at;
      lastMonth = monthIndex(localDate(calendar, record.at)) + params.months;
    } else {
      start = period.end;
      lastMonth += params.months;
    }
  }
}

export const periodsEachRecordedV1: CheckKind<PeriodsEachRecordedParams> = {
  id: 'periods.each-recorded',
  version: 1,
  title: 'A record made in each period of calendar months',
  description:
    'Inside the adoption’s dates, each period of N local calendar months in the stated time zone must hold a selected record, placed by atField (or its span start). Fixed periods are runs of N months counted from January (N 1: each calendar month; N 12: each calendar year); only periods wholly inside the adoption’s dates count. Rolling periods start at the adoption’s start and may run past its end: each record makes the next due by the end of the Nth month after the month it was made in, the first is due by the end of the Nth month counting the adoption’s start month as the first (or N months after the latest record before the adoption), and a period that ends with none is followed by another of N months. Each period that has ended without a record needs attention and is named; while none has ended, a period still open without a record is awaited until it ends, unless a rolling period opens with a record from before the adoption. Without the adoption’s dates the result is insufficient.',
  inputs: [{ name: 'records', description: 'The records, each placed in the period its time falls in.' }],
  details: [
    { name: 'timeZone', description: 'The time zone the months are counted in.' },
    { name: 'months', description: 'How many calendar months one period holds.' },
    { name: 'periodsEnded', description: 'Periods inside the adoption’s dates that have ended.' },
    { name: 'periodsMissing', description: 'Ended periods with no record.' },
    { name: 'missingPeriods', description: 'The local first and last day of each ended period with no record.' },
    { name: 'currentPeriodThrough', description: 'The last local date of the period now open; else null.' },
    { name: 'currentPeriodRecorded', description: 'Whether the period now open already holds a record.' },
  ],
  issues: { description: 'One ended period with no record, named period:<its first local date>.' },
  adoptionDates: 'Periods are counted from the adoption’s start, and only up to its end.',
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['timeZone', 'months', 'periods'],
    properties: {
      select: selectionSchema,
      atField: fieldPath,
      timeZone: timeZoneSchema,
      months: { type: 'integer', minimum: 1, maximum: 24 },
      periods: { enum: ['fixed', 'rolling'] },
    },
  },
  evaluate(params, inputs, clock) {
    const now = utcMillis(clock.evaluatedAt)!;
    const details: CheckDetails = {
      timeZone: params.timeZone,
      months: params.months,
      periodsEnded: 0,
      periodsMissing: 0,
      missingPeriods: null,
      currentPeriodThrough: null,
      currentPeriodRecorded: false,
    };
    const calendar = zoneCalendar(params.timeZone);
    if (!calendar) return zoneMissing(params.timeZone, details);
    const adoption = adoptionWindow(clock);
    if (!adoption)
      return result(
        'insufficient',
        'pending',
        'adoption_dates_missing',
        'The periods are counted inside an adoption’s dates, and none were given.',
        [],
        details,
      );
    const made = current(inputs.records, params.select)
      .flatMap((record) => {
        const at = recordTime(record, params.atField);
        return at === undefined || at > now ? [] : [{ record, at }];
      })
      .sort((left, right) => left.at - right.at || (left.record.id < right.record.id ? -1 : 1));
    const periods = (params.periods === 'fixed' ? fixedPeriods : rollingPeriods)(calendar, params, adoption, made, now);
    const ended = periods.filter((period) => period.over <= now);
    const missing = ended.filter((period) => !period.record);
    const open = periods.find((period) => period.start <= now && now < period.over);
    const unrecorded = periods.find((period) => period.end > now && !period.record);
    const span = (period: Period) => `${period.firstDay} to ${period.lastDay}`;
    Object.assign(details, {
      periodsEnded: ended.length,
      periodsMissing: missing.length,
      missingPeriods: missing.length ? missing.map(span).join(', ') : null,
      currentPeriodThrough: open?.lastDay ?? null,
      currentPeriodRecorded: Boolean(open?.record),
    });
    const evidence = periods.flatMap((period) => (period.record ? [period.record] : []));
    const boundary = unrecorded?.end;
    const openWords = open ? ` The period ${span(open)} ${open.record ? 'holds a record' : 'has none yet'}.` : '';
    const unit = `${params.months} calendar month${params.months === 1 ? '' : 's'}`;
    if (missing.length) {
      const outcome = result(
        'supported',
        'attention',
        'periods_missing',
        `No record is made in ${missing.length} of the ${ended.length} ended period(s) of ${unit} in ${params.timeZone}: ${missing.slice(0, SHOWN).map(span).join(', ')}${missing.length > SHOWN ? ` and ${missing.length - SHOWN} more` : ''}.${openWords}`,
        evidence,
        details,
        boundary,
      );
      return { ...outcome, issues: missing.map((period) => `period:${period.firstDay}`) } satisfies CheckResult;
    }
    if (ended.length)
      return result(
        'supported',
        'pass',
        'periods_recorded',
        `Each of the ${ended.length} ended period(s) of ${unit} in ${params.timeZone} inside the adoption’s dates holds a record.${openWords}`,
        evidence,
        details,
        boundary,
      );
    const earlier = params.periods === 'rolling' ? made.filter((item) => item.at <= adoption.start).at(-1) : undefined;
    if (earlier && open)
      return result(
        'supported',
        'pass',
        'periods_recorded',
        `No period of ${unit} has ended inside the adoption’s dates yet; the latest record before them, at ${iso(earlier.at)}, makes the next due through ${open.lastDay}.`,
        [earlier.record],
        details,
        boundary,
      );
    if (open?.record)
      return result(
        'supported',
        'pass',
        'periods_recorded',
        `No period of ${unit} has ended inside the adoption’s dates yet.${openWords}`,
        evidence,
        details,
        boundary,
      );
    const first = periods[0];
    return result(
      'insufficient',
      'pending',
      'period_open',
      first
        ? `No period of ${unit} has ended inside the adoption’s dates yet; the first, ${span(first)}, has no record yet.`
        : `No period of ${unit} lies wholly inside the adoption’s dates yet.`,
      evidence,
      details,
      boundary,
    );
  },
};

export const deadlineCheckKinds: readonly CheckKind[] = [eventsAnsweredWithinV1, periodsEachRecordedV1];
for (const kind of deadlineCheckKinds) registerCheckKind(kind);
