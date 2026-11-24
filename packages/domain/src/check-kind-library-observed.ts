import type { CheckDetails } from '@ledger/contracts';
import { quantityText, textUnitSchema, type TextUnit } from './quantities.js';
import { distancesOutsideArea } from './check-kind-library-geometry.js';
import {
  comparisons,
  current,
  fieldPath,
  latestNumbers,
  round,
  scalars,
  selectionSchema,
  type Condition,
  type Scalar,
  type Selection,
} from './check-kind-library-records.js';
import { iso } from './check-kind-library-windows.js';
import {
  latestObservations,
  observationField,
  observationMatches,
  registerCheckKind,
  spanStart,
  utcMillis,
  type CheckInputs,
  type CheckKind,
  type CheckObservation,
  type CheckResult,
} from './check-kinds.js';
import { sentenceStart } from './field-labels.js';

// Check kinds that read what was flown when it is on record and what was planned otherwise, and say which they read
// (docs/design/observed-values.md). Each kind, its parameters and inputs are listed in docs/design/record-check-kinds.md.

/** What a flown observation measures, by conditions on it, and whether the rule compares it with its limit. */
export interface FlownMeasure {
  where?: Condition[];
  describes: string;
  compared: boolean;
  /** Compared only when no value is recorded in the operator's own record of the flight. */
  afterRecorded?: boolean;
}

const words = { type: 'string', minLength: 1, maxLength: 200 } as const;
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
const measuresSchema = {
  type: 'array',
  minItems: 1,
  maxItems: 10,
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['describes', 'compared'],
    properties: {
      where: { type: 'array', minItems: 1, maxItems: 10, items: conditionSchema },
      describes: words,
      compared: { type: 'boolean' },
      afterRecorded: { type: 'boolean' },
    },
  },
} as const;
const unusableSchema = {
  type: 'array',
  minItems: 1,
  maxItems: 10,
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['field', 'oneOf'],
    properties: { field: fieldPath, oneOf: scalars },
  },
} as const;

function result(
  evidenceState: CheckResult['evidenceState'],
  outcome: CheckResult['outcome'],
  reasonCode: string,
  summary: string,
  evidence: readonly CheckObservation[],
  details: CheckDetails,
): CheckResult {
  return {
    evidenceState,
    outcome,
    reasonCode,
    summary,
    evidence: [...new Set(evidence.map((observation) => observation.id))],
    details: { ...details, reading: summary.length <= 1000 ? summary : null },
  };
}

/**
 * A number for a sentence: at most two decimals, with the unit when the rule gives one, stated first in the unit the
 * rule's text uses when it declares one (quantities.ts).
 */
function shown(value: number, unit: string | undefined, textUnit?: string): string {
  return quantityText(value, unit, textUnit);
}

function list(items: readonly string[]): string {
  return items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** The flown observations the rule can use: those no unusable condition names. */
function usableFlown(
  observations: readonly CheckObservation[] | undefined,
  unusable: readonly { field: string; oneOf: Scalar[] }[] = [],
): CheckObservation[] {
  return (observations ?? []).filter(
    (observation) => !unusable.some((condition) => observationMatches(observation, [condition])),
  );
}

interface Measured {
  observation: CheckObservation;
  value: number;
  at: number;
  measure: FlownMeasure;
}

/** Each flown value sorted into those the rule compares and the words for those it does not. */
function measuredValues(
  observations: readonly CheckObservation[],
  field: string,
  measures: readonly FlownMeasure[],
): { compared: Measured[]; notCompared: { observation: CheckObservation; describes: string }[] } {
  const compared: Measured[] = [];
  const notCompared: { observation: CheckObservation; describes: string }[] = [];
  for (const observation of observations) {
    const value = observationField(observation, field);
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const measure = measures.find((candidate) => observationMatches(observation, candidate.where ?? []));
    if (!measure) notCompared.push({ observation, describes: 'a value this rule does not read' });
    else if (!measure.compared) notCompared.push({ observation, describes: measure.describes });
    else compared.push({ observation, value, at: Date.parse(spanStart(observation)), measure });
  }
  return { compared, notCompared };
}

/** The value furthest towards the wrong side of the limit, the earliest of equals. */
function worstOf(values: readonly Measured[], comparison: keyof typeof comparisons): Measured {
  const higherIsWorse = comparisons[comparison].margin < 0;
  return [...values].sort((a, b) => (higherIsWorse ? b.value - a.value : a.value - b.value) || a.at - b.at)[0]!;
}

/** Why the flown values, if any, give the rule nothing to compare, and what the result rests on instead. */
function noFlownWords(
  readsFlown: boolean,
  notCompared: readonly { describes: string }[],
  subject: string,
  restsOn = 'the plan',
): string {
  if (!readsFlown) return `This rule reads no flown ${subject}; the result rests on ${restsOn}.`;
  if (!notCompared.length) return `No flown ${subject} is reported for this flight; the result rests on ${restsOn}.`;
  const kinds = [...new Set(notCompared.map((item) => item.describes))];
  return `${notCompared.length} flown value(s) are reported for this flight, but they state ${list(kinds)}, which this rule does not compare with its limit; the result rests on ${restsOn}.`;
}

// A value flown, or else planned, within a limit -------------------------------------------------------------------

export interface FlownOrPlannedParams {
  planSelect?: Selection;
  planDescribes?: string;
  plannedField: string;
  plannedDescribes: string;
  recordedSelect?: Selection;
  recordedField?: string;
  recordedDescribes?: string;
  flownField?: string;
  flownDescribes?: string;
  measures?: FlownMeasure[];
  unusable?: { field: string; oneOf: Scalar[] }[];
  comparison: keyof typeof comparisons;
  limit: number;
  limitDescribes?: string;
  unit?: string;
  textUnit?: TextUnit;
}

const flownOrPlannedDetails = [
  {
    name: 'basis',
    description:
      'flown when a reported flown value was compared, recorded when the result rests on the operator’s own record of the flight, planned when it rests on the plan.',
  },
  { name: 'measured', description: 'In words, what the value compared with the limit measures.' },
  {
    name: 'value',
    description: 'The value compared with the limit: the worst flown value, the recorded value, or the planned value.',
  },
  { name: 'valueAt', description: 'When the worst flown value was reported; null for a recorded or planned value.' },
  { name: 'plannedValue', description: 'The planned value; null when the plan states none.' },
  {
    name: 'recordedValue',
    description: 'The value the operator recorded for the flight; null when none is on record.',
  },
  { name: 'limit', description: 'The limit.' },
  { name: 'margin', description: 'How far the value compared is on the right side of the limit; negative beyond it.' },
  { name: 'flownValues', description: 'How many flown values were compared with the limit.' },
  { name: 'flownNotCompared', description: 'How many flown values state a measure the rule does not compare.' },
  { name: 'reading', description: 'The result in one or more sentences, for a rule’s wording to quote.' },
] as const;

export const valueFlownOrPlannedV1: CheckKind<FlownOrPlannedParams> = {
  id: 'value.flown-or-planned',
  version: 1,
  title: 'Flown value, or else planned value, within a limit',
  description:
    'Three sources in order. When the rule reads flown observations and any of them states a value the rule compares (one matching a measure the rule marks as compared), the worst of those values is compared with the limit: the highest for at_most and below, the lowest for at_least and above. Otherwise, when the rule reads the operator’s own record of the flight and the latest selected one states a value, that value is compared. Otherwise the planned value in the latest selected plan is compared. Every result says which it read and why it does not rest on the one before: no flown value is reported, the flown values state a measure the rule does not compare (named in the rule’s words), or the rule reads none; in words and in the details basis and measured. A value compared from a measure marked afterRecorded counts only when no recorded value is on record. When a flown value is read and a recorded value is also on record, the summary states the recorded value beside it; the two are never averaged. A flown or recorded value beyond the limit needs attention whatever the plan says, and the summary states the planned value beside it. Flown observations matching an unusable condition are left out; a flown value matching no measure is not compared. A missing planned value with no flown or recorded value is insufficient; simultaneous plans or records stating different values conflict. With textUnit, the unit the rule’s text uses, each value is stated in it with the stored value in parentheses. With planDescribes the sentences name the plan input in the rule’s words, such as the latest preflight assessment, instead of the plan.',
  inputs: [
    { name: 'plan', description: 'Operator records or observations that carry the planned value.' },
    {
      name: 'recorded',
      description: 'The operator’s own records of the flight as flown, carrying the recorded value.',
      optional: true,
    },
    { name: 'flown', description: 'Observations reported while the flight was flown.', optional: true },
  ],
  details: [...flownOrPlannedDetails],
  summaryValues: ['valueAt'],
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['plannedField', 'plannedDescribes', 'comparison', 'limit'],
    properties: {
      planSelect: selectionSchema,
      planDescribes: words,
      plannedField: fieldPath,
      plannedDescribes: words,
      recordedSelect: selectionSchema,
      recordedField: fieldPath,
      recordedDescribes: words,
      flownField: fieldPath,
      flownDescribes: words,
      measures: measuresSchema,
      unusable: unusableSchema,
      comparison: { enum: Object.keys(comparisons) },
      limit: { type: 'number' },
      limitDescribes: words,
      unit: { type: 'string', minLength: 1, maxLength: 20 },
      textUnit: textUnitSchema,
    },
    dependencies: {
      flownField: ['flownDescribes'],
      measures: ['flownField'],
      unusable: ['flownField'],
      recordedField: ['recordedDescribes'],
      recordedDescribes: ['recordedField'],
      recordedSelect: ['recordedField'],
    },
  },
  evaluate(params, inputs) {
    const comparison = comparisons[params.comparison];
    const planName = params.planDescribes ?? 'the plan';
    const limitWords =
      params.limitDescribes ?? `${comparison.words} ${shown(params.limit, params.unit, params.textUnit)}`;
    const planned = latestNumbers(current(inputs.plan, params.planSelect), params.plannedField);
    const plannedValue = planned.values.length === 1 ? planned.values[0]! : null;
    const readsRecorded = inputs.recorded !== undefined && params.recordedField !== undefined;
    const recorded = readsRecorded
      ? latestNumbers(current(inputs.recorded, params.recordedSelect), params.recordedField!)
      : { latest: [], reported: [], values: [] };
    const recordedValue = recorded.values.length === 1 ? recorded.values[0]! : null;
    const readsFlown = inputs.flown !== undefined && params.flownField !== undefined;
    const measured = readsFlown
      ? measuredValues(
          usableFlown(inputs.flown, params.unusable),
          params.flownField!,
          params.measures ?? [{ describes: params.flownDescribes!, compared: true }],
        )
      : { compared: [], notCompared: [] };
    // A measure that ranks after the operator's record is not compared when the record states a value.
    const compared = measured.compared.filter((item) => !item.measure.afterRecorded || recordedValue === null);
    const notCompared = [
      ...measured.notCompared,
      ...measured.compared
        .filter((item) => !compared.includes(item))
        .map((item) => ({ observation: item.observation, describes: item.measure.describes })),
    ];
    const details: CheckDetails = {
      basis: 'planned',
      measured: params.plannedDescribes,
      value: plannedValue,
      valueAt: null,
      plannedValue,
      recordedValue,
      limit: params.limit,
      margin: null,
      flownValues: compared.length,
      flownNotCompared: notCompared.length,
    };
    const planEvidence = planned.reported.map((item) => item.observation);
    const recordedEvidence = recorded.reported.map((item) => item.observation);
    if (planned.values.length > 1)
      return result(
        'conflicting',
        'attention',
        'planned_values_disagree',
        `Plans recorded at the same time state different ${params.plannedDescribes}: ${planned.values.join(', ')}.`,
        planEvidence,
        details,
      );
    if (recorded.values.length > 1)
      return result(
        'conflicting',
        'attention',
        'recorded_values_disagree',
        `Records of the flight made at the same time state different ${params.recordedDescribes}: ${recorded.values.join(', ')}.`,
        recordedEvidence,
        details,
      );
    const plannedWords =
      plannedValue === null
        ? `${sentenceStart(planName)} states no ${params.plannedDescribes}.`
        : `The ${params.plannedDescribes} is ${shown(plannedValue, params.unit, params.textUnit)}, ${comparison.holds(plannedValue, params.limit) ? 'within' : 'beyond'} the limit.`;
    const recordedWords =
      recordedValue === null
        ? ''
        : ` The ${params.recordedDescribes} is ${shown(recordedValue, params.unit, params.textUnit)}, ${comparison.holds(recordedValue, params.limit) ? 'within' : 'beyond'} the limit; the reported value is read, not the recorded one.`;
    const skippedWords = notCompared.length
      ? ` ${notCompared.length} other flown value(s) state ${list([...new Set(notCompared.map((item) => item.describes))])} and are not compared.`
      : '';
    if (compared.length) {
      const worst = worstOf(compared, params.comparison);
      const holds = comparison.holds(worst.value, params.limit);
      const others = [...new Set(compared.map((item) => item.measure.describes))].filter(
        (describes) => describes !== worst.measure.describes,
      );
      Object.assign(details, {
        basis: 'flown',
        measured: worst.measure.describes,
        value: round(worst.value),
        valueAt: iso(worst.at),
        margin: round((worst.value - params.limit) * comparison.margin),
      });
      const also = others.length ? ` Values are also stated as ${list(others)}.` : '';
      const summary = `Read the ${worst.measure.describes}: of ${compared.length} value(s) on record for this flight, the ${comparison.margin < 0 ? 'highest' : 'lowest'} is ${shown(worst.value, params.unit, params.textUnit)} at ${iso(worst.at)}, ${holds ? 'within' : 'beyond'} the limit (${limitWords}).${recordedWords} ${plannedWords}${also}${skippedWords}`;
      const evidence = [worst.observation, ...recordedEvidence, ...planEvidence];
      return holds
        ? result('supported', 'pass', 'flown_within_limit', summary, evidence, details)
        : result('supported', 'attention', 'flown_beyond_limit', summary, evidence, details);
    }
    const flownSubject = params.flownDescribes ?? 'value';
    if (recordedValue !== null) {
      const holds = comparison.holds(recordedValue, params.limit);
      Object.assign(details, {
        basis: 'recorded',
        measured: params.recordedDescribes,
        value: recordedValue,
        margin: round((recordedValue - params.limit) * comparison.margin),
      });
      const why = readsFlown
        ? `${noFlownWords(true, measured.notCompared, flownSubject, 'the operator’s own record of the flight')} `
        : '';
      const deferred = notCompared.length > measured.notCompared.length ? skippedWords : '';
      const summary = `${why}Read the ${params.recordedDescribes}: ${shown(recordedValue, params.unit, params.textUnit)}, ${holds ? 'within' : 'beyond'} the limit (${limitWords}). ${plannedWords}${deferred}`;
      const evidence = [...recordedEvidence, ...planEvidence];
      return holds
        ? result('supported', 'pass', 'recorded_within_limit', summary, evidence, details)
        : result('supported', 'attention', 'recorded_beyond_limit', summary, evidence, details);
    }
    const recordedNone = readsRecorded ? ` No record of the flight as flown states a ${params.recordedDescribes}.` : '';
    const why = `${noFlownWords(readsFlown, notCompared, flownSubject, planName)}${recordedNone}`;
    if (plannedValue === null)
      return result(
        'insufficient',
        'pending',
        'planned_value_missing',
        `${why} ${plannedWords}`,
        planned.latest,
        details,
      );
    details.margin = round((plannedValue - params.limit) * comparison.margin);
    const summary = `${why} ${plannedWords.replace(/the limit\.$/, `the limit (${limitWords}).`)}`;
    return comparison.holds(plannedValue, params.limit)
      ? result('supported', 'pass', 'planned_within_limit', summary, planEvidence, details)
      : result('supported', 'attention', 'planned_beyond_limit', summary, planEvidence, details);
  },
};

// An airspace authorization covers the flight ----------------------------------------------------------------------

export interface AuthorizationCoversFlightParams {
  planSelect?: Selection;
  plannedStartField: string;
  plannedEndField: string;
  plannedHeightField?: string;
  plannedHeightDescribes?: string;
  recordedSelect?: Selection;
  recordedStartField?: string;
  recordedEndField?: string;
  recordedHeightField?: string;
  recordedHeightDescribes?: string;
  heightField?: string;
  measures?: FlownMeasure[];
  unusable?: { field: string; oneOf: Scalar[] }[];
  inForce: string[];
  awaiting?: string[];
  ceilingDatums: string[];
  /** The unit the rule's text states heights and distances in. */
  textUnit?: TextUnit;
}

interface Point {
  latitude: number;
  longitude: number;
}

/**
 * The flight as read: its time, height and place, flown when positions are on record, else from the operator's own
 * record of the flight, else planned.
 */
interface FlightRead {
  basis: 'flown' | 'recorded' | 'planned';
  start: number;
  end: number;
  timeWords: string;
  height?: { meters: number; describes: string; observation?: CheckObservation };
  heightNote: string;
  positions: { observation: CheckObservation; point: Point }[];
  evidence: CheckObservation[];
}

interface Problem {
  code: 'status' | 'not_started' | 'expired' | 'no_interval' | 'other_place' | 'ceiling_below';
  words: string;
}

interface Assessed {
  id: string;
  report: CheckObservation;
  status: string;
  problems: Problem[];
  notes: string[];
  ceilingMeters: number | null;
  positionsOutside: number;
  outside: CheckObservation[];
}

function pointOf(observation: CheckObservation): Point | undefined {
  const latitude = observationField(observation, 'position.latitudeDegrees');
  const longitude = observationField(observation, 'position.longitudeDegrees');
  return typeof latitude === 'number' && typeof longitude === 'number' ? { latitude, longitude } : undefined;
}

function flightRead(params: AuthorizationCoversFlightParams, inputs: CheckInputs): FlightRead | undefined {
  const plans = latestObservations(current(inputs.plan, params.planSelect));
  const plan = plans[0];
  const recorded = latestObservations(current(inputs.recorded, params.recordedSelect))[0];
  const usable = usableFlown(inputs.flown, params.unusable).flatMap((observation) => {
    const point = pointOf(observation);
    return point ? [{ observation, point, at: Date.parse(spanStart(observation)) }] : [];
  });
  const heights =
    params.heightField === undefined
      ? { compared: [], notCompared: [] }
      : measuredValues(
          usable.map((item) => item.observation),
          params.heightField,
          params.measures ?? [],
        );
  const numberAt = (observation: CheckObservation | undefined, field: string | undefined) => {
    const value = observation && field ? observationField(observation, field) : undefined;
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  };
  const plannedHeight = numberAt(plan, params.plannedHeightField);
  const plannedHeightRead =
    plannedHeight === undefined
      ? undefined
      : { meters: plannedHeight, describes: params.plannedHeightDescribes ?? 'planned height' };
  const recordedHeight = numberAt(recorded, params.recordedHeightField);
  const recordedHeightRead =
    recordedHeight === undefined
      ? undefined
      : {
          meters: recordedHeight,
          describes: params.recordedHeightDescribes ?? 'recorded height',
          observation: recorded,
        };
  const flownHeight = heights.compared.length ? worstOf(heights.compared, 'at_most') : undefined;
  const height = flownHeight
    ? { meters: flownHeight.value, describes: flownHeight.measure.describes, observation: flownHeight.observation }
    : (recordedHeightRead ?? plannedHeightRead);
  const heightNote = flownHeight
    ? ''
    : heights.notCompared.length
      ? ` The flown positions state ${list([...new Set(heights.notCompared.map((item) => item.describes))])}, which this rule does not compare with a ceiling, so the height read is the ${recordedHeightRead ? 'flight record’s' : 'plan’s'}.`
      : '';
  if (usable.length) {
    const times = usable.map((item) => item.at);
    return {
      basis: 'flown',
      start: Math.min(...times),
      end: Math.max(...times),
      timeWords: `flown positions, from ${iso(Math.min(...times))} to ${iso(Math.max(...times))}`,
      ...(height ? { height } : {}),
      heightNote,
      positions: usable.map(({ observation, point }) => ({ observation, point })),
      evidence: [...plans, ...(recordedHeightRead && !flownHeight ? [recorded!] : [])],
    };
  }
  const takeoff = recorded ? utcMillis(observationField(recorded, params.recordedStartField ?? '')) : undefined;
  const landing = recorded ? utcMillis(observationField(recorded, params.recordedEndField ?? '')) : undefined;
  if (takeoff !== undefined && landing !== undefined && landing > takeoff)
    return {
      basis: 'recorded',
      start: takeoff,
      end: landing,
      timeWords: `takeoff and landing in the operator’s flight record, from ${iso(takeoff)} to ${iso(landing)}`,
      ...(height ? { height } : {}),
      heightNote,
      positions: [],
      evidence: [recorded!, ...plans],
    };
  if (!plan) return undefined;
  const start = utcMillis(observationField(plan, params.plannedStartField));
  const end = utcMillis(observationField(plan, params.plannedEndField));
  if (start === undefined || end === undefined || end < start) return undefined;
  return {
    basis: 'planned',
    start,
    end,
    timeWords: `planned window, from ${iso(start)} to ${iso(end)}`,
    ...(height ? { height } : {}),
    heightNote,
    positions: [],
    evidence: [...plans, ...(recordedHeightRead ? [recorded!] : [])],
  };
}

/** The report of one authorization the rule reads: the latest made by the end of the flight, else the first. */
function reportAtFlight(
  reports: readonly CheckObservation[],
  end: number,
): { report: CheckObservation; after: boolean } | { conflicting: CheckObservation[] } {
  const byTime = [...reports].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  const before = byTime.filter((report) => Date.parse(report.occurredAt) <= end);
  const chosen = before.at(-1) ?? byTime[0]!;
  const simultaneous = byTime.filter((report) => report.occurredAt === chosen.occurredAt);
  const statuses = new Set(simultaneous.map((report) => observationField(report, 'values.reportedStatus')));
  if (statuses.size > 1) return { conflicting: simultaneous };
  return { report: chosen, after: !before.length };
}

function assessAuthorization(
  params: AuthorizationCoversFlightParams,
  flight: FlightRead,
  id: string,
  report: CheckObservation,
  after: boolean,
): Assessed {
  const status = String(observationField(report, 'values.reportedStatus'));
  const problems: Problem[] = [];
  const notes: string[] = [];
  if (!params.inForce.includes(status))
    problems.push({
      code: 'status',
      words: `reported ${status} at ${report.occurredAt}${after ? ', after the flight ended' : ''}`,
    });
  const start = utcMillis(report.interval?.start);
  const end = utcMillis(report.interval?.end);
  if (start === undefined || end === undefined)
    problems.push({ code: 'no_interval', words: 'states no start and end of the time it covers' });
  else {
    if (start > flight.start)
      problems.push({ code: 'not_started', words: `starts at ${iso(start)}, after the flight’s ${iso(flight.start)}` });
    if (end < flight.end)
      problems.push({ code: 'expired', words: `ended at ${iso(end)}, before the flight’s ${iso(flight.end)}` });
  }
  const area = observationField(report, 'values.area.boundary');
  let positionsOutside = 0;
  const outside: CheckObservation[] = [];
  if (flight.basis === 'planned')
    notes.push('The plan states no place, so whether its area covers the flight is not compared.');
  else if (flight.basis === 'recorded')
    notes.push('The flight record states no position, so whether its area covers the flight is not compared.');
  else if (!Array.isArray(area)) notes.push('It states no area, so the place flown is not compared with it.');
  else {
    const corners = (area as { latitudeDegrees: number; longitudeDegrees: number }[]).map((corner) => [
      corner.longitudeDegrees,
      corner.latitudeDegrees,
    ]);
    const polygon = { type: 'Polygon', coordinates: [[...corners, corners[0]]] };
    const distances = distancesOutsideArea(
      polygon,
      flight.positions.map((item) => item.point),
    );
    if (!distances)
      notes.push('Its area is not one the rule can place positions in, so the place flown is not compared.');
    else {
      const beyond = distances.flatMap((distance, index) => (distance > 0 ? [{ distance, index }] : []));
      positionsOutside = beyond.length;
      outside.push(...beyond.slice(0, 20).map((item) => flight.positions[item.index]!.observation));
      if (beyond.length)
        problems.push({
          code: 'other_place',
          words: `${beyond.length} of ${distances.length} flown positions are outside its area, up to ${shown(Math.max(...beyond.map((item) => item.distance)), 'm', params.textUnit)}`,
        });
    }
  }
  const ceiling = observationField(report, 'values.ceiling.meters');
  const ceilingDatum = observationField(report, 'values.ceiling.datum');
  const ceilingMeters = typeof ceiling === 'number' && Number.isFinite(ceiling) ? ceiling : null;
  if (ceilingMeters === null) notes.push('It states no ceiling.');
  else if (!params.ceilingDatums.includes(String(ceilingDatum)))
    notes.push(`Its ceiling is stated against ${String(ceilingDatum)}, which this rule does not compare.`);
  else if (!flight.height) notes.push('No height is on record to compare with its ceiling.');
  else if (ceilingMeters < flight.height.meters)
    problems.push({
      code: 'ceiling_below',
      words: `its ceiling, ${shown(ceilingMeters, 'm', params.textUnit)} above ground level, is below the ${flight.height.describes}, ${shown(flight.height.meters, 'm', params.textUnit)}`,
    });
  return { id, report, status, problems, notes, ceilingMeters, positionsOutside, outside };
}

const authorizationDetails = [
  {
    name: 'basis',
    description:
      'flown when the flight’s time and place were read from flown positions, recorded when its time was read from the operator’s own record of the flight, planned otherwise.',
  },
  { name: 'flightStart', description: 'The start of the flight’s time as read.' },
  { name: 'flightEnd', description: 'The end of the flight’s time as read.' },
  { name: 'heightRead', description: 'The height compared with a ceiling, in meters; null when none is on record.' },
  { name: 'heightMeasured', description: 'In words, what the height read measures; null when none is on record.' },
  { name: 'authorizationsRead', description: 'How many authorizations are on record about the flight.' },
  { name: 'authorizationId', description: 'The authorization that supports the rule, or else the first one assessed.' },
  { name: 'authorizationStatus', description: 'The status reported for that authorization, as read.' },
  { name: 'ceilingMeters', description: 'That authorization’s ceiling, in meters; null when it states none.' },
  { name: 'positionsOutside', description: 'How many flown positions are outside that authorization’s area.' },
  { name: 'problem', description: 'What the first authorization assessed lacks; null when one supports the rule.' },
  { name: 'reading', description: 'The result in one or more sentences, for a rule’s wording to quote.' },
] as const;

export const authorizationCoversFlightV1: CheckKind<AuthorizationCoversFlightParams> = {
  id: 'authorization.covers-flight',
  version: 1,
  title: 'An airspace authorization on record covers the flight',
  description:
    'The flight is read from its flown positions when any usable one is on record, else from the latest selected record the operator made of the flight as flown, and from the latest selected plan otherwise: its time is from the first to the last flown position, or the recorded takeoff to landing, or the planned window; its height is the highest flown height the rule compares (by its measures), or else the recorded height, or else the planned height; its place is the flown positions, and with none the place is not compared and the result says so. Each authorization on record (airspace.authorization observations, grouped by authorizationId) is read at its latest report made by the end of the flight, or its first report when all were made later; reports at one instant with different statuses conflict. An authorization supports the rule when its reported status is one the rule lists as in force, its interval runs from at or before the flight’s start to at or after its end, every flown position is inside its area, and its ceiling, in a datum the rule compares, is at or above the height read. One that supports passes and is named. Otherwise each is named with what it lacks: its status, an interval that ended before the flight’s end (expired) or starts after its start, positions outside its area, a ceiling below the height read; that needs attention, unless every one lacks only a status the rule lists as awaited, which is pending. An authorization without an area or ceiling is not refused for it; the result says what was not compared. No authorization on record is insufficient; no flight time is insufficient. With textUnit, heights, ceilings and distances are stated in that unit with the stored value in parentheses.',
  inputs: [
    { name: 'authorizations', description: 'airspace.authorization observations about the flight.' },
    { name: 'plan', description: 'The flight’s plan, with its window and planned height.' },
    {
      name: 'recorded',
      description: 'The operator’s own records of the flight as flown, with its takeoff, landing and height.',
      optional: true,
    },
    { name: 'flown', description: 'Positions reported while the flight was flown.', optional: true },
  ],
  details: [...authorizationDetails],
  summaryValues: ['flightStart', 'flightEnd'],
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['plannedStartField', 'plannedEndField', 'inForce', 'ceilingDatums'],
    properties: {
      planSelect: selectionSchema,
      plannedStartField: fieldPath,
      plannedEndField: fieldPath,
      plannedHeightField: fieldPath,
      plannedHeightDescribes: words,
      recordedSelect: selectionSchema,
      recordedStartField: fieldPath,
      recordedEndField: fieldPath,
      recordedHeightField: fieldPath,
      recordedHeightDescribes: words,
      heightField: fieldPath,
      measures: measuresSchema,
      unusable: unusableSchema,
      inForce: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: words },
      awaiting: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: words },
      ceilingDatums: { type: 'array', minItems: 1, maxItems: 10, uniqueItems: true, items: words },
      textUnit: textUnitSchema,
    },
    dependencies: {
      plannedHeightField: ['plannedHeightDescribes'],
      measures: ['heightField'],
      recordedStartField: ['recordedEndField'],
      recordedEndField: ['recordedStartField'],
      recordedHeightField: ['recordedHeightDescribes'],
    },
  },
  evaluate(params, inputs) {
    const authorizations = inputs.authorizations ?? [];
    const details: CheckDetails = {
      basis: null,
      flightStart: null,
      flightEnd: null,
      heightRead: null,
      heightMeasured: null,
      authorizationsRead: 0,
      authorizationId: null,
      authorizationStatus: null,
      ceilingMeters: null,
      positionsOutside: 0,
      problem: null,
    };
    const flight = flightRead(params, inputs);
    if (!flight)
      return result(
        'insufficient',
        'pending',
        'flight_time_missing',
        'No flown position, no flight record with a takeoff before its landing and no planned window with a valid start and end are on record, so the flight’s time is not known.',
        latestObservations(current(inputs.plan, params.planSelect)),
        details,
      );
    Object.assign(details, {
      basis: flight.basis,
      flightStart: iso(flight.start),
      flightEnd: iso(flight.end),
      heightRead: flight.height ? round(flight.height.meters) : null,
      heightMeasured: flight.height?.describes ?? null,
    });
    const byId = new Map<string, CheckObservation[]>();
    for (const report of authorizations) {
      const id = String(observationField(report, 'values.authorizationId'));
      byId.set(id, [...(byId.get(id) ?? []), report]);
    }
    details.authorizationsRead = byId.size;
    if (!byId.size)
      return result(
        'insufficient',
        'pending',
        'authorization_missing',
        'No airspace authorization is on record about this flight.',
        flight.evidence,
        details,
      );
    const assessed: Assessed[] = [];
    for (const [id, reports] of [...byId].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const read = reportAtFlight(reports, flight.end);
      if ('conflicting' in read)
        return result(
          'conflicting',
          'attention',
          'authorization_reports_disagree',
          `Reports about authorization ${id} made at ${read.conflicting[0]!.occurredAt} state different statuses.`,
          read.conflicting,
          { ...details, authorizationId: id },
        );
      assessed.push(assessAuthorization(params, flight, id, read.report, read.after));
    }
    const basisWords =
      flight.basis === 'flown'
        ? `Read the flight’s ${flight.timeWords}.`
        : `No flown position is on record for this flight; read its ${flight.timeWords}.`;
    const heightWords = flight.height
      ? ` The height read is the ${flight.height.describes}, ${shown(flight.height.meters, 'm', params.textUnit)}.${flight.heightNote}`
      : ` No height is on record for the flight.${flight.heightNote}`;
    const supporting = assessed.find((item) => !item.problems.length);
    const shownFor = supporting ?? assessed[0]!;
    Object.assign(details, {
      authorizationId: shownFor.id,
      authorizationStatus: shownFor.status,
      ceilingMeters: shownFor.ceilingMeters === null ? null : round(shownFor.ceilingMeters),
      positionsOutside: shownFor.positionsOutside,
      problem: supporting ? null : (shownFor.problems[0]?.code ?? null),
    });
    const evidence = [...flight.evidence, ...(flight.height?.observation ? [flight.height.observation] : [])];
    if (supporting) {
      const ceiling =
        supporting.ceilingMeters === null
          ? ''
          : `, with a ceiling of ${shown(supporting.ceilingMeters, 'm', params.textUnit)} above ground level`;
      const summary =
        `Authorization ${supporting.id}, reported ${supporting.status} at ${supporting.report.occurredAt}, covers the flight${flight.basis === 'flown' ? ' and every flown position' : flight.basis === 'recorded' ? '’s recorded takeoff to landing' : '’s planned window'}${ceiling}. ${basisWords}${heightWords} ${supporting.notes.join(' ')}`.trim();
      return result('supported', 'pass', 'authorization_covers', summary, [supporting.report, ...evidence], details);
    }
    const named = assessed.map((item) => `${item.id}: ${list(item.problems.map((problem) => problem.words))}.`);
    const awaitedOnly = assessed.every(
      (item) =>
        item.problems.length === 1 &&
        item.problems[0]!.code === 'status' &&
        (params.awaiting ?? []).includes(item.status),
    );
    const notes = [...new Set(assessed.flatMap((item) => item.notes))].join(' ');
    const summary =
      `No airspace authorization on record covers the flight. ${named.join(' ')} ${basisWords}${heightWords} ${notes}`.trim();
    const reports = assessed.flatMap((item) => [item.report, ...item.outside]);
    return awaitedOnly
      ? result('insufficient', 'pending', 'authorization_awaited', summary, [...reports, ...evidence], details)
      : result('supported', 'attention', 'authorization_not_covering', summary, [...reports, ...evidence], details);
  },
};

export const observedCheckKinds: readonly CheckKind[] = [valueFlownOrPlannedV1, authorizationCoversFlightV1];
for (const kind of observedCheckKinds) registerCheckKind(kind);
