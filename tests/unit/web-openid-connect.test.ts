import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  authorizationUrl,
  checkIdToken,
  confirmAccountTied,
  exchangeCode,
  isCallback,
  newTransaction,
  OpenIdSession,
  parseCallback,
  ProviderUnreachableError,
  readSignInConfiguration,
  pkceChallenge,
  takeTransaction,
  saveTransaction,
  UntiedAccountError,
  withoutCallback,
  type IssuerEntry,
} from '../../apps/web/src/openid-connect.js';

const entry: IssuerEntry = {
  issuer: 'https://id.example.test/realms/ledger',
  clientId: 'ledger-web',
  label: 'Example ID',
  authorizationEndpoint: 'https://id.example.test/realms/ledger/auth',
  tokenEndpoint: 'https://id.example.test/realms/ledger/token',
};
const redirect = 'https://ledger.example.test/';
const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const idToken = (claims: Record<string, unknown>) => `${segment({ alg: 'ES256' })}.${segment(claims)}.signature`;

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

describe('The web sign-in flow', () => {
  it('makes the S256 PKCE challenge of RFC 7636', async () => {
    // The example of RFC 7636, appendix B.
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
    const verifier = newTransaction(entry, redirect, 0).verifier;
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(await pkceChallenge(verifier)).toBe(createHash('sha256').update(verifier).digest('base64url'));
  });

  it('asks for a code with PKCE, state and nonce, and for a new sign-in when confirming', async () => {
    const transaction = newTransaction(entry, redirect, 1000);
    const url = new URL(await authorizationUrl(entry, transaction));
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'ledger-web',
      redirect_uri: redirect,
      scope: 'openid profile',
      state: transaction.state,
      nonce: transaction.nonce,
      code_challenge: await pkceChallenge(transaction.verifier),
      code_challenge_method: 'S256',
    });
    expect(url.searchParams.has('max_age')).toBe(false);
    expect(url.searchParams.has('client_secret')).toBe(false);
    const confirming = new URL(await authorizationUrl(entry, transaction, { confirm: true }));
    expect(confirming.searchParams.get('max_age')).toBe('0');
    expect(confirming.searchParams.get('prompt')).toBe('login');
    expect(newTransaction(entry, redirect, 0).state).not.toBe(transaction.state);
  });

  it('accepts only the answer to its own transaction, once', () => {
    const transaction = newTransaction(entry, redirect, 1000);
    const storage = new MemoryStorage() as unknown as Storage;
    saveTransaction(storage, transaction);
    const answer = `${redirect}?code=abc&state=${transaction.state}&iss=${encodeURIComponent(entry.issuer)}`;
    expect(isCallback(answer)).toBe(true);
    expect(isCallback(`${redirect}?state=x`)).toBe(false);
    const taken = takeTransaction(storage);
    expect(parseCallback(answer, taken)).toEqual({ code: 'abc' });
    expect(takeTransaction(storage)).toBeNull();
    expect(() => parseCallback(answer, null)).toThrow('not started here');
    expect(() => parseCallback(`${redirect}?code=abc&state=other`, transaction)).toThrow('not started here');
    expect(() =>
      parseCallback(`${redirect}?code=abc&state=${transaction.state}&iss=https://other.example.test`, transaction),
    ).toThrow('different sign-in provider');
    expect(() => parseCallback(`${redirect}?error=access_denied&state=${transaction.state}`, transaction)).toThrow(
      'cancelled',
    );
    expect(withoutCallback(`${answer}&keep=1`)).toBe(`${redirect}?keep=1`);
  });

  it('checks the ID token answers this sign-in: issuer, audience, nonce, expiry and a fresh sign-in', () => {
    const expected = { issuer: entry.issuer, clientId: entry.clientId, nonce: 'n-1', nowSeconds: 1000 };
    const good = { iss: entry.issuer, aud: entry.clientId, nonce: 'n-1', exp: 1300, auth_time: 990 };
    expect(checkIdToken(idToken(good), expected)).toMatchObject({ expiresAt: 1_300_000, authTime: 990 });
    expect(checkIdToken(idToken({ ...good, aud: ['other', entry.clientId] }), expected).authTime).toBe(990);
    expect(() => checkIdToken(idToken({ ...good, iss: 'https://other.example.test' }), expected)).toThrow(
      'different sign-in provider',
    );
    expect(() => checkIdToken(idToken({ ...good, aud: 'other' }), expected)).toThrow('different client');
    expect(() => checkIdToken(idToken({ ...good, nonce: 'n-2' }), expected)).toThrow('does not answer');
    expect(() => checkIdToken(idToken({ ...good, exp: 900 }), expected)).toThrow('expired');
    expect(() => checkIdToken('not-a-token', expected)).toThrow('unreadable');
    expect(checkIdToken(idToken(good), { ...expected, signedInAfter: 995 }).authTime).toBe(990);
    expect(() => checkIdToken(idToken(good), { ...expected, signedInAfter: 1100 })).toThrow('did not ask you');
    const { auth_time: _, ...noAuthTime } = good;
    expect(() => checkIdToken(idToken(noAuthTime), { ...expected, signedInAfter: 995 })).toThrow('auth_time');
  });

  it('exchanges the code as a public client with the PKCE verifier and no secret', async () => {
    const transaction = newTransaction(entry, redirect, 1000);
    const sent: { url: string; body: URLSearchParams }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      sent.push({ url, body: new URLSearchParams(String(init.body)) });
      return Response.json({
        id_token: idToken({ iss: entry.issuer, aud: entry.clientId, nonce: transaction.nonce, exp: 2000 }),
        refresh_token: 'refresh-1',
      });
    }) as unknown as typeof fetch;
    const tokens = await exchangeCode(fetcher, entry, transaction, 'abc', { nowSeconds: 1000 });
    expect(tokens).toMatchObject({ refreshToken: 'refresh-1', expiresAt: 2_000_000 });
    expect(sent[0]!.url).toBe(entry.tokenEndpoint);
    expect(Object.fromEntries(sent[0]!.body)).toEqual({
      grant_type: 'authorization_code',
      code: 'abc',
      redirect_uri: redirect,
      client_id: 'ledger-web',
      code_verifier: transaction.verifier,
    });
  });
});

describe('A sign-in without a connection', () => {
  const expiring = { idToken: 'old', refreshToken: 'refresh-1', expiresAt: Date.now() + 10_000 };

  it('is not ended when the provider cannot be reached to renew it, and is renewed once it can', async () => {
    const ended: string[] = [];
    let reachable = false;
    const fetcher = (async () => {
      if (!reachable) throw new TypeError('Failed to fetch');
      const nowSeconds = Math.floor(Date.now() / 1000);
      return Response.json({
        id_token: idToken({ iss: entry.issuer, aud: entry.clientId, exp: nowSeconds + 3600, iat: nowSeconds }),
      });
    }) as unknown as typeof fetch;
    const session = new OpenIdSession(entry, expiring, (reason) => ended.push(reason), fetcher);
    await expect(session.token()).rejects.toBeInstanceOf(ProviderUnreachableError);
    expect(ended).toEqual([]);
    reachable = true;
    expect(await session.token()).not.toBe('old');
    expect(ended).toEqual([]);
  });

  it('says Ledger cannot be reached when the app opens with no connection, not that the sign-in failed', async () => {
    const fetching = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    try {
      await expect(readSignInConfiguration('')).rejects.toThrow(
        'Ledger cannot be reached from this device now. Sign in once there is a connection.',
      );
    } finally {
      globalThis.fetch = fetching;
    }
  });

  it('is ended when the provider answers and refuses to renew it', async () => {
    const ended: string[] = [];
    const fetcher = (async () => Response.json({ error: 'invalid_grant' }, { status: 400 })) as unknown as typeof fetch;
    const session = new OpenIdSession(entry, expiring, (reason) => ended.push(reason), fetcher);
    expect(await session.token()).toBeNull();
    expect(ended).toEqual(['Your sign-in has ended. Sign in again to continue.']);
  });
});

describe('A sign-in for an account tied to no one', () => {
  const answer = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('shows the person their own account and what the administrator does with it', async () => {
    const refused = confirmAccountTied(
      'https://ledger.example.test/',
      'id-token',
      answer(401, {
        error: {
          code: 'sign_in_account_not_tied',
          message: 'You signed in, but this account is not tied to anyone in Ledger.',
          details: { issuer: entry.issuer, subject: 'account-7' },
        },
      }),
    );
    await expect(refused).rejects.toBeInstanceOf(UntiedAccountError);
    await expect(refused).rejects.toMatchObject({ issuer: entry.issuer, subject: 'account-7' });
  });

  it('leaves every other answer to the workspace', async () => {
    await expect(confirmAccountTied('https://ledger.example.test', 't', answer(200, {}))).resolves.toBeUndefined();
    await expect(
      confirmAccountTied(
        'https://ledger.example.test',
        't',
        answer(401, { error: { code: 'unauthenticated', message: 'Credential is invalid' } }),
      ),
    ).resolves.toBeUndefined();
  });
});
