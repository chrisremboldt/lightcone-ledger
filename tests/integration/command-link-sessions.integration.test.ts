import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import {
  processLease,
  runDueRuleEvaluations,
  runDueRuleSelections,
  type WorkLease,
} from '../../apps/workers/src/index.js';
import type {
  CommandLinkSource,
  OrganizationCoverageResponse,
  RuleEvaluationRecord,
  RulePackVersion,
} from '../../packages/contracts/src/index.js';
import { adoptShownPack } from '../../packages/contracts/fixtures/demo/v1/ready.js';
import { translateAndSubmit, type ObservationSink } from '../../packages/adapters/src/adapter-contract.js';
import { commandLinkStatusAdapter } from '../../packages/adapters/src/command-link-status.js';
import { COMMAND_LINK_LOSS_LEAF_ID } from '../../packages/domain/src/rules/command-link-evidence-v1.js';
import { sha256 } from '../../packages/integrity/src/index.js';
import { createPool, MemoryObjectStore, withScope, type AuthContext } from '../../packages/persistence/src/index.js';
import { settleOwnedWork, withOwnedWork } from './worker-queue.js';

// The lost-link review of pack version 6 binds a capture session to the flight and aircraft of its earliest report,
// across flights, for reports that arrive as link.status observations, in whatever order they arrive.

type Role = 'operator' | 'source';

describe.runIf(process.env.LEDGER_ENV !== 'staging')('PostgreSQL capture sessions across flights', () => {
  const prefix = `command-link-sessions-${randomUUID()}`;
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const workerPool = createPool(process.env.WORKER_DATABASE_URL);
  const store = new MemoryObjectStore();
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeAll(async () => {
    app = await createApp({ pool, env: 'test', objectStore: store });
    await app.ready();
  });
  afterAll(async () => {
    await settleOwnedWork([prefix], { objectStore: store });
    if (app) await app.close();
    await pool.end();
    await admin.end();
    await workerPool.end();
  });

  interface Fixture {
    tenantId: string;
    sourceId: string;
    worker: AuthContext;
    tokens: Record<Role, string>;
  }

  function call(f: Fixture, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, role: Role = 'operator') {
    return app.inject({
      method,
      url,
      payload,
      headers: {
        authorization: `Bearer ${f.tokens[role]}`,
        'idempotency-key': randomUUID(),
        ...(method === 'PUT' ? { 'content-type': 'application/octet-stream' } : {}),
      },
    });
  }

  async function fixture(suffix: string): Promise<Fixture> {
    const tenantId = `${prefix}:${suffix}`;
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, 'Fictional session operator']);
    const roles: Record<Role, string[]> = {
      operator: ['input:write', 'flight:create', 'flight:read', 'evidence:read', 'authority:write', 'pack:adopt'],
      source: ['input:write', 'flight:read', 'evidence:read'],
    };
    const tokens = {} as Record<Role, string>;
    for (const [role, capabilities] of Object.entries(roles) as [Role, string[]][]) {
      const id = `${tenantId}:${role}`;
      tokens[role] = `ledger-dev-${id}`;
      await admin.query('INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,$4,$5)', [
        id,
        tenantId,
        `Fictional ${role}`,
        role === 'operator' ? 'human' : 'source',
        capabilities,
      ]);
      await admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [
        sha256(tokens[role]),
        id,
      ]);
    }
    const worker: AuthContext = {
      id: `${tenantId}:worker`,
      tenantId,
      name: 'Fictional session worker',
      kind: 'worker',
      capabilities: ['flight:read', 'evidence:read'],
      revision: 1,
    };
    await admin.query("INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,'worker',$4)", [
      worker.id,
      tenantId,
      worker.name,
      worker.capabilities,
    ]);
    const f: Fixture = { tenantId, sourceId: `${tenantId}:link`, worker, tokens };
    const current = (await call(f, 'GET', '/v1/me', undefined, 'source')).json().principal;
    const granted = await call(f, 'POST', '/v1/commands', {
      kind: 'authority.update',
      principalId: `${tenantId}:source`,
      expectedRevision: current.revision,
      capabilities: current.capabilities,
      observationGrants: [{ sourceId: f.sourceId, observationType: 'link.status' }],
    });
    expect(granted.statusCode, granted.body).toBe(201);
    const shown = await call(f, 'GET', '/v1/organization/coverage');
    const retained = await call(f, 'GET', '/v1/rule-packs/ledger.demo-procedures/versions/6');
    expect(retained.statusCode, retained.body).toBe(200);
    const now = Date.now();
    const adopted = await call(
      f,
      'POST',
      '/v1/commands',
      adoptShownPack(
        shown.json() as OrganizationCoverageResponse,
        retained.json().pack as RulePackVersion,
        { start: new Date(now - 86_400_000).toISOString(), end: new Date(now + 86_400_000).toISOString() },
        'Adopt the fictional flight procedures.',
        'active',
      ),
    );
    expect(adopted.statusCode, adopted.body).toBe(201);
    await drain(f);
    return f;
  }

  async function lease(f: Fixture): Promise<WorkLease | null> {
    return withScope(workerPool, f.worker, async (client) => {
      const candidate = (
        await client.query<WorkLease>(
          `SELECT w.* FROM work_items w WHERE (w.state='pending' OR (w.state='leased' AND w.lease_until<clock_timestamp()))
         AND w.available_at<=clock_timestamp()
         AND NOT EXISTS(SELECT 1 FROM work_items p WHERE p.stream_id=w.stream_id AND p.stream_sequence<w.stream_sequence AND p.state NOT IN ('completed','failed'))
         ORDER BY w.available_at,w.id LIMIT 1 FOR UPDATE`,
        )
      ).rows[0];
      if (!candidate) return null;
      const row = (
        await client.query<WorkLease>(
          "UPDATE work_items SET state='leased',generation=generation+1,lease_owner=$1,lease_until=clock_timestamp()+interval '30 seconds' WHERE id=$2 RETURNING *",
          [prefix, candidate.id],
        )
      ).rows[0];
      return { ...row, worker_id: f.worker.id };
    });
  }

  async function drain(f: Fixture) {
    for (let index = 0; index < 200; index++) {
      const work = await lease(f);
      if (work) {
        expect(await processLease(workerPool, work, { objectStore: store })).toBe(true);
        continue;
      }
      // Only this file's tenants: the shared helper keeps other files' queued work out of the lease.
      const settled = await withOwnedWork(
        admin,
        [prefix],
        async () =>
          (await runDueRuleSelections(workerPool, { limit: 100 })) +
          (await runDueRuleEvaluations(workerPool, { limit: 100 })),
      );
      if (!settled) return;
    }
    throw new Error('Session fixture did not drain');
  }

  async function flight(f: Fixture, label: string) {
    const response = await call(f, 'POST', '/v1/flights', { originationKey: `${f.tenantId}:${label}`, label });
    expect(response.statusCode, response.body).toBe(201);
    await drain(f);
    return response.json().flight.id as string;
  }

  async function artifact(f: Fixture, bytes: Uint8Array) {
    const upload = await call(
      f,
      'POST',
      '/v1/uploads',
      { byteLength: bytes.length, contentType: 'application/json' },
      'source',
    );
    expect(upload.statusCode, upload.body).toBe(201);
    const id = upload.json().upload.id;
    expect((await call(f, 'PUT', `/v1/uploads/${id}/content`, Buffer.from(bytes), 'source')).statusCode).toBe(200);
    const finalized = await call(f, 'POST', `/v1/uploads/${id}/finalize`, undefined, 'source');
    expect(finalized.statusCode, finalized.body).toBe(201);
    return finalized.json().artifact.id as string;
  }

  /** Sends one report through the adapter and the generic intake; returns its observation id. */
  async function report(f: Fixture, flightId: string, raw: CommandLinkSource): Promise<string> {
    const sink: ObservationSink = {
      retainOriginal: async (request) => ({ artifactId: await artifact(f, request.bytes) }),
      submitObservation: async (observation) => {
        const response = await call(
          f,
          'POST',
          '/v1/inputs',
          { sourceId: f.sourceId, kind: 'observation', occurredAt: observation.occurredAt, payload: observation },
          'source',
        );
        expect(response.statusCode, response.body).toBe(201);
        return { receiptId: response.json().receipt.id };
      },
    };
    const outcome = await translateAndSubmit(
      commandLinkStatusAdapter,
      {
        bytes: Buffer.from(`${JSON.stringify(raw)}\n`),
        contentType: 'application/json',
        transport: {},
        capturedAt: raw.occurredAt,
      },
      {
        subjects: { scope: 'ledger', ids: { flight: { [raw.sourceSessionId]: flightId } } },
        binding: { sourceSessionId: raw.sourceSessionId, aircraftId: raw.aircraftId },
      },
      sink,
    );
    expect(outcome.rejections).toEqual([]);
    const receipt = await call(f, 'GET', `/v1/receipts/${outcome.submitted[0]!.receiptId}`);
    return receipt.json().receipt.eventId as string;
  }

  async function latest(f: Fixture, flightId: string): Promise<RuleEvaluationRecord> {
    const row = (
      await admin.query<{ record: RuleEvaluationRecord }>(
        `SELECT record FROM rule_evaluations WHERE tenant_id=$1 AND subject_id=$2 AND leaf_id=$3
         ORDER BY recorded_at DESC,id DESC LIMIT 1`,
        [f.tenantId, flightId, COMMAND_LINK_LOSS_LEAF_ID],
      )
    ).rows[0];
    expect(row).toBeDefined();
    return row!.record;
  }

  const raw = (f: Fixture, id: string, fields: Partial<CommandLinkSource> = {}): CommandLinkSource => ({
    sourceSessionId: `${f.tenantId}:shared-session`,
    sourceEventId: id,
    incidentId: `${f.tenantId}:incident-${id}`,
    aircraftId: 'fictional-aircraft-1',
    occurredAt: '2026-10-01T17:00:00.000Z',
    status: 'lost',
    ...fields,
  });

  const summary = (record: RuleEvaluationRecord) => ({
    pack: record.pack.version,
    check: [record.check.kind, record.check.version],
    episodeCount: record.details?.episodeCount,
    leftOutCount: record.details?.leftOutCount,
    issues: record.issues?.length,
  });

  for (const order of [
    ['first', 'reused', 'own'],
    ['reused', 'own', 'first'],
    ['own', 'reused', 'first'],
  ])
    it(`leaves out a session first used on another flight when reports arrive ${order.join(', ')}`, async () => {
      const f = await fixture(order.join('-'));
      const one = await flight(f, 'first flight');
      const two = await flight(f, 'second flight');
      const sends: Record<string, () => Promise<string>> = {
        first: () => report(f, one, raw(f, 'first')),
        reused: () => report(f, two, raw(f, 'reused', { occurredAt: '2026-10-01T17:05:00.000Z' })),
        own: () =>
          report(
            f,
            two,
            raw(f, 'own', { sourceSessionId: `${f.tenantId}:own-session`, occurredAt: '2026-10-01T17:06:00.000Z' }),
          ),
      };
      const ids: Record<string, string> = {};
      for (const name of order) {
        ids[name] = await sends[name]!();
        await drain(f);
      }
      const first = await latest(f, one);
      const second = await latest(f, two);
      expect(summary(first)).toEqual({
        pack: 6,
        check: ['episode.open', 2],
        episodeCount: 1,
        leftOutCount: 0,
        issues: 1,
      });
      expect(summary(second)).toEqual({
        pack: 6,
        check: ['episode.open', 2],
        episodeCount: 1,
        leftOutCount: 1,
        issues: 1,
      });
      expect(second.details?.leftOutObservations).toBe(ids.reused);
      expect(second.issues![0]).toContain(ids.own);
      expect(second.inputs.find((input) => input.name === 'sessionTransitions')?.observationIds.sort()).toEqual(
        [ids.first, ids.reused, ids.own].sort(),
      );

      // Withdrawing the earlier report on the first flight gives the session to the second flight.
      const withdrawn = await call(
        f,
        'POST',
        '/v1/commands',
        { kind: 'observation.withdraw', observationId: ids.first, reason: 'Sent for the wrong capture.' },
        'source',
      );
      expect(withdrawn.statusCode, withdrawn.body).toBe(201);
      await drain(f);
      expect(summary(await latest(f, two))).toMatchObject({ episodeCount: 2, leftOutCount: 0, issues: 2 });
    });
});
