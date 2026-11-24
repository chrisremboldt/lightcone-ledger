import { Type, type Static } from '@sinclair/typebox';

const Id = Type.String({ minLength: 1, maxLength: 200 });
const Time = Type.String({ format: 'date-time' });

/** Every credential secret starts with this; the API tells a source's or service's bearer token by it. */
export const CREDENTIAL_SECRET_PREFIX = 'ledger-service-';
/** 32 bytes from the system random source, base64url without padding. */
export const CREDENTIAL_SECRET_PATTERN = '^ledger-service-[A-Za-z0-9_-]{43}$';
export const CREDENTIAL_LIST_LIMIT = 1000;

export const CredentialIssueCommandSchema = Type.Object(
  {
    kind: Type.Literal('credential.issue'),
    principalId: Id,
    label: Type.String({
      minLength: 1,
      maxLength: 200,
      pattern: '\\S',
      description: 'What the credential is for, in words the administrator will recognise when revoking it.',
    }),
    expiresAt: Type.Optional(
      Type.String({
        format: 'date-time',
        description: 'When the credential stops being accepted. Must be later than now. Omitted: until revoked.',
      }),
    ),
  },
  {
    additionalProperties: false,
    description:
      'Issues a credential to an active source or service of the organization. Requires authority:write. The server generates the secret and returns it once, in this response; Ledger keeps only its SHA-256 hash, so a retry with the same idempotency key is refused rather than shown the secret again.',
  },
);
export type CredentialIssueCommand = Static<typeof CredentialIssueCommandSchema>;

export const CredentialRevokeCommandSchema = Type.Object(
  { kind: Type.Literal('credential.revoke'), credentialId: Id },
  {
    additionalProperties: false,
    description:
      'Revokes one credential of the organization. Requires authority:write. It is refused from the next request on; a revoked credential is never accepted again.',
  },
);
export type CredentialRevokeCommand = Static<typeof CredentialRevokeCommandSchema>;

export const CredentialCommandSchemas = [CredentialIssueCommandSchema, CredentialRevokeCommandSchema] as const;

export const IssuedCredentialSchema = Type.Object(
  {
    id: Id,
    principalId: Id,
    secret: Type.String({ pattern: CREDENTIAL_SECRET_PATTERN }),
  },
  {
    additionalProperties: false,
    description:
      'The new credential and its secret. This is the only time the secret is returned: it is in no read, log or journal entry. Send it as a bearer token.',
  },
);
export type IssuedCredential = Static<typeof IssuedCredentialSchema>;

const PrincipalNameSchema = Type.Object({ id: Id, name: Type.String() }, { additionalProperties: false });

export const credentialStateValues = ['usable', 'expired', 'revoked'] as const;
export const CredentialEntrySchema = Type.Object(
  {
    id: Id,
    principal: Type.Object(
      {
        id: Id,
        name: Type.String(),
        kind: Type.Union([Type.Literal('source'), Type.Literal('service')]),
        active: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    label: Type.Optional(Type.String()),
    issuedBy: Type.Optional(PrincipalNameSchema),
    issuedAt: Type.Optional(Time),
    expiresAt: Type.Optional(Time),
    revokedBy: Type.Optional(PrincipalNameSchema),
    revokedAt: Type.Optional(Time),
    state: Type.Union(
      credentialStateValues.map((value) => Type.Literal(value)),
      {
        description:
          'usable: neither revoked nor expired (the source or service must also be active to be accepted); expired: past its expiry; revoked.',
      },
    ),
  },
  {
    additionalProperties: false,
    description:
      'One credential, without its secret or hash. A credential with no label, issuer or issue time was put on file by the database owner (the development seeds do this), not issued through Ledger.',
  },
);
export type CredentialEntry = Static<typeof CredentialEntrySchema>;

export const CredentialListResponseSchema = Type.Object(
  {
    credentials: Type.Array(CredentialEntrySchema, { maxItems: CREDENTIAL_LIST_LIMIT }),
    hasMore: Type.Boolean(),
  },
  {
    additionalProperties: false,
    description: `Every credential of the organization's sources and services, usable ones first, newest first. Requires authority:write. Private, no-store. At most ${CREDENTIAL_LIST_LIMIT} entries; hasMore says whether more exist.`,
  },
);
export type CredentialListResponse = Static<typeof CredentialListResponseSchema>;
