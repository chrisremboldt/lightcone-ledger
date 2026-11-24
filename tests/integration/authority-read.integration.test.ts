import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import {
  AUTHORITY_PRINCIPAL_MAX_RESPONSE_BYTES,
  type AuthorityPrincipal,
  type AuthorityPrincipalResponse,
  type Command,
  type CommandResponse,
} from '../../packages/contracts/src/index.js';
import { sha256 } from '../../packages/integrity/src/index.js';
import { createPool, MemoryObjectStore } from '../../packages/persistence/src/index.js';
import { isTestDatabaseName } from './test-database.js';
import { settleOwnedWork } from './worker-queue.js';

type Role = 'manager' | 'reader' | 'target' | 'inactive';
interface Fixture {
  tenantId: string;
  ids: Record<Role, string>;
  tokens: Record<Role, string>;
}
interface AuthorityRow {
  id: string;
  tenant_id: string;
  name: string;
  kind: AuthorityPrincipal['kind'];
  active: boolean;
  revision: string;
  capabilities: AuthorityPrincipal['capabilities'];
  command_link_sources: string[];
  mission_sources: string[];
  monitoring_sources: string[];
}

describe.runIf(process.env.LEDGER_ENV !== 'staging')('Exact current principal authority', () => {
  const prefix = `authority-read-${randomUUID()}`;
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const issuer = 'https://authority-read-identity.invalid';
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeAll(async () => {
    expect(isTestDatabaseName(process.env.LEDGER_TEST_DATABASE), 'LEDGER_TEST_DATABASE must be ledger_test*').toBe(
      true,
    );
    for (const name of ['DATABASE_URL', 'DATABASE_ADMIN_URL'] as const) {
      expect(process.env[name], `${name} must be configured`).toBeDefined();
      expect(new URL(process.env[name]!).pathname).toBe(`/${process.env.LEDGER_TEST_DATABASE}`);
    }
    app = await createApp({ pool, env: 'test', objectStore: new MemoryObjectStore() });
    await app.ready();
  });
  afterAll(async () => {
    await settleOwnedWork([prefix]);
    await app?.close();
    await pool.end();
    await admin.end();
  });

  async function fixture(suffix: string): Promise<Fixture> {
    const tenantId = `${prefix}:${suffix}`;
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, 'Fictional authority organization']);
    const ids = {} as Fixture['ids'];
    const tokens = {} as Fixture['tokens'];
    const kinds: Record<Role, AuthorityPrincipal['kind']> = {
      manager: 'human',
      reader: 'service',
      target: 'source',
      inactive: 'worker',
    };
    for (const role of ['manager', 'reader', 'target', 'inactive'] as const) {
      ids[role] = `${tenantId}:${role}`;
      tokens[role] = `ledger-dev-${ids[role]}`;
      const capabilities: AuthorityPrincipal['capabilities'] =
        role === 'manager'
          ? ['authority:write']
          : role === 'target'
            ? ['input:write', 'flight:read', 'command-link:write']
            : ['flight:read'];
      await admin.query(
        `INSERT INTO principals(id,tenant_id,name,kind,active,revision,capabilities,sign_in_issuer,sign_in_subject,
         command_link_sources,mission_sources,monitoring_sources)
         VALUES($1,$2,$3,$4,$5,1,$6,$7,$8,$9,$10,$11)`,
        [
          ids[role],
          tenantId,
          `Fictional ${role}`,
          kinds[role],
          role !== 'inactive',
          capabilities,
          issuer,
          `${ids[role]}:private-subject`,
          role === 'target' ? ['c2-original', 'c2-retained'] : [],
          role === 'target' ? ['mission-original'] : [],
          role === 'target' ? ['monitoring-original'] : [],
        ],
      );
      await admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [
        sha256(tokens[role]),
        ids[role],
      ]);
    }
    return { tenantId, ids, tokens };
  }

  async function current(f: Fixture, id: string): Promise<AuthorityPrincipal> {
    const row = (
      await admin.query<AuthorityRow>(
        `SELECT id,tenant_id,name,kind,active,revision,capabilities,command_link_sources,mission_sources,monitoring_sources
         FROM principals WHERE tenant_id=$1 AND id=$2`,
        [f.tenantId, id],
      )
    ).rows[0]!;
    const grants = await admin.query<{ source_id: string; observation_type: string }>(
      `SELECT source_id,observation_type FROM observation_grants WHERE tenant_id=$1 AND principal_id=$2
       ORDER BY source_id COLLATE "C",observation_type COLLATE "C"`,
      [f.tenantId, id],
    );
    return {
      id: row.id,
      tenantId: row.tenant_id,
      name: row.name,
      kind: row.kind,
      active: row.active,
      revision: Number(row.revision),
      capabilities: row.capabilities,
      commandLinkSources: row.command_link_sources,
      missionSources: row.mission_sources,
      monitoringSources: row.monitoring_sources,
      observationGrants: grants.rows.map((grant) => ({
        sourceId: grant.source_id,
        observationType: grant.observation_type,
      })),
    };
  }

  async function get(f: Fixture, id: string, role: Role | null = 'manager') {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/authority/principals/${encodeURIComponent(id)}`,
      ...(role ? { headers: { authorization: `Bearer ${f.tokens[role]}` } } : {}),
    });
    expect(response.headers['cache-control']).toBe('private, no-store');
    return response;
  }

  async function read(f: Fixture, id: string) {
    const response = await get(f, id);
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<AuthorityPrincipalResponse>();
    expect(Object.keys(body)).toEqual(['principal']);
    expect(Object.keys(body.principal).sort()).toEqual(
      [
        'id',
        'tenantId',
        'name',
        'kind',
        'active',
        'revision',
        'capabilities',
        'commandLinkSources',
        'missionSources',
        'monitoringSources',
        'observationGrants',
      ].sort(),
    );
    expect(body.principal).toEqual(await current(f, id));
    expect(Buffer.byteLength(response.body, 'utf8')).toBeLessThanOrEqual(AUTHORITY_PRINCIPAL_MAX_RESPONSE_BYTES);
    for (const privateValue of [issuer, `${id}:private-subject`, ...Object.values(f.tokens)]) {
      expect(response.body).not.toContain(privateValue);
      expect(response.body).not.toContain(sha256(privateValue));
    }
    return body.principal;
  }

  const update = (f: Fixture, command: Extract<Command, { kind: 'authority.update' }>, key = randomUUID()) =>
    app.inject({
      method: 'POST',
      url: '/v1/commands',
      headers: { authorization: `Bearer ${f.tokens.manager}`, 'idempotency-key': key },
      payload: command,
    });

  it('reads complete current authority and preserves full-replacement and revision-safe update semantics', async () => {
    const f = await fixture('updates');
    expect(await read(f, f.ids.manager)).toMatchObject({ kind: 'human', capabilities: ['authority:write'] });
    const original = await read(f, f.ids.target);
    expect(original).toMatchObject({
      kind: 'source',
      commandLinkSources: ['c2-original', 'c2-retained'],
      missionSources: ['mission-original'],
      monitoringSources: ['monitoring-original'],
    });
    const command: Extract<Command, { kind: 'authority.update' }> = {
      kind: 'authority.update',
      principalId: original.id,
      expectedRevision: original.revision,
      capabilities: ['input:write', 'flight:read', 'mission:write', 'monitoring:write'],
      monitoringSources: [],
      active: false,
    };
    const key = randomUUID();
    const accepted = await update(f, command, key);
    expect(accepted.statusCode, accepted.body).toBe(201);
    const changed = await read(f, f.ids.target);
    expect(changed).toEqual({
      ...original,
      revision: original.revision + 1,
      capabilities: command.capabilities,
      // RETAINED: the command-link source grants stay as granted; authority.update no longer changes them.
      commandLinkSources: ['c2-original', 'c2-retained'],
      monitoringSources: [],
      active: false,
    });

    const replay = await update(f, command, key);
    expect(replay.statusCode, replay.body).toBe(201);
    expect(replay.json<CommandResponse>().command.id).toBe(accepted.json<CommandResponse>().command.id);
    expect(await read(f, f.ids.target)).toEqual(changed);
    const stale = await update(f, command);
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json().error.code).toBe('stale_authority');
    expect(await read(f, f.ids.target)).toEqual(changed);

    // The retired command-link capability is not granted anew; a principal that holds it may keep it.
    const reader = await read(f, f.ids.reader);
    const refused = await update(f, {
      kind: 'authority.update',
      principalId: reader.id,
      expectedRevision: reader.revision,
      capabilities: [...reader.capabilities, 'command-link:write'],
    });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.json().error.code).toBe('capability_retired');
    expect(original.capabilities).toContain('command-link:write');
  });

  it('keeps exact authority private, tenant-scoped and complete on every response path', async () => {
    const f = await fixture('access');
    const foreign = await fixture('foreign');
    expect(await read(f, f.ids.reader)).toMatchObject({ kind: 'service', active: true });
    expect(await read(f, f.ids.inactive)).toMatchObject({ kind: 'worker', active: false });
    for (const role of [null, 'inactive'] as const) {
      const response = await get(f, f.ids.target, role);
      expect(response.statusCode, response.body).toBe(401);
    }
    const denied = await get(f, f.ids.target, 'reader');
    expect(denied.statusCode, denied.body).toBe(403);
    expect(denied.json().error.code).toBe('capability_required');

    const missing = await get(f, `${f.tenantId}:missing`);
    const hidden = await get(f, foreign.ids.target);
    expect(missing.statusCode, missing.body).toBe(404);
    expect(hidden.statusCode, hidden.body).toBe(404);
    expect(hidden.json().error).toEqual(missing.json().error);
    expect(hidden.json().error.code).toBe('principal_not_found');
    expect(hidden.body).not.toContain(foreign.tenantId);

    const oversizedId = `${f.tenantId}:oversized`;
    await admin.query("INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,'human',$4)", [
      oversizedId,
      f.tenantId,
      'X'.repeat(AUTHORITY_PRINCIPAL_MAX_RESPONSE_BYTES),
      ['flight:read'],
    ]);
    const oversized = await get(f, oversizedId);
    expect(oversized.statusCode, oversized.body).toBe(413);
    expect(oversized.json().error.code).toBe('principal_authority_too_large');
    expect(oversized.json()).not.toHaveProperty('principal');
    expect(Buffer.byteLength(oversized.body, 'utf8')).toBeLessThanOrEqual(AUTHORITY_PRINCIPAL_MAX_RESPONSE_BYTES);
  });
});
