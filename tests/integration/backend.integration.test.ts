import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import { leaseWork, processLease, type WorkLease } from '../../apps/workers/src/index.js';
import { acceptCommand } from '../../packages/domain/src/index.js';
import { authenticate, createPool, migrate, seed, withScope } from '../../packages/persistence/src/index.js';
import { sha256 } from '../../packages/integrity/src/index.js';
import type { Command, FlightSummary, TimelineResponse } from '../../packages/contracts/src/index.js';
import { drainOwnedWork, leaseExpired, settleOwnedWork, withOwnedWork } from './worker-queue.js';

const isolated = process.env.LEDGER_ENV !== 'staging';
describe.runIf(isolated)('PostgreSQL backend acceptance, isolation and recovery', () => {
  if (!process.env.WORKER_DATABASE_URL)
    throw new Error('Integration recovery tests require WORKER_DATABASE_URL for ledger_worker');
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const workerPool = createPool(process.env.WORKER_DATABASE_URL);
  let app: Awaited<ReturnType<typeof createApp>>;
  const prefix = randomUUID();
  const owned = ['tenant-alpha', 'tenant-beta'];
  const local = (role = 'operator', tenant = 'alpha') => `ledger-dev-${tenant}-${role}`;
  async function call(method: string, url: string, body?: unknown, idempotencyKey?: string, credential = local()) {
    const response = await app.inject({
      method: method as any,
      url,
      payload: body as any,
      headers: {
        authorization: `Bearer ${credential}`,
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
    });
    return {
      status: response.statusCode,
      data: response.headers['content-type']?.includes('json') ? response.json() : response.body,
    };
  }
  async function flight(label: string): Promise<FlightSummary> {
    const result = await call(
      'POST',
      '/v1/flights',
      { originationKey: `${prefix}:${label}`, label: `Integration ${label}` },
      `${prefix}:${label}`,
    );
    expect(result.status).toBe(201);
    return result.data.flight;
  }
  async function drain() {
    await drainOwnedWork(admin, workerPool, owned);
  }
  async function overlapLeases(first: WorkLease, second: WorkLease) {
    let announce!: () => void, release!: () => void;
    const announced = new Promise<void>((r) => {
        announce = r;
      }),
      held = new Promise<void>((r) => {
        release = r;
      });
    const accepting = processLease(workerPool, first, {
      beforeCommit: async () => {
        announce();
        await held;
      },
    });
    await announced;
    const url = new URL(process.env.WORKER_DATABASE_URL!);
    const applicationName = `integration-${randomUUID()}`;
    url.searchParams.set('application_name', applicationName);
    const secondPool = createPool(url.toString());
    const competing = processLease(secondPool, second);
    let blocked = false;
    try {
      for (let i = 0; i < 100; i++) {
        blocked = Boolean(
          (
            await admin.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'", [
              applicationName,
            ])
          ).rowCount,
        );
        if (blocked) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(blocked).toBe(true);
    } finally {
      release();
      expect(await Promise.all([accepting, competing])).toEqual([true, true]);
      await secondPool.end();
    }
  }
  const observe = (id: string, landing = '2026-10-01T12:00:00Z') => ({
    sourceId: `integration-feed-${prefix}`,
    kind: 'flight.observation',
    occurredAt: '2026-10-01T12:00:00Z',
    subject: { flightId: id },
    payload: { activity: 'landed', landingTime: landing },
  });
  async function timeline(id: string, credential = local()): Promise<TimelineResponse> {
    const r = await call('GET', `/v1/flights/${id}/timeline`, undefined, undefined, credential);
    expect(r.status).toBe(200);
    return r.data;
  }
  const decision = (view: TimelineResponse): Command => ({
    kind: 'decision.record',
    flightId: view.flight.id,
    expectedRevision: view.flight.revision,
    expectedBasisRevision: view.flight.basisRevision,
    inputCut: view.meta.inputCut,
    expectedDependencyBasis: view.meta.dependencyBasis!,
    decision: { kind: 'synthetic-review', note: 'Individually attributable test decision' },
  });
  beforeAll(async () => {
    await migrate(admin);
    await seed(admin);
    app = await createApp({ db: pool, env: 'test' });
    await app.ready();
  });
  afterAll(async () => {
    await settleOwnedWork(owned);
    if (app) await app.close();
    await pool.end();
    await workerPool.end();
    await admin.end();
  });
  it('runs under a non-owner role and fails closed outside transaction scope', async () => {
    const {
      rows: [role],
    } = await pool.query('SELECT current_user AS name,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user');
    expect(role).toMatchObject({ name: 'ledger_app', rolsuper: false, rolbypassrls: false });
    expect((await pool.query('SELECT id FROM flight_views')).rows).toEqual([]);
    expect((await call('GET', '/readyz')).status).toBe(200);
  });
  it('prevents cross-tenant reads and caller-supplied tenant routing', async () => {
    const f = await flight('isolation');
    expect((await call('GET', `/v1/flights/${f.id}`, undefined, undefined, local('operator', 'beta'))).status).toBe(
      404,
    );
    expect(
      (await call('POST', '/v1/inputs', { ...observe(f.id), tenantId: 'tenant-beta' }, `${prefix}:spoof`)).status,
    ).toBe(400);
    const beta = await authenticate(pool, { token: local('operator', 'beta') });
    expect(beta).not.toBeNull();
    await withScope(pool, beta!, async (c) => {
      expect((await c.query('SELECT id FROM flight_views WHERE id=$1', [f.id])).rowCount).toBe(0);
    });
  });
  it('converges same-key races and preserves independent producer attestations', async () => {
    const f = await flight('dedup');
    const body = observe(f.id);
    const key = `${prefix}:receipt-race`;
    const responses = await Promise.all(Array.from({ length: 12 }, () => call('POST', '/v1/inputs', body, key)));
    expect(responses.map((r) => r.status)).toEqual(Array(12).fill(201));
    expect(new Set(responses.map((r) => r.data.receipt.id)).size).toBe(1);
    expect((await call('POST', '/v1/inputs', { ...body, payload: { activity: 'active' } }, key)).status).toBe(409);
    const independent = await call('POST', '/v1/inputs', body, key, local('actor'));
    expect(independent.status).toBe(201);
    expect(independent.data.receipt.id).not.toBe(responses[0].data.receipt.id);
    const { rows } = await admin.query('SELECT COUNT(*) AS count FROM journal_events WHERE id=$1', [
      responses[0].data.receipt.eventId,
    ]);
    expect(Number(rows[0].count)).toBe(1);
  });
  it('returns a scoped durable receipt, verifies raw byte hashes and rejects immutable overwrite', async () => {
    const bytes = Buffer.from('Operational source bytes\r\n');
    const made = await call(
      'POST',
      '/v1/uploads',
      { contentType: 'text/plain', byteLength: bytes.length },
      `${prefix}:upload:create`,
    );
    expect(made.status).toBe(201);
    const id = made.data.upload.id;
    const wrong = await app.inject({
      method: 'PUT',
      url: `/v1/uploads/${id}/content`,
      headers: {
        authorization: `Bearer ${local()}`,
        'content-type': 'application/octet-stream',
        'idempotency-key': `${prefix}:upload:wrong`,
      },
      payload: Buffer.from('bad'),
    });
    expect(wrong.statusCode).toBe(400);
    const put = await app.inject({
      method: 'PUT',
      url: `/v1/uploads/${id}/content`,
      headers: {
        authorization: `Bearer ${local()}`,
        'content-type': 'application/octet-stream',
        'idempotency-key': `${prefix}:upload:bytes`,
      },
      payload: bytes,
    });
    expect(put.statusCode).toBe(200);
    const changed = Buffer.from(bytes);
    changed[0] ^= 1;
    const overwrite = await app.inject({
      method: 'PUT',
      url: `/v1/uploads/${id}/content`,
      headers: {
        authorization: `Bearer ${local()}`,
        'content-type': 'application/octet-stream',
        'idempotency-key': `${prefix}:upload:overwrite`,
      },
      payload: changed,
    });
    expect(overwrite.statusCode).toBe(409);
    const done = await call('POST', `/v1/uploads/${id}/finalize`, undefined, `${prefix}:upload:finalize`);
    expect(done.status).toBe(201);
    expect(done.data.artifact.sha256).toBe(sha256(bytes));
    expect(
      (await call('GET', `/v1/artifacts/${done.data.artifact.id}`, undefined, undefined, local('operator', 'beta')))
        .status,
    ).toBe(404);
    const content = await app.inject({
      method: 'GET',
      url: `/v1/artifacts/${done.data.artifact.id}/content`,
      headers: { authorization: `Bearer ${local()}` },
    });
    expect(content.rawPayload.equals(bytes)).toBe(true);
    const f = await flight('artifact');
    const receipt = await call(
      'POST',
      '/v1/inputs',
      { ...observe(f.id), artifactId: done.data.artifact.id },
      `${prefix}:artifact:input`,
    );
    expect(receipt.status).toBe(201);
    const bad = await call(
      'POST',
      '/v1/inputs',
      { ...observe(f.id), artifactId: done.data.artifact.id },
      `${prefix}:artifact:wrong-tenant`,
      local('operator', 'beta'),
    );
    expect(bad.status).toBe(404);
  });
  it('rejects credential fields before retention and preserves immutable receipts/journal', async () => {
    const f = await flight('immutability');
    const reject = await call(
      'POST',
      '/v1/inputs',
      { ...observe(f.id), payload: { authorization: 'secret' } },
      `${prefix}:secret`,
    );
    expect(reject.status).toBe(400);
    const r = await call('POST', '/v1/inputs', observe(f.id), `${prefix}:immutable`);
    const who = await authenticate(pool, { token: local() });
    await expect(
      withScope(pool, who!, (c) => c.query("UPDATE receipts SET payload='{}' WHERE id=$1", [r.data.receipt.id])),
    ).rejects.toThrow();
    await expect(
      withScope(pool, who!, (c) =>
        c.query("UPDATE journal_events SET payload='{}' WHERE id=$1", [r.data.receipt.eventId]),
      ),
    ).rejects.toThrow();
    const retained = (await admin.query('SELECT payload FROM journal_events WHERE id=$1', [r.data.receipt.eventId]))
      .rows[0].payload;
    expect(JSON.stringify(retained)).not.toContain(local());
  });
  it('rejects fabricated or future projected stream positions in a decision cut', async () => {
    const f = await flight('cut-validation');
    await drain();
    const view = await timeline(f.id);
    const unknown = decision(view);
    if (unknown.kind === 'decision.record')
      unknown.inputCut = { ...unknown.inputCut, streams: { ...unknown.inputCut.streams, [randomUUID()]: 1 } };
    expect((await call('POST', '/v1/commands', unknown, `${prefix}:unknown-cut`)).status).toBe(409);
    const next = decision(view);
    if (next.kind === 'decision.record') {
      const stream = Object.keys(next.inputCut.streams)[0];
      next.inputCut = {
        ...next.inputCut,
        streams: { ...next.inputCut.streams, [stream]: next.inputCut.streams[stream] + 1 },
      };
    }
    expect((await call('POST', '/v1/commands', next, `${prefix}:future-cut`)).status).toBe(409);
  });
  it('rejects decisions when input acceptance or assignment changes the protected basis', async () => {
    const f = await flight('basis');
    await drain();
    const original = await timeline(f.id);
    expect((await call('POST', '/v1/inputs', observe(f.id), `${prefix}:basis:input`)).status).toBe(201);
    expect((await call('POST', '/v1/commands', decision(original), `${prefix}:basis:stale-input`)).status).toBe(409);
    const newer = await timeline(f.id);
    expect(
      (
        await call(
          'POST',
          '/v1/commands',
          {
            kind: 'flight.assign',
            flightId: f.id,
            expectedRevision: newer.flight.revision,
            expectedBasisRevision: newer.flight.basisRevision,
            aircraft: 'integration-aircraft',
          },
          `${prefix}:assign`,
        )
      ).status,
    ).toBe(201);
    expect((await call('POST', '/v1/commands', decision(newer), `${prefix}:basis:stale-assignment`)).status).toBe(409);
  });
  it('serializes concurrent source projection before deriving activity and conflicts', async () => {
    await drain();
    const f = await flight('concurrent-claims');
    await drain();
    const first = await call('POST', '/v1/inputs', observe(f.id), `${prefix}:concurrent:a`);
    const second = await call(
      'POST',
      '/v1/inputs',
      {
        ...observe(f.id, '2026-10-01T12:01:00Z'),
        sourceId: `second-source-${prefix}`,
        occurredAt: '2026-10-01T12:01:00Z',
      },
      `${prefix}:concurrent:b`,
    );
    const leases = await withOwnedWork(admin, owned, () => leaseWork(workerPool, { limit: 100 }));
    const a = leases.find((l) => l.event_id === first.data.receipt.eventId)!;
    const b = leases.find((l) => l.event_id === second.data.receipt.eventId)!;
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    await overlapLeases(a, b);
    const final = await timeline(f.id);
    expect(final.flight.activity).toBe('landed');
    expect(final.flight.conflictCount).toBe(1);
    expect(final.flight.coverage).toBe('conflicting');
    expect(final.items.filter((i) => i.kind === 'flight.observation')).toHaveLength(2);
  });
  it('keeps the newest order revision when independent workers originate the same source order', async () => {
    await drain();
    const originationKey = `${prefix}:concurrent-order`,
      externalId = `${prefix}:order-worker-race`;
    const order = (revision: number, status: string) => ({
      sourceId: `order-worker-source-${prefix}`,
      kind: 'order.revision',
      sourceRevision: revision,
      occurredAt: '2026-10-01T12:00:00Z',
      subject: { orderId: externalId },
      payload: {
        externalId,
        revision,
        status,
        label: `${prefix}:concurrent-order-label`,
        fulfillments: [{ originationKey }],
      },
    });
    const first = await call('POST', '/v1/inputs', order(3, 'accepted'), `${prefix}:order-worker:newest`);
    // Independent authorized producer; observation-only actors cannot originate orders.
    const second = await call(
      'POST',
      '/v1/inputs',
      order(2, 'cancelled'),
      `${prefix}:order-worker:stale`,
      local('source'),
    );
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const leases = await withOwnedWork(admin, owned, () => leaseWork(workerPool, { limit: 100 }));
    const a = leases.find((l) => l.event_id === first.data.receipt.eventId)!,
      b = leases.find((l) => l.event_id === second.data.receipt.eventId)!;
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    await overlapLeases(a, b);
    await drain();
    const current = (
      await admin.query(
        'SELECT revision,status FROM operational_orders WHERE tenant_id=$1 AND source_id=$2 AND external_id=$3',
        ['tenant-alpha', `order-worker-source-${prefix}`, externalId],
      )
    ).rows[0];
    expect(current).toMatchObject({ revision: '3', status: 'accepted' });
    const flights = (
      await admin.query('SELECT id FROM flight_views WHERE tenant_id=$1 AND origination_key=$2', [
        'tenant-alpha',
        originationKey,
      ])
    ).rows;
    expect(flights).toHaveLength(1);
    expect((await timeline(flights[0].id)).flight.activity).toBe('planned');
    const shown = await timeline(flights[0].id);
    const correction = await call(
      'POST',
      '/v1/commands',
      {
        kind: 'evidence.correct',
        flightId: flights[0].id,
        correctionOf: first.data.receipt.eventId,
        expectedRevision: shown.flight.revision,
        expectedBasisRevision: shown.flight.basisRevision,
        inputCut: shown.meta.inputCut,
        expectedDependencyBasis: shown.meta.dependencyBasis!,
        occurredAt: '2026-10-01T12:00:00Z',
        note: 'Attempt to replace the source-owned plan using a generic correction.',
        payload: { status: 'cancelled' },
      },
      `${prefix}:order-worker:correction`,
    );
    expect(correction.status).toBe(409);
    expect(correction.data.error.code).toBe('source_revision_required');
    expect(
      Number(
        (
          await admin.query(
            "SELECT COUNT(*) FROM subjects WHERE tenant_id='tenant-alpha' AND kind='order' AND label=$1",
            [`${prefix}:concurrent-order-label`],
          )
        ).rows[0].count,
      ),
    ).toBe(1);
  });
  it('moves current observation selection while retaining relation history on both flights', async () => {
    await drain();
    const old = await flight('relink-old'),
      target = await flight('relink-target');
    await drain();
    const receipt = await call('POST', '/v1/inputs', observe(old.id), `${prefix}:relink:observation`);
    await drain();
    const original = await timeline(old.id),
      next = await timeline(target.id);
    expect(original.flight.activity).toBe('landed');
    const linked = await call(
      'POST',
      '/v1/commands',
      {
        kind: 'identity.link',
        flightId: target.id,
        receiptId: receipt.data.receipt.id,
        expectedRevision: next.flight.revision,
      },
      `${prefix}:relink:command`,
    );
    expect(linked.status).toBe(201);
    expect((await call('POST', '/v1/commands', decision(original), `${prefix}:relink:stale-old`)).status).toBe(409);
    expect((await call('POST', '/v1/commands', decision(next), `${prefix}:relink:stale-target`)).status).toBe(409);
    await drain();
    const prior = await timeline(old.id),
      current = await timeline(target.id);
    expect(prior.flight.activity).toBe('planned');
    expect(prior.flight.coverage).toBe('unknown');
    expect(current.flight.activity).toBe('landed');
    expect(prior.items.some((item) => item.id === receipt.data.receipt.eventId)).toBe(true);
    for (const view of [prior, current])
      expect(view.items.find((item) => item.id === linked.data.command.id)?.payload).toMatchObject({
        kind: 'identity.link',
        flightId: target.id,
        previousFlightId: old.id,
        receiptId: receipt.data.receipt.id,
      });
  });
  it('protects authority through decision commit and rejects a newly changed authority basis', async () => {
    const actorId = `integration-actor-${prefix}`;
    const credential = `ledger-dev-integration-${prefix}`;
    await admin.query(
      "INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,'tenant-alpha','Integration actor','human',$2)",
      [actorId, ['flight:read', 'decision:write']],
    );
    await admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [
      sha256(credential),
      actorId,
    ]);
    const actor = (await authenticate(pool, { token: credential }))!;
    const f = await flight('authority');
    await drain();
    const old = await timeline(f.id, credential);
    let announce!: () => void, release!: () => void;
    const announced = new Promise<void>((r) => {
      announce = r;
    });
    const held = new Promise<void>((r) => {
      release = r;
    });
    const accepting = withScope(
      pool,
      actor,
      async (client, who) => {
        const result = await acceptCommand(client, who, decision(old));
        announce();
        await held;
        return result;
      },
      'decision:write',
    );
    await announced;
    let changed = false;
    const authorityChange = call(
      'POST',
      '/v1/commands',
      {
        kind: 'authority.update',
        principalId: actorId,
        expectedRevision: actor.revision,
        capabilities: ['flight:read', 'decision:write'],
      },
      `${prefix}:authority`,
    ).then((r) => {
      changed = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(changed).toBe(false);
    release();
    expect((await accepting).actorId).toBe(actorId);
    expect((await authorityChange).status).toBe(201);
    const now = await timeline(f.id, credential);
    const forged = decision(now);
    if (forged.kind === 'decision.record') forged.inputCut.principalRevision = actor.revision;
    expect((await call('POST', '/v1/commands', forged, `${prefix}:stale-authority`, credential)).status).toBe(409);
  });
  it('retains the accepted decision cut while appended corrections resolve current conflicts', async () => {
    const f = await flight('correction');
    const first = await call('POST', '/v1/inputs', observe(f.id), `${prefix}:correction:a`);
    await drain();
    const view = await timeline(f.id);
    const accepted = await call('POST', '/v1/commands', decision(view), `${prefix}:correction:decision`);
    expect(accepted.status).toBe(201);
    await call('POST', '/v1/inputs', observe(f.id, '2026-10-01T12:01:00Z'), `${prefix}:correction:b`);
    await drain();
    const conflict = await timeline(f.id);
    expect(conflict.flight.conflictCount).toBe(1);
    const command = {
      kind: 'evidence.correct',
      flightId: f.id,
      expectedRevision: conflict.flight.revision,
      expectedBasisRevision: conflict.flight.basisRevision,
      inputCut: conflict.meta.inputCut,
      expectedDependencyBasis: conflict.meta.dependencyBasis!,
      correctionOf: first.data.receipt.eventId,
      occurredAt: '2026-10-01T12:00:00Z',
      note: 'Synthetic source clock correction',
      payload: { activity: 'landed', landingTime: '2026-10-01T12:01:00Z' },
    };
    expect(
      (await call('POST', '/v1/commands', command, `${prefix}:correction:foreign`, local('operator', 'beta'))).status,
    ).toBe(404);
    const other = await flight('correction-other-flight');
    await drain();
    const otherItem = (await timeline(other.id)).items.find((item) => item.kind === 'flight.created')!;
    const wrongFlight = await call(
      'POST',
      '/v1/commands',
      { ...command, correctionOf: otherItem.id },
      `${prefix}:correction:wrong-flight`,
    );
    expect(wrongFlight.status).toBe(404);
    expect(wrongFlight.data.error.code).toBe('correction_target_missing');
    const corrected = await call('POST', '/v1/commands', command, `${prefix}:correction:command`);
    expect(corrected.status).toBe(201);
    await drain();
    const final = await timeline(f.id);
    expect(final.flight.conflictCount).toBe(0);
    expect(final.items.some((i) => i.id === first.data.receipt.eventId)).toBe(true);
    expect(final.decisions[0].renderedInputCut).toEqual(view.meta.inputCut);
    expect(final.decisions[0].acceptedBasisRevision).toBe(view.flight.basisRevision);
    const nextCorrection = {
      ...command,
      expectedRevision: final.flight.revision,
      expectedBasisRevision: final.flight.basisRevision,
      inputCut: final.meta.inputCut,
      expectedDependencyBasis: final.meta.dependencyBasis!,
      correctionOf: corrected.data.command.id,
      note: 'Clarify the earlier transcription correction without replacing its history.',
    };
    const next = await call('POST', '/v1/commands', nextCorrection, `${prefix}:correction:next`);
    expect(next.status).toBe(201);
    await drain();
    const retained = await timeline(f.id);
    expect(retained.flight.conflictCount).toBe(0);
    expect(retained.items.find((item) => item.id === next.data.command.id)?.correctionOf).toBe(
      corrected.data.command.id,
    );
    expect((await call('POST', '/v1/commands', command, `${prefix}:correction:command`)).data.command).toEqual(
      corrected.data.command,
    );
    expect((await call('POST', '/v1/commands', command, `${prefix}:correction:stale`)).status).toBe(409);
  });
  it('rolls back effects of an expired lease and fences its old generation after reclaim', async () => {
    await drain();
    const f = await flight('expiry');
    const result = await admin.query(
      "SELECT * FROM work_items WHERE event_id IN(SELECT id FROM journal_events WHERE payload->>'flightId'=$1) ORDER BY stream_sequence LIMIT 1",
      [f.id],
    );
    const task = result.rows[0];
    const leases = await withOwnedWork(admin, owned, () => leaseWork(workerPool, { limit: 100, leaseSeconds: 2 }));
    const lease = leases.find((l) => l.id === task.id)!;
    expect(lease).toBeDefined();
    await expect(
      processLease(workerPool, lease, {
        beforeCommit: () => leaseExpired(admin, 'work_items', lease.id),
      }),
    ).rejects.toThrow('lost its lease');
    expect(
      Number((await admin.query('SELECT COUNT(*) FROM timeline_items WHERE flight_id=$1', [f.id])).rows[0].count),
    ).toBe(0);
    const reclaimed = (
      await withOwnedWork(admin, owned, () => leaseWork(workerPool, { limit: 100, leaseSeconds: 30 }))
    ).find((l) => l.id === task.id)!;
    expect(Number(reclaimed.generation)).toBeGreaterThan(Number(lease.generation));
    expect(await processLease(workerPool, lease)).toBe(false);
    expect(await processLease(workerPool, { ...reclaimed, event_id: randomUUID() })).toBe(false);
    expect(await processLease(workerPool, reclaimed)).toBe(true);
    expect(
      Number((await admin.query('SELECT COUNT(*) FROM timeline_items WHERE flight_id=$1', [f.id])).rows[0].count),
    ).toBe(1);
  });
  it('recovers a killed process without committing its partial projection', async () => {
    await drain();
    const f = await flight('kill');
    const task = (
      await admin.query(
        "SELECT * FROM work_items WHERE event_id IN(SELECT id FROM journal_events WHERE payload->>'flightId'=$1) ORDER BY stream_sequence LIMIT 1",
        [f.id],
      )
    ).rows[0];
    // The child loads and connects before it is handed the lease, so a slow start cannot outlast the lease.
    const script = `import {createInterface} from 'node:readline';import {createPool} from './packages/persistence/dist/index.js';import {processLease} from './apps/workers/dist/index.js';const pool=createPool(process.env.WORKER_DATABASE_URL);await pool.query('SELECT 1');process.stdout.write('ready\\n');const lines=createInterface({input:process.stdin});for await (const line of lines){const processed=await processLease(pool,JSON.parse(line),{beforeCommit:async()=>{process.stdout.write('projection-written\\n');await new Promise(()=>{});}});process.stdout.write('processed '+processed+'\\n');process.exit(0);}`;
    const child = spawn(process.execPath, ['--env-file=.env', '--input-type=module', '-e', script], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let heard = () => {};
    child.stdout.on('data', (bytes) => {
      output += String(bytes);
      heard();
    });
    const childSays = (marker: string) =>
      new Promise<void>((resolve, reject) => {
        heard = () => output.includes(marker) && resolve();
        heard();
        child.once('exit', (code) => reject(new Error(`Child worker exited (${code}) before ${marker}: ${output}`)));
        child.stderr.once('data', (bytes) => reject(new Error(String(bytes))));
      });
    await childSays('ready');
    const lease = (
      await withOwnedWork(admin, owned, () => leaseWork(workerPool, { limit: 100, leaseSeconds: 2 }))
    ).find((l) => l.id === task.id)!;
    expect(lease).toBeDefined();
    child.stdin.write(JSON.stringify(lease) + '\n');
    await childSays('projection-written');
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    expect(
      Number((await admin.query('SELECT COUNT(*) FROM timeline_items WHERE flight_id=$1', [f.id])).rows[0].count),
    ).toBe(0);
    await leaseExpired(admin, 'work_items', task.id);
    const reclaimed = (
      await withOwnedWork(admin, owned, () => leaseWork(workerPool, { limit: 100, leaseSeconds: 30 }))
    ).find((l) => l.id === task.id)!;
    expect(reclaimed).toBeDefined();
    expect(await processLease(workerPool, reclaimed)).toBe(true);
    expect(
      Number((await admin.query('SELECT COUNT(*) FROM timeline_items WHERE flight_id=$1', [f.id])).rows[0].count),
    ).toBe(1);
  });
});
