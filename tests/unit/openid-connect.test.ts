import { describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import {
  allowedProviderUrl,
  createTokenVerifier,
  publicSignInConfiguration,
  signInSettings,
  type IssuerSetting,
} from '../../apps/api/src/openid-connect.js';
import { reauthenticator, FRESH_CONFIRMATION_SECONDS } from '../../apps/api/src/sms.js';

const ISSUER = 'https://id.example.test/realms/ledger';
const CLIENT = 'ledger-web';
const ORIGIN = 'https://ledger.example.test';

type Key = { kid: string; privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey']; jwk: JWK };
async function key(kid: string, alg = 'ES256'): Promise<Key> {
  const { privateKey, publicKey } = await generateKeyPair(alg);
  return { kid, privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg } };
}

/** An identity provider in memory: discovery and keys, with every request counted. */
function provider(keys: { current: Key[] }, discovery: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url === `${ISSUER}/.well-known/openid-configuration`)
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/auth`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/certs`,
        ...discovery,
      });
    if (url === `${ISSUER}/certs`) return Response.json({ keys: keys.current.map((entry) => entry.jwk) });
    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

interface Claims {
  iss?: string;
  sub?: string | null;
  aud?: string;
  azp?: string;
  exp?: number | null;
  nbf?: number;
  auth_time?: number;
}
async function sign(signer: Key, claims: Claims = {}, alg = 'ES256') {
  const now = Math.floor(Date.now() / 1000);
  const body: Record<string, unknown> = {
    iss: ISSUER,
    sub: 'person-1',
    aud: CLIENT,
    iat: now,
    exp: now + 300,
    auth_time: now,
    ...claims,
  };
  for (const [name, value] of Object.entries(body)) if (value === null) delete body[name];
  return new SignJWT(body).setProtectedHeader({ alg, kid: signer.kid }).sign(signer.privateKey);
}

function verifier(
  keys: { current: Key[] },
  overrides: Partial<IssuerSetting> = {},
  options: { cooldown?: number; discovery?: Record<string, unknown>; env?: 'local' | 'test' | 'staging' } = {},
) {
  const fake = provider(keys, options.discovery);
  const verify = createTokenVerifier({
    issuers: [{ issuer: ISSUER, clientId: CLIENT, ...overrides }],
    env: options.env ?? 'staging',
    origins: [ORIGIN],
    fetch: fake.fetch,
    keyRefetchCooldownMs: options.cooldown ?? 30_000,
  });
  return { ...verify, calls: fake.calls };
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { status: number; code: string; message: string };
  }
  throw new Error('The token was accepted');
}

const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('OpenID Connect token verification', () => {
  it('accepts a token signed by a published key and returns the issuer, subject and sign-in time', async () => {
    const signer = await key('one');
    const subject = verifier({ current: [signer] });
    const token = await sign(signer, { auth_time: 1_900_000_000 - 60 });
    expect(await subject.verify(token)).toMatchObject({
      issuer: ISSUER,
      subject: 'person-1',
      authTime: 1_900_000_000 - 60,
    });
    await subject.verify(token);
    expect(subject.calls).toEqual([`${ISSUER}/.well-known/openid-configuration`, `${ISSUER}/certs`]);
  });

  it('refuses a token from an issuer that is not configured before any network call', async () => {
    const signer = await key('one');
    const subject = verifier({ current: [signer] });
    const error = await refusal(subject.verify(await sign(signer, { iss: 'https://elsewhere.example.test' })));
    expect(error).toMatchObject({ status: 401, code: 'unauthenticated' });
    expect(error.message).toContain('does not accept');
    expect(subject.calls).toEqual([]);
  });

  it('refuses unsigned and shared-secret tokens without fetching anything', async () => {
    const subject = verifier({ current: [await key('one')] });
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: ISSUER, sub: 'person-1', aud: CLIENT, exp: now + 300 };
    const unsigned = `${segment({ alg: 'none' })}.${segment(claims)}.`;
    expect(await refusal(subject.verify(unsigned))).toMatchObject({ status: 401 });
    const shared = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256', kid: 'one' })
      .sign(new TextEncoder().encode('a shared secret of thirty-two bytes!'));
    expect(await refusal(subject.verify(shared))).toMatchObject({ status: 401 });
    expect(await refusal(subject.verify('not a token'))).toMatchObject({ status: 401 });
    expect(subject.calls).toEqual([]);
  });

  it('refuses an expired token and one not yet valid, with a small clock tolerance', async () => {
    const signer = await key('one');
    const subject = verifier({ current: [signer] });
    const now = Math.floor(Date.now() / 1000);
    const expired = await refusal(subject.verify(await sign(signer, { exp: now - 120 })));
    expect(expired).toMatchObject({ status: 401 });
    expect(expired.message).toContain('expired');
    expect(await subject.verify(await sign(signer, { exp: now - 10 }))).toMatchObject({ subject: 'person-1' });
    expect(await refusal(subject.verify(await sign(signer, { nbf: now + 120 })))).toMatchObject({ status: 401 });
    expect(await refusal(subject.verify(await sign(signer, { exp: null })))).toMatchObject({ status: 401 });
    expect(await refusal(subject.verify(await sign(signer, { sub: null })))).toMatchObject({ status: 401 });
  });

  it('refuses a token for another audience', async () => {
    const signer = await key('one');
    const subject = verifier({ current: [signer] });
    expect(await refusal(subject.verify(await sign(signer, { aud: 'another-client' })))).toMatchObject({
      status: 401,
    });
  });

  it('checks the authorized party when present, or against the origins when the issuer asks for it', async () => {
    const signer = await key('one');
    const plain = verifier({ current: [signer] });
    expect(await refusal(plain.verify(await sign(signer, { azp: 'another-client' })))).toMatchObject({ status: 401 });
    expect(await plain.verify(await sign(signer, { azp: CLIENT }))).toMatchObject({ subject: 'person-1' });
    const checked = verifier({ current: [signer] }, { checkAuthorizedParty: true });
    expect(await checked.verify(await sign(signer, { azp: ORIGIN }))).toMatchObject({ subject: 'person-1' });
    expect(await refusal(checked.verify(await sign(signer)))).toMatchObject({ status: 401 });
    expect(await refusal(checked.verify(await sign(signer, { azp: 'https://other.example.test' })))).toMatchObject({
      status: 401,
    });
  });

  it('refetches keys for an unknown key id at most once per cooldown', async () => {
    const signer = await key('one');
    const stranger = await key('stranger');
    const subject = verifier({ current: [signer] });
    await subject.verify(await sign(signer));
    const keyFetches = () => subject.calls.filter((url) => url.endsWith('/certs')).length;
    expect(keyFetches()).toBe(1);
    for (let attempt = 0; attempt < 5; attempt++)
      expect(await refusal(subject.verify(await sign(stranger)))).toMatchObject({ status: 401 });
    // The keys were fetched moments ago, so a flood of unknown key ids fetches nothing more.
    expect(keyFetches()).toBe(1);
  });

  it('picks up a rotated key once the cooldown has passed', async () => {
    const first = await key('first');
    const keys = { current: [first] };
    const subject = verifier(keys, {}, { cooldown: 0 });
    await subject.verify(await sign(first));
    const second = await key('second');
    keys.current = [second];
    expect(await subject.verify(await sign(second))).toMatchObject({ subject: 'person-1' });
    expect(await refusal(subject.verify(await sign(first)))).toMatchObject({ status: 401 });
  });

  it('refuses a signature no published key makes, even under a published key id', async () => {
    const signer = await key('one');
    const impostor = await key('one');
    const subject = verifier({ current: [signer] });
    expect(await refusal(subject.verify(await sign(impostor)))).toMatchObject({ status: 401 });
  });

  it('treats a provider whose discovery is wrong or not https as unavailable, and waits before asking again', async () => {
    const signer = await key('one');
    const wrongIssuer = verifier(
      { current: [signer] },
      {},
      { discovery: { issuer: 'https://elsewhere.example.test' } },
    );
    expect(await refusal(wrongIssuer.verify(await sign(signer)))).toMatchObject({
      status: 503,
      code: 'identity_provider_unavailable',
    });
    expect(await refusal(wrongIssuer.verify(await sign(signer)))).toMatchObject({ status: 503 });
    expect(wrongIssuer.calls).toHaveLength(1);
    const plainKeys = verifier({ current: [signer] }, {}, { discovery: { jwks_uri: 'http://id.example.test/certs' } });
    expect(await refusal(plainKeys.verify(await sign(signer)))).toMatchObject({ status: 503 });
    expect(plainKeys.calls.some((url) => url.startsWith('http:'))).toBe(false);
  });

  it('publishes only public values for the web app', async () => {
    const signer = await key('one');
    const subject = verifier({ current: [signer] }, { label: 'Example ID' });
    const settings = {
      deploymentName: 'Example Survey',
      issuers: [{ issuer: ISSUER, clientId: CLIENT, label: 'Example ID' }],
    };
    expect(await publicSignInConfiguration(settings, subject, 'staging')).toEqual({
      deploymentName: 'Example Survey',
      issuers: [
        {
          issuer: ISSUER,
          clientId: CLIENT,
          label: 'Example ID',
          authorizationEndpoint: `${ISSUER}/auth`,
          tokenEndpoint: `${ISSUER}/token`,
        },
      ],
      developmentTokens: false,
    });
  });
});

describe('OpenID Connect settings', () => {
  it('reads one issuer from a pair of variables, or several from a JSON list', () => {
    expect(
      signInSettings('staging', {
        LEDGER_OIDC_ISSUER: ISSUER,
        LEDGER_OIDC_CLIENT_ID: CLIENT,
        LEDGER_OIDC_LABEL: 'Example ID',
      }),
    ).toEqual({ deploymentName: 'Ledger', issuers: [{ issuer: ISSUER, clientId: CLIENT, label: 'Example ID' }] });
    expect(
      signInSettings('staging', {
        LEDGER_DEPLOYMENT_NAME: 'Example Survey',
        LEDGER_OIDC_ISSUERS: JSON.stringify([
          { issuer: ISSUER, clientId: CLIENT },
          { issuer: 'https://other.example.test', clientId: 'ledger', checkAuthorizedParty: true },
        ]),
      }),
    ).toEqual({
      deploymentName: 'Example Survey',
      issuers: [
        { issuer: ISSUER, clientId: CLIENT },
        { issuer: 'https://other.example.test', clientId: 'ledger', checkAuthorizedParty: true },
      ],
    });
    expect(signInSettings('local', {})).toEqual({ deploymentName: 'Ledger', issuers: [] });
  });

  it('refuses settings that could never work, at startup', () => {
    expect(() =>
      signInSettings('staging', { LEDGER_OIDC_ISSUER: 'http://id.example.test', LEDGER_OIDC_CLIENT_ID: CLIENT }),
    ).toThrow('https');
    expect(() =>
      signInSettings('staging', { LEDGER_OIDC_ISSUER: 'http://127.0.0.1:4010', LEDGER_OIDC_CLIENT_ID: CLIENT }),
    ).toThrow('https');
    expect(
      signInSettings('test', { LEDGER_OIDC_ISSUER: 'http://127.0.0.1:4010', LEDGER_OIDC_CLIENT_ID: CLIENT }).issuers,
    ).toHaveLength(1);
    expect(() => signInSettings('staging', { LEDGER_OIDC_ISSUER: ISSUER })).toThrow('clientId');
    expect(() => signInSettings('staging', { LEDGER_OIDC_CLIENT_ID: CLIENT })).toThrow('LEDGER_OIDC_ISSUER');
    expect(() =>
      signInSettings('staging', {
        LEDGER_OIDC_ISSUER: ISSUER,
        LEDGER_OIDC_CLIENT_ID: CLIENT,
        LEDGER_OIDC_ISSUERS: '[]',
      }),
    ).toThrow('not both');
    expect(() => signInSettings('staging', { LEDGER_OIDC_ISSUERS: '{' })).toThrow('JSON list');
    expect(() =>
      signInSettings('staging', {
        LEDGER_OIDC_ISSUERS: JSON.stringify([{ issuer: ISSUER, clientId: CLIENT, secret: 'x' }]),
      }),
    ).toThrow('unknown setting secret');
    expect(() =>
      signInSettings('staging', {
        LEDGER_OIDC_ISSUERS: JSON.stringify([
          { issuer: ISSUER, clientId: CLIENT },
          { issuer: ISSUER, clientId: 'again' },
        ]),
      }),
    ).toThrow('twice');
  });

  it('allows plain http only to this machine, and only in local and test', () => {
    expect(allowedProviderUrl('https://id.example.test/x', 'staging')).toBe(true);
    expect(allowedProviderUrl('http://localhost:8080', 'local')).toBe(true);
    expect(allowedProviderUrl('http://[::1]:8080', 'test')).toBe(true);
    expect(allowedProviderUrl('http://localhost:8080', 'staging')).toBe(false);
    expect(allowedProviderUrl('http://id.example.test', 'local')).toBe(false);
    expect(allowedProviderUrl('https://user:pass@id.example.test', 'staging')).toBe(false);
    expect(allowedProviderUrl('ftp://id.example.test', 'local')).toBe(false);
  });
});

describe('A fresh confirmation for a signature', () => {
  const now = new Date('2026-11-21T12:00:00Z');
  const seconds = now.getTime() / 1000;
  const client = { query: async () => ({ rows: [{ now }] }) } as never;
  const who = { id: 'person-1', tenantId: 'tenant-1' } as never;
  const request = { headers: {} } as never;
  const confirm = (authTime?: number) =>
    reauthenticator(
      client,
      who,
      request,
      { issuer: ISSUER, subject: 'person-1', ...(authTime === undefined ? {} : { authTime }) },
      'staging',
    )();

  it('accepts a sign-in at the provider within the window and records when it happened', async () => {
    expect(await confirm(seconds - 60)).toEqual({
      method: 'openid_connect',
      verifiedAt: now.toISOString(),
      authenticatedAt: new Date((seconds - 60) * 1000).toISOString(),
    });
  });

  it('refuses a stale sign-in, a token without auth_time, and one from the future', async () => {
    for (const authTime of [seconds - FRESH_CONFIRMATION_SECONDS - 1, undefined, seconds + 600])
      expect(await refusal(confirm(authTime))).toMatchObject({ status: 403, code: 'reauthentication_required' });
  });
});
