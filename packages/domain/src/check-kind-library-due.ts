import type { CheckDetails } from '@ledger/contracts';
import { quantityText, textUnitSchema, type TextUnit } from './quantities.js';
import {
  addition,
  iso,
  overlappingAdditions,
  recordedAdditions,
  result as combinedResult,
  type Addition,
  type TotalFromOpeningParams,
} from './check-kind-library-combined.js';
import { current, fieldPath, labelOf, round, selectionSchema, type Selection } from './check-kind-library-records.js';
import {
  latestObservations,
  observationField,
  registerCheckKind,
  utcMillis,
  type CheckKind,
  type CheckObservation,
} from './check-kinds.js';
import { placedTime, type PlacedTime } from './day-precision.js';

// A record that says when something is next due, at a time, at a total such as hours in service, or both, compared
// with the time and the total at an instant: a flight's takeoff, or now. Listed in docs/design/record-check-kinds.md.

export interface DueTimeOrTotalParams {
  dueSelect?: Selection;
  dueAtField?: string;
  dueTimeField?: string;
  dueTotalField?: string;
  dueDescribes: string;
  openingSelect?: Selection;
  openingField?: string;
  openingAtField?: string;
  additionsSelect?: Selection;
  additionsStartField?: string;
  additionsEndField?: string;
  recordedAdditionsSelect?: Selection;
  recordedStartField?: string;
  recordedEndField?: string;
  totalDescribes?: string;
  reportedTimeSelect?: Selection;
  reportedTimeField?: string;
  recordedTimeSelect?: Selection;
  recordedTimeField?: string;
  plannedTimeSelect?: Selection;
  plannedTimeField?: string;
  unit?: string;
  textUnit?: TextUnit;
}

const words = { type: 'string', minLength: 1, maxLength: 200 } as const;

/** A result whose details keep its own summary as reading, so a rule's wording can quote it and add to it. */
function result(...args: Parameters<typeof combinedResult>): ReturnType<typeof combinedResult> {
  const [, , , summary, , details] = args;
  details.reading = summary;
  return combinedResult(...args);
}

type Moment = { at: number; basis: 'reported' | 'recorded' | 'planned' | 'now'; evidence: CheckObservation[] };

/** The instant the rule asks about: a reported takeoff, else a recorded one, else a planned one, else now. */
function momentOf(params: DueTimeOrTotalParams, inputs: Parameters<CheckKind['evaluate']>[1], now: number) {
  const sources = [
    ['reported', inputs.reportedTime, params.reportedTimeSelect, params.reportedTimeField],
    ['recorded', inputs.recordedTime, params.recordedTimeSelect, params.recordedTimeField],
    ['planned', inputs.plannedTime, params.plannedTimeSelect, params.plannedTimeField],
  ] as const;
  const asked = sources.filter(([, , , field]) => field !== undefined);
  if (!asked.length) return { at: now, basis: 'now', evidence: [] } satisfies Moment;
  for (const [basis, observations, select, field] of asked) {
    const latest = latestObservations(current(observations, select));
    const times = latest.flatMap((observation) => {
      const time = placedTime(observation, field, 'earliest');
      return time ? [{ observation, at: time.at }] : [];
    });
    if (!times.length) continue;
    const at = Math.min(...times.map((item) => item.at));
    return { at, basis, evidence: times.map((item) => item.observation) } satisfies Moment;
  }
  return undefined;
}

function momentWords(moment: Moment, now: number, describes: string): string {
  if (moment.basis === 'now') return 'now';
  if (moment.basis !== 'planned') return describes;
  return moment.at > now
    ? `now, before the planned start, ${iso(moment.at)}`
    : `at the planned start, ${iso(moment.at)}`;
}

const recordedWords = (time: PlacedTime) => (time.day === undefined ? `at ${iso(time.at)}` : `on ${time.day}`);

export const dueTimeOrTotalV1: CheckKind<DueTimeOrTotalParams> = {
  id: 'due.time-or-total',
  version: 1,
  title: 'Within the next due time and next due total of the record in effect',
  description:
    'A due record, such as an inspection, states when the next is due: at a time (dueTimeField), at a total (dueTotalField), or both. The instant asked about is the time in the latest reported-time observation, else in the latest recorded-time observation, else in the latest planned-time observation, each read only when the rule names its field; with none named it is the evaluation time. The due record in effect is the latest selected one made (dueAtField, or its span start) at or before that instant. With a due total, the total at the instant is the latest selected opening balance whose time (openingAtField, or its span start) is at or before it, plus the hours between the start and end fields of every reported addition that starts at or after the opening time and before the instant, and of every recorded addition that shares its time with no reported one, as total.from-opening counts them. Past the due time, or with the total above the due total, the result needs attention and names both figures; within both it passes and states what is left. A due record that states neither is incomplete and insufficient; no due record in effect, no opening balance for a due total, an addition without its times, additions that overlap, and due records made together that state different values are insufficient or conflicting. A planned instant still to come is read with the total so far. A due record placed by a date alone is read as made at the end of that day, and a due time given as a date alone as due at the start of that day; the summary says only the date is on record. Each sentence names the subject by the id the due record or opening balance is about.',
  inputs: [
    { name: 'due', description: 'Records that state when the next is due.' },
    { name: 'opening', description: 'Records that carry an opening balance of the total.', optional: true },
    {
      name: 'additions',
      description: 'Reported additions to the total, each with a start and an end.',
      optional: true,
    },
    {
      name: 'recordedAdditions',
      description: 'The operator’s own records of additions, read where no reported addition shares their time.',
      optional: true,
    },
    { name: 'reportedTime', description: 'Reports that state the instant asked about.', optional: true },
    { name: 'recordedTime', description: 'The operator’s own records that state the instant.', optional: true },
    { name: 'plannedTime', description: 'Plans that state the instant.', optional: true },
  ],
  details: [
    {
      name: 'reading',
      description: 'The kind’s own summary, so a rule’s wording can quote it and add what is left to a person.',
    },
    { name: 'basis', description: 'Where the instant came from: reported, recorded, planned or now.' },
    { name: 'at', description: 'The instant asked about, a UTC instant.' },
    { name: 'dueRecordedAt', description: 'When the due record in effect was made; null when none is in effect.' },
    { name: 'dueAt', description: 'The next due time it states; null when it states none.' },
    { name: 'dueTotal', description: 'The next due total it states; null when it states none.' },
    { name: 'total', description: 'The total at the instant; null when not derived.' },
    { name: 'margin', description: 'The due total less the total; negative past it; null when not derived.' },
    { name: 'subjectId', description: 'The id of the subject the due record or opening balance is about.' },
  ],
  summaryValues: ['at'],
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['dueDescribes'],
    properties: {
      dueSelect: selectionSchema,
      dueAtField: fieldPath,
      dueTimeField: fieldPath,
      dueTotalField: fieldPath,
      dueDescribes: words,
      openingSelect: selectionSchema,
      openingField: fieldPath,
      openingAtField: fieldPath,
      additionsSelect: selectionSchema,
      additionsStartField: fieldPath,
      additionsEndField: fieldPath,
      recordedAdditionsSelect: selectionSchema,
      recordedStartField: fieldPath,
      recordedEndField: fieldPath,
      totalDescribes: words,
      reportedTimeSelect: selectionSchema,
      reportedTimeField: fieldPath,
      recordedTimeSelect: selectionSchema,
      recordedTimeField: fieldPath,
      plannedTimeSelect: selectionSchema,
      plannedTimeField: fieldPath,
      unit: { type: 'string', minLength: 1, maxLength: 20 },
      textUnit: textUnitSchema,
    },
    anyOf: [{ required: ['dueTimeField'] }, { required: ['dueTotalField'] }],
    dependencies: {
      dueTotalField: ['openingField', 'additionsStartField', 'additionsEndField'],
      additionsStartField: ['additionsEndField'],
      additionsEndField: ['additionsStartField'],
      recordedStartField: ['recordedEndField'],
      recordedEndField: ['recordedStartField'],
      textUnit: ['unit'],
    },
  },
  evaluate(params, inputs, clock) {
    const now = utcMillis(clock.evaluatedAt)!;
    const stated = (quantity: number) =>
      params.unit === undefined ? String(quantity) : quantityText(quantity, params.unit, params.textUnit);
    const details: CheckDetails = {
      reading: null,
      basis: null,
      at: null,
      dueRecordedAt: null,
      dueAt: null,
      dueTotal: null,
      total: null,
      margin: null,
      subjectId: null,
    };
    const moment = momentOf(params, inputs, now);
    const due = params.dueDescribes;
    if (!moment)
      return result(
        'not_applicable',
        'not_applicable',
        'time_not_on_file',
        `No takeoff or planned start is on file, so no ${due} can be placed before it.`,
        [],
        details,
      );
    Object.assign(details, { basis: moment.basis, at: iso(moment.at) });
    const when = momentWords(moment, now, 'at takeoff');
    const made = current(inputs.due, params.dueSelect).flatMap((observation) => {
      const time = placedTime(observation, params.dueAtField, 'latest');
      return time && time.at <= moment.at ? [{ observation, time }] : [];
    });
    const subjectOf = (observation: CheckObservation | undefined) => {
      const subject = observation?.observation.subject as { id?: unknown } | undefined;
      return typeof subject?.id === 'string' ? subject.id : undefined;
    };
    const openings = current(inputs.opening, params.openingSelect);
    const subjectId = subjectOf(made[0]?.observation) ?? subjectOf(openings[0]);
    details.subjectId = subjectId ?? null;
    const who = subjectId ?? 'The subject';
    if (!made.length)
      return result(
        'insufficient',
        'attention',
        'due_record_missing',
        `No ${due} of ${who} is recorded ${moment.basis === 'now' ? 'yet' : `before ${when === 'at takeoff' ? 'takeoff' : 'the flight'}`}, so when the next is due is not on file.`,
        moment.evidence,
        details,
      );
    const newest = Math.max(...made.map((item) => item.time.at));
    const inEffect = made.filter((item) => item.time.at === newest);
    const dueTimes = inEffect.map((item) =>
      params.dueTimeField === undefined ? undefined : placedTime(item.observation, params.dueTimeField, 'earliest'),
    );
    const dueTotals = inEffect.map((item) => {
      const value =
        params.dueTotalField === undefined ? undefined : observationField(item.observation, params.dueTotalField);
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    });
    const dueEvidence = inEffect.map((item) => item.observation);
    if (new Set(dueTimes.map((time) => time?.at)).size > 1 || new Set(dueTotals).size > 1)
      return result(
        'conflicting',
        'attention',
        'due_records_disagree',
        `${inEffect.length} ${due} records of ${who} made together state different next due times or totals.`,
        [...moment.evidence, ...dueEvidence],
        details,
      );
    const dueTime = dueTimes[0];
    const dueTotal = dueTotals[0];
    const recorded = `the ${due} recorded ${recordedWords(inEffect[0]!.time)}`;
    Object.assign(details, {
      dueRecordedAt: iso(inEffect[0]!.time.at),
      dueAt: dueTime ? iso(dueTime.at) : null,
      dueTotal: dueTotal ?? null,
    });
    if (!dueTime && dueTotal === undefined)
      return result(
        'insufficient',
        'attention',
        'due_not_stated',
        `${sentenceStart(recorded)} states no next due time and no next due ${params.totalDescribes ?? 'total'}; the record is incomplete.`,
        [...moment.evidence, ...dueEvidence],
        details,
      );
    const sentences: string[] = [];
    let past = false;
    const evidence = [...moment.evidence, ...dueEvidence];
    if (dueTime) {
      const dueWords =
        dueTime.day === undefined
          ? `by ${iso(dueTime.at)}`
          : `on ${dueTime.day} (only the date is on record; read as the start of that day)`;
      const after = moment.at > dueTime.at;
      past ||= after;
      const instant =
        moment.basis === 'now'
          ? 'now'
          : moment.basis === 'planned'
            ? `the planned start at ${iso(moment.at)}`
            : `takeoff at ${iso(moment.at)}`;
      sentences.push(
        after
          ? `${sentenceStart(recorded)} was due ${dueWords}, before ${instant}.`
          : `${sentenceStart(recorded)} is next due ${dueWords}, after ${instant}.`,
      );
    }
    if (dueTotal !== undefined) {
      const total = totalAt(params, inputs, Math.min(moment.at, now), moment.basis === 'now');
      if ('problem' in total)
        return result(
          total.state,
          'attention',
          total.problem,
          total.summary(who, when),
          [...evidence, ...total.evidence],
          details,
        );
      const margin = round(dueTotal - total.total);
      Object.assign(details, { total: total.total, margin });
      evidence.push(...total.evidence);
      const over = total.total > dueTotal;
      past ||= over;
      const measured = params.totalDescribes ?? 'total';
      sentences.push(
        over
          ? `${who} had ${stated(total.total)} ${measured} ${when}; ${recorded} was due at ${stated(dueTotal)}.`
          : `${who} had ${stated(total.total)} ${measured} ${when}; ${recorded} is next due at ${stated(dueTotal)}, ${stated(margin)} later.`,
      );
    }
    const boundary = moment.basis === 'now' && dueTime && !past ? dueTime.at + 1 : undefined;
    return past
      ? result('supported', 'attention', 'due_passed', sentences.join(' '), evidence, details)
      : result('supported', 'pass', 'within_due', sentences.join(' '), evidence, details, boundary);
  },
};

type Total =
  | { total: number; evidence: CheckObservation[] }
  | {
      problem: string;
      state: 'insufficient' | 'conflicting';
      evidence: CheckObservation[];
      summary: (who: string, when: string) => string;
    };

/** The opening balance at or before the instant plus the additions after it and before the instant. */
function totalAt(
  params: DueTimeOrTotalParams,
  inputs: Parameters<CheckKind['evaluate']>[1],
  until: number,
  inclusive: boolean,
): Total {
  const openings = current(inputs.opening, params.openingSelect).flatMap((observation) => {
    const value = observationField(observation, params.openingField!);
    const time = placedTime(observation, params.openingAtField, 'earliest');
    return typeof value === 'number' && Number.isFinite(value) && time && time.at <= until
      ? [{ observation, value, at: time.at }]
      : [];
  });
  if (!openings.length)
    return {
      problem: 'opening_balance_missing',
      state: 'insufficient',
      evidence: [],
      summary: (who, when) =>
        `No opening total ${params.totalDescribes ?? ''} is recorded for ${who} up to that time, so its total ${params.totalDescribes ?? ''} ${when} is not known.`.replace(
          /\s+/g,
          ' ',
        ),
    };
  const openingAt = Math.max(...openings.map((item) => item.at));
  const latest = openings.filter((item) => item.at === openingAt);
  if (new Set(latest.map((item) => item.value)).size > 1)
    return {
      problem: 'opening_balances_disagree',
      state: 'conflicting',
      evidence: latest.map((item) => item.observation),
      summary: (who) => `Records of ${who} made together state different opening totals.`,
    };
  const counts = (item: Addition) => item.start >= openingAt && (inclusive ? item.start <= until : item.start < until);
  const totalParams = params as unknown as TotalFromOpeningParams;
  const reported = current(inputs.additions, params.additionsSelect)
    .map((observation) => addition(observation, totalParams))
    .filter(counts);
  const fromRecords =
    params.recordedStartField === undefined
      ? { counted: [], differing: [] }
      : recordedAdditions(
          reported,
          current(inputs.recordedAdditions, params.recordedAdditionsSelect)
            .map((observation) =>
              addition(observation, totalParams, { start: params.recordedStartField, end: params.recordedEndField }),
            )
            .filter(counts),
        );
  const additions = [...reported, ...fromRecords.counted];
  const unvalued = additions.filter((item) => item.value === undefined).map((item) => item.observation);
  if (unvalued.length)
    return {
      problem: 'addition_value_missing',
      state: 'insufficient',
      evidence: unvalued,
      summary: (who) =>
        `${unvalued.length} flight(s) of ${who} after its recorded total record no valid ${labelOf(params.additionsStartField!, unvalued)} and ${labelOf(params.additionsEndField!, unvalued)}: ${unvalued.map((item) => item.id).join(', ')}.`,
    };
  const overlapping = overlappingAdditions(additions);
  if (overlapping.length)
    return {
      problem: 'additions_overlap',
      state: 'conflicting',
      evidence: overlapping,
      summary: () =>
        `Additions overlap in time, so the same time would be counted twice: ${overlapping.map((item) => item.id).join(', ')}.`,
    };
  const opening = latest[0]!;
  return {
    total: round(opening.value + additions.reduce((sum, item) => sum + item.value!, 0)),
    evidence: [opening.observation, ...additions.map((item) => item.observation)],
  };
}

function sentenceStart(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export const dueCheckKinds: readonly CheckKind[] = [dueTimeOrTotalV1];
for (const kind of dueCheckKinds) registerCheckKind(kind);
