import { Type, type Static } from '@sinclair/typebox';

/**
 * Notices (docs/design/notices.md): an email to a person, or a call to the organization's webhook, saying that
 * something is theirs or due. Both are off unless configured.
 */

/** What a notice says happened: (a) assigned, (b) due soon, (c) overdue, (d) waiting for acknowledgement, (e) digest. */
export const noticeKindValues = ['assigned', 'due', 'overdue', 'acknowledgement', 'digest'] as const;
export type NoticeKind = (typeof noticeKindValues)[number];
export const noticeChannelValues = ['email', 'webhook'] as const;
export type NoticeChannel = (typeof noticeChannelValues)[number];
export const noticeStateValues = ['waiting', 'sent', 'failed', 'given_up'] as const;
export type NoticeState = (typeof noticeStateValues)[number];
export const noticeDigestValues = ['none', 'daily', 'weekly'] as const;
export type NoticeDigest = (typeof noticeDigestValues)[number];
/** The notices a person chooses to receive by email, one by one; the digest is chosen apart. */
export const noticeEmailChoiceValues = ['assigned', 'due', 'overdue', 'acknowledgement'] as const;
export type NoticeEmailChoice = (typeof noticeEmailChoiceValues)[number];

/** An action is due soon from this many days before its due day. */
export const NOTICE_DUE_SOON_DAYS = 3;
/** A notice is given up after this many failed attempts. */
export const NOTICE_ATTEMPT_LIMIT = 5;
export const NOTICE_LIST_LIMIT = 50;

/** A plain email address: one @, no spaces, no display name. */
export const NOTICE_EMAIL_PATTERN = '^[^@\\s<>",;]+@[^@\\s<>",;]+\\.[^@\\s<>",;]+$';
export const NoticeEmailSchema = Type.String({ minLength: 3, maxLength: 254, pattern: NOTICE_EMAIL_PATTERN });

const Choices = Type.Object(
  {
    assigned: Type.Boolean({ description: 'A finding or an action is assigned to the person.' }),
    due: Type.Boolean({ description: 'An action of theirs is due within three days.' }),
    overdue: Type.Boolean({ description: 'An action of theirs is overdue; sent once.' }),
    acknowledgement: Type.Boolean({ description: 'A document is waiting for their acknowledgement.' }),
  },
  { additionalProperties: false },
);

export const NoticeSettingsSchema = Type.Object(
  {
    email: Type.Union([NoticeEmailSchema, Type.Null()], {
      description: 'Where the person gets email notices; null when no address is kept, and then no email is sent.',
    }),
    choices: Choices,
    digest: Type.Union(noticeDigestValues.map((value) => Type.Literal(value))),
  },
  { additionalProperties: false },
);
export type NoticeSettings = Static<typeof NoticeSettingsSchema>;

export const NoticeSettingsResponseSchema = Type.Object(
  {
    settings: NoticeSettingsSchema,
    emailAvailable: Type.Boolean({ description: 'Whether this Ledger is configured to send email.' }),
  },
  {
    additionalProperties: false,
    description:
      'Where the signed-in person gets notices and which of them arrive by email. Private, no-store. Every person may read their own.',
  },
);
export type NoticeSettingsResponse = Static<typeof NoticeSettingsResponseSchema>;

export const NoticeSettingsUpdateSchema = Type.Object(
  {
    email: Type.Optional(Type.Union([NoticeEmailSchema, Type.Null()])),
    choices: Type.Optional(Type.Partial(Choices, { additionalProperties: false })),
    digest: Type.Optional(Type.Union(noticeDigestValues.map((value) => Type.Literal(value)))),
  },
  { additionalProperties: false },
);
export type NoticeSettingsUpdate = Static<typeof NoticeSettingsUpdateSchema>;

export const NoticeEmailUpdateSchema = Type.Object(
  { email: Type.Union([NoticeEmailSchema, Type.Null()]) },
  { additionalProperties: false },
);
export type NoticeEmailUpdate = Static<typeof NoticeEmailUpdateSchema>;
export const NoticeEmailParamsSchema = Type.Object(
  { id: Type.String({ minLength: 1, maxLength: 200 }) },
  { additionalProperties: false },
);
export type NoticeEmailParams = Static<typeof NoticeEmailParamsSchema>;

export const NoticeWebhookSchema = Type.Object(
  {
    url: Type.String({ description: 'Where each notice is posted.' }),
    setAt: Type.String({ format: 'date-time' }),
    setBy: Type.Object({ id: Type.String(), name: Type.String() }, { additionalProperties: false }),
  },
  { additionalProperties: false },
);
export const NoticeWebhookResponseSchema = Type.Object(
  {
    webhook: Type.Union([NoticeWebhookSchema, Type.Null()]),
    httpAllowed: Type.Boolean({ description: 'Whether an http:// address is accepted; only on a local Ledger.' }),
  },
  {
    additionalProperties: false,
    description: 'The organization’s webhook for notices, never its secret. Private, no-store.',
  },
);
export type NoticeWebhookResponse = Static<typeof NoticeWebhookResponseSchema>;

export const NoticeWebhookUpdateSchema = Type.Object(
  {
    url: Type.Union([Type.String({ minLength: 10, maxLength: 2000, pattern: '^https?://\\S+$' }), Type.Null()], {
      description: 'The https address to post notices to, or null to remove the webhook.',
    }),
  },
  { additionalProperties: false },
);
export type NoticeWebhookUpdate = Static<typeof NoticeWebhookUpdateSchema>;

export const NoticeWebhookSetResponseSchema = Type.Object(
  {
    webhook: Type.Union([NoticeWebhookSchema, Type.Null()]),
    secret: Type.Union([Type.String({ pattern: '^[A-Za-z0-9_-]{43,128}$' }), Type.Null()], {
      description:
        'The secret that signs each call, shown only in this response and never again. Null when the webhook was removed.',
    }),
    commandId: Type.String(),
  },
  { additionalProperties: false },
);
export type NoticeWebhookSetResponse = Static<typeof NoticeWebhookSetResponseSchema>;

export const NoticeListQuerySchema = Type.Object(
  {
    state: Type.Optional(Type.Union(noticeStateValues.map((value) => Type.Literal(value)))),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: NOTICE_LIST_LIMIT, default: NOTICE_LIST_LIMIT })),
  },
  { additionalProperties: false },
);
export type NoticeListQuery = Static<typeof NoticeListQuerySchema>;

export const NoticeEntrySchema = Type.Object(
  {
    id: Type.String(),
    createdAt: Type.String({ format: 'date-time' }),
    kind: Type.Union(noticeKindValues.map((value) => Type.Literal(value))),
    channel: Type.Union(noticeChannelValues.map((value) => Type.Literal(value))),
    recipient: Type.Object({ id: Type.String(), name: Type.String() }, { additionalProperties: false }),
    sentence: Type.String({ description: 'What the notice says happened.' }),
    reference: Type.Union([Type.String(), Type.Null()]),
    path: Type.Union([Type.String(), Type.Null()], { description: 'The address of the record in Ledger.' }),
    state: Type.Union(noticeStateValues.map((value) => Type.Literal(value))),
    attempts: Type.Integer({ minimum: 0 }),
    lastAttemptAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    reason: Type.Union([Type.String(), Type.Null()], { description: 'Why the last attempt failed.' }),
  },
  { additionalProperties: false },
);
export type NoticeEntry = Static<typeof NoticeEntrySchema>;
export const NoticeListResponseSchema = Type.Object(
  {
    notices: Type.Array(NoticeEntrySchema, { maxItems: NOTICE_LIST_LIMIT }),
    hasMore: Type.Boolean(),
    nextCursor: Type.Union([Type.String(), Type.Null()]),
  },
  {
    additionalProperties: false,
    description:
      'Every notice of the organization, newest first, with its state: waiting, sent, failed (with the reason; it will be tried again) or given up. Requires authority:write. Private, no-store.',
  },
);
export type NoticeListResponse = Static<typeof NoticeListResponseSchema>;

export const NoticeSettingsChangeResponseSchema = Type.Object(
  { settings: NoticeSettingsSchema, commandId: Type.String() },
  {
    additionalProperties: false,
    description:
      'The person’s notice settings as recorded. The journal records whether an address is kept and the choices, never the address itself.',
  },
);
export type NoticeSettingsChangeResponse = Static<typeof NoticeSettingsChangeResponseSchema>;
