import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import { processLease, type WorkLease } from '../../apps/workers/src/index.js';
import { createPool, MemoryObjectStore, withScope, type AuthContext } from '../../packages/persistence/src/index.js';
import { sha256 } from '../../packages/integrity/src/index.js';
import type { Input } from '../../packages/contracts/src/index.js';
import { settleOwnedWork } from './worker-queue.js';

describe.runIf(process.env.LEDGER_ENV !== 'staging')('PostgreSQL originating input authority', () => {
  const pool = createPool(),
    admin = createPool(process.env.DATABASE_ADMIN_URL),
    workerPool = createPool(process.env.WORKER_DATABASE_URL);
  const prefix = `origin-authority-${randomUUID()}`;
  let app: Awaited<ReturnType<typeof createApp>>;
  const observationCaps = ['input:write', 'flight:read', 'order:read', 'evidence:read'];
  const originCaps = [...observationCaps, 'flight:create'];
  interface Fixture {
    tenantId: string;
    observer: AuthContext;
    origin: AuthContext;
    worker: AuthContext;
    operator: AuthContext;
    tokens: Record<string, string>;
  }
  beforeAll(async () => {
    app = await createApp({ pool, env: 'test', objectStore: new MemoryObjectStore() });
    await app.ready();
  });
  afterAll(async () => {
    await settleOwnedWork([`tenant-${prefix}`]);
    if (app) await app.close();
    await pool.end();
    await admin.end();
    await workerPool.end();
  });
  async function fixture(suffix: string): Promise<Fixture> {
    const tenantId = `tenant-${prefix}-${suffix}`,
      tokens: Record<string, string> = {};
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, 'Fictional origination authority test']);
    const contexts: Record<string, AuthContext> = {};
    for (const [role, caps] of Object.entries({
      observer: observationCaps,
      origin: originCaps,
      operator: [...originCaps, 'authority:write'],
      worker: ['flight:read'],
    })) {
      const id = `principal-${prefix}-${suffix}-${role}`;
      await admin.query('INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,$4,$5)', [
        id,
        tenantId,
        `Fictional ${role}`,
        role === 'worker' ? 'worker' : role === 'origin' ? 'source' : 'human',
        caps,
      ]);
      contexts[role] = { id, tenantId, name: `Fictional ${role}`, capabilities: caps, revision: 1 };
      if (role !== 'worker') {
        const token = `ledger-dev-${prefix}-${suffix}-${role}`;
        tokens[role] = token;
        await admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [sha256(token), id]);
      }
    }
    return {
      tenantId,
      tokens,
      observer: contexts.observer!,
      origin: contexts.origin!,
      operator: contexts.operator!,
      worker: contexts.worker!,
    };
  }
  const headers = (f: Fixture, role = 'origin', key?: string) => ({
    authorization: `Bearer ${f.tokens[role]}`,
    ...(key ? { 'idempotency-key': `${prefix}:${key}` } : {}),
  });
  const intent = (f: Fixture, key: string): Input => ({
    sourceId: `source-${prefix}`,
    kind: 'intent.revision',
    occurredAt: '2026-10-02T12:00:00Z',
    sourceRevision: 1,
    subject: { originationKey: `${f.tenantId}:${key}` },
    payload: { originationKey: `${f.tenantId}:${key}`, label: 'Authorized intent', revision: 1 },
  });
  const order = (f: Fixture, key: string): Input => ({
    sourceId: `source-${prefix}`,
    kind: 'order.revision',
    occurredAt: '2026-10-02T12:00:00Z',
    sourceRevision: 1,
    subject: { orderId: `${f.tenantId}:${key}` },
    payload: {
      externalId: `${f.tenantId}:${key}`,
      revision: 1,
      status: 'accepted',
      fulfillments: [{ originationKey: `${f.tenantId}:${key}:flight` }],
    },
  });
  const submit = (f: Fixture, input: Input, key: string, role = 'origin') =>
    app.inject({ method: 'POST', url: '/v1/inputs', headers: headers(f, role, key), payload: input });
  async function counts(f: Fixture) {
    const result: Record<string, number> = {};
    for (const table of [
      'artifacts',
      'uploads',
      'receipts',
      'journal_events',
      'outbox',
      'work_items',
      'idempotency_keys',
      'flight_views',
      'operational_orders',
    ])
      result[table] = Number(
        (await admin.query(`SELECT COUNT(*) AS count FROM ${table} WHERE tenant_id=$1`, [f.tenantId])).rows[0].count,
      );
    return result;
  }
  async function lease(f: Fixture, eventId: string): Promise<WorkLease> {
    // Claim only this test's accepted event: other suites and continuous fixtures
    // cannot have their work consumed by this focused authority regression.
    return withScope(workerPool, f.worker, async (client) => {
      const row = (
        await client.query(
          "UPDATE work_items SET state='leased',generation=generation+1,attempts=attempts+1,lease_owner=$1,lease_until=clock_timestamp()+interval '30 seconds' WHERE event_id=$2 AND state='pending' RETURNING *",
          [prefix, eventId],
        )
      ).rows[0];
      expect(row).toBeDefined();
      return { ...row, worker_id: f.worker.id };
    });
  }
  async function created(f: Fixture, causationId: string) {
    return (
      await admin.query(
        "SELECT * FROM journal_events WHERE tenant_id=$1 AND event_type='flight.created' AND causation_id=$2",
        [f.tenantId, causationId],
      )
    ).rows;
  }
  it('rejects observation-only actors for direct flights, orders and intents before any retained effects', async () => {
    const f = await fixture('deny');
    const before = await counts(f);
    const direct = await app.inject({
      method: 'POST',
      url: '/v1/flights',
      headers: headers(f, 'observer', 'direct-denied'),
      payload: { originationKey: `${f.tenantId}:direct` },
    });
    expect(direct.statusCode).toBe(403);
    for (const [index, input] of [order(f, 'order-denied'), intent(f, 'intent-denied')].entries()) {
      // Even an unavailable artifact is not looked up before authority rejection.
      const response = await submit(f, { ...input, artifactId: randomUUID() }, `denied-${index}`, 'observer');
      expect(response.statusCode, response.body).toBe(403);
      expect(response.json().error.code).toBe('capability_required');
    }
    expect(await counts(f)).toEqual(before);
    const observed = await submit(
      f,
      {
        sourceId: `source-${prefix}`,
        kind: 'flight.observation',
        occurredAt: '2026-10-02T12:00:00Z',
        subject: {},
        payload: { activity: 'active' },
      },
      'observation',
      'observer',
    );
    expect(observed.statusCode).toBe(201);
    expect(observed.json().receipt.linkStatus).toBe('unresolved');
  });

  it('retains server-issued authority and originates as that issuer without worker flight:create', async () => {
    const f = await fixture('issuer');
    for (const [index, body] of [order(f, 'order'), intent(f, 'intent')].entries()) {
      body.payload.acceptedAuthority = { principalId: f.worker.id, requiredCapabilities: ['authority:write'] };
      const response = await submit(f, body, `authorized-${index}`);
      expect(response.statusCode, response.body).toBe(201);
      expect(response.json().receipt.payload).toEqual(body.payload);
      const eventId = response.json().receipt.eventId;
      const envelope = (await admin.query('SELECT payload FROM journal_events WHERE id=$1', [eventId])).rows[0].payload;
      expect(envelope.acceptedAuthority).toEqual({
        version: 'ledger.input-authority.1',
        principalId: f.origin.id,
        tenantId: f.tenantId,
        principalRevision: 1,
        inputKind: body.kind,
        sourceId: body.sourceId,
        requiredCapabilities: ['input:write', 'flight:create'],
      });
      expect(envelope.payload).toEqual(body.payload);
      expect(await processLease(workerPool, await lease(f, eventId))).toBe(true);
      const effects = await created(f, eventId);
      expect(effects).toHaveLength(1);
      expect(effects[0].principal_id).toBe(f.origin.id);
      expect(effects[0].payload.origination).toEqual({
        inputEventId: eventId,
        issuerPrincipalRevision: 1,
        executorPrincipalId: f.worker.id,
        authorityMode: 'retained_acceptance',
      });
      const read = await app.inject({
        method: 'GET',
        url: `/v1/flights/${effects[0].payload.flightId}`,
        headers: headers(f, 'observer'),
      });
      expect(read.statusCode).toBe(200);
      const retry = await submit(f, body, `authorized-${index}`);
      expect(retry.statusCode).toBe(201);
      expect(retry.json().receipt.id).toBe(response.json().receipt.id);
      const conflict = await submit(
        f,
        { ...body, payload: { ...body.payload, label: 'Changed content' } },
        `authorized-${index}`,
      );
      expect(conflict.statusCode).toBe(409);
    }
    const reserved = await app.inject({
      method: 'POST',
      url: '/v1/inputs',
      headers: headers(f, 'origin', 'reserved'),
      payload: { ...intent(f, 'reserved'), acceptedAuthority: { principalId: f.worker.id } },
    });
    expect(reserved.statusCode).toBe(400);
  });
});
