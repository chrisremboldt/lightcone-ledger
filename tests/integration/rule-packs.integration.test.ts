import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import { RulePackVersionResponseSchema, type RulePackVersion } from '../../packages/contracts/src/index.js';
import { registerRulePack } from '../../packages/domain/src/rule-pack-registry.js';
import { canonicalDigest, sha256 } from '../../packages/integrity/src/index.js';
import { createPool, MemoryObjectStore } from '../../packages/persistence/src/index.js';
import { settleOwnedWork } from './worker-queue.js';

describe.runIf(process.env.LEDGER_ENV !== 'staging')('Authenticated draft rule pack catalog', () => {
  const prefix = `rule-pack-${randomUUID()}`;
  const tenantId = `${prefix}:tenant`;
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const credentials = {
    reader: `ledger-dev-${prefix}-reader`,
    restricted: `ledger-dev-${prefix}-restricted`,
  };
  const validate = new Ajv({ allErrors: true }).compile(RulePackVersionResponseSchema);
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeAll(async () => {
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, 'Fictional rule pack reader']);
    for (const [role, capabilities] of Object.entries({ reader: ['flight:read'], restricted: ['order:read'] })) {
      const id = `${prefix}:${role}`;
      const credential = credentials[role as keyof typeof credentials];
      await admin.query('INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,$4,$5)', [
        id,
        tenantId,
        `Fictional ${role}`,
        'human',
        capabilities,
      ]);
      await admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [sha256(credential), id]);
    }
    app = await createApp({ pool, env: 'test', objectStore: new MemoryObjectStore() });
    await app.ready();
  });

  afterAll(async () => {
    await settleOwnedWork([prefix]);
    if (app) await app.close();
    await pool.end();
    await admin.end();
  });

  it('requires flight read authority and returns only the requested exact draft version', async () => {
    const url = '/v1/rule-packs/ledger.demo-procedures/versions/1';
    const headers = { authorization: `Bearer ${credentials.reader}` };
    const allowed = await app.inject({ method: 'GET', url, headers });
    expect(allowed.statusCode, allowed.body).toBe(200);
    expect(validate(allowed.json()), JSON.stringify(validate.errors)).toBe(true);
    expect(allowed.json().pack).toMatchObject({
      packId: 'ledger.demo-procedures',
      version: 1,
      status: 'draft',
      review: 'ai_drafted',
      adopted: false,
    });
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    const denied = await app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${credentials.restricted}` },
    });
    expect(denied.statusCode, denied.body).toBe(403);
    expect(denied.json().error.code).toBe('capability_required');
    const unavailable = await app.inject({
      method: 'GET',
      url: '/v1/rule-packs/ledger.demo-procedures/versions/999',
      headers,
    });
    expect(unavailable.statusCode, unavailable.body).toBe(404);
    expect(unavailable.json().error.code).toBe('rule_pack_not_found');
    const malformed = await app.inject({
      method: 'GET',
      url: '/v1/rule-packs/ledger.demo-procedures/versions/invalid',
      headers,
    });
    expect(malformed.statusCode, malformed.body).toBe(400);
    expect(malformed.json().error).toEqual({
      code: 'invalid_request',
      message: 'Path parameter version must be a whole number; it is text.',
    });
    // A principal who holds only reads is refused before the body is read, so the shape is checked for one who writes.
    const beside = await app.inject({
      method: 'POST',
      url: '/v1/inputs',
      headers: { authorization: 'Bearer ledger-dev-alpha-operator', 'idempotency-key': `shape-${prefix}` },
      payload: {
        sourceId: 'example-ridge-log',
        kind: 'observation',
        occurredAt: '2026-11-10T15:00:00Z',
        subject: { flightId: 'RIDGE-F-1' },
        payload: {
          type: 'battery.state',
          version: 1,
          subject: { kind: 'aircraft', id: 'RIDGE-AC-1' },
          occurredAt: '2026-11-10T15:00:00Z',
        },
      },
    });
    expect(beside.statusCode, beside.body).toBe(400);
    expect(beside.json().error.message).toBe(
      'The request body has subject, which is not taken here. An observation input states its subject, session, time of effect, revision, original file and fidelity inside its payload, not beside it.',
    );
  });

  it('serves any registered pack and retained source through the same routes', async () => {
    const packId = `test.registered-${prefix}`;
    const sourceId = `test.registered-source-${prefix}`;
    const bytes = Buffer.from('Fictional field manual, section 4: confirm the landing zone is clear.', 'utf8');
    const content: Omit<RulePackVersion, 'digest'> = {
      packId,
      version: 1,
      title: 'Fictional field manual',
      status: 'draft',
      review: 'ai_drafted',
      adopted: false,
      bindings: [],
      leaves: [],
    };
    const version = { ...content, digest: canonicalDigest(content) };
    registerRulePack({
      packId,
      versions: [version],
      sources: [
        {
          sourceId,
          url: 'https://example.test/field-manual.txt',
          sha256: sha256(bytes),
          byteLength: bytes.length,
          contentType: 'text/plain; charset=utf-8',
          readPath: `/v1/rule-sources/${sourceId}/content`,
          filename: 'field-manual.txt',
          bytes,
        },
      ],
    });
    const headers = { authorization: `Bearer ${credentials.reader}` };
    const pack = await app.inject({ method: 'GET', url: `/v1/rule-packs/${packId}/versions/1`, headers });
    expect(pack.statusCode, pack.body).toBe(200);
    expect(pack.json().pack).toEqual(version);
    const source = await app.inject({ method: 'GET', url: `/v1/rule-sources/${sourceId}/content`, headers });
    expect(source.statusCode, source.body).toBe(200);
    expect(source.rawPayload).toEqual(bytes);
    expect(source.headers['x-content-sha256']).toBe(sha256(bytes));
    expect(source.headers['content-type']).toContain('text/plain');
    expect(source.headers['content-disposition']).toBe('attachment; filename="field-manual.txt"');
    const denied = await app.inject({
      method: 'GET',
      url: `/v1/rule-sources/${sourceId}/content`,
      headers: { authorization: `Bearer ${credentials.restricted}` },
    });
    expect(denied.statusCode, denied.body).toBe(403);
  });
});
