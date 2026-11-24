import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import { processLease, type WorkLease } from '../../apps/workers/src/index.js';
import { createPool, MemoryObjectStore, withScope, type AuthContext } from '../../packages/persistence/src/index.js';
import { sha256 } from '../../packages/integrity/src/index.js';
import type { Input } from '../../packages/contracts/src/index.js';
import { organization } from '../../packages/domain/src/adoptions.js';
import { lockAdoptedRules } from '../../packages/domain/src/rule-evaluations.js';
import { lockWaitStarted, runOwnedWork, settleOwnedWork } from './worker-queue.js';

describe.runIf(process.env.LEDGER_ENV !== 'staging')('PostgreSQL source intent and fulfillment revisions', () => {
  const pool = createPool(),
    admin = createPool(process.env.DATABASE_ADMIN_URL),
    workerPool = createPool(process.env.WORKER_DATABASE_URL);
  const prefix = `source-revision-${randomUUID()}`;
  let app: Awaited<ReturnType<typeof createApp>>;
  interface Fixture {
    tenantId: string;
    sourceId: string;
    token: string;
    issuer: AuthContext;
    worker: AuthContext;
    originationKey: string;
    orderId: string;
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
      sourceId = `source-${prefix}-${suffix}`,
      token = `ledger-dev-${prefix}-${suffix}`;
    const caps = ['input:write', 'flight:create', 'flight:read', 'order:read', 'evidence:read', 'identity:write'];
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, 'Fictional source revision test']);
    const issuer: AuthContext = {
      id: `issuer-${prefix}-${suffix}`,
      tenantId,
      name: 'Fictional source',
      capabilities: caps,
      revision: 1,
    };
    const worker: AuthContext = {
      id: `worker-${prefix}-${suffix}`,
      tenantId,
      name: 'Fictional worker',
      capabilities: ['flight:read'],
      revision: 1,
    };
    for (const principal of [issuer, worker])
      await admin.query('INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,$4,$5)', [
        principal.id,
        tenantId,
        principal.name,
        principal === issuer ? 'source' : 'worker',
        principal.capabilities,
      ]);
    await admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [sha256(token), issuer.id]);
    return {
      tenantId,
      sourceId,
      token,
      issuer,
      worker,
      originationKey: `${tenantId}:intent`,
      orderId: `${tenantId}:order`,
    };
  }
  const headers = (f: Fixture, key?: string) => ({
    authorization: `Bearer ${f.token}`,
    ...(key ? { 'idempotency-key': `${prefix}:${key}` } : {}),
  });
  const intent = (f: Fixture, revision: number, orderRevision: number, quantity: number): Input => ({
    sourceId: f.sourceId,
    kind: 'intent.revision',
    sourceRevision: revision,
    occurredAt: '2026-10-02T12:00:00Z',
    subject: { originationKey: f.originationKey },
    payload: {
      originationKey: f.originationKey,
      label: `Intent revision ${revision}`,
      orderRefs: [{ orderId: f.orderId, revision: orderRevision, quantity }],
    },
  });
  async function submit(f: Fixture, body: Input, key: string) {
    const response = await app.inject({ method: 'POST', url: '/v1/inputs', headers: headers(f, key), payload: body });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().receipt;
  }
  async function lease(f: Fixture, eventId: string): Promise<WorkLease> {
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
  async function project(f: Fixture, receipt: { eventId: string }) {
    expect(await processLease(workerPool, await lease(f, receipt.eventId))).toBe(true);
  }
  async function fulfillment(f: Fixture) {
    return (
      await admin.query(
        'SELECT order_revision,quantity FROM fulfillments WHERE tenant_id=$1 AND source_id=$2 AND order_external_id=$3',
        [f.tenantId, f.sourceId, f.orderId],
      )
    ).rows[0];
  }

  it('rejects changed intent content at the same source revision without changing the current fulfillment', async () => {
    const f = await fixture('same-revision');
    const first = await submit(f, intent(f, 5, 7, 12), 'same:first');
    await project(f, first);
    const changed = await submit(f, intent(f, 5, 7, 99), 'same:changed');
    await expect(processLease(workerPool, await lease(f, changed.eventId))).rejects.toMatchObject({
      status: 409,
      code: 'source_revision_conflict',
    });
    expect(await fulfillment(f)).toMatchObject({ order_revision: '7', quantity: '12' });
    expect(
      Number(
        (await admin.query('SELECT COUNT(*) AS count FROM receipts WHERE tenant_id=$1', [f.tenantId])).rows[0].count,
      ),
    ).toBe(2);
    // Exercise the real worker's terminal retry path for this fixture only.
    // An earliest ready timestamp makes its final attempt the bounded claim.
    await withScope(workerPool, f.worker, (client) =>
      client.query(
        "UPDATE work_items SET state='pending',attempts=4,available_at='-infinity',lease_until=NULL WHERE event_id=$1",
        [changed.eventId],
      ),
    );
    await runOwnedWork(admin, workerPool, [`tenant-${prefix}`], { limit: 1 });
    const read = await app.inject({ method: 'GET', url: `/v1/receipts/${changed.id}`, headers: headers(f) });
    expect(read.json().receipt.processing).toMatchObject({
      status: 'failed',
      attempts: 5,
      error: 'Same source intent revision carries conflicting content',
    });
    expect(read.json().receipt.payload).toEqual(intent(f, 5, 7, 99).payload);
  });

  it('projects a new flight while an adoption is projected for its organization, in one lock order', async () => {
    const f = await fixture('adoption-lock-order');
    const intentLease = await lease(f, (await submit(f, intent(f, 1, 1, 1), 'adoption-lock-order')).eventId);
    // An adoption's projection takes the tenant's lock on its adopted rules, then the organization row; the intent
    // that creates a flight of that organization is projected while the first is held.
    let projected: Promise<boolean> | undefined;
    await withScope(workerPool, f.worker, async (client) => {
      await lockAdoptedRules(client, f.tenantId, 'exclusive');
      projected = processLease(workerPool, intentLease);
      projected.catch(() => undefined);
      await lockWaitStarted(admin);
      await organization(client, f.tenantId, 'UPDATE');
    });
    expect(await projected).toBe(true);
    expect(await fulfillment(f)).toMatchObject({ order_revision: '1', quantity: '1' });
  });

  it('does not regress quantity when a newer intent carries an older referenced order revision', async () => {
    const f = await fixture('stale-quantity');
    await project(f, await submit(f, intent(f, 5, 7, 12), 'stale:first'));
    await project(f, await submit(f, intent(f, 6, 6, 4), 'stale:new-intent-old-order'));
    expect(await fulfillment(f)).toMatchObject({ order_revision: '7', quantity: '12' });
  });

  it('separates awaiting orders from orphan evidence through dispatch and cancellation within the authenticated tenant', async () => {
    const f = await fixture('awaiting-orders');
    const other = await fixture('other-awaiting-orders');
    const order = (orderId: string, revision = 1, status = 'accepted', fulfillments: unknown[] = []): Input => ({
      sourceId: f.sourceId,
      kind: 'order.revision',
      sourceRevision: revision,
      occurredAt: '2026-10-15T12:00:00Z',
      subject: { orderId },
      payload: { externalId: orderId, revision, status, label: orderId, fulfillments },
    });
    for (const [id, status] of [
      [f.orderId, 'accepted'],
      [`${f.orderId}:second`, 'accepted'],
      [`${f.orderId}:cancelled`, 'cancelled'],
    ])
      await project(f, await submit(f, order(id, 1, status), id));
    await project(other, await submit(other, order(f.orderId), 'foreign-order'));
    const orphan = await submit(
      f,
      {
        sourceId: f.sourceId,
        kind: 'flight.observation',
        occurredAt: '2026-10-15T12:00:00Z',
        subject: { externalFlightId: `${prefix}:unknown-flight` },
        payload: { activity: 'active' },
      },
      'orphan-observation',
    );
    await project(f, orphan);
    const read = async (url: string, subject = f) => {
      const response = await app.inject({ method: 'GET', url, headers: headers(subject) });
      expect(response.statusCode, response.body).toBe(200);
      return response.json();
    };
    const url = '/v1/orders?view=awaiting-flight&limit=1';
    const first = await read(url);
    expect(first.orders).toHaveLength(1);
    expect(first.page.hasMore).toBe(true);
    const next = await read(`${url}&cursor=${encodeURIComponent(first.page.nextCursor)}`);
    expect(next.orders).toHaveLength(1);
    expect(next.page.hasMore).toBe(false);
    expect([first.orders[0].externalId, next.orders[0].externalId].sort()).toEqual(
      [f.orderId, `${f.orderId}:second`].sort(),
    );
    expect((await read('/v1/orders?view=awaiting-flight', other)).orders).toHaveLength(1);
    const changedView = await app.inject({
      method: 'GET',
      url: `/v1/orders?cursor=${encodeURIComponent(first.page.nextCursor)}`,
      headers: headers(f),
    });
    expect(changedView.statusCode).toBe(400);
    const evidence = await read('/v1/receipts?linkStatus=unlinked&excludeKind=order.revision&limit=1');
    expect(evidence.receipts.map((receipt: { id: string }) => receipt.id)).toEqual([orphan.id]);
    expect(evidence.page.hasMore).toBe(false);

    await project(
      f,
      await submit(
        f,
        order(f.orderId, 2, 'accepted', [{ originationKey: f.originationKey, label: 'Dispatched order flight' }]),
        'dispatch-order',
      ),
    );
    let remaining = await read('/v1/orders?view=awaiting-flight');
    expect(remaining.orders.map((row: { externalId: string }) => row.externalId)).toEqual([`${f.orderId}:second`]);
    await project(f, await submit(f, order(`${f.orderId}:second`, 2, 'cancelled'), 'cancel-order'));
    remaining = await read('/v1/orders?view=awaiting-flight');
    expect(remaining.orders).toEqual([]);
    const retained = await read('/v1/orders');
    expect(retained.orders).toHaveLength(3);
    expect(retained.orders.find((row: { externalId: string }) => row.externalId === f.orderId).flightIds).toHaveLength(
      1,
    );
    expect((await read('/v1/orders?view=awaiting-flight', other)).orders).toHaveLength(1);
  });

  it('separates elapsed requested order windows before pagination without cancelling accepted orders', async () => {
    const f = await fixture('order-window-scopes');
    const foreign = await fixture('foreign-order-window-scopes');
    const now = Date.now();
    const ended = new Date(now - 60_000).toISOString();
    const upcoming = new Date(now + 60_000).toISOString();
    async function accept(owner: Fixture, suffix: string, scheduledEnd: string) {
      const orderId = `${owner.orderId}:${suffix}`;
      const input: Input = {
        sourceId: owner.sourceId,
        kind: 'order.revision',
        sourceRevision: 1,
        occurredAt: new Date(now).toISOString(),
        subject: { orderId },
        payload: { externalId: orderId, revision: 1, status: 'accepted', scheduledEnd, fulfillments: [] },
      };
      await project(owner, await submit(owner, input, suffix));
      return orderId;
    }
    const elapsedId = await accept(f, 'elapsed', ended);
    const upcomingId = await accept(f, 'upcoming', upcoming);
    const unconfirmedId = await accept(f, 'unconfirmed', '2026-02-30T12:00:00.000Z');
    await accept(foreign, 'elapsed', ended);
    async function read(view: string, owner = f, continuation?: string) {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/orders?view=${view}&limit=1${continuation ? `&cursor=${encodeURIComponent(continuation)}` : ''}`,
        headers: headers(owner),
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json();
    }
    const overdue = await read('awaiting-overdue');
    expect(overdue.orders.map((row: { externalId: string }) => row.externalId)).toEqual([elapsedId]);
    expect(overdue.orders[0]).toMatchObject({ status: 'accepted', flightIds: [], payload: { scheduledEnd: ended } });
    expect(overdue.page.hasMore).toBe(false);
    const current = await read('awaiting-current');
    expect(current.page.hasMore).toBe(true);
    const next = await read('awaiting-current', f, current.page.nextCursor);
    expect(next.page.hasMore).toBe(false);
    expect([...current.orders, ...next.orders].map((row: { externalId: string }) => row.externalId).sort()).toEqual(
      [upcomingId, unconfirmedId].sort(),
    );
    const wrongScope = await app.inject({
      method: 'GET',
      url: `/v1/orders?view=awaiting-overdue&cursor=${encodeURIComponent(current.page.nextCursor)}`,
      headers: headers(f),
    });
    expect(wrongScope.statusCode).toBe(400);
    const foreignOverdue = await read('awaiting-overdue', foreign);
    expect(foreignOverdue.orders[0].externalId).not.toBe(elapsedId);
  });
});
