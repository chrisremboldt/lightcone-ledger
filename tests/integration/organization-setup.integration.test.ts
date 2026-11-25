import 'dotenv/config';
import { isExamplePack, standardRulePacks } from '../../packages/standard-packs/src/index.js';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import { adoptRulePack, SEEDED_PACK } from '../../apps/api/src/seed-rule-packs.js';
import {
  parseOrganizationSetup,
  setUpOrganization,
  setupEnvironment,
  setupReport,
} from '../../apps/api/src/organization-setup.js';
import { administratorCapabilities } from '../../packages/domain/src/index.js';
import {
  PrincipalAuthorityListResponseSchema,
  type PrincipalAuthorityEntry,
} from '../../packages/contracts/src/index.js';
import { PrincipalResponseSchema } from '../../packages/contracts/src/openapi.js';
import { sha256 } from '../../packages/integrity/src/index.js';
import { authenticate, createPool, MemoryObjectStore, seed } from '../../packages/persistence/src/index.js';
import { settleOwnedWork } from './worker-queue.js';

const run = randomUUID().slice(0, 8);
// The issuers the API would accept, as org:create reads them from LEDGER_OIDC_ISSUER or LEDGER_OIDC_ISSUERS.
const accepted = ['https://identity.example.invalid'];
const owned = `tenant-org-setup-${run}`;

describe.runIf(process.env.LEDGER_ENV !== 'staging')('Creating an organization and its people', () => {
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  const validMe = ajv.compile(PrincipalResponseSchema);
  const validList = ajv.compile(PrincipalAuthorityListResponseSchema);
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeAll(async () => {
    app = await createApp({ pool, env: 'test', objectStore: new MemoryObjectStore() });
    await app.ready();
  });
  afterAll(async () => {
    await settleOwnedWork([owned]);
    await app?.close();
    await pool.end();
    await admin.end();
  });

  const options = (suffix: string, extra: string[] = []) =>
    parseOrganizationSetup([
      '--',
      '--name',
      `Fictional Ridge Survey ${suffix}`,
      '--time-zone',
      'America/Denver',
      '--admin',
      'Robin Vale',
      '--id',
      `org-setup-${run}-${suffix}`,
      ...extra,
    ]);
  async function snapshot(tenantId: string) {
    const rows = async (sql: string) => (await admin.query(sql, [tenantId])).rows;
    return {
      tenants: await rows('SELECT id,name,time_zone FROM tenants WHERE id=$1'),
      principals: await rows(
        'SELECT id,name,kind,capabilities,revision,active,sign_in_issuer,sign_in_subject FROM principals WHERE tenant_id=$1 ORDER BY id',
      ),
      credentials: await rows(
        'SELECT c.token_hash FROM api_credentials c JOIN principals p ON p.id=c.principal_id WHERE p.tenant_id=$1',
      ),
      events: await rows('SELECT id,event_type,principal_id FROM journal_events WHERE tenant_id=$1 ORDER BY id'),
      commands: await rows('SELECT id,kind,actor_id FROM command_records WHERE tenant_id=$1 ORDER BY id'),
    };
  }
  const call = (token: string, method: 'GET' | 'POST', url: string, payload?: object, key = randomUUID()) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': key },
      ...(payload ? { payload } : {}),
    });

  it('creates an organization once in a production-like environment, tied to the identity provider', async () => {
    const signIn = ['--sign-in-issuer', 'https://identity.example.invalid', '--sign-in-subject', `user_${run}_staging`];
    const setup = options('staging', signIn);
    const environment = setupEnvironment({ LEDGER_ENV: 'staging', NODE_ENV: 'production' });
    expect(environment).toBe('staging');
    await expect(setUpOrganization(admin, options('unbound'), environment, accepted)).rejects.toThrow(
      '--sign-in-issuer',
    );
    const elsewhere = options('elsewhere', [
      '--sign-in-issuer',
      'https://other.example.invalid',
      '--sign-in-subject',
      'x',
    ]);
    await expect(setUpOrganization(admin, elsewhere, environment, accepted)).rejects.toThrow(
      'It accepts: https://identity.example.invalid',
    );
    await expect(setUpOrganization(admin, setup, environment, [])).rejects.toThrow('set LEDGER_OIDC_ISSUER');
    expect((await snapshot(elsewhere.tenantId)).principals).toEqual([]);

    const first = await setUpOrganization(admin, setup, environment, accepted);
    expect(first).toMatchObject({
      created: true,
      organization: { id: setup.tenantId, name: setup.name, timeZone: 'America/Denver' },
    });
    expect(first.developmentToken).toBeUndefined();
    expect(setupReport(setup, first)).toContain(`as subject user_${run}_staging`);
    const created = await snapshot(setup.tenantId);
    expect(created.credentials).toEqual([]);
    // Its administrator, its worker, and the safety reporting channel every organization has.
    expect(created.principals.map((row) => row.kind).sort()).toEqual(['human', 'intake', 'worker']);
    const administrator = await authenticate(pool, {
      issuer: 'https://identity.example.invalid',
      subject: `user_${run}_staging`,
    });
    expect(administrator).toMatchObject({ tenantId: setup.tenantId, name: 'Robin Vale', kind: 'human' });
    expect([...administrator!.capabilities].sort()).toEqual([...administratorCapabilities].sort());
    expect(created.commands).toEqual([{ id: created.events[0].id, kind: 'person.add', actor_id: administrator!.id }]);

    const second = await setUpOrganization(admin, { ...setup, timeZone: 'Europe/Berlin' }, environment, accepted);
    expect(second).toEqual({ created: false, organization: first.organization });
    expect(setupReport(setup, second)).toContain('already exists. Nothing was changed.');
    expect(await snapshot(setup.tenantId)).toEqual(created);
  });

  it('keeps the fictional seeds out of a production-like environment', async () => {
    const saved = process.env.LEDGER_ENV;
    process.env.LEDGER_ENV = 'staging';
    try {
      await expect(seed(admin)).rejects.toThrow('forbidden outside isolated local/test');
    } finally {
      process.env.LEDGER_ENV = saved;
    }
  });

  it('gives a local administrator a development token, and the API returns the organization and its zone', async () => {
    const setup = options('local');
    const result = await setUpOrganization(admin, setup, 'local', accepted);
    expect(result.created).toBe(true);
    const token = result.developmentToken!;
    expect(token).toMatch(/^ledger-dev-/);
    expect(setupReport(setup, result)).toContain(token);
    const me = await call(token, 'GET', '/v1/me');
    expect(me.statusCode, me.body).toBe(200);
    expect(validMe(me.json()), JSON.stringify(validMe.errors)).toBe(true);
    expect(me.json().organization).toEqual({ id: setup.tenantId, name: setup.name, timeZone: 'America/Denver' });
    expect((await setUpOrganization(admin, setup, 'local', accepted)).developmentToken).toBeUndefined();
    // An organization of its own is offered the packs that quote a regulation, not the invented examples, which the
    // seeded fictional organizations are offered.
    const own = await call(token, 'GET', '/v1/rule-packs');
    expect(own.statusCode, own.body).toBe(200);
    const offered = own.json().packs.map((pack: { packId: string }) => pack.packId) as string[];
    expect(offered).toEqual(expect.arrayContaining(['ledger.part107', 'ledger.part108-nprm']));
    for (const example of standardRulePacks().filter((pack) => isExamplePack(pack.packId)))
      expect(offered).not.toContain(example.packId);
    const fictional = await call('ledger-dev-alpha-operator', 'GET', '/v1/rule-packs');
    expect(fictional.json().packs.map((pack: { packId: string }) => pack.packId)).toContain(SEEDED_PACK.packId);
  });

  it('returns the zone each seeded organization declares', async () => {
    const me = await call('ledger-dev-alpha-operator', 'GET', '/v1/me');
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json().organization).toMatchObject({ id: 'tenant-alpha', timeZone: 'America/Chicago' });
    await expect(
      admin.query('INSERT INTO tenants(id,name,time_zone) VALUES($1,$2,$3)', [
        `${owned}-nowhere`,
        'Fictional nowhere',
        'Mars/Olympus',
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('lets an administrator add people, change what they may do and deactivate them, each as a recorded command', async () => {
    const setup = options('people');
    const result = await setUpOrganization(admin, setup, 'local', accepted);
    if (!result.created) throw new Error('The organization should be new');
    const token = result.developmentToken!;
    const dispatcher = {
      kind: 'person.add',
      name: 'Casey Lund',
      principalKind: 'human',
      capabilities: ['flight:read', 'evidence:read', 'input:write', 'pack:adopt'],
      observationGrants: [{ sourceId: 'operator-records', observationType: 'operator.record' }],
      signIn: { issuer: 'https://identity.example.invalid', subject: `user_${run}_dispatcher` },
    };
    const key = randomUUID();
    const added = await call(token, 'POST', '/v1/commands', dispatcher, key);
    expect(added.statusCode, added.body).toBe(201);
    const command = added.json().command;
    expect(command).toMatchObject({ kind: 'person.add', actorId: result.administratorId });
    expect(command.payload).toMatchObject({ name: 'Casey Lund', principalKind: 'human', signInLinked: true });
    expect(JSON.stringify(command.payload)).not.toContain(`user_${run}_dispatcher`);
    const replay = await call(token, 'POST', '/v1/commands', dispatcher, key);
    expect(replay.json().command.id).toBe(command.id);

    const pilot = await call(token, 'POST', '/v1/commands', {
      kind: 'person.add',
      name: 'Ari Moss',
      principalKind: 'human',
      capabilities: ['flight:read', 'sms:read', 'briefing:ack'],
    });
    expect(pilot.statusCode, pilot.body).toBe(201);
    const pilotId: string = pilot.json().command.payload.principalId;

    const reused = await call(token, 'POST', '/v1/commands', { ...dispatcher, name: 'Someone else' });
    expect(reused.statusCode).toBe(409);
    expect(reused.json().error.code).toBe('sign_in_identity_in_use');
    const retired = await call(token, 'POST', '/v1/commands', {
      kind: 'person.add',
      name: 'Retired grant',
      principalKind: 'human',
      capabilities: ['command-link:write'],
    });
    expect(retired.json().error.code).toBe('capability_retired');
    const sourceSignIn = await call(token, 'POST', '/v1/commands', {
      kind: 'person.add',
      name: 'Fictional feed',
      principalKind: 'source',
      capabilities: ['input:write'],
      signIn: { issuer: 'https://identity.example.invalid', subject: `user_${run}_feed` },
    });
    expect(sourceSignIn.json().error.code).toBe('sign_in_for_people_only');

    const list = await call(token, 'GET', '/v1/authority/principals');
    expect(list.statusCode, list.body).toBe(200);
    expect(list.headers['cache-control']).toBe('private, no-store');
    expect(validList(list.json()), JSON.stringify(validList.errors)).toBe(true);
    const people: PrincipalAuthorityEntry[] = list.json().principals;
    expect(people.map((person) => [person.name, person.active, person.signInLinked])).toEqual([
      ['Ari Moss', true, false],
      ['Casey Lund', true, true],
      ['Robin Vale', true, false],
    ]);
    expect(people.find((person) => person.name === 'Casey Lund')!.observationGrants).toEqual(
      dispatcher.observationGrants,
    );
    expect(list.body).not.toContain(`user_${run}_dispatcher`);
    expect(list.json()).toMatchObject({ hasMore: false, nextCursor: null });

    // A page at a time, by name and then id: the pages together are the whole list, each person once.
    const paged: PrincipalAuthorityEntry[] = [];
    let cursor: string | null = null;
    do {
      const page = await call(
        token,
        'GET',
        `/v1/authority/principals?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      expect(page.statusCode, page.body).toBe(200);
      expect(validList(page.json()), JSON.stringify(validList.errors)).toBe(true);
      expect(page.json().principals.length).toBeLessThanOrEqual(2);
      paged.push(...page.json().principals);
      cursor = page.json().nextCursor;
      expect(page.json().hasMore).toBe(cursor !== null);
    } while (cursor);
    expect(paged.map((person) => person.id)).toEqual(people.map((person) => person.id));
    const forged = await call(token, 'GET', '/v1/authority/principals?cursor=not-a-cursor');
    expect(forged.statusCode, forged.body).toBe(400);
    expect(forged.json().error.code).toBe('invalid_cursor');

    const current = people.find((person) => person.id === pilotId)!;
    const changed = await call(token, 'POST', '/v1/commands', {
      kind: 'authority.update',
      principalId: pilotId,
      expectedRevision: current.revision,
      capabilities: [...current.capabilities, 'input:write'],
    });
    expect(changed.statusCode, changed.body).toBe(201);
    const deactivated = await call(token, 'POST', '/v1/commands', {
      kind: 'authority.update',
      principalId: pilotId,
      expectedRevision: current.revision + 1,
      capabilities: [...current.capabilities, 'input:write'],
      active: false,
    });
    expect(deactivated.statusCode, deactivated.body).toBe(201);
    const after = (await call(token, 'GET', '/v1/authority/principals')).json().principals as PrincipalAuthorityEntry[];
    expect(after.find((person) => person.id === pilotId)).toMatchObject({
      active: false,
      revision: current.revision + 2,
      capabilities: [...current.capabilities, 'input:write'],
    });

    // The pilot is never deleted: their record and the commands about them stay.
    const history = await admin.query<{ kind: string; actor_id: string }>(
      `SELECT kind,actor_id FROM command_records WHERE tenant_id=$1 AND (payload->>'principalId')=$2 ORDER BY recorded_at`,
      [setup.tenantId, pilotId],
    );
    expect(history.rows).toEqual([
      { kind: 'person.add', actor_id: result.administratorId },
      { kind: 'authority.update', actor_id: result.administratorId },
      { kind: 'authority.update', actor_id: result.administratorId },
    ]);
    const pilotToken = `ledger-dev-${run}-pilot`;
    await admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [
      sha256(pilotToken),
      pilotId,
    ]);
    expect((await call(pilotToken, 'GET', '/v1/me')).statusCode).toBe(401);

    // Someone without authority:write can neither add people nor read their authority.
    const dispatcherId = people.find((person) => person.name === 'Casey Lund')!.id;
    const dispatcherToken = `ledger-dev-${run}-dispatcher`;
    await admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [
      sha256(dispatcherToken),
      dispatcherId,
    ]);
    const refused = await call(dispatcherToken, 'POST', '/v1/commands', {
      kind: 'person.add',
      name: 'Not added',
      principalKind: 'human',
      capabilities: [],
    });
    expect(refused.statusCode).toBe(403);
    expect((await call(dispatcherToken, 'GET', '/v1/authority/principals')).statusCode).toBe(403);
    const worker = await call(token, 'POST', '/v1/commands', {
      kind: 'person.add',
      name: 'Not a worker',
      principalKind: 'worker',
      capabilities: [],
    });
    expect(worker.statusCode).toBe(400);
  });

  it('ties a person added with only a user id to the issuer the administrator signs in through', async () => {
    const issuer = 'https://identity.example.invalid';
    const setup = options('issuer', ['--sign-in-issuer', issuer, '--sign-in-subject', `user_${run}_issuer_admin`]);
    const result = await setUpOrganization(admin, setup, 'staging', accepted);
    if (!result.created) throw new Error('The organization should be new');
    // The test API has no identity provider, so the administrator acts here through a test credential.
    const token = `ledger-dev-${run}-issuer-admin`;
    await admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [
      sha256(token),
      result.administratorId,
    ]);
    const added = await call(token, 'POST', '/v1/commands', {
      kind: 'person.add',
      name: 'Kim Arden',
      principalKind: 'human',
      capabilities: ['flight:read'],
      signIn: { subject: `user_${run}_pilot` },
    });
    expect(added.statusCode, added.body).toBe(201);
    expect(await authenticate(pool, { issuer, subject: `user_${run}_pilot` })).toMatchObject({
      id: added.json().command.payload.principalId,
      tenantId: setup.tenantId,
    });

    const local = await setUpOrganization(admin, options('no-issuer'), 'local', accepted);
    const refused = await call(local.created ? local.developmentToken! : '', 'POST', '/v1/commands', {
      kind: 'person.add',
      name: 'Lee Brook',
      principalKind: 'human',
      capabilities: [],
      signIn: { subject: `user_${run}_unbound` },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe('sign_in_issuer_required');
  });

  it('takes an empty organization from creation to people, an adopted pack and imported records', async () => {
    const setup = options('first-day');
    const result = await setUpOrganization(admin, setup, 'local', accepted);
    if (!result.created) throw new Error('The organization should be new');
    const token = result.developmentToken!;
    for (const [name, capabilities] of [
      ['Casey Lund', ['flight:read', 'flight:create', 'evidence:read', 'input:write', 'pack:adopt', 'decision:write']],
      ['Ari Moss', ['flight:read', 'evidence:read', 'input:write', 'briefing:ack']],
    ] as const) {
      const added = await call(token, 'POST', '/v1/commands', {
        kind: 'person.add',
        name,
        principalKind: 'human',
        capabilities,
      });
      expect(added.statusCode, added.body).toBe(201);
    }

    expect(await adoptRulePack(app, token, SEEDED_PACK, 'Adopted on the first day.')).toBe(true);
    const coverage = await call(token, 'GET', '/v1/organization/coverage');
    expect(coverage.json().adoptions.map((adoption: any) => adoption.pack.packId)).toContain(SEEDED_PACK.packId);

    const file = Buffer.from(
      readFileSync(
        join(
          import.meta.dirname,
          '..',
          '..',
          'packages',
          'contracts',
          'fixtures',
          'operator-records',
          'alpha-aircraft-time.csv',
        ),
        'utf8',
      ).replaceAll('ALPHA-', `${run}-FIRST-`),
    );
    const created = await call(token, 'POST', '/v1/uploads', { contentType: 'text/csv', byteLength: file.byteLength });
    expect(created.statusCode, created.body).toBe(201);
    const uploadId = created.json().upload.id as string;
    const stored = await app.inject({
      method: 'PUT',
      url: `/v1/uploads/${uploadId}/content`,
      headers: {
        authorization: `Bearer ${token}`,
        'idempotency-key': randomUUID(),
        'content-type': 'application/octet-stream',
      },
      payload: file,
    });
    expect(stored.statusCode, stored.body).toBe(200);
    const finalized = await call(token, 'POST', `/v1/uploads/${uploadId}/finalize`);
    expect(finalized.statusCode, finalized.body).toBe(201);
    const imported = await call(token, 'POST', '/v1/operator-records/imports', {
      artifactId: finalized.json().artifact.id,
      recordType: 'aircraft.time-in-service',
      recordVersion: 1,
    });
    expect(imported.statusCode, imported.body).toBe(201);
    const listed = await call(
      token,
      'GET',
      `/v1/operator-records?${new URLSearchParams({ recordType: 'aircraft.time-in-service' })}`,
    );
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().records.length).toBeGreaterThan(0);
  });
});
