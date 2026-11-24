import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import { processLease, type WorkLease } from '../../apps/workers/src/index.js';
import { linkSubjectDependency, retainSubjectEvidence } from '../../packages/domain/src/index.js';
import {
  appendEvent,
  createPool,
  MemoryObjectStore,
  withScope,
  type AuthContext,
  type JournalEvent,
} from '../../packages/persistence/src/index.js';
import { sha256 } from '../../packages/integrity/src/index.js';
import type {
  Command,
  FlightCreate,
  FlightSummary,
  Input,
  Receipt,
  TimelineResponse,
} from '../../packages/contracts/src/index.js';
import { settleOwnedWork } from './worker-queue.js';

describe.runIf(process.env.LEDGER_ENV !== 'staging')('PostgreSQL subject-scoped decision cuts', () => {
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const workerPool = createPool(process.env.WORKER_DATABASE_URL);
  const prefix = `scoped-cut-${randomUUID()}`;
  let app: Awaited<ReturnType<typeof createApp>>;
  interface Fixture {
    tenantId: string;
    sourceId: string;
    token: string;
    actor: AuthContext;
    worker: AuthContext;
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
    const tenantId = `tenant-${prefix}-${suffix}`;
    const token = `ledger-dev-${prefix}-${suffix}`;
    const capabilities = [
      'input:write',
      'flight:create',
      'flight:read',
      'evidence:read',
      'identity:write',
      'decision:write',
    ];
    const actor: AuthContext = {
      id: `actor-${prefix}-${suffix}`,
      tenantId,
      name: 'Fictional coordinator',
      capabilities,
      revision: 1,
    };
    const worker: AuthContext = { ...actor, id: `worker-${prefix}-${suffix}`, name: 'Fictional worker' };
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, 'Scoped evidence test']);
    for (const principal of [actor, worker])
      await admin.query('INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,$4,$5)', [
        principal.id,
        tenantId,
        principal.name,
        principal === actor ? 'human' : 'worker',
        capabilities,
      ]);
    await admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [sha256(token), actor.id]);
    return { tenantId, sourceId: `source-${suffix}`, token, actor, worker };
  }
  const headers = (f: Fixture, key?: string) => ({
    authorization: `Bearer ${f.token}`,
    ...(key ? { 'idempotency-key': `${prefix}:${key}` } : {}),
  });
  async function project(f: Fixture, eventId: string) {
    const lease = await withScope(workerPool, f.worker, async (client) => {
      const row = (
        await client.query<Omit<WorkLease, 'worker_id'>>(
          "UPDATE work_items SET state='leased',generation=generation+1,attempts=attempts+1,lease_owner=$1,lease_until=clock_timestamp()+interval '30 seconds' WHERE event_id=$2 AND state='pending' RETURNING *",
          [prefix, eventId],
        )
      ).rows[0];
      expect(row).toBeDefined();
      return { ...row, worker_id: f.worker.id };
    });
    expect(await processLease(workerPool, lease)).toBe(true);
  }
  async function event(id: string): Promise<JournalEvent> {
    return (await admin.query<JournalEvent>('SELECT * FROM journal_events WHERE id=$1', [id])).rows[0];
  }
  async function projectCreation(f: Fixture, flightId: string) {
    const created = (
      await admin.query<JournalEvent>(
        "SELECT * FROM journal_events WHERE tenant_id=$1 AND event_type='flight.created' AND payload->>'flightId'=$2",
        [f.tenantId, flightId],
      )
    ).rows[0];
    await project(f, created.id);
    return created;
  }
  async function createFlight(f: Fixture, name: string, extra: Partial<FlightCreate> = {}): Promise<FlightSummary> {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/flights',
      headers: headers(f, `${f.tenantId}:${name}`),
      payload: { originationKey: `${f.tenantId}:${name}`, label: name, ...extra },
    });
    expect(response.statusCode, response.body).toBe(201);
    const flight = response.json().flight as FlightSummary;
    await projectCreation(f, flight.id);
    return flight;
  }
  async function submit(f: Fixture, body: Input): Promise<Receipt> {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/inputs',
      headers: headers(f, randomUUID()),
      payload: body,
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().receipt;
  }
  const observation = (f: Fixture, subject: Input['subject'], sourceSessionId = 'shared'): Input => ({
    sourceId: f.sourceId,
    sourceSessionId,
    kind: 'flight.observation',
    occurredAt: '2026-10-14T12:00:00Z',
    subject,
    payload: { activity: 'airborne' },
  });
  async function timeline(f: Fixture, flightId: string): Promise<TimelineResponse> {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/flights/${flightId}/timeline`,
      headers: headers(f),
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }
  const decision = (view: TimelineResponse): Extract<Command, { kind: 'decision.record' }> => ({
    kind: 'decision.record',
    flightId: view.flight.id,
    expectedRevision: view.flight.revision,
    expectedBasisRevision: view.flight.basisRevision,
    inputCut: structuredClone(view.meta.inputCut),
    expectedDependencyBasis: view.meta.dependencyBasis!,
    decision: { kind: 'synthetic-review', note: 'Reviewed the displayed scoped evidence' },
  });
  const command = (f: Fixture, payload: Command) =>
    app.inject({ method: 'POST', url: '/v1/commands', headers: headers(f, randomUUID()), payload });

  it('keeps a quiet flight stable across unrelated streams and shared-stream activity, while pinning pending input', async () => {
    const f = await fixture('frontiers');
    const a = await createFlight(f, 'A');
    const b = await createFlight(f, 'B');
    const aReceipt = await submit(f, observation(f, { flightId: a.id }));
    await project(f, aReceipt.eventId);
    const initial = await timeline(f, a.id);
    const bReceipt = await submit(f, observation(f, { flightId: b.id }, 'separate'));
    await project(f, bReceipt.eventId);
    const bEvent = await event(bReceipt.eventId);
    expect(initial.meta.inputCut.streams).not.toHaveProperty(bEvent.stream_id);
    for (const stream of Object.keys((await timeline(f, b.id)).meta.inputCut.streams))
      expect(initial.meta.inputCut.streams).not.toHaveProperty(stream);
    const sharedB = await submit(f, observation(f, { flightId: b.id }));
    await project(f, sharedB.eventId);
    const quiet = await timeline(f, a.id);
    expect(quiet.meta.inputCut).toEqual(initial.meta.inputCut);
    expect(quiet.meta.dependencyBasis).toBe(initial.meta.dependencyBasis);
    const list = await app.inject({ method: 'GET', url: '/v1/flights', headers: headers(f) });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().meta.inputCut.streams).toEqual({});

    const pending = await submit(f, observation(f, { flightId: a.id }));
    const pendingEvent = await event(pending.eventId);
    const displayed = await timeline(f, a.id);
    expect(displayed.meta.inputCut.streams[pendingEvent.stream_id]).toBeLessThan(Number(pendingEvent.stream_sequence));
    expect(displayed.items.some((item) => item.id === pending.eventId)).toBe(false);
    const accepted = await command(f, decision(displayed));
    expect(accepted.statusCode, accepted.body).toBe(201);
    const retained = (await timeline(f, a.id)).decisions.find((item) => item.id === accepted.json().command.id)!;
    expect(retained.renderedInputCut).toEqual(displayed.meta.inputCut);
    expect(retained.acceptedInputCut.streams[pendingEvent.stream_id]).toBe(Number(pendingEvent.stream_sequence));
    expect(retained.renderedInputCut.streams[pendingEvent.stream_id]).toBeLessThan(
      Number(pendingEvent.stream_sequence),
    );
    expect(retained.acceptedInputCut.streams).not.toHaveProperty(bEvent.stream_id);
    await project(f, pending.eventId);
    await project(f, accepted.json().command.id);
  });

  it('rejects incomplete or foreign cuts and invalidates dependencies without changing the flight revision', async () => {
    const f = await fixture('dependencies');
    const a = await createFlight(f, 'A');
    const b = await createFlight(f, 'B');
    const first = await submit(f, observation(f, { flightId: b.id }));
    await project(f, first.eventId);
    const before = await timeline(f, a.id);
    const foreign = await timeline(f, b.id);
    const [stream, sequence] = Object.entries(before.meta.inputCut.streams)[0];
    for (const streams of [
      {},
      { ...before.meta.inputCut.streams, ...foreign.meta.inputCut.streams },
      { ...before.meta.inputCut.streams, [stream]: sequence + 1 },
    ]) {
      const altered = decision(before);
      altered.inputCut.streams = streams;
      const rejected = await command(f, altered);
      expect(rejected.statusCode, rejected.body).toBe(409);
    }
    const relation = await withScope(pool, f.actor, async (client, actor) => {
      const linked = await appendEvent(client, actor, {
        type: 'subject.dependency.linked',
        stream: `flight:${a.id}`,
        payload: { flightId: a.id, dependencyId: b.id },
      });
      await retainSubjectEvidence(client, f.tenantId, [a.id], linked);
      await linkSubjectDependency(client, f.tenantId, a.id, b.id, linked.id);
      return linked;
    });
    await project(f, relation.id);
    const reviewed = await timeline(f, a.id);
    for (const dependencyStream of Object.keys(foreign.meta.inputCut.streams))
      expect(reviewed.meta.inputCut.streams).toHaveProperty(dependencyStream);
    const pending = await submit(f, observation(f, { flightId: b.id }));
    const changed = await timeline(f, a.id);
    expect(changed.flight.revision).toBe(reviewed.flight.revision);
    expect(changed.flight.basisRevision).toBe(reviewed.flight.basisRevision);
    expect(changed.meta.inputCut).toEqual(reviewed.meta.inputCut);
    expect(changed.meta.dependencyBasis).not.toBe(reviewed.meta.dependencyBasis);
    const stale = await command(f, decision(reviewed));
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json().error.code).toBe('stale_basis');
    const refreshed = await command(f, decision(changed));
    expect(refreshed.statusCode, refreshed.body).toBe(201);
    const retained = (await timeline(f, a.id)).decisions.find((item) => item.id === refreshed.json().command.id)!;
    const pendingEvent = await event(pending.eventId);
    expect(retained.acceptedInputCut.streams[pendingEvent.stream_id]).toBe(Number(pendingEvent.stream_sequence));
    await project(f, pending.eventId);
    await project(f, refreshed.json().command.id);
  });

  it('retains prior alias evidence and shared orders for every flight, then preserves both sides of an identity move', async () => {
    const f = await fixture('relationships');
    const externalFlightId = `${f.tenantId}:shared-alias`;
    const prior = await submit(f, observation(f, { externalFlightId }, 'alias'));
    await project(f, prior.eventId);
    const priorEvent = await event(prior.eventId);
    const order = await submit(f, {
      sourceId: f.sourceId,
      sourceSessionId: 'orders',
      kind: 'order.revision',
      occurredAt: '2026-10-14T12:01:00Z',
      sourceRevision: 1,
      subject: { orderId: `${f.tenantId}:order` },
      payload: {
        status: 'accepted',
        fulfillments: ['A', 'B'].map((name) => ({
          originationKey: `${f.tenantId}:${name}`,
          label: name,
          aliases: [{ sourceId: f.sourceId, externalId: externalFlightId }],
        })),
      },
    });
    await project(f, order.eventId);
    const list = await app.inject({ method: 'GET', url: '/v1/flights', headers: headers(f) });
    expect(list.statusCode, list.body).toBe(200);
    const flights = list.json().flights as FlightSummary[];
    expect(flights).toHaveLength(2);
    for (const flight of flights) await projectCreation(f, flight.id);
    const orderEvent = await event(order.eventId);
    for (const flight of flights) {
      const view = await timeline(f, flight.id);
      expect(view.meta.inputCut.streams[priorEvent.stream_id]).toBe(Number(priorEvent.stream_sequence));
      expect(view.meta.inputCut.streams[orderEvent.stream_id]).toBe(Number(orderEvent.stream_sequence));
    }
    const ambiguous = await submit(f, observation(f, { externalFlightId }, 'alias'));
    expect(ambiguous.linkStatus).toBe('candidate');
    await project(f, ambiguous.eventId);
    const ambiguousEvent = await event(ambiguous.eventId);
    for (const flight of flights)
      expect((await timeline(f, flight.id)).meta.inputCut.streams[ambiguousEvent.stream_id]).toBe(
        Number(ambiguousEvent.stream_sequence),
      );
    const [a, b] = flights;
    const assign = async (flightId: string) => {
      const view = await timeline(f, flightId);
      const linked = await command(f, {
        kind: 'identity.link',
        flightId,
        receiptId: ambiguous.id,
        expectedRevision: view.flight.revision,
      });
      expect(linked.statusCode, linked.body).toBe(201);
      await project(f, linked.json().command.id);
      return event(linked.json().command.id);
    };
    await assign(a.id);
    const moved = await assign(b.id);
    for (const flight of flights) {
      const view = await timeline(f, flight.id);
      expect(view.meta.inputCut.streams[ambiguousEvent.stream_id]).toBe(Number(ambiguousEvent.stream_sequence));
      expect(view.meta.inputCut.streams[moved.stream_id]).toBe(Number(moved.stream_sequence));
      expect(view.items.some((item) => item.id === ambiguous.eventId)).toBe(true);
      expect(view.items.some((item) => item.id === moved.id)).toBe(true);
    }
  });

  it('backfills pending payload-based intents at origination and prior order evidence when a relationship is added', async () => {
    const f = await fixture('backfill');
    const originationKey = `${f.tenantId}:intent`;
    const intent = (sourceSessionId: string, sourceRevision: number, payload: Input['payload']): Input => ({
      sourceId: f.sourceId,
      sourceSessionId,
      kind: 'intent.revision',
      sourceRevision,
      occurredAt: '2026-10-14T12:00:00Z',
      subject: {},
      payload,
    });
    const first = await submit(f, intent('first-intent', 1, { originationKey, label: 'Initial intent' }));
    const pending = await submit(
      f,
      intent('pending-intent', 2, { intent: { originationKey, label: 'Pending revised intent' } }),
    );
    await project(f, first.eventId);
    const list = await app.inject({ method: 'GET', url: '/v1/flights', headers: headers(f) });
    expect(list.statusCode, list.body).toBe(200);
    const flights = list.json().flights as FlightSummary[];
    expect(flights).toHaveLength(1);
    const flight = flights[0];
    await projectCreation(f, flight.id);
    const firstEvent = await event(first.eventId);
    const pendingEvent = await event(pending.eventId);
    const displayed = await timeline(f, flight.id);
    expect(displayed.meta.inputCut.streams[firstEvent.stream_id]).toBe(Number(firstEvent.stream_sequence));
    expect(displayed.meta.inputCut.streams[pendingEvent.stream_id]).toBe(0);
    const accepted = await command(f, decision(displayed));
    expect(accepted.statusCode, accepted.body).toBe(201);
    const retained = (await timeline(f, flight.id)).decisions.find((item) => item.id === accepted.json().command.id)!;
    for (const input of [firstEvent, pendingEvent])
      expect(retained.acceptedInputCut.streams[input.stream_id]).toBe(Number(input.stream_sequence));
    await project(f, accepted.json().command.id);
    await project(f, pending.eventId);

    const orderId = `${f.tenantId}:independent-order`;
    const order = await submit(f, {
      sourceId: f.sourceId,
      sourceSessionId: 'independent-order',
      kind: 'order.revision',
      sourceRevision: 4,
      occurredAt: '2026-10-14T12:01:00Z',
      subject: { orderId },
      payload: { status: 'accepted' },
    });
    await project(f, order.eventId);
    const orderEvent = await event(order.eventId);
    expect((await timeline(f, flight.id)).meta.inputCut.streams).not.toHaveProperty(orderEvent.stream_id);
    const linked = await submit(
      f,
      intent('linked-order', 3, { originationKey, orderRefs: [{ orderId, revision: 4, quantity: 1 }] }),
    );
    await project(f, linked.eventId);
    const updated = await timeline(f, flight.id);
    expect(updated.meta.inputCut.streams[orderEvent.stream_id]).toBe(Number(orderEvent.stream_sequence));
    expect(updated.flight.id).toBe(flight.id);
  });
});
