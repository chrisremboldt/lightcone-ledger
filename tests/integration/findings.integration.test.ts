import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import {
  leaseRuleEvaluations,
  processRuleEvaluationLease,
  runDueRuleEvaluations,
} from '../../apps/workers/src/index.js';
import { createPool, MemoryObjectStore, withScope, type AuthContext } from '../../packages/persistence/src/index.js';
import { sha256 } from '../../packages/integrity/src/index.js';
import { verifyBundle } from '../../tools/verifier/index.mjs';
import { FindingsResponseSchema } from '../../packages/contracts/src/openapi.js';
import { adoptShownPack } from '../../packages/contracts/fixtures/demo/v1/ready.js';
import type {
  Command,
  FindingRecord,
  Input,
  OrganizationCoverageResponse,
  TimelineResponse,
} from '../../packages/contracts/src/index.js';
import { leaseExpired, projectOwnedWork, settleOwnedWork, withOwnedWork } from './worker-queue.js';

describe.runIf(process.env.LEDGER_ENV !== 'staging')('PostgreSQL recorded flight findings', () => {
  const prefix = `findings-${randomUUID()}`;
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const workerPool = createPool(process.env.WORKER_DATABASE_URL);
  const caps = [
    'input:write',
    'flight:create',
    'flight:read',
    'decision:write',
    'correction:write',
    'evidence:read',
    'pack:adopt',
  ];
  const actor: AuthContext = {
    id: `${prefix}:actor`,
    tenantId: `${prefix}:tenant`,
    name: 'Fictional finding owner',
    revision: 1,
    capabilities: caps,
  };
  const worker: AuthContext = { ...actor, id: `${prefix}:worker`, name: 'Fictional evaluation worker' };
  const token = `ledger-dev-${prefix}`;
  let app: Awaited<ReturnType<typeof createApp>>;
  beforeAll(async () => {
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [actor.tenantId, 'Finding isolation fixture']);
    for (const principal of [actor, worker])
      await admin.query('INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,$4,$5)', [
        principal.id,
        principal.tenantId,
        principal.name,
        principal === actor ? 'human' : 'worker',
        caps,
      ]);
    await admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [sha256(token), actor.id]);
    app = await createApp({ pool, env: 'test', objectStore: new MemoryObjectStore() });
    await app.ready();
    // The landing checks run only for an organization that adopted the procedures holding them.
    const shown = await call('GET', '/v1/organization/coverage');
    const retained = await call('GET', '/v1/rule-packs/ledger.demo-procedures/versions/4');
    const adopted = await call(
      'POST',
      '/v1/commands',
      adoptShownPack(
        shown.json() as OrganizationCoverageResponse,
        retained.json().pack,
        { start: new Date(Date.now() - 60_000).toISOString(), end: new Date(Date.now() + 86_400_000).toISOString() },
        'Adopt the fictional flight procedures.',
        'active',
      ),
    );
    expect(adopted.statusCode, adopted.body).toBe(201);
    await drain();
  });
  afterAll(async () => {
    await settleOwnedWork([prefix]);
    if (app) await app.close();
    await pool.end();
    await admin.end();
    await workerPool.end();
  });
  async function call(method: 'GET' | 'POST', url: string, payload?: unknown, key = randomUUID(), credential = token) {
    return app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${credential}`, 'idempotency-key': key },
      payload,
    });
  }
  // Projects the fixture's events, then runs the generic evaluator's due work, until neither has any left.
  async function drain() {
    for (let round = 0; round < 20; round++) {
      await project();
      if (!(await withOwnedWork(admin, [prefix], () => runDueRuleEvaluations(workerPool, { limit: 100 })))) return;
    }
    throw new Error('Fixture evaluation did not drain');
  }
  async function project() {
    await projectOwnedWork(admin, workerPool, [prefix]);
  }
  async function flight(name: string, scheduledEnd = new Date(Date.now() + 60_000).toISOString()) {
    const created = await call('POST', '/v1/flights', {
      originationKey: `${prefix}:${name}`,
      label: name,
      scheduledEnd,
    });
    expect(created.statusCode, created.body).toBe(201);
    await drain();
    return created.json().flight.id as string;
  }
  async function thread(id: string): Promise<TimelineResponse> {
    const response = await call('GET', `/v1/flights/${id}/timeline`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }
  async function observe(flightId: string, sourceId: string, landingTime: string) {
    const payload: Input = {
      sourceId,
      kind: 'flight.observation',
      occurredAt: landingTime,
      subject: { flightId },
      payload: { activity: 'landed', landingTime },
    };
    const response = await call('POST', '/v1/inputs', payload);
    expect(response.statusCode, response.body).toBe(201);
    await drain();
    return response.json().receipt.eventId as string;
  }
  function treatment(
    shown: TimelineResponse,
    finding: FindingRecord,
    action: 'acknowledge' | 'respond' | 'resolve',
  ): Command {
    return {
      kind: 'decision.record',
      flightId: shown.flight.id,
      expectedRevision: shown.flight.revision,
      expectedBasisRevision: shown.flight.basisRevision,
      inputCut: shown.meta.inputCut,
      expectedDependencyBasis: shown.meta.dependencyBasis!,
      findingTreatment: { findingId: finding.id, evaluationId: finding.latestEvaluation.id, action },
      decision: { kind: `finding.${action}`, note: `${action}: reviewed the retained finding evidence.` },
    };
  }
  it('retains one finding, attributed treatment and accepted evaluator basis without changing v1 evidence', async () => {
    const id = await flight('Landing disagreement');
    const first = await observe(id, `${prefix}:live`, '2026-10-15T14:20:00Z');
    const second = await observe(id, `${prefix}:buffered`, '2026-10-15T14:22:00Z');
    let shown = await thread(id);
    const finding = shown.findings![0];
    expect(finding.latestEvaluation.evidenceState).toBe('conflicting');
    expect(finding.latestEvaluation.explanation.evidence.map((item) => item.eventId)).toEqual(
      expect.arrayContaining([first, second]),
    );
    expect(shown.flight.findingSummary?.openCount).toBe(1);
    const read = await call('GET', `/v1/flights/${id}/findings`);
    const ajv = new Ajv({ strict: false });
    addFormats(ajv);
    const validate = ajv.compile(FindingsResponseSchema);
    expect(validate(read.json()), JSON.stringify(validate.errors)).toBe(true);
    const ownCommand = treatment(shown, finding, 'acknowledge');
    const key = randomUUID();
    const owned = await call('POST', '/v1/commands', ownCommand, key);
    expect(owned.statusCode, owned.body).toBe(201);
    expect((await call('POST', '/v1/commands', ownCommand, key)).json().command.id).toBe(owned.json().command.id);
    await drain();
    shown = await thread(id);
    expect(shown.findings![0].owner?.id).toBe(actor.id);
    expect(shown.findings![0].treatments).toHaveLength(1);
    expect((await call('POST', '/v1/commands', treatment(shown, shown.findings![0], 'resolve'))).statusCode).toBe(409);
    const general: Command = {
      kind: 'decision.record',
      flightId: id,
      expectedRevision: shown.flight.revision,
      expectedBasisRevision: shown.flight.basisRevision,
      inputCut: shown.meta.inputCut,
      expectedDependencyBasis: shown.meta.dependencyBasis!,
      decision: { kind: 'reviewed', note: 'Reviewed the map only.' },
    };
    expect((await call('POST', '/v1/commands', general)).statusCode).toBe(201);
    await drain();
    expect((await thread(id)).findings![0].status).toBe('acknowledged');
    expect(
      (await call('GET', `/v1/flights?view=monitor&search=${id}`))
        .json()
        .flights.map((flight: { id: string }) => flight.id),
    ).not.toContain(id);
    expect(
      (await call('GET', `/v1/flights?view=historical-issues&search=${id}`))
        .json()
        .flights.map((flight: { id: string }) => flight.id),
    ).toContain(id);
    const issued = await call('POST', '/v1/exports', {
      flightId: id,
      decisionId: owned.json().command.id,
      scope: 'whole_tenant_prefixes',
    });
    expect(issued.statusCode, issued.body).toBe(201);
    const exportId = issued.json().record.id;
    const content = await call('GET', `/v1/exports/${exportId}/content`);
    expect(content.statusCode, content.body).toBe(200);
    expect(verifyBundle(content.json(), { expectedManifestDigest: issued.json().record.manifestDigest }).status).toBe(
      'verified',
    );
    const decisionEvent = content
      .json()
      .entries.map((entry: { canonicalEnvelope: string }) => JSON.parse(entry.canonicalEnvelope))
      .find((entry: { eventId: string }) => entry.eventId === owned.json().command.id);
    expect(decisionEvent.payload.acceptedFindingBasis.id).toBe(finding.latestEvaluation.id);
    const beforeCorrection = await thread(id);
    for (const correctionOf of [beforeCorrection.findings![0].latestEvaluation.id, owned.json().command.id]) {
      const rejected = await call('POST', '/v1/commands', {
        kind: 'evidence.correct',
        flightId: id,
        expectedRevision: beforeCorrection.flight.revision,
        expectedBasisRevision: beforeCorrection.flight.basisRevision,
        inputCut: beforeCorrection.meta.inputCut,
        expectedDependencyBasis: beforeCorrection.meta.dependencyBasis!,
        correctionOf,
        occurredAt: '2026-10-15T14:22:00Z',
        note: 'Attempt to overwrite a computed check or recorded decision.',
        payload: { outcome: 'pass', evaluationId: 'replacement-evaluation', note: 'Changed' },
      });
      expect(rejected.statusCode, rejected.body).toBe(409);
      expect(rejected.json().error.code).toBe('correction_target_unsupported');
    }
    expect((await thread(id)).findings).toEqual(beforeCorrection.findings);
    const correction: Command = {
      kind: 'evidence.correct',
      flightId: id,
      expectedRevision: beforeCorrection.flight.revision,
      expectedBasisRevision: beforeCorrection.flight.basisRevision,
      inputCut: beforeCorrection.meta.inputCut,
      expectedDependencyBasis: beforeCorrection.meta.dependencyBasis!,
      correctionOf: second,
      occurredAt: '2026-10-15T14:22:00Z',
      note: 'Aircraft log confirms the first landing time.',
      payload: { activity: 'landed', landingTime: '2026-10-15T14:20:00Z' },
    };
    expect((await call('POST', '/v1/commands', correction)).statusCode).toBe(201);
    await drain();
    shown = await thread(id);
    expect(shown.findings![0].id).toBe(finding.id);
    expect(shown.findings![0].initialEvaluation).toEqual(finding.initialEvaluation);
    expect(shown.findings![0].latestEvaluation.outcome).toBe('pass');
    expect(
      (await call('GET', `/v1/flights?view=historical-issues&search=${id}`))
        .json()
        .flights.map((flight: { id: string }) => flight.id),
    ).toContain(id);
    expect((await call('POST', '/v1/commands', treatment(shown, shown.findings![0], 'resolve'))).statusCode).toBe(201);
    await drain();
    expect((await thread(id)).flight.findingSummary?.openCount).toBe(0);
    expect(
      (await call('GET', `/v1/flights?view=historical-issues&search=${id}`))
        .json()
        .flights.map((flight: { id: string }) => flight.id),
    ).not.toContain(id);
    expect(
      (await call('GET', `/v1/flights?view=history&search=${id}`))
        .json()
        .flights.map((flight: { id: string }) => flight.id),
    ).toContain(id);
    expect((await call('GET', `/v1/exports/${exportId}/content`)).body).toBe(content.body);
    expect(
      (await call('GET', `/v1/flights/${id}/findings`, undefined, randomUUID(), 'ledger-dev-beta-operator')).statusCode,
    ).toBe(404);
    const foreign = await withScope(pool, { id: 'principal-beta-operator', tenantId: 'tenant-beta' }, (client) =>
      client.query('SELECT id FROM findings WHERE id=$1', [finding.id]),
    );
    expect(foreign.rowCount).toBe(0);
    await expect(
      admin.query('UPDATE rule_evaluations SET record=record WHERE id=$1', [finding.initialEvaluation.id]),
    ).rejects.toThrow('append-only');
    await expect(admin.query('DELETE FROM finding_treatments WHERE id=$1', [owned.json().command.id])).rejects.toThrow(
      'append-only',
    );
    await observe(id, `${prefix}:later-log`, '2026-10-15T14:23:00Z');
    const reopened = (await thread(id)).findings![0];
    expect(reopened.id).toBe(finding.id);
    expect(reopened.status).toBe('acknowledged');
    expect(reopened.owner?.id).toBe(actor.id);
    expect(reopened.treatments.at(-1)?.action).toBe('resolve');
    expect((await call('GET', `/v1/exports/${exportId}/content`)).body).toBe(content.body);
  });
  it('evaluates silence durably, rolls back an expired lease and rejects the displayed basis after the timeout', async () => {
    const id = await flight('Missing landing evidence', new Date(Date.now() - 5 * 60_000 + 1500).toISOString());
    const before = await thread(id);
    expect(before.findings).toHaveLength(0);
    // The deadline falls due by the database's clock, which need not match this machine's.
    const due = `SELECT 1 FROM rule_evaluation_work WHERE subject_id=$1 AND trigger_kind='deadline' AND due_at<=clock_timestamp()`;
    while (!(await admin.query(due, [id])).rowCount) await new Promise((resolve) => setTimeout(resolve, 20));
    const deadline = (
      await withOwnedWork(admin, [prefix], () =>
        leaseRuleEvaluations(workerPool, { owner: prefix, limit: 100, leaseSeconds: 2 }),
      )
    ).find((item) => item.subject_id === id && item.trigger_kind === 'deadline')!;
    expect(deadline).toBeDefined();
    await expect(
      processRuleEvaluationLease(workerPool, deadline, {
        beforeCommit: () => leaseExpired(admin, 'rule_evaluation_work', deadline.id),
      }),
    ).rejects.toThrow('lost its lease');
    expect((await thread(id)).findings).toHaveLength(0);
    const reclaimed = (
      await withOwnedWork(admin, [prefix], () =>
        leaseRuleEvaluations(workerPool, { owner: prefix, limit: 100, leaseSeconds: 30 }),
      )
    ).find((item) => item.id === deadline.id)!;
    expect(Number(reclaimed.generation)).toBeGreaterThan(Number(deadline.generation));
    expect(await processRuleEvaluationLease(workerPool, deadline)).toBe(false);
    expect(await processRuleEvaluationLease(workerPool, reclaimed)).toBe(true);
    await drain();
    const shown = await thread(id);
    const finding = shown.findings![0];
    expect(finding.latestEvaluation.evidenceState).toBe('insufficient');
    expect(finding.latestEvaluation.outcome).toBe('attention');
    expect(finding.latestEvaluation.clock.mode).toBe('wall');
    expect(shown.meta.dependencyBasis).not.toBe(before.meta.dependencyBasis);
    const stale: Command = {
      kind: 'decision.record',
      flightId: id,
      expectedRevision: before.flight.revision,
      expectedBasisRevision: before.flight.basisRevision,
      inputCut: before.meta.inputCut,
      expectedDependencyBasis: before.meta.dependencyBasis!,
      decision: { kind: 'reviewed', note: 'Old displayed basis before the durable deadline.' },
    };
    expect((await call('POST', '/v1/commands', stale)).statusCode).toBe(409);
    const owned = await call('POST', '/v1/commands', treatment(shown, finding, 'acknowledge'));
    expect(owned.statusCode, owned.body).toBe(201);
    await drain();
    await observe(id, `${prefix}:late-log`, new Date().toISOString());
    const after = await thread(id);
    expect(after.findings![0].latestEvaluation.outcome).toBe('pass');
    expect((await call('POST', '/v1/commands', treatment(after, after.findings![0], 'resolve'))).statusCode).toBe(201);
    await drain();
    const count = await admin.query("SELECT COUNT(*) FROM findings WHERE subject_kind='flight' AND subject_id=$1", [
      id,
    ]);
    expect(Number(count.rows[0].count)).toBe(1);
    const completed = (await admin.query('SELECT state FROM rule_evaluation_work WHERE id=$1', [deadline.id])).rows[0];
    expect(completed.state).toBe('completed');
    await expect(pool.query('SELECT * FROM ledger_lease_rule_evaluations($1,$2,$3)', [prefix, 1, 30])).rejects.toThrow(
      'permission denied',
    );
  });
  it('reevaluates an existing flight when an order cancellation omits its earlier fulfillments', async () => {
    const sourceId = `${prefix}:order`;
    const externalId = `${prefix}:cancelled-order`;
    const originationKey = `${prefix}:order-flight`;
    const occurredAt = new Date().toISOString();
    const order: Input = {
      sourceId,
      kind: 'order.revision',
      sourceRevision: 1,
      occurredAt,
      subject: { orderId: externalId },
      payload: {
        externalId,
        revision: 1,
        status: 'accepted',
        fulfillments: [{ originationKey, scheduledEnd: new Date(Date.now() - 10 * 60_000).toISOString() }],
      },
    };
    expect((await call('POST', '/v1/inputs', order)).statusCode).toBe(201);
    await drain();
    const id = (
      await admin.query<{ id: string }>('SELECT id FROM flight_views WHERE tenant_id=$1 AND origination_key=$2', [
        actor.tenantId,
        originationKey,
      ])
    ).rows[0].id;
    const original = (await thread(id)).findings![0];
    expect(original.latestEvaluation.outcome).toBe('attention');
    const cancellation: Input = {
      ...order,
      sourceRevision: 2,
      payload: { externalId, revision: 2, status: 'cancelled' },
    };
    expect((await call('POST', '/v1/inputs', cancellation)).statusCode).toBe(201);
    await drain();
    const after = await thread(id);
    expect(after.flight.activity).toBe('cancelled');
    expect(after.findings![0].id).toBe(original.id);
    expect(after.findings![0].latestEvaluation.outcome).toBe('not_applicable');
  });
});
