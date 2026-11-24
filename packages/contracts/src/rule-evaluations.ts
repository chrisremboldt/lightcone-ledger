import { Type, type SchemaOptions, type Static, type TLiteral } from '@sinclair/typebox';
import { ObservationFieldPathPattern, RuleNamePattern, RuleReadAboutSchema } from './checked-rules.js';
import { InputCutSchema } from './input-cut.js';
import {
  ObservationTypeIdSchema,
  ObservationVersionSchema,
  observationSubjectKindValues,
  observationSubjectScopeValues,
} from './observations/envelope.js';

const Id = Type.String({ minLength: 1, maxLength: 200 });
const Version = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const Digest = Type.String({ pattern: '^[a-f0-9]{64}$' });
const Time = Type.String({ format: 'date-time' });
const Closed = { additionalProperties: false } as const;
const literals = <const Values extends readonly string[]>(values: Values, options: SchemaOptions = {}) =>
  Type.Union(values.map((value) => Type.Literal(value)) as TLiteral<Values[number]>[], options);

/**
 * What an evaluation is about: a Ledger subject, or a subject a source names by its own id that Ledger has not
 * resolved. No Ledger subject row is created for a source identity.
 */
export const SubjectReferenceSchema = Type.Object(
  {
    scope: literals(observationSubjectScopeValues),
    kind: literals(observationSubjectKindValues),
    id: Id,
    sourceId: Type.Optional(Id),
  },
  { ...Closed, description: 'sourceId is present exactly when scope is source.' },
);
export type SubjectReference = Static<typeof SubjectReferenceSchema>;

/** One unambiguous string for a subject reference: ledger/<kind>/<id> or source/<sourceId>/<kind>/<id>, each part URI-encoded. */
export function subjectReferenceKey(subject: SubjectReference): string {
  const id = encodeURIComponent(subject.id);
  if (subject.scope === 'ledger') return `ledger/${subject.kind}/${id}`;
  if (!subject.sourceId) throw new TypeError('A source-scoped subject reference needs its sourceId');
  return `source/${encodeURIComponent(subject.sourceId)}/${subject.kind}/${id}`;
}

/** A subject reference with the name a person knows the subject by, as reads show it. */
export const NamedSubjectSchema = Type.Object(
  { ...SubjectReferenceSchema.properties, name: Type.String({ minLength: 1, maxLength: 1000 }) },
  {
    ...Closed,
    description:
      'name: the Ledger subject’s label; for a subject a source names by its own id, the name the latest current record of a naming type under that source gives it (a person’s personnel file, an aircraft’s identity, a flight’s plan), else that id. sourceId is present exactly when scope is source.',
  },
);
export type NamedSubject = Static<typeof NamedSubjectSchema>;

/**
 * Beside the evaluations a read returns, never inside them, so a record and its digest stay exactly as recorded: for
 * each evaluation id, the subject each of its inputs was about, in input order. That is the subject recorded with
 * the input when there is one; otherwise the one subject its observations are about, taking the subject the read was
 * about wherever an observation names it; otherwise the subject the read was about.
 */
export const EvaluationInputSubjectsSchema = Type.Record(Type.String(), Type.Array(NamedSubjectSchema), {
  description:
    'For each evaluation id, the subject each input was about, in input order, with the name a person knows it by. Read now; never recorded or digested.',
});
export type EvaluationInputSubjects = Static<typeof EvaluationInputSubjectsSchema>;

/**
 * Beside the evaluations a read returns, never inside them: for each evaluation id whose summary the rule's own
 * wording gave, that wording with its {name} placeholders, so a screen can fill it again from the recorded details
 * in a person's terms. Present only when the pinned rule is registered here and filling it from the recorded
 * details gives the recorded summary exactly.
 */
export const EvaluationSummaryWordingSchema = Type.Record(
  Type.String(),
  Type.String({ minLength: 1, maxLength: 1000 }),
  {
    description:
      'For each evaluation id whose recorded summary is wording filled from its details, that wording: the rule’s own, or the check kind’s own summary with the values it names marked as placeholders. Read now; never recorded or digested.',
  },
);
export type EvaluationSummaryWording = Static<typeof EvaluationSummaryWordingSchema>;

const RuleName = Type.String({ pattern: RuleNamePattern });
const FieldPath = Type.String({ pattern: ObservationFieldPathPattern, maxLength: 400 });

/** The related subject a result or finding is about, beside the evaluated subject it belongs to. */
export const RelatedSubjectSchema = Type.Object(
  { name: RuleName, subject: SubjectReferenceSchema, subjectKey: Type.String({ minLength: 1, maxLength: 1000 }) },
  { ...Closed, description: 'name is the leaf’s name for the relation; subject is the related subject as resolved.' },
);
export type RelatedSubject = Static<typeof RelatedSubjectSchema>;

/** Added to an evaluation record when the result is for one related subject. */
export const RelatedSubjectResultSchema = Type.Object(
  {
    ...RelatedSubjectSchema.properties,
    namedBy: Type.Array(Type.Object({ observationId: Id, field: FieldPath }, Closed), {
      maxItems: 500,
      description:
        'The observations whose reference named the related subject. Empty when the subject is no longer named.',
    }),
  },
  {
    ...Closed,
    description: 'The related subject this result is for and the observations whose reference named it.',
  },
);
export type RelatedSubjectResult = Static<typeof RelatedSubjectResultSchema>;

export const evidenceStateValues = ['supported', 'insufficient', 'conflicting', 'not_applicable'] as const;
/** relieved: an active waiver adoption relieves the rule; the check's own answer is kept under relief.otherwise. */
export const evaluationOutcomeValues = ['pass', 'attention', 'pending', 'not_applicable', 'relieved'] as const;

const ObservationEvidenceSchema = Type.Object(
  {
    observationId: Id,
    eventId: Id,
    receiptId: Id,
    sourceId: Id,
    type: ObservationTypeIdSchema,
    version: ObservationVersionSchema,
    occurredAt: Time,
  },
  Closed,
);

/** When one issue a check named happened, as the check kind can tell from the evidence. */
export const IssueTimeSchema = Type.Object(
  {
    issue: Type.String({ minLength: 1, maxLength: 1000 }),
    start: Time,
    end: Type.Optional(Time),
    endUnknown: Type.Optional(Type.Literal(true)),
  },
  {
    ...Closed,
    description:
      'start: when the issue began. end: when it ended, absent while it continues. endUnknown: the evidence cannot tell whether or when it ended.',
  },
);
export type IssueTime = Static<typeof IssueTimeSchema>;

/** Structured values a check returns with its result, such as a computed deadline, for screens and later steps. */
export const CheckDetailsSchema = Type.Record(
  Type.String({ pattern: '^[a-z][a-zA-Z0-9]{0,63}$' }),
  Type.Unsafe<string | number | boolean | null>({ type: ['string', 'number', 'boolean', 'null'], maxLength: 1000 }),
  { description: 'Named values the check kind declares, each a string, number, boolean or null.' },
);
export type CheckDetails = Static<typeof CheckDetailsSchema>;

/**
 * The fields of an evaluation record, besides its details, that a check kind's own summary may state word for word
 * and a screen may show in a person's terms: the next boundary, and the time of each observation it relied on.
 */
export const summaryRecordSources = ['nextBoundary', 'evidenceOccurredAt'] as const;
export type SummaryRecordSource = (typeof summaryRecordSources)[number];

/** The placeholder name of the time of the observation cited at this position in the evidence. */
export function evidenceOccurredAtName(index: number): string {
  return `evidence${index}OccurredAt`;
}

/**
 * The values wording may be filled from: the recorded details, then the recorded next boundary and evidence times
 * under their own placeholder names. Read from the record; nothing is recorded or digested.
 */
export function summaryRecordValues(record: {
  details?: CheckDetails;
  nextBoundary?: string;
  evidence: readonly { occurredAt: string }[];
}): CheckDetails {
  return {
    ...(record.details ?? {}),
    ...(record.nextBoundary ? { nextBoundary: record.nextBoundary } : {}),
    ...Object.fromEntries(record.evidence.map((item, index) => [evidenceOccurredAtName(index), item.occurredAt])),
  };
}

/** What Ledger holds about a subject, as rules read it: a few generic facts, each a string, number, boolean or null. */
export const SubjectStateContentSchema = Type.Record(
  Type.String({ pattern: '^[a-z][a-zA-Z0-9]{0,63}$' }),
  Type.Unsafe<string | number | boolean | null>({ type: ['string', 'number', 'boolean', 'null'], maxLength: 1000 }),
  { maxProperties: 50 },
);
export type SubjectStateContent = Static<typeof SubjectStateContentSchema>;

/** The records an evaluation read as plans: about a time that had not come when it ran. */
export const ReadAsPlansSchema = Type.Object(
  {
    from: Time,
    observationIds: Type.Array(Id, { minItems: 1, maxItems: 500 }),
  },
  {
    ...Closed,
    description:
      'Present when a read that declares plans took records whose span started after the evaluation instant: those records, and from, the earliest of their starts. The evaluation read them as plans.',
  },
);
export type ReadAsPlans = Static<typeof ReadAsPlansSchema>;

/** The waiver adoption and provision that relieve an evaluated rule, or would in shadow. */
export const EvaluationReliefSchema = Type.Object(
  {
    mode: literals(['active', 'shadow'], {
      description:
        'The waiver adoption’s mode. active: the evaluation is recorded as relieved, unless coverage says the provision does not cover the subject. shadow: recorded as what the waiver would relieve; the rule’s own answer stands and counts.',
    }),
    waiver: Type.Object(
      {
        adoptionId: Id,
        acceptedRevision: Type.Integer({ minimum: 1 }),
        effectiveInterval: Type.Object({ start: Time, end: Time }, Closed),
        pack: Type.Object({ id: Id, version: Version, digest: Digest, title: Id }, Closed),
        adoptedBy: Type.Object({ id: Id, name: Type.String({ maxLength: 1000 }) }, Closed),
      },
      { ...Closed, description: 'The adoption of the waiver in effect at the evaluated instant, and who adopted it.' },
    ),
    provision: Type.Object(
      {
        ruleId: Id,
        ruleVersion: Version,
        ruleDigest: Digest,
        title: Id,
        source: Type.Object({ kind: Id, reference: Id, text: Type.String(), sha256: Digest }, Closed),
      },
      { ...Closed, description: 'The waiver’s provision that declares the relief, with its quoted text.' },
    ),
    coverage: Type.Optional(
      Type.Object(
        {
          covered: Type.Boolean(),
          provisionResult: Type.Optional(
            Type.Object(
              {
                evaluationId: Id,
                outcome: literals(evaluationOutcomeValues),
                evidenceState: literals(evidenceStateValues),
                reasonCode: Type.String({ minLength: 1, maxLength: 100 }),
                summary: Type.String({ minLength: 1, maxLength: 2000 }),
              },
              {
                ...Closed,
                description:
                  'The provision’s latest result for this subject under the waiver adoption. Absent when its check has recorded none yet.',
              },
            ),
          ),
        },
        {
          ...Closed,
          description:
            'Present when the provision and the relieved rule are about the same kind of subject. The relief then applies to this subject only while the provision’s own latest result for it, under the waiver adoption, is supported (pass). covered false: the provision does not cover this subject; the rule’s own result stands and counts.',
        },
      ),
    ),
    otherwise: Type.Optional(
      Type.Object(
        {
          outcome: literals(['pass', 'attention', 'pending', 'not_applicable']),
          reasonCode: Type.String({ minLength: 1, maxLength: 100 }),
          summary: Type.String({ minLength: 1, maxLength: 2000 }),
          issues: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 500 })),
          issueTimes: Type.Optional(Type.Array(IssueTimeSchema, { maxItems: 500 })),
        },
        {
          ...Closed,
          description:
            'Present when the relief is active: what the relieved rule would otherwise have reported. Its evidence, details and evidence state stay on the record.',
        },
      ),
    ),
  },
  {
    ...Closed,
    description:
      'Relief a person granted by adopting a waiver. It changes what the result counts for, never what was observed.',
  },
);
export type EvaluationRelief = Static<typeof EvaluationReliefSchema>;

export const RuleEvaluationRecordSchema = Type.Object(
  {
    version: Type.Literal('ledger.rule-evaluation.1'),
    id: Id,
    subject: SubjectReferenceSchema,
    subjectKey: Type.String({ minLength: 1, maxLength: 1000 }),
    organizationId: Id,
    adoption: Type.Object(
      {
        id: Id,
        acceptedRevision: Type.Integer({ minimum: 1 }),
        effectiveInterval: Type.Object({ start: Time, end: Time }, Closed),
        mode: Type.Optional(
          literals(['shadow', 'active'], {
            description:
              'The mode of the adoption in effect when the evaluation ran. Absent on evaluations recorded before adoption modes existed; those ran under active adoptions.',
          }),
        ),
      },
      Closed,
    ),
    pack: Type.Object({ id: Id, version: Version, digest: Digest }, Closed),
    rule: Type.Object(
      {
        id: Id,
        version: Version,
        digest: Digest,
        title: Id,
        source: Type.Object({ kind: Id, reference: Id, text: Type.String(), sha256: Digest }, Closed),
      },
      Closed,
    ),
    check: Type.Object({ kind: Id, version: Version, definitionDigest: Digest }, Closed),
    parameters: Type.Record(Type.String(), Type.Unknown()),
    applicability: literals(['applicable', 'not_applicable']),
    evidenceState: literals(evidenceStateValues),
    outcome: literals(evaluationOutcomeValues),
    reasonCode: Type.String({ minLength: 1, maxLength: 100 }),
    summary: Type.String({ minLength: 1, maxLength: 2000 }),
    details: Type.Optional(CheckDetailsSchema),
    issues: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), {
        maxItems: 500,
        description:
          'Present when the check kind names what needs attention: the distinct things a person reviews. A resolved finding reopens only for an issue its resolving evaluation did not name.',
      }),
    ),
    issueTimes: Type.Optional(
      Type.Array(IssueTimeSchema, {
        maxItems: 500,
        description:
          'Present when the check kind says when each issue it names happened: one entry per named issue it could place.',
      }),
    ),
    evidence: Type.Array(ObservationEvidenceSchema, {
      description: 'The observations the result relied on.',
    }),
    inputs: Type.Array(
      Type.Object(
        {
          name: Id,
          type: ObservationTypeIdSchema,
          about: RuleReadAboutSchema,
          subject: Type.Optional(SubjectReferenceSchema),
          required: Type.Boolean(),
          observationIds: Type.Array(Id),
          truncated: Type.Boolean(),
          later: Type.Optional(
            Type.Object(
              { from: Time, observationIds: Type.Array(Id, { minItems: 1, maxItems: 1 }) },
              {
                ...Closed,
                description:
                  'Present when a required read that does not read plans came back empty while a record it would take is about a later time: the earliest such record, and from, when its span starts and the rule reads it.',
              },
            ),
          ),
        },
        Closed,
      ),
      {
        description:
          'Every declared input as gathered at the input cut. subject: the related subject a read about one was about.',
      },
    ),
    related: Type.Optional(RelatedSubjectResultSchema),
    relief: Type.Optional(EvaluationReliefSchema),
    readAsPlans: Type.Optional(ReadAsPlansSchema),
    subjectState: Type.Optional(
      Type.Object(
        {
          name: Id,
          kind: literals(observationSubjectKindValues),
          revision: Type.Union([Digest, Type.Null()]),
          state: Type.Union([SubjectStateContentSchema, Type.Null()]),
        },
        {
          ...Closed,
          description:
            'The subject state the rule read, as gathered: its content and revision (the digest of the content), or null for both when Ledger held none. The recorded content is the authority for what the evaluation read.',
        },
      ),
    ),
    clock: Type.Object(
      {
        mode: Type.Literal('wall'),
        evaluatedAt: Time,
        timeZone: Type.Optional(
          Type.String({
            minLength: 1,
            maxLength: 64,
            description: 'The organization’s IANA time zone, which the summary states its times in.',
          }),
        ),
      },
      Closed,
    ),
    nextBoundary: Type.Optional(Time),
    trigger: Type.Object(
      {
        kind: literals(['observation', 'deadline', 'state', 'correction', 'adoption'], {
          description:
            'state: a change of the subject’s own state; correction: a replaced, withdrawn or re-attached observation; adoption: a change of the adoption. Each names the event that caused it.',
        }),
        eventId: Type.Optional(Id),
        dueAt: Type.Optional(Time),
      },
      Closed,
    ),
    inputCut: InputCutSchema,
    dependencyBasis: Digest,
    observationDigest: Digest,
    inputDigest: Digest,
    recordedAt: Time,
  },
  {
    ...Closed,
    description:
      'One evaluation of one adopted rule for one subject. evidenceState says what the evidence supports and outcome what needs a person; neither is a verdict.',
  },
);
export type RuleEvaluationRecord = Static<typeof RuleEvaluationRecordSchema>;

/**
 * The plain words for a relief: "Relieved by <provision title>, <waiver pack title>, adopted by <person>". When the
 * provision does not cover the subject, they say so and what the provision's check last recorded.
 */
export function reliefStatement(relief: EvaluationRelief): string {
  const statement = `${relief.provision.title}, ${relief.waiver.pack.title}, adopted by ${relief.waiver.adoptedBy.name}`;
  if (relief.coverage && !relief.coverage.covered) {
    const result = relief.coverage.provisionResult;
    const recorded = result
      ? `The provision’s check last recorded: ${result.summary}`
      : 'The provision’s check has recorded no result for this subject yet.';
    return relief.mode === 'active'
      ? `${relief.waiver.pack.title}, adopted by ${relief.waiver.adoptedBy.name}, relieves this rule, but its provision ${relief.provision.title} does not cover this subject, so the rule’s own result stands. ${recorded}`
      : `Would not be relieved by ${statement} (shadow adoption): the provision does not cover this subject. ${recorded}`;
  }
  return relief.mode === 'active'
    ? `Relieved by ${statement}.`
    : `Would be relieved by ${statement} (shadow adoption).`;
}

/** The adoption mode an evaluation was recorded under; evaluations recorded before modes existed ran as active. */
export function evaluationMode(evaluation: Pick<RuleEvaluationRecord, 'adoption'>): 'shadow' | 'active' {
  return evaluation.adoption.mode ?? 'active';
}

export const SUBJECT_RECORD_PAGE_LIMIT = 100;
export const SubjectRecordQuerySchema = Type.Object(
  {
    subjectKind: literals(observationSubjectKindValues),
    subjectId: Id,
    subjectScope: Type.Optional(
      literals(observationSubjectScopeValues, {
        description:
          'ledger (default): subjectId is a Ledger subject id. source: subjectId is the source’s own id under sourceId.',
      }),
    ),
    sourceId: Type.Optional(Id),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: SUBJECT_RECORD_PAGE_LIMIT })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
  },
  { ...Closed, description: 'Records about one subject reference, newest first.' },
);
export type SubjectRecordQuery = Static<typeof SubjectRecordQuerySchema>;

const PageSchema = Type.Object(
  {
    limit: Type.Integer({ minimum: 1, maximum: SUBJECT_RECORD_PAGE_LIMIT }),
    returned: Type.Integer({ minimum: 0, maximum: SUBJECT_RECORD_PAGE_LIMIT }),
    hasMore: Type.Boolean(),
    nextCursor: Type.Union([Type.String(), Type.Null()]),
  },
  Closed,
);

export const RuleEvaluationListResponseSchema = Type.Object(
  {
    evaluations: Type.Array(RuleEvaluationRecordSchema),
    page: PageSchema,
    inputSubjects: EvaluationInputSubjectsSchema,
    summaryWording: EvaluationSummaryWordingSchema,
  },
  Closed,
);
export type RuleEvaluationListResponse = Static<typeof RuleEvaluationListResponseSchema>;

export const RuleEvaluationResponseSchema = Type.Object(
  {
    evaluation: RuleEvaluationRecordSchema,
    inputSubjects: EvaluationInputSubjectsSchema,
    summaryWording: EvaluationSummaryWordingSchema,
  },
  Closed,
);
export type RuleEvaluationResponse = Static<typeof RuleEvaluationResponseSchema>;
export const RuleEvaluationParamsSchema = Type.Object({ id: Id }, Closed);
export type RuleEvaluationParams = Static<typeof RuleEvaluationParamsSchema>;

export const findingTreatmentActions = ['acknowledge', 'assign', 'plan', 'respond', 'resolve', 'close'] as const;
export const findingClosingReasons = [
  'corrected_by_record',
  'accepted',
  'condition_ended',
  'recorded_in_error',
] as const;
export type FindingClosingReason = (typeof findingClosingReasons)[number];
const Day = Type.String({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' });

export const FindingDecisionReferenceSchema = Type.Object(
  { id: Id, findingCount: Type.Integer({ minimum: 1 }) },
  {
    ...Closed,
    description: 'The one decision about many findings of one rule this treatment came from, and how many it named.',
  },
);

const SubjectTreatmentSchema = Type.Object(
  {
    id: Id,
    evaluationId: Id,
    action: literals([...findingTreatmentActions]),
    actorId: Id,
    actorName: Type.String(),
    note: Type.String(),
    recordedAt: Time,
    assignee: Type.Optional(Type.Object({ id: Id, name: Type.String() }, Closed)),
    dueOn: Type.Optional(Day),
    reason: Type.Optional(literals([...findingClosingReasons])),
    decision: Type.Optional(FindingDecisionReferenceSchema),
  },
  Closed,
);

export const FindingActionSchema = Type.Object(
  {
    note: Type.String(),
    dueOn: Day,
    overdue: Type.Boolean({
      description: 'The due day has passed in the organization’s time zone and nothing is recorded as done.',
    }),
    doneAt: Type.Optional(Time),
  },
  { ...Closed, description: 'The action recorded on the finding, and when what was done was recorded.' },
);
export type FindingAction = Static<typeof FindingActionSchema>;

export const FindingClosingRecordSchema = Type.Object(
  { observationId: Id, title: Type.String(), occurredAt: Time },
  {
    ...Closed,
    description: 'A record the closing evaluation read that the evaluation which opened the finding did not.',
  },
);
export type FindingClosingRecord = Static<typeof FindingClosingRecordSchema>;

export const FindingClosureSchema = Type.Union(
  [
    Type.Object(
      {
        by: Type.Literal('record'),
        closedAt: Time,
        evaluationId: Id,
        summary: Type.String(),
        records: Type.Array(FindingClosingRecordSchema),
      },
      Closed,
    ),
    Type.Object(
      {
        by: Type.Literal('person'),
        closedAt: Time,
        reason: literals([...findingClosingReasons, 'evidence_cleared']),
        actorName: Type.String(),
        note: Type.String(),
      },
      Closed,
    ),
  ],
  {
    description:
      'How the finding was closed: by itself when a later record changed the result, or by a person with a reason. evidence_cleared is a person resolving a finding whose check had cleared.',
  },
);
export type FindingClosure = Static<typeof FindingClosureSchema>;

export const SubjectFindingRecordSchema = Type.Object(
  {
    id: Id,
    subject: SubjectReferenceSchema,
    subjectKey: Type.String({ minLength: 1, maxLength: 1000 }),
    packId: Id,
    ruleId: Id,
    related: Type.Optional(RelatedSubjectSchema),
    mode: literals(['shadow', 'active'], {
      description:
        'The mode of the latest evaluation. A shadow finding is recorded and labelled but never counted in what a person attests to.',
    }),
    status: literals(['open', 'acknowledged', 'responding', 'resolved']),
    ruleNoLongerAdopted: Type.Optional(
      Type.Literal(true, {
        description:
          'Present when no adoption in effect holds the finding’s rule, as when a later version of its pack dropped it. The finding keeps its status until a person treats it.',
      }),
    ),
    owner: Type.Union([Type.Object({ id: Id, name: Type.String() }, Closed), Type.Null()]),
    openedAt: Time,
    initialEvaluation: RuleEvaluationRecordSchema,
    latestEvaluation: RuleEvaluationRecordSchema,
    treatments: Type.Array(SubjectTreatmentSchema, { maxItems: 50 }),
    hasOlderTreatments: Type.Boolean(),
    action: Type.Optional(FindingActionSchema),
    closure: Type.Optional(FindingClosureSchema),
  },
  {
    ...Closed,
    description:
      'A finding opened by the generic evaluator for one rule and one subject reference, and for one related subject when the rule fans out.',
  },
);
export type SubjectFindingRecord = Static<typeof SubjectFindingRecordSchema>;

export const SubjectFindingListResponseSchema = Type.Object(
  {
    findings: Type.Array(SubjectFindingRecordSchema),
    page: PageSchema,
    inputSubjects: EvaluationInputSubjectsSchema,
    summaryWording: EvaluationSummaryWordingSchema,
  },
  Closed,
);
export type SubjectFindingListResponse = Static<typeof SubjectFindingListResponseSchema>;
