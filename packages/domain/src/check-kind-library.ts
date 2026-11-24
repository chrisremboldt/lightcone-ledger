import {
  findOperatorRecordDefinition,
  missingFields,
  missingReplayFields,
  missingRequiredFields,
  ObservationFieldPathPattern,
  ObservationTypeIdPattern,
} from '@ledger/contracts';
import {
  latestObservations,
  observationField,
  registerCheckKind,
  utcMillis,
  type CheckKind,
  type CheckObservation,
  type CheckResult,
} from './check-kinds.js';
import { fieldLabel, recordFieldLabels, recordTitle, sentenceStart } from './field-labels.js';
import { observationRegistry } from './observation-registry.js';
import './check-kind-library-records.js';
import './check-kind-library-combined.js';
import './check-kind-library-deadlines.js';
import './check-kind-library-geometry.js';
import './check-kind-library-windows.js';
import './check-kind-library-observed.js';
import './check-kind-library-on-file.js';

// The first library of check kinds. Each reads only the inputs and parameters it is given; the rule names the
// observation types, fields and limits.

const fieldPath = { type: 'string', pattern: ObservationFieldPathPattern, maxLength: 400 } as const;

function ids(observations: readonly CheckObservation[]): string[] {
  return observations.map((observation) => observation.id);
}

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
    evidence: ids(evidence),
    ...(nextBoundary === undefined ? {} : { nextBoundary: new Date(nextBoundary).toISOString() }),
  };
}

// Record present and complete ------------------------------------------------------------------------------------

export interface RecordCompleteParams {
  recordType: string;
  recordVersion: number;
  fields?: string[];
}

export const recordCompleteV1: CheckKind<RecordCompleteParams> = {
  id: 'record.complete',
  version: 1,
  title: 'Record present and complete',
  description:
    'The latest operator record of the given record type and version is present and has a value in every required field, or in the listed fields when the rule lists them. Absent, null and blank values are missing; false is an answer.',
  inputs: [{ name: 'record', description: 'Operator-record observations that may carry the record.' }],
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['recordType', 'recordVersion'],
    properties: {
      recordType: { type: 'string', pattern: ObservationTypeIdPattern, maxLength: 100 },
      recordVersion: { type: 'integer', minimum: 1 },
      fields: {
        type: 'array',
        minItems: 1,
        maxItems: 100,
        uniqueItems: true,
        items: { type: 'string', pattern: '^[a-z][a-zA-Z0-9]*$' },
      },
    },
  },
  evaluate(params, inputs) {
    const label = recordTitle(params.recordType, params.recordVersion);
    const records = (inputs.record ?? []).filter((candidate) => {
      const values = observationField(candidate, 'values') as Record<string, unknown> | undefined;
      return values?.recordType === params.recordType && values?.recordVersion === params.recordVersion;
    });
    const latest = records[0];
    if (!latest) return result('insufficient', 'attention', 'record_missing', `No ${label} is held.`, []);
    const definition = findOperatorRecordDefinition(observationRegistry(), params.recordType, params.recordVersion);
    if (!definition)
      return result(
        'insufficient',
        'pending',
        'record_type_unavailable',
        `The ${label} is not a registered kind of record.`,
        [latest],
      );
    const body = (observationField(latest, 'values.record') ?? {}) as Record<string, unknown>;
    const missing = params.fields
      ? missingFields(definition, body, params.fields)
      : missingRequiredFields(definition, body);
    const thin = missingReplayFields(definition, body);
    const labels = (names: readonly string[]) =>
      recordFieldLabels(params.recordType, params.recordVersion, names).join(', ');
    const replayNote = thin.length ? ` Replay detail not recorded: ${labels(thin)}.` : '';
    if (missing.length)
      return result(
        'insufficient',
        'attention',
        'record_incomplete',
        `The latest ${label} is missing: ${labels(missing)}.${replayNote}`,
        [latest],
      );
    return result('supported', 'pass', 'record_complete', `The latest ${label} is complete.${replayNote}`, [latest]);
  },
};

// Value within a limit -------------------------------------------------------------------------------------------

const comparisons = {
  at_most: { holds: (value: number, limit: number) => value <= limit, words: 'at most' },
  at_least: { holds: (value: number, limit: number) => value >= limit, words: 'at least' },
  below: { holds: (value: number, limit: number) => value < limit, words: 'below' },
  above: { holds: (value: number, limit: number) => value > limit, words: 'above' },
} as const;

export interface ValueWithinLimitParams {
  field: string;
  comparison: keyof typeof comparisons;
  limit: number;
}

export const valueWithinLimitV1: CheckKind<ValueWithinLimitParams> = {
  id: 'value.within-limit',
  version: 1,
  title: 'Value within a limit',
  description:
    'A named numeric field of the latest observation is compared with a limit. Observations sharing the newest span start that report different values disagree. An absent or non-numeric value is insufficient, never a pass.',
  inputs: [{ name: 'subject', description: 'Observations that carry the numeric field.' }],
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['field', 'comparison', 'limit'],
    properties: {
      field: fieldPath,
      comparison: { enum: Object.keys(comparisons) },
      limit: { type: 'number' },
    },
  },
  evaluate(params, inputs) {
    const latest = latestObservations(inputs.subject ?? []);
    const reported = latest.flatMap((observation) => {
      const value = observationField(observation, params.field);
      return typeof value === 'number' && Number.isFinite(value) ? [{ observation, value }] : [];
    });
    const label = fieldLabel(params.field, latest);
    if (!reported.length)
      return result('insufficient', 'pending', 'value_missing', `No value is reported for ${label}.`, latest);
    const evidence = reported.map((item) => item.observation);
    const values = [...new Set(reported.map((item) => item.value))];
    if (values.length > 1)
      return result(
        'conflicting',
        'attention',
        'values_disagree',
        `Observations at the same time report different values for ${label}: ${values.join(', ')}.`,
        evidence,
      );
    const comparison = comparisons[params.comparison];
    const statement = `The latest reported value for ${label} is ${values[0]}; the limit is ${comparison.words} ${params.limit}.`;
    return comparison.holds(values[0]!, params.limit)
      ? result('supported', 'pass', 'value_within_limit', statement, evidence)
      : result('supported', 'attention', 'value_outside_limit', statement, evidence);
  },
};

// Date within the previous N calendar months ---------------------------------------------------------------------

export interface DateWithinMonthsParams {
  field: string;
  months: number;
}

const calendarDate = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Year, zero-based month and day of a calendar date or of a UTC instant's UTC date. */
function dateParts(value: unknown): [number, number, number] | undefined {
  if (typeof value !== 'string') return undefined;
  const date = calendarDate.exec(value);
  if (date) {
    const [year, month, day] = [Number(date[1]), Number(date[2]) - 1, Number(date[3])];
    const check = new Date(Date.UTC(year, month, day));
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month || check.getUTCDate() !== day)
      return undefined;
    return [year, month, day];
  }
  const time = utcMillis(value);
  if (time === undefined) return undefined;
  const instant = new Date(time);
  return [instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()];
}

export const dateWithinMonthsV1: CheckKind<DateWithinMonthsParams> = {
  id: 'date.within-months',
  version: 1,
  title: 'Date within the previous N calendar months',
  description:
    'A named date field of the latest observation falls within the previous N calendar months of the evaluation clock: a date in month M stays within through the last day of month M+N (UTC). The answer changes at the first instant of month M+N+1. A date after the clock, or dates that disagree, need attention.',
  inputs: [{ name: 'subject', description: 'Observations that carry the date field.' }],
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['field', 'months'],
    properties: { field: fieldPath, months: { type: 'integer', minimum: 1, maximum: 1200 } },
  },
  evaluate(params, inputs, clock) {
    const now = utcMillis(clock.evaluatedAt)!;
    const latest = latestObservations(inputs.subject ?? []);
    const dated = latest.flatMap((observation) => {
      const parts = dateParts(observationField(observation, params.field));
      return parts ? [{ observation, parts }] : [];
    });
    const label = fieldLabel(params.field, latest);
    if (!dated.length)
      return result('insufficient', 'pending', 'date_missing', `No valid date is reported for ${label}.`, latest);
    const evidence = dated.map((item) => item.observation);
    const days = [...new Set(dated.map(({ parts }) => Date.UTC(parts[0], parts[1], parts[2])))];
    if (days.length > 1)
      return result(
        'conflicting',
        'attention',
        'dates_disagree',
        `Observations at the same time report different dates for ${label}.`,
        evidence,
      );
    const [year, month] = dated[0]!.parts;
    const day = new Date(days[0]!).toISOString().slice(0, 10);
    if (days[0]! > now)
      return result(
        'conflicting',
        'attention',
        'date_after_clock',
        `${sentenceStart(label)}, ${day}, is after the evaluation time.`,
        evidence,
      );
    const boundary = Date.UTC(year, month + params.months + 1, 1);
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

// A recorded interval covers a window ----------------------------------------------------------------------------

export interface IntervalCoversWindowParams {
  windowStartField?: string;
  windowEndField?: string;
}

interface Segment {
  start: number;
  end: number;
}

/** A recorded interval without an end is in effect up to and including the time the source made the statement. */
function recordedSegment(observation: CheckObservation): Segment | undefined {
  const start = utcMillis(observation.interval?.start);
  if (start === undefined) return undefined;
  const end =
    observation.interval?.end === undefined
      ? utcMillis(observation.occurredAt)! + 1
      : utcMillis(observation.interval.end);
  return end !== undefined && end > start ? { start, end } : undefined;
}

function merged(segments: Segment[]): Segment[] {
  const sorted = [...segments].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Segment[] = [];
  for (const segment of sorted) {
    const last = out.at(-1);
    if (last && segment.start <= last.end) last.end = Math.max(last.end, segment.end);
    else out.push({ ...segment });
  }
  return out;
}

export const intervalCoversWindowV1: CheckKind<IntervalCoversWindowParams> = {
  id: 'interval.covers-window',
  version: 1,
  title: 'A recorded interval covers a window',
  description:
    'Recorded intervals, joined where they touch or overlap, cover the window. The window is the latest window observation (its interval, or the named start and end fields) when the rule reads one, and otherwise the evaluation instant, in which case the answer changes when covering ends or a later interval begins. An interval without an end covers up to the time it was stated.',
  inputs: [
    { name: 'interval', description: 'Observations whose recorded intervals may cover the window.' },
    { name: 'window', description: 'An observation stating the window to cover.', optional: true },
  ],
  summaryRecordValues: ['nextBoundary'],
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { windowStartField: fieldPath, windowEndField: fieldPath },
  },
  evaluate(params, inputs, clock) {
    const recorded = (inputs.interval ?? []).flatMap((observation) => {
      const segment = recordedSegment(observation);
      return segment ? [{ observation, segment }] : [];
    });
    const segments = merged(recorded.map((item) => item.segment));
    const windowObservation = (inputs.window ?? [])[0];
    if (windowObservation) {
      const start = utcMillis(observationField(windowObservation, params.windowStartField ?? 'interval.start'));
      const end = utcMillis(observationField(windowObservation, params.windowEndField ?? 'interval.end'));
      if (start === undefined || end === undefined || end <= start)
        return result('insufficient', 'pending', 'window_missing', 'The window to cover has no valid start and end.', [
          windowObservation,
        ]);
      const overlapping = recorded.filter(({ segment }) => segment.start < end && segment.end > start);
      const evidence = [windowObservation, ...overlapping.map((item) => item.observation)];
      return segments.some((segment) => segment.start <= start && segment.end >= end)
        ? result('supported', 'pass', 'window_covered', 'Recorded intervals cover the whole window.', evidence)
        : result(
            'insufficient',
            'attention',
            'window_not_covered',
            'Recorded intervals do not cover the whole window.',
            evidence,
          );
    }
    const now = utcMillis(clock.evaluatedAt)!;
    const covering = segments.find((segment) => segment.start <= now && now < segment.end);
    const evidence = recorded
      .filter(({ segment }) => segment.start <= now && now < segment.end)
      .map((item) => item.observation);
    if (covering)
      return result(
        'supported',
        'pass',
        'window_covered',
        `A recorded interval is in effect until ${new Date(covering.end).toISOString()}.`,
        evidence,
        covering.end,
      );
    const later = segments.find((segment) => segment.start > now);
    return result(
      'insufficient',
      'attention',
      'window_not_covered',
      'No recorded interval is in effect at the evaluation time.',
      recorded
        .filter(({ segment }) => segment.end <= now)
        .slice(0, 1)
        .map((item) => item.observation),
      later?.start,
    );
  },
};

export const libraryCheckKinds: readonly CheckKind[] = [
  recordCompleteV1,
  valueWithinLimitV1,
  dateWithinMonthsV1,
  intervalCoversWindowV1,
];
for (const kind of libraryCheckKinds) registerCheckKind(kind);
