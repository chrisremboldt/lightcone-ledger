import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import type {
  OrganizationCoverageResponse,
  RuleEvaluationRecord,
  RulePackVersion,
  SubjectFindingRecord,
} from '../../packages/contracts/src/index.js';
import { adoptShownPack } from '../../packages/contracts/fixtures/demo/v1/ready.js';
import {
  defineCheckedRule,
  registerCheckKind,
  registerRulePack,
  subjectStateRevision,
  type CheckKind,
} from '../../packages/domain/src/index.js';
import { canonicalDigest, sha256 } from '../../packages/integrity/src/index.js';
import { createPool, MemoryObjectStore, type AuthContext } from '../../packages/persistence/src/index.js';
import { runOwnedWork, settleOwnedWork } from './worker-queue.js';

// Everything rule-specific lives in this test: the check kind, the rule and its pack. The evaluator, the worker and
// the flight state registration name none of them.
describe.runIf(process.env.LEDGER_ENV !== 'staging')('Rules that read a flight’s own state', () => {
  const prefix = `rule-state-${randomUUID()}`;
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const workerPool = createPool(process.env.WORKER_DATABASE_URL);
  const sourceId = `${prefix}-tracker`;
  const tenantId = `${prefix}:tenant`;
  let app: Awaited<ReturnType<typeof createApp>>;

  // Made up for this test: needs attention whenever the subject state reports a status, and returns it.
  const statusReportedV1: CheckKind<Record<string, never>> = {
    id: 'statetest.status-reported',
    version: 1,
    title: 'Status reported',
    description: 'Needs attention when the subject state reports a status, which it returns as a detail.',
    inputs: [{ name: 'state', description: 'The subject state.' }],
    parameterSchema: { type: 'object', additionalProperties: false },
    details: [{ name: 'status', description: 'The reported status.' }],
    evaluate(_params, inputs) {
      const status = inputs.state?.[0]?.observation.status;
      return typeof status === 'string'
        ? {
            evidenceState: 'supported',
            outcome: 'attention',
            reasonCode: 'status_reported',
            summary: 'A status is reported.',
            evidence: [],
            details: { status },
          }
        : {
            evidenceState: 'insufficient',
            outcome: 'pending',
            reasonCode: 'status_missing',
            summary: 'No status is reported.',
            evidence: [],
          };
    },
  };
  registerCheckKind(statusReportedV1);

  const rule = defineCheckedRule({
    id: 'test.landed-flight-review',
    version: 1,
    title: 'A landed flight is reviewed',
    source: { kind: 'operator_procedure', reference: 'Fictional procedure 7.1', text: 'Review every landed flight.' },
    target: { subjectKind: 'flight' },
    reads: [{ name: 'notes', type: 'statetest.note', versions: [1], about: 'target', required: false, select: 'all' }],
    subjectState: { name: 'state', required: true },
    applicability: [{ input: 'state', field: 'status', oneOf: ['landed'], whenAbsent: 'insufficient' }],
    check: { kind: statusReportedV1 },
    wording: { attention: 'Review this flight: Ledger records it as {status}.' },
  });
  const packContent = {
    packId: `${prefix}.pack`,
    version: 1,
    title: 'Fictional review procedures',
    status: 'draft' as const,
    review: 'ai_drafted' as const,
    adopted: false as const,
    bindings: [],
    leaves: [rule],
  };
  const testPack: RulePackVersion = { ...packContent, digest: canonicalDigest(packContent) };

  const base = { tenantId, revision: 1, name: 'Fictional review owner' };
  const actor: AuthContext = {
    ...base,
    id: `${tenantId}:actor`,
    kind: 'human',
    capabilities: ['flight:read', 'flight:create', 'evidence:read', 'authority:write', 'pack:adopt', 'input:write'],
  };
  const worker: AuthContext = {
    ...base,
    id: `${tenantId}:worker`,
    kind: 'worker',
    capabilities: ['flight:read', 'evidence:read', 'input:write'],
  };

  function call(method: 'GET' | 'POST', url: string, payload?: unknown) {
    return app.inject({
      method,
      url,
      headers: { authorization: `Bearer ledger-dev-${actor.id}`, 'idempotency-key': randomUUID() },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  }

  async function settle(done: () => Promise<boolean> = async () => false): Promise<void> {
    for (let attempt = 0; attempt < 60; attempt++) {
      const completed = await runOwnedWork(admin, workerPool, [prefix]);
      if (await done()) return;
      if (!completed) {
        const pending = await admin.query(
          `SELECT (SELECT COUNT(*) FROM work_items w WHERE w.tenant_id=$1 AND w.state IN ('pending','leased'))
           +(SELECT COUNT(*) FROM rule_evaluation_work r WHERE r.tenant_id=$1 AND r.state IN ('pending','leased')
             AND r.due_at<=clock_timestamp()) AS count`,
          [tenantId],
        );
        if (Number(pending.rows[0].count) === 0) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    throw new Error('Worker did not settle');
  }

  function query(flightId: string): string {
    return new URLSearchParams({ subjectKind: 'flight', subjectId: flightId }).toString();
  }
  async function evaluations(flightId: string): Promise<RuleEvaluationRecord[]> {
    const response = await call('GET', `/v1/evaluations?${query(flightId)}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json().evaluations;
  }
  async function findings(flightId: string): Promise<SubjectFindingRecord[]> {
    const response = await call('GET', `/v1/findings?${query(flightId)}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json().findings;
  }
  async function work(flightId: string): Promise<number> {
    const rows = await admin.query(
      'SELECT COUNT(*) AS count FROM rule_evaluation_work WHERE tenant_id=$1 AND subject_id=$2',
      [tenantId, flightId],
    );
    return Number(rows.rows[0].count);
  }

  beforeAll(async () => {
    registerRulePack({ packId: testPack.packId, versions: [testPack] });
    app = await createApp({ pool, env: 'test', objectStore: new MemoryObjectStore() });
    await app.ready();
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, 'Fictional review tenant']);
    for (const principal of [actor, worker]) {
      await admin.query('INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,$4,$5)', [
        principal.id,
        tenantId,
        principal.name,
        principal.kind,
        principal.capabilities,
      ]);
      await admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [
        sha256(`ledger-dev-${principal.id}`),
        principal.id,
      ]);
    }
    const shown = await call('GET', '/v1/organization/coverage');
    expect(shown.statusCode, shown.body).toBe(200);
    const retained = await call('GET', `/v1/rule-packs/${encodeURIComponent(testPack.packId)}/versions/1`);
    expect(retained.statusCode, retained.body).toBe(200);
    const now = Date.now();
    const adopted = await call(
      'POST',
      '/v1/commands',
      adoptShownPack(
        shown.json() as OrganizationCoverageResponse,
        retained.json().pack,
        { start: new Date(now - 60_000).toISOString(), end: new Date(now + 3_600_000).toISOString() },
        'Adopt the fictional review procedures.',
        'active',
      ),
    );
    expect(adopted.statusCode, adopted.body).toBe(201);
    await settle();
  });
  afterAll(async () => {
    await settleOwnedWork([prefix]);
    if (app) await app.close();
    await pool.end();
    await admin.end();
    await workerPool.end();
  });

  it('queues and changes an evaluation when the flight’s state changes, with a new digest and the rule’s wording', async () => {
    const created = await call('POST', '/v1/flights', { originationKey: `${prefix}-flight`, label: 'Review flight' });
    expect(created.statusCode, created.body).toBe(201);
    const flightId = created.json().flight.id as string;
    await settle(async () => (await evaluations(flightId)).length > 0);
    const [planned] = await evaluations(flightId);
    expect(planned).toMatchObject({
      rule: { id: rule.id, digest: rule.digest },
      subjectState: { name: 'state', kind: 'flight', state: { status: 'planned' } },
      trigger: { kind: 'state', eventId: expect.any(String) },
      outcome: 'not_applicable',
      reasonCode: 'condition_not_met',
    });
    // The record holds the state content the rule read; its revision is the digest of that content.
    expect(planned!.subjectState!.revision).toBe(subjectStateRevision(planned!.subjectState!.state!));
    expect(await findings(flightId)).toEqual([]);

    const landingTime = new Date(Date.now() - 60_000).toISOString();
    const observed = await call('POST', '/v1/inputs', {
      sourceId,
      kind: 'flight.observation',
      occurredAt: landingTime,
      subject: { flightId },
      payload: { activity: 'landed', landingTime },
    });
    expect(observed.statusCode, observed.body).toBe(201);
    await settle(async () => (await evaluations(flightId)).length > 1);
    const [landed, previous] = await evaluations(flightId);
    expect(previous!.id).toBe(planned!.id);
    expect(landed).toMatchObject({
      applicability: 'applicable',
      evidenceState: 'supported',
      outcome: 'attention',
      reasonCode: 'status_reported',
      summary: 'Review this flight: Ledger records it as landed.',
      details: { status: 'landed' },
      trigger: { kind: 'state', eventId: observed.json().receipt.eventId },
      subjectState: { state: { status: 'landed' } },
    });
    expect(landed!.subjectState!.revision).not.toBe(planned!.subjectState!.revision);
    expect(landed!.observationDigest).not.toBe(planned!.observationDigest);
    expect(landed!.inputDigest).not.toBe(planned!.inputDigest);
    const [finding] = await findings(flightId);
    expect(finding).toMatchObject({
      ruleId: rule.id,
      status: 'open',
      initialEvaluation: { id: landed!.id, summary: landed!.summary, details: { status: 'landed' } },
      latestEvaluation: { id: landed!.id, summary: 'Review this flight: Ledger records it as landed.' },
    });

    // An event that leaves the flight's state as it was queues nothing for the rule.
    const queued = await work(flightId);
    const again = await call('POST', '/v1/inputs', {
      sourceId,
      kind: 'flight.observation',
      occurredAt: new Date(Date.now() - 30_000).toISOString(),
      subject: { flightId },
      payload: { activity: 'landed', title: 'Post-flight note' },
    });
    expect(again.statusCode, again.body).toBe(201);
    await settle();
    expect(await work(flightId)).toBe(queued);
    expect(await evaluations(flightId)).toHaveLength(2);
  });
});
