import { Type, type Static } from '@sinclair/typebox';

/**
 * A link to one produced set of records, opened without signing in (docs/design/shared-links.md). Its secret is 256
 * random bits, shown once; Ledger keeps only its SHA-256. It expires, can be revoked at once, and each opening is kept.
 */

export const RECORD_LINK_DEFAULT_DAYS = 7;
export const RECORD_LINK_MAX_DAYS = 90;
/** 32 random bytes as base64url after the prefix. */
export const RECORD_LINK_SECRET_PATTERN = '^ledger-records-[A-Za-z0-9_-]{43}$';
/** The web app's page a link opens; the secret follows #, which a browser never sends to a server. */
export const RECORD_LINK_PAGE = '/shared';

const Closed = { additionalProperties: false } as const;
const Id = Type.String({ minLength: 1, maxLength: 200 });
const Time = Type.String({ format: 'date-time' });
const Digest = Type.String({ pattern: '^[a-f0-9]{64}$' });
const PersonRef = Type.Object({ id: Id, name: Type.String() }, Closed);
const Text = (maxLength: number, description: string) =>
  Type.String({ minLength: 1, maxLength, pattern: '\\S', description });

export const RecordLinkCreateSchema = Type.Object(
  {
    note: Text(300, 'Who the link is for and why, in your words. Shown with the link and kept with its creation.'),
    expiresInDays: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: RECORD_LINK_MAX_DAYS,
        description: `How many days the link opens the set. ${RECORD_LINK_DEFAULT_DAYS} unless given; ${RECORD_LINK_MAX_DAYS} at most.`,
      }),
    ),
  },
  { ...Closed, description: 'Make a link to one produced set of records. Its secret is returned once.' },
);
export type RecordLinkCreate = Static<typeof RecordLinkCreateSchema>;

export const RecordLinkRevokeSchema = Type.Object(
  { reason: Text(1000, 'Why the link is revoked. Kept with the revocation.') },
  Closed,
);
export type RecordLinkRevoke = Static<typeof RecordLinkRevokeSchema>;

export const recordLinkOpenedValues = ['page', 'file', 'archive'] as const;
export const RecordLinkOpeningSchema = Type.Object(
  {
    openedAt: Time,
    opened: Type.Union(
      recordLinkOpenedValues.map((value) => Type.Literal(value)),
      {
        description: 'The page, one file of the set, or the whole .zip.',
      },
    ),
    path: Type.Union([Type.String(), Type.Null()], { description: 'The file opened, for a file.' }),
  },
  { ...Closed, description: 'One opening of a link. Who opened it is not kept.' },
);
export type RecordLinkOpening = Static<typeof RecordLinkOpeningSchema>;

export const RecordLinkSchema = Type.Object(
  {
    id: Id,
    productionId: Id,
    note: Type.String(),
    createdBy: PersonRef,
    createdAt: Time,
    expiresAt: Time,
    revokedBy: Type.Union([PersonRef, Type.Null()]),
    revokedAt: Type.Union([Time, Type.Null()]),
    revokeReason: Type.Union([Type.String(), Type.Null()]),
    state: Type.Union([Type.Literal('open'), Type.Literal('expired'), Type.Literal('revoked')], {
      description: 'open: the link opens the set now.',
    }),
    openings: Type.Array(RecordLinkOpeningSchema, { description: 'Newest first, at most 200.' }),
  },
  Closed,
);
export type RecordLink = Static<typeof RecordLinkSchema>;

export const RecordLinkCreatedSchema = Type.Object(
  {
    link: RecordLinkSchema,
    secret: Type.String({
      pattern: RECORD_LINK_SECRET_PATTERN,
      description: `Shown once. The link is ${RECORD_LINK_PAGE}# followed by the secret, on the web app’s address.`,
    }),
  },
  Closed,
);
export type RecordLinkCreated = Static<typeof RecordLinkCreatedSchema>;
export const RecordLinkResponseSchema = Type.Object({ link: RecordLinkSchema }, Closed);
export type RecordLinkResponse = Static<typeof RecordLinkResponseSchema>;
export const RecordLinkListSchema = Type.Object({ links: Type.Array(RecordLinkSchema) }, Closed);
export type RecordLinkList = Static<typeof RecordLinkListSchema>;
export const RecordLinkParamsSchema = Type.Object({ id: Id }, Closed);
export type RecordLinkParams = Static<typeof RecordLinkParamsSchema>;

// What the page a link opens may read. Every request carries the secret in its body, never in its address.

const Secret = Type.String({ minLength: 1, maxLength: 200, description: 'The secret after # in the link.' });
export const SharedRecordsRequestSchema = Type.Object({ secret: Secret }, Closed);
export type SharedRecordsRequest = Static<typeof SharedRecordsRequestSchema>;
export const SharedRecordsFileRequestSchema = Type.Object(
  { secret: Secret, path: Type.String({ minLength: 1, maxLength: 500 }) },
  Closed,
);
export type SharedRecordsFileRequest = Static<typeof SharedRecordsFileRequestSchema>;

export const SharedRecordsFileSchema = Type.Object(
  {
    path: Type.String(),
    role: Type.Union([
      Type.Literal('index'),
      Type.Literal('records'),
      Type.Literal('original'),
      Type.Literal('manifest'),
    ]),
    contentType: Type.String(),
    byteLength: Type.Integer({ minimum: 0 }),
    sha256: Type.Union([Digest, Type.Null()], {
      description: 'From manifest.json; null for manifest.json itself, whose digest is manifestSha256.',
    }),
  },
  Closed,
);
export type SharedRecordsFile = Static<typeof SharedRecordsFileSchema>;

export const SharedRecordsSchema = Type.Object(
  {
    organization: Type.Object({ name: Type.String(), timeZone: Type.String() }, Closed),
    set: Type.Object(
      {
        reason: Type.String({ description: 'Why the records were produced, as the file prints it.' }),
        requestedBy: Type.String(),
        producedAt: Time,
        producedBy: Type.String({ description: 'The name of the person who produced them.' }),
        records: Type.Integer({ minimum: 0 }),
        archiveSha256: Digest,
        manifestSha256: Digest,
        byteLength: Type.Integer({ minimum: 1 }),
      },
      Closed,
    ),
    files: Type.Array(SharedRecordsFileSchema),
    expiresAt: Time,
  },
  {
    ...Closed,
    description:
      'One produced set of records as its link shows it. Expired, revoked and unknown links all answer 404 record_link_not_in_use.',
  },
);
export type SharedRecords = Static<typeof SharedRecordsSchema>;
