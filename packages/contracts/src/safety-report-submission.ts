import { Type, type Static } from '@sinclair/typebox';

// What a person sends when they submit a safety report themselves, signed in or through a reporting link, and what
// they get back. See docs/design/report-submission.md.

const Time = Type.String({ format: 'date-time' });
const Text = (maxLength: number, description?: string) =>
  Type.String({ minLength: 1, maxLength, pattern: '\\S', ...(description ? { description } : {}) });
const strict = <T extends Parameters<typeof Type.Object>[0]>(properties: T, description?: string) =>
  Type.Object(properties, { additionalProperties: false, ...(description ? { description } : {}) });

/** The token of a reporting link: 32 random bytes, base64url. */
export const REPORT_LINK_TOKEN_PATTERN = '^ledger-report-[A-Za-z0-9_-]{43}$';
/** A receipt code as shown: five groups of four characters from an alphabet without look-alike characters. */
export const RECEIPT_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** The longest body these routes take, in bytes. */
export const SAFETY_REPORT_BODY_LIMIT = 32 * 1024;

const reportFields = {
  whatWasSeen: Text(8000, 'What happened or what the reporter saw.'),
  occurredAt: Type.Optional(Time),
  where: Type.Optional(Text(200, 'Where it happened: a site, an aircraft or a place people know. Never coordinates.')),
  contact: Type.Optional(
    Text(200, 'An optional way to reach the reporter. Visible to the people cleared to read safety reports.'),
  ),
};

export const SignedInSafetyReportSchema = strict(
  {
    ...reportFields,
    named: Type.Boolean({
      description: 'Whether the signed-in person’s name goes on the report. Without it nothing kept names them.',
    }),
  },
  'A safety report a signed-in person submits.',
);
export type SignedInSafetyReport = Static<typeof SignedInSafetyReportSchema>;

export const LinkSafetyReportSchema = strict(
  { ...reportFields, token: Type.String({ pattern: REPORT_LINK_TOKEN_PATTERN }) },
  'A safety report sent through a reporting link, without signing in. The token is the part of the link after #.',
);
export type LinkSafetyReport = Static<typeof LinkSafetyReportSchema>;

export const SafetyReportReceiptSchema = strict(
  {
    receipt: strict(
      { code: Type.String({ minLength: 24, maxLength: 24 }) },
      'Shown once. Ledger keeps only its SHA-256 and cannot show it again.',
    ),
  },
  'What the reporter is given: a receipt code with which to ask whether the report is received or closed.',
);
export type SafetyReportReceipt = Static<typeof SafetyReportReceiptSchema>;

export const SafetyReportReceiptQuerySchema = strict(
  { code: Type.String({ minLength: 1, maxLength: 64 }) },
  'A receipt code, as shown or typed; spaces, dashes and letter case do not matter.',
);
export type SafetyReportReceiptQuery = Static<typeof SafetyReportReceiptQuerySchema>;

export const safetyReportStatusValues = ['received', 'closed'] as const;
export const SafetyReportStatusSchema = strict(
  { status: Type.Union(safetyReportStatusValues.map((value) => Type.Literal(value))) },
  'All a receipt code tells: whether the report is received or closed.',
);
export type SafetyReportStatus = Static<typeof SafetyReportStatusSchema>;

const PersonRef = strict({ id: Type.String(), name: Type.String() });
export const SafetyReportLinkSchema = strict({
  id: Type.String(),
  label: Type.String(),
  issuedBy: PersonRef,
  issuedAt: Time,
  expiresAt: Type.Union([Time, Type.Null()]),
  revokedBy: Type.Union([PersonRef, Type.Null()]),
  revokedAt: Type.Union([Time, Type.Null()]),
  inForce: Type.Boolean({ description: 'Not revoked and not expired: the link takes reports now.' }),
});
export type SafetyReportLink = Static<typeof SafetyReportLinkSchema>;

export const SafetyReportLinkIssueSchema = strict(
  {
    label: Text(120, 'What people know the link by, such as where it is posted.'),
    expiresAt: Type.Optional(Time),
  },
  'Issue a reporting link. Its token is returned once.',
);
export type SafetyReportLinkIssue = Static<typeof SafetyReportLinkIssueSchema>;

export const SafetyReportLinkIssuedSchema = strict({
  link: SafetyReportLinkSchema,
  token: Type.String({
    pattern: REPORT_LINK_TOKEN_PATTERN,
    description: 'Shown once. The link is /report# followed by the token, on the web app’s address.',
  }),
});
export type SafetyReportLinkIssued = Static<typeof SafetyReportLinkIssuedSchema>;

export const SafetyReportLinkListSchema = strict({ links: Type.Array(SafetyReportLinkSchema) });
export type SafetyReportLinkList = Static<typeof SafetyReportLinkListSchema>;
export const SafetyReportLinkResponseSchema = strict({ link: SafetyReportLinkSchema });
export const SafetyReportLinkParamsSchema = strict({ id: Type.String({ minLength: 1, maxLength: 200 }) });

/** A reporting link in force, as the Safety home names it to anyone who reads safety records. */
export const SafetyReportLinkInForceSchema = strict({
  label: Type.String(),
  expiresAt: Type.Union([Time, Type.Null()]),
});
export type SafetyReportLinkInForce = Static<typeof SafetyReportLinkInForceSchema>;
