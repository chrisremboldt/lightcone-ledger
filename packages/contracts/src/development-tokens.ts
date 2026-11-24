import { Type, type Static } from '@sinclair/typebox';

// Kept out of the package's main entry, which the web app's production build includes: that build must hold no part
// of a development token. Read it from @ledger/contracts/development-tokens.

/** Every development token starts with this; the API accepts one only on a local or test database. */
export const DEVELOPMENT_TOKEN_PREFIX = 'ledger-dev-';

export const DevelopmentTokenParamsSchema = Type.Object(
  { id: Type.String({ minLength: 1, maxLength: 200 }) },
  { additionalProperties: false },
);
export type DevelopmentTokenParams = Static<typeof DevelopmentTokenParamsSchema>;

export const DevelopmentTokenRequestSchema = Type.Object(
  {
    note: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 2000,
        pattern: '\\S',
        description: 'Why the token is issued, in the words of the administrator issuing it. Kept with the issue.',
      }),
    ),
  },
  { additionalProperties: false },
);
export type DevelopmentTokenRequest = Static<typeof DevelopmentTokenRequestSchema>;

export const DevelopmentTokenResponseSchema = Type.Object(
  {
    developmentToken: Type.Object(
      {
        credentialId: Type.String({ minLength: 1 }),
        principalId: Type.String({ minLength: 1 }),
        token: Type.String({ pattern: '^ledger-dev-[A-Za-z0-9_-]{32}$' }),
      },
      { additionalProperties: false },
    ),
    replacedCredentialIds: Type.Array(Type.String({ minLength: 1 }), {
      description: "The person's earlier tokens, refused from now on.",
    }),
    commandId: Type.String({ minLength: 1 }),
  },
  {
    additionalProperties: false,
    description:
      'A new development token for one active person of the organization, shown only in this response: Ledger keeps only its hash, and no read, log or journal entry holds it. It replaces every earlier token of that person. Refused outside local and test, where a person signs in through the identity provider.',
  },
);
export type DevelopmentTokenResponse = Static<typeof DevelopmentTokenResponseSchema>;
