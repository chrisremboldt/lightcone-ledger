import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import { parseOrganizationSetup, setUpOrganization } from '../../apps/api/src/organization-setup.js';
import type { SignInConfiguration, SmsSigningPreviewResponse } from '../../packages/contracts/src/index.js';
import { exampleRiskMatrix } from '../../packages/domain/src/sms-example-matrix.js';
import { sha256 } from '../../packages/integrity/src/index.js';
import { createPool, MemoryObjectStore } from '../../packages/persistence/src/index.js';
import { pkceChallenge } from '../../apps/web/src/openid-connect.js';
import { startTestIssuer, type TestIssuer } from '../oidc/test-issuer.js';
import { databaseNow, settleOwnedWork } from './worker-queue.js';

const run = randomUUID().slice(0, 8);
const owned = `tenant-oidc-${run}`;
const CLIENT = 'ledger-test-web';
const REDIRECT = 'http://127.0.0.1:5173/';
const people = {
  administrator: `oidc-administrator-${run}`,
  dispatcher: `oidc-dispatcher-${run}`,
  executive: `oidc-executive-${run}`,
};

describe.runIf(process.env.LEDGER_ENV !== 'staging')('Sign-in through an OpenID Connect issuer', () => {
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const store = new MemoryObjectStore();
  const providerRequests: string[] = [];
  let issuer: TestIssuer;
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeAll(async () => {
    issuer = await startTestIssuer({
      people: Object.values(people).map((subject) => ({ subject, name: subject })),
      clients: [{ clientId: CLIENT, redirectUris: [REDIRECT] }],
    });
    app = await createApp({
      pool,
      env: 'test',
      objectStore: store,
      signIn: { deploymentName: 'Fictional Ridge Survey', issuers: [{ issuer: issuer.url, clientId: CLIENT }] },
      identityProvider: {
        keyRefetchCooldownMs: 0,
        fetch: ((input: string | URL | Request, init?: RequestInit) => {
          providerRequests.push(String(input instanceof Request ? input.url : input));
          return fetch(input, init);
        }) as typeof fetch,
      },
    });
    await app.ready();
  });
  afterAll(async () => {
    await settleOwnedWork([owned], { objectStore: store });
    await app?.close();
    await issuer?.close();
    await pool.end();
    await admin.end();
  });

  const call = (token: string, method: 'GET' | 'POST', url: string, payload?: object) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
      ...(payload ? { payload } : {}),
    });

  /** The web app's flow, step by step: authorize with PKCE as the named test person, then exchange the code. */
  async function signIn(subject: string, options: { confirm?: boolean } = {}): Promise<string> {
    const configuration = (await app.inject({ method: 'GET', url: '/v1/sign-in' })).json() as SignInConfiguration;
    const entry = configuration.issuers[0]!;
    const verifier = randomUUID() + randomUUID();
    const state = randomUUID();
    const authorize = new URL(entry.authorizationEndpoint!);
    for (const [name, value] of Object.entries({
      response_type: 'code',
      client_id: CLIENT,
      redirect_uri: REDIRECT,
      scope: 'openid profile',
      state,
      nonce: randomUUID(),
      code_challenge: await pkceChallenge(verifier),
      code_challenge_method: 'S256',
      login_hint: subject,
      ...(options.confirm ? { max_age: '0', prompt: 'login' } : {}),
    }))
      authorize.searchParams.set(name, value);
    const redirected = await fetch(authorize, { redirect: 'manual' });
    expect(redirected.status).toBe(302);
    const back = new URL(redirected.headers.get('location')!);
    expect(back.searchParams.get('state')).toBe(state);
    const tokens = await fetch(entry.tokenEndpoint!, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: back.searchParams.get('code')!,
        redirect_uri: REDIRECT,
        client_id: CLIENT,
        code_verifier: verifier,
      }),
    });
    expect(tokens.status).toBe(200);
    return ((await tokens.json()) as { id_token: string }).id_token;
  }

  it('discovers the issuer and publishes only what the web app needs before sign-in', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/sign-in' });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      deploymentName: 'Fictional Ridge Survey',
      issuers: [
        {
          issuer: issuer.url,
          clientId: CLIENT,
          label: new URL(issuer.url).host,
          authorizationEndpoint: `${issuer.url}/authorize`,
          tokenEndpoint: `${issuer.url}/token`,
          endSessionEndpoint: `${issuer.url}/logout`,
        },
      ],
      developmentTokens: true,
    });
    expect(issuer.requests.get('/.well-known/openid-configuration')).toBe(1);
  });

  it('signs in the administrator org:create tied, who adds a person who then signs in too', async () => {
    const setup = parseOrganizationSetup([
      '--name',
      `Fictional Ridge Survey ${run}`,
      '--time-zone',
      'America/Denver',
      '--admin',
      'Robin Vale',
      '--id',
      `oidc-${run}`,
      '--sign-in-issuer',
      issuer.url,
      '--sign-in-subject',
      people.administrator,
    ]);
    const created = await setUpOrganization(admin, setup, 'test', [issuer.url]);
    expect(created).toMatchObject({ created: true });

    const administrator = await signIn(people.administrator);
    const me = await call(administrator, 'GET', '/v1/me');
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json().principal).toMatchObject({ name: 'Robin Vale', tenantId: setup.tenantId });

    const elsewhere = await call(administrator, 'POST', '/v1/commands', {
      kind: 'person.add',
      name: 'Casey Lund',
      principalKind: 'human',
      capabilities: ['flight:read'],
      signIn: { issuer: 'https://unconfigured.example.invalid', subject: people.dispatcher },
    });
    expect(elsewhere.statusCode).toBe(400);
    expect(elsewhere.json().error.code).toBe('sign_in_issuer_unknown');
    const added = await call(administrator, 'POST', '/v1/commands', {
      kind: 'person.add',
      name: 'Casey Lund',
      principalKind: 'human',
      capabilities: ['flight:read'],
      signIn: { issuer: issuer.url, subject: people.dispatcher },
    });
    expect(added.statusCode, added.body).toBe(201);

    const dispatcher = await signIn(people.dispatcher);
    const dispatcherMe = await call(dispatcher, 'GET', '/v1/me');
    expect(dispatcherMe.statusCode, dispatcherMe.body).toBe(200);
    expect(dispatcherMe.json().principal).toMatchObject({ name: 'Casey Lund', capabilities: ['flight:read'] });

    await admin.query('UPDATE principals SET active=false WHERE id=$1', [added.json().command.payload.principalId]);
    const inactive = await call(dispatcher, 'GET', '/v1/me');
    expect(inactive.statusCode).toBe(401);
    // An account tied to someone is refused as before, with nothing about the account.
    expect(inactive.json().error.code).toBe('unauthenticated');
    expect(inactive.json().error.details).toBeUndefined();
  });

  it('refuses an expired token, a wrong audience and a subject tied to no one', async () => {
    const expired = await call(
      await issuer.mint({ subject: people.administrator, audience: CLIENT, expiresInSeconds: -120 }),
      'GET',
      '/v1/me',
    );
    expect(expired.statusCode).toBe(401);
    expect(expired.json().error.message).toContain('expired');
    const audience = await call(
      await issuer.mint({ subject: people.administrator, audience: 'another-client' }),
      'GET',
      '/v1/me',
    );
    expect(audience.statusCode).toBe(401);
    const untied = await call(await issuer.mint({ subject: `nobody-${run}`, audience: CLIENT }), 'GET', '/v1/me');
    expect(untied.statusCode).toBe(401);
    // The person is shown their own account to pass to an administrator, and what the administrator does with it.
    expect(untied.json().error).toEqual({
      code: 'sign_in_account_not_tied',
      message: expect.stringContaining('this account is not tied to anyone in Ledger'),
      details: { issuer: issuer.url, subject: `nobody-${run}` },
    });
    expect(untied.json().error.message).toContain('On the People screen they add you');
    expect(untied.body).not.toContain(people.administrator);
    expect((await call(await issuer.mint({ subject: people.administrator }), 'GET', '/v1/me')).statusCode).toBe(200);
  });

  it('refuses a token from an issuer that is not configured without calling any provider', async () => {
    const before = providerRequests.length;
    const foreign = await call(
      await issuer.mint({ subject: people.administrator, issuer: 'https://unconfigured.example.invalid' }),
      'GET',
      '/v1/me',
    );
    expect(foreign.statusCode).toBe(401);
    expect(providerRequests.length).toBe(before);
  });

  it('picks up a rotated signing key', async () => {
    const before = await signIn(people.administrator);
    await issuer.rotate();
    const after = await signIn(people.administrator);
    expect((await call(after, 'GET', '/v1/me')).statusCode).toBe(200);
    // The earlier key is no longer published, so a token it signed is no longer accepted.
    expect((await call(before, 'GET', '/v1/me')).statusCode).toBe(401);
    expect(
      (await call(await issuer.mint({ subject: people.administrator, unpublishedKey: true }), 'GET', '/v1/me'))
        .statusCode,
    ).toBe(401);
  });

  it('refuses a signature on a stale sign-in and accepts it after a new one', async () => {
    const tenant = `${owned}-signing`;
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenant, 'Fictional Ridge Survey signing']);
    const safetyToken = `ledger-dev-${tenant}:safety`;
    const executiveId = `${tenant}:executive`;
    await admin.query('INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,$4,$5)', [
      `${tenant}:safety`,
      tenant,
      'Fictional Safety Manager',
      'human',
      ['sms:read', 'sms:write', 'sms:configure', 'decision:write', 'evidence:read'],
    ]);
    await admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [
      sha256(safetyToken),
      `${tenant}:safety`,
    ]);
    await admin.query(
      `INSERT INTO principals(id,tenant_id,name,kind,capabilities,sign_in_issuer,sign_in_subject)
       VALUES($1,$2,$3,'human',$4,$5,$6)`,
      [
        executiveId,
        tenant,
        'Fictional Accountable Executive',
        ['sms:read', 'sms:adopt', 'decision:write', 'evidence:read'],
        issuer.url,
        people.executive,
      ],
    );
    await admin.query(
      "INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,'Worker','worker',$3)",
      [`${tenant}:worker`, tenant, ['input:write', 'flight:create', 'flight:read', 'evidence:read']],
    );
    const opened = await call(safetyToken, 'POST', '/v1/commands', {
      kind: 'sms.record.open',
      record: {
        kind: 'risk_matrix',
        schema: 'sms.risk-matrix.1',
        title: 'Program safety risk matrix',
        ownerId: executiveId,
        body: exampleRiskMatrix,
      },
    });
    expect(opened.statusCode, opened.body).toBe(201);
    const recordId = opened.json().command.subject.id as string;

    const stale = await issuer.mint({
      subject: people.executive,
      audience: CLIENT,
      authTime: Math.floor(Date.parse(await databaseNow(pool)) / 1000) - 600,
    });
    const shownResponse = await call(stale, 'GET', `/v1/sms/records/${recordId}/signing?meaning=matrix.adopt`);
    expect(shownResponse.statusCode, shownResponse.body).toBe(200);
    const shown = shownResponse.json() as SmsSigningPreviewResponse;
    expect(shown).toMatchObject({ available: true, reauthentication: 'openid_connect' });
    const adoption = {
      kind: 'decision.record',
      subject: { kind: 'sms', id: recordId },
      expectedRevision: shown.basis.revision,
      expectedDependencyBasis: shown.basis.dependencyBasis,
      decision: {
        kind: 'matrix.adopt',
        note: 'Adopting the program matrix for fictional testing.',
        versionNumber: 1,
        signature: { intent: shown.intent!, contentDigest: shown.contentDigest!, reviewed: true },
      },
    };
    const refused = await call(stale, 'POST', '/v1/commands', adoption);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toMatchObject({
      code: 'reauthentication_required',
      details: { method: 'openid_connect' },
    });
    const withoutAuthTime = await issuer.mint({ subject: people.executive, audience: CLIENT, authTime: null });
    expect((await call(withoutAuthTime, 'POST', '/v1/commands', adoption)).statusCode).toBe(403);

    const signedInAgain = await signIn(people.executive, { confirm: true });
    const adopted = await call(signedInAgain, 'POST', '/v1/commands', adoption);
    expect(adopted.statusCode, adopted.body).toBe(201);
    const detail = await call(signedInAgain, 'GET', `/v1/sms/records/${recordId}`);
    expect(detail.statusCode, detail.body).toBe(200);
    const signature = (
      detail.json() as { signatures: { reauthentication: { method: string; authenticatedAt?: string } }[] }
    ).signatures[0]!;
    expect(signature.reauthentication).toMatchObject({ method: 'openid_connect' });
    expect(Date.parse(signature.reauthentication.authenticatedAt!)).toBeGreaterThan(0);
  });
});
