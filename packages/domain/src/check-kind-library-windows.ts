import type { CheckDetails, IssueTime } from '@ledger/contracts';
import { quantityText, textUnitSchema, type TextUnit } from './quantities.js';
import {
  comparisons,
  current,
  fieldPath,
  labelOf,
  latestNumbers,
  round,
  selectionSchema,
  type Selection,
} from './check-kind-library-records.js';
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
} from './check-kinds.js';

// Check kinds over every value inside a window: the window comes from another input or from the subject's state, such
// as takeoff to landing from a flight report, or scheduled start to end. Each kind, its parameters and inputs are
// listed in docs/design/record-check-kinds.md.

/** A window as an observation states it. Without a stated end, or before its end, the window is still open. */
export interface ObservedWindow {
  start: number;
  /** The stated end; undefined while none is stated. */
  end?: number;
  /** True once the stated end is at or before the evaluation time. */
  closed: boolean;
  evidence: CheckObservation[];
}

export type WindowFound =
  { window: ObservedWindow } | { problem: 'window_missing' | 'windows_disagree'; evidence: CheckObservation[] };

export interface WindowParams {
  windowSelect?: Selection;
  windowStartField?: string;
  windowEndField?: string;
}

export const windowParameterSchema = {
  windowSelect: selectionSchema,
  windowStartField: fieldPath,
  windowEndField: fieldPath,
} as const;

/**
 * The window the latest selected window observations state. A start that is not a UTC instant, or an end before the
 * start, is no window; an end that is absent or null leaves the window open. Simultaneous observations that state
 * different windows disagree.
 */
export function observedWindow(inputs: CheckInputs, params: WindowParams, now: number): WindowFound {
  const latest = latestObservations(current(inputs.window, params.windowSelect));
  const stated = latest.map((observation) => {
    const start = utcMillis(observationField(observation, params.windowStartField ?? 'interval.start'));
    const endValue = observationField(observation, params.windowEndField ?? 'interval.end');
    const end = endValue === undefined || endValue === null ? undefined : (utcMillis(endValue) ?? NaN);
    return { observation, start, end };
  });
  const valid = stated.filter(
    (item) => item.start !== undefined && !Number.isNaN(item.end) && (item.end === undefined || item.end >= item.start),
  );
  if (!valid.length || valid.length < stated.length) return { problem: 'window_missing', evidence: latest };
  if (new Set(valid.map((item) => `${item.start}/${item.end ?? ''}`)).size > 1)
    return { problem: 'windows_disagree', evidence: latest };
  const { start, end } = valid[0]!;
  return {
    window: {
      start: start!,
      ...(end === undefined ? {} : { end }),
      closed: end !== undefined && end <= now,
      evidence: valid.map((item) => item.observation),
    },
  };
}

/** Whether a span start falls in the window as far as it has been observed: from its start to its end or now. */
export function inWindow(window: ObservedWindow, at: number, now: number): boolean {
  return at >= window.start && at <= Math.min(window.end ?? Infinity, now);
}

export function windowDetails(window: ObservedWindow | undefined): CheckDetails {
  return {
    windowStart: window ? new Date(window.start).toISOString() : null,
    windowEnd: window?.end === undefined ? null : new Date(window.end).toISOString(),
    windowClosed: window ? window.closed : null,
  };
}

export const windowDetailDefinitions = [
  { name: 'windowStart', description: 'The start of the window, a UTC instant; null when no window was read.' },
  { name: 'windowEnd', description: 'The stated end of the window, a UTC instant; null while none is stated.' },
  {
    name: 'windowClosed',
    description: 'Whether the stated end is at or before the evaluation time; false while the window is open.',
  },
] as const;

export function iso(time: number): string {
  return new Date(time).toISOString();
}

// Every value in a window within a limit ---------------------------------------------------------------------------

export interface WindowValuesWithinLimitParams extends WindowParams {
  select?: Selection;
  field: string;
  comparison: keyof typeof comparisons;
  limit?: number;
  limitSelect?: Selection;
  limitField?: string;
  includeValueAtStart?: boolean;
  minValues?: number;
  minSeconds?: number;
  maxGapSeconds?: number;
  coverage: 'required' | 'optional';
  unit?: string;
  textUnit?: TextUnit;
  recordedSelect?: Selection;
  recordedField?: string;
  recordedAtField?: string;
  recordedStartField?: string;
  recordedEndField?: string;
  recordedDescribes?: string;
  reportedDescribes?: string;
}

/** The values reported at one instant: outside, within, or disagreeing about the limit. */
interface Instant {
  at: number;
  observations: CheckObservation[];
  values: number[];
  side: 'outside' | 'within' | 'disagree';
}

/** Consecutive instants outside the limit, until the first instant back within it, if any. */
interface Run {
  instants: Instant[];
  /** The first instant back within the limit after the run, inside the window. */
  backWithinAt?: number;
}

function runEnd(run: Run): number {
  return run.backWithinAt ?? run.instants.at(-1)!.at;
}

function runCounts(run: Run, params: WindowValuesWithinLimitParams): boolean {
  return (
    run.instants.length >= (params.minValues ?? 1) &&
    runEnd(run) - run.instants[0]!.at >= (params.minSeconds ?? 0) * 1000
  );
}

function instantsOf(
  values: readonly { observation: CheckObservation; at: number; value: number }[],
  holds: (value: number) => boolean,
): Instant[] {
  const byTime = new Map<number, Instant>();
  for (const item of values) {
    const instant = byTime.get(item.at) ?? { at: item.at, observations: [], values: [], side: 'within' as const };
    instant.observations.push(item.observation);
    instant.values.push(item.value);
    byTime.set(item.at, instant);
  }
  return [...byTime.values()]
    .sort((left, right) => left.at - right.at)
    .map((instant) => {
      const outside = instant.values.filter((value) => !holds(value)).length;
      const side = outside === 0 ? 'within' : outside === instant.values.length ? 'outside' : 'disagree';
      return { ...instant, side };
    });
}

/** Runs of instants outside the limit, oldest first. An instant whose values disagree neither ends nor extends one. */
function runsOf(instants: readonly Instant[]): Run[] {
  const runs: Run[] = [];
  let run: Run | undefined;
  for (const instant of instants) {
    if (instant.side === 'outside') {
      run ??= { instants: [] };
      run.instants.push(instant);
    } else if (instant.side === 'within' && run) {
      runs.push({ ...run, backWithinAt: instant.at });
      run = undefined;
    }
  }
  if (run) runs.push(run);
  return runs;
}

/** Gaps longer than the maximum between the window start, each instant with a value, and a closed window's end. */
function gapsOf(window: ObservedWindow, instants: readonly Instant[], maxGapSeconds: number): number[] {
  const times = [window.start, ...instants.map((instant) => instant.at), ...(window.closed ? [window.end!] : [])];
  const gaps: number[] = [];
  for (let index = 1; index < times.length; index += 1) {
    const gap = times[index]! - times[index - 1]!;
    if (gap > maxGapSeconds * 1000) gaps.push(gap);
  }
  return gaps;
}

function windowResult(
  evidenceState: CheckResult['evidenceState'],
  outcome: CheckResult['outcome'],
  reasonCode: string,
  summary: string,
  evidence: readonly CheckObservation[],
  details: CheckDetails,
  issueTimes: IssueTime[] = [],
  nextBoundary?: number,
): CheckResult {
  return {
    evidenceState,
    outcome,
    reasonCode,
    summary,
    evidence: [...new Set(evidence.map((observation) => observation.id))],
    details,
    issues: issueTimes.map((time) => time.issue),
    issueTimes,
    ...(nextBoundary === undefined ? {} : { nextBoundary: iso(nextBoundary) }),
  };
}

export const windowValuesWithinLimitV1: CheckKind<WindowValuesWithinLimitParams> = {
  id: 'window.values-within-limit',
  version: 1,
  title: 'Every value in a window within a limit',
  description:
    'Every numeric value of a field among the selected observations whose span start falls in a window is compared with a limit: a fixed limit, or a numeric field of the latest selected limit observation, with the comparisons of value.within-limit. The window is stated by the latest selected window observation, an input or the subject state, by its start and end fields (default its interval); both ends belong to it, and a start equal to the end is one instant. With includeValueAtStart, the latest value before the start is in effect at the start and is checked there, unless a value is reported at the start. Values at one instant that fall on different sides of the limit disagree: that instant neither starts nor ends a run, and the evidence conflicts. Consecutive instants outside the limit are a run, which lasts from its first value outside to the first value back within the limit, or to its last value outside when none follows in the window. A run counts only with at least minValues values and lasting at least minSeconds: shorter runs are tolerated. Each counted run is one issue, named and timed by its start. A window with no stated end, or whose end is after the evaluation time, is open: the result covers the values reported so far and says so, a run still going on and not yet long enough to count is pending, and the result is the same when evaluated again after the window closes unless a value inside the window is added. Observations in the window without a numeric value are counted as missing values; with maxGapSeconds, longer stretches without a value from the window start, between values and to a closed window end are gaps. With coverage required, missing values or gaps make an otherwise passing result insufficient, and a closed window with no value is insufficient; with coverage optional a closed window with no value does not apply. No window, or simultaneous windows that disagree, are insufficient or conflicting; a missing limit is insufficient. With unit, the unit the values are stored in, each value and the limit are stated with it; with textUnit too, the unit the rule’s text uses, each is stated in that unit with the stored value in parentheses. With the recorded input, the operator’s own record stands in for what is not reported: when no window observation is on record the window is the latest record’s, from recordedStartField to recordedEndField; with neither the rule does not apply. When no value is reported in the window, the value in recordedField of the latest record is compared with the limit at the instant in recordedAtField, and a value outside the limit is one issue named and timed by that instant. A reported value is read before a recorded one, which the summary then names beside it; the two are never averaged. Records made at the same time that state different values conflict. The summary says which was read, in the rule’s words reportedDescribes and recordedDescribes.',
  inputs: [
    { name: 'values', description: 'Observations or operator records that carry the value.' },
    {
      name: 'window',
      description: 'An observation, operator record or subject state stating the window, such as takeoff to landing.',
    },
    { name: 'limit', description: 'Observations or operator records that carry the limit.', optional: true },
    {
      name: 'recorded',
      description:
        'The operator’s own records of what happened: the window when no window observation states one, and the value read when no value is reported in the window.',
      optional: true,
    },
  ],
  details: [
    ...windowDetailDefinitions,
    {
      name: 'basis',
      description:
        'reported when values reported in the window were compared, recorded when the value in the operator’s own record was; null when none was.',
    },
    {
      name: 'recordedValue',
      description: 'The value in the operator’s own record; null when none is on record.',
    },
    {
      name: 'recordedNote',
      description:
        'With reported values read, the sentence naming the recorded value beside them, with a leading space, or empty when none is on record; null when the recorded value was read. A rule’s wording ends with it.',
    },
    { name: 'limit', description: 'The limit the values were compared with; null when none was read.' },
    { name: 'valuesChecked', description: 'How many numeric values in the window were compared with the limit.' },
    { name: 'missingValues', description: 'How many observations in the window carry no numeric value.' },
    { name: 'disagreeingInstants', description: 'How many instants report values on both sides of the limit.' },
    { name: 'runCount', description: 'How many runs outside the limit count.' },
    {
      name: 'secondsOutside',
      description: 'The total length of the counted runs, in seconds, each from its first value outside to its end.',
    },
    { name: 'firstRunStartedAt', description: 'When the first counted run began; null when none counts.' },
    {
      name: 'worstValue',
      description:
        'The reported value furthest on the wrong side of the limit, or nearest to it when none is outside; null when the recorded value was read.',
    },
    { name: 'worstValueAt', description: 'When the worst value was reported.' },
    { name: 'worstMargin', description: 'The margin of the worst value to the limit; negative outside it.' },
    { name: 'gapCount', description: 'With maxGapSeconds, how many gaps are longer; otherwise null.' },
    { name: 'longestGapSeconds', description: 'With maxGapSeconds, the longest gap, in seconds; otherwise null.' },
  ],
  summaryValues: ['windowStart', 'windowEnd', 'worstValueAt'],
  summaryRecordValues: ['evidenceOccurredAt'],
  issues: {
    description: 'One counted run of values outside the limit inside the window, named by when it began.',
    timed:
      'A run starts at its first value outside the limit and ends at the first value back within it; with none in the window, at its last value outside once the window has closed, and it continues while the window is open.',
  },
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['field', 'comparison', 'coverage'],
    properties: {
      select: selectionSchema,
      field: fieldPath,
      comparison: { enum: Object.keys(comparisons) },
      limit: { type: 'number' },
      limitSelect: selectionSchema,
      limitField: fieldPath,
      ...windowParameterSchema,
      includeValueAtStart: { type: 'boolean' },
      minValues: { type: 'integer', minimum: 1, maximum: 10_000 },
      minSeconds: { type: 'number', minimum: 0, maximum: 86_400 },
      maxGapSeconds: { type: 'number', exclusiveMinimum: 0, maximum: 86_400 },
      coverage: { enum: ['required', 'optional'] },
      unit: { type: 'string', minLength: 1, maxLength: 20 },
      textUnit: textUnitSchema,
      recordedSelect: selectionSchema,
      recordedField: fieldPath,
      recordedAtField: fieldPath,
      recordedStartField: fieldPath,
      recordedEndField: fieldPath,
      recordedDescribes: { type: 'string', minLength: 1, maxLength: 200 },
      reportedDescribes: { type: 'string', minLength: 1, maxLength: 200 },
    },
    oneOf: [{ required: ['limit'] }, { required: ['limitField'] }],
    dependencies: {
      limitSelect: ['limitField'],
      textUnit: ['unit'],
      recordedField: ['recordedAtField', 'recordedDescribes', 'reportedDescribes'],
      recordedAtField: ['recordedField'],
      recordedDescribes: ['recordedField'],
      reportedDescribes: ['recordedField'],
      recordedStartField: ['recordedEndField', 'recordedField'],
      recordedEndField: ['recordedStartField'],
      recordedSelect: ['recordedField'],
    },
  },
  evaluate(params, inputs, clock) {
    const now = utcMillis(clock.evaluatedAt)!;
    const details: CheckDetails = {
      ...windowDetails(undefined),
      basis: null,
      recordedValue: null,
      recordedNote: '',
      limit: null,
      valuesChecked: 0,
      missingValues: 0,
      disagreeingInstants: 0,
      runCount: 0,
      secondsOutside: 0,
      firstRunStartedAt: null,
      worstValue: null,
      worstValueAt: null,
      worstMargin: null,
      gapCount: null,
      longestGapSeconds: null,
    };
    const readsRecorded = params.recordedField !== undefined && inputs.recorded !== undefined;
    const recordedRead = readsRecorded ? current(inputs.recorded, params.recordedSelect) : [];
    let found = observedWindow(inputs, params, now);
    // With no window observation on record, the operator's own record states the window.
    if ('problem' in found && !found.evidence.length && readsRecorded && params.recordedStartField !== undefined) {
      const fromRecord = observedWindow(
        { window: recordedRead },
        { windowStartField: params.recordedStartField, windowEndField: params.recordedEndField },
        now,
      );
      if ('problem' in fromRecord && !fromRecord.evidence.length)
        return windowResult(
          'not_applicable',
          'not_applicable',
          'not_flown_on_file',
          `Neither a report nor the operator’s own record states when it happened, so no ${params.reportedDescribes} can be read yet.`,
          [],
          details,
        );
      found = fromRecord;
    }
    if ('problem' in found)
      return found.problem === 'windows_disagree'
        ? windowResult(
            'conflicting',
            'attention',
            'windows_disagree',
            'Observations at the same time state different windows.',
            found.evidence,
            details,
          )
        : windowResult(
            'insufficient',
            'pending',
            'window_missing',
            'No window with a valid start, and an end not before it, is recorded.',
            found.evidence,
            details,
          );
    const window = found.window;
    Object.assign(details, windowDetails(window));
    const evidence = [...window.evidence];
    let limit = params.limit;
    if (params.limitField !== undefined) {
      const limits = latestNumbers(current(inputs.limit, params.limitSelect), params.limitField);
      const limitLabel = labelOf(params.limitField, limits.latest, params.limitSelect);
      evidence.push(...limits.reported.map((item) => item.observation));
      if (!limits.reported.length)
        return windowResult(
          'insufficient',
          'attention',
          'limit_missing',
          `No value is recorded for ${limitLabel}.`,
          [...evidence, ...limits.latest],
          details,
        );
      if (limits.values.length > 1)
        return windowResult(
          'conflicting',
          'attention',
          'limits_disagree',
          `Observations at the same time report different values for ${limitLabel}: ${limits.values.join(', ')}.`,
          evidence,
          details,
        );
      limit = limits.values[0]!;
    }
    details.limit = limit!;
    const comparison = comparisons[params.comparison];
    const holds = (value: number) => comparison.holds(value, limit!);
    const recorded = latestNumbers(recordedRead, params.recordedField ?? '');
    if (readsRecorded && recorded.values.length > 1)
      return windowResult(
        'conflicting',
        'attention',
        'recorded_values_disagree',
        `Records made at the same time state different ${params.recordedDescribes}: ${recorded.values.join(', ')}.`,
        [...evidence, ...recorded.reported.map((item) => item.observation)],
        details,
      );
    const recordedItem = readsRecorded ? recorded.reported[0] : undefined;
    if (recordedItem) details.recordedValue = recordedItem.value;
    const selected = current(inputs.values, params.select).map((observation) => ({
      observation,
      at: Date.parse(spanStart(observation)),
      value: observationField(observation, params.field),
    }));
    const numeric = (item: (typeof selected)[number]): item is (typeof selected)[number] & { value: number } =>
      typeof item.value === 'number' && Number.isFinite(item.value);
    const inside = selected.filter((item) => inWindow(window, item.at, now));
    const reported = inside.filter(numeric);
    const missing = inside.filter((item) => !numeric(item));
    if (params.includeValueAtStart && !reported.some((item) => item.at === window.start)) {
      const before = selected.filter(numeric).filter((item) => item.at < window.start);
      const newest = Math.max(...before.map((item) => item.at));
      reported.push(...before.filter((item) => item.at === newest).map((item) => ({ ...item, at: window.start })));
    }
    details.valuesChecked = reported.length;
    details.missingValues = missing.length;
    const field = labelOf(
      params.field,
      selected.map((item) => item.observation),
      params.select,
    );
    const stated = (quantity: number) =>
      params.unit === undefined ? String(quantity) : quantityText(quantity, params.unit, params.textUnit);
    const label = `${field} ${comparison.words} ${stated(limit!)}`;
    const span = `from ${iso(window.start)} ${window.closed ? `to ${iso(window.end!)}` : 'so far, the window still open'}`;
    const openBoundary = window.closed ? undefined : window.end;
    if (!reported.length && recordedItem) {
      const at = utcMillis(observationField(recordedItem.observation, params.recordedAtField!)) ?? window.start;
      const within = holds(recordedItem.value);
      const issueTimes = within ? [] : [{ issue: `outside-from:${iso(at)}`, start: iso(at), end: iso(at) }];
      Object.assign(details, {
        basis: 'recorded',
        recordedNote: null,
        valuesChecked: 1,
        runCount: within ? 0 : 1,
        firstRunStartedAt: within ? null : iso(at),
        missingValues: missing.length,
      });
      const summary = `No ${params.reportedDescribes} is reported; the result rests on the operator’s own record. Read the ${params.recordedDescribes}: ${stated(recordedItem.value)}, ${within ? 'within' : 'outside'} the limit, ${comparison.words} ${stated(limit!)}.`;
      return within
        ? windowResult(
            'supported',
            'pass',
            'recorded_within_limit',
            summary,
            [...evidence, recordedItem.observation],
            details,
          )
        : windowResult(
            'supported',
            'attention',
            'recorded_outside_limit',
            summary,
            [...evidence, recordedItem.observation],
            details,
            issueTimes,
          );
    }
    const recordedNone =
      readsRecorded && !reported.length ? ` The ${params.recordedDescribes} is not on file either.` : '';
    const recordedBeside = recordedItem
      ? ` The ${params.recordedDescribes} is ${stated(recordedItem.value)}; the reported value is read, not the recorded one.`
      : '';
    if (reported.length) Object.assign(details, { basis: 'reported', recordedNote: recordedBeside });
    if (!reported.length) {
      const missingNote = `${missing.length ? ` ${missing.length} observation(s) carry no value for ${field}.` : ''}${recordedNone}`;
      if (!window.closed)
        return windowResult(
          'insufficient',
          'pending',
          'values_awaited',
          `No value is reported for ${field} in the window ${span}.${missingNote}`,
          [...evidence, ...missing.map((item) => item.observation)],
          details,
          [],
          openBoundary,
        );
      return params.coverage === 'required'
        ? windowResult(
            'insufficient',
            'attention',
            'values_missing',
            `No value is reported for ${field} in the window ${span}.${missingNote}`,
            [...evidence, ...missing.map((item) => item.observation)],
            details,
          )
        : windowResult(
            'not_applicable',
            'not_applicable',
            'no_values_in_window',
            `No value is reported for ${field} in the window ${span}.${recordedNone}`,
            evidence,
            details,
          );
    }
    const instants = instantsOf(reported, holds);
    // The earliest of equally bad values, so the answer does not depend on the order the values were read in.
    const oldestFirst = [...reported].sort(
      (left, right) => left.at - right.at || (left.observation.id < right.observation.id ? -1 : 1),
    );
    const worst = oldestFirst.reduce((most, item) =>
      (item.value - limit!) * comparison.margin < (most.value - limit!) * comparison.margin ? item : most,
    );
    Object.assign(details, {
      worstValue: worst.value,
      worstValueAt: iso(worst.at),
      worstMargin: round((worst.value - limit!) * comparison.margin),
      disagreeingInstants: instants.filter((instant) => instant.side === 'disagree').length,
    });
    const runs = runsOf(instants);
    const counted = runs.filter((run) => runCounts(run, params));
    const trailing = runs.at(-1)?.backWithinAt === undefined ? runs.at(-1) : undefined;
    const issueTimes = counted.map((run) => {
      const start = iso(run.instants[0]!.at);
      const ended = run.backWithinAt !== undefined || window.closed;
      return { issue: `outside-from:${start}`, start, ...(ended ? { end: iso(runEnd(run)) } : {}) };
    });
    Object.assign(details, {
      runCount: counted.length,
      secondsOutside: round(counted.reduce((sum, run) => sum + runEnd(run) - run.instants[0]!.at, 0) / 1000),
      firstRunStartedAt: issueTimes[0]?.start ?? null,
    });
    const gaps = params.maxGapSeconds === undefined ? undefined : gapsOf(window, instants, params.maxGapSeconds);
    if (gaps) Object.assign(details, { gapCount: gaps.length, longestGapSeconds: round(Math.max(0, ...gaps) / 1000) });
    const notes = [
      ...(details.disagreeingInstants
        ? [`${details.disagreeingInstants} instant(s) report values on both sides of the limit`]
        : []),
      ...(missing.length ? [`${missing.length} observation(s) carry no value for ${field}`] : []),
      ...(gaps?.length ? [`${gaps.length} gap(s) longer than ${params.maxGapSeconds} s without a value`] : []),
    ];
    const noteText = `${notes.length ? ` ${notes.join('; ')}.` : ''}${recordedBeside}`;
    const worstText = `the worst is ${stated(worst.value)} at ${iso(worst.at)}`;
    const disagree = details.disagreeingInstants !== 0;
    if (counted.length) {
      const cited = counted.flatMap((run) => run.instants.flatMap((instant) => instant.observations));
      return windowResult(
        disagree ? 'conflicting' : 'supported',
        'attention',
        'values_outside_limit',
        `${counted.length} run(s) of ${field} outside ${comparison.words} ${stated(limit!)} in the window ${span}, ${details.secondsOutside} s in all; ${worstText}.${noteText}`,
        [...evidence, ...cited],
        details,
        issueTimes,
        openBoundary,
      );
    }
    if (trailing && !window.closed)
      return windowResult(
        'insufficient',
        'pending',
        'outside_unconfirmed',
        `${trailing.instants.length} value(s) since ${iso(trailing.instants[0]!.at)} are outside ${label}, fewer or shorter than a run counts; the window is still open.${noteText}`,
        [...evidence, ...trailing.instants.flatMap((instant) => instant.observations)],
        details,
        [],
        openBoundary,
      );
    const all = [...reported.map((item) => item.observation), ...missing.map((item) => item.observation)];
    if (disagree)
      return windowResult(
        'conflicting',
        'attention',
        'values_disagree',
        `Values at the same time fall on both sides of ${label} in the window ${span}.${noteText}`,
        [...evidence, ...all],
        details,
        [],
        openBoundary,
      );
    if (params.coverage === 'required' && (missing.length || gaps?.length))
      return windowResult(
        'insufficient',
        'attention',
        'coverage_gap',
        `No counted run of ${field} outside the limit among ${reported.length} value(s) in the window ${span}, but the values do not cover it:${noteText}`,
        [...evidence, ...all],
        details,
        [],
        openBoundary,
      );
    const tolerated = runs.length ? ` ${runs.length} shorter run(s) outside the limit are tolerated.` : '';
    return windowResult(
      'supported',
      'pass',
      'values_within_limit',
      `${reported.length} value(s) of ${field} in the window ${span} are ${comparison.words} ${stated(limit!)}; ${worstText}.${tolerated}${noteText}`,
      [...evidence, ...all],
      details,
      [],
      openBoundary,
    );
  },
};

export const windowCheckKinds: readonly CheckKind[] = [windowValuesWithinLimitV1];
for (const kind of windowCheckKinds) registerCheckKind(kind);
