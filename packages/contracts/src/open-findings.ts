import { Type, type Static } from '@sinclair/typebox';
import { observationSubjectKindValues } from './observations/envelope.js';
import { FindingActionSchema, NamedSubjectSchema } from './rule-evaluations.js';

/**
 * The open findings across every subject, and the home of an organization whose flights are known only from its own
 * records. Documented in docs/design/finding-work.md.
 */

const Id = Type.String({ minLength: 1, maxLength: 200 });
const Time = Type.String({ format: 'date-time' });
const Count = Type.Integer({ minimum: 0 });
const Closed = { additionalProperties: false } as const;
const SubjectKind = Type.Union(observationSubjectKindValues.map((kind) => Type.Literal(kind)));
const day = (description: string) => Type.String({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$', description });

/** At most this many open findings are read for the list; more are reported as truncated. */
export const OPEN_FINDING_LIMIT = 2000;
export const OPEN_FINDING_PAGE_LIMIT = 200;
/** One decision about many findings of one rule names at most this many. */
export const FINDING_SET_LIMIT = 500;
/** The home lists at most this many flights in each of upcoming and recent. */
export const FLIGHTS_ON_RECORD_LIMIT = 25;

export const OpenFindingsQuerySchema = Type.Object(
  {
    shown: Type.Optional(
      Type.Union([Type.Literal('counted'), Type.Literal('proposed')], {
        description:
          'counted (the default): findings from adoptions in active mode. proposed: findings from adoptions in shadow mode, which are never counted.',
      }),
    ),
    subjectKind: Type.Optional(SubjectKind),
    packId: Type.Optional(Id),
    ruleId: Type.Optional(Id),
    aboutFrom: Type.Optional(
      day(
        'The first day, in the organization’s time zone, the findings are about: the earliest time of the current records about the subject, else when the finding opened.',
      ),
    ),
    aboutUntil: Type.Optional(day('The last day, in the organization’s time zone, the findings are about, included.')),
    result: Type.Optional(
      Type.Union([Type.Literal('attention'), Type.Literal('cleared')], {
        description:
          'attention: findings whose latest result still needs attention. cleared: findings whose latest result no longer does, which a person closes.',
      }),
    ),
    owner: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 200,
        description: 'A person’s principal id, or none for the findings nobody owns.',
      }),
    ),
    cursor: Type.Optional(Type.String({ maxLength: 4096 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: OPEN_FINDING_PAGE_LIMIT })),
  },
  { ...Closed, description: 'Which open findings to list. Filters combine.' },
);
export type OpenFindingsQuery = Static<typeof OpenFindingsQuerySchema>;

export const OpenFindingGroupsQuerySchema = Type.Object(
  {
    shown: OpenFindingsQuerySchema.properties.shown,
    subjectKind: Type.Optional(SubjectKind),
    packId: Type.Optional(Id),
    aboutFrom: OpenFindingsQuerySchema.properties.aboutFrom,
    aboutUntil: OpenFindingsQuerySchema.properties.aboutUntil,
    result: OpenFindingsQuerySchema.properties.result,
    owner: OpenFindingsQuerySchema.properties.owner,
    order: Type.Optional(
      Type.Union([Type.Literal('fewest'), Type.Literal('most')], {
        description: 'fewest (the default): the rules with the fewest open findings first. most: the most first.',
      }),
    ),
  },
  { ...Closed, description: 'Which open findings to group by rule. Filters combine, as for the list.' },
);
export type OpenFindingGroupsQuery = Static<typeof OpenFindingGroupsQuerySchema>;

export const OpenFindingSchema = Type.Object(
  {
    id: Id,
    subject: NamedSubjectSchema,
    related: Type.Optional(
      Type.Object(
        { name: Type.String(), subject: NamedSubjectSchema },
        {
          ...Closed,
          description: 'For a rule that checks each related subject: the one this finding is for.',
        },
      ),
    ),
    packId: Id,
    packTitle: Type.String(),
    ruleId: Id,
    ruleTitle: Type.String(),
    paragraph: Type.String({ description: 'The reference of the text the rule checks, as the pack cites it.' }),
    summary: Type.String({ description: 'What the latest evaluation reported.' }),
    evaluationId: Type.String({
      minLength: 1,
      maxLength: 200,
      description: 'The latest evaluation, which a decision about the finding pins.',
    }),
    aboutAt: Type.String({
      format: 'date-time',
      description:
        'When the finding is about: the earliest time of the current records about its subject, else when it opened.',
    }),
    cleared: Type.Boolean({
      description:
        'The latest result no longer needs attention, but nothing a person keeps answered the finding: what it reported still happened, and a person closes it.',
    }),
    mode: Type.Union([Type.Literal('active'), Type.Literal('shadow')]),
    status: Type.Union([Type.Literal('open'), Type.Literal('acknowledged'), Type.Literal('responding')]),
    owner: Type.Union([Type.Object({ id: Id, name: Type.String() }, Closed), Type.Null()]),
    openedAt: Time,
    ageDays: Count,
    action: Type.Optional(FindingActionSchema),
  },
  Closed,
);
export type OpenFinding = Static<typeof OpenFindingSchema>;

export const FindingAttentionSchema = Type.Object(
  {
    unowned: Count,
    overdue: Count,
  },
  {
    ...Closed,
    description:
      'Counted open findings that nobody owns, and counted open findings whose action is past its due day with nothing recorded as done.',
  },
);
export type FindingAttention = Static<typeof FindingAttentionSchema>;

export const OpenFindingsResponseSchema = Type.Object(
  {
    shown: Type.Union([Type.Literal('counted'), Type.Literal('proposed')]),
    findings: Type.Array(OpenFindingSchema),
    matching: Type.Integer({
      minimum: 0,
      description: 'How many findings of the tab the filters select, on every page.',
    }),
    page: Type.Object(
      { limit: Type.Integer(), hasMore: Type.Boolean(), nextCursor: Type.Union([Type.String(), Type.Null()]) },
      Closed,
    ),
    counts: Type.Object(
      {
        counted: Count,
        proposed: Count,
        relieved: Count,
      },
      {
        ...Closed,
        description:
          'Every open finding of the organization, by how it is shown: counted, proposed (shadow), and relieved by an adopted waiver, which is neither.',
      },
    ),
    attention: FindingAttentionSchema,
    filters: Type.Object(
      {
        subjectKinds: Type.Array(SubjectKind),
        packs: Type.Array(Type.Object({ id: Id, title: Type.String() }, Closed)),
        owners: Type.Array(Type.Object({ id: Id, name: Type.String() }, Closed)),
      },
      { ...Closed, description: 'The values the open findings of the shown tab hold, to choose a filter from.' },
    ),
    truncated: Type.Boolean({ description: `True when more than ${OPEN_FINDING_LIMIT} findings are open.` }),
    computedAt: Time,
  },
  Closed,
);
export type OpenFindingsResponse = Static<typeof OpenFindingsResponseSchema>;

export const OpenFindingGroupSchema = Type.Object(
  {
    packId: Id,
    packTitle: Type.String(),
    ruleId: Id,
    ruleTitle: Type.String(),
    paragraph: Type.String({ description: 'The reference of the text the rule checks, as the pack cites it.' }),
    open: Count,
    subjects: Type.Integer({ minimum: 0, description: 'How many distinct subjects the open findings are about.' }),
    owned: Count,
    cleared: Type.Integer({
      minimum: 0,
      description: 'How many are supported by the record now; a person closes them.',
    }),
    oldestOpenedAt: Time,
    aboutFrom: Time,
    aboutUntil: Time,
  },
  {
    ...Closed,
    description:
      'The open findings of one rule: how many, about how many subjects, how many owned, the oldest opening, and the earliest and latest time they are about.',
  },
);
export type OpenFindingGroup = Static<typeof OpenFindingGroupSchema>;

export const OpenFindingGroupsResponseSchema = Type.Object(
  {
    shown: OpenFindingsResponseSchema.properties.shown,
    order: Type.Union([Type.Literal('fewest'), Type.Literal('most')]),
    groups: Type.Array(OpenFindingGroupSchema, {
      description: 'One per pack and rule, by how many are open, then by pack title and rule id.',
    }),
    total: Type.Object(
      { findings: Count, rules: Count },
      { ...Closed, description: 'How many open findings the groups hold, and under how many rules.' },
    ),
    counts: OpenFindingsResponseSchema.properties.counts,
    attention: FindingAttentionSchema,
    filters: OpenFindingsResponseSchema.properties.filters,
    truncated: OpenFindingsResponseSchema.properties.truncated,
    computedAt: Time,
  },
  Closed,
);
export type OpenFindingGroupsResponse = Static<typeof OpenFindingGroupsResponseSchema>;

export const FlightOnRecordSchema = Type.Object(
  {
    subject: NamedSubjectSchema,
    window: Type.Object({ start: Time, end: Time }, Closed),
    aircraft: Type.Union([NamedSubjectSchema, Type.Null()]),
    pilotInCommand: Type.Union([NamedSubjectSchema, Type.Null()]),
    openFindings: Type.Integer({ minimum: 0, description: 'Counted open findings about the flight.' }),
  },
  {
    ...Closed,
    description:
      'A flight as its current flight plan record gives it: the window, the aircraft the plan names and the person a current role assignment names as pilot in command.',
  },
);
export type FlightOnRecord = Static<typeof FlightOnRecordSchema>;

export const FlightsOnRecordResponseSchema = Type.Object(
  {
    orderSource: Type.Boolean({
      description:
        'Whether the organization has an order source on record: a source that may create flights, or an order or flight intent one sent. Without one its flights are known only from its own records.',
    }),
    upcoming: Type.Array(FlightOnRecordSchema, { description: 'Windows starting now or later, soonest first.' }),
    recent: Type.Array(FlightOnRecordSchema, { description: 'Windows that started before now, latest first.' }),
    truncated: Type.Boolean(),
    attention: FindingAttentionSchema,
    computedAt: Time,
  },
  Closed,
);
export type FlightsOnRecordResponse = Static<typeof FlightsOnRecordResponseSchema>;
