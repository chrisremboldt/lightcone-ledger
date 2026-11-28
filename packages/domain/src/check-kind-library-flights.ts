import { RECORD_NOT_ON_FILE, type CheckDetails } from '@ledger/contracts';
import {
  calendarDateSchema,
  iso,
  localDate,
  result as combinedResult,
  validCalendarDate,
  zoneCalendar,
} from './check-kind-library-combined.js';
import {
  current,
  fieldPath,
  labelOf,
  recordedSegment,
  round,
  scalars,
  selectionSchema,
  type Scalar,
  type Segment,
  type Selection,
} from './check-kind-library-records.js';
import {
  latestObservations,
  observationField,
  registerCheckKind,
  type CheckInputs,
  type CheckKind,
  type CheckKindInput,
  type CheckObservation,
} from './check-kinds.js';
import { placedTime } from './day-precision.js';
import { valueLabel } from './field-labels.js';

// Check kinds that ask a question as of one flight: the record in effect at its takeoff, the intervals that overlap
// its window, the intervals counted in the days before it, and whether it falls within stated dates. Each follows the
// per-flight rule in docs/design/record-check-kinds.md ("Evaluated as of each flight").

const DAY = 86_400_000;

/** A result whose details keep its own summary as reading, so a rule's wording can quote it and add to it. */
export function result(...args: Parameters<typeof combinedResult>): ReturnType<typeof combinedResult> {
  const [, , , summary, , details] = args;
  details.reading = summary;
  return combinedResult(...args);
}

export const readingDetail = {
  name: 'reading',
  description: 'The kind’s own summary, so a rule’s wording can quote it and add what is left to a person.',
} as const;
const words = { type: 'string', minLength: 1, maxLength: 200 } as const;
const positiveWhole = { type: 'integer', minimum: 1, maximum: 10_000 } as const;

// The flight's time ------------------------------------------------------------------------------------------------

/** Where a rule reads the flight's time: a report, the operator's flight record, the plan; each by its fields. */
export interface FlightTimeParams {
  reportedSelect?: Selection;
  reportedStartField?: string;
  reportedEndField?: string;
  recordedSelect?: Selection;
  recordedStartField?: string;
  recordedEndField?: string;
  plannedSelect?: Selection;
  plannedStartField?: string;
  plannedEndField?: string;
}

export const flightTimeSchema = {
  reportedSelect: selectionSchema,
  reportedStartField: fieldPath,
  reportedEndField: fieldPath,
  recordedSelect: selectionSchema,
  recordedStartField: fieldPath,
  recordedEndField: fieldPath,
  plannedSelect: selectionSchema,
  plannedStartField: fieldPath,
  plannedEndField: fieldPath,
} as const;

export const flightTimeDependencies = {
  reportedEndField: ['reportedStartField'],
  recordedEndField: ['recordedStartField'],
  plannedEndField: ['plannedStartField'],
} as const;

export const flightTimeInputs: readonly CheckKindInput[] = [
  { name: 'reported', description: 'Reports of the flight that state its takeoff and landing.', optional: true },
  { name: 'recorded', description: 'The operator’s own record of the flight as flown.', optional: true },
  { name: 'planned', description: 'The flight’s plan, with its planned window.', optional: true },
];

export const flightTimeDetails = [
  readingDetail,
  { name: 'basis', description: 'Where the flight’s time came from: reported, recorded or planned; null when none.' },
  { name: 'flightStart', description: 'The takeoff, or the planned start, as a UTC instant; null when none.' },
  { name: 'flightEnd', description: 'The landing, or the planned end, as a UTC instant; null when none is stated.' },
] as const;

/** The flight's window: a reported takeoff, else the operator's record, else the plan; the end from the same record. */
export interface FlightWindow {
  start: number;
  end: number | undefined;
  basis: 'reported' | 'recorded' | 'planned';
  evidence: CheckObservation[];
}

export function flightWindow(params: FlightTimeParams, inputs: CheckInputs): FlightWindow | undefined {
  const sources = [
    ['reported', inputs.reported, params.reportedSelect, params.reportedStartField, params.reportedEndField],
    ['recorded', inputs.recorded, params.recordedSelect, params.recordedStartField, params.recordedEndField],
    ['planned', inputs.planned, params.plannedSelect, params.plannedStartField, params.plannedEndField],
  ] as const;
  for (const [basis, observations, select, startField, endField] of sources) {
    if (startField === undefined) continue;
    const latest = latestObservations(current(observations, select));
    const placed = latest.flatMap((observation) => {
      const start = placedTime(observation, startField, 'earliest');
      return start ? [{ observation, start: start.at }] : [];
    });
    if (!placed.length) continue;
    const start = Math.min(...placed.map((item) => item.start));
    const ends = placed.flatMap((item) => {
      const end = endField === undefined ? undefined : placedTime(item.observation, endField, 'latest');
      return end && end.at >= start ? [end.at] : [];
    });
    return {
      start,
      end: ends.length ? Math.max(...ends) : undefined,
      basis,
      evidence: placed.map((item) => item.observation),
    };
  }
  return undefined;
}

/** The flight's time as a sentence says it: "takeoff at …", "the recorded takeoff at …", "the planned start at …". */
export function startWords(window: FlightWindow): string {
  const at = iso(window.start);
  if (window.basis === 'reported') return `takeoff at ${at}`;
  if (window.basis === 'recorded') return `takeoff at ${at} in the operator’s flight record`;
  return `the planned start at ${at}`;
}

function windowWords(window: FlightWindow): string {
  const end = window.end === undefined ? '' : ` to ${iso(window.end)}`;
  const from = `${iso(window.start)}${end}`;
  if (window.basis === 'reported') return `the flight as reported, ${from}`;
  if (window.basis === 'recorded') return `the flight as the operator recorded it, ${from}`;
  return `the planned window, ${from}`;
}

export function windowDetails(window: FlightWindow | undefined): CheckDetails {
  return {
    basis: window?.basis ?? null,
    flightStart: iso(window?.start),
    flightEnd: iso(window?.end),
  };
}

export function noFlightTime(what: string, details: CheckDetails) {
  return result(
    'insufficient',
    'pending',
    RECORD_NOT_ON_FILE,
    `No takeoff or planned start is on file for this flight, so ${what} cannot be placed against it.`,
    [],
    details,
  );
}

/** The id an observation names as its subject, as written. */
function subjectIdOf(observation: CheckObservation | undefined, role: 'subject' | 'secondarySubject' = 'subject') {
  const subject = observation?.observation[role] as { id?: unknown } | undefined;
  return typeof subject?.id === 'string' ? subject.id : undefined;
}

/** A time between a record and a flight: in hours under a day, else in days. */
const daysText = (millis: number) => {
  if (millis < DAY) {
    const hours = Math.round((millis / 3_600_000) * 10) / 10;
    return `${hours} h`;
  }
  const days = Math.round((millis / DAY) * 10) / 10;
  return `${days} day${days === 1 ? '' : 's'}`;
};

// The record in effect before a flight -------------------------------------------------------------------------

export interface RecordBeforeFlightParams extends FlightTimeParams {
  select?: Selection;
  atField?: string;
  recordDescribes: string;
  field?: string;
  expected?: Scalar[];
  maxAgeDays?: number;
  previousSelect?: Selection;
  previousEndField?: string;
  previousDescribes?: string;
}

export const recordBeforeFlightV1: CheckKind<RecordBeforeFlightParams> = {
  id: 'record.before-flight',
  version: 1,
  title: 'The record in effect at a flight’s takeoff',
  description:
    'The latest selected record made (atField, or its span start) at or before the flight’s time: the takeoff a report states, else the takeoff in the operator’s flight record, else the planned start, each read only when the rule names its field. A record made after that time is never read for the flight. With previousEndField, the record must be made after the latest previous window (such as the aircraft’s previous flight) that ended at or before the flight’s time; with maxAgeDays, at most that many days before it; with field and expected, it must hold one of the expected values. No flight time, no record at or before it, or none since the previous window is insufficient, reason record_not_on_file. A record older than maxAgeDays, or holding another value, needs attention. Records made together that state different values conflict. A record whose related subject is a subject of the flight’s kind names the flight it was made for and counts for that flight only: made at or before its takeoff, or given as a date alone on or before the takeoff’s local date, and taken as made since the previous window. Under a rule with previousEndField, a record placed by a date alone that names no flight counts only for flights that took off on that local date, and is taken as made after the previous window only when that ended on an earlier local date; otherwise a record placed by a date alone is read as made at the end of that day. Each sentence names the subject by the id the records are about and says which it relied on.',
  inputs: [
    { name: 'records', description: 'The records, such as checks or inspections of the flight’s aircraft.' },
    {
      name: 'previous',
      description: 'Earlier windows of the same subject, such as its flights, each with an end.',
      optional: true,
    },
    ...flightTimeInputs,
  ],
  details: [
    ...flightTimeDetails,
    { name: 'recordAt', description: 'When the record in effect was made; null when none.' },
    { name: 'previousEndAt', description: 'When the latest previous window ended; null when none or not read.' },
    { name: 'ageDays', description: 'Days from the record to the flight’s time; null when no record.' },
    { name: 'value', description: 'The value of the field in the record in effect; null when none or not read.' },
    { name: 'subjectId', description: 'The id of the subject the records are about; null when none is named.' },
  ],
  summaryValues: ['flightStart', 'recordAt', 'previousEndAt'],
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['recordDescribes'],
    properties: {
      select: selectionSchema,
      atField: fieldPath,
      recordDescribes: words,
      field: fieldPath,
      expected: scalars,
      maxAgeDays: { type: 'number', exclusiveMinimum: 0, maximum: 36_500 },
      previousSelect: selectionSchema,
      previousEndField: fieldPath,
      previousDescribes: words,
      ...flightTimeSchema,
    },
    anyOf: [
      { required: ['reportedStartField'] },
      { required: ['recordedStartField'] },
      { required: ['plannedStartField'] },
    ],
    dependencies: {
      ...flightTimeDependencies,
      field: ['expected'],
      expected: ['field'],
      previousSelect: ['previousEndField'],
      previousDescribes: ['previousEndField'],
    },
  },
  evaluate(params, inputs, clock) {
    const window = flightWindow(params, inputs);
    const details: CheckDetails = {
      ...windowDetails(window),
      recordAt: null,
      previousEndAt: null,
      ageDays: null,
      value: null,
      subjectId: null,
    };
    const what = `the ${params.recordDescribes}`;
    if (!window) return noFlightTime(what, details);
    const when = startWords(window);
    const perFlight = params.previousEndField !== undefined;
    const counted = recordsForFlight(params, inputs, window, clock.timeZone);
    const made = counted.made;
    const subjectId =
      subjectIdOf(made[0]?.observation) ??
      subjectIdOf(current(inputs.records, params.select)[0]) ??
      subjectIdOf(window.evidence[0], 'secondarySubject');
    details.subjectId = subjectId ?? null;
    const of = subjectId === undefined ? '' : ` of ${subjectId}`;
    const previousEnd =
      params.previousEndField === undefined
        ? undefined
        : Math.max(
            -Infinity,
            ...current(inputs.previous, params.previousSelect).flatMap((observation) => {
              const end = placedTime(observation, params.previousEndField, 'latest');
              return end && end.at <= window.start ? [end.at] : [];
            }),
          );
    const previous = previousEnd !== undefined && Number.isFinite(previousEnd) ? previousEnd : undefined;
    details.previousEndAt = iso(previous);
    const previousWords = `${params.previousDescribes ?? 'the previous window'}, which ended at ${iso(previous)}`;
    const newest = made[0];
    if (!newest) {
      const elsewhere = counted.earlierDay;
      return result(
        'insufficient',
        'pending',
        RECORD_NOT_ON_FILE,
        elsewhere
          ? `No ${params.recordDescribes}${of} is on file for ${when}; the latest, made on ${elsewhere}, names no flight and gives a date only, so it counts only for flights that took off on ${elsewhere}.`
          : `No ${params.recordDescribes}${of} is on file at or before ${when}.`,
        window.evidence,
        details,
      );
    }
    const inEffect = made.filter((item) => item.at === newest.at);
    const madeWords = newest.day === undefined ? `at ${iso(newest.at)}` : `on ${newest.day}`;
    Object.assign(details, { recordAt: iso(newest.at), ageDays: round((window.start - newest.at) / DAY) });
    const evidence = [...window.evidence, ...inEffect.map((item) => item.observation)];
    const sameDayAsPrevious =
      previous !== undefined && newest.day !== undefined && localDay(previous, newest.timeZone) === newest.day;
    if (!newest.named && previous !== undefined && (newest.at <= previous || (newest.day && sameDayAsPrevious)))
      return result(
        'insufficient',
        'pending',
        RECORD_NOT_ON_FILE,
        newest.day === undefined
          ? `No ${params.recordDescribes}${of} is on file between ${previousWords}, and ${when}; the latest was made ${madeWords}.`
          : `No ${params.recordDescribes}${of} is on file between ${previousWords}, and ${when}; the latest was made ${madeWords} and names no flight. Only the date is on record, so it is not taken as made after a flight that ended that same day.`,
        evidence,
        details,
      );
    const age = window.start - newest.at;
    const ageWords = `${daysText(age)} before ${when}`;
    if (params.maxAgeDays !== undefined && age > params.maxAgeDays * DAY)
      return result(
        'supported',
        'attention',
        'record_too_old',
        `The latest ${params.recordDescribes}${of} on file before ${when} was made ${madeWords}, ${daysText(age)} before it; the rule allows at most ${params.maxAgeDays} day${params.maxAgeDays === 1 ? '' : 's'}.`,
        evidence,
        details,
      );
    const since = previous === undefined ? '' : ` after ${previousWords},`;
    const flightId = subjectIdOf(window.evidence[0]);
    const recorded = newest.named
      ? `The ${params.recordDescribes}${of} made for this flight, ${flightId}, ${
          newest.day === undefined
            ? `${madeWords}, ${ageWords}`
            : `${madeWords} (only the date is on record), for ${when}`
        }`
      : newest.day !== undefined && perFlight
        ? `The ${params.recordDescribes}${of} made ${madeWords}, which names no flight (only the date is on record, so it counts only for flights that took off that day),${since} for ${when}`
        : `The ${params.recordDescribes}${of} made ${madeWords},${since} ${ageWords}`;
    if (params.field === undefined)
      return result('supported', 'pass', 'record_in_effect', `${recorded}, is on file.`, evidence, details);
    const values = [
      ...new Set(
        inEffect.flatMap((item) => {
          const value = observationField(item.observation, params.field!);
          return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? [value] : [];
        }),
      ),
    ];
    const observed = inEffect.map((item) => item.observation);
    const label = labelOf(params.field, observed, params.select);
    const shown = (value: Scalar) => valueLabel(params.field!, value, observed, params.select);
    if (!values.length)
      return result(
        'insufficient',
        'attention',
        'value_missing',
        `${recorded}, records no ${label}; the record is incomplete.`,
        evidence,
        details,
      );
    if (values.length > 1)
      return result(
        'conflicting',
        'attention',
        'values_disagree',
        `${inEffect.length} ${params.recordDescribes} records${of} made together ${madeWords} state different values for ${label}: ${values.map(shown).join(', ')}. Correct the one that is wrong, or record it as replaced, so one value stands.`,
        evidence,
        details,
      );
    const value = values[0]!;
    details.value = value;
    return params.expected!.includes(value)
      ? result(
          'supported',
          'pass',
          'value_expected',
          `${recorded}, records ${label} as ${shown(value)}.`,
          evidence,
          details,
        )
      : result(
          'supported',
          'attention',
          'value_unexpected',
          `${recorded}, records ${label} as ${shown(value)}; expected ${params.expected!.map(shown).join(' or ')}.`,
          evidence,
          details,
        );
  },
};

/** A record counted for a flight: when it is taken as made, the day when only a date is on record, and whether it names the flight. */
interface CountedRecord {
  observation: CheckObservation;
  at: number;
  day?: string;
  timeZone?: string;
  named: boolean;
}

/** The local calendar date of an instant in a zone, UTC when the zone is not known. */
function localDay(at: number, timeZone: string | undefined): string {
  return localDate((timeZone && zoneCalendar(timeZone)) || zoneCalendar('UTC')!, at);
}

/**
 * The records that count for the flight, newest first (docs/design/date-only-records.md, "A check made for a flight").
 * A record whose related subject is a subject of the flight's kind names a flight, and counts only for that one; when
 * one names this flight, only those count. A date alone that names no flight counts, under a rule that asks for a
 * record since the previous flight, only for flights that took off that local day. Also returns the day of the latest
 * such record from an earlier day, so the sentence can say why it does not count.
 */
function recordsForFlight(
  params: RecordBeforeFlightParams,
  inputs: CheckInputs,
  window: FlightWindow,
  zone: string | undefined,
): { made: CountedRecord[]; earlierDay?: string } {
  const flight = window.evidence[0]?.observation.subject as { kind?: unknown; id?: unknown } | undefined;
  const perFlight = params.previousEndField !== undefined;
  const named: CountedRecord[] = [];
  const unnamed: CountedRecord[] = [];
  let earlierDay: string | undefined;
  for (const observation of current(inputs.records, params.select)) {
    const related = observation.observation.secondarySubject as { kind?: unknown; id?: unknown } | undefined;
    const namesFlight = flight?.kind !== undefined && related?.kind === flight.kind;
    if (namesFlight && related?.id !== flight?.id) continue;
    const time = placedTime(observation, params.atField, 'latest');
    if (!time) continue;
    const item = { observation, ...time, named: namesFlight };
    if (time.day === undefined || (!namesFlight && !perFlight)) {
      if (time.at <= window.start) (namesFlight ? named : unnamed).push(item);
      continue;
    }
    const takeoffDay = localDay(window.start, time.timeZone ?? zone);
    if (namesFlight) {
      if (time.day <= takeoffDay) named.push({ ...item, at: Math.min(time.at, window.start) });
    } else if (time.day === takeoffDay) unnamed.push({ ...item, at: window.start });
    else if (time.day < takeoffDay && (earlierDay === undefined || time.day > earlierDay)) earlierDay = time.day;
  }
  const made = (named.length ? named : unnamed).sort((a, b) => b.at - a.at);
  return { made, ...(earlierDay === undefined ? {} : { earlierDay }) };
}

// Intervals of other subjects that overlap a flight, or come before it -----------------------------------------

interface IntervalParams extends FlightTimeParams {
  select?: Selection;
  intervalDescribes: string;
  holderField?: string;
}

const intervalSchema = {
  select: selectionSchema,
  intervalDescribes: words,
  holderField: fieldPath,
  ...flightTimeSchema,
} as const;

const intervalInputs: readonly CheckKindInput[] = [
  {
    name: 'intervals',
    description:
      'Recorded intervals of the flight’s holder, such as every assignment of its pilot, each about the subject it was held for.',
  },
  ...flightTimeInputs,
];

/** Each other subject the intervals are about, with its joined intervals; the flight's own subject is left out. */
function otherSubjects(params: IntervalParams, inputs: CheckInputs, window: FlightWindow) {
  const own = subjectIdOf(window.evidence[0]);
  const bySubject = new Map<string, { segments: Segment[]; evidence: CheckObservation[] }>();
  for (const observation of current(inputs.intervals, params.select)) {
    const id = subjectIdOf(observation);
    const segment = recordedSegment(observation, 'stated');
    if (id === undefined || id === own || !segment) continue;
    const entry = bySubject.get(id) ?? { segments: [], evidence: [] };
    entry.segments.push(segment);
    entry.evidence.push(observation);
    bySubject.set(id, entry);
  }
  return [...bySubject.entries()]
    .map(([id, entry]) => ({ id, ...entry }))
    .sort((a, b) => Math.min(...a.segments.map((s) => s.start)) - Math.min(...b.segments.map((s) => s.start)));
}

function holderOf(params: IntervalParams, inputs: CheckInputs): string {
  if (params.holderField === undefined) return 'The holder';
  for (const observation of current(inputs.intervals, params.select)) {
    const value = observationField(observation, params.holderField);
    if (typeof value === 'string' && value.trim()) return value;
  }
  return 'The holder';
}

function listedIds(ids: readonly string[]): string {
  const shown = ids.slice(0, 10).join(', ');
  return ids.length > 10 ? `${shown} and ${ids.length - 10} more` : shown;
}

export interface IntervalsAtOnceParams extends IntervalParams {
  max: number;
}

export const intervalsAtOnceV1: CheckKind<IntervalsAtOnceParams> = {
  id: 'intervals.at-once',
  version: 1,
  title: 'Subjects held at once during a flight',
  description:
    'During the flight’s window (the reported takeoff to landing, else the operator’s flight record, else the planned window; a window without an end is its start alone), how many subjects did the holder hold at the same moment: the flight itself, and each other subject whose selected intervals (joined, an interval without an end reaching to when it was stated) overlap that moment? More than max needs attention and names each subject and the moment; at most max passes and names the others that overlap. The flight is told apart from the others by the subject its window record is about. No flight time is insufficient, reason record_not_on_file.',
  inputs: intervalInputs,
  details: [
    ...flightTimeDetails,
    { name: 'holder', description: 'The holder the intervals name, as written; null when not read.' },
    { name: 'mostAtOnce', description: 'The most subjects held at the same moment, the flight included.' },
    { name: 'mostAt', description: 'When that many were first held at once; null when only the flight.' },
    { name: 'heldAtOnce', description: 'The other subjects held at that moment, by id.' },
    { name: 'overlapping', description: 'Every other subject whose intervals overlap the flight’s window, by id.' },
  ],
  summaryValues: ['flightStart', 'flightEnd', 'mostAt'],
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['intervalDescribes', 'max'],
    properties: { ...intervalSchema, max: positiveWhole },
    anyOf: [
      { required: ['reportedStartField'] },
      { required: ['recordedStartField'] },
      { required: ['plannedStartField'] },
    ],
    dependencies: flightTimeDependencies,
  },
  evaluate(params, inputs) {
    const window = flightWindow(params, inputs);
    const holder = holderOf(params, inputs);
    const details: CheckDetails = {
      ...windowDetails(window),
      holder: holder === 'The holder' ? null : holder,
      mostAtOnce: null,
      mostAt: null,
      heldAtOnce: null,
      overlapping: null,
    };
    if (!window) return noFlightTime(`the ${params.intervalDescribes}`, details);
    const end = window.end ?? window.start;
    const holds = (segment: Segment, at: number) => segment.start <= at && at < segment.end;
    // An interval overlaps the window when it holds a moment of it; a window without an end is its start alone.
    const overlaps = (segment: Segment) =>
      end > window.start ? segment.start < end && segment.end > window.start : holds(segment, window.start);
    const others = otherSubjects(params, inputs, window).filter((other) => other.segments.some(overlaps));
    // The count can rise only where the window starts or a held interval starts inside it.
    const moments = [
      window.start,
      ...others.flatMap((other) =>
        other.segments.flatMap((segment) =>
          segment.start > window.start && segment.start < end ? [segment.start] : [],
        ),
      ),
    ];
    let most = { count: 1, at: window.start, held: [] as string[] };
    for (const at of [...new Set(moments)].sort((a, b) => a - b)) {
      const held = others
        .filter((other) => other.segments.some((segment) => holds(segment, at)))
        .map((other) => other.id);
      if (held.length + 1 > most.count) most = { count: held.length + 1, at, held };
    }
    Object.assign(details, {
      mostAtOnce: most.count,
      mostAt: most.held.length ? iso(most.at) : null,
      heldAtOnce: most.held.length ? most.held.join(', ') : null,
      overlapping: others.length ? others.map((other) => other.id).join(', ') : null,
    });
    const evidence = [...window.evidence, ...others.flatMap((other) => other.evidence)];
    const during = windowWords(window);
    if (most.count > params.max)
      return result(
        'supported',
        'attention',
        'too_many_at_once',
        `${holder} held ${most.count} ${params.intervalDescribes} at once from ${iso(most.at)}, during ${during}: this flight and ${listedIds(most.held)}; the rule allows at most ${params.max}.`,
        evidence,
        details,
      );
    const whose = holder === 'The holder' ? 'the holder’s' : `${holder}’s`;
    const pass =
      most.count === 1
        ? `During ${during}, none of ${whose} other ${params.intervalDescribes} on file overlaps it. The rule allows at most ${params.max} at once.`
        : `During ${during}, ${holder} held at most ${most.count} ${params.intervalDescribes} at once, this flight included; the others that overlap it are ${listedIds(others.map((other) => other.id))}. The rule allows at most ${params.max}.`;
    return result('supported', 'pass', 'within_at_once', pass, evidence, details);
  },
};

export interface IntervalsCountedBeforeParams extends IntervalParams {
  days: number;
  atLeast: number;
}

export const intervalsCountedBeforeV1: CheckKind<IntervalsCountedBeforeParams> = {
  id: 'intervals.counted-before',
  version: 1,
  title: 'Subjects held in the days before a flight',
  description:
    'How many other subjects the holder held in the days days before the flight’s time (the reported takeoff, else the operator’s flight record, else the planned start): each subject one of whose selected intervals starts in that window, from days before the flight’s time up to it, is counted once. Fewer than atLeast needs attention and names those counted; at least atLeast passes and names them. The flight itself is not counted; it is told apart by the subject its time record is about. No flight time is insufficient, reason record_not_on_file.',
  inputs: intervalInputs,
  details: [
    ...flightTimeDetails,
    { name: 'holder', description: 'The holder the intervals name, as written; null when not read.' },
    { name: 'countedFrom', description: 'The first instant counted, the given days before the flight’s time.' },
    { name: 'counted', description: 'How many other subjects were counted.' },
    { name: 'countedIds', description: 'Their ids, oldest first; null when none.' },
  ],
  summaryValues: ['flightStart', 'countedFrom'],
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['intervalDescribes', 'days', 'atLeast'],
    properties: { ...intervalSchema, days: positiveWhole, atLeast: positiveWhole },
    anyOf: [
      { required: ['reportedStartField'] },
      { required: ['recordedStartField'] },
      { required: ['plannedStartField'] },
    ],
    dependencies: flightTimeDependencies,
  },
  evaluate(params, inputs) {
    const window = flightWindow(params, inputs);
    const holder = holderOf(params, inputs);
    const details: CheckDetails = {
      ...windowDetails(window),
      holder: holder === 'The holder' ? null : holder,
      countedFrom: null,
      counted: null,
      countedIds: null,
    };
    if (!window) return noFlightTime(`the ${params.intervalDescribes}`, details);
    const from = window.start - params.days * DAY;
    const counted = otherSubjects(params, inputs, window).filter((other) =>
      other.segments.some((segment) => segment.start >= from && segment.start < window.start),
    );
    const ids = counted.map((other) => other.id);
    Object.assign(details, {
      countedFrom: iso(from),
      counted: counted.length,
      countedIds: ids.length ? ids.join(', ') : null,
    });
    const evidence = [...window.evidence, ...counted.flatMap((other) => other.evidence)];
    const span = `in the ${params.days} days before ${startWords(window)}, from ${iso(from)}`;
    const whose = holder === 'The holder' ? 'the holder’s' : `${holder}’s`;
    const counts = `${counted.length ? counted.length : 'None'} of ${whose} other ${params.intervalDescribes} on file started ${span}${ids.length ? `: ${listedIds(ids)}` : ''}; the rule asks for at least ${params.atLeast}.`;
    if (counted.length < params.atLeast)
      return result('supported', 'attention', 'too_few_before', counts, evidence, details);
    return result('supported', 'pass', 'enough_before', counts, evidence, details);
  },
};

// A flight within stated dates ------------------------------------------------------------------------------------

export interface TimeWithinDatesParams extends FlightTimeParams {
  from: string;
  through: string;
  datesDescribe: string;
  select?: Selection;
  field?: string;
  expected?: Scalar[];
}

export const timeWithinDatesV1: CheckKind<TimeWithinDatesParams> = {
  id: 'time.within-dates',
  version: 1,
  title: 'A flight within stated dates',
  description:
    'With field and expected, the latest selected subject record must hold one of the expected values (such as a plan citing a certificate): none is insufficient, another value needs attention. Then, does the local calendar date of the flight’s time (the reported takeoff, else the operator’s flight record, else the planned start), in the organization’s time zone (UTC without one), fall from from through through? A date before or after needs attention and the sentence gives the dates and the flight’s date. No flight time is insufficient, reason record_not_on_file.',
  inputs: [
    {
      name: 'subject',
      description: 'The record whose value the rule expects, such as the flight’s plan.',
      optional: true,
    },
    ...flightTimeInputs,
  ],
  details: [
    ...flightTimeDetails,
    { name: 'flightDay', description: 'The local calendar date of the flight’s time; null when none.' },
    { name: 'value', description: 'The value of the field read, with field; otherwise null.' },
  ],
  summaryValues: ['flightStart'],
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['from', 'through', 'datesDescribe'],
    properties: {
      from: calendarDateSchema,
      through: calendarDateSchema,
      datesDescribe: { type: 'string', minLength: 1, maxLength: 300 },
      select: selectionSchema,
      field: fieldPath,
      expected: scalars,
      ...flightTimeSchema,
    },
    anyOf: [
      { required: ['reportedStartField'] },
      { required: ['recordedStartField'] },
      { required: ['plannedStartField'] },
    ],
    dependencies: { ...flightTimeDependencies, field: ['expected'], expected: ['field'], select: ['field'] },
  },
  evaluate(params, inputs, clock) {
    const window = flightWindow(params, inputs);
    const details: CheckDetails = { ...windowDetails(window), flightDay: null, value: null };
    let subjectEvidence: CheckObservation[] = [];
    let cited = '';
    if (params.field !== undefined) {
      const latest = latestObservations(current(inputs.subject, params.select));
      const label = labelOf(params.field, latest, params.select);
      const values = [
        ...new Set(
          latest.flatMap((observation): Scalar[] => {
            const value = observationField(observation, params.field!);
            return typeof value === 'string' && value.trim() ? [value] : typeof value === 'number' ? [value] : [];
          }),
        ),
      ];
      const shown = (value: Scalar) => valueLabel(params.field!, value, latest, params.select);
      if (!values.length)
        return result(
          'insufficient',
          'pending',
          'value_missing',
          `No value is recorded for ${label}.`,
          latest,
          details,
        );
      if (values.length > 1)
        return result(
          'conflicting',
          'attention',
          'values_disagree',
          `Records at the same time state different values for ${label}: ${values.map(shown).join(', ')}.`,
          latest,
          details,
        );
      details.value = values[0]!;
      if (!params.expected!.includes(values[0]!))
        return result(
          'supported',
          'attention',
          'value_unexpected',
          `The latest recorded value for ${label} is ${shown(values[0]!)}. Expected ${params.expected!.map(shown).join(' or ')}.`,
          latest,
          details,
        );
      subjectEvidence = latest;
      cited = `${sentenceCase(label)} is ${shown(values[0]!)}. `;
    }
    if (!window) return noFlightTime(params.datesDescribe, details);
    const zone = clock.timeZone ?? 'UTC';
    const calendar = zoneCalendar(zone) ?? zoneCalendar('UTC')!;
    const day = localDate(calendar, window.start);
    details.flightDay = day;
    const evidence = [...subjectEvidence, ...window.evidence];
    const dates = `from ${params.from} through ${params.through}`;
    const flight = `${startWords(window)}, on ${day}`;
    if (!validCalendarDate(params.from) || !validCalendarDate(params.through) || params.through < params.from)
      return result(
        'insufficient',
        'pending',
        'dates_invalid',
        `The dates the rule states, ${dates}, are not calendar dates in order.`,
        evidence,
        details,
      );
    if (day < params.from || day > params.through)
      return result(
        'supported',
        'attention',
        day < params.from ? 'before_dates' : 'after_dates',
        `${cited}The flight’s time is ${flight}, ${day < params.from ? 'before' : 'after'} ${params.datesDescribe}, ${dates}.`,
        evidence,
        details,
      );
    return result(
      'supported',
      'pass',
      'within_dates',
      `${cited}The flight’s time is ${flight}, within ${params.datesDescribe}, ${dates}.`,
      evidence,
      details,
    );
  },
};

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export const flightCheckKinds: readonly CheckKind[] = [
  recordBeforeFlightV1,
  intervalsAtOnceV1,
  intervalsCountedBeforeV1,
  timeWithinDatesV1,
];
for (const kind of flightCheckKinds) registerCheckKind(kind);
