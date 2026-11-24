import type { CheckDetails } from '@ledger/contracts';
import { quantityText, textUnitSchema, type TextUnit } from './quantities.js';
import {
  comparisons,
  current,
  describeSelection,
  fieldPath,
  labelOf,
  latestNumbers,
  merged,
  recordedSegment,
  round,
  scalar,
  scalars,
  selectionSchema,
  statedWindow,
  type Scalar,
  type Segment,
  type Selection,
} from './check-kind-library-records.js';
import {
  latestObservations,
  observationField,
  registerCheckKind,
  spanStart,
  utcMillis,
  type CheckKind,
  type CheckObservation,
  type CheckResult,
} from './check-kinds.js';
import { sentenceStart } from './field-labels.js';
import { notDueSchema, notDueSentence, type NotDue } from './check-kind-not-due.js';
import { placedTime } from './day-precision.js';

// Check kinds that combine more than one record: a field compared across two inputs, a total derived from an opening
// balance and later additions, coverage of the intersection of two windows, and totals over calendar days or business
// days in a stated time zone. Each kind, its parameters and inputs are listed in docs/design/record-check-kinds.md.

const HOUR = 3_600_000;

export function result(
  evidenceState: CheckResult['evidenceState'],
  outcome: CheckResult['outcome'],
  reasonCode: string,
  summary: string,
  evidence: readonly CheckObservation[],
  details: CheckDetails,
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
    details,
  };
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function iso(time: number | undefined): string | null {
  return time === undefined ? null : new Date(time).toISOString();
}

function listed(values: readonly Scalar[]): string | null {
  const distinct = [...new Set(values.map(String))].sort();
  return distinct.length ? distinct.join(', ') : null;
}

const comparisonSchema = { enum: Object.keys(comparisons) } as const;
type Comparison = keyof typeof comparisons;

// Local calendar days ---------------------------------------------------------------------------------------------

// An IANA zone name such as America/Denver, or UTC. Abbreviations and offsets are refused so no zone is guessed.
export const timeZoneSchema = {
  type: 'string',
  pattern: '^(?:UTC|[A-Z][A-Za-z_]+(?:/[A-Za-z0-9_+-]+){1,2})$',
  maxLength: 64,
} as const;
export const calendarDateSchema = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;
const formatters = new Map<string, Intl.DateTimeFormat>();

/** A formatter giving local calendar dates in the zone, or undefined when the platform does not know the zone. */
export function zoneCalendar(timeZone: string): Intl.DateTimeFormat | undefined {
  if (!new RegExp(timeZoneSchema.pattern).test(timeZone)) return undefined;
  const known = formatters.get(timeZone);
  if (known) return known;
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(timeZone, formatter);
    return formatter;
  } catch {
    return undefined;
  }
}

/** The local calendar date of an instant, as YYYY-MM-DD. */
export function localDate(calendar: Intl.DateTimeFormat, time: number): string {
  const parts = Object.fromEntries(calendar.formatToParts(time).map((part) => [part.type, part.value]));
  return `${parts.year!.padStart(4, '0')}-${parts.month}-${parts.day}`;
}

/** The first instant of a local calendar date. Found by search, so a day that skips midnight still has a start. */
export function dayStart(calendar: Intl.DateTimeFormat, date: string): number {
  // Every zone's offset is within 14 hours of UTC, so the local day starts inside this range.
  const utcMidnight = Date.parse(`${date}T00:00:00.000Z`);
  let before = utcMidnight - 36 * HOUR;
  let after = utcMidnight + 36 * HOUR;
  while (after - before > 1) {
    const middle = Math.floor((before + after) / 2);
    if (localDate(calendar, middle) >= date) after = middle;
    else before = middle;
  }
  return after;
}

export function addDays(date: string, days: number): string {
  const time = Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000;
  return new Date(time).toISOString().slice(0, 10);
}

/** ISO weekday of a calendar date: 1 is Monday, 7 is Sunday. */
export function isoWeekday(date: string): number {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay() || 7;
}

export function validCalendarDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) &&
    addDays(value, 0) === value
  );
}

export function zoneMissing(timeZone: string, details: CheckDetails): CheckResult {
  return result(
    'insufficient',
    'pending',
    'time_zone_unknown',
    `The time zone ${timeZone} is not a time zone this platform knows; no zone is assumed in its place.`,
    [],
    details,
  );
}

// A field in one record matches a field in another -----------------------------------------------------------------

export interface FieldMatchesParams {
  referenceSelect?: Selection;
  referenceField: string;
  candidateSelect?: Selection;
  candidateField: string;
  candidateScope: 'latest' | 'any';
  textMatch?: 'exact' | 'case_insensitive';
  mapping?: { value: Scalar; matches: Scalar[] }[];
  matchedField?: string;
  matchedComparison?: Comparison;
  matchedLimit?: number;
}

function scalarValue(value: unknown): Scalar | undefined {
  if (typeof value === 'string') return value.trim() ? value : undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  return typeof value === 'boolean' ? value : undefined;
}

function scalarsOf(observations: readonly CheckObservation[], field: string) {
  return observations.flatMap((observation) => {
    const value = scalarValue(observationField(observation, field));
    return value === undefined ? [] : [{ observation, value }];
  });
}

export const fieldMatchesV1: CheckKind<FieldMatchesParams> = {
  id: 'field.matches',
  version: 1,
  title: 'A field in one record matches a field in another',
  description:
    'The reference value is a field of the latest selected reference observation. With candidateScope latest the latest selected candidate observation must hold a matching value; with any, at least one selected candidate must. Values match when equal (text compared exactly, or ignoring case and surrounding space), or, with a mapping, when the candidate value is one the mapping lists for the reference value. With matchedField, a matching candidate must also hold a number within matchedLimit. A missing reference or candidate value, or a reference value the mapping does not list, is insufficient; simultaneous reports that disagree conflict.',
  inputs: [
    { name: 'reference', description: 'Observations or operator records that carry the value to match.' },
    { name: 'candidate', description: 'Observations or operator records compared with the reference value.' },
  ],
  details: [
    { name: 'referenceValue', description: 'The reference value compared; null when none is recorded.' },
    {
      name: 'candidateValues',
      description: 'The distinct candidate values compared, sorted and comma separated; null when none.',
    },
    { name: 'matchCount', description: 'How many compared candidate observations match the reference value.' },
    {
      name: 'matchedValue',
      description: 'The matchedField number of the best matching candidate; null when not checked or not recorded.',
    },
  ],
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['referenceField', 'candidateField', 'candidateScope'],
    properties: {
      referenceSelect: selectionSchema,
      referenceField: fieldPath,
      candidateSelect: selectionSchema,
      candidateField: fieldPath,
      candidateScope: { enum: ['latest', 'any'] },
      textMatch: { enum: ['exact', 'case_insensitive'] },
      mapping: {
        type: 'array',
        minItems: 1,
        maxItems: 200,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['value', 'matches'],
          properties: { value: scalar, matches: scalars },
        },
      },
      matchedField: fieldPath,
      matchedComparison: comparisonSchema,
      matchedLimit: { type: 'number' },
    },
    dependencies: {
      matchedField: ['matchedComparison', 'matchedLimit'],
      matchedComparison: ['matchedField'],
      matchedLimit: ['matchedField'],
    },
  },
  evaluate(params, inputs) {
    const normal = (value: Scalar): Scalar =>
      typeof value === 'string' && params.textMatch === 'case_insensitive'
        ? value.trim().replace(/\s+/g, ' ').toLowerCase()
        : value;
    const references = scalarsOf(
      latestObservations(current(inputs.reference, params.referenceSelect)),
      params.referenceField,
    );
    const selected = current(inputs.candidate, params.candidateSelect);
    const candidates = scalarsOf(
      params.candidateScope === 'latest' ? latestObservations(selected) : selected,
      params.candidateField,
    );
    const referenceValues = [...new Set(references.map((item) => normal(item.value)))];
    const details: CheckDetails = {
      referenceValue: referenceValues.length === 1 ? referenceValues[0]! : null,
      candidateValues: listed(candidates.map((item) => item.value)),
      matchCount: 0,
      matchedValue: null,
    };
    const referenceEvidence = references.map((item) => item.observation);
    const referenceLabel = labelOf(
      params.referenceField,
      current(inputs.reference, params.referenceSelect),
      params.referenceSelect,
    );
    const candidateLabel = labelOf(params.candidateField, selected, params.candidateSelect);
    if (!referenceValues.length)
      return result(
        'insufficient',
        'pending',
        'reference_value_missing',
        `No value is recorded for ${referenceLabel} to compare with.`,
        [],
        details,
      );
    if (referenceValues.length > 1)
      return result(
        'conflicting',
        'attention',
        'reference_values_disagree',
        `Observations at the same time report different values for ${referenceLabel}: ${listed(references.map((item) => item.value))}.`,
        referenceEvidence,
        details,
      );
    const reference = referenceValues[0]!;
    if (!candidates.length)
      return result(
        'insufficient',
        'pending',
        'candidate_value_missing',
        `No value is recorded for ${candidateLabel} to compare with ${referenceLabel}, ${String(reference)}.`,
        referenceEvidence,
        details,
      );
    const evidence = [...referenceEvidence, ...candidates.map((item) => item.observation)];
    if (params.candidateScope === 'latest' && new Set(candidates.map((item) => normal(item.value))).size > 1)
      return result(
        'conflicting',
        'attention',
        'candidate_values_disagree',
        `Observations at the same time report different values for ${candidateLabel}: ${details.candidateValues}.`,
        evidence,
        details,
      );
    let accepted: Scalar[] = [reference];
    if (params.mapping) {
      const entry = params.mapping.find((item) => normal(item.value) === reference);
      if (!entry)
        return result(
          'insufficient',
          'attention',
          'value_unmapped',
          `The rule lists no matching values for ${referenceLabel}, ${String(reference)}.`,
          referenceEvidence,
          details,
        );
      accepted = entry.matches.map(normal);
    }
    const matches = candidates.filter((item) => accepted.includes(normal(item.value)));
    details.matchCount = matches.length;
    const compared = `${candidateLabel} against ${referenceLabel}, ${String(reference)},`;
    if (!matches.length)
      return result(
        'supported',
        'attention',
        'values_do_not_match',
        `No recorded value for ${compared} matches; recorded: ${details.candidateValues}.`,
        evidence,
        details,
      );
    const matchEvidence = [...referenceEvidence, ...matches.map((item) => item.observation)];
    if (params.matchedField === undefined)
      return result(
        'supported',
        'pass',
        'values_match',
        `A recorded value for ${compared} matches.`,
        matchEvidence,
        details,
      );
    const comparison = comparisons[params.matchedComparison!];
    const numbers = matches.flatMap((item) => {
      const value = observationField(item.observation, params.matchedField!);
      return isNumber(value) ? [value] : [];
    });
    if (!numbers.length)
      return result(
        'insufficient',
        'attention',
        'matched_value_missing',
        `A recorded value for ${compared} matches, but no value for ${labelOf(
          params.matchedField!,
          matches.map((item) => item.observation),
        )} is recorded with it.`,
        matchEvidence,
        details,
      );
    const best = comparison.margin > 0 ? Math.max(...numbers) : Math.min(...numbers);
    details.matchedValue = best;
    const matched = labelOf(
      params.matchedField!,
      matches.map((item) => item.observation),
    );
    const statement = `A recorded value for ${compared} matches with ${matched} ${best}; the limit is ${comparison.words} ${params.matchedLimit}.`;
    return comparison.holds(best, params.matchedLimit!)
      ? result('supported', 'pass', 'values_match', statement, matchEvidence, details)
      : result('supported', 'attention', 'matched_value_outside_limit', statement, matchEvidence, details);
  },
};

// A total derived from an opening balance and later additions ------------------------------------------------------

export interface TotalFromOpeningParams {
  openingSelect?: Selection;
  openingField: string;
  openingAtField?: string;
  additionsSelect?: Selection;
  additionsField?: string;
  additionsStartField?: string;
  additionsEndField?: string;
  recordedAdditionsSelect?: Selection;
  recordedStartField?: string;
  recordedEndField?: string;
  comparison?: Comparison;
  limit?: number;
  limitSelect?: Selection;
  limitField?: string;
  unit?: string;
  textUnit?: TextUnit;
}

export interface Addition extends Segment {
  observation: CheckObservation;
  value: number | undefined;
}

/**
 * An addition, the time it occupies and the value it adds: the numeric field, or the hours between the start and end
 * fields. Without those fields it occupies its interval, or the instant it starts.
 */
export function addition(
  observation: CheckObservation,
  params: TotalFromOpeningParams,
  fields: { start?: string; end?: string } = { start: params.additionsStartField, end: params.additionsEndField },
): Addition {
  if (fields.start === undefined || fields.end === undefined) {
    const start = Date.parse(spanStart(observation));
    const stated = utcMillis(observation.interval?.end);
    const value = observationField(observation, params.additionsField!);
    const end = stated !== undefined && stated > start ? stated : start;
    return { observation, start, end, value: isNumber(value) ? value : undefined };
  }
  const start = utcMillis(observationField(observation, fields.start));
  const end = utcMillis(observationField(observation, fields.end));
  if (start === undefined) {
    const at = Date.parse(spanStart(observation));
    return { observation, start: at, end: at, value: undefined };
  }
  return end === undefined || end < start
    ? { observation, start, end: start, value: undefined }
    : { observation, start, end, value: (end - start) / HOUR };
}

const sharesTime = (a: Segment, b: Segment) => a.start === b.start || (a.start < b.end && b.start < a.end);

/**
 * The operator's own records of additions, each counted only when no reported addition shares its time: one that
 * does is the same flight of the same subject, counted from the report. Those whose times differ from that report's
 * are named.
 */
export function recordedAdditions(
  reported: readonly Addition[],
  recorded: readonly Addition[],
): { counted: Addition[]; differing: Addition[] } {
  const counted: Addition[] = [];
  const differing: Addition[] = [];
  for (const record of recorded) {
    const same = reported.filter((report) => sharesTime(report, record));
    if (!same.length) counted.push(record);
    else if (same.some((report) => report.start !== record.start || report.end !== record.end)) differing.push(record);
  }
  return { counted, differing };
}

/** Two additions that start together or whose times overlap: the same time would be counted twice. */
export function overlappingAdditions(additions: readonly Addition[]): CheckObservation[] {
  const spans = [...additions].sort((a, b) => a.start - b.start || a.end - b.end);
  const overlapping = new Set<CheckObservation>();
  for (let index = 1; index < spans.length; index += 1) {
    const previous = spans[index - 1]!;
    const next = spans[index]!;
    if (next.start === previous.start || next.start < previous.end) {
      overlapping.add(previous.observation);
      overlapping.add(next.observation);
    }
  }
  return [...overlapping];
}

export const totalFromOpeningV1: CheckKind<TotalFromOpeningParams> = {
  id: 'total.from-opening',
  version: 1,
  title: 'A total derived from an opening balance and later additions',
  description:
    'The total is a numeric field of the latest selected opening observation plus the sum, over every selected addition that starts at or after the opening time and by the evaluation time, of a numeric field or of the hours between a start and an end field. The opening time is the opening observation’s span start, or the instant in openingAtField. Additions before the opening time are already in the balance and do not count. With recordedStartField and recordedEndField, the operator’s own records of additions are read too, as the hours between those fields: a record is counted only when no reported addition shares its time (starts with it or overlaps it), since that is the same time reported by a source and is counted from the report; a record whose times differ from that report’s is counted in recordedDiffering and named. Without a limit the derived total is stated; with a fixed limit or a limit field it is compared with the limit, and the summary states the margin. With unit, the unit the values are stored in, each quantity is stated with it; with textUnit too, in that unit with the stored value in parentheses. A missing opening balance, addition value or limit is insufficient; simultaneous openings or limits that disagree, and additions that overlap in time, conflict.',
  inputs: [
    { name: 'opening', description: 'Observations or operator records that carry the opening balance.' },
    { name: 'additions', description: 'Observations or operator records whose values add to the balance.' },
    {
      name: 'recordedAdditions',
      description: 'The operator’s own records of additions, read where no reported addition shares their time.',
      optional: true,
    },
    { name: 'limit', description: 'Observations or operator records that carry the limit.', optional: true },
  ],
  details: [
    { name: 'openingValue', description: 'The opening balance; null when none is recorded.' },
    { name: 'openingAt', description: 'The opening time, a UTC instant; null when none is recorded.' },
    { name: 'addedValue', description: 'The sum of the counted additions; null when not derived.' },
    { name: 'additionCount', description: 'How many additions were counted.' },
    {
      name: 'recordedAdditionCount',
      description: 'How many of the counted additions were read from the operator’s own records.',
    },
    {
      name: 'recordedDiffering',
      description: 'How many of the operator’s records share their time with a report but state different times.',
    },
    { name: 'total', description: 'The opening balance plus the counted additions; null when not derived.' },
    { name: 'limit', description: 'The limit compared with; null without one.' },
    { name: 'margin', description: 'How far the total is inside the limit (negative outside); null without one.' },
  ],
  summaryValues: ['openingAt'],
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['openingField'],
    properties: {
      openingSelect: selectionSchema,
      openingField: fieldPath,
      openingAtField: fieldPath,
      additionsSelect: selectionSchema,
      additionsField: fieldPath,
      additionsStartField: fieldPath,
      additionsEndField: fieldPath,
      recordedAdditionsSelect: selectionSchema,
      recordedStartField: fieldPath,
      recordedEndField: fieldPath,
      comparison: comparisonSchema,
      limit: { type: 'number' },
      limitSelect: selectionSchema,
      limitField: fieldPath,
      unit: { type: 'string', minLength: 1, maxLength: 20 },
      textUnit: textUnitSchema,
    },
    not: { required: ['limit', 'limitField'] },
    oneOf: [{ required: ['additionsField'] }, { required: ['additionsStartField', 'additionsEndField'] }],
    dependencies: {
      additionsStartField: ['additionsEndField'],
      additionsEndField: ['additionsStartField'],
      recordedStartField: ['recordedEndField'],
      recordedEndField: ['recordedStartField'],
      recordedAdditionsSelect: ['recordedStartField'],
      comparison: { anyOf: [{ required: ['limit'] }, { required: ['limitField'] }] },
      limit: ['comparison'],
      limitField: ['comparison'],
      limitSelect: ['limitField'],
      textUnit: ['unit'],
    },
  },
  evaluate(params, inputs, clock) {
    const now = utcMillis(clock.evaluatedAt)!;
    const stated = (quantity: number) =>
      params.unit === undefined ? String(quantity) : quantityText(quantity, params.unit, params.textUnit);
    const details: CheckDetails = {
      openingValue: null,
      openingAt: null,
      addedValue: null,
      additionCount: 0,
      recordedAdditionCount: 0,
      recordedDiffering: 0,
      total: null,
      limit: params.limit ?? null,
      margin: null,
    };
    const openings = latestNumbers(current(inputs.opening, params.openingSelect), params.openingField);
    const openingLabel = labelOf(params.openingField, openings.latest, params.openingSelect);
    if (!openings.reported.length)
      return result(
        'insufficient',
        'attention',
        'opening_balance_missing',
        `No opening balance is recorded for ${openingLabel}.`,
        openings.latest,
        details,
      );
    const openingEvidence = openings.reported.map((item) => item.observation);
    if (openings.values.length > 1)
      return result(
        'conflicting',
        'attention',
        'opening_balances_disagree',
        `Observations at the same time report different values for ${openingLabel}: ${openings.values.join(', ')}.`,
        openingEvidence,
        details,
      );
    details.openingValue = openings.values[0]!;
    const openingTimes = [
      ...new Set(
        openingEvidence.flatMap((observation) =>
          params.openingAtField === undefined
            ? [Date.parse(spanStart(observation))]
            : (utcMillis(observationField(observation, params.openingAtField)) ?? []),
        ),
      ),
    ];
    if (openingTimes.length !== 1)
      return result(
        openingTimes.length ? 'conflicting' : 'insufficient',
        'attention',
        openingTimes.length ? 'opening_times_disagree' : 'opening_time_missing',
        openingTimes.length
          ? `Observations at the same time report different values for ${labelOf(params.openingAtField!, openingEvidence, params.openingSelect)}.`
          : `No valid time is recorded for ${labelOf(params.openingAtField!, openingEvidence, params.openingSelect)} with the opening balance.`,
        openingEvidence,
        details,
      );
    const openingAt = openingTimes[0]!;
    details.openingAt = iso(openingAt);
    const counts = (item: Addition) => item.start >= openingAt && item.start <= now;
    const reported = current(inputs.additions, params.additionsSelect)
      .map((observation) => addition(observation, params))
      .filter(counts);
    const fromRecords =
      params.recordedStartField === undefined
        ? { counted: [], differing: [] }
        : recordedAdditions(
            reported,
            current(inputs.recordedAdditions, params.recordedAdditionsSelect)
              .map((observation) =>
                addition(observation, params, { start: params.recordedStartField, end: params.recordedEndField }),
              )
              .filter(counts),
          );
    const additions = [...reported, ...fromRecords.counted];
    Object.assign(details, {
      recordedAdditionCount: fromRecords.counted.length,
      recordedDiffering: fromRecords.differing.length,
    });
    const recordedAdditionsRead = current(inputs.additions, params.additionsSelect);
    const additionLabel = (field: string) => labelOf(field, recordedAdditionsRead, params.additionsSelect);
    const valueLabel =
      params.additionsField !== undefined
        ? additionLabel(params.additionsField)
        : `${additionLabel(params.additionsStartField!)} and ${additionLabel(params.additionsEndField!)}`;
    const unvalued = additions.filter((item) => item.value === undefined).map((item) => item.observation);
    if (unvalued.length)
      return result(
        'insufficient',
        'attention',
        'addition_value_missing',
        `${unvalued.length} addition(s) after the opening balance record no valid ${valueLabel}: ${unvalued.map((item) => item.id).join(', ')}.`,
        [...openingEvidence, ...unvalued],
        details,
      );
    const overlapping = overlappingAdditions(additions);
    if (overlapping.length)
      return result(
        'conflicting',
        'attention',
        'additions_overlap',
        `Additions overlap in time, so the same time would be counted twice: ${overlapping.map((item) => item.id).join(', ')}.`,
        [...openingEvidence, ...overlapping],
        details,
      );
    const added = round(additions.reduce((sum, item) => sum + item.value!, 0));
    const total = round(details.openingValue + added);
    Object.assign(details, { addedValue: added, additionCount: additions.length, total });
    const evidence = [
      ...openingEvidence,
      ...additions.map((item) => item.observation),
      ...fromRecords.differing.map((item) => item.observation),
    ];
    const fromRecordsWords = fromRecords.counted.length
      ? ` (${fromRecords.counted.length} read from the operator’s own records)`
      : '';
    const differingWords = fromRecords.differing.length
      ? ` ${fromRecords.differing.length} of the operator’s own records state times that differ from the report of the same time, which is counted instead: ${fromRecords.differing.map((item) => item.observation.id).join(', ')}.`
      : '';
    const derived = `${sentenceStart(openingLabel)} ${stated(details.openingValue as number)} at ${details.openingAt} plus ${stated(added)} from ${additions.length} later addition(s)${fromRecordsWords} is ${stated(total)}`;
    let limit = params.limit;
    if (params.limitField !== undefined) {
      const limits = latestNumbers(current(inputs.limit, params.limitSelect), params.limitField);
      const limitLabel = labelOf(params.limitField, limits.latest, params.limitSelect);
      if (!limits.reported.length)
        return result(
          'insufficient',
          'attention',
          'limit_missing',
          `No value is recorded for ${limitLabel}.`,
          [...evidence, ...limits.latest],
          details,
        );
      evidence.push(...limits.reported.map((item) => item.observation));
      if (limits.values.length > 1)
        return result(
          'conflicting',
          'attention',
          'limits_disagree',
          `Observations at the same time report different values for ${limitLabel}: ${limits.values.join(', ')}.`,
          evidence,
          details,
        );
      limit = limits.values[0]!;
    }
    if (limit === undefined)
      return result('supported', 'pass', 'total_derived', `${derived}.${differingWords}`, evidence, details);
    const comparison = comparisons[params.comparison!];
    const margin = round((total - limit) * comparison.margin);
    Object.assign(details, { limit, margin });
    const statement = `${derived}; the limit is ${comparison.words} ${stated(limit)}; the margin is ${stated(margin)}.${differingWords}`;
    return comparison.holds(total, limit)
      ? result('supported', 'pass', 'total_within_limit', statement, evidence, details)
      : result('supported', 'attention', 'total_outside_limit', statement, evidence, details);
  },
};

// Recorded intervals cover the intersection of two windows ----------------------------------------------------------

export interface IntervalCoversIntersectionParams {
  select?: Selection;
  openEnd: 'stated' | 'open';
  windowSelect?: Selection;
  windowStartField?: string;
  windowEndField?: string;
  otherWindowSelect?: Selection;
  otherWindowStartField?: string;
  otherWindowEndField?: string;
  whenDisjoint: 'not_applicable' | 'attention';
}

type StatedWindow =
  { window: Segment; evidence: CheckObservation[] } | { problem: 'missing' | 'disagree'; evidence: CheckObservation[] };

/** The window the latest selected observations state, when they state exactly one. */
function latestWindow(
  observations: readonly CheckObservation[] | undefined,
  selection: Selection | undefined,
  startField: string | undefined,
  endField: string | undefined,
): StatedWindow {
  const latest = latestObservations(current(observations, selection));
  const stated = latest.flatMap((observation) => {
    const window = statedWindow(observation, startField, endField);
    return window ? [{ observation, window }] : [];
  });
  const evidence = stated.map((item) => item.observation);
  if (!stated.length) return { problem: 'missing', evidence: latest };
  const distinct = new Set(stated.map((item) => `${item.window.start}/${item.window.end}`));
  return distinct.size > 1 ? { problem: 'disagree', evidence } : { window: stated[0]!.window, evidence };
}

export const intervalCoversIntersectionV1: CheckKind<IntervalCoversIntersectionParams> = {
  id: 'interval.covers-intersection',
  version: 1,
  title: 'Recorded intervals cover the intersection of two windows',
  description:
    'The window to cover is the time two recorded windows share: the latest selected observation of each window input (its interval, or the named start and end fields). Selected intervals, joined where they touch or overlap, must cover all of it. An interval without an end covers up to the time it was stated, or without limit when openEnd is open. When the two windows share no time the rule does not apply, or needs attention with whenDisjoint attention. A missing window is insufficient; simultaneous windows that disagree conflict.',
  inputs: [
    { name: 'interval', description: 'Observations or operator records whose intervals may cover the window.' },
    { name: 'window', description: 'An observation or operator record stating the first window.' },
    { name: 'otherWindow', description: 'An observation or operator record stating the second window.' },
  ],
  details: [
    { name: 'windowStart', description: 'Start of the shared window, a UTC instant; null when there is none.' },
    { name: 'windowEnd', description: 'End of the shared window, a UTC instant; null when there is none.' },
    {
      name: 'uncoveredFrom',
      description: 'The first instant of the shared window no interval covers; null when covered or not checked.',
    },
  ],
  summaryValues: ['windowStart', 'windowEnd', 'uncoveredFrom'],
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['openEnd', 'whenDisjoint'],
    properties: {
      select: selectionSchema,
      openEnd: { enum: ['stated', 'open'] },
      windowSelect: selectionSchema,
      windowStartField: fieldPath,
      windowEndField: fieldPath,
      otherWindowSelect: selectionSchema,
      otherWindowStartField: fieldPath,
      otherWindowEndField: fieldPath,
      whenDisjoint: { enum: ['not_applicable', 'attention'] },
    },
  },
  evaluate(params, inputs) {
    const details: CheckDetails = { windowStart: null, windowEnd: null, uncoveredFrom: null };
    const stated = [
      latestWindow(inputs.window, params.windowSelect, params.windowStartField, params.windowEndField),
      latestWindow(
        inputs.otherWindow,
        params.otherWindowSelect,
        params.otherWindowStartField,
        params.otherWindowEndField,
      ),
    ];
    const windowEvidence = stated.flatMap((item) => item.evidence);
    const disagree = stated.findIndex((item) => 'problem' in item && item.problem === 'disagree');
    if (disagree >= 0)
      return result(
        'conflicting',
        'attention',
        'windows_disagree',
        `Observations at the same time state different ${disagree ? 'second' : 'first'} windows.`,
        windowEvidence,
        details,
      );
    const missing = stated.findIndex((item) => 'problem' in item);
    if (missing >= 0)
      return result(
        'insufficient',
        'pending',
        'window_missing',
        `The ${missing ? 'second' : 'first'} window has no valid start and end.`,
        windowEvidence,
        details,
      );
    const [first, second] = stated.map((item) => (item as { window: Segment }).window) as [Segment, Segment];
    const window = { start: Math.max(first.start, second.start), end: Math.min(first.end, second.end) };
    if (window.end <= window.start)
      return params.whenDisjoint === 'attention'
        ? result(
            'supported',
            'attention',
            'windows_disjoint',
            'The two windows share no time.',
            windowEvidence,
            details,
          )
        : result(
            'not_applicable',
            'not_applicable',
            'windows_disjoint',
            'The two windows share no time.',
            windowEvidence,
            details,
          );
    Object.assign(details, { windowStart: iso(window.start), windowEnd: iso(window.end) });
    const recorded = current(inputs.interval, params.select).flatMap((observation) => {
      const segment = recordedSegment(observation, params.openEnd);
      return segment && segment.start < window.end && segment.end > window.start ? [{ observation, segment }] : [];
    });
    const evidence = [...windowEvidence, ...recorded.map((item) => item.observation)];
    const subject = describeSelection(params.select, 'recorded interval');
    let reached = window.start;
    for (const segment of merged(recorded.map((item) => item.segment)))
      if (segment.start <= reached) reached = Math.max(reached, segment.end);
    if (reached >= window.end)
      return result(
        'supported',
        'pass',
        'window_covered',
        `Selected ${subject}s, joined, cover the shared window from ${details.windowStart} to ${details.windowEnd}.`,
        evidence,
        details,
      );
    details.uncoveredFrom = iso(reached);
    return result(
      'insufficient',
      'attention',
      'window_not_covered',
      `No ${subject} covers the shared window from ${details.uncoveredFrom}.`,
      evidence,
      details,
    );
  },
};

// A count or total over local calendar days -----------------------------------------------------------------------

export interface LocalDaysTotalParams {
  select?: Selection;
  timeZone: string;
  timeZoneField?: string;
  measure: 'count' | 'sum' | 'hours' | 'hours_uncovered';
  field?: string;
  days?: number;
  weekStartsOn?: number;
  scope: 'total' | 'each_day';
  requireDays?: number;
  comparison: Comparison;
  limit: number;
  whenNone?: 'insufficient' | 'zero';
}

interface LocalDay {
  date: string;
  start: number;
  end: number;
}

/** The local calendar days the window holds, oldest first, and the date of the evaluation instant. */
function windowDays(calendar: Intl.DateTimeFormat, params: LocalDaysTotalParams, now: number) {
  const today = localDate(calendar, now);
  const first =
    params.weekStartsOn === undefined
      ? addDays(today, 1 - params.days!)
      : addDays(today, -((isoWeekday(today) - params.weekStartsOn + 7) % 7));
  const length = params.weekStartsOn === undefined ? params.days! : 7;
  const days: LocalDay[] = [];
  for (let index = 0; index < length; index += 1) {
    const date = addDays(first, index);
    days.push({ date, start: dayStart(calendar, date), end: dayStart(calendar, addDays(date, 1)) });
  }
  return { today, days };
}

export const localDaysTotalV1: CheckKind<LocalDaysTotalParams> = {
  id: 'local-days.total',
  version: 1,
  title: 'A count or total over calendar days in a stated time zone',
  description:
    'Selected observations are placed on calendar days in the stated IANA time zone, never the machine’s zone. The window is the given number of days ending with the local day of the evaluation time, or with weekStartsOn the local week that holds it. The measure is the number of observations starting on a day, the sum of a numeric field over them, the hours of selected intervals within the day (joined), or the hours of the day those intervals leave uncovered; days are as long as the zone makes them, so 23 or 25 hours across a daylight-saving change. With scope total the window’s sum is compared with the limit; with each_day every day (or at least requireDays of them) must be within it, and days of the window after the evaluation day are still to come. With no selected observation the result is insufficient unless whenNone is zero. An unknown zone, a missing value or an interval without an end is insufficient; an observation that records a different time zone in timeZoneField conflicts.',
  inputs: [{ name: 'subject', description: 'Observations or operator records counted on calendar days.' }],
  details: [
    { name: 'timeZone', description: 'The time zone the days are counted in.' },
    { name: 'firstDay', description: 'The first local date of the window.' },
    { name: 'lastDay', description: 'The last local date of the window.' },
    { name: 'total', description: 'With scope total, the window’s count, sum or hours; otherwise null.' },
    { name: 'daysWithinLimit', description: 'With scope each_day, how many days so far are within the limit.' },
    { name: 'daysRequired', description: 'With scope each_day, how many days must be within the limit.' },
    { name: 'limit', description: 'The limit compared with.' },
  ],
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['timeZone', 'measure', 'scope', 'comparison', 'limit'],
    properties: {
      select: selectionSchema,
      timeZone: timeZoneSchema,
      timeZoneField: fieldPath,
      measure: { enum: ['count', 'sum', 'hours', 'hours_uncovered'] },
      field: fieldPath,
      days: { type: 'integer', minimum: 1, maximum: 366 },
      weekStartsOn: { type: 'integer', minimum: 1, maximum: 7 },
      scope: { enum: ['total', 'each_day'] },
      requireDays: { type: 'integer', minimum: 1, maximum: 366 },
      comparison: comparisonSchema,
      limit: { type: 'number' },
      whenNone: { enum: ['insufficient', 'zero'] },
    },
    oneOf: [{ required: ['days'] }, { required: ['weekStartsOn'] }],
    allOf: [
      {
        if: { properties: { measure: { const: 'sum' } } },
        then: { required: ['field'] },
        else: { not: { required: ['field'] } },
      },
      { if: { required: ['requireDays'] }, then: { properties: { scope: { const: 'each_day' } } } },
    ],
  },
  evaluate(params, inputs, clock) {
    const now = utcMillis(clock.evaluatedAt)!;
    const details: CheckDetails = {
      timeZone: params.timeZone,
      firstDay: null,
      lastDay: null,
      total: null,
      daysWithinLimit: null,
      daysRequired: null,
      limit: params.limit,
    };
    const calendar = zoneCalendar(params.timeZone);
    if (!calendar) return zoneMissing(params.timeZone, details);
    const { today, days } = windowDays(calendar, params, now);
    Object.assign(details, { firstDay: days[0]!.date, lastDay: days.at(-1)!.date });
    const from = days[0]!.start;
    const to = days.at(-1)!.end;
    const selected = current(inputs.subject, params.select);
    const hours = params.measure === 'hours' || params.measure === 'hours_uncovered';
    const inWindow = selected.filter((observation) => {
      if (!hours) {
        const at = Date.parse(spanStart(observation));
        return at >= from && at < to;
      }
      const start = utcMillis(observation.interval?.start);
      const end = utcMillis(observation.interval?.end);
      return start !== undefined && start < to && (observation.interval?.end === undefined || (end ?? to) > from);
    });
    const zones = params.timeZoneField
      ? inWindow.filter((observation) => {
          const zone = observationField(observation, params.timeZoneField!);
          return typeof zone === 'string' && zone.trim() && zone.trim() !== params.timeZone;
        })
      : [];
    if (zones.length)
      return result(
        'conflicting',
        'attention',
        'time_zones_disagree',
        `${zones.length} observation(s) record ${labelOf(params.timeZoneField!, zones, params.select)} other than ${params.timeZone}: ${zones.map((item) => item.id).join(', ')}.`,
        zones,
        details,
      );
    if (!selected.length && params.whenNone !== 'zero')
      return result(
        'insufficient',
        'pending',
        'subject_missing',
        `No ${describeSelection(params.select, 'observation')} is recorded to count.`,
        [],
        details,
      );
    const unvalued = inWindow.filter((observation) =>
      hours
        ? recordedSegment(observation, 'none') === undefined
        : params.measure === 'sum' && !isNumber(observationField(observation, params.field!)),
    );
    if (unvalued.length)
      return result(
        'insufficient',
        'attention',
        hours ? 'interval_end_missing' : 'value_missing',
        hours
          ? `${unvalued.length} interval(s) in the window have no valid end: ${unvalued.map((item) => item.id).join(', ')}.`
          : `${unvalued.length} observation(s) in the window record no value for ${labelOf(params.field!, unvalued, params.select)}: ${unvalued.map((item) => item.id).join(', ')}.`,
        unvalued,
        details,
      );
    const segments = hours ? merged(inWindow.map((observation) => recordedSegment(observation, 'none')!)) : [];
    const measured = (day: LocalDay): number => {
      if (hours) {
        const covered = segments.reduce(
          (sum, segment) => sum + Math.max(0, Math.min(segment.end, day.end) - Math.max(segment.start, day.start)),
          0,
        );
        return round((params.measure === 'hours' ? covered : day.end - day.start - covered) / HOUR);
      }
      const on = inWindow.filter((observation) => {
        const at = Date.parse(spanStart(observation));
        return at >= day.start && at < day.end;
      });
      return params.measure === 'count'
        ? on.length
        : round(on.reduce((sum, observation) => sum + (observationField(observation, params.field!) as number), 0));
    };
    const comparison = comparisons[params.comparison];
    // What a sentence calls the measure, and a quantity of it: hours are stated as hours, a count or sum as it is.
    const measure = {
      count: 'count',
      sum: 'sum',
      hours: 'number of hours covered',
      hours_uncovered: 'number of hours left uncovered',
    }[params.measure];
    const stated = (quantity: number) => (hours ? `${quantity} h` : String(quantity));
    const counted = days.filter((day) => day.date <= today);
    const remaining = days.length - counted.length;
    const window = `${details.firstDay} to ${details.lastDay} in ${params.timeZone}`;
    const nextDay = dayStart(calendar, addDays(today, 1));
    if (params.scope === 'total') {
      const total = round(counted.reduce((sum, day) => sum + measured(day), 0));
      details.total = total;
      const statement = `The ${measure} over ${window} is ${stated(total)}; the limit is ${comparison.words} ${stated(params.limit)}.`;
      if (comparison.holds(total, params.limit))
        return result('supported', 'pass', 'days_within_limit', statement, inWindow, details, nextDay);
      return remaining && comparison.margin > 0
        ? result('insufficient', 'pending', 'days_remaining', statement, inWindow, details, nextDay)
        : result('supported', 'attention', 'days_outside_limit', statement, inWindow, details);
    }
    const values = counted.map((day) => ({ day, value: measured(day) }));
    const within = values.filter((item) => comparison.holds(item.value, params.limit));
    const required = Math.min(params.requireDays ?? days.length, days.length);
    Object.assign(details, { daysWithinLimit: within.length, daysRequired: required });
    const outside = values.filter((item) => !comparison.holds(item.value, params.limit));
    const statement = `${within.length} of ${counted.length} day(s) so far of ${window} have a ${measure} ${comparison.words} ${stated(params.limit)}; ${required} must.${outside.length ? ` Outside: ${outside.map((item) => `${item.day.date} (${stated(item.value)})`).join(', ')}.` : ''}`;
    if (within.length >= required)
      return result('supported', 'pass', 'days_within_limit', statement, inWindow, details, nextDay);
    return within.length + remaining >= required
      ? result('insufficient', 'pending', 'days_remaining', statement, inWindow, details, nextDay)
      : result('supported', 'attention', 'days_outside_limit', statement, inWindow, details);
  },
};

// Business days between two recorded times -------------------------------------------------------------------------

export interface BusinessDaysWithinParams {
  select?: Selection;
  fromField?: string;
  toField: string;
  timeZone: string;
  days: number;
  excludedWeekdays: number[];
  excludedDates: string[];
  calendarFrom: string;
  calendarThrough: string;
  whenAbsent?: 'insufficient' | 'not_applicable';
  notDue?: NotDue;
}

/** The last local date allowed: the Nth business day after the start date. Undefined past the stated calendar. */
function lastBusinessDay(params: BusinessDaysWithinParams, startDate: string): string | undefined {
  const excluded = new Set(params.excludedDates);
  let date = startDate;
  let counted = 0;
  while (counted < params.days) {
    date = addDays(date, 1);
    if (date < params.calendarFrom || date > params.calendarThrough) return undefined;
    if (!params.excludedWeekdays.includes(isoWeekday(date)) && !excluded.has(date)) counted += 1;
  }
  return date;
}

/** The distinct instants a field states; a date alone is read at the instant of its day the reading names. */
function distinctInstants(
  observations: readonly CheckObservation[],
  field: string | undefined,
  reading: 'earliest' | 'latest',
) {
  const found = observations.flatMap((observation) => {
    const time = placedTime(observation, field, reading);
    return time === undefined ? [] : [{ observation, time: time.at, day: time.day }];
  });
  return { found, times: [...new Set(found.map((item) => item.time))] };
}

export const businessDaysWithinV1: CheckKind<BusinessDaysWithinParams> = {
  id: 'business-days.within',
  version: 1,
  title: 'A later time within N business days of an earlier one',
  description:
    'For the latest selected observation, the later time (toField) must fall within the given number of business days after the earlier time (fromField, or its span start). Days are calendar days in the stated IANA time zone; the day of the earlier time is not counted; a business day is any day not on an excluded weekday (1 Monday to 7 Sunday) and not an excluded date. The later time must be before the start of the day after the last business day. Excluded dates are only trusted from calendarFrom through calendarThrough; counting past them is insufficient, never guessed. With no later time recorded the result is awaited until that instant and needs attention from it on. A missing earlier time is insufficient (or not applicable with whenAbsent not_applicable). A record matching notDue (such as an occurrence the operator recorded as not reportable) is not counted: the rule does not apply to it, and the summary says so and who decided. Simultaneous times that disagree, or a later time before the earlier one, conflict. A later time given as a date alone is read as the end of that local day, and the summary says only the date is on record.',
  inputs: [{ name: 'subject', description: 'Observations or operator records that carry the two times.' }],
  details: [
    { name: 'timeZone', description: 'The time zone the days are counted in.' },
    { name: 'startDay', description: 'The local date of the earlier time; null when none is recorded.' },
    { name: 'dueThrough', description: 'The last local date allowed; null when it cannot be counted.' },
    { name: 'dueAt', description: 'The instant the allowed days end, UTC; null when it cannot be counted.' },
    { name: 'businessDays', description: 'How many business days are allowed.' },
    { name: 'endRecorded', description: 'Whether the later time is recorded.' },
  ],
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['toField', 'timeZone', 'days', 'excludedWeekdays', 'excludedDates', 'calendarFrom', 'calendarThrough'],
    properties: {
      select: selectionSchema,
      fromField: fieldPath,
      toField: fieldPath,
      timeZone: timeZoneSchema,
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
      whenAbsent: { enum: ['insufficient', 'not_applicable'] },
      notDue: notDueSchema,
    },
  },
  evaluate(params, inputs, clock) {
    const now = utcMillis(clock.evaluatedAt)!;
    const details: CheckDetails = {
      timeZone: params.timeZone,
      startDay: null,
      dueThrough: null,
      dueAt: null,
      businessDays: params.days,
      endRecorded: false,
    };
    const calendar = zoneCalendar(params.timeZone);
    if (!calendar) return zoneMissing(params.timeZone, details);
    const badDate = [params.calendarFrom, params.calendarThrough, ...params.excludedDates].find(
      (date) => !validCalendarDate(date),
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
    const latest = latestObservations(current(inputs.subject, params.select));
    const notDue = latest.flatMap(
      (observation) => notDueSentence(observation, params.notDue, `The record at ${spanStart(observation)}`) ?? [],
    );
    if (latest.length && notDue.length === latest.length) {
      const notCounted = notDue.join(' ');
      return { ...result('not_applicable', 'not_applicable', 'not_due', notCounted, latest, details), notCounted };
    }
    const starts = distinctInstants(latest, params.fromField, 'earliest');
    const startLabel = params.fromField ? labelOf(params.fromField, latest, params.select) : 'the start time';
    const endLabel = labelOf(params.toField, latest, params.select);
    if (!starts.times.length)
      return params.whenAbsent === 'not_applicable' && !latest.length
        ? result('not_applicable', 'not_applicable', 'start_not_recorded', 'No observation is recorded.', [], details)
        : result(
            'insufficient',
            'pending',
            'start_missing',
            `No valid time is recorded for ${startLabel}.`,
            latest,
            details,
          );
    const ends = distinctInstants(latest, params.toField, 'latest');
    const evidence = [...starts.found, ...ends.found].map((item) => item.observation);
    if (starts.times.length > 1 || ends.times.length > 1)
      return result(
        'conflicting',
        'attention',
        'times_disagree',
        `Observations at the same time report different values for ${starts.times.length > 1 ? startLabel : endLabel}.`,
        evidence,
        details,
      );
    const start = starts.times[0]!;
    const end = ends.times[0];
    details.startDay = localDate(calendar, start);
    details.endRecorded = end !== undefined;
    if (end !== undefined && end < start)
      return result(
        'conflicting',
        'attention',
        'end_before_start',
        `${sentenceStart(endLabel)} is before ${startLabel}.`,
        evidence,
        details,
      );
    const through = lastBusinessDay(params, details.startDay);
    if (through === undefined)
      return result(
        'insufficient',
        'pending',
        'calendar_not_covered',
        `Counting ${params.days} business days after ${details.startDay} runs outside the stated calendar, ${params.calendarFrom} to ${params.calendarThrough}.`,
        evidence,
        details,
      );
    const dueAt = dayStart(calendar, addDays(through, 1));
    Object.assign(details, { dueThrough: through, dueAt: iso(dueAt) });
    const allowed = `${params.days} business days after ${details.startDay} in ${params.timeZone}, through ${through}`;
    const endDay = ends.found.find((item) => item.time === end)?.day;
    const endWords =
      endDay === undefined
        ? sentenceStart(endLabel)
        : `${sentenceStart(endLabel)}, on ${endDay} (only the date is on record; read as the end of that day),`;
    if (end !== undefined)
      return end < dueAt
        ? result('supported', 'pass', 'within_business_days', `${endWords} is within ${allowed}.`, evidence, details)
        : result(
            'supported',
            'attention',
            'after_business_days',
            endDay === undefined
              ? `${sentenceStart(endLabel)}, ${iso(end)}, is after ${allowed}.`
              : `${endWords} is after ${allowed}.`,
            evidence,
            details,
          );
    return now < dueAt
      ? result(
          'insufficient',
          'pending',
          'end_awaited',
          `No value is recorded yet for ${endLabel}; it is due within ${allowed}.`,
          evidence,
          details,
          dueAt,
        )
      : result(
          'insufficient',
          'attention',
          'end_overdue',
          `No value is recorded for ${endLabel} within ${allowed}.`,
          evidence,
          details,
        );
  },
};

export const combinedCheckKinds: readonly CheckKind[] = [
  fieldMatchesV1,
  totalFromOpeningV1,
  intervalCoversIntersectionV1,
  localDaysTotalV1,
  businessDaysWithinV1,
];
for (const kind of combinedCheckKinds) registerCheckKind(kind);
