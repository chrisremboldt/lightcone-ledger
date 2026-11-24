import { Type, type Static } from '@sinclair/typebox';
import { FidelitySchema } from './fidelity.js';
import {
  ObservationHeaderSchema,
  ObservationTypeIdSchema,
  ObservationVersionSchema,
  observationSubjectKindValues,
  observationSubjectScopeValues,
} from './observations/envelope.js';

const Id = Type.String({ minLength: 1, maxLength: 200 });
const Time = Type.String({ format: 'date-time' });
const literals = <const Values extends readonly string[]>(values: Values) =>
  Type.Union(values.map((value) => Type.Literal(value)));

/**
 * The `observation` input kind: `payload` is one observation object; its own `type` and `version` select the
 * registered schema. Everything an observation states (subject, session, fidelity, original artifact) is read from
 * the payload, so the input-level duplicates of those fields are refused. `occurredAt` must equal the payload's.
 */
export const ObservationInputConstraintSchema = {
  properties: {
    payload: ObservationHeaderSchema,
  },
  not: {
    description:
      'An observation input states its subject, session, time of effect, revision, original file and fidelity inside its payload, not beside it.',
    anyOf: ['subject', 'sourceSessionId', 'effectiveAt', 'sourceRevision', 'artifactId', 'fidelity'].map((field) => ({
      required: [field],
    })),
  },
};

export const ObservationGrantSchema = Type.Object(
  { sourceId: Id, observationType: ObservationTypeIdSchema },
  {
    additionalProperties: false,
    description:
      'Permission for this principal to submit observations of observationType (every registered version) under sourceId.',
  },
);
export type ObservationGrant = Static<typeof ObservationGrantSchema>;
export const ObservationGrantsSchema = Type.Array(ObservationGrantSchema, {
  uniqueItems: true,
  maxItems: 200,
  description:
    'Complete set of observation grants. In authority.update, omission preserves current grants and [] revokes them all.',
});

export const observationSubjectResolutionValues = ['ledger', 'alias', 'unresolved', 'ambiguous'] as const;
export type ObservationSubjectResolution = (typeof observationSubjectResolutionValues)[number];
/** How a read found the subject: as resolved at intake, or by a subject resolution recorded afterwards. */
export const observationSubjectReadResolutionValues = [...observationSubjectResolutionValues, 'record'] as const;
export type ObservationSubjectReadResolution = (typeof observationSubjectReadResolutionValues)[number];
export const AcceptedObservationSubjectSchema = Type.Object(
  {
    kind: literals(observationSubjectKindValues),
    id: Id,
    scope: literals(observationSubjectScopeValues),
    ledgerId: Type.Optional(Id),
    resolution: Type.Union(
      observationSubjectReadResolutionValues.map((value) => Type.Literal(value)),
      {
        description:
          'ledger: the submitted id is a Ledger subject. alias: a source id resolved through exactly one alias at intake. unresolved: no alias matched at intake. ambiguous: more than one alias matched. record: a subject resolution recorded after intake attached or moved it to ledgerId (resolutionId); reads at an evidence cut see only resolutions inside it. Intake itself never records record.',
      },
    ),
    resolutionId: Type.Optional(Id),
  },
  { additionalProperties: false },
);
export type AcceptedObservationSubject = Static<typeof AcceptedObservationSubjectSchema>;

export const ObservationWithdrawalViewSchema = Type.Object(
  { id: Id, eventId: Id, reason: Type.String(), recordedAt: Time, recordedBy: Id },
  { additionalProperties: false },
);

export const AcceptedObservationSchema = Type.Object(
  {
    id: Id,
    receiptId: Id,
    eventId: Id,
    artifactId: Id,
    sourceId: Id,
    type: ObservationTypeIdSchema,
    version: ObservationVersionSchema,
    subject: AcceptedObservationSubjectSchema,
    secondarySubject: Type.Optional(AcceptedObservationSubjectSchema),
    occurredAt: Time,
    interval: Type.Optional(Type.Object({ start: Time, end: Type.Optional(Time) }, { additionalProperties: false })),
    receivedAt: Time,
    fidelity: FidelitySchema,
    sourceSessionId: Type.Optional(Id),
    sourceEventId: Type.Optional(Id),
    observation: Type.Record(Type.String(), Type.Unknown(), {
      description: 'The complete accepted observation, exactly as validated against its registered type and version.',
    }),
    replaces: Type.Optional(Id),
    replacedBy: Type.Optional(Id),
    withdrawal: Type.Optional(ObservationWithdrawalViewSchema),
  },
  { additionalProperties: false },
);
export type AcceptedObservation = Static<typeof AcceptedObservationSchema>;

export const OBSERVATION_PAGE_LIMIT = 500;
export const ObservationQuerySchema = Type.Object(
  {
    subjectKind: literals(observationSubjectKindValues),
    subjectId: Id,
    subjectScope: Type.Optional(
      Type.Union(
        observationSubjectScopeValues.map((value) => Type.Literal(value)),
        {
          description:
            'ledger (default): subjectId is a Ledger subject id, matched against the primary or secondary subject as currently resolved. source: subjectId is the source’s own id under sourceId, matched as submitted.',
        },
      ),
    ),
    sourceId: Type.Optional(Id),
    type: ObservationTypeIdSchema,
    version: Type.Optional(ObservationVersionSchema),
    from: Time,
    to: Time,
    order: Type.Optional(Type.Union([Type.Literal('oldest_first'), Type.Literal('newest_first')])),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: OBSERVATION_PAGE_LIMIT })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
    include: Type.Optional(
      Type.Union([Type.Literal('current'), Type.Literal('all')], {
        description:
          'current (default): leave out observations that are replaced or withdrawn. all: include them, each saying what replaced or withdrew it.',
      }),
    ),
  },
  {
    additionalProperties: false,
    description:
      "Observations of one type for one subject whose time span meets [from, to). The span is [interval.start, interval.end) for an interval, [interval.start, occurredAt] for an interval without an end, and occurredAt otherwise. Ordered by span start then id; oldest_first is the default. A Ledger subject is matched against each observation's current subject, after any subject resolution recorded since intake.",
  },
);
export type ObservationQuery = Static<typeof ObservationQuerySchema>;

export const ObservationListResponseSchema = Type.Object(
  {
    observations: Type.Array(AcceptedObservationSchema),
    page: Type.Object(
      {
        limit: Type.Integer({ minimum: 1, maximum: OBSERVATION_PAGE_LIMIT }),
        returned: Type.Integer({ minimum: 0, maximum: OBSERVATION_PAGE_LIMIT }),
        hasMore: Type.Boolean(),
        nextCursor: Type.Union([Type.String(), Type.Null()]),
        order: Type.Union([Type.Literal('oldest_first'), Type.Literal('newest_first')]),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type ObservationListResponse = Static<typeof ObservationListResponseSchema>;

const Reason = Type.String({ minLength: 1, maxLength: 4000 });

export const ObservationWithdrawCommandSchema = Type.Object(
  { kind: Type.Literal('observation.withdraw'), observationId: Id, reason: Reason },
  {
    additionalProperties: false,
    description:
      'States that an accepted observation is wrong, with no replacement. Needs input:write and a grant for the observation type under its source. An observation is withdrawn or replaced once.',
  },
);
export type ObservationWithdrawCommand = Static<typeof ObservationWithdrawCommandSchema>;

export const ObservationSubjectResolveCommandSchema = Type.Object(
  {
    kind: Type.Literal('observation.resolve-subject'),
    observationId: Id,
    role: Type.Optional(Type.Union([Type.Literal('subject'), Type.Literal('secondarySubject')])),
    ledgerSubjectId: Id,
    reason: Reason,
  },
  {
    additionalProperties: false,
    description:
      'Attaches one subject role (subject by default) of an accepted observation to a Ledger subject of the same kind, or moves it from the one it is about. Needs input:write and a grant for the observation type under its source.',
  },
);
export type ObservationSubjectResolveCommand = Static<typeof ObservationSubjectResolveCommandSchema>;

export const SubjectAliasCommandSchema = Type.Object(
  {
    kind: Type.Literal('subject.alias'),
    sourceId: Id,
    subjectKind: literals(observationSubjectKindValues),
    externalId: Id,
    ledgerSubjectId: Id,
    validFrom: Type.Optional(Time),
    validTo: Type.Optional(Time),
    reason: Reason,
  },
  {
    additionalProperties: false,
    description:
      "Records an alias from a source's own id to a Ledger subject. Later observations naming it resolve at intake; earlier observations that named it and were unresolved at intake are attached to the subject, within the validity. Needs input:write and an observation grant under the source.",
  },
);
export type SubjectAliasCommand = Static<typeof SubjectAliasCommandSchema>;

export const ObservationCorrectionCommandSchemas = [
  ObservationWithdrawCommandSchema,
  ObservationSubjectResolveCommandSchema,
  SubjectAliasCommandSchema,
] as const;
