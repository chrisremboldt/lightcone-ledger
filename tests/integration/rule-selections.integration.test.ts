import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import { processRuleSelectionLease, type RuleSelectionLease } from '../../apps/workers/src/index.js';
import type {
  Command,
  FlightRuleSelectionRecordV1,
  FlightRuleSelectionResponse,
  TimelineResponse,
} from '../../packages/contracts/src/index.js';
import { FlightRuleSelectionRecordResponseSchema } from '../../packages/contracts/src/rule-selection.js';
import { FlightRuleSelectionResponseSchema } from '../../packages/contracts/src/openapi.js';
import { adoptShownPack } from '../../packages/contracts/fixtures/demo/v1/ready.js';
import { acceptCommand, getRulePackVersion } from '../../packages/domain/src/index.js';
import {
  appendEvent,
  createPool,
  MemoryObjectStore,
  withScope,
  type AuthContext,
} from '../../packages/persistence/src/index.js';
import { canonicalDigest, sha256 } from '../../packages/integrity/src/index.js';
import { leaseExpired, projectOwnedWork, settleOwnedWork } from './worker-queue.js';

interface Fixture {
  actor: AuthContext;
  worker: AuthContext;
  token: string;
}

describe.runIf(process.env.LEDGER_ENV !== 'staging')('PostgreSQL flight rule selection', () => {
  const prefix = `selection-${randomUUID()}`;
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const workerPool = createPool(process.env.WORKER_DATABASE_URL);
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  const valid = ajv.compile(FlightRuleSelectionResponseSchema);
  const validRecord = ajv.compile(FlightRuleSelectionRecordResponseSchema);
  let app: Awaited<ReturnType<typeof createApp>>;
  beforeAll(async () => {
    app = await createApp({ pool, env: 'test', objectStore: new MemoryObjectStore() });
    await app.ready();
  });
  afterAll(async () => {
    await settleOwnedWork([prefix]);
    await app?.close();
    await pool.end();
    await admin.end();
    await workerPool.end();
  });
  async function fixture(
    name: string,
    capabilities = ['flight:read', 'flight:create', 'decision:write', 'pack:adopt'],
  ): Promise<Fixture> {
    const tenantId = `${prefix}:${name}`;
    const actor: AuthContext = {
      id: `${tenantId}:actor`,
      tenantId,
      name: 'Selection owner',
      kind: 'human',
      revision: 1,
      capabilities,
    };
    const worker = { ...actor, id: `${tenantId}:worker`, kind: 'worker' };
    const token = `ledger-dev-${tenantId}`;
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, 'Selection fixture']);
    for (const who of [actor, worker])
      await admin.query('INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,$4,$5)', [
        who.id,
        tenantId,
        who.name,
        who.kind,
        who.capabilities,
      ]);
    await admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [sha256(token), actor.id]);
    return { actor, worker, token };
  }
  function call(f: Fixture, method: 'GET' | 'POST', url: string, payload?: unknown) {
    return app.inject({
      method,
      url,
      payload,
      headers: { authorization: `Bearer ${f.token}`, 'idempotency-key': randomUUID() },
    });
  }
  async function flight(f: Fixture, legacy = false) {
    if (legacy)
      return withScope(pool, f.actor, async (client, who) => {
        const id = randomUUID();
        await client.query("INSERT INTO subjects(id,tenant_id,kind,label) VALUES($1,$2,'flight','Old flight')", [
          id,
          who.tenantId,
        ]);
        await appendEvent(client, who, {
          type: 'flight.created',
          stream: `flight:${id}`,
          payload: { flightId: id, originationKey: id },
        });
        await client.query('INSERT INTO flight_views(id,tenant_id,origination_key,label) VALUES($1,$2,$1,$1)', [
          id,
          who.tenantId,
        ]);
        return id;
      });
    const response = await call(f, 'POST', '/v1/flights', { originationKey: randomUUID() });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().flight.id as string;
  }
  async function sourceDrain(f: Fixture) {
    await projectOwnedWork(admin, workerPool, [f.worker.tenantId]);
  }
  async function selectionLease(f: Fixture, id?: string, seconds = 30): Promise<RuleSelectionLease | null> {
    return withScope(workerPool, f.worker, async (client) => {
      const row = (
        await client.query<RuleSelectionLease>(
          `SELECT * FROM selection_work
        WHERE (state='pending' AND available_at<=clock_timestamp() AND due_at<=clock_timestamp()
          OR state='leased' AND lease_until<clock_timestamp()) AND ($1::text IS NULL OR id=$1)
        ORDER BY available_at,id LIMIT 1 FOR UPDATE`,
          [id ?? null],
        )
      ).rows[0];
      if (!row) return null;
      const updated = (
        await client.query<RuleSelectionLease>(
          `UPDATE selection_work SET state='leased',generation=generation+1,attempts=attempts+1,
        lease_owner=$1,lease_until=clock_timestamp()+make_interval(secs=>$3::double precision) WHERE id=$2 RETURNING *`,
          [prefix, row.id, seconds],
        )
      ).rows[0];
      return { ...updated, worker_id: f.worker.id };
    });
  }
  async function selectionDrain(f: Fixture) {
    for (let count = 0; count < 40; count++) {
      const lease = await selectionLease(f);
      if (!lease) return;
      expect(await processRuleSelectionLease(workerPool, lease)).toBe(true);
    }
    throw new Error('Selection work did not drain');
  }
  async function shown(f: Fixture, id: string): Promise<FlightRuleSelectionResponse> {
    const response = await call(f, 'GET', `/v1/flights/${id}/rule-selection`);
    expect(response.statusCode, response.body).toBe(200);
    expect(valid(response.json()), JSON.stringify(valid.errors)).toBe(true);
    return response.json();
  }
  async function timeline(f: Fixture, id: string): Promise<TimelineResponse> {
    const response = await call(f, 'GET', `/v1/flights/${id}/timeline`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }
  function decision(displayed: TimelineResponse): Command {
    return {
      kind: 'decision.record',
      flightId: displayed.flight.id,
      expectedRevision: displayed.flight.revision,
      expectedBasisRevision: displayed.flight.basisRevision,
      inputCut: displayed.meta.inputCut,
      expectedDependencyBasis: displayed.meta.dependencyBasis!,
      decision: { kind: 'review', note: 'Reviewed this displayed flight basis.' },
    };
  }
  async function adoption(f: Fixture, start: string, end: string) {
    const coverage = (await call(f, 'GET', '/v1/organization/coverage')).json();
    const command = adoptShownPack(
      coverage,
      getRulePackVersion('ledger.demo-procedures', 5)!,
      { start, end },
      'Selection fixture.',
      'active',
    );
    const accepted = await call(f, 'POST', '/v1/commands', command);
    expect(accepted.statusCode, accepted.body).toBe(201);
    return accepted.json().command.id as string;
  }
  async function times(startMs: number, endMs: number) {
    const now = (await admin.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now.getTime();
    return { start: new Date(now + startMs).toISOString(), end: new Date(now + endMs).toISOString() };
  }
  async function passBoundary(at: string) {
    await admin.query('SELECT pg_sleep(GREATEST(EXTRACT(EPOCH FROM $1::timestamptz-clock_timestamp()),0)+0.03)', [at]);
  }

  it('registers tenant dependencies and selects exact pending/projected execution', async () => {
    const f = await fixture('provenance');
    const other = await fixture('other');
    const id = await flight(f);
    expect((await shown(f, id)).convergence).toEqual({ status: 'pending', reason: 'bootstrap' });
    await sourceDrain(f);
    await selectionDrain(f);
    const baseline = await shown(f, id);
    expect(baseline.selection?.selection.state).toBe('not_adopted');
    const before = await timeline(f, id);
    const interval = await times(-60_000, 60_000);
    const adopted = await adoption(f, interval.start, interval.end);
    const rejected = await call(f, 'POST', '/v1/commands', decision(before));
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().error.code).toBe('stale_basis');
    await selectionDrain(f);
    expect((await shown(f, id)).selection?.selection.state).toBe('pending');
    await sourceDrain(f);
    expect((await shown(f, id)).convergence.reason).toBe('organization_changed');
    await selectionDrain(f);
    const eligible = await shown(f, id);
    expect(eligible.convergence.status).toBe('current');
    const pack = getRulePackVersion('ledger.demo-procedures', 5)!;
    expect(eligible.selection).toMatchObject({
      version: 'flight.rule-selection.3',
      selection: { state: 'eligible', adoption: { id: adopted, pack: { version: 5, digest: pack.digest } } },
      execution: { status: 'active', evaluator: { id: 'ledger.rule-evaluator', version: 1 } },
    });
    // The selection names the adopted pack's checked rules about flights, read from the adoption, not from any id.
    expect(
      eligible.selection!.version === 'flight.rule-selection.3' && eligible.selection!.selection.adoption!.rules,
    ).toEqual(
      pack.leaves
        .filter((leaf) => 'check' in leaf && leaf.target.subjectKind === 'flight')
        .map(({ id, version, digest }) => ({ id, version, digest })),
    );
    expect(eligible.selection!.basisManifest.subjects).toEqual(
      expect.arrayContaining([id, `organization:${f.actor.tenantId}`]),
    );
    expect((await call(other, 'GET', `/v1/flights/${id}/rule-selection`)).statusCode).toBe(404);
    const count = await admin.query(
      'SELECT count(*)::int AS count FROM flight_rule_selections WHERE tenant_id=$1 AND flight_id=$2',
      [f.actor.tenantId, id],
    );
    await selectionDrain(f);
    expect((await shown(f, id)).selection?.id).toBe(eligible.selection!.id);
    expect(Number(count.rows[0].count)).toBe(3);
  });

  it('reads exact retained selections across current changes within the authorized flight scope', async () => {
    const f = await fixture('history');
    const other = await fixture('history-other');
    const denied = await fixture('history-denied', []);
    const id = await flight(f);
    const anotherFlight = await flight(f);
    await sourceDrain(f);
    await selectionDrain(f);
    const original = (await shown(f, id)).selection!;
    const path = `/v1/flights/${id}/rule-selections/${original.id}`;
    const before = await call(f, 'GET', path);
    expect(before.statusCode, before.body).toBe(200);
    expect(validRecord(before.json()), JSON.stringify(validRecord.errors)).toBe(true);
    expect(before.json()).toEqual({ selection: original });

    const interval = await times(-60_000, 60_000);
    await adoption(f, interval.start, interval.end);
    await sourceDrain(f);
    await selectionDrain(f);
    const current = (await shown(f, id)).selection!;
    expect(current.id).not.toBe(original.id);
    expect(current.execution.status).toBe('active');
    expect((await call(f, 'GET', path)).json()).toEqual(before.json());
    expect((await call(f, 'GET', `/v1/flights/${id}/rule-selections/${current.id}`)).json()).toEqual({
      selection: current,
    });

    const legacy: FlightRuleSelectionRecordV1 = {
      ...original,
      id: randomUUID(),
      version: 'flight.rule-selection.1',
      execution: { status: 'inactive', baseline: 'builtin_draft' },
    };
    legacy.selectionDigest = canonicalDigest({
      version: legacy.version,
      flightId: legacy.flightId,
      organizationId: legacy.organizationId,
      adoptionRevision: legacy.adoptionRevision,
      projectedAdoptionRevision: legacy.projectedAdoptionRevision,
      selection: legacy.selection,
      execution: legacy.execution,
      nextBoundary: legacy.nextBoundary,
    });
    await withScope(workerPool, f.worker, async (client, who) => {
      const event = await appendEvent(client, who, {
        id: legacy.id,
        type: 'flight.rule-selection.recorded',
        stream: `rule-selection:${id}`,
        payload: { flightId: id, selection: legacy, declaredSubjects: [id] },
      });
      await client.query(
        `INSERT INTO flight_rule_selections(id,tenant_id,flight_id,selection_digest,record,recorded_at)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [legacy.id, who.tenantId, id, legacy.selectionDigest, legacy, event.received_at],
      );
    });
    const historical = await call(f, 'GET', `/v1/flights/${id}/rule-selections/${legacy.id}`);
    expect(historical.statusCode, historical.body).toBe(200);
    expect(validRecord(historical.json()), JSON.stringify(validRecord.errors)).toBe(true);
    expect(historical.json()).toEqual({ selection: legacy });
    expect((await shown(f, id)).selection!.id).toBe(current.id);
    for (const response of [
      await call(other, 'GET', path),
      await call(f, 'GET', `/v1/flights/${anotherFlight}/rule-selections/${original.id}`),
      await call(f, 'GET', `/v1/flights/${id}/rule-selections/${randomUUID()}`),
    ]) {
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('not_found');
    }
    expect((await call(denied, 'GET', path)).statusCode).toBe(403);
  });

  it('invalidates at start/adjacent/end boundaries before workers run and late work selects current time', async () => {
    const f = await fixture('boundaries');
    const id = await flight(f);
    const interval = await times(3000, 4500);
    await adoption(f, interval.start, interval.end);
    const later = new Date(Date.parse(interval.end) + 1500).toISOString();
    const adjacent = await adoption(f, interval.end, later);
    await sourceDrain(f);
    await selectionDrain(f);
    expect((await shown(f, id)).selection?.selection.state).toBe('scheduled');
    await passBoundary(interval.start);
    expect((await shown(f, id)).convergence.reason).toBe('boundary_due');
    const stale = await call(f, 'POST', '/v1/commands', decision(await timeline(f, id)));
    expect(stale.statusCode).toBe(409);
    await passBoundary(interval.end);
    await selectionDrain(f);
    expect((await shown(f, id)).selection?.selection).toMatchObject({ state: 'eligible', adoption: { id: adjacent } });
    await passBoundary(later);
    await selectionDrain(f);
    expect((await shown(f, id)).selection?.selection.state).toBe('expired');
    // No built-in flight evaluator runs for a selection; the generic evaluator runs the selected rules.
    const evaluations = await admin.query(
      'SELECT count(*)::int AS count FROM flight_evaluations WHERE tenant_id=$1 AND flight_id=$2',
      [f.actor.tenantId, id],
    );
    expect(evaluations.rows[0].count).toBe(0);
  });

  it('rolls back a decision when its boundary crosses after acceptance but before commit', async () => {
    const f = await fixture('commit');
    const id = await flight(f);
    const interval = await times(3000, 60_000);
    await adoption(f, interval.start, interval.end);
    await sourceDrain(f);
    await selectionDrain(f);
    const command = decision(await timeline(f, id));
    await expect(
      withScope(pool, f.actor, async (client, who) => {
        await acceptCommand(client, who, command);
        await client.query('SELECT pg_sleep(GREATEST(EXTRACT(EPOCH FROM $1::timestamptz-clock_timestamp()),0)+0.03)', [
          interval.start,
        ]);
      }),
    ).rejects.toMatchObject({ code: 'concurrent_change', status: 409 });
    const decisions = await admin.query(
      'SELECT count(*)::int AS count FROM decisions WHERE tenant_id=$1 AND flight_id=$2',
      [f.actor.tenantId, id],
    );
    expect(decisions.rows[0].count).toBe(0);
  });

  it('bootstraps in recoverable pages and rolls back all effects when a flight lease expires', async () => {
    const f = await fixture('bootstrap');
    const ids = [await flight(f, true), await flight(f, true)];
    const workId = randomUUID();
    await admin.query(
      "INSERT INTO selection_work(id,tenant_id,organization_id,kind,due_at,available_at) VALUES($1,$2,$3,'execution_bootstrap','2000-01-01T00:00:00Z','2000-01-01T00:00:00Z')",
      [workId, f.actor.tenantId, `organization:${f.actor.tenantId}`],
    );
    const legacy = await workerPool.connect();
    try {
      await legacy.query('BEGIN');
      const oldLeases = await legacy.query('SELECT * FROM ledger_lease_rule_selections($1,100,30)', [prefix]);
      expect(oldLeases.rows.some((row) => row.id === workId)).toBe(false);
    } finally {
      await legacy.query('ROLLBACK');
      legacy.release();
    }
    const page = (await selectionLease(f, workId))!;
    expect(await processRuleSelectionLease(workerPool, page, { fanoutLimit: 1 })).toBe(true);
    expect(await processRuleSelectionLease(workerPool, page)).toBe(false);
    const state = (await admin.query('SELECT state,cursor_flight_id FROM selection_work WHERE id=$1', [workId]))
      .rows[0];
    expect(state.state).toBe('pending');
    const childId = (
      await admin.query("SELECT id FROM selection_work WHERE tenant_id=$1 AND kind='execution'", [f.actor.tenantId])
    ).rows[0].id;
    const child = (await selectionLease(f, childId, 2))!;
    await expect(
      processRuleSelectionLease(workerPool, child, {
        beforeCommit: () => leaseExpired(admin, 'selection_work', child.id),
      }),
    ).rejects.toMatchObject({ code: 'worker_lease_expired' });
    expect(
      (
        await admin.query('SELECT count(*)::int AS count FROM flight_rule_selections WHERE tenant_id=$1', [
          f.actor.tenantId,
        ])
      ).rows[0].count,
    ).toBe(0);
    expect(
      (
        await admin.query('SELECT count(*)::int AS count FROM subject_dependencies WHERE tenant_id=$1', [
          f.actor.tenantId,
        ])
      ).rows[0].count,
    ).toBe(0);
    const reclaimed = (await selectionLease(f, childId))!;
    expect(await processRuleSelectionLease(workerPool, child)).toBe(false);
    expect(await processRuleSelectionLease(workerPool, reclaimed)).toBe(true);
    await selectionDrain(f);
    for (const id of ids) expect((await shown(f, id)).convergence.status).toBe('current');
  });
});
