import { Type, type SchemaOptions, type Static, type TLiteral } from '@sinclair/typebox';
import {
  ObservationTypeIdPattern,
  ObservationTypeIdSchema,
  ObservationVersionSchema,
  observationSubjectKindValues,
} from './observations/envelope.js';

const Identifier = Type.String({ minLength: 1, maxLength: 200 });
const Version = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const Digest = Type.String({ pattern: '^[a-f0-9]{64}$' });
const Closed = { additionalProperties: false } as const;
const literals = <const Values extends readonly string[]>(values: Values, options: SchemaOptions = {}) =>
  Type.Union(values.map((value) => Type.Literal(value)) as TLiteral<Values[number]>[], options);

/** A name a rule gives to one of its inputs, parameters or conditions. */
export const RuleNamePattern = '^[a-z][a-zA-Z0-9]{0,63}$';
const RuleName = Type.String({ pattern: RuleNamePattern });
/** A dot-separated path into an accepted observation object, such as values.totalRemainingPercent. */
export const ObservationFieldPathPattern = '^[a-zA-Z][a-zA-Z0-9]*(\\.[a-zA-Z][a-zA-Z0-9]*){0,9}$';
const FieldPath = Type.String({ pattern: ObservationFieldPathPattern, maxLength: 400 });
// One schema with a list of types, not a union: request validation coerces values into the first union branch that
// accepts them, and a list of types leaves a value of any listed type as it is.
const ScalarValue = Type.Unsafe<string | number | boolean>({ type: ['string', 'number', 'boolean'], maxLength: 1000 });

export const checkedRuleSubjectKindValues = observationSubjectKindValues;
export type CheckedRuleSubjectKind = (typeof checkedRuleSubjectKindValues)[number];

export const RuleReadConditionSchema = Type.Union(
  [
    Type.Object({ field: FieldPath, oneOf: Type.Array(ScalarValue, { minItems: 1, maxItems: 50 }) }, Closed),
    Type.Object({ field: FieldPath, filled: Type.Literal(true) }, Closed),
  ],
  {
    description:
      'oneOf: the field equals one of the values, or, when it holds a list, the list holds one of them. filled: the field holds a value; absent, null and blank text are not filled, false is.',
  },
);
export type RuleReadCondition = Static<typeof RuleReadConditionSchema>;

/** Related subjects one evaluation evaluates at most; more is reported, never evaluated in part. */
export const RELATED_SUBJECT_LIMIT = 50;

/** What a read is about: the evaluated subject, its organization, a related subject, or a referencing field. */
export const RuleReadAboutSchema = Type.Union(
  [
    literals(['target', 'organization']),
    Type.Object(
      { related: RuleName, referencing: Type.Optional(FieldPath) },
      {
        ...Closed,
        description:
          'Observations about the related subject of this name, matched as target matches; with referencing, the observations whose reference field at that path names the related subject instead, about any subject (such as every flight a pilot is assigned to).',
      },
    ),
    Type.Object(
      { referencing: FieldPath },
      { ...Closed, description: 'Observations whose reference field at this path names the evaluated subject.' },
    ),
    Type.Object(
      { sameSessionAs: RuleName },
      {
        ...Closed,
        description:
          'Observations with a source event id that the same source reported in the same capture session as an observation of this earlier read about the evaluated subject, about any subject.',
      },
    ),
  ],
  {
    description:
      'target: observations naming the evaluated subject as their subject or secondary subject. organization: observations about the organization the subject belongs to. related: observations about a related subject the leaf declares, or with referencing those whose reference field names it. referencing: observations whose reference field names the evaluated subject. sameSessionAs: observations reported in the capture sessions of an earlier read, about any subject.',
  },
);
export type RuleReadAbout = Static<typeof RuleReadAboutSchema>;

export const RuleReadSchema = Type.Object(
  {
    name: RuleName,
    type: ObservationTypeIdSchema,
    versions: Type.Array(ObservationVersionSchema, { minItems: 1, maxItems: 20, uniqueItems: true }),
    about: RuleReadAboutSchema,
    required: Type.Boolean({
      description: 'A required input with no observation makes the evaluation insufficient without running the check.',
    }),
    select: Type.Union(
      [
        literals(['latest', 'all']),
        Type.Object(
          {
            latestAtOrBefore: Type.Object(
              {
                read: RuleName,
                field: FieldPath,
              },
              {
                ...Closed,
                description:
                  'An earlier read, or the subject-state read, and the field of its latest observation that holds the instant. Without one valid instant the read is empty.',
              },
            ),
          },
          Closed,
        ),
        Type.Object(
          {
            within: Type.Object(
              { read: RuleName, startField: FieldPath, endField: FieldPath },
              {
                ...Closed,
                description:
                  'An earlier read, or the subject-state read, and the fields of its latest observation that hold the start and end of the window. Without one valid start the read is empty; without an end it reads up to the evaluation time.',
              },
            ),
          },
          Closed,
        ),
      ],
      {
        description:
          'latest: the observations sharing the newest span start. all: every observation up to the page limit, newest first. latestAtOrBefore: the observations sharing the newest span start at or before an instant another read records. within: every observation whose span start lies in a window another read records, from its start to its end, up to the page limit, newest first.',
      },
    ),
    where: Type.Optional(
      Type.Array(RuleReadConditionSchema, {
        minItems: 1,
        maxItems: 10,
        description:
          'Only observations meeting every condition are read, before required, select, applicability and the page limit apply.',
      }),
    ),
    plans: Type.Optional(
      Type.Literal(true, {
        description:
          'The read reads plans: records about a time that has not come (their span starts after the evaluation instant) are read as soon as they are recorded. Absent: a record is read once its span has started.',
      }),
    ),
    onFile: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 100,
        description:
          'What a person calls the record this required read takes, such as "remote pilot certificate". When every required read that is empty names one, the result is insufficient with reason record_not_on_file and says "No … on file."',
      }),
    ),
  },
  Closed,
);
export type RuleRead = Static<typeof RuleReadSchema>;

/** The reason of an evaluation that found no record a rule requires; its summary names each record not on file. */
export const RECORD_NOT_ON_FILE = 'record_not_on_file';

/**
 * The reason of an evaluation whose required reads are empty only because the records that match them are about a
 * time that has not come; its summary says from when the rule reads each one.
 */
export const RECORD_FOR_LATER_TIME = 'record_for_later_time';

/** Members one adoption queues and one coverage read counts for one rule; more is reported as incomplete. */
export const POPULATION_LIMIT = 2000;

export const RulePopulationSchema = Type.Union(
  [
    Type.Object(
      { of: Type.Literal('on_record') },
      {
        ...Closed,
        description:
          'Every subject of the target kind the organization has on record: a Ledger subject of the kind, or a subject a current observation names as its subject, secondary subject or in a reference field.',
      },
    ),
    Type.Object(
      {
        of: Type.Literal('designated'),
        by: Type.Object(
          {
            type: ObservationTypeIdSchema,
            versions: Type.Array(ObservationVersionSchema, { minItems: 1, maxItems: 20, uniqueItems: true }),
            where: Type.Optional(Type.Array(RuleReadConditionSchema, { minItems: 1, maxItems: 10 })),
            field: Type.Union([literals(['subject', 'secondarySubject']), FieldPath], {
              description:
                'subject or secondarySubject: that role, as currently resolved. Any other path: a reference field, as written.',
            }),
          },
          Closed,
        ),
      },
      {
        ...Closed,
        description:
          'The subjects of the target kind that current observations of this type, meeting the conditions, name at the field: for example the people role records name as remote pilots, or the aircraft a fleet record lists.',
      },
    ),
    Type.Object(
      { of: Type.Literal('in_adoption_dates') },
      {
        ...Closed,
        description:
          'The subjects of the target kind named by a current observation whose time overlaps the adoption’s effective interval, such as the flights flown while the pack is adopted.',
      },
    ),
  ],
  {
    description:
      'Who the rule is meant for: each member is evaluated when the pack is adopted, revised or succeeded, and when it joins, whether or not a record the rule reads exists about it. Absent: the rule is evaluated for the subjects whose records it reads.',
  },
);
export type RulePopulation = Static<typeof RulePopulationSchema>;

/** A subject named by an earlier read, or by the subject-state read, of the same leaf. */
export const RuleRelatedSubjectSchema = Type.Object(
  {
    name: RuleName,
    subjectKind: literals(checkedRuleSubjectKindValues),
    from: Type.Object(
      {
        read: RuleName,
        field: Type.Union([literals(['subject', 'secondarySubject']), FieldPath], {
          description:
            'subject or secondarySubject: that role of each observation, as currently resolved. Any other path: a reference field ({ id, scope }) in each observation, resolved through alias resolutions inside the evidence cut.',
        }),
      },
      Closed,
    ),
    fanOut: Type.Boolean({
      description:
        'true: one result per distinct related subject. false: the read must name exactly one; two or more is conflicting.',
    }),
    whenNone: literals(['insufficient', 'not_applicable', 'empty'], {
      description:
        'The result for the evaluated subject when the read names no related subject. empty (not with fanOut): the reads about it are empty and the check runs, for reads that only add to what the evaluated subject’s own records show.',
    }),
    whenNoneSummary: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 500,
        description:
          'The summary recorded when the read names no related subject, in place of the engine’s own sentence naming the read, such as "No dock or ground station is named on the flight plan."',
      }),
    ),
    requeue: Type.Optional(
      Type.Object(
        {
          windowEnd: Type.Object(
            { read: RuleName, field: FieldPath },
            {
              ...Closed,
              description:
                'A read about the evaluated subject, or the subject-state read, and the field of its latest observation that holds when the evaluated subject’s window ends.',
            },
          ),
          endedWithinDays: Type.Optional(
            Type.Integer({
              minimum: 0,
              maximum: 3650,
              description: 'Also re-queue a subject whose window ended at most this many days ago. Absent: 0.',
            }),
          ),
        },
        {
          ...Closed,
          description:
            'Which evaluated subjects are still worth evaluating again when a record about this related subject changes: those whose window has not ended, or ended within endedWithinDays. A subject with no recorded end is queued. A skipped subject keeps its last evaluation; the queueing work for the event records how many it skipped. Absent: every subject that names it is queued.',
        },
      ),
    ),
  },
  { ...Closed, description: 'A subject the evaluated subject’s records name, which reads may be about.' },
);
export type RuleRelatedSubject = Static<typeof RuleRelatedSubjectSchema>;

export const RuleAdoptionParameterSchema = Type.Object(
  {
    name: RuleName,
    title: Type.String({ minLength: 1, maxLength: 200 }),
    valueType: literals(['number', 'integer', 'string', 'boolean']),
    minimum: Type.Optional(Type.Number()),
    maximum: Type.Optional(Type.Number()),
    options: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 1, maxItems: 100 })),
  },
  { ...Closed, description: 'A value the adopting organization must supply, passed to the check under this name.' },
);
export type RuleAdoptionParameter = Static<typeof RuleAdoptionParameterSchema>;

export const RuleApplicabilityConditionSchema = Type.Object(
  {
    input: RuleName,
    field: FieldPath,
    oneOf: Type.Array(ScalarValue, { minItems: 1, maxItems: 50 }),
    whenAbsent: literals(['not_applicable', 'insufficient', 'applies'], {
      description:
        'When no observation of the input is on record: the rule does not apply, is insufficient, or applies (for a rule that reads either a source’s report or the operator’s own record).',
    }),
    notMetSummary: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 500,
        description:
          'The summary recorded when the field holds none of the values, in place of the engine’s own sentence naming the field.',
      }),
    ),
  },
  {
    ...Closed,
    description:
      'The rule applies only when the field of the latest observation of this input equals one of the values. The engine evaluates it; the check never sees an inapplicable subject. When the input is a required read that names the record it takes (onFile) and none is on file, the result says that record is not on file.',
  },
);
export type RuleApplicabilityCondition = Static<typeof RuleApplicabilityConditionSchema>;

export const CheckParametersSchema = Type.Record(Type.String({ pattern: RuleNamePattern }), Type.Unknown(), {
  description: 'Fixed parameters for the check kind. Adoption parameters are added under their own names.',
});

export const CheckReferenceSchema = Type.Object(
  {
    kind: Type.String({ pattern: ObservationTypeIdPattern, maxLength: 100 }),
    version: Version,
    definitionDigest: Digest,
    params: CheckParametersSchema,
  },
  Closed,
);
export type CheckReference = Static<typeof CheckReferenceSchema>;

export const RuleSubjectStateReadSchema = Type.Object(
  {
    name: RuleName,
    required: Type.Boolean({
      description: 'A required state that Ledger does not hold makes the evaluation insufficient.',
    }),
  },
  {
    ...Closed,
    description:
      'Reads what Ledger holds about the evaluated subject itself, such as a flight’s status and declared times. It reaches the check as one observation under this name, and its revision is part of the input digest.',
  },
);
export type RuleSubjectStateRead = Static<typeof RuleSubjectStateReadSchema>;

/** A {name} placeholder in rule wording, naming one of the check kind's declared details. */
export const RuleWordingPlaceholderPattern = '\\{([a-z][a-zA-Z0-9]{0,63})\\}';
const WordingTemplate = Type.String({ minLength: 1, maxLength: 1000 });
export const RuleWordingSchema = Type.Object(
  {
    pass: Type.Optional(WordingTemplate),
    attention: Type.Optional(WordingTemplate),
    pending: Type.Optional(WordingTemplate),
    not_applicable: Type.Optional(WordingTemplate),
  },
  {
    ...Closed,
    description:
      'The rule’s own summary for a result the check returns, keyed by outcome. Placeholders such as {dueAt} are filled only from the check result’s details; when one is not returned the check’s own summary is used. Wording never changes the result.',
  },
);
export type RuleWording = Static<typeof RuleWordingSchema>;

/** A quoted paragraph of a retained original document, pinned by byte span into that document and by digest. */
export const RetainedDocumentSourceSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal('proposed_regulation', { description: 'Proposed regulatory text, not in force.' }),
      Type.Literal('regulation', {
        description: 'Regulatory text in force on the edition date the pack states for the retained document.',
      }),
    ]),
    reference: Identifier,
    text: Type.String(),
    encoding: Type.Literal('utf-8'),
    byteLength: Type.Integer({ minimum: 0 }),
    sha256: Digest,
    textSpan: Type.Object(
      {
        start: Type.Integer({ minimum: 0 }),
        end: Type.Integer({ minimum: 0 }),
        unit: Type.Literal('utf8_byte'),
        sourceId: Identifier,
      },
      { additionalProperties: false, description: 'Zero-based half-open byte offsets into the retained document.' },
    ),
    document: Type.Object(
      {
        sourceId: Identifier,
        url: Type.String(),
        sha256: Digest,
        byteLength: Type.Integer({ minimum: 1 }),
        contentType: Type.Union([
          Type.Literal('text/html; charset=utf-8'),
          Type.Literal('application/xml; charset=utf-8'),
        ]),
        readPath: Type.String(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type RetainedDocumentSource = Static<typeof RetainedDocumentSourceSchema>;

/** True for a source quoted from a retained original document rather than carried whole in the rule. */
export function isRetainedDocumentSource(source: { kind: string }): source is RetainedDocumentSource {
  return 'document' in source;
}

export const ProcedureSourceSchema = Type.Object(
  {
    kind: Type.Union(
      [
        Type.Literal('operator_procedure', { description: 'An operator procedure.' }),
        Type.Literal('waiver_or_exemption', {
          description:
            'A waiver or exemption the organization holds. Only a rule quoting one may relieve another rule.',
        }),
      ],
      {
        description: 'Text the rule carries whole. A quoted paragraph of a retained document is the other variant.',
      },
    ),
    reference: Identifier,
    text: Type.String(),
    encoding: Type.Literal('utf-8'),
    byteLength: Type.Integer({ minimum: 0 }),
    sha256: Digest,
    textSpan: Type.Object(
      {
        start: Type.Integer({ minimum: 0 }),
        end: Type.Integer({ minimum: 0 }),
        unit: Type.Literal('utf8_byte'),
      },
      { ...Closed, description: 'Zero-based half-open byte offsets into this source text.' },
    ),
  },
  Closed,
);

/** The id of a section of a rule pack version, as its sections list declares it. */
export const RuleSectionIdSchema = Type.String({
  pattern: '^[a-z0-9]+([.-][a-z0-9]+)*$',
  maxLength: 100,
  description: 'The id of the section of the pack version the rule belongs to, one its sections list declares.',
});
/** The paragraph a rule reads, as a reader cites it. */
export const RuleParagraphSchema = Type.String({
  minLength: 1,
  maxLength: 100,
  description: 'The paragraph the rule reads, as a reader cites it, such as “§ 108.40(a)(3)(i)” or “Provision 3”.',
});

/** Rules of another pack that a waiver or exemption provision relieves while it is adopted in active mode. */
export const RuleReliefSchema = Type.Object(
  {
    packId: Identifier,
    ruleIds: Type.Array(Identifier, { minItems: 1, maxItems: 50, uniqueItems: true }),
  },
  {
    ...Closed,
    description:
      'The pack and the ids of its checked rules this provision relieves. The registry refuses a relief of the rule’s own pack, of an unregistered pack or of a rule id no registered version of that pack holds.',
  },
);
export type RuleRelief = Static<typeof RuleReliefSchema>;

/** When a rule stops waiting for a record: a time on record, such as a flight's landing, and the time allowed after it. */
export const RuleWaitEndSchema = Type.Object(
  {
    read: RuleName,
    field: FieldPath,
    afterHours: Type.Integer({ minimum: 1, maximum: 8784 }),
    describes: Type.String({
      minLength: 1,
      maxLength: 200,
      description: 'What the time is, in words that follow "after", such as "the flight landed".',
    }),
    onFile: Type.String({
      minLength: 1,
      maxLength: 200,
      description:
        'What a person calls the record waited for, such as "preflight assessment stating the distance below cloud".',
    }),
  },
  {
    ...Closed,
    description:
      'A result that waits for a record (pending, for any reason but record_not_on_file) stops waiting once the latest time in field of read, plus afterHours, has passed: it becomes record_not_on_file and says which record and since when. Until then that instant is a boundary at which the rule is evaluated again.',
  },
);
export type RuleWaitEnd = Static<typeof RuleWaitEndSchema>;

export const CheckedRuleLeafSchema = Type.Object(
  {
    id: Identifier,
    version: Version,
    title: Identifier,
    source: Type.Union([ProcedureSourceSchema, RetainedDocumentSourceSchema]),
    review: Type.Literal('ai_drafted'),
    adopted: Type.Literal(false),
    coverage: Type.Literal('automated'),
    target: Type.Object({ subjectKind: literals(checkedRuleSubjectKindValues) }, Closed),
    reads: Type.Array(RuleReadSchema, { minItems: 1, maxItems: 20 }),
    check: CheckReferenceSchema,
    adoptionParameters: Type.Array(RuleAdoptionParameterSchema, { maxItems: 20 }),
    applicability: Type.Array(RuleApplicabilityConditionSchema, { maxItems: 10 }),
    subjectState: Type.Optional(RuleSubjectStateReadSchema),
    wording: Type.Optional(RuleWordingSchema),
    related: Type.Optional(
      Type.Array(RuleRelatedSubjectSchema, {
        minItems: 1,
        maxItems: 2,
        description:
          'Subjects the evaluated subject’s records name. At most one fans out: the rule then gives one result per related subject.',
      }),
    ),
    relieves: Type.Optional(
      Type.Array(RuleReliefSchema, {
        minItems: 1,
        maxItems: 10,
        uniqueItems: true,
        description:
          'Rules of other packs this provision relieves. Only a rule whose source is a waiver or exemption may declare it. While an adoption of this pack in active mode is in effect, an evaluation of a relieved rule is recorded as relieved; in shadow, as what it would relieve.',
      }),
    ),
    population: Type.Optional(RulePopulationSchema),
    waitEnds: Type.Optional(RuleWaitEndSchema),
    section: Type.Optional(RuleSectionIdSchema),
    paragraph: Type.Optional(RuleParagraphSchema),
    digest: Digest,
  },
  {
    ...Closed,
    description:
      'A rule as data: a pinned source text, the subject kind it is evaluated for, the observations it reads and a versioned check kind with parameters. The generic evaluator runs it.',
  },
);
export type CheckedRuleLeaf = Static<typeof CheckedRuleLeafSchema>;

/** True for a rule leaf the generic evaluator runs. */
export function isCheckedRuleLeaf(leaf: { coverage: string }): leaf is CheckedRuleLeaf {
  return 'check' in leaf && 'reads' in leaf;
}

export const AdoptionParameterValueSchema = ScalarValue;
export const AdoptionParameterValuesSchema = Type.Record(
  Identifier,
  Type.Record(Type.String({ pattern: RuleNamePattern }), ScalarValue),
  {
    description:
      'Values the organization sets on adoption, keyed by leaf id and then by the parameter names the leaf declares.',
  },
);
export type AdoptionParameterValues = Static<typeof AdoptionParameterValuesSchema>;
