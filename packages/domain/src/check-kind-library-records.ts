import {
  findOperatorRecordDefinition,
  missingFields,
  missingRequiredFields,
  missingReplayFields,
  ObservationFieldPathPattern,
  ObservationTypeIdPattern,
  recordFieldFilled,
} from '@ledger/contracts';
import {
  latestObservations,
  observationField,
  registerCheckKind,
  spanStart,
  utcMillis,
  type CheckInputs,
  type CheckKind,
  type CheckObservation,
  type CheckResult,
  valueIsOneOf,
} from './check-kinds.js';
import { quantityText, textUnitSchema, type TextUnit } from './quantities.js';
import { fieldLabel, recordFieldLabels, recordTitle, sentenceStart, valueLabel } from './field-labels.js';
import { observationRegistry } from './observation-registry.js';
import { placedTime } from './day-precision.js';

// Check kinds for record-keeping rules: records, dates, intervals, duty and rest, quantities against limits, values
// and occurrences. Each kind, its parameters and inputs are listed in docs/design/record-check-kinds.md.
//
// Every kind here can narrow its inputs to one operator record type and to observations whose fields hold given
// values. Replaced and withdrawn observations never reach a kind: the observation reads leave them out.
const HOUR = 3_600_000;

export type Scalar = string | number | boolean;
export type Condition = { field: string; oneOf: Scalar[] } | { field: string; filled: true };

/** Which observations of an input a kind reads: one operator record type, and conditions on fields. */
export interface Selection {
  recordType?: string;
  recordVersion?: number;
  where?: Condition[];
}

export interface Segment {
  start: number;
  end: number;
}

export const fieldPath = { type: 'string', pattern: ObservationFieldPathPattern, maxLength: 400 } as const;
const recordTypeSchema = { type: 'string', pattern: ObservationTypeIdPattern, maxLength: 100 } as const;
export const scalar = { type: ['string', 'number', 'boolean'], maxLength: 1000 } as const;
export const scalars = { type: 'array', minItems: 1, maxItems: 50, uniqueItems: true, items: scalar } as const;
const conditionSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['field', 'oneOf'],
      properties: { field: fieldPath, oneOf: scalars },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['field', 'filled'],
      properties: { field: fieldPath, filled: { const: true } },
    },
  ],
} as const;
const whereSchema = { type: 'array', minItems: 1, maxItems: 10, items: conditionSchema } as const;
export const selectionSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { recordType: recordTypeSchema, recordVersion: { type: 'integer', minimum: 1 }, where: whereSchema },
  dependencies: { recordType: ['recordVersion'], recordVersion: ['recordType'] },
} as const;
const hours = { type: 'number', exclusiveMinimum: 0, maximum: 100_000 } as const;

function result(
  evidenceState: CheckResult['evidenceState'],
  outcome: CheckResult['outcome'],
  reasonCode: string,
  summary: string,
  evidence: readonly CheckObservation[],
  nextBoundary?: number,
): CheckResult {
  return {
    evidenceState,
    outcome,
    reasonCode,
    summary,
    evidence: [...new Set(evidence.map((observation) => observation.id))],
    ...(nextBoundary === undefined || !Number.isFinite(nextBoundary)
      ? {}
      : { nextBoundary: new Date(nextBoundary).toISOString() }),
  };
}

function holds(observation: CheckObservation, condition: Condition): boolean {
  const value = observationField(observation, condition.field);
  if ('filled' in condition) return recordFieldFilled(value);
  return valueIsOneOf(value, condition.oneOf);
}

/** The observations of one input that match the selection, newest first. */
export function current(
  observations: readonly CheckObservation[] | undefined,
  selection: Selection | undefined,
): CheckObservation[] {
  return (observations ?? []).filter((observation) => {
    if (selection?.recordType !== undefined) {
      if (observationField(observation, 'values.recordType') !== selection.recordType) return false;
      if (observationField(observation, 'values.recordVersion') !== selection.recordVersion) return false;
    }
    return (selection?.where ?? []).every((condition) => holds(observation, condition));
  });
}

/** What a person calls the records a selection takes: the record type's title, or the fallback words. */
export function describeSelection(selection: Selection | undefined, fallback: string): string {
  return selection?.recordType && selection.recordVersion !== undefined
    ? recordTitle(selection.recordType, selection.recordVersion)
    : fallback;
}

/** A field of the selected observations as a person reads it (field-labels.ts). */
export function labelOf(path: string, observations: readonly CheckObservation[] = [], selection?: Selection): string {
  return fieldLabel(path, observations, selection);
}

export function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function hoursText(millis: number): string {
  return `${Math.round((millis / HOUR) * 100) / 100} h`;
}

export function merged(segments: readonly Segment[]): Segment[] {
  const sorted = [...segments].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Segment[] = [];
  for (const segment of sorted) {
    const last = out.at(-1);
    if (last && segment.start <= last.end) last.end = Math.max(last.end, segment.end);
    else out.push({ ...segment });
  }
  return out;
}

function clipped(segments: readonly Segment[], from: number, to: number): Segment[] {
  return segments
    .map((segment) => ({ start: Math.max(segment.start, from), end: Math.min(segment.end, to) }))
    .filter((segment) => segment.end > segment.start);
}

/** The window stated by the latest window observation: its interval, or the named start and end fields. */
export function statedWindow(
  observation: CheckObservation,
  startField: string | undefined,
  endField: string | undefined,
): Segment | undefined {
  const start = utcMillis(observationField(observation, startField ?? 'interval.start'));
  const end = utcMillis(observationField(observation, endField ?? 'interval.end'));
  return start !== undefined && end !== undefined && end > start ? { start, end } : undefined;
}

/** A recorded interval with a valid start and end. Without an end, `open` reaches forever; otherwise to its statement. */
export function recordedSegment(
  observation: CheckObservation,
  openEnd: 'stated' | 'open' | 'none',
): Segment | undefined {
  const start = utcMillis(observation.interval?.start);
  if (start === undefined) return undefined;
  if (observation.interval?.end === undefined) {
    if (openEnd === 'none') return undefined;
    return { start, end: openEnd === 'open' ? Infinity : utcMillis(observation.occurredAt)! + 1 };
  }
  const end = utcMillis(observation.interval.end);
  return end !== undefined && end > start ? { start, end } : undefined;
}

export function latestNumbers(observations: readonly CheckObservation[], field: string) {
  const latest = latestObservations(observations);
  const reported = latest.flatMap((observation) => {
    const value = observationField(observation, field);
    return typeof value === 'number' && Number.isFinite(value) ? [{ observation, value }] : [];
  });
  return { latest, reported, values: [...new Set(reported.map((item) => item.value))] };
}

// Record present and complete, version 2 --------------------------------------------------------------------------

export interface RecordCompleteV2Params {
  recordType: string;
  recordVersion: number;
  fields?: string[];
  where?: Condition[];
  whenAbsent?: 'insufficient' | 'not_applicable';
  scope?: 'latest' | 'each';
}

export const recordCompleteV2: CheckKind<RecordCompleteV2Params> = {
  id: 'record.complete',
  version: 2,
  title: 'Record present and complete',
  description:
    'The latest operator record of the given type (or each one, with scope each) that matches the conditions has a value in every required field, or in the listed fields. Absent, null and blank values are missing; false is an answer. With no such record the result is insufficient, or not applicable when whenAbsent is not_applicable: for records made only when something happens.',
  inputs: [{ name: 'record', description: 'Operator-record observations that may carry the record.' }],
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['recordType', 'recordVersion'],
    properties: {
      recordType: recordTypeSchema,
      recordVersion: { type: 'integer', minimum: 1 },
      fields: {
        type: 'array',
        minItems: 1,
        maxItems: 100,
        uniqueItems: true,
        items: { type: 'string', pattern: '^[a-z][a-zA-Z0-9]*$' },
      },
      where: whereSchema,
      whenAbsent: { enum: ['insufficient', 'not_applicable'] },
      scope: { enum: ['latest', 'each'] },
    },
  },
  evaluate(params, inputs) {
    const label = recordTitle(params.recordType, params.recordVersion);
    const records = current(inputs.record, params);
    if (!records.length)
      return params.whenAbsent === 'not_applicable'
        ? result('not_applicable', 'not_applicable', 'record_not_present', `No ${label} is held.`, [])
        : result('insufficient', 'attention', 'record_missing', `No ${label} is held.`, []);
    const definition = findOperatorRecordDefinition(observationRegistry(), params.recordType, params.recordVersion);
    const unknown = (params.fields ?? []).filter(
      (name) => !definition?.fields.some((field) => field.name === name && !field.replayOnly),
    );
    if (!definition || unknown.length)
      return result(
        'insufficient',
        'pending',
        'record_type_unavailable',
        definition
          ? `The ${label} has no recordable field ${unknown.map((name) => `“${name}”`).join(', ')}.`
          : `The ${label} is not a registered kind of record.`,
        records.slice(0, 1),
      );
    const checked = params.scope === 'each' ? records : records.slice(0, 1);
    const missing = checked.flatMap((record) => {
      const body = (observationField(record, 'values.record') ?? {}) as Record<string, unknown>;
      const names = params.fields
        ? missingFields(definition, body, params.fields)
        : missingRequiredFields(definition, body);
      return names.length ? [{ record, names }] : [];
    });
    const thin = [
      ...new Set(
        checked.flatMap((record) =>
          missingReplayFields(definition, (observationField(record, 'values.record') ?? {}) as Record<string, unknown>),
        ),
      ),
    ];
    const labels = (names: readonly string[]) =>
      recordFieldLabels(params.recordType, params.recordVersion, names).join(', ');
    const replayNote = thin.length ? ` Replay detail not recorded: ${labels(thin)}.` : '';
    const which = params.scope === 'each' ? `${checked.length} ${label} record(s)` : `The latest ${label}`;
    if (missing.length)
      return result(
        'insufficient',
        'attention',
        'record_incomplete',
        params.scope === 'each'
          ? `${missing.length} of ${which} are missing fields: ${missing.map((item) => `${item.record.id} (${labels(item.names)})`).join('; ')}.${replayNote}`
          : `${which} is missing: ${labels(missing[0]!.names)}.${replayNote}`,
        missing.map((item) => item.record),
      );
    return result(
      'supported',
      'pass',
      'record_complete',
      `${which} ${params.scope === 'each' ? 'are' : 'is'} complete.${replayNote}`,
      checked,
    );
  },
};

// Date within the previous N calendar months, version 2 ------------------------------------------------------------

export interface DateWithinMonthsV2Params {
  select?: Selection;
  field: string;
  months: number;
  nameField?: string;
  sameWhen?: string[];
}

const calendarDate = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Milliseconds at UTC midnight of a calendar date, or of a UTC instant's UTC date. Time zones play no part. */
function utcDay(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const date = calendarDate.exec(value);
  if (date) {
    const [year, month, day] = [Number(date[1]), Number(date[2]) - 1, Number(date[3])];
    const time = Date.UTC(year, month, day);
    const check = new Date(time);
    return check.getUTCFullYear() === year && check.getUTCMonth() === month && check.getUTCDate() === day
      ? time
      : undefined;
  }
  const time = utcMillis(value);
  return time === undefined ? undefined : Math.floor(time / 86_400_000) * 86_400_000;
}

export const dateWithinMonthsV2: CheckKind<DateWithinMonthsV2Params> = {
  id: 'date.within-months',
  version: 2,
  title: 'Date within the previous N calendar months',
  description:
    'A date field of the latest selected observation falls within the previous N calendar months of the evaluation clock: a date in month M stays within through the last day of month M+N, by UTC calendar date. The answer changes at the first instant of month M+N+1. A date after the clock, or simultaneous dates that disagree, need attention; no date is insufficient. Simultaneous records disagree only when they are about the same thing: with sameWhen, only records that hold the same values in each of its fields (the same course and the same completion evidence) are about the same thing, and of records about different things (three courses, or one course completed twice) the latest date is read and the sentence names it. Without sameWhen every simultaneous record is about the same thing. Records that disagree are named by the field nameField names, each with its date, and the summary says what to correct so one date stands.',
  inputs: [{ name: 'subject', description: 'Observations or operator records that carry the date field.' }],
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['field', 'months'],
    properties: {
      select: selectionSchema,
      field: fieldPath,
      months: { type: 'integer', minimum: 1, maximum: 1200 },
      nameField: fieldPath,
      sameWhen: { type: 'array', minItems: 1, maxItems: 5, uniqueItems: true, items: fieldPath },
    },
  },
  evaluate(params, inputs, clock) {
    const now = utcMillis(clock.evaluatedAt)!;
    const latest = latestObservations(current(inputs.subject, params.select));
    const dated = latest.flatMap((observation) => {
      const day = utcDay(observationField(observation, params.field));
      return day === undefined ? [] : [{ observation, day }];
    });
    const label = labelOf(params.field, latest, params.select);
    if (!dated.length)
      return result('insufficient', 'pending', 'date_missing', `No valid date is reported for ${label}.`, latest);
    const nameOf = (observation: CheckObservation) => {
      const name = params.nameField === undefined ? undefined : observationField(observation, params.nameField);
      return typeof name === 'string' && name.trim() ? name.trim() : undefined;
    };
    // Records made together conflict only when they are about the same thing: the same values in every sameWhen field.
    const identity = (observation: CheckObservation) =>
      JSON.stringify((params.sameWhen ?? []).map((field) => observationField(observation, field) ?? null));
    const byThing = new Map<string, typeof dated>();
    for (const item of dated)
      byThing.set(identity(item.observation), [...(byThing.get(identity(item.observation)) ?? []), item]);
    const sameThing = [...byThing.values()].find((group) => new Set(group.map((item) => item.day)).size > 1);
    if (sameThing) {
      const named = sameThing
        .map((item) => {
          const name = nameOf(item.observation);
          const day = new Date(item.day).toISOString().slice(0, 10);
          return name ? `${day} (${name})` : day;
        })
        .sort();
      return result(
        'conflicting',
        'attention',
        'dates_disagree',
        `${sameThing.length} records made at the same time give different dates for ${label}: ${named.join(', ')}. Correct the date that is wrong, or record the older one as replaced by the newer, so one date stands.`,
        sameThing.map((item) => item.observation),
      );
    }
    const newestDay = Math.max(...dated.map((item) => item.day));
    const newest = dated.filter((item) => item.day === newestDay);
    const evidence = newest.map((item) => item.observation);
    const recorded = new Date(newestDay);
    // Among records of different things made together, the sentence names the one whose date it read.
    const newestName = byThing.size > 1 ? nameOf(newest[0]!.observation) : undefined;
    const day = `${recorded.toISOString().slice(0, 10)}${newestName ? ` (${newestName})` : ''}`;
    if (newestDay > now)
      return result(
        'conflicting',
        'attention',
        'date_after_clock',
        `${sentenceStart(label)}, ${day}, is after the evaluation time.`,
        evidence,
      );
    const boundary = Date.UTC(recorded.getUTCFullYear(), recorded.getUTCMonth() + params.months + 1, 1);
    const through = new Date(boundary - 86_400_000).toISOString().slice(0, 10);
    return now < boundary
      ? result(
          'supported',
          'pass',
          'date_within_months',
          `${sentenceStart(label)}, ${day}, is within the previous ${params.months} calendar months, through ${through}.`,
          evidence,
          boundary,
        )
      : result(
          'supported',
          'attention',
          'date_outside_months',
          `${sentenceStart(label)}, ${day}, was within the previous ${params.months} calendar months only through ${through}.`,
          evidence,
        );
  },
};

// A recorded interval covers a window, version 2 ------------------------------------------------------------------

export interface IntervalCoversWindowV2Params {
  select?: Selection;
  openEnd: 'stated' | 'open';
  windowSelect?: Selection;
  windowStartField?: string;
  windowEndField?: string;
}

export const intervalCoversWindowV2: CheckKind<IntervalCoversWindowV2Params> = {
  id: 'interval.covers-window',
  version: 2,
  title: 'A recorded interval covers a window',
  description:
    'Selected intervals, joined where they touch or overlap, cover the window. The window is the latest selected window observation (its interval, or the named start and end fields) when the rule reads one, and otherwise the evaluation instant, in which case the answer changes when covering ends or a later interval begins. An interval without an end covers up to the time it was stated, or without limit when openEnd is open. With conditions on a role and a person field, this answers whether a named role is assigned.',
  inputs: [
    { name: 'interval', description: 'Observations or operator records whose intervals may cover the window.' },
    { name: 'window', description: 'An observation or operator record stating the window to cover.', optional: true },
  ],
  summaryRecordValues: ['nextBoundary'],
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['openEnd'],
    properties: {
      select: selectionSchema,
      openEnd: { enum: ['stated', 'open'] },
      windowSelect: selectionSchema,
      windowStartField: fieldPath,
      windowEndField: fieldPath,
    },
  },
  evaluate(params, inputs, clock) {
    const recorded = current(inputs.interval, params.select).flatMap((observation) => {
      const segment = recordedSegment(observation, params.openEnd);
      return segment ? [{ observation, segment }] : [];
    });
    const segments = merged(recorded.map((item) => item.segment));
    const subject = describeSelection(params.select, 'recorded interval');
    if (inputs.window !== undefined) {
      const windowObservation = current(inputs.window, params.windowSelect)[0];
      const window =
        windowObservation && statedWindow(windowObservation, params.windowStartField, params.windowEndField);
      if (!window)
        return result(
          'insufficient',
          'pending',
          'window_missing',
          'The window to cover has no valid start and end.',
          windowObservation ? [windowObservation] : [],
        );
      const overlapping = recorded.filter(({ segment }) => segment.start < window.end && segment.end > window.start);
      const evidence = [windowObservation, ...overlapping.map((item) => item.observation)];
      return segments.some((segment) => segment.start <= window.start && segment.end >= window.end)
        ? result(
            'supported',
            'pass',
            'window_covered',
            `Selected ${subject}s, joined, cover the whole window.`,
            evidence,
          )
        : result('insufficient', 'attention', 'window_not_covered', `No ${subject} covers the whole window.`, evidence);
    }
    const now = utcMillis(clock.evaluatedAt)!;
    const covering = segments.find((segment) => segment.start <= now && now < segment.end);
    if (covering)
      return result(
        'supported',
        'pass',
        'window_covered',
        Number.isFinite(covering.end)
          ? `A ${subject} is in effect until ${new Date(covering.end).toISOString()}.`
          : `A ${subject} is in effect with no recorded end.`,
        recorded.filter(({ segment }) => segment.start <= now && now < segment.end).map((item) => item.observation),
        covering.end,
      );
    return result(
      'insufficient',
      'attention',
      'window_not_covered',
      `No ${subject} is in effect at the evaluation time.`,
      recorded
        .filter(({ segment }) => segment.end <= now)
        .slice(0, 1)
        .map((item) => item.observation),
      segments.find((segment) => segment.start > now)?.start,
    );
  },
};

// Duty and rest over recorded periods ------------------------------------------------------------------------------

export interface DutyWithinLimitsParams {
  dutySelect: Selection;
  restSelect: Selection;
  windowSelect?: Selection;
  windowStartField?: string;
  windowEndField?: string;
  maxDutyHours?: number;
  minRestHours?: number;
  restWithinHours?: number;
  maxRollingDutyHours?: number;
  rollingHours?: number;
  /** The organization records every duty period, so the time between two of them is rest. */
  dutyRecordComplete?: boolean;
}

interface Period {
  observation: CheckObservation;
  start: number;
  end?: number;
}

function periodsOf(observations: readonly CheckObservation[]): Period[] {
  return observations.flatMap((observation) => {
    const start = utcMillis(observation.interval?.start);
    if (start === undefined) return [];
    const end = observation.interval?.end === undefined ? undefined : utcMillis(observation.interval.end);
    return end !== undefined && end <= start ? [] : [{ observation, start, ...(end === undefined ? {} : { end }) }];
  });
}

/** The duty period being assessed: the latest one under way at the window, or started by the evaluation time. */
function assessedDuty(duties: readonly Period[], window: Segment | undefined, now: number): Period | undefined {
  const candidates = window
    ? duties.filter((duty) => duty.start < window.end && (duty.end === undefined || duty.end > window.start))
    : duties.filter((duty) => duty.start <= now);
  return [...candidates].sort((a, b) => b.start - a.start)[0];
}

type RestBefore =
  | { kind: 'first'; evidence: CheckObservation[] }
  | { kind: 'unknown'; words: string; evidence: CheckObservation[] }
  | { kind: 'counted'; longest: number; words: string; evidence: CheckObservation[] };

/**
 * The longest continuous rest in the hours before a duty period: recorded rest, and when the duty record is complete
 * also the time between two recorded duty periods. A person with no earlier period on record has no rest to count.
 */
function restBefore(
  duty: Period,
  duties: readonly Period[],
  rests: readonly Period[],
  withinHours: number,
  dutyRecordComplete: boolean,
): RestBefore {
  const from = duty.start - withinHours * HOUR;
  const earlierDuties = duties.filter((other) => other !== duty && other.start < duty.start);
  if (!earlierDuties.length && !rests.some((rest) => rest.start < duty.start)) return { kind: 'first', evidence: [] };
  const recorded = rests.filter((rest) => rest.end !== undefined && rest.start < duty.start && rest.end > from);
  const recordedSegments = clipped(
    recorded.map((rest) => ({ start: rest.start, end: rest.end! })),
    from,
    duty.start,
  );
  const between = dutyRecordComplete && earlierDuties.length ? dutyGaps(earlierDuties, from, duty.start) : undefined;
  const evidence = [...recorded.map((rest) => rest.observation), ...(between?.evidence ?? [])];
  if (between?.openEnded)
    return { kind: 'unknown', words: 'a duty period before the duty period has no recorded end', evidence };
  if (!recorded.length && !between)
    return { kind: 'unknown', words: `no rest is recorded in the ${withinHours} h before the duty period`, evidence };
  const gapSegments = between?.segments ?? [];
  const longest = merged([...recordedSegments, ...gapSegments]).reduce<Segment | undefined>(
    (most, segment) => (!most || segment.end - segment.start > most.end - most.start ? segment : most),
    undefined,
  );
  const overlaps = (segments: readonly Segment[]) =>
    longest !== undefined && segments.some((segment) => segment.start < longest.end && segment.end > longest.start);
  const fromRecord = overlaps(recordedSegments);
  const fromGap = overlaps(gapSegments) || (!fromRecord && between !== undefined);
  const words =
    fromRecord && fromGap
      ? 'rest, taken from recorded rest and the time between recorded duty periods,'
      : fromGap
        ? 'rest, taken from the time between recorded duty periods,'
        : 'recorded rest';
  return { kind: 'counted', longest: longest ? longest.end - longest.start : 0, words, evidence };
}

/** The times between recorded duty periods within [from, to), from the end of the first one on record. */
function dutyGaps(
  earlier: readonly Period[],
  from: number,
  to: number,
): { segments: Segment[]; evidence: CheckObservation[]; openEnded: boolean } {
  const latest = [...earlier].sort((a, b) => b.start - a.start)[0]!;
  const openEnded = latest.end === undefined;
  const covered = merged(earlier.map((other) => ({ start: other.start, end: other.end ?? to })));
  const evidence = earlier.filter((other) => (other.end ?? to) > from).map((other) => other.observation);
  const segments: Segment[] = [];
  let cursor = covered[0]!.end;
  for (const segment of [...covered.slice(1), { start: to, end: to }]) {
    if (segment.start > cursor) segments.push({ start: cursor, end: segment.start });
    cursor = Math.max(cursor, segment.end);
  }
  return {
    segments: clipped(segments, from, to),
    evidence: evidence.length ? evidence : [latest.observation],
    openEnded,
  };
}

export const dutyWithinLimitsV1: CheckKind<DutyWithinLimitsParams> = {
  id: 'duty.within-limits',
  version: 1,
  title: 'Duty and rest within limits',
  description:
    'Arithmetic over recorded duty and rest periods of one person. The assessed duty period is the latest selected duty period overlapping the window (when the rule reads one) or started by the evaluation time. Each limit the rule sets is checked: the assessed duty period lasts at most maxDutyHours; within the restWithinHours before it starts there is one continuous recorded rest of at least minRestHours; and the duty recorded in the rollingHours ending when it ends totals at most maxRollingDutyHours. Overlapping periods are joined. Only recorded rest counts, unless dutyRecordComplete says every duty period is on record: then the time between two recorded duty periods is rest too, and the sentence says so. A person with no earlier duty or rest period on record has no rest before the duty period to count, and that is said, not found. A missing period or end is insufficient.',
  inputs: [
    { name: 'periods', description: 'Recorded duty and rest periods of the person, read in full.' },
    {
      name: 'window',
      description: 'An observation or operator record stating the window being staffed.',
      optional: true,
    },
  ],
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['dutySelect', 'restSelect'],
    properties: {
      dutySelect: selectionSchema,
      restSelect: selectionSchema,
      windowSelect: selectionSchema,
      windowStartField: fieldPath,
      windowEndField: fieldPath,
      maxDutyHours: hours,
      minRestHours: hours,
      restWithinHours: hours,
      maxRollingDutyHours: hours,
      rollingHours: hours,
      dutyRecordComplete: { type: 'boolean' },
    },
    anyOf: [{ required: ['maxDutyHours'] }, { required: ['minRestHours'] }, { required: ['maxRollingDutyHours'] }],
    dependencies: {
      minRestHours: ['restWithinHours'],
      restWithinHours: ['minRestHours'],
      maxRollingDutyHours: ['rollingHours'],
      rollingHours: ['maxRollingDutyHours'],
    },
  },
  evaluate(params, inputs, clock) {
    const now = utcMillis(clock.evaluatedAt)!;
    const duties = periodsOf(current(inputs.periods, params.dutySelect));
    const rests = periodsOf(current(inputs.periods, params.restSelect));
    let window: Segment | undefined;
    const evidence: CheckObservation[] = [];
    if (inputs.window !== undefined) {
      const windowObservation = current(inputs.window, params.windowSelect)[0];
      window = windowObservation && statedWindow(windowObservation, params.windowStartField, params.windowEndField);
      if (!window)
        return result(
          'insufficient',
          'pending',
          'window_missing',
          'The window being staffed has no valid start and end.',
          windowObservation ? [windowObservation] : [],
        );
      evidence.push(windowObservation!);
    }
    const duty = assessedDuty(duties, window, now);
    if (!duty)
      return result(
        'insufficient',
        'attention',
        'duty_period_missing',
        window ? 'No recorded duty period overlaps the window.' : 'No recorded duty period has started.',
        evidence,
      );
    evidence.push(duty.observation);
    const gaps: string[] = [];
    const exceeded: string[] = [];
    const met: string[] = [];
    const notes: string[] = [];
    if (params.maxDutyHours !== undefined) {
      if (duty.end === undefined) gaps.push('the duty period has no recorded end');
      else {
        const length = duty.end - duty.start;
        const statement = `the duty period lasts ${hoursText(length)} against at most ${params.maxDutyHours} h`;
        (length <= params.maxDutyHours * HOUR ? met : exceeded).push(statement);
      }
    }
    if (params.minRestHours !== undefined && params.restWithinHours !== undefined) {
      const rest = restBefore(duty, duties, rests, params.restWithinHours, params.dutyRecordComplete === true);
      evidence.push(...rest.evidence);
      if (rest.kind === 'first') notes.push(`no earlier duty or rest period of this person is on record`);
      else if (rest.kind === 'unknown') gaps.push(rest.words);
      else {
        const statement = `the longest continuous ${rest.words} in the ${params.restWithinHours} h before the duty period is ${hoursText(rest.longest)} against at least ${params.minRestHours} h`;
        (rest.longest >= params.minRestHours * HOUR ? met : exceeded).push(statement);
      }
    }
    if (params.maxRollingDutyHours !== undefined && params.rollingHours !== undefined) {
      if (duty.end === undefined) gaps.push('the duty period has no recorded end');
      else {
        const from = duty.end - params.rollingHours * HOUR;
        const inRange = duties.filter((other) => other.start < duty.end! && (other.end ?? Infinity) > from);
        evidence.push(...inRange.map((other) => other.observation));
        if (inRange.some((other) => other.end === undefined))
          gaps.push(`a duty period in the ${params.rollingHours} h ending with the duty period has no recorded end`);
        else {
          const total = merged(
            clipped(
              inRange.map((other) => ({ start: other.start, end: other.end! })),
              from,
              duty.end,
            ),
          ).reduce((sum, segment) => sum + segment.end - segment.start, 0);
          const statement = `duty in the ${params.rollingHours} h ending with the duty period totals ${hoursText(total)} against at most ${params.maxRollingDutyHours} h`;
          (total <= params.maxRollingDutyHours * HOUR ? met : exceeded).push(statement);
        }
      }
    }
    const sentence = (parts: string[]) => `${parts.join('; ')}.`.replace(/^./, (first) => first.toUpperCase());
    if (exceeded.length)
      return result(
        'supported',
        'attention',
        'duty_limit_exceeded',
        sentence([...exceeded, ...gaps, ...met, ...notes]),
        evidence,
      );
    if (gaps.length)
      return result(
        'insufficient',
        'attention',
        'duty_record_insufficient',
        sentence([...gaps, ...met, ...notes]),
        evidence,
      );
    return result('supported', 'pass', 'duty_within_limits', sentence([...met, ...notes]), evidence);
  },
};

// A quantity within a limit, version 2 -----------------------------------------------------------------------------

export const comparisons = {
  at_most: { holds: (value: number, limit: number) => value <= limit, words: 'at most', margin: -1 },
  at_least: { holds: (value: number, limit: number) => value >= limit, words: 'at least', margin: 1 },
  below: { holds: (value: number, limit: number) => value < limit, words: 'below', margin: -1 },
  above: { holds: (value: number, limit: number) => value > limit, words: 'above', margin: 1 },
} as const;

export interface ValueWithinLimitV2Params {
  select?: Selection;
  field: string;
  comparison: keyof typeof comparisons;
  limit?: number;
  limitSelect?: Selection;
  limitField?: string;
  offsetField?: string;
  measureFrom?: 'zero' | 'limit_start';
  unit?: string;
  textUnit?: TextUnit;
}

export const valueWithinLimitV2: CheckKind<ValueWithinLimitV2Params> = {
  id: 'value.within-limit',
  version: 2,
  title: 'Value within a limit',
  description:
    'A numeric field of the latest selected observation is compared with a limit: a fixed limit, or a numeric field of the latest selected limit observation. Measured from the limit start, the value is the latest value less the latest value recorded at or before the limit observation begins, and a limit whose interval has ended no longer applies. An offset field of the limit observation is added to the value. The summary states the margin to the limit. A missing value, limit, baseline or offset is insufficient; simultaneous reports that disagree conflict. With unit, the unit the value is stored in, each quantity is stated with it; with textUnit too, the unit the rule’s text uses, each is stated in that unit with the stored value in parentheses.',
  inputs: [
    { name: 'quantity', description: 'Observations or operator records that carry the value.' },
    { name: 'limit', description: 'Observations or operator records that carry the limit.', optional: true },
  ],
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['field', 'comparison'],
    properties: {
      select: selectionSchema,
      field: fieldPath,
      comparison: { enum: Object.keys(comparisons) },
      limit: { type: 'number' },
      limitSelect: selectionSchema,
      limitField: fieldPath,
      offsetField: fieldPath,
      measureFrom: { enum: ['zero', 'limit_start'] },
      unit: { type: 'string', minLength: 1, maxLength: 20 },
      textUnit: textUnitSchema,
    },
    oneOf: [{ required: ['limit'] }, { required: ['limitField'] }],
    dependencies: {
      limitSelect: ['limitField'],
      offsetField: ['limitField'],
      measureFrom: ['limitField'],
      textUnit: ['unit'],
    },
  },
  evaluate(params, inputs, clock) {
    const now = utcMillis(clock.evaluatedAt)!;
    const quantities = current(inputs.quantity, params.select);
    const evidence: CheckObservation[] = [];
    const stated = (quantity: number) =>
      params.unit === undefined ? String(quantity) : quantityText(quantity, params.unit, params.textUnit);
    let limit = params.limit;
    let offset = 0;
    let since: number | undefined;
    const notes: string[] = [];
    if (params.limitField !== undefined) {
      const limits = latestNumbers(current(inputs.limit, params.limitSelect), params.limitField);
      const limitLabel = labelOf(params.limitField, limits.latest, params.limitSelect);
      if (!limits.reported.length)
        return result(
          'insufficient',
          'attention',
          'limit_missing',
          `No value is recorded for ${limitLabel}.`,
          limits.latest,
        );
      evidence.push(...limits.reported.map((item) => item.observation));
      if (limits.values.length > 1)
        return result(
          'conflicting',
          'attention',
          'limits_disagree',
          `Observations at the same time report different values for ${limitLabel}: ${limits.values.join(', ')}.`,
          evidence,
        );
      limit = limits.values[0]!;
      const limitObservation = limits.reported[0]!.observation;
      if (params.measureFrom === 'limit_start') {
        const ended = utcMillis(limitObservation.interval?.end);
        if (ended !== undefined && ended <= now)
          return result(
            'not_applicable',
            'not_applicable',
            'limit_ended',
            `The recorded limit ended at ${new Date(ended).toISOString()}.`,
            evidence,
          );
        since = utcMillis(spanStart(limitObservation));
      }
      if (params.offsetField !== undefined) {
        const value = observationField(limitObservation, params.offsetField);
        const offsetLabel = labelOf(params.offsetField, [limitObservation], params.limitSelect);
        if (typeof value !== 'number' || !Number.isFinite(value))
          return result(
            'insufficient',
            'attention',
            'offset_missing',
            `No value is recorded for ${offsetLabel}.`,
            evidence,
          );
        offset = value;
        notes.push(`plus ${offsetLabel} ${stated(value)}`);
      }
    }
    const values = latestNumbers(quantities, params.field);
    const label = labelOf(params.field, values.latest.length ? values.latest : quantities, params.select);
    if (!values.reported.length)
      return result('insufficient', 'pending', 'value_missing', `No value is reported for ${label}.`, [
        ...evidence,
        ...values.latest,
      ]);
    evidence.push(...values.reported.map((item) => item.observation));
    if (values.values.length > 1)
      return result(
        'conflicting',
        'attention',
        'values_disagree',
        `Observations at the same time report different values for ${label}: ${values.values.join(', ')}.`,
        evidence,
      );
    let value = values.values[0]!;
    if (since !== undefined) {
      const before = latestNumbers(
        quantities.filter((observation) => Date.parse(spanStart(observation)) <= since!),
        params.field,
      );
      if (!before.reported.length)
        return result(
          'insufficient',
          'attention',
          'baseline_missing',
          `No value is recorded for ${label} at or before the limit began.`,
          evidence,
        );
      evidence.push(...before.reported.map((item) => item.observation));
      if (before.values.length > 1)
        return result(
          'conflicting',
          'attention',
          'values_disagree',
          `Observations at the same time report different values for ${label} at the limit start: ${before.values.join(', ')}.`,
          evidence,
        );
      notes.unshift(`less ${stated(before.values[0]!)} at the limit start`);
      value -= before.values[0]!;
    }
    const used = round(value + offset);
    const comparison = comparisons[params.comparison];
    const margin = round((used - limit!) * comparison.margin);
    const measured = notes.length ? ` (latest ${stated(values.values[0]!)}, ${notes.join(', ')})` : '';
    const statement = `${sentenceStart(label)} is ${stated(used)}${measured}; the limit is ${comparison.words} ${stated(limit!)}; the margin is ${stated(margin)}.`;
    return comparison.holds(used, limit!)
      ? result('supported', 'pass', 'value_within_limit', statement, evidence)
      : result('supported', 'attention', 'value_outside_limit', statement, evidence);
  },
};

// A recorded value is one of the expected values -------------------------------------------------------------------

export interface ValueOneOfParams {
  select?: Selection;
  field: string;
  expected: Scalar[];
  undetermined?: Scalar[];
}

export const valueOneOfV1: CheckKind<ValueOneOfParams> = {
  id: 'value.one-of',
  version: 1,
  title: 'Recorded value is one of the expected values',
  description:
    'A field of the latest selected observation holds one of the expected values. A value the rule lists as undetermined is insufficient; any other value needs attention. No value is insufficient; simultaneous reports that disagree conflict.',
  inputs: [{ name: 'subject', description: 'Observations or operator records that carry the field.' }],
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['field', 'expected'],
    properties: { select: selectionSchema, field: fieldPath, expected: scalars, undetermined: scalars },
  },
  evaluate(params, inputs) {
    const latest = latestObservations(current(inputs.subject, params.select));
    const reported = latest.flatMap((observation) => {
      const value = observationField(observation, params.field);
      return recordFieldFilled(value) && ['string', 'number', 'boolean'].includes(typeof value)
        ? [{ observation, value: value as Scalar }]
        : [];
    });
    const label = labelOf(params.field, latest, params.select);
    const shown = (value: Scalar) => valueLabel(params.field, value, latest, params.select);
    if (!reported.length)
      return result('insufficient', 'pending', 'value_missing', `No value is recorded for ${label}.`, latest);
    const evidence = reported.map((item) => item.observation);
    const values = [...new Set(reported.map((item) => item.value))];
    if (values.length > 1)
      return result(
        'conflicting',
        'attention',
        'values_disagree',
        `Observations at the same time report different values for ${label}: ${values.map(shown).join(', ')}.`,
        evidence,
      );
    const value = values[0]!;
    const statement = `The latest recorded value for ${label} is ${shown(value)}.`;
    if (params.expected.includes(value)) return result('supported', 'pass', 'value_expected', statement, evidence);
    if (params.undetermined?.includes(value))
      return result('insufficient', 'attention', 'value_undetermined', statement, evidence);
    return result(
      'supported',
      'attention',
      'value_unexpected',
      `${statement} Expected ${params.expected.map(shown).join(' or ')}.`,
      evidence,
    );
  },
};

// An occurrence is or is not recorded in a window ------------------------------------------------------------------

export interface OccurrenceInWindowParams {
  select?: Selection;
  expect: 'present' | 'absent';
  triggerSelect?: Selection;
  windowSelect?: Selection;
  windowStartField?: string;
  windowEndField?: string;
}

export const occurrenceInWindowV1: CheckKind<OccurrenceInWindowParams> = {
  id: 'occurrence.in-window',
  version: 1,
  title: 'An occurrence is or is not recorded in a window',
  description:
    'Whether a selected occurrence is recorded at a time in a window. With a trigger input, every selected trigger opens a window from its time to the evaluation time, and the rule does not apply while there is no trigger: for example a follow-up record after each event. With a window input, the window is the latest selected window observation; with neither, all recorded time up to the evaluation. When the occurrence is expected and missing the result is insufficient; when it is expected absent and recorded, it needs attention.',
  inputs: [
    { name: 'occurrence', description: 'Observations or operator records of the occurrence.' },
    {
      name: 'trigger',
      description: 'Observations or operator records that each call for an occurrence.',
      optional: true,
    },
    { name: 'window', description: 'An observation or operator record stating the window.', optional: true },
  ],
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['expect'],
    properties: {
      select: selectionSchema,
      expect: { enum: ['present', 'absent'] },
      triggerSelect: selectionSchema,
      windowSelect: selectionSchema,
      windowStartField: fieldPath,
      windowEndField: fieldPath,
    },
  },
  evaluate(params, inputs, clock) {
    const now = utcMillis(clock.evaluatedAt)!;
    const occurrences = current(inputs.occurrence, params.select);
    const subject = describeSelection(params.select, 'occurrence');
    const within = (window: Segment) =>
      occurrences.filter((observation) => {
        const at = Date.parse(spanStart(observation));
        return at >= window.start && at < window.end;
      });
    const windows: { window: Segment; opener?: CheckObservation }[] = [];
    if (inputs.trigger !== undefined) {
      const triggers = current(inputs.trigger, params.triggerSelect);
      if (!triggers.length)
        return result(
          'not_applicable',
          'not_applicable',
          'trigger_not_recorded',
          `No ${describeSelection(params.triggerSelect, 'triggering record')} is recorded.`,
          [],
        );
      for (const trigger of triggers)
        windows.push({ window: { start: Date.parse(spanStart(trigger)), end: now + 1 }, opener: trigger });
    } else if (inputs.window !== undefined) {
      const windowObservation = current(inputs.window, params.windowSelect)[0];
      const window =
        windowObservation && statedWindow(windowObservation, params.windowStartField, params.windowEndField);
      if (!window)
        return result(
          'insufficient',
          'pending',
          'window_missing',
          'The window has no valid start and end.',
          windowObservation ? [windowObservation] : [],
        );
      windows.push({ window, opener: windowObservation });
    } else windows.push({ window: { start: -Infinity, end: now + 1 } });
    const found = windows.map((item) => ({ ...item, matches: within(item.window) }));
    const openers = found.flatMap((item) => (item.opener ? [item.opener] : []));
    const matches = found.flatMap((item) => item.matches);
    if (params.expect === 'present') {
      const unmet = found.filter((item) => !item.matches.length);
      if (unmet.length)
        return result(
          'insufficient',
          'attention',
          'occurrence_not_recorded',
          inputs.trigger !== undefined
            ? `No ${subject} is recorded after ${unmet.length} of ${found.length} triggering record(s): ${unmet.map((item) => item.opener!.id).join(', ')}.`
            : `No ${subject} is recorded in the window.`,
          [...openers, ...matches],
        );
      return result('supported', 'pass', 'occurrence_recorded', `A ${subject} is recorded in each window.`, [
        ...openers,
        ...matches,
      ]);
    }
    if (matches.length)
      return result(
        'supported',
        'attention',
        'occurrence_recorded',
        `${new Set(matches.map((item) => item.id)).size} ${subject}(s) recorded in the window.`,
        [...openers, ...matches],
      );
    return result('supported', 'pass', 'occurrence_not_recorded', `No ${subject} is recorded in the window.`, openers);
  },
};

// A record made at least, and at most, a stated time before a window starts -----------------------------------------

export interface RecordMadeBeforeParams {
  select?: Selection;
  atField?: string;
  windowSelect?: Selection;
  startField: string;
  leadHours: number;
  maxLeadHours?: number;
}

export const recordMadeBeforeV1: CheckKind<RecordMadeBeforeParams> = {
  id: 'record.made-before',
  version: 1,
  title: 'A record is made at least, and at most, a stated time before a window starts',
  description:
    'Whether a selected record is made at least leadHours before the start the latest selected window observation states in startField and, with maxLeadHours, not more than maxLeadHours before it. A record is made at the instant in atField, or at its span start; a record placed by a date alone is read as made at the last instant of that day, and the summary says only the date is on record. One made in that span passes. Before the deadline, none made in the span yet is pending until the deadline; after it, one made later is reported as late, one made only earlier than the span as early, and none at all needs attention. No valid start is insufficient.',
  inputs: [
    { name: 'record', description: 'Observations or operator records, each made at one instant.' },
    { name: 'window', description: 'An observation or operator record stating the start.' },
  ],
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['startField', 'leadHours'],
    properties: {
      select: selectionSchema,
      atField: fieldPath,
      windowSelect: selectionSchema,
      startField: fieldPath,
      leadHours: { type: 'number', minimum: 0, maximum: 8760 },
      maxLeadHours: { type: 'number', exclusiveMinimum: 0, maximum: 8760 },
    },
  },
  details: [
    { name: 'startsAt', description: 'The start the window observation states.' },
    { name: 'dueBy', description: 'The last instant a record counts as made in time: the start less the lead.' },
    {
      name: 'notBefore',
      description: 'With maxLeadHours, the first instant a record counts as made in time; otherwise null.',
    },
    { name: 'madeAt', description: 'When the selected record reported was made, or null when none is.' },
  ],
  summaryValues: ['startsAt', 'dueBy', 'notBefore', 'madeAt'],
  evaluate(params, inputs, clock) {
    const now = utcMillis(clock.evaluatedAt)!;
    const windowObservation = current(inputs.window, params.windowSelect)[0];
    const start = windowObservation ? utcMillis(observationField(windowObservation, params.startField)) : undefined;
    if (start === undefined)
      return result(
        'insufficient',
        'pending',
        'start_missing',
        `No valid time is recorded for ${labelOf(params.startField, windowObservation ? [windowObservation] : [], params.windowSelect)}.`,
        windowObservation ? [windowObservation] : [],
      );
    const dueBy = start - params.leadHours * HOUR;
    const notBefore = params.maxLeadHours === undefined ? undefined : start - params.maxLeadHours * HOUR;
    const made = current(inputs.record, params.select)
      .flatMap((observation) => {
        const time = placedTime(observation, params.atField, 'latest');
        return time === undefined ? [] : [{ observation, ...time }];
      })
      .sort((left, right) => left.at - right.at);
    const madeWords = (item: { at: number; day?: string }) =>
      item.day === undefined
        ? `at ${new Date(item.at).toISOString()},`
        : `on ${item.day}; only the date is on record, so it is read as made at the end of that day,`;
    const subject = describeSelection(params.select, 'record');
    const startsAt = new Date(start).toISOString();
    const due = new Date(dueBy).toISOString();
    const earliest = notBefore === undefined ? undefined : new Date(notBefore).toISOString();
    // The span a record counts in, as a sentence states it.
    const span =
      earliest === undefined
        ? `by ${due}, ${params.leadHours} h before the start at ${startsAt}`
        : params.leadHours === 0
          ? `from ${earliest} to the start at ${startsAt}, not more than ${params.maxLeadHours} h before it`
          : `from ${earliest} to ${due}, between ${params.maxLeadHours} h and ${params.leadHours} h before the start at ${startsAt}`;
    const details = (madeAt: number | undefined) => ({
      startsAt,
      dueBy: due,
      notBefore: earliest ?? null,
      madeAt: madeAt === undefined ? null : new Date(madeAt).toISOString(),
    });
    const inTime = made.filter((item) => item.at <= dueBy && (notBefore === undefined || item.at >= notBefore));
    if (inTime.length)
      return {
        ...result('supported', 'pass', 'made_in_time', `A ${subject} was made ${madeWords(inTime[0]!)} ${span}.`, [
          windowObservation!,
          inTime[0]!.observation,
        ]),
        details: details(inTime[0]!.at),
      };
    const late = made.find((item) => item.at > dueBy);
    const early = made.filter((item) => notBefore !== undefined && item.at < notBefore).at(-1);
    if (late)
      return {
        ...result(
          'supported',
          'attention',
          'made_late',
          earliest === undefined
            ? `The earliest ${subject} was made ${madeWords(late)} after ${due}, ${params.leadHours} h before the start at ${startsAt}.`
            : `The earliest ${subject} made after ${earliest} was made ${madeWords(late)} after ${due}; it was due ${span}.`,
          [windowObservation!, late.observation],
        ),
        details: details(late.at),
      };
    if (now <= dueBy)
      return {
        ...result(
          'insufficient',
          'pending',
          'not_made_yet',
          earliest === undefined
            ? `No ${subject} is made yet; it is due ${span}.`
            : `No ${subject} is made yet in the span it counts in; it is due ${span}.${early ? ` The latest, made ${madeWords(early).replace(/,$/, '')}, is earlier than that.` : ''}`,
          early ? [windowObservation!, early.observation] : [windowObservation!],
          dueBy + 1,
        ),
        details: details(early?.at),
      };
    if (early)
      return {
        ...result(
          'supported',
          'attention',
          'made_early',
          `The latest ${subject} was made ${madeWords(early)} before ${earliest}; it was due ${span}.`,
          [windowObservation!, early.observation],
        ),
        details: details(early.at),
      };
    return {
      ...result('insufficient', 'attention', 'not_made', `No ${subject} was made ${span}.`, [windowObservation!]),
      details: details(undefined),
    };
  },
};

export const recordCheckKinds: readonly CheckKind[] = [
  recordCompleteV2,
  dateWithinMonthsV2,
  intervalCoversWindowV2,
  dutyWithinLimitsV1,
  valueWithinLimitV2,
  valueOneOfV1,
  occurrenceInWindowV1,
  recordMadeBeforeV1,
];
for (const kind of recordCheckKinds) registerCheckKind(kind);
