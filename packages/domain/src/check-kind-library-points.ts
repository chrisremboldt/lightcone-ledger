import {
  findOperatorRecordDefinition,
  RECORD_NOT_ON_FILE,
  recordFieldFilled,
  storedUnit,
  type CheckDetails,
  type OperatorRecordDefinition,
  type OperatorRecordField,
} from '@ledger/contracts';
import { iso } from './check-kind-library-combined.js';
import {
  flightTimeDependencies,
  flightTimeDetails,
  flightTimeInputs,
  flightTimeSchema,
  flightWindow,
  noFlightTime,
  result,
  startWords,
  windowDetails,
  type FlightTimeParams,
} from './check-kind-library-flights.js';
import {
  current,
  detailEntries,
  fieldPath,
  scalar,
  selectionSchema,
  type Scalar,
  type Selection,
} from './check-kind-library-records.js';
import {
  observationField,
  registerCheckKind,
  utcMillis,
  type CheckKind,
  type CheckObservation,
  type CheckParameterContext,
} from './check-kinds.js';
import { placedTime } from './day-precision.js';
import { fieldLabel, sentenceStart, valueLabel } from './field-labels.js';
import { observationRegistry } from './observation-registry.js';

// A check kind that totals the points a rule gives the answers of one record, and compares the total with a level
// (docs/design/record-check-kinds.md, "A total of points"). The points live in the rule, beside the text that states
// them; the arithmetic is over whole numbers, so it is exact.

const RECORD_FIELD = 'values.record.';

/** A band of a number field: from is included, to is not; either may be left out for an open end. */
export interface PointsBand {
  from?: number;
  to?: number;
  points: number;
}

/** One scored field: the points of each option, of each band of a number, or of yes and of no. */
export interface ScoredField {
  field: string;
  options?: { value: Scalar; points: number }[];
  bands?: PointsBand[];
  yes?: number;
  no?: number;
}

export interface RecordPointsTotalParams extends FlightTimeParams {
  select?: Selection;
  atField?: string;
  recordDescribes: string;
  fields: ScoredField[];
  comparison: 'at_most' | 'below';
  level: number;
  whenOver: string;
}

const points = { type: 'integer', minimum: -1000, maximum: 1000 } as const;
const scoredFieldSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['field'],
  properties: {
    field: fieldPath,
    options: {
      type: 'array',
      minItems: 1,
      maxItems: 50,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['value', 'points'],
        properties: { value: scalar, points },
      },
    },
    bands: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['points'],
        properties: { from: { type: 'number' }, to: { type: 'number' }, points },
      },
    },
    yes: points,
    no: points,
  },
  oneOf: [{ required: ['options'] }, { required: ['bands'] }, { required: ['yes', 'no'] }],
  dependencies: { yes: ['no'], no: ['yes'] },
} as const;

const comparisons = {
  at_most: {
    holds: (total: number, level: number) => total <= level,
    words: 'at most',
    over: (level: string) => `Above ${level}`,
  },
  below: {
    holds: (total: number, level: number) => total < level,
    words: 'below',
    over: (level: string) => `At ${level} or more`,
  },
} as const;

const pointsText = (count: number) => `${count} point${Math.abs(count) === 1 ? '' : 's'}`;

function bandWords(band: PointsBand): string {
  if (band.from === undefined && band.to === undefined) return 'any value';
  if (band.from === undefined) return `below ${band.to}`;
  if (band.to === undefined) return `${band.from} and above`;
  return `${band.from} to under ${band.to}`;
}

const inBand = (value: number, band: PointsBand) =>
  (band.from === undefined || value >= band.from) && (band.to === undefined || value < band.to);

/** The record field a path names, in the record type of the observations that hold it or of the selection. */
function recordFieldOf(
  path: string,
  observations: readonly CheckObservation[],
  selection: Selection | undefined,
): OperatorRecordField | undefined {
  if (!path.startsWith(RECORD_FIELD)) return undefined;
  const name = path.slice(RECORD_FIELD.length);
  const types: [unknown, unknown][] = [
    ...observations.map((observation): [unknown, unknown] => [
      observationField(observation, 'values.recordType'),
      observationField(observation, 'values.recordVersion'),
    ]),
    [selection?.recordType, selection?.recordVersion],
  ];
  for (const [recordType, recordVersion] of types) {
    if (typeof recordType !== 'string' || typeof recordVersion !== 'number') continue;
    const field = findOperatorRecordDefinition(observationRegistry(), recordType, recordVersion)?.fields.find(
      (candidate) => candidate.name === name,
    );
    if (field) return field;
  }
  return undefined;
}

/** A scored field as the form labels it: "Wind at launch". */
function answerLabel(path: string, observations: readonly CheckObservation[], selection: Selection | undefined) {
  return (
    recordFieldOf(path, observations, selection)?.label ??
    sentenceStart(fieldLabel(path, observations, selection).replace(/^the /u, ''))
  );
}

/** An answer as a person reads it: an option's label, Yes or No, or a number with the unit it is stored in. */
function answerWords(
  path: string,
  value: Scalar,
  observations: readonly CheckObservation[],
  selection: Selection | undefined,
): string {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  const field = recordFieldOf(path, observations, selection);
  if (typeof value === 'number')
    return field?.kind === 'number' && field.unit !== 'Count' ? `${value} ${storedUnit(field.unit).unit}` : `${value}`;
  return valueLabel(path, value, observations, selection);
}

type Answer =
  | { state: 'scored'; path: string; label: string; value: Scalar; shown: string; points: number }
  | { state: 'missing' | 'disagree'; path: string; label: string }
  | { state: 'unscored'; path: string; label: string; shown: string };

/** The points the rule gives a value of a scored field: none when it states none, or more than one, for it. */
function pointsFor(spec: ScoredField, value: Scalar): number | undefined {
  if (spec.options) {
    const matching = spec.options.filter((option) => option.value === value);
    return matching.length === 1 ? matching[0]!.points : undefined;
  }
  if (spec.bands) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    const matching = spec.bands.filter((band) => inBand(value, band));
    return matching.length === 1 ? matching[0]!.points : undefined;
  }
  if (typeof value !== 'boolean') return undefined;
  return value ? spec.yes : spec.no;
}

function answerOf(
  spec: ScoredField,
  observations: readonly CheckObservation[],
  selection: Selection | undefined,
): Answer {
  const label = answerLabel(spec.field, observations, selection);
  const values = [
    ...new Set(
      observations.flatMap((observation): Scalar[] => {
        const value = observationField(observation, spec.field);
        return recordFieldFilled(value) && ['string', 'number', 'boolean'].includes(typeof value)
          ? [value as Scalar]
          : [];
      }),
    ),
  ];
  if (!values.length) return { state: 'missing', path: spec.field, label };
  if (values.length > 1) return { state: 'disagree', path: spec.field, label };
  const value = values[0]!;
  const shown = answerWords(spec.field, value, observations, selection);
  const scored = pointsFor(spec, value);
  return scored === undefined
    ? { state: 'unscored', path: spec.field, label, shown }
    : { state: 'scored', path: spec.field, label, value, shown, points: scored };
}

const fieldName = (path: string) => (path.startsWith(RECORD_FIELD) ? path.slice(RECORD_FIELD.length) : path);

// What the schema cannot say about the points a rule states --------------------------------------------------------

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function bandsOf(value: unknown): PointsBand[] | undefined {
  if (!Array.isArray(value) || !value.every(isObject)) return undefined;
  const numeric = (item: unknown) => item === undefined || (typeof item === 'number' && Number.isFinite(item));
  return value.every((band) => numeric(band.from) && numeric(band.to)) ? (value as unknown as PointsBand[]) : undefined;
}

/**
 * Why the bands of one number field do not give every value it may hold exactly one number of points. `bounds` are the
 * least and greatest value the field takes; without them the bands must be open at both ends.
 */
function bandProblems(label: string, bands: readonly PointsBand[], bounds?: { minimum: number; maximum: number }) {
  const problems: string[] = [];
  const empty = bands.find((band) => band.from !== undefined && band.to !== undefined && band.from >= band.to);
  if (empty)
    return [
      `The band "${bandWords(empty)}" of ${label} holds no value: a band runs from a number (included) to a greater one (not included).`,
    ];
  const sorted = [...bands].sort((a, b) => (a.from ?? -Infinity) - (b.from ?? -Infinity));
  for (const [index, band] of sorted.entries()) {
    const next = sorted[index + 1];
    if (!next) break;
    const end = band.to ?? Infinity;
    const start = next.from ?? -Infinity;
    if (end > start)
      problems.push(
        `The bands of ${label} overlap: "${bandWords(band)}" and "${bandWords(next)}" both hold ${start === -Infinity ? 'the lowest values' : start}. A band's from is included and its to is not, so one band ends where the next starts.`,
      );
    else if (end < start)
      problems.push(
        `The bands of ${label} leave values from ${end} to under ${start} with no points: "${bandWords(band)}" is followed by "${bandWords(next)}".`,
      );
  }
  const first = sorted[0]!;
  const last = sorted.at(-1)!;
  if (bounds) {
    if (first.from !== undefined && first.from > bounds.minimum)
      problems.push(
        `The bands of ${label} leave values below ${first.from} with no points; the field takes values from ${bounds.minimum}. Start the lowest band there, or leave out its from.`,
      );
    if (last.to !== undefined && last.to <= bounds.maximum)
      problems.push(
        `The bands of ${label} leave values of ${last.to} and above with no points; the field takes values up to ${bounds.maximum}. Leave out the highest band's to.`,
      );
  } else if (first.from !== undefined || last.to !== undefined)
    problems.push(
      `The bands of ${label} must be open at both ends (the lowest with no from, the highest with no to), because nothing states the least and greatest value the field takes.`,
    );
  return problems;
}

/** The record field a scored path names in the record types the rule's read takes: the latest version that has it. */
function fieldRead(path: string, types: readonly OperatorRecordDefinition[]): OperatorRecordField | undefined {
  if (!path.startsWith(RECORD_FIELD)) return undefined;
  return types.flatMap((type) => type.fields.filter((field) => field.name === path.slice(RECORD_FIELD.length))).at(-1);
}

const kindWords: Record<OperatorRecordField['kind'], string> = {
  text: 'a text field',
  long_text: 'a text field',
  date: 'a date',
  date_time: 'a date and time',
  reference: 'a reference',
  boolean: 'a yes-or-no field',
  number: 'a number',
  select: 'a field with listed options',
};

function scoredFieldProblems(spec: Record<string, unknown>, field: OperatorRecordField | undefined): string[] {
  const path = typeof spec.field === 'string' ? spec.field : '';
  const label = field ? `“${field.label}” (${fieldName(path)})` : fieldName(path) || 'a scored field';
  const given = spec.options !== undefined ? 'select' : spec.bands !== undefined ? 'number' : 'boolean';
  if (field && field.kind !== given)
    return [
      `${label} is ${kindWords[field.kind]}, but the rule gives it ${given === 'select' ? 'options' : given === 'number' ? 'bands' : 'yes and no'}. Give a field with listed options its options, a number its bands, and a yes-or-no field yes and no.`,
    ];
  if (given === 'number') {
    const bands = bandsOf(spec.bands);
    if (!bands?.length) return [];
    const bounds = field?.kind === 'number' ? { minimum: field.minimum, maximum: field.maximum } : undefined;
    return bandProblems(label, bands, bounds);
  }
  if (given !== 'select' || !Array.isArray(spec.options)) return [];
  const values = spec.options.filter(isObject).map((option) => option.value);
  const problems: string[] = [];
  const twice = values.find((value, index) => values.indexOf(value) !== index);
  if (twice !== undefined) problems.push(`${label} gives points for ${String(twice)} twice.`);
  if (field?.kind === 'select') {
    const known = field.options.map((option) => option.value);
    const unscored = known.filter((value) => !values.includes(value));
    const unknown = values.filter((value) => !known.includes(value as string));
    if (unscored.length)
      problems.push(
        `${label} has no points for ${unscored.join(', ')}. Every answer the form offers scores a stated number of points, 0 included.`,
      );
    if (unknown.length)
      problems.push(
        `${label} gives points for ${unknown.map(String).join(', ')}, which the field does not offer; its options are ${known.join(', ')}.`,
      );
  }
  return problems;
}

function pointsParameterProblems(params: Readonly<Record<string, unknown>>, context: CheckParameterContext): string[] {
  if (!Array.isArray(params.fields)) return [];
  const selection = isObject(params.select) ? params.select : undefined;
  const types = context
    .recordTypes('record')
    .filter(
      (type) =>
        selection?.recordType === undefined ||
        (type.recordType === selection.recordType && type.recordVersion === selection.recordVersion),
    );
  const specs = params.fields.filter(isObject);
  const paths = specs.map((spec) => spec.field);
  const twice = paths.find((path, index) => paths.indexOf(path) !== index);
  return [
    ...(twice === undefined ? [] : [`${fieldName(String(twice))} is scored twice; list each field once.`]),
    ...specs.flatMap((spec) =>
      scoredFieldProblems(spec, typeof spec.field === 'string' ? fieldRead(spec.field, types) : undefined),
    ),
  ];
}

// The kind ---------------------------------------------------------------------------------------------------------

export const recordPointsTotalV1: CheckKind<RecordPointsTotalParams> = {
  id: 'record.points-total',
  version: 1,
  title: 'The points of a record’s answers, totalled against a level',
  description:
    'Totals the points the rule gives the answers of one record and compares the total with a level. The record is the latest selected one made (atField, or its span start) at or before the flight’s time when the rule names a field for it (the takeoff a report states, else the takeoff in the operator’s flight record, else the planned start), and otherwise at or before the evaluation time. A record made after the flight’s time is never read for the flight. Each scored field takes its points from the rule: a number for each option of a field with listed options, for each band of a number, or for yes and for no. Points are whole numbers, so the total is exact. A total within the level (at_most, or below) passes; any other needs attention. The sentence lists every scored answer in the form’s own labels with the points it scored, then the total, the level and what the rule says the procedure asks at a total over it; it gives the total no other name. No such record is insufficient, reason record_not_on_file. A scored field with no answer, or an answer the rule states no points for, is insufficient and named: a missing answer never scores zero. Records made together that give different answers conflict.',
  inputs: [
    { name: 'record', description: 'The records that hold the answers, such as an assessment made for a flight.' },
    ...flightTimeInputs,
  ],
  details: [
    ...flightTimeDetails,
    { name: 'recordAt', description: 'When the record read was made, as a UTC instant; null when none.' },
    { name: 'total', description: 'The total of the points; null when no total could be stated.' },
    { name: 'level', description: 'The level the total is compared with.' },
    { name: 'points', description: 'Each scored field with its points, as name=points; null when no record.' },
    { name: 'answers', description: 'Each scored field with its answer as recorded, as name=answer; null when none.' },
    { name: 'missing', description: 'The scored fields with no answer, or none the rule scores, by name; else null.' },
  ],
  summaryValues: ['flightStart', 'recordAt'],
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['recordDescribes', 'fields', 'comparison', 'level', 'whenOver'],
    properties: {
      select: selectionSchema,
      atField: { ...fieldPath, description: 'When a record was made; without it, the time the record is placed at' },
      recordDescribes: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description: 'What a person calls the record, such as flight risk assessment',
      },
      fields: {
        type: 'array',
        minItems: 1,
        maxItems: 30,
        items: scoredFieldSchema,
        description:
          'Each scored field has field (its path) and exactly one of: options, a list of value and points, for a field with listed options, every option listed; bands, a list of from, to and points, for a number, where from is included and to is not, either may be left out for an open end, and the bands cover every value the field takes without overlapping; or yes and no, the points of each, for a yes-or-no field. Points are whole numbers',
      },
      comparison: {
        enum: Object.keys(comparisons),
        description: 'The total that passes: at most the level, or below it',
      },
      level: {
        type: 'integer',
        minimum: -100_000,
        maximum: 100_000,
        description: 'In points. Fix it in the rule, or leave it to adoptionParameters',
      },
      whenOver: {
        type: 'string',
        minLength: 1,
        maxLength: 300,
        description: 'What the procedure asks at a total over the level, in its own words; the sentence quotes it',
      },
      ...flightTimeSchema,
    },
    dependencies: flightTimeDependencies,
  },
  parameterProblems: pointsParameterProblems,
  evaluate(params, inputs, clock) {
    const asOfFlight =
      params.reportedStartField !== undefined ||
      params.recordedStartField !== undefined ||
      params.plannedStartField !== undefined;
    const window = asOfFlight ? flightWindow(params, inputs) : undefined;
    const details: CheckDetails = {
      ...windowDetails(window),
      recordAt: null,
      total: null,
      level: params.level,
      points: null,
      answers: null,
      missing: null,
    };
    const what = params.recordDescribes;
    if (asOfFlight && !window) return noFlightTime(`the ${what}`, details);
    const asOf = window?.start ?? utcMillis(clock.evaluatedAt)!;
    const when = window ? startWords(window) : 'the evaluation time';
    const made = current(inputs.record, params.select)
      .flatMap((observation) => {
        const time = placedTime(observation, params.atField, 'latest');
        return time ? [{ observation, ...time }] : [];
      })
      .sort((a, b) => b.at - a.at);
    const madeWords = (item: { at: number; day?: string }) =>
      item.day === undefined
        ? `at ${iso(item.at)}`
        : `on ${item.day} (only the date is on record, so it is read as made at the end of that day)`;
    const newest = made.find((item) => item.at <= asOf);
    const windowEvidence = window?.evidence ?? [];
    if (!newest) {
      const later = made.at(-1);
      return result(
        'insufficient',
        'pending',
        RECORD_NOT_ON_FILE,
        later
          ? `No ${what} is on file at or before ${when}. The earliest on file was made ${madeWords(later)}, after it, and is not read for it.`
          : `No ${what} is on file at or before ${when}.`,
        later ? [...windowEvidence, later.observation] : windowEvidence,
        details,
      );
    }
    const read = made.filter((item) => item.at === newest.at).map((item) => item.observation);
    const evidence = [...windowEvidence, ...read];
    details.recordAt = iso(newest.at);
    const answers = params.fields.map((spec) => answerOf(spec, read, params.select));
    const named = (state: Answer['state']) => answers.filter((answer) => answer.state === state);
    const labels = (list: readonly Answer[]) => list.map((answer) => answer.label).join(', ');
    const record = `The ${what} made ${madeWords(newest)}${window ? `, before ${when},` : ''}`;
    details.answers = detailEntries(
      answers.flatMap((answer) =>
        answer.state === 'scored' ? [`${fieldName(answer.path)}=${String(answer.value)}`] : [],
      ),
    );
    if (named('disagree').length)
      return result(
        'conflicting',
        'attention',
        'values_disagree',
        `${read.length} ${what} records made together ${madeWords(newest)} give different answers for: ${labels(named('disagree'))}. Correct the one that is wrong, or record it as replaced, so one answer stands.`,
        evidence,
        details,
      );
    const lacking = [...named('missing'), ...named('unscored')];
    if (lacking.length) {
      details.missing = detailEntries(lacking.map((answer) => fieldName(answer.path)));
      const missing = named('missing').length ? ` records no answer for: ${labels(named('missing'))}` : '';
      const unscored = named('unscored')
        .map((answer) => (answer.state === 'unscored' ? `${answer.label}: ${answer.shown}` : ''))
        .join('; ');
      return result(
        'insufficient',
        'attention',
        named('missing').length ? 'answer_missing' : 'answer_not_scored',
        `${record}${missing}${missing && unscored ? ', and' : ''}${unscored ? ` holds an answer the rule states no points for: ${unscored}` : ''}. An answer that is missing or not scored counts no points, so no total is stated.`,
        evidence,
        details,
      );
    }
    const scored = answers.flatMap((answer) => (answer.state === 'scored' ? [answer] : []));
    const total = scored.reduce((sum, answer) => sum + answer.points, 0);
    details.total = total;
    details.points = detailEntries(scored.map((answer) => `${fieldName(answer.path)}=${answer.points}`));
    const comparison = comparisons[params.comparison];
    const within = comparison.holds(total, params.level);
    const listed = scored.map((answer) => `${answer.label}: ${answer.shown} (${answer.points})`).join('; ');
    const level = pointsText(params.level);
    const totalWords = within
      ? `Total: ${pointsText(total)}, ${comparison.words} the level of ${level}.`
      : `Total: ${pointsText(total)}; the level is ${comparison.words} ${level}.`;
    const summary = `${record} scores ${listed}. ${totalWords} ${comparison.over(level)}: ${params.whenOver.replace(/[.\s]+$/u, '')}.`;
    return within
      ? result('supported', 'pass', 'total_within_level', summary, evidence, details)
      : result('supported', 'attention', 'total_over_level', summary, evidence, details);
  },
};

export const pointsCheckKinds: readonly CheckKind[] = [recordPointsTotalV1];
for (const kind of pointsCheckKinds) registerCheckKind(kind);
