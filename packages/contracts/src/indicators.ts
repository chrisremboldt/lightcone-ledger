import { Type, type SchemaOptions, type Static, type TLiteral } from '@sinclair/typebox';
import { ObservationFieldPathPattern } from './checked-rules.js';
import {
  ObservationTypeIdPattern,
  ObservationTypeIdSchema,
  ObservationVersionSchema,
  observationSubjectKindValues,
} from './observations/envelope.js';
import { SubjectReferenceSchema } from './rule-evaluations.js';

/** Hard bounds on one indicator calculation and on what gathering reads for it. */
export const INDICATOR_LIMITS = {
  maxSubjects: 200,
  maxEvents: 2000,
  maxExposureObservations: 5000,
  maxEvaluations: 5000,
  maxWindowMilliseconds: 366 * 24 * 60 * 60 * 1000,
  maxPer: 1_000_000_000,
  maxFractionDigits: 12,
} as const;

const Id = Type.String({ minLength: 1, maxLength: 200 });
const Version = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const Digest = Type.String({ pattern: '^[a-f0-9]{64}$' });
const Time = Type.String({
  format: 'date-time',
  pattern: '^(?!0000)\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:[0-5]\\d(?:\\.\\d{1,3})?Z$',
});
const Closed = { additionalProperties: false } as const;
const literals = <const Values extends readonly string[]>(values: Values, options: SchemaOptions = {}) =>
  Type.Union(values.map((value) => Type.Literal(value)) as TLiteral<Values[number]>[], options);
const FieldPath = Type.String({ pattern: ObservationFieldPathPattern, maxLength: 400 });
const ScalarValue = Type.Unsafe<string | number | boolean>({ type: ['string', 'number', 'boolean'], maxLength: 1000 });

/** A non-negative decimal written in base ten, such as 0, 12 or 2.5. */
export const IndicatorDecimalPattern = '^(0|[1-9][0-9]{0,17})(\\.[0-9]{1,12})?$';
const Decimal = Type.String({ pattern: IndicatorDecimalPattern });
const Integer = Type.String({ pattern: '^(0|[1-9][0-9]{0,79})$' });
const PositiveInteger = Type.String({ pattern: '^[1-9][0-9]{0,79}$' });

/** An exact non-negative fraction in lowest terms. The arithmetic behind every exposure and rate is exact. */
export const IndicatorRationalSchema = Type.Object({ numerator: Integer, denominator: PositiveInteger }, Closed);
export type IndicatorRational = Static<typeof IndicatorRationalSchema>;

export const IndicatorFieldConditionSchema = Type.Union(
  [
    Type.Object({ field: FieldPath, operator: Type.Literal('present') }, Closed),
    Type.Object({ field: FieldPath, operator: Type.Literal('equals'), value: ScalarValue }, Closed),
    Type.Object(
      {
        field: FieldPath,
        operator: Type.Literal('one_of'),
        values: Type.Array(ScalarValue, { minItems: 1, maxItems: 50 }),
      },
      Closed,
    ),
    Type.Object(
      { field: FieldPath, operator: literals(['at_least', 'at_most', 'above', 'below']), value: Type.Number() },
      Closed,
    ),
  ],
  {
    description:
      'A condition on one field of the accepted observation, read by dot-separated path. An absent field never matches, except that present asks for it.',
  },
);
export type IndicatorFieldCondition = Static<typeof IndicatorFieldConditionSchema>;

export const IndicatorScopeSchema = Type.Union(
  [
    Type.Object({ kind: Type.Literal('organization') }, Closed),
    Type.Object(
      {
        kind: Type.Literal('subjects'),
        subjects: Type.Array(SubjectReferenceSchema, { minItems: 1, maxItems: INDICATOR_LIMITS.maxSubjects }),
      },
      Closed,
    ),
    Type.Object({ kind: Type.Literal('subject_kind'), subjectKind: literals(observationSubjectKindValues) }, Closed),
  ],
  {
    description:
      'Which subjects are counted. subjects lists them. organization and subject_kind need a population of subjects declared for the window, by a named person or source.',
  },
);
export type IndicatorScope = Static<typeof IndicatorScopeSchema>;

export const IndicatorEventsSchema = Type.Union(
  [
    Type.Object(
      { kind: Type.Literal('findings'), packId: Id, ruleId: Id },
      {
        ...Closed,
        description:
          'Findings the generic evaluator opened for the named rule, placed by openedAt; a finding opened on a plan is placed no earlier than the start of the time the plan is about.',
      },
    ),
    Type.Object(
      {
        kind: Type.Literal('issues'),
        packId: Id,
        ruleId: Id,
        alsoRules: Type.Optional(
          Type.Array(Type.Object({ packId: Id, ruleId: Id }, Closed), {
            minItems: 1,
            maxItems: 9,
            description: 'Further rules whose issues are counted with those of the named rule.',
          }),
        ),
        countEach: Type.Optional(
          literals(['issue', 'subject'], {
            description:
              'issue (the default): each distinct issue of each rule is one event. subject: each subject in scope with at least one issue in the window is one event, however many issues and rules name it.',
          }),
        ),
      },
      {
        ...Closed,
        description:
          'The distinct issues the named rules’ active evaluations of a subject in scope named, each counted once however many evaluations name it and whether or not it was later settled; or, with countEach subject, the subjects with any such issue, each counted once. An issue is placed by the time its check kind gives it (from its start to its end, or on while it continues), else at the time of the evaluation that first named it. An issue begun before the window whose end is unknown cannot be placed and makes the result insufficient, unless its subject is counted by another issue; one counted in the window whose latest naming evaluation found the evidence conflicting makes it conflicting. Evaluations still due for the population make it insufficient.',
      },
    ),
    Type.Object(
      {
        kind: Type.Literal('observations'),
        type: ObservationTypeIdSchema,
        versions: Type.Array(ObservationVersionSchema, { minItems: 1, maxItems: 20, uniqueItems: true }),
        condition: Type.Optional(IndicatorFieldConditionSchema),
      },
      {
        ...Closed,
        description:
          'Accepted observations of the type, placed by span start (interval start, else occurredAt), that meet the condition.',
      },
    ),
  ],
  { description: 'What is counted.' },
);
export type IndicatorEvents = Static<typeof IndicatorEventsSchema>;

export const IndicatorDefinitionContentSchema = Type.Object(
  {
    format: Type.Literal('ledger.indicator-definition.1'),
    id: Type.String({ pattern: ObservationTypeIdPattern, maxLength: 100 }),
    version: Version,
    title: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.String({ minLength: 1, maxLength: 4000 }),
    scope: IndicatorScopeSchema,
    events: IndicatorEventsSchema,
    exposure: Type.Object(
      {
        kind: ObservationTypeIdSchema,
        version: Version,
        definitionDigest: Digest,
        params: Type.Record(Type.String(), Type.Unknown()),
      },
      { ...Closed, description: 'What the count is divided by: a registered exposure kind, pinned by digest.' },
    ),
    window: Type.Object(
      { maxMilliseconds: Type.Integer({ minimum: 1, maximum: INDICATOR_LIMITS.maxWindowMilliseconds }) },
      { ...Closed, description: 'The longest half-open UTC window one calculation may cover.' },
    ),
    completeness: Type.Object(
      {
        exposureMustExceed: Type.String({
          pattern: IndicatorDecimalPattern,
          description: 'A rate is stated only when exposure is greater than this, in the exposure kind’s unit.',
        }),
        populationDeclaredComplete: Type.Boolean({
          description: 'The population of subjects must be declared complete for the window by a person or source.',
        }),
        coverageWithoutGaps: Type.Boolean({
          description:
            'The observations the exposure relies on must show no gaps, where the exposure kind can tell; for example a takeoff with no reported landing.',
        }),
      },
      Closed,
    ),
    unit: Type.Object(
      {
        per: Type.Integer({ minimum: 1, maximum: INDICATOR_LIMITS.maxPer }),
        label: Type.String({ minLength: 1, maxLength: 100 }),
        fractionDigits: Type.Integer({ minimum: 0, maximum: INDICATOR_LIMITS.maxFractionDigits }),
      },
      {
        ...Closed,
        description:
          'The rate is events times per divided by exposure, for example per 100 flights. Decimal forms are rounded half up to fractionDigits; the exact fraction is always kept.',
      },
    ),
  },
  {
    ...Closed,
    description:
      'An indicator definition: which events are counted, within which subjects, divided by which exposure, over a bounded window, and what completeness a stated rate needs. A published id and version is never changed.',
  },
);
export type IndicatorDefinitionContent = Static<typeof IndicatorDefinitionContentSchema>;

export const IndicatorDefinitionSchema = Type.Object(
  {
    ...IndicatorDefinitionContentSchema.properties,
    digest: Type.String({ pattern: '^[a-f0-9]{64}$', description: 'Canonical digest of every other field.' }),
  },
  Closed,
);
export type IndicatorDefinition = Static<typeof IndicatorDefinitionSchema>;

export const IndicatorPopulationSchema = Type.Object(
  {
    subjects: Type.Array(SubjectReferenceSchema, { maxItems: INDICATOR_LIMITS.maxSubjects }),
    complete: Type.Boolean(),
    declaredBy: Type.Union([
      Type.Object({ kind: literals(['person', 'source', 'definition']), id: Id }, Closed),
      Type.Null(),
    ]),
  },
  {
    ...Closed,
    description:
      'The subjects in scope for the window and who declared the list complete. For a subjects scope it is the listed subjects, declared by the definition.',
  },
);
export type IndicatorPopulation = Static<typeof IndicatorPopulationSchema>;

const Note = Type.Object(
  {
    code: Type.String({ minLength: 1, maxLength: 100 }),
    subjectKey: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
    observationIds: Type.Array(Id),
  },
  Closed,
);

export const indicatorStatusValues = ['supported', 'insufficient', 'conflicting'] as const;
export type IndicatorStatus = (typeof indicatorStatusValues)[number];

export const IndicatorResultSchema = Type.Object(
  {
    version: Type.Literal('ledger.indicator-result.1'),
    definition: Type.Object({ id: Id, version: Version, digest: Digest }, Closed),
    exposureKind: Type.Object({ id: Id, version: Version, digest: Digest }, Closed),
    control: Type.Union([Type.Object({ id: Id, version: Version }, Closed), Type.Null()]),
    window: Type.Object({ start: Time, end: Time }, Closed),
    recordedThrough: Time,
    status: literals(indicatorStatusValues),
    eventCount: Type.Integer({ minimum: 0 }),
    exposure: Type.Object(
      {
        value: IndicatorRationalSchema,
        decimal: Decimal,
        unit: Type.String({ minLength: 1, maxLength: 100 }),
        coverage: literals(['checked', 'not_determinable']),
        gaps: Type.Array(Note),
        conflicts: Type.Array(Note),
      },
      Closed,
    ),
    rate: Type.Union([
      Type.Object(
        {
          value: IndicatorRationalSchema,
          decimal: Type.String({ pattern: '^(0|[1-9][0-9]*)(\\.[0-9]{1,12})?$' }),
          per: Type.Integer({ minimum: 1 }),
          label: Type.String({ minLength: 1, maxLength: 100 }),
        },
        Closed,
      ),
      Type.Null(),
    ]),
    reasons: Type.Array(Type.String({ minLength: 1, maxLength: 100 })),
    limitations: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 100 }), {
        description:
          'What the result could not take into account, without changing its status. evaluations_recorded_after_cut: the rule evaluated a subject in the population after the evidence cut; a calculation at a later cut may differ.',
      }),
    ),
    eventsPlacedBy: Type.Optional(
      Type.Array(literals(['issue', 'evaluation']), {
        description:
          'For counted issues: issue when the rule’s check kind said when each happened, evaluation when an issue was placed at the time of the evaluation that first named it.',
      }),
    ),
    population: Type.Object(
      {
        subjectCount: Type.Integer({ minimum: 0 }),
        digest: Digest,
        complete: Type.Boolean(),
        declaredBy: IndicatorPopulationSchema.properties.declaredBy,
      },
      Closed,
    ),
    counted: Type.Object({ events: Type.Array(Id), exposure: Type.Array(Id) }, Closed),
    inputDigest: Digest,
  },
  {
    ...Closed,
    description:
      'One indicator calculation. status says what the evidence supports: supported states a rate, insufficient and conflicting state none and give reasons. It is evidence for a person to review, never a verdict on the control.',
  },
);
export type IndicatorResult = Static<typeof IndicatorResultSchema>;

const Sentence = Type.String({ minLength: 1, maxLength: 4000 });
const Explained = Type.Object(
  {
    code: Type.String({ minLength: 1, maxLength: 100 }),
    sentence: Type.Union([Sentence, Type.Null()], {
      description: 'The code in a plain sentence, or null when no current definition words it.',
    }),
  },
  Closed,
);
const ExplainedNotes = Type.Array(
  Type.Object({ ...Explained.properties, count: Type.Integer({ minimum: 1 }) }, Closed),
  { description: 'One entry per distinct code, with how many notes carry it; the sentence already says how many.' },
);

export const IndicatorResultWordingSchema = Type.Object(
  {
    title: Type.Union([Sentence, Type.Null()]),
    description: Type.Union([Sentence, Type.Null()]),
    rate: Type.Union([Sentence, Type.Null()]),
    events: Sentence,
    exposure: Sentence,
    population: Sentence,
    reasons: Type.Array(Explained),
    limitations: Type.Array(Explained),
    gaps: ExplainedNotes,
    conflicts: ExplainedNotes,
  },
  {
    ...Closed,
    description:
      'A result in plain words for people, supplied when it is read: the title and description from the indicator definition, gaps and conflicts from the exposure kind, reasons and limitations from the calculation, and who declared the population by name. Worded from the definitions registered now, so an older result reads the same way; a code no current definition words has a null sentence. Programs read the codes in the result.',
  },
);
export type IndicatorResultWording = Static<typeof IndicatorResultWordingSchema>;
