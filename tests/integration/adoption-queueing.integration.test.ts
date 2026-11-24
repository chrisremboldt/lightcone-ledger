import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import {
  leaseRuleEvaluations,
  leaseWork,
  processLease,
  processRuleEvaluationLease,
} from '../../apps/workers/src/index.js';
import type { RuleEvaluationRecord, RulePackVersion } from '../../packages/contracts/src/index.js';
import { adoptShownPack } from '../../packages/contracts/fixtures/demo/v1/ready.js';
import {
  continueAdoptionRuleEvaluations,
  defineCheckedRule,
  findCheckKind,
  registerObservationTypes,
  registerRulePack,
} from '../../packages/domain/src/index.js';
import { canonicalDigest, sha256 } from '../../packages/integrity/src/index.js';
import { createPool, MemoryObjectStore, withScope, type AuthContext } from '../../packages/persistence/src/index.js';
import { rotorIcingObservation, rotorIcingType } from '../unit/rotor-icing-observation.js';
import { drainOwnedWork, projectOwnedWork, settleOwnedWork, withOwnedWork } from './worker-queue.js';

interface Operator {
  tenantId: string;
  actor: AuthContext;
  worker: AuthContext;
  source: AuthContext;
  sourceId: string;
  artifactId: string;
}

// The rules, their observation type and their pack exist only in this test.
describe.runIf(process.env.LEDGER_ENV !== 'staging')('Queueing what is already recorded when a pack is adopted', () => {
  const prefix = `adoption-queueing-${randomUUID()}`;
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const workerPool = createPool(process.env.WORKER_DATABASE_URL);
  const type = 'rotor.adoption-reading';
  let app: Awaited<ReturnType<typeof createApp>>;

  function floorRule(id: string, limit: number) {
    return defineCheckedRule({
      id,
      version: 1,
      title: `Outside air stays above ${limit} Celsius`,
      source: {
        kind: 'operator_procedure',
        reference: `Fictional procedure ${id}`,
        text: 'Stop while the outside air is at or below the floor.',
      },
      target: { subjectKind: 'aircraft' },
      reads: [{ name: 'subject', type, versions: [1], about: 'target', required: true, select: 'latest' }],
      check: {
        kind: findCheckKind('value.within-limit', 1)!,
        params: { field: 'values.outsideAirTemperatureCelsius', comparison: 'above', limit },
      },
    });
  }
  const content = {
    packId: `${prefix}.pack`,
    version: 1,
    title: 'Fictional floor procedures',
    status: 'draft' as const,
    review: 'ai_drafted' as const,
    adopted: false as const,
    bindings: [],
    leaves: [floorRule('test.adoption-queue-floor', 0), floorRule('test.adoption-queue-deep', -10)],
  };
  const pack: RulePackVersion = { ...content, digest: canonicalDigest(content) };
  const now = Date.now();
  const interval = { start: new Date(now - 3_600_000).toISOString(), end: new Date(now + 3_600_000).toISOString() };
  const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

  function call(principal: AuthContext, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
    return app.inject({
      method,
      url,
      headers: { authorization: `Bearer ledger-dev-${principal.id}`, 'idempotency-key': randomUUID() },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  }

  async function operator(name: string): Promise<Operator> {
    const tenantId = `${prefix}:${name}`;
    const base = { tenantId, revision: 1, kind: 'human', name: 'Fictional adopter' };
    const actor: AuthContext = {
      ...base,
      id: `${tenantId}:actor`,
      capabilities: ['flight:read', 'evidence:read', 'authority:write', 'pack:adopt', 'input:write'],
    };
    const worker: AuthContext = {
      ...base,
      id: `${tenantId}:worker`,
      kind: 'worker',
      capabilities: ['flight:read', 'evidence:read'],
    };
    const source: AuthContext = {
      ...base,
      id: `${tenantId}:source`,
      kind: 'source',
      capabilities: ['input:write', 'flight:read', 'evidence:read'],
    };
    const sourceId = `${prefix}-${name}-sensor`;
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, `Fictional ${name} operator`]);
    for (const principal of [actor, worker, source]) {
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
    const current = await call(actor, 'GET', `/v1/authority/principals/${encodeURIComponent(source.id)}`);
    expect(current.statusCode, current.body).toBe(200);
    const granted = await call(actor, 'POST', '/v1/commands', {
      kind: 'authority.update',
      principalId: source.id,
      expectedRevision: current.json().principal.revision,
      capabilities: current.json().principal.capabilities,
      observationGrants: [{ sourceId, observationType: type }],
    });
    expect(granted.statusCode, granted.body).toBe(201);
    const bytes = Buffer.from(JSON.stringify({ entered: 'fictional reading log' }));
    const created = await call(source, 'POST', '/v1/uploads', {
      contentType: 'application/json',
      byteLength: bytes.byteLength,
    });
    expect(created.statusCode, created.body).toBe(201);
    const uploadId = created.json().upload.id as string;
    const stored = await app.inject({
      method: 'PUT',
      url: `/v1/uploads/${uploadId}/content`,
      headers: {
        authorization: `Bearer ledger-dev-${source.id}`,
        'idempotency-key': randomUUID(),
        'content-type': 'application/octet-stream',
      },
      payload: bytes,
    });
    expect(stored.statusCode, stored.body).toBe(200);
    const finalized = await call(source, 'POST', `/v1/uploads/${uploadId}/finalize`);
    expect(finalized.statusCode, finalized.body).toBe(201);
    return { tenantId, actor, worker, source, sourceId, artifactId: finalized.json().artifact.id as string };
  }

  async function report(
    f: Operator,
    tail: string,
    sourceEventId: string,
    occurredAt: string,
    celsius: number,
  ): Promise<string> {
    const observation = rotorIcingObservation(
      {
        subject: { kind: 'aircraft', id: tail, scope: 'source' },
        sourceEventId,
        occurredAt,
        // A report at an instant: its time is when it occurred.
        interval: undefined,
        values: { severity: 'light', outsideAirTemperatureCelsius: celsius },
      },
      type,
    );
    const response = await call(f.source, 'POST', '/v1/inputs', {
      sourceId: f.sourceId,
      kind: 'observation',
      occurredAt,
      payload: { ...observation, originalArtifactId: f.artifactId },
    });
    expect(response.statusCode, response.body).toBe(201);
    return (
      await admin.query<{ event_id: string }>(
        `SELECT event_id FROM observations WHERE tenant_id=$1 AND source_event_id=$2`,
        [f.tenantId, sourceEventId],
      )
    ).rows[0]!.event_id;
  }

  async function adopt(f: Operator): Promise<string> {
    const shown = await call(f.actor, 'GET', '/v1/organization/coverage');
    expect(shown.statusCode, shown.body).toBe(200);
    const command = adoptShownPack(shown.json(), pack, interval, 'Fictional procedure adoption.', 'active');
    const adopted = await call(f.actor, 'POST', '/v1/commands', command);
    expect(adopted.statusCode, adopted.body).toBe(201);
    return adopted.json().command.id as string;
  }

  /** Leases and runs the operator's due rule work in passes, each pass in lease order or its reverse. */
  async function runRuleWork(f: Operator, order: 'leased' | 'reversed') {
    for (let pass = 0; pass < 20; pass++) {
      const leases = await withOwnedWork(admin, [f.tenantId], () => leaseRuleEvaluations(workerPool, { limit: 100 }));
      if (!leases.length) return;
      for (const lease of order === 'leased' ? leases : [...leases].reverse())
        expect(await processRuleEvaluationLease(workerPool, lease)).toBe(true);
    }
    throw new Error('Rule work did not drain');
  }

  /** Runs the adoption's pages, the only rule work due, which queue its evaluations without running them. */
  async function runPages(f: Operator) {
    const leases = await withOwnedWork(admin, [f.tenantId], () => leaseRuleEvaluations(workerPool, { limit: 100 }));
    expect(leases.map((lease) => lease.trigger_kind)).toEqual(['adoption-page', 'adoption-page']);
    for (const lease of leases) expect(await processRuleEvaluationLease(workerPool, lease)).toBe(true);
  }

  /** What the operator's evaluations and findings say, by subject and rule, with observations named by source event. */
  async function outcomes(f: Operator) {
    const sourceEvents = new Map(
      (
        await admin.query<{ id: string; source_event_id: string }>(
          'SELECT id,source_event_id FROM observations WHERE tenant_id=$1',
          [f.tenantId],
        )
      ).rows.map((row) => [row.id, row.source_event_id]),
    );
    const evaluations = (
      await admin.query<{ record: RuleEvaluationRecord }>('SELECT record FROM rule_evaluations WHERE tenant_id=$1', [
        f.tenantId,
      ])
    ).rows.map(({ record }) => ({
      subject: record.subject.id,
      rule: record.rule.id,
      outcome: record.outcome,
      reasonCode: record.reasonCode,
      read: record.inputs.flatMap((input) => input.observationIds.map((id) => sourceEvents.get(id))).sort(),
      evidence: record.evidence.map((item) => sourceEvents.get(item.observationId)).sort(),
    }));
    const findings = (
      await admin.query<{ subject_id: string; leaf_id: string; status: string }>(
        `SELECT f.subject_id,f.leaf_id,v.status FROM findings f JOIN finding_views v ON v.tenant_id=f.tenant_id AND v.id=f.id
         WHERE f.tenant_id=$1`,
        [f.tenantId],
      )
    ).rows.map((row) => `${row.subject_id} ${row.leaf_id} ${row.status}`);
    const key = (item: { subject: string; rule: string }) => `${item.subject} ${item.rule}`;
    return {
      evaluations: evaluations.sort((left, right) => key(left).localeCompare(key(right))),
      findings: findings.sort(),
    };
  }

  beforeAll(async () => {
    registerObservationTypes(rotorIcingType(type));
    registerRulePack({ packId: pack.packId, versions: [pack] });
    app = await createApp({ pool, env: 'test', objectStore: new MemoryObjectStore() });
    await app.ready();
  });
  afterAll(async () => {
    await settleOwnedWork([prefix]);
    if (app) await app.close();
    await pool.end();
    await admin.end();
    await workerPool.end();
  });

  it('evaluates reports recorded before the adoption without new data, the same whatever order the work runs in', async () => {
    const operators = [await operator('leased'), await operator('reversed')];
    for (const f of operators) {
      await report(f, 'tail-1', 'reading-1a', minutesAgo(50), -3);
      await report(f, 'tail-1', 'reading-1b', minutesAgo(40), 2);
      await report(f, 'tail-2', 'reading-2a', minutesAgo(30), -5);
      await report(f, 'tail-3', 'reading-3a', minutesAgo(20), 4);
      // Before the adoption's effective interval: on record, but not evaluated when the pack is adopted.
      await report(f, 'tail-4', 'reading-4a', minutesAgo(120), -20);
      await drainOwnedWork(admin, workerPool, [f.tenantId]);
      expect((await outcomes(f)).evaluations).toEqual([]);

      const adoptionId = await adopt(f);
      await projectOwnedWork(admin, workerPool, [f.tenantId]);
      const pages = await admin.query(
        `SELECT leaf_id,continuation FROM rule_evaluation_work WHERE tenant_id=$1 AND trigger_kind='adoption-page'
         AND trigger_event_id=$2 ORDER BY leaf_id`,
        [f.tenantId, adoptionId],
      );
      expect(pages.rows).toEqual([
        { leaf_id: 'test.adoption-queue-deep', continuation: { step: 0, after: '' } },
        { leaf_id: 'test.adoption-queue-floor', continuation: { step: 0, after: '' } },
      ]);
      // The pages queue the evaluations; a new report then queues its own for a subject already queued.
      await runPages(f);
      await report(f, 'tail-2', 'reading-2b', minutesAgo(1), -12);
      await projectOwnedWork(admin, workerPool, [f.tenantId]);
      const queued = await admin.query(
        `SELECT trigger_kind,subject_id,count(*)::int AS count FROM rule_evaluation_work
         WHERE tenant_id=$1 AND state='pending' GROUP BY 1,2 ORDER BY 1,2`,
        [f.tenantId],
      );
      expect(queued.rows).toEqual([
        { trigger_kind: 'adoption', subject_id: 'tail-1', count: 2 },
        { trigger_kind: 'adoption', subject_id: 'tail-2', count: 2 },
        { trigger_kind: 'adoption', subject_id: 'tail-3', count: 2 },
        { trigger_kind: 'observation', subject_id: 'tail-2', count: 2 },
      ]);
    }
    const [leased, reversed] = operators as [Operator, Operator];
    await runRuleWork(leased, 'leased');
    await runRuleWork(reversed, 'reversed');

    const results = await outcomes(leased);
    expect(await outcomes(reversed)).toEqual(results);
    expect(results.evaluations.map(({ subject, rule, outcome }) => `${subject} ${rule} ${outcome}`)).toEqual([
      'tail-1 test.adoption-queue-deep pass',
      'tail-1 test.adoption-queue-floor pass',
      'tail-2 test.adoption-queue-deep attention',
      'tail-2 test.adoption-queue-floor attention',
      'tail-3 test.adoption-queue-deep pass',
      'tail-3 test.adoption-queue-floor pass',
    ]);
    expect(results.evaluations.find((item) => item.subject === 'tail-2')!.read).toEqual(['reading-2b']);
    expect(results.findings).toEqual(['tail-2 test.adoption-queue-deep open', 'tail-2 test.adoption-queue-floor open']);
  });

  it('queues a large organization a page at a time through a continuation', async () => {
    const f = await operator('paged');
    const tails = ['tail-a', 'tail-b', 'tail-c', 'tail-d', 'tail-e'];
    for (const [index, tail] of tails.entries()) await report(f, tail, `reading-${tail}`, minutesAgo(10 + index), 5);
    await drainOwnedWork(admin, workerPool, [f.tenantId]);
    const adoptionId = await adopt(f);
    await projectOwnedWork(admin, workerPool, [f.tenantId]);
    const leafId = 'test.adoption-queue-floor';
    const work = { packId: pack.packId, leafId, eventId: adoptionId, continuation: { step: 0, after: '' } };
    const queued = await withScope(workerPool, f.worker, (client, principal) =>
      continueAdoptionRuleEvaluations(client, principal, work, 2),
    );
    expect(queued).toBe(2);
    const rows = await admin.query<{ trigger_kind: string; continuation: { step: number; after: string } | null }>(
      `SELECT trigger_kind,continuation FROM rule_evaluation_work WHERE tenant_id=$1 AND leaf_id=$2
       AND trigger_event_id=$3 ORDER BY trigger_kind,continuation->>'after'`,
      [f.tenantId, leafId, adoptionId],
    );
    const firstObservations = await admin.query<{ id: string }>(
      'SELECT id FROM observations WHERE tenant_id=$1 ORDER BY id LIMIT 2',
      [f.tenantId],
    );
    expect(rows.rows).toEqual([
      { trigger_kind: 'adoption', continuation: null },
      { trigger_kind: 'adoption', continuation: null },
      { trigger_kind: 'adoption-page', continuation: { step: 0, after: '' } },
      { trigger_kind: 'adoption-page', continuation: { step: 0, after: firstObservations.rows[1]!.id } },
    ]);

    await drainOwnedWork(admin, workerPool, [f.tenantId]);
    const evaluated = await admin.query(
      `SELECT subject_id,count(*)::int AS count FROM rule_evaluations WHERE tenant_id=$1 AND leaf_id=$2
       GROUP BY 1 ORDER BY 1`,
      [f.tenantId, leafId],
    );
    expect(evaluated.rows).toEqual(tails.map((tail) => ({ subject_id: tail, count: 1 })));
  });

  /** True once a transaction in this database waits for an advisory lock. */
  async function waitingOnLock(): Promise<boolean> {
    const rows = await admin.query(
      `SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted
       AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`,
    );
    return Boolean(rows.rowCount);
  }

  /**
   * Projects two events at once: the first is held open just before it commits, the second starts and must wait for
   * it on the adopted-rules lock, then the first is released. Returns once both have committed.
   */
  async function projectHeldThenOther(f: Operator, heldEventId: string, otherEventId: string): Promise<void> {
    const leases = await withOwnedWork(admin, [f.tenantId], () => leaseWork(workerPool, { limit: 100 }));
    const held = leases.find((lease) => lease.event_id === heldEventId)!;
    const other = leases.find((lease) => lease.event_id === otherEventId)!;
    expect(leases.map((lease) => lease.event_id).sort()).toEqual([heldEventId, otherEventId].sort());
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const atCommit = new Promise<void>((resolve) => (reached = resolve));
    const first = processLease(workerPool, held, {
      beforeCommit: async () => {
        reached();
        await gate;
      },
    });
    await atCommit;
    let secondDone = false;
    const second = processLease(workerPool, other).finally(() => (secondDone = true));
    while (!(await waitingOnLock())) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondDone).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(await second).toBe(true);
  }

  async function evaluationsOf(f: Operator, tail: string) {
    return (
      await admin.query<{ leaf_id: string; adoption_id: string; trigger: string }>(
        `SELECT leaf_id,adoption_id,record->'trigger'->>'kind' AS trigger FROM rule_evaluations
         WHERE tenant_id=$1 AND subject_id=$2 ORDER BY leaf_id`,
        [f.tenantId, tail],
      )
    ).rows;
  }
  async function observationWork(f: Operator, eventId: string): Promise<number> {
    return (
      await admin.query(`SELECT 1 FROM rule_evaluation_work WHERE tenant_id=$1 AND trigger_event_id=$2`, [
        f.tenantId,
        eventId,
      ])
    ).rowCount!;
  }

  it('an observation projected while an adoption projects waits, then queues under the adoption, once', async () => {
    const f = await operator('adoption-first');
    await drainOwnedWork(admin, workerPool, [f.tenantId]);
    const adoptionId = await adopt(f);
    const reportId = await report(f, 'tail-x', 'reading-x', minutesAgo(1), -4);
    await projectHeldThenOther(f, adoptionId, reportId);
    // The observation's own queueing saw the adoption that committed first.
    expect(await observationWork(f, reportId)).toBe(2);
    await drainOwnedWork(admin, workerPool, [f.tenantId]);
    const evaluated = await evaluationsOf(f, 'tail-x');
    expect(evaluated.map((row) => [row.leaf_id, row.adoption_id])).toEqual([
      ['test.adoption-queue-deep', adoptionId],
      ['test.adoption-queue-floor', adoptionId],
    ]);
  });

  it('an adoption projected while an observation projects waits, then its pages queue the observation, once', async () => {
    const f = await operator('observation-first');
    await drainOwnedWork(admin, workerPool, [f.tenantId]);
    const adoptionId = await adopt(f);
    const reportId = await report(f, 'tail-y', 'reading-y', minutesAgo(1), -4);
    await projectHeldThenOther(f, reportId, adoptionId);
    // The observation committed before the adoption was visible, so only the adoption's pages queue it.
    expect(await observationWork(f, reportId)).toBe(0);
    await drainOwnedWork(admin, workerPool, [f.tenantId]);
    const evaluated = await evaluationsOf(f, 'tail-y');
    expect(evaluated).toEqual([
      { leaf_id: 'test.adoption-queue-deep', adoption_id: adoptionId, trigger: 'adoption' },
      { leaf_id: 'test.adoption-queue-floor', adoption_id: adoptionId, trigger: 'adoption' },
    ]);
  });
});
