import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import { parseCredentialSetup, setUpCredential, credentialReport } from '../../apps/api/src/credential-setup.js';
import { parseOrganizationSetup, setUpOrganization } from '../../apps/api/src/organization-setup.js';
import { CREDENTIAL_SECRET_PATTERN, CredentialListResponseSchema } from '../../packages/contracts/src/index.js';
import { sha256 } from '../../packages/integrity/src/index.js';
import { createPool, MemoryObjectStore } from '../../packages/persistence/src/index.js';
import { databaseNow, settleOwnedWork } from './worker-queue.js';

const run = randomUUID().slice(0, 8);
const owned = `tenant-credentials-${run}`;

describe.runIf(process.env.LEDGER_ENV !== 'staging')('Credentials for sources and services', () => {
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  const validList = ajv.compile(CredentialListResponseSchema);
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

  const call = (token: string, method: 'GET' | 'POST', url: string, payload?: object, key = randomUUID()) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': key },
      ...(payload ? { payload } : {}),
    });

  async function organization(suffix: string) {
    const setup = parseOrganizationSetup([
      '--name',
      `Fictional Credential Works ${suffix}`,
      '--time-zone',
      'America/Denver',
      '--admin',
      'Robin Vale',
      '--id',
      `credentials-${run}-${suffix}`,
    ]);
    const result = await setUpOrganization(admin, setup, 'local');
    if (!result.created) throw new Error('The organization should be new');
    return { tenantId: setup.tenantId, administratorId: result.administratorId, token: result.developmentToken! };
  }
  async function add(token: string, name: string, principalKind: 'human' | 'source' | 'service') {
    const response = await call(token, 'POST', '/v1/commands', {
      kind: 'person.add',
      name,
      principalKind,
      capabilities: principalKind === 'human' ? ['flight:read'] : ['input:write', 'flight:read'],
    });
    expect(response.statusCode, response.body).toBe(201);
    return String(response.json().command.payload.principalId);
  }
  async function issue(token: string, principalId: string, extra: object = {}, key = randomUUID()) {
    return call(
      token,
      'POST',
      '/v1/commands',
      { kind: 'credential.issue', principalId, label: 'Fictional dock adapter', ...extra },
      key,
    );
  }
  async function list(token: string) {
    const response = await call(token, 'GET', '/v1/authority/credentials');
    expect(response.statusCode, response.body).toBe(200);
    expect(validList(response.json()), JSON.stringify(validList.errors)).toBe(true);
    expect(response.headers['cache-control']).toBe('private, no-store');
    return response;
  }
  async function journalText(tenantId: string) {
    const rows = (
      await admin.query(
        `SELECT j.payload::text AS journal,c.payload::text AS command FROM journal_events j
         LEFT JOIN command_records c ON c.tenant_id=j.tenant_id AND c.id=j.id WHERE j.tenant_id=$1`,
        [tenantId],
      )
    ).rows;
    return JSON.stringify(rows);
  }

  it('issues a credential once, records who issued it with their authority, and keeps only its hash', async () => {
    const org = await organization('issue');
    const sourceId = await add(org.token, 'Fictional dock adapter', 'source');
    const key = randomUUID();
    const issued = await issue(org.token, sourceId, {}, key);
    expect(issued.statusCode, issued.body).toBe(201);
    expect(issued.headers['cache-control']).toBe('private, no-store');
    const body = issued.json();
    const secret: string = body.credential.secret;
    expect(secret).toMatch(new RegExp(CREDENTIAL_SECRET_PATTERN));
    expect(Buffer.from(secret.slice('ledger-service-'.length), 'base64url')).toHaveLength(32);
    expect(body.credential.principalId).toBe(sourceId);
    expect(body.command).toMatchObject({ kind: 'credential.issue', actorId: org.administratorId });
    expect(body.command.payload).toMatchObject({
      credentialId: body.credential.id,
      principalId: sourceId,
      label: 'Fictional dock adapter',
      actorAuthority: { revision: 1, capabilities: expect.arrayContaining(['authority:write']) },
    });

    // The secret works as a bearer token for the source.
    const me = await call(secret, 'GET', '/v1/me');
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json().principal).toMatchObject({ id: sourceId, kind: 'source' });

    // A retry cannot be shown the secret again, and issues nothing new.
    const replay = await issue(org.token, sourceId, {}, key);
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error).toMatchObject({
      code: 'credential_secret_not_repeated',
      details: { credentialId: body.credential.id },
    });
    expect(replay.body).not.toContain(secret);

    const hash = sha256(secret);
    const stored = (await admin.query('SELECT token_hash FROM api_credentials WHERE id=$1', [body.credential.id])).rows;
    expect(stored).toEqual([{ token_hash: hash }]);
    const journal = await journalText(org.tenantId);
    expect(journal).toContain(body.credential.id);
    expect(journal).not.toContain(secret);
    expect(journal).not.toContain(hash);

    const listed = await list(org.token);
    expect(listed.body).not.toContain(secret);
    expect(listed.body).not.toContain(hash);
    expect(listed.json().credentials).toEqual([
      {
        id: body.credential.id,
        principal: { id: sourceId, name: 'Fictional dock adapter', kind: 'source', active: true },
        label: 'Fictional dock adapter',
        issuedBy: { id: org.administratorId, name: 'Robin Vale' },
        issuedAt: body.command.recordedAt,
        state: 'usable',
      },
    ]);
    // The API's own database role cannot read a hash back at all.
    await expect(pool.query('SELECT token_hash FROM api_credentials LIMIT 1')).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('refuses a revoked credential at once and records who revoked it', async () => {
    const org = await organization('revoke');
    const serviceId = await add(org.token, 'Fictional monitor', 'service');
    const issued = (await issue(org.token, serviceId)).json();
    const secret: string = issued.credential.secret;
    expect((await call(secret, 'GET', '/v1/me')).statusCode).toBe(200);

    const revoked = await call(org.token, 'POST', '/v1/commands', {
      kind: 'credential.revoke',
      credentialId: issued.credential.id,
    });
    expect(revoked.statusCode, revoked.body).toBe(201);
    expect(revoked.json().command).toMatchObject({ kind: 'credential.revoke', actorId: org.administratorId });
    expect(revoked.json().credential).toBeUndefined();
    const refused = await call(secret, 'GET', '/v1/me');
    expect(refused.statusCode).toBe(401);

    const again = await call(org.token, 'POST', '/v1/commands', {
      kind: 'credential.revoke',
      credentialId: issued.credential.id,
    });
    expect(again.json().error.code).toBe('credential_already_revoked');
    const [entry] = (await list(org.token)).json().credentials;
    expect(entry).toMatchObject({
      id: issued.credential.id,
      state: 'revoked',
      revokedBy: { id: org.administratorId, name: 'Robin Vale' },
      revokedAt: revoked.json().command.recordedAt,
    });
    await expect(
      admin.query('UPDATE api_credentials SET revoked_at=NULL WHERE id=$1', [issued.credential.id]),
    ).rejects.toThrow('a credential can only be revoked, once');
    await expect(admin.query('DELETE FROM api_credentials WHERE id=$1', [issued.credential.id])).rejects.toThrow(
      'a credential can only be revoked, once',
    );
  });

  it('refuses an expired credential, and an expiry already past', async () => {
    const org = await organization('expiry');
    const sourceId = await add(org.token, 'Fictional weather feed', 'source');
    const now = Date.parse(await databaseNow(admin));
    const past = await issue(org.token, sourceId, { expiresAt: new Date(now - 1000).toISOString() });
    expect(past.json().error.code).toBe('credential_expiry_past');
    const expiresAt = new Date(now + 1500).toISOString();
    const issued = (await issue(org.token, sourceId, { expiresAt })).json();
    expect(issued.command.payload.expiresAt).toBe(expiresAt);
    expect((await call(issued.credential.secret, 'GET', '/v1/me')).statusCode).toBe(200);
    while (Date.parse(await databaseNow(admin)) <= Date.parse(expiresAt))
      await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await call(issued.credential.secret, 'GET', '/v1/me')).statusCode).toBe(401);
    expect((await list(org.token)).json().credentials[0]).toMatchObject({ state: 'expired', expiresAt });
  });

  it('issues only to an active source or service, and only to someone who manages people', async () => {
    const org = await organization('authority');
    const personId = await add(org.token, 'Ari Moss', 'human');
    const toPerson = await issue(org.token, personId);
    expect(toPerson.json().error.code).toBe('credential_for_sources_and_services');
    const workerId = `worker-credentials-${run}-authority`;
    expect((await issue(org.token, workerId)).json().error.code).toBe('credential_for_sources_and_services');

    const sourceId = await add(org.token, 'Fictional route planner', 'source');
    const deactivate = await call(org.token, 'POST', '/v1/commands', {
      kind: 'authority.update',
      principalId: sourceId,
      expectedRevision: 1,
      capabilities: ['input:write', 'flight:read'],
      active: false,
    });
    expect(deactivate.statusCode, deactivate.body).toBe(201);
    expect((await issue(org.token, sourceId)).json().error.code).toBe('principal_inactive');

    const helperId = await add(org.token, 'Fictional helper', 'service');
    const helper = (await issue(org.token, helperId)).json().credential.secret as string;
    const unauthorised = await issue(helper, helperId);
    expect(unauthorised.statusCode).toBe(403);
    expect((await call(helper, 'GET', '/v1/authority/credentials')).statusCode).toBe(403);
    expect(
      (await call(helper, 'POST', '/v1/commands', { kind: 'credential.revoke', credentialId: 'anything' })).statusCode,
    ).toBe(403);
  });

  it('keeps each organization to its own credentials', async () => {
    const first = await organization('first');
    const second = await organization('second');
    const firstSource = await add(first.token, 'Fictional dock adapter', 'source');
    const issued = (await issue(first.token, firstSource)).json().credential;

    expect((await list(second.token)).json().credentials).toEqual([]);
    const foreignIssue = await issue(second.token, firstSource);
    expect(foreignIssue.statusCode).toBe(404);
    const foreignRevoke = await call(second.token, 'POST', '/v1/commands', {
      kind: 'credential.revoke',
      credentialId: issued.id,
    });
    expect(foreignRevoke.statusCode).toBe(404);
    expect(foreignRevoke.json().error.code).toBe('credential_not_found');
    expect((await call(issued.secret, 'GET', '/v1/me')).statusCode).toBe(200);
    expect((await list(first.token)).json().credentials.map((entry: { id: string }) => entry.id)).toEqual([issued.id]);
  });

  it('issues the first credential of a fresh deployment from the command line, recorded under the administrator', async () => {
    const org = await organization('cli');
    const options = parseCredentialSetup([
      '--',
      '--organization',
      org.tenantId,
      '--for',
      'Fictional dock adapter',
      '--label',
      'Dock adapter on the hangar host',
      '--add',
      'source',
      '--capability',
      'input:write',
      '--grant',
      'fictional-dock:link.status',
    ]);
    await expect(setUpCredential(admin, { ...options, add: undefined })).rejects.toThrow(
      'No source or service Fictional dock adapter',
    );
    const result = await setUpCredential(admin, options);
    expect(result).toMatchObject({
      principal: { name: 'Fictional dock adapter', kind: 'source', added: true },
      administrator: { id: org.administratorId, name: 'Robin Vale' },
    });
    const report = credentialReport(result);
    expect(report).toContain(result.credential.secret);
    const me = await call(result.credential.secret, 'GET', '/v1/me');
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json().principal).toMatchObject({ id: result.principal.id, capabilities: ['input:write'] });

    const commands = (
      await admin.query('SELECT kind,actor_id,payload FROM command_records WHERE tenant_id=$1 ORDER BY recorded_at', [
        org.tenantId,
      ])
    ).rows;
    expect(commands.map((row) => [row.kind, row.actor_id])).toEqual([
      ['person.add', org.administratorId],
      ['person.add', org.administratorId],
      ['credential.issue', org.administratorId],
    ]);
    expect(commands[2].payload).toMatchObject({
      principalId: result.principal.id,
      label: 'Dock adapter on the hangar host',
      actorAuthority: { revision: 1 },
    });
    expect(await journalText(org.tenantId)).not.toContain(result.credential.secret);

    // A second run finds the source by name and issues another credential beside the first.
    const second = await setUpCredential(admin, { ...options, add: undefined });
    expect(second.principal).toMatchObject({ id: result.principal.id, added: false });
    expect(second.credential.secret).not.toBe(result.credential.secret);
    await expect(setUpCredential(admin, { ...options, tenantId: `${owned}-missing` })).rejects.toThrow(
      'There is no organization',
    );
  });
});
