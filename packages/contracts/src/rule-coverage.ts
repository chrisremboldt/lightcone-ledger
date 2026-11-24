import { Type, type SchemaOptions, type Static, type TLiteral } from '@sinclair/typebox';
import { RulePopulationSchema } from './checked-rules.js';
import { observationSubjectKindValues } from './observations/envelope.js';
import { NamedSubjectSchema } from './rule-evaluations.js';

const Id = Type.String({ minLength: 1, maxLength: 200 });
const Time = Type.String({ format: 'date-time' });
const Count = Type.Integer({ minimum: 0 });
const Closed = { additionalProperties: false } as const;
const literals = <const Values extends readonly string[]>(values: Values, options: SchemaOptions = {}) =>
  Type.Union(values.map((value) => Type.Literal(value)) as TLiteral<Values[number]>[], options);

/** Subjects one page of a coverage list holds at most. */
export const COVERAGE_PAGE_LIMIT = 200;

export const coverageCheckedByValues = ['automatic', 'person', 'not_supported'] as const;
export type CoverageCheckedBy = (typeof coverageCheckedByValues)[number];

/**
 * A member's latest result under an adoption, as coverage counts it. Never a verdict: each says what the record
 * supports, or that it is not on file.
 */
export const coverageResultValues = [
  'supported',
  'attention',
  'no_record',
  'pending',
  'not_applicable',
  'relieved',
  'other',
  'not_evaluated',
] as const;
export type CoverageResult = (typeof coverageResultValues)[number];
export const CoverageResultSchema = literals(coverageResultValues, {
  description:
    'supported: the latest evaluation passed (supported by the record). attention: it needs attention. no_record: a record the rule requires is not on file. pending: it waits for another record or a time. not_applicable: the rule does not apply. relieved: a waiver the organization adopted relieves the rule, so its result is recorded and not counted against the subject. other: any other result. not_evaluated: no evaluation under this adoption yet.',
});

export const CoverageCountsSchema = Type.Object(
  Object.fromEntries(coverageResultValues.map((value) => [value, Count])) as Record<CoverageResult, typeof Count>,
  Closed,
);
export type CoverageCounts = Static<typeof CoverageCountsSchema>;

export const RuleCoverageSchema = Type.Object(
  {
    leafId: Id,
    title: Type.String(),
    checkedBy: literals(coverageCheckedByValues, {
      description:
        'automatic: a check runs on records. person: a person reviews it. not_supported: nothing checks it yet.',
    }),
    subjectKind: Type.Optional(literals(observationSubjectKindValues)),
    section: Id,
    paragraph: Type.Optional(Type.String({ description: 'The paragraph the rule reads, as a reader cites it.' })),
    population: Type.Optional(RulePopulationSchema),
    populationSize: Type.Union([Count, Type.Null()], {
      description:
        'Members found, at most the population limit plus one; null for a rule no check runs. Without a declared population, the subjects evaluated under the adoption.',
    }),
    counts: Type.Union([CoverageCountsSchema, Type.Null()]),
    complete: Type.Boolean({ description: 'Every member is counted by an evaluation under this adoption.' }),
    incomplete: Type.Optional(
      literals(['population_limit', 'evaluating'], {
        description:
          'population_limit: more members than one adoption evaluates; the counts cover the first ones. evaluating: some members have no evaluation yet.',
      }),
    ),
  },
  Closed,
);
export type RuleCoverage = Static<typeof RuleCoverageSchema>;

export const CoverageSectionSchema = Type.Object(
  {
    id: Id,
    title: Type.String({ description: 'The section as a heading.' }),
    leafIds: Type.Array(Id, { description: 'The rules of the section, in the order the rules list gives them.' }),
    checkedBy: Type.Object(
      Object.fromEntries(coverageCheckedByValues.map((value) => [value, Count])) as Record<
        CoverageCheckedBy,
        typeof Count
      >,
      { ...Closed, description: 'How many of its rules are checked in each way.' },
    ),
    needingAttention: Type.Integer({
      minimum: 0,
      description: 'How many of its rules have at least one member whose latest result needs attention.',
    }),
    withNoRecord: Type.Integer({
      minimum: 0,
      description: 'How many of its rules have at least one member with a record the rule requires not on file.',
    }),
  },
  Closed,
);
export type CoverageSection = Static<typeof CoverageSectionSchema>;

export const AdoptionCoverageParamsSchema = Type.Object({ adoptionId: Id }, Closed);
export type AdoptionCoverageParams = Static<typeof AdoptionCoverageParamsSchema>;

export const AdoptionRuleCoverageResponseSchema = Type.Object(
  {
    adoptionId: Id,
    packId: Id,
    version: Type.Integer({ minimum: 1 }),
    title: Type.String(),
    mode: literals(['shadow', 'active']),
    asOf: Time,
    populationLimit: Type.Integer({ minimum: 1 }),
    sections: Type.Array(CoverageSectionSchema, {
      description:
        'The sections of the adopted pack version in reading order, each with its rules. A pack that declares none has one section holding every rule in the order of their paragraphs or provision numbers.',
    }),
    rules: Type.Array(RuleCoverageSchema, { description: 'Every rule, section by section, in the sections’ order.' }),
  },
  Closed,
);
export type AdoptionRuleCoverageResponse = Static<typeof AdoptionRuleCoverageResponseSchema>;

export const RuleCoverageSubjectsParamsSchema = Type.Object({ adoptionId: Id, leafId: Id }, Closed);
export type RuleCoverageSubjectsParams = Static<typeof RuleCoverageSubjectsParamsSchema>;

export const RuleCoverageSubjectsQuerySchema = Type.Object(
  {
    result: Type.Optional(CoverageResultSchema),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: COVERAGE_PAGE_LIMIT })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 1200 })),
  },
  Closed,
);
export type RuleCoverageSubjectsQuery = Static<typeof RuleCoverageSubjectsQuerySchema>;

const CoveragePageSchema = Type.Object(
  {
    limit: Type.Integer({ minimum: 1, maximum: COVERAGE_PAGE_LIMIT }),
    hasMore: Type.Boolean(),
    nextCursor: Type.Union([Type.String(), Type.Null()]),
  },
  Closed,
);

export const RuleCoverageSubjectSchema = Type.Object(
  {
    subject: NamedSubjectSchema,
    result: CoverageResultSchema,
    evaluation: Type.Union([
      Type.Object(
        {
          id: Id,
          outcome: Type.String(),
          evidenceState: Type.String(),
          reasonCode: Type.String(),
          summary: Type.String(),
          recordedAt: Time,
        },
        Closed,
      ),
      Type.Null(),
    ]),
    finding: Type.Union([Type.Object({ id: Id, status: Type.String() }, Closed), Type.Null()]),
    missing: Type.Array(Type.String(), {
      description: 'What a person calls each record the rule requires that the latest evaluation found not on file.',
    }),
  },
  Closed,
);
export type RuleCoverageSubject = Static<typeof RuleCoverageSubjectSchema>;

export const RuleCoverageSubjectsResponseSchema = Type.Object(
  {
    adoptionId: Id,
    leafId: Id,
    result: Type.Union([CoverageResultSchema, Type.Null()]),
    subjects: Type.Array(RuleCoverageSubjectSchema),
    page: CoveragePageSchema,
  },
  Closed,
);
export type RuleCoverageSubjectsResponse = Static<typeof RuleCoverageSubjectsResponseSchema>;

export const SubjectsOnRecordQuerySchema = Type.Object(
  {
    kind: literals(observationSubjectKindValues),
    search: Type.Optional(Type.String({ maxLength: 200 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: COVERAGE_PAGE_LIMIT })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 1200 })),
  },
  Closed,
);
export type SubjectsOnRecordQuery = Static<typeof SubjectsOnRecordQuerySchema>;

export const SubjectsOnRecordResponseSchema = Type.Object(
  {
    kind: literals(observationSubjectKindValues),
    subjects: Type.Array(NamedSubjectSchema),
    page: CoveragePageSchema,
    truncated: Type.Boolean({
      description: 'More subjects of the kind are on record than one read searches; narrow the search.',
    }),
  },
  Closed,
);
export type SubjectsOnRecordResponse = Static<typeof SubjectsOnRecordResponseSchema>;
