import { RECORD_NOT_ON_FILE, type CheckDetails } from '@ledger/contracts';
import {
  isFilled,
  latestObservations,
  observationField,
  registerCheckKind,
  utcMillis,
  type CheckKind,
  type CheckObservation,
  type CheckResult,
} from './check-kinds.js';
import { sentenceStart, valueLabel } from './field-labels.js';
import {
  current,
  fieldPath,
  labelOf,
  recordCompleteV2,
  recordedSegment,
  scalars,
  selectionSchema,
  type Condition,
  type Scalar,
  type Segment,
  type Selection,
} from './check-kind-library-records.js';

// Whether a record is on file and in force, and which record it is (docs/design/on-file-checks.md). Never whether it
// is adequate: what the record says is for a person.

/** How many records are named in a summary; the rest are counted. */
const NAMED = 3;

export interface RecordInForceParams {
  /** What a person calls one such record, such as "safety policy". */
  recordLabel: string;
  select?: Selection;
  /**
   * A purpose the records must serve: ticked on the revision (its purposes list), or by the record's own type being
   * one the purpose names. The result says which.
   */
  serves?: { purpose: string; documentTypes?: string[] };
  /** Counts of the records in force that meet conditions, each with the words for what they are. */
  counts?: { where: Condition[]; describes: string }[];
  /** An operator record that stands instead when no record is in force, read for completeness. */
  alternative?: {
    recordType: string;
    recordVersion: number;
    titleField?: string;
    revisionField?: string;
    sinceField?: string;
  };
}

interface Placed {
  observation: CheckObservation;
  segment: Segment;
  /** How the record serves the purpose the rule asks for, when it asks for one. */
  serving?: 'its type' | 'ticked as serving it';
}

/** How a record serves the purpose, or undefined when it does not: by its type first, else by a tick. */
function serving(observation: CheckObservation, serves: NonNullable<RecordInForceParams['serves']>) {
  const type = observationField(observation, 'values.documentType');
  if (typeof type === 'string' && (serves.documentTypes ?? []).includes(type)) return 'its type' as const;
  const purposes = observationField(observation, 'values.purposes');
  return Array.isArray(purposes) && purposes.includes(serves.purpose) ? ('ticked as serving it' as const) : undefined;
}

const day = (millis: number) => new Date(millis).toISOString().slice(0, 10);

function text(observation: CheckObservation, field: string | undefined): string | undefined {
  const value = field === undefined ? undefined : observationField(observation, field);
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** “Title”, revision R: a record by its title and revision, or undefined for one without a title. */
function titled(observation: CheckObservation, titleField: string, revisionField: string): string | undefined {
  const title = text(observation, titleField);
  if (!title) return undefined;
  const revision = text(observation, revisionField);
  return `“${title}”${revision ? `, revision ${revision}` : ''}`;
}

function named(records: readonly Placed[], label: string): string {
  const names = records.flatMap(({ observation, segment, serving: by }) => {
    const name = titled(observation, 'values.title', 'values.revision');
    return name
      ? [
          `${name}, since ${day(segment.start)}${by ? (by === 'its type' ? ', serving it by its type' : ', ticked as serving it') : ''}`,
        ]
      : [];
  });
  if (!names.length) return `${records.length} ${label} record(s) on file.`;
  const more = records.length - Math.min(names.length, NAMED);
  return `In force: ${names.slice(0, NAMED).join('; ')}${more > 0 ? `; and ${more} more` : ''}.`;
}

function counted(records: readonly Placed[], counts: RecordInForceParams['counts']): string | null {
  if (!counts?.length) return null;
  return counts
    .map(({ where, describes }) => {
      const matching = current(
        records.map((record) => record.observation),
        { where },
      ).length;
      return `${matching} of them ${describes}`;
    })
    .join('; ');
}

function result(
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
    details,
    ...(nextBoundary === undefined || !Number.isFinite(nextBoundary)
      ? {}
      : { nextBoundary: new Date(nextBoundary).toISOString() }),
  };
}

const byStart = (a: Placed, b: Placed) =>
  a.segment.start - b.segment.start || (a.observation.id < b.observation.id ? -1 : 1);

export const recordInForceV1: CheckKind<RecordInForceParams> = {
  id: 'record.in-force',
  version: 1,
  title: 'A record on file and in force',
  description:
    'The selected records whose interval holds the evaluation instant are in force; with serves, only those serving the purpose count, by their type being one it names or by its being ticked on them, and each is named with which; an interval without an end has no recorded end. With any in force the result is supported and names each (its title, revision and the date it came into force), with the counts of those meeting each counted condition, and the next boundary is the earliest end. With none, the latest alternative operator record, when the rule reads one, stands instead and is checked for completeness as record.complete does; otherwise the result is insufficient with reason record_not_on_file, naming the latest record that ended and any that takes effect later, whose start is the next boundary. It says nothing about what a record holds.',
  inputs: [
    { name: 'records', description: 'Records with the interval they are in force over, such as issued documents.' },
    { name: 'record', description: 'An operator record that may stand instead.', optional: true },
  ],
  details: [
    { name: 'recordsInForce', description: 'How many selected records are in force.' },
    { name: 'named', description: 'The sentence naming the records in force, or the operator record read instead.' },
    { name: 'title', description: 'The title of the first record in force; else null.' },
    { name: 'revision', description: 'Its revision; else null.' },
    { name: 'inForceSince', description: 'The date it came into force (UTC); else null.' },
    { name: 'counts', description: 'The counts of records in force meeting each counted condition; else null.' },
    { name: 'basis', description: 'in_force, operator_record, or null when nothing stands.' },
    {
      name: 'servedBy',
      description:
        'With a purpose, how the first record in force serves it: its type, or ticked as serving it; else null.',
    },
  ],
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['recordLabel'],
    properties: {
      recordLabel: { type: 'string', minLength: 1, maxLength: 200 },
      select: selectionSchema,
      serves: {
        type: 'object',
        additionalProperties: false,
        required: ['purpose'],
        properties: {
          purpose: { type: 'string', minLength: 1, maxLength: 120 },
          documentTypes: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            uniqueItems: true,
            items: { type: 'string', minLength: 1, maxLength: 80 },
          },
        },
      },
      counts: {
        type: 'array',
        minItems: 1,
        maxItems: 5,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['where', 'describes'],
          properties: {
            where: (selectionSchema.properties as Record<string, unknown>).where,
            describes: { type: 'string', minLength: 1, maxLength: 200 },
          },
        },
      },
      alternative: {
        type: 'object',
        additionalProperties: false,
        required: ['recordType', 'recordVersion'],
        properties: {
          recordType: (selectionSchema.properties as Record<string, unknown>).recordType,
          recordVersion: { type: 'integer', minimum: 1 },
          titleField: fieldPath,
          revisionField: fieldPath,
          sinceField: fieldPath,
        },
      },
    },
  },
  evaluate(params, inputs, clock) {
    const now = utcMillis(clock.evaluatedAt)!;
    const recorded = current(inputs.records, params.select).flatMap((observation): Placed[] => {
      const segment = recordedSegment(observation, 'open');
      if (!segment) return [];
      if (!params.serves) return [{ observation, segment }];
      const by = serving(observation, params.serves);
      return by ? [{ observation, segment, serving: by }] : [];
    });
    const inForce = recorded.filter(({ segment }) => segment.start <= now && now < segment.end).sort(byStart);
    const later = recorded.filter(({ segment }) => segment.start > now).sort(byStart);
    const ended = recorded
      .filter(({ segment }) => segment.end <= now)
      .sort((a, b) => b.segment.end - a.segment.end || byStart(a, b));
    const first = inForce[0];
    const details: CheckDetails = {
      recordsInForce: inForce.length,
      named: null,
      title: first ? (text(first.observation, 'values.title') ?? null) : null,
      revision: first ? (text(first.observation, 'values.revision') ?? null) : null,
      inForceSince: first ? day(first.segment.start) : null,
      counts: counted(inForce, params.counts),
      basis: null,
      servedBy: first?.serving ?? null,
    };
    const nextStart = later[0]?.segment.start;
    if (first) {
      details.named = named(inForce, params.recordLabel);
      details.basis = 'in_force';
      const ends = Math.min(...inForce.map(({ segment }) => segment.end), nextStart ?? Infinity);
      return result(
        'supported',
        'pass',
        'record_in_force',
        `${details.named}${details.counts ? ` ${details.counts}.` : ''}`,
        inForce.map((item) => item.observation),
        details,
        ends,
      );
    }
    const alternative = params.alternative && (inputs.record ?? []).length ? params.alternative : undefined;
    if (alternative) {
      const complete = recordCompleteV2.evaluate(
        { recordType: alternative.recordType, recordVersion: alternative.recordVersion },
        { record: inputs.record },
        clock,
      );
      if (complete.reasonCode === 'record_complete' || complete.reasonCode === 'record_incomplete') {
        const record = (inputs.record ?? []).find((observation) => complete.evidence.includes(observation.id))!;
        const name = titled(
          record,
          alternative.titleField ?? 'values.record.title',
          alternative.revisionField ?? 'values.record.revision',
        );
        const since = utcMillis(text(record, alternative.sinceField ?? 'values.record.effectiveAt'));
        details.named = `No controlled document serving this is in force; read the operator record instead${name ? `: ${name}` : ''}${since === undefined ? '' : `, in effect from ${day(since)}`}.`;
        details.basis = 'operator_record';
        return complete.reasonCode === 'record_complete'
          ? result('supported', 'pass', 'operator_record_on_file', details.named, [record], details, nextStart)
          : { ...complete, summary: `${details.named} ${complete.summary}`, details };
      }
    }
    const latest = ended[0];
    const endedWords = latest
      ? ` The latest, ${titled(latest.observation, 'values.title', 'values.revision') ?? 'one'}, was in force from ${day(latest.segment.start)} until ${day(latest.segment.end)}.`
      : '';
    const laterWords = later[0]
      ? ` ${titled(later[0].observation, 'values.title', 'values.revision') ?? 'One'} takes effect on ${day(later[0].segment.start)}.`
      : '';
    return result(
      'insufficient',
      'pending',
      RECORD_NOT_ON_FILE,
      `No ${params.recordLabel} on file.${endedWords}${laterWords}`,
      [...(latest ? [latest.observation] : []), ...(later[0] ? [later[0].observation] : [])],
      details,
      nextStart,
    );
  },
};

// Values on file for a subject, from the first source that states them ---------------------------------------------

export interface OnFileValue {
  field: string;
  /** The same value in the fallback input, read where the primary input states none. */
  fallbackField?: string;
  describes: string;
}

export interface ValuesOnFileParams {
  /** What a person calls the values together, such as "takeoff and landing times". */
  describes: string;
  /** What a person calls the subject, such as "flight". */
  subjectDescribes: string;
  values: OnFileValue[];
  select?: Selection;
  /** Words for where the primary input's values come from, such as "the flight’s reports". */
  primaryDescribes: string;
  fallbackSelect?: Selection;
  fallbackDescribes?: string;
  /** one: each value once for the subject. each: every selected primary observation holding all values is listed. */
  scope?: 'one' | 'each';
  /** The first value is a start and the second an end: the end must be after the start, and the duration is stated. */
  interval?: boolean;
}

type Shown = string | number | boolean;

/** A value as a person reads it: an option's label, a reference's id, a number or text as recorded. */
function shownValue(value: unknown): Shown | undefined {
  if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string')
    return (value as { id: string }).id;
  if (typeof value === 'string') return value.trim() ? value : undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean') return value;
  return undefined;
}

function wordsOf(field: string, value: Shown, observations: readonly CheckObservation[]): string {
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return typeof value === 'string' ? valueLabel(field, value, observations) : String(value);
}

interface Found {
  values: Shown[];
  observations: CheckObservation[];
}

/** The distinct values a field holds across the observations, with those holding one. */
function found(observations: readonly CheckObservation[], field: string | undefined): Found {
  if (field === undefined) return { values: [], observations: [] };
  const holding = observations.flatMap((observation) => {
    const value = shownValue(observationField(observation, field));
    return value === undefined ? [] : [{ observation, value }];
  });
  const distinct = new Map<string, Shown>();
  for (const { value } of holding) {
    const instant = typeof value === 'string' ? utcMillis(value) : undefined;
    distinct.set(instant === undefined ? JSON.stringify(value) : `@${instant}`, value);
  }
  return { values: [...distinct.values()], observations: holding.map((item) => item.observation) };
}

function joined(items: readonly string[], last = 'and'): string {
  return items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} ${last} ${items.at(-1)}`;
}

function minutesBetween(start: Shown, end: Shown): number | undefined {
  const from = typeof start === 'string' ? utcMillis(start) : undefined;
  const to = typeof end === 'string' ? utcMillis(end) : undefined;
  return from === undefined || to === undefined ? undefined : (to - from) / 60_000;
}

const onFileDetails = [
  {
    name: 'basis',
    description:
      'primary when every value was read from the primary input, fallback when every one was read from the fallback, both when some were read from each; null when not all are on file.',
  },
  {
    name: 'valuesOnFile',
    description: 'How many of the values (or, with scope each, how many observations) are on file.',
  },
  {
    name: 'differing',
    description: 'How many values read from the primary input differ from the one the fallback input also states.',
  },
  { name: 'durationMinutes', description: 'With interval, the minutes from the start to the end; null otherwise.' },
  { name: 'reading', description: 'The result in one or more sentences, for a rule’s wording to quote.' },
] as const;

export const valuesOnFileV1: CheckKind<ValuesOnFileParams> = {
  id: 'values.on-file',
  version: 1,
  title: 'Values on file for a subject, from the first source that states them',
  description:
    'Whether each named value is on file for the subject. With scope one, each value is read from the selected observations of the primary input where any states it, and otherwise from the fallback field of the selected fallback observations; the result names the source of each, and where the fallback also states a value that differs from the one read, it names that value too. The two are never mixed into one value. Observations of one input that state different values for the same field conflict. With interval, the first value is a start and the second an end: an end not after its start conflicts, and the duration is stated. With scope each, every selected primary observation holding all values is listed. When any value is not on file the result is insufficient with reason record_not_on_file and says which, and where it was looked for. It says nothing about whether the values are right.',
  inputs: [
    { name: 'primary', description: 'Observations or operator records read first.' },
    {
      name: 'fallback',
      description: 'Observations or operator records read where the primary input states no value.',
      optional: true,
    },
  ],
  details: [...onFileDetails],
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['describes', 'subjectDescribes', 'values', 'primaryDescribes'],
    properties: {
      describes: { type: 'string', minLength: 1, maxLength: 200 },
      subjectDescribes: { type: 'string', minLength: 1, maxLength: 100 },
      values: {
        type: 'array',
        minItems: 1,
        maxItems: 10,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['field', 'describes'],
          properties: {
            field: fieldPath,
            fallbackField: fieldPath,
            describes: { type: 'string', minLength: 1, maxLength: 200 },
          },
        },
      },
      select: selectionSchema,
      primaryDescribes: { type: 'string', minLength: 1, maxLength: 200 },
      fallbackSelect: selectionSchema,
      fallbackDescribes: { type: 'string', minLength: 1, maxLength: 200 },
      scope: { enum: ['one', 'each'] },
      interval: { type: 'boolean' },
    },
    dependencies: { fallbackSelect: ['fallbackDescribes'] },
  },
  evaluate(params, inputs) {
    const subject = `this ${params.subjectDescribes}`;
    const primary = current(inputs.primary, params.select);
    const fallback = current(inputs.fallback, params.fallbackSelect);
    const details: CheckDetails = { basis: null, valuesOnFile: 0, differing: 0, durationMinutes: null };
    const done = (
      evidenceState: CheckResult['evidenceState'],
      outcome: CheckResult['outcome'],
      reasonCode: string,
      summary: string,
      evidence: readonly CheckObservation[],
    ) => result(evidenceState, outcome, reasonCode, summary, evidence, { ...details, reading: summary });
    const sources = params.fallbackDescribes
      ? `${params.primaryDescribes} or ${params.fallbackDescribes}`
      : params.primaryDescribes;

    if (params.scope === 'each') {
      const entries = primary.flatMap((observation) => {
        const shown = params.values.map((value) => {
          const read = shownValue(observationField(observation, value.field));
          return read === undefined ? undefined : wordsOf(value.field, read, [observation]);
        });
        return shown.every((item) => item !== undefined) ? [{ observation, words: shown.join(', ') }] : [];
      });
      details.valuesOnFile = entries.length;
      if (!entries.length)
        return done(
          'insufficient',
          'pending',
          RECORD_NOT_ON_FILE,
          `No ${params.describes} on file for ${subject} in ${params.primaryDescribes}.`,
          primary.slice(0, NAMED),
        );
      details.basis = 'primary';
      return done(
        'supported',
        'pass',
        'values_on_file',
        `On file for ${subject}, from ${params.primaryDescribes}: ${entries.map((entry) => entry.words).join('; ')}.`,
        entries.map((entry) => entry.observation),
      );
    }

    const read = params.values.map((value) => {
      const fromPrimary = found(primary, value.field);
      const fromFallback = found(fallback, value.fallbackField);
      return { value, fromPrimary, fromFallback };
    });
    const disagreeing = read.flatMap(({ value, fromPrimary, fromFallback }) => {
      if (fromPrimary.values.length > 1) return [{ value, source: params.primaryDescribes, found: fromPrimary }];
      if (!fromPrimary.values.length && fromFallback.values.length > 1)
        return [{ value, source: params.fallbackDescribes!, found: fromFallback }];
      return [];
    });
    if (disagreeing.length)
      return done(
        'conflicting',
        'attention',
        'values_disagree',
        disagreeing
          .map(
            ({ value, source, found: item }) =>
              `${sentenceStart(source)} state different ${value.describes} for ${subject}: ${joined(item.values.map((shown) => wordsOf(value.field, shown, item.observations)))}.`,
          )
          .join(' '),
        disagreeing.flatMap((item) => item.found.observations),
      );
    const chosen = read.map(({ value, fromPrimary, fromFallback }) => {
      if (fromPrimary.values.length === 1) {
        const other = fromFallback.values[0];
        const differs =
          fromFallback.values.length === 1 &&
          (typeof other === 'string' && typeof fromPrimary.values[0] === 'string'
            ? utcMillis(other) !== undefined
              ? utcMillis(other) !== utcMillis(fromPrimary.values[0])
              : other !== fromPrimary.values[0]
            : other !== fromPrimary.values[0]);
        return {
          value,
          from: 'primary' as const,
          shown: fromPrimary.values[0]!,
          found: fromPrimary,
          differs,
          other,
          fallback: fromFallback,
        };
      }
      if (fromFallback.values.length === 1)
        return {
          value,
          from: 'fallback' as const,
          shown: fromFallback.values[0]!,
          found: fromFallback,
          differs: false,
          other: undefined,
          fallback: fromFallback,
        };
      return {
        value,
        from: undefined,
        shown: undefined,
        found: fromPrimary,
        differs: false,
        other: undefined,
        fallback: fromFallback,
      };
    });
    const present = chosen.filter((item) => item.from !== undefined);
    details.valuesOnFile = present.length;
    const describe = (item: (typeof chosen)[number]) =>
      `${item.value.describes} ${wordsOf(item.from === 'fallback' ? item.value.fallbackField! : item.value.field, item.shown!, item.found.observations)}`;
    const evidence = present.flatMap((item) => [
      ...item.found.observations,
      ...(item.differs ? item.fallback.observations : []),
    ]);
    if (present.length < chosen.length) {
      const missing = chosen.filter((item) => item.from === undefined).map((item) => item.value.describes);
      const onFile = present.length ? ` On file: ${present.map(describe).join(', ')}.` : '';
      return done(
        'insufficient',
        'pending',
        RECORD_NOT_ON_FILE,
        `No ${joined(missing, 'or')} on file for ${subject} in ${sources}.${onFile}`,
        evidence,
      );
    }
    const froms = new Set(present.map((item) => item.from));
    details.basis = froms.size > 1 ? 'both' : [...froms][0]!;
    const sourceWords =
      details.basis === 'both'
        ? present
            .map(
              (item) =>
                `${describe(item)} (from ${item.from === 'primary' ? params.primaryDescribes : params.fallbackDescribes})`,
            )
            .join(', ')
        : present.map(describe).join(', ');
    const fromWords =
      details.basis === 'both'
        ? ''
        : `, from ${details.basis === 'primary' ? params.primaryDescribes : params.fallbackDescribes}`;
    let durationWords = '';
    if (params.interval && present.length >= 2) {
      const minutes = minutesBetween(present[0]!.shown!, present[1]!.shown!);
      if (minutes !== undefined && minutes <= 0)
        return done(
          'conflicting',
          'attention',
          'end_not_after_start',
          `The ${present[1]!.value.describes} on file for ${subject} is not after its ${present[0]!.value.describes}: ${sourceWords}.`,
          evidence,
        );
      if (minutes !== undefined) {
        details.durationMinutes = Math.round(minutes * 100) / 100;
        durationWords = `, a duration of ${details.durationMinutes} minutes`;
      }
    }
    const differing = present.filter((item) => item.differs);
    details.differing = differing.length;
    const differingWords = differing
      .map(
        (item) =>
          ` The ${item.value.describes} in ${params.fallbackDescribes} is ${wordsOf(item.value.fallbackField!, item.other!, item.fallback.observations)}, which differs; the one in ${params.primaryDescribes} is read.`,
      )
      .join('');
    return done(
      'supported',
      'pass',
      'values_on_file',
      `On file for ${subject}${fromWords}: ${sourceWords}${durationWords}.${differingWords}`,
      evidence,
    );
  },
};

export interface RecordsCountedParams {
  /** What a person calls one counted record, such as "safety assurance record". */
  recordLabel: string;
  /** The records counted by when they start. */
  select?: Selection;
  /** Counts of the counted records that meet conditions, each with the words for what they are; none is stated. */
  counts?: { where: Condition[]; describes: string }[];
  /** Items counted while they are open now, such as actions, with how many are past their due time. `label` starts the sentence. */
  open?: { select?: Selection; label: string; dueField: string };
}

function countsOf(records: readonly CheckObservation[], counts: RecordsCountedParams['counts']): string[] {
  return (counts ?? []).flatMap(({ where, describes }) => {
    const matching = current(records, { where }).length;
    return matching ? [`${describes}: ${matching}`] : [];
  });
}

export const recordsCountedV1: CheckKind<RecordsCountedParams> = {
  id: 'records.counted',
  version: 1,
  title: 'Records on file, counted within the adoption’s dates',
  description:
    'Counts the selected records whose interval starts within the adoption’s dates and no later than the evaluation instant, with the count of those meeting each counted condition; with open, also counts the items whose interval holds the evaluation instant and how many of them are past the time in their due field. With any record counted the result is supported and states the counts; with none it is insufficient with reason record_not_on_file, says how many started before the adoption’s start and when the latest did, and still states the open and overdue counts. The next boundary is the earliest due time still ahead among the open items, or the adoption’s end. A count is on file or not; it says nothing about what a record holds.',
  inputs: [{ name: 'records', description: 'Records with the interval they are on file or open over.' }],
  details: [
    { name: 'stated', description: 'The sentence stating the counts.' },
    { name: 'recordsCounted', description: 'How many selected records start within the dates counted.' },
    { name: 'countedFrom', description: 'The first day counted (UTC): the adoption’s start; else null.' },
    { name: 'earlier', description: 'How many selected records started before the adoption’s start.' },
    { name: 'counts', description: 'The counts of counted records meeting each condition; else null.' },
    { name: 'open', description: 'How many open items there are, with open; else null.' },
    { name: 'overdue', description: 'How many of the open items are past their due time, with open; else null.' },
  ],
  adoptionDates: 'Records are counted from the adoption’s start, and only those starting before its end.',
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['recordLabel'],
    properties: {
      recordLabel: { type: 'string', minLength: 1, maxLength: 200 },
      select: selectionSchema,
      counts: {
        type: 'array',
        minItems: 1,
        maxItems: 10,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['where', 'describes'],
          properties: {
            where: (selectionSchema.properties as Record<string, unknown>).where,
            describes: { type: 'string', minLength: 1, maxLength: 200 },
          },
        },
      },
      open: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'dueField'],
        properties: {
          select: selectionSchema,
          label: { type: 'string', minLength: 1, maxLength: 200 },
          dueField: fieldPath,
        },
      },
    },
  },
  evaluate(params, inputs, clock) {
    const now = utcMillis(clock.evaluatedAt)!;
    const from = utcMillis(clock.adoption?.start) ?? -Infinity;
    const until = Math.min(now, utcMillis(clock.adoption?.end) ?? Infinity);
    const counted = current(inputs.records, params.select).filter((observation) => {
      const segment = recordedSegment(observation, 'open');
      return segment !== undefined && segment.start >= from && segment.start <= until;
    });
    const open = params.open
      ? current(inputs.records, params.open.select).filter((observation) => {
          const segment = recordedSegment(observation, 'open');
          return segment !== undefined && segment.start <= now && now < segment.end;
        })
      : [];
    const due = (observation: CheckObservation) =>
      params.open ? utcMillis(text(observation, params.open.dueField)) : undefined;
    const overdue = open.filter((observation) => {
      const at = due(observation);
      return at !== undefined && at <= now;
    });
    const ahead = open.flatMap((observation) => {
      const at = due(observation);
      return at !== undefined && at > now ? [at] : [];
    });
    const earlier = current(inputs.records, params.select)
      .flatMap((observation) => {
        const segment = recordedSegment(observation, 'open');
        return segment !== undefined && segment.start < from ? [segment.start] : [];
      })
      .sort((a, b) => b - a);
    const counts = countsOf(counted, params.counts);
    const details: CheckDetails = {
      stated: null,
      recordsCounted: counted.length,
      countedFrom: Number.isFinite(from) ? day(from) : null,
      earlier: earlier.length,
      counts: counts.length ? counts.join('; ') : null,
      open: params.open ? open.length : null,
      overdue: params.open ? overdue.length : null,
    };
    const since = Number.isFinite(from) ? ` since ${day(from)}` : '';
    const openWords = params.open
      ? ` ${params.open.label}: ${open.length} open, ${overdue.length} of them past the due date.`
      : '';
    const boundary = Math.min(...ahead, utcMillis(clock.adoption?.end) ?? Infinity);
    if (!counted.length) {
      const before = earlier.length
        ? ` ${earlier.length} earlier ${earlier.length === 1 ? 'one is' : 'ones are'} on file, the latest from ${day(earlier[0]!)}.`
        : '';
      details.stated = `No ${params.recordLabel} on file${since}.${before}${openWords}`;
      return result(
        'insufficient',
        'pending',
        RECORD_NOT_ON_FILE,
        details.stated,
        [...open],
        details,
        boundary > now ? boundary : undefined,
      );
    }
    details.stated = `${counted.length} ${params.recordLabel}${counted.length === 1 ? '' : 's'} on file${since}${counts.length ? `: ${counts.join('; ')}` : ''}.${openWords}`;
    return result(
      'supported',
      'pass',
      'records_counted',
      details.stated,
      [...counted, ...open],
      details,
      boundary > now ? boundary : undefined,
    );
  },
};

// Every record in force holds the named values ----------------------------------------------------------------------

export interface EachInForceParams {
  /** What a person calls one such record, such as "operating area". */
  recordLabel: string;
  /** The field that holds the organization's own id for each record, which the summary names it by. */
  idField: string;
  /** The values each record in force must hold, each with what a person calls it. */
  values: { field: string; describes: string }[];
  select?: Selection;
}

const numbered = new Intl.Collator('en', { numeric: true });

function idOf(observation: CheckObservation, field: string): string {
  return text(observation, field) ?? observation.id;
}

function listed(ids: readonly string[]): string {
  const shown = ids.slice(0, NAMED * 3);
  return `${shown.join(', ')}${ids.length > shown.length ? ` and ${ids.length - shown.length} more` : ''}`;
}

export const eachInForceV1: CheckKind<EachInForceParams> = {
  id: 'records.each-in-force',
  version: 1,
  title: 'Every record in force holds the named values',
  description:
    'The selected records whose interval holds the evaluation instant are in force (an interval without an end has no recorded end). Each record in force must hold every named value (absent, null and blank text are not held; false is). With every one holding them the result is supported and names each record by the id it states; with one or more lacking a value it needs attention and names each with what it lacks. With none in force the result is insufficient with reason record_not_on_file, naming the latest record that ended and the earliest that takes effect later, whose start is the next boundary. The earliest end of a record in force is the next boundary otherwise. It says nothing about whether a value is adequate.',
  inputs: [
    { name: 'records', description: 'Records with the interval they are in force over, such as operating areas.' },
  ],
  details: [
    { name: 'recordsInForce', description: 'How many selected records are in force.' },
    { name: 'named', description: 'The ids of the records in force, in order of their start.' },
    { name: 'lacking', description: 'How many records in force lack one or more named values.' },
  ],
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['recordLabel', 'idField', 'values'],
    properties: {
      recordLabel: { type: 'string', minLength: 1, maxLength: 200 },
      idField: fieldPath,
      values: {
        type: 'array',
        minItems: 1,
        maxItems: 10,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['field', 'describes'],
          properties: { field: fieldPath, describes: { type: 'string', minLength: 1, maxLength: 200 } },
        },
      },
      select: selectionSchema,
    },
  },
  evaluate(params, inputs, clock) {
    const now = utcMillis(clock.evaluatedAt)!;
    const recorded = current(inputs.records, params.select).flatMap((observation): Placed[] => {
      const segment = recordedSegment(observation, 'open');
      return segment ? [{ observation, segment }] : [];
    });
    // Records starting together are named in the order of their own ids, so the summary does not depend on Ledger's.
    const byStartAndId = (a: Placed, b: Placed) =>
      a.segment.start - b.segment.start ||
      numbered.compare(idOf(a.observation, params.idField), idOf(b.observation, params.idField)) ||
      byStart(a, b);
    const inForce = recorded.filter(({ segment }) => segment.start <= now && now < segment.end).sort(byStartAndId);
    const later = recorded.filter(({ segment }) => segment.start > now).sort(byStartAndId);
    const ended = recorded
      .filter(({ segment }) => segment.end <= now)
      .sort((a, b) => b.segment.end - a.segment.end || byStartAndId(a, b));
    const ids = inForce.map(({ observation }) => idOf(observation, params.idField));
    const details: CheckDetails = {
      recordsInForce: inForce.length,
      named: ids.length ? listed(ids) : null,
      lacking: 0,
    };
    const nextStart = later[0]?.segment.start;
    if (!inForce.length) {
      const endedWords = ended[0]
        ? ` The latest, ${idOf(ended[0].observation, params.idField)}, was in force from ${day(ended[0].segment.start)} until ${day(ended[0].segment.end)}.`
        : '';
      const laterWords = later[0]
        ? ` ${idOf(later[0].observation, params.idField)} is in force from ${day(later[0].segment.start)}.`
        : '';
      return result(
        'insufficient',
        'pending',
        RECORD_NOT_ON_FILE,
        `No ${params.recordLabel} in force is on file.${endedWords}${laterWords}`,
        [...(ended[0] ? [ended[0].observation] : []), ...(later[0] ? [later[0].observation] : [])],
        details,
        nextStart,
      );
    }
    const ends = Math.min(...inForce.map(({ segment }) => segment.end), nextStart ?? Infinity);
    const lacking = inForce.flatMap(({ observation }) => {
      const missing = params.values.filter(({ field }) => !isFilled(observationField(observation, field)));
      return missing.length ? [{ observation, missing }] : [];
    });
    details.lacking = lacking.length;
    const count = `${inForce.length} ${params.recordLabel}${inForce.length === 1 ? '' : 's'} in force: ${listed(ids)}.`;
    if (lacking.length)
      return result(
        'insufficient',
        'attention',
        'value_not_on_file',
        `${count} ${lacking
          .map(
            ({ observation, missing }) =>
              `${sentenceStart(params.recordLabel)} ${idOf(observation, params.idField)} states no ${missing.map(({ describes }) => describes).join(' and no ')}.`,
          )
          .join(' ')}`,
        lacking.map(({ observation }) => observation),
        details,
        ends,
      );
    return result(
      'supported',
      'pass',
      'values_on_file',
      `${count} Each states its ${params.values.map(({ describes }) => describes).join(' and its ')}.`,
      inForce.map(({ observation }) => observation),
      details,
      ends,
    );
  },
};

// The latest record holds an expected value, and a value not recorded needs attention -------------------------------

export interface ValueRecordedAsParams {
  field: string;
  expected: Scalar[];
  select?: Selection;
}

export const valueRecordedAsV1: CheckKind<ValueRecordedAsParams> = {
  id: 'value.recorded-as',
  version: 1,
  title: 'The latest record holds an expected value; none recorded needs attention',
  description:
    'A field of the latest selected record holds one of the expected values. Unlike value.one-of, a record that holds no value in the field needs attention: for a value that must be recorded before something else happens, such as a return to service before a flight. No selected record does not apply. Simultaneous records that disagree conflict.',
  inputs: [{ name: 'subject', description: 'Records that carry the field.' }],
  details: [{ name: 'value', description: 'The value the latest record holds, as a person reads it; null when none.' }],
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['field', 'expected'],
    properties: { select: selectionSchema, field: fieldPath, expected: scalars },
  },
  evaluate(params, inputs) {
    const latest = latestObservations(current(inputs.subject, params.select));
    const details: CheckDetails = { value: null };
    if (!latest.length)
      return result('not_applicable', 'not_applicable', 'record_not_present', 'No record is read.', [], details);
    const label = labelOf(params.field, latest, params.select);
    const values = [
      ...new Set(
        latest.map((observation) => {
          const value = observationField(observation, params.field);
          return isFilled(value) && ['string', 'number', 'boolean'].includes(typeof value) ? (value as Scalar) : null;
        }),
      ),
    ];
    if (values.length > 1)
      return result(
        'conflicting',
        'attention',
        'values_disagree',
        `Records at the same time hold different values for ${label}.`,
        latest,
        details,
      );
    const value = values[0]!;
    if (value === null)
      return result(
        'insufficient',
        'attention',
        'value_not_recorded',
        `No value is recorded for ${label}.`,
        latest,
        details,
      );
    const shown = (item: Scalar) => valueLabel(params.field, item, latest, params.select);
    details.value = shown(value);
    const statement = `The latest record holds ${shown(value)} for ${label}.`;
    if (params.expected.includes(value))
      return result('supported', 'pass', 'value_expected', statement, latest, details);
    return result(
      'supported',
      'attention',
      'value_unexpected',
      `${statement} Expected ${params.expected.map(shown).join(' or ')}.`,
      latest,
      details,
    );
  },
};

export const onFileCheckKinds: readonly CheckKind[] = [
  recordInForceV1,
  valuesOnFileV1,
  recordsCountedV1,
  eachInForceV1,
  valueRecordedAsV1,
];
for (const kind of onFileCheckKinds) registerCheckKind(kind);
