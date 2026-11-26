import { Type, type Static, type TLiteral } from '@sinclair/typebox';
import { RECORD_LINK_SECRET_PATTERN } from './record-production-links.js';
import { coverageCheckedByValues, CoverageCountsSchema } from './rule-coverage.js';

/**
 * A program owner's view of the operators it contracts (docs/design/program-owner-view.md). An operator makes a grant
 * whose secret opens one narrow read of counts; the program owner's Ledger reads it on a schedule, keeps every answer,
 * and shows its operators side by side. Nothing in the answer names a subject, a person or a safety report.
 */

export const PROGRAM_GRANT_DEFAULT_DAYS = 90;
export const PROGRAM_GRANT_MAX_DAYS = 365;
export const PROGRAM_GRANT_PACK_LIMIT = 10;
export const PROGRAM_GRANT_PRODUCTION_LIMIT = 20;
/** 32 random bytes as base64url after the prefix. */
export const PROGRAM_GRANT_SECRET_PATTERN = '^ledger-program-[A-Za-z0-9_-]{43}$';
/** The route of an operator's Ledger that answers a grant's secret, without sign-in. */
export const PROGRAM_VIEW_PATH = '/v1/program-view';
export const PROGRAM_VIEW_VERSION = 'ledger.program-view.1';
/** The largest answer a program owner's Ledger keeps. */
export const PROGRAM_VIEW_MAX_BYTES = 1_048_576;
/** How often a followed operator is read, in seconds. */
export const PROGRAM_READ_SECONDS = 3600;
/** An answer older than this is shown as not read lately, in seconds. */
export const PROGRAM_READ_LATE_SECONDS = 7200;

const Closed = { additionalProperties: false } as const;
const Id = Type.String({ minLength: 1, maxLength: 200 });
const Time = Type.String({ format: 'date-time' });
const Count = Type.Integer({ minimum: 0 });
const Digest = Type.String({ pattern: '^[a-f0-9]{64}$' });
const PersonRef = Type.Object({ id: Id, name: Type.String() }, Closed);
const Text = (maxLength: number, description: string) =>
  Type.String({ minLength: 1, maxLength, pattern: '\\S', description });
const literals = <const Values extends readonly string[]>(values: Values, description?: string) =>
  Type.Union(
    values.map((value) => Type.Literal(value)) as TLiteral<Values[number]>[],
    description ? { description } : {},
  );

// --- The document an operator's Ledger answers ---

/** An instant in UTC, as Ledger writes one; checked by pattern so the document is checked without format plug-ins. */
const Utc = Type.String({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,6})?Z$' });
const Name = Type.String({ maxLength: 500 });

export const ProgramViewRuleSchema = Type.Object(
  {
    ruleId: Type.String({ minLength: 1, maxLength: 200 }),
    title: Name,
    citation: Type.Union([Name, Type.Null()], { description: 'The paragraph the rule reads, as the pack cites it.' }),
    checkedBy: literals(coverageCheckedByValues),
    counts: Type.Union([CoverageCountsSchema, Type.Null()], {
      description: 'How many subjects are in each result; null for a rule nothing checks.',
    }),
    complete: Type.Boolean({ description: 'Every subject the rule covers is counted.' }),
  },
  Closed,
);
export type ProgramViewRule = Static<typeof ProgramViewRuleSchema>;

export const ProgramViewPackSchema = Type.Object(
  {
    packId: Type.String({ minLength: 1, maxLength: 200 }),
    title: Name,
    version: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()], {
      description: 'The adopted version read; null when the organization has no adoption of the pack that stands now.',
    }),
    mode: Type.Union([Type.Literal('active'), Type.Literal('shadow'), Type.Null()]),
    rules: Type.Array(ProgramViewRuleSchema, { maxItems: 1000 }),
  },
  Closed,
);
export type ProgramViewPack = Static<typeof ProgramViewPackSchema>;

export const ProgramViewFindingRuleSchema = Type.Object(
  {
    packId: Type.String({ minLength: 1, maxLength: 200 }),
    packTitle: Name,
    ruleId: Type.String({ minLength: 1, maxLength: 200 }),
    ruleTitle: Name,
    citation: Name,
    open: Type.Integer({ minimum: 1 }),
    oldestOpenedAt: Utc,
    oldestAgeDays: Count,
  },
  Closed,
);
export type ProgramViewFindingRule = Static<typeof ProgramViewFindingRuleSchema>;

export const ProgramViewDocumentSchema = Type.Object(
  {
    version: Type.Literal(PROGRAM_VIEW_VERSION),
    operator: Type.Object({ name: Name }, Closed),
    madeAt: Utc,
    grantExpiresAt: Utc,
    packs: Type.Optional(Type.Array(ProgramViewPackSchema, { maxItems: PROGRAM_GRANT_PACK_LIMIT })),
    openFindings: Type.Optional(
      Type.Object(
        {
          total: Count,
          truncated: Type.Boolean({ description: 'More findings are open than one read counts.' }),
          rules: Type.Array(ProgramViewFindingRuleSchema, { maxItems: 2000 }),
        },
        { ...Closed, description: 'Counted open findings by rule: active adoptions, nothing a waiver relieves.' },
      ),
    ),
    records: Type.Optional(
      Type.Array(
        Type.Object(
          {
            producedAt: Utc,
            records: Count,
            expiresAt: Utc,
            secret: Type.String({
              pattern: RECORD_LINK_SECRET_PATTERN,
              description: 'The link to the set: /shared# and this, on the operator’s Ledger.',
            }),
          },
          Closed,
        ),
        { maxItems: PROGRAM_GRANT_PRODUCTION_LIMIT },
      ),
    ),
  },
  {
    ...Closed,
    description:
      'What a grant shows: counts of recorded things only, never a subject, a record, a person or a safety report. Parts the grant does not cover are absent.',
  },
);
export type ProgramViewDocument = Static<typeof ProgramViewDocumentSchema>;

export const ProgramViewRequestSchema = Type.Object(
  { secret: Type.String({ minLength: 1, maxLength: 200, description: 'The grant’s secret.' }) },
  Closed,
);
export type ProgramViewRequest = Static<typeof ProgramViewRequestSchema>;

// --- The operator's side: grants ---

export const ProgramGrantCreateSchema = Type.Object(
  {
    programOwner: Text(200, 'Who the grant is for: the program owner, in your words.'),
    expiresInDays: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: PROGRAM_GRANT_MAX_DAYS,
        description: `How many days the grant answers. ${PROGRAM_GRANT_DEFAULT_DAYS} unless given; ${PROGRAM_GRANT_MAX_DAYS} at most.`,
      }),
    ),
    packs: Type.Array(Id, {
      maxItems: PROGRAM_GRANT_PACK_LIMIT,
      uniqueItems: true,
      description: 'Adopted packs whose coverage by rule and result the grant shows.',
    }),
    openFindings: Type.Boolean({ description: 'Whether the grant shows the open findings by rule.' }),
    productions: Type.Array(Id, {
      maxItems: PROGRAM_GRANT_PRODUCTION_LIMIT,
      uniqueItems: true,
      description: 'Produced sets the grant gives a link to, made with it and ending with it.',
    }),
  },
  { ...Closed, description: 'Make a grant. Its secret is returned once. It covers at least one part.' },
);
export type ProgramGrantCreate = Static<typeof ProgramGrantCreateSchema>;

export const ProgramGrantRevokeSchema = Type.Object(
  { reason: Text(1000, 'Why the grant is revoked. Kept with the revocation.') },
  Closed,
);
export type ProgramGrantRevoke = Static<typeof ProgramGrantRevokeSchema>;

export const ProgramGrantReadSchema = Type.Object(
  {
    readAt: Time,
    parts: Type.Array(Type.String(), {
      description: 'What was read: pack:<pack id>, open_findings, records:<production id>.',
    }),
  },
  { ...Closed, description: 'One read of a grant. Who read it is not kept.' },
);
export type ProgramGrantRead = Static<typeof ProgramGrantReadSchema>;

export const ProgramGrantSchema = Type.Object(
  {
    id: Id,
    programOwner: Type.String(),
    createdBy: PersonRef,
    createdAt: Time,
    expiresAt: Time,
    revokedBy: Type.Union([PersonRef, Type.Null()]),
    revokedAt: Type.Union([Time, Type.Null()]),
    revokeReason: Type.Union([Type.String(), Type.Null()]),
    state: literals(['in_force', 'expired', 'revoked'] as const, 'in_force: the grant answers its secret now.'),
    covers: Type.Object(
      {
        packs: Type.Array(Type.Object({ packId: Id, title: Type.String() }, Closed)),
        openFindings: Type.Boolean(),
        productions: Type.Array(
          Type.Object(
            { id: Id, producedAt: Time, records: Count, linkId: Id, reason: Type.String() },
            { ...Closed, description: 'A produced set and the link made to it with the grant.' },
          ),
        ),
      },
      Closed,
    ),
    readCount: Count,
    reads: Type.Array(ProgramGrantReadSchema, { description: 'Newest first, at most 200.' }),
  },
  Closed,
);
export type ProgramGrant = Static<typeof ProgramGrantSchema>;

export const ProgramGrantCreatedSchema = Type.Object(
  {
    grant: ProgramGrantSchema,
    secret: Type.String({
      pattern: PROGRAM_GRANT_SECRET_PATTERN,
      description: 'Shown once. Give it, with this Ledger’s address, to the program owner.',
    }),
  },
  Closed,
);
export type ProgramGrantCreated = Static<typeof ProgramGrantCreatedSchema>;
export const ProgramGrantResponseSchema = Type.Object({ grant: ProgramGrantSchema }, Closed);
export type ProgramGrantResponse = Static<typeof ProgramGrantResponseSchema>;
export const ProgramGrantListSchema = Type.Object({ grants: Type.Array(ProgramGrantSchema) }, Closed);
export type ProgramGrantList = Static<typeof ProgramGrantListSchema>;
export const ProgramGrantParamsSchema = Type.Object({ id: Id }, Closed);
export type ProgramGrantParams = Static<typeof ProgramGrantParamsSchema>;

// --- The program owner's side: operators it follows ---

export const ProgramOperatorAddSchema = Type.Object(
  {
    name: Text(200, 'Your name for the operator. The view lists operators in alphabetical order of it.'),
    address: Type.String({
      minLength: 10,
      maxLength: 2000,
      pattern: '^https?://[^\\s]+$',
      description: 'The address of the operator’s Ledger, as its people open it. https:// outside a local Ledger.',
    }),
    secret: Type.String({ pattern: PROGRAM_GRANT_SECRET_PATTERN, description: 'The secret the operator gave you.' }),
  },
  { ...Closed, description: 'Follow an operator. The secret is kept for the workers and never shown again.' },
);
export type ProgramOperatorAdd = Static<typeof ProgramOperatorAddSchema>;

export const ProgramOperatorRemoveSchema = Type.Object(
  { reason: Text(1000, 'Why the operator is no longer followed. Kept with the removal.') },
  Closed,
);
export type ProgramOperatorRemove = Static<typeof ProgramOperatorRemoveSchema>;

export const programReadOutcomeValues = ['answered', 'not_in_use', 'failed'] as const;
export type ProgramReadOutcome = (typeof programReadOutcomeValues)[number];

export const ProgramOperatorAnswerSchema = Type.Object(
  {
    id: Id,
    readAt: Time,
    outcome: literals(
      programReadOutcomeValues,
      'answered: the document was kept. not_in_use: the operator’s Ledger answered that the grant opens nothing. failed: no answer was kept.',
    ),
    reason: Type.Union([Type.String(), Type.Null()]),
    sha256: Type.Union([Digest, Type.Null()], { description: 'Of the answer’s bytes as received.' }),
    byteLength: Type.Union([Count, Type.Null()]),
  },
  Closed,
);
export type ProgramOperatorAnswer = Static<typeof ProgramOperatorAnswerSchema>;

export const programOperatorStateValues = ['read', 'late', 'failed', 'ended', 'not_read'] as const;
export type ProgramOperatorState = (typeof programOperatorStateValues)[number];

export const ProgramOperatorSchema = Type.Object(
  {
    id: Id,
    name: Type.String(),
    address: Type.String(),
    addedBy: PersonRef,
    addedAt: Time,
    nextReadAt: Type.Union([Time, Type.Null()]),
    state: literals(
      programOperatorStateValues,
      'read: the last read answered and the grant is in force. late: the last answer is more than two hours old. failed: the last read failed. ended: the grant opens nothing any more. not_read: not read yet.',
    ),
    lastRead: Type.Union([ProgramOperatorAnswerSchema, Type.Null()]),
    lastAnswer: Type.Union([
      Type.Object({ readAt: Time, sha256: Digest, document: ProgramViewDocumentSchema }, Closed),
      Type.Null(),
    ]),
  },
  Closed,
);
export type ProgramOperator = Static<typeof ProgramOperatorSchema>;

export const ProgramOperatorListSchema = Type.Object(
  {
    asOf: Time,
    operators: Type.Array(ProgramOperatorSchema, { description: 'In alphabetical order of their names.' }),
    removed: Type.Array(
      Type.Object(
        { id: Id, name: Type.String(), removedAt: Time, removedBy: PersonRef, reason: Type.String() },
        Closed,
      ),
      { description: 'Operators no longer followed, most recently removed first, at most 50.' },
    ),
    httpAllowed: Type.Boolean({ description: 'Whether this Ledger reads an http:// address: only a local one.' }),
  },
  Closed,
);
export type ProgramOperatorList = Static<typeof ProgramOperatorListSchema>;
export const ProgramOperatorResponseSchema = Type.Object({ operator: ProgramOperatorSchema }, Closed);
export type ProgramOperatorResponse = Static<typeof ProgramOperatorResponseSchema>;
export const ProgramOperatorAnswersSchema = Type.Object(
  { operatorId: Id, answers: Type.Array(ProgramOperatorAnswerSchema, { description: 'Newest first, at most 200.' }) },
  Closed,
);
export type ProgramOperatorAnswers = Static<typeof ProgramOperatorAnswersSchema>;
export const ProgramOperatorParamsSchema = Type.Object({ id: Id }, Closed);
export type ProgramOperatorParams = Static<typeof ProgramOperatorParamsSchema>;
