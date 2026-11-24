import 'dotenv/config';
import { localizeInstants } from '../../packages/contracts/src/index.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import type {
  FindingRecord,
  OrganizationCoverageResponse,
  RuleEvaluationRecord,
  RulePackVersion,
  SubjectFindingRecord,
} from '../../packages/contracts/src/index.js';
import { adoptShownPack } from '../../packages/contracts/fixtures/demo/v1/ready.js';
import {
  defineCheckedRule,
  defineIndicator,
  evaluateAdoptedRule,
  findCheckKind,
  gatherIndicatorInputs,
  registerIndicatorDefinition,
  registerObservationTypes,
  registerRulePack,
} from '../../packages/domain/src/index.js';
import { canonicalDigest, sha256 } from '../../packages/integrity/src/index.js';
import { createPool, MemoryObjectStore, withScope, type AuthContext } from '../../packages/persistence/src/index.js';
import { rotorIcingObservation, rotorIcingType } from '../unit/rotor-icing-observation.js';
import { runOwnedWork, settleOwnedWork } from './worker-queue.js';

// The observation type, the rules and their pack exist only in this test. Nothing in intake, the evaluator, the
// worker or the reads names them. The two rules differ only in whether their read declares that it reads plans.
describe.runIf(process.env.LEDGER_ENV !== 'staging')('Rules that read plans on PostgreSQL', () => {
  const prefix = `rule-plans-${randomUUID()}`;
  const tenantId = `${prefix}:tenant`;
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const workerPool = createPool(process.env.WORKER_DATABASE_URL);
  const sourceId = `${prefix}-planner`;
  const type = 'rotor.icing-forecast';
  let app: Awaited<ReturnType<typeof createApp>>;

  const rule = (id: string, plans: boolean) =>
    defineCheckedRule({
      id,
      version: 1,
      title: 'Forecast outside air stays above freezing',
      source: { kind: 'operator_procedure', reference: 'Fictional procedure 9.1', text: 'Plan above freezing.' },
      target: { subjectKind: 'flight' },
      reads: [
        {
          name: 'subject',
          type,
          versions: [1],
          about: 'target',
          required: true,
          select: 'latest',
          ...(plans ? { plans: true as const } : {}),
        },
      ],
      check: {
        kind: findCheckKind('value.within-limit', 1)!,
        params: { field: 'values.outsideAirTemperatureCelsius', comparison: 'above', limit: 0 },
      },
    });
  const planRule = rule('test.planned-air-above-freezing', true);
  const presentRule = rule('test.present-air-above-freezing', false);
  const packContent = {
    packId: `${prefix}.pack`,
    version: 1,
    title: 'Fictional planning procedures',
    status: 'draft' as const,
    review: 'ai_drafted' as const,
    adopted: false as const,
    bindings: [],
    leaves: [planRule, presentRule],
  };
  const testPack: RulePackVersion = { ...packContent, digest: canonicalDigest(packContent) };
  const findingsOf = (ruleId: string, name: string) =>
    defineIndicator({
      id: `test.${name}-forecast-findings`,
      version: 1,
      title: 'Forecast findings per flight hour',
      description: 'Findings the fictional forecast rule opened, per reported flight hour.',
      scope: { kind: 'subject_kind', subjectKind: 'flight' },
      events: { kind: 'findings', packId: testPack.packId, ruleId },
      exposure: { kind: 'exposure.flight-hours', version: 1, params: {} },
      window: { maxMilliseconds: 24 * 60 * 60 * 1000 },
      completeness: { exposureMustExceed: '0', populationDeclaredComplete: true, coverageWithoutGaps: true },
      unit: { per: 1, label: 'per flight hour', fractionDigits: 3 },
    });
  const planFindings = findingsOf(planRule.id, 'planned');
  const presentFindings = findingsOf(presentRule.id, 'present');

  const base = { tenantId, revision: 1, name: 'Fictional planning owner' };
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
  const source: AuthContext = {
    ...base,
    id: `${tenantId}:source`,
    kind: 'source',
    capabilities: ['input:write', 'flight:read', 'evidence:read'],
  };
  let artifactId = '';

  function call(principal: AuthContext, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
    return app.inject({
      method,
      url,
      headers: { authorization: `Bearer ledger-dev-${principal.id}`, 'idempotency-key': randomUUID() },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  }

  async function upload(): Promise<string> {
    const bytes = Buffer.from(JSON.stringify({ entered: 'fictional icing forecast' }));
    const created = await call(source, 'POST', '/v1/uploads', {
      contentType: 'application/json',
      byteLength: bytes.byteLength,
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().upload.id as string;
    const stored = await app.inject({
      method: 'PUT',
      url: `/v1/uploads/${id}/content`,
      headers: {
        authorization: `Bearer ledger-dev-${source.id}`,
        'idempotency-key': randomUUID(),
        'content-type': 'application/octet-stream',
      },
      payload: bytes,
    });
    expect(stored.statusCode, stored.body).toBe(200);
    const finalized = await call(source, 'POST', `/v1/uploads/${id}/finalize`);
    expect(finalized.statusCode, finalized.body).toBe(201);
    return finalized.json().artifact.id as string;
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

  /** A forecast recorded now about the interval that starts `startsIn` milliseconds from now and lasts an hour. */
  async function plan(flightId: string, celsius: number, startsIn: number, replaces?: string): Promise<string> {
    const start = Date.now() + startsIn;
    const observation = rotorIcingObservation(
      {
        subject: { kind: 'flight', id: flightId, scope: 'ledger' },
        sourceEventId: randomUUID(),
        occurredAt: new Date().toISOString(),
        interval: { start: new Date(start).toISOString(), end: new Date(start + 3_600_000).toISOString() },
        values: { severity: 'light', outsideAirTemperatureCelsius: celsius },
        originalArtifactId: artifactId,
      },
      type,
    );
    const response = await call(source, 'POST', '/v1/inputs', {
      sourceId,
      kind: 'observation',
      occurredAt: observation.occurredAt,
      payload: observation,
      ...(replaces ? { replaces } : {}),
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().receipt.eventId as string;
  }
  async function flight(): Promise<string> {
    const created = await call(actor, 'POST', '/v1/flights', { originationKey: `${prefix}-${randomUUID()}` });
    expect(created.statusCode, created.body).toBe(201);
    return created.json().flight.id as string;
  }
  async function evaluations(flightId: string, leafId: string): Promise<RuleEvaluationRecord[]> {
    const response = await call(actor, 'GET', `/v1/evaluations?subjectKind=flight&subjectId=${flightId}`);
    expect(response.statusCode, response.body).toBe(200);
    return (response.json().evaluations as RuleEvaluationRecord[]).filter((item) => item.rule.id === leafId);
  }
  async function evaluated(flightId: string, leafId: string, count: number): Promise<RuleEvaluationRecord[]> {
    await settle(async () => (await evaluations(flightId, leafId)).length >= count);
    const found = await evaluations(flightId, leafId);
    expect(found).toHaveLength(count);
    return found;
  }
  async function findings(flightId: string, leafId: string): Promise<SubjectFindingRecord[]> {
    const response = await call(actor, 'GET', `/v1/findings?subjectKind=flight&subjectId=${flightId}`);
    expect(response.statusCode, response.body).toBe(200);
    return (response.json().findings as SubjectFindingRecord[]).filter((item) => item.ruleId === leafId);
  }

  beforeAll(async () => {
    registerObservationTypes(rotorIcingType(type));
    registerRulePack({ packId: testPack.packId, versions: [testPack] });
    registerIndicatorDefinition(planFindings);
    registerIndicatorDefinition(presentFindings);
    app = await createApp({ pool, env: 'test', objectStore: new MemoryObjectStore() });
    await app.ready();
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, 'Fictional planning tenant']);
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
    artifactId = await upload();
    const shown = await call(actor, 'GET', '/v1/organization/coverage');
    expect(shown.statusCode, shown.body).toBe(200);
    const retained = await call(actor, 'GET', `/v1/rule-packs/${encodeURIComponent(testPack.packId)}/versions/1`);
    expect(retained.statusCode, retained.body).toBe(200);
    const now = Date.now();
    const adopted = await call(
      actor,
      'POST',
      '/v1/commands',
      adoptShownPack(
        shown.json() as OrganizationCoverageResponse,
        retained.json().pack,
        { start: new Date(now - 60_000).toISOString(), end: new Date(now + 3 * 86_400_000).toISOString() },
        'Adopt the fictional planning procedures.',
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

  it('finds on a plan recorded today for tomorrow, and says it was read as a plan', async () => {
    const flightId = await flight();
    const recorded = await plan(flightId, -3, 86_400_000);
    const [planned] = await evaluated(flightId, planRule.id, 1);
    expect(planned).toMatchObject({
      outcome: 'attention',
      reasonCode: 'value_outside_limit',
      readAsPlans: { observationIds: [recorded] },
      inputs: [{ name: 'subject', observationIds: [recorded] }],
    });
    expect(Date.parse(planned!.readAsPlans!.from)).toBeGreaterThan(Date.parse(planned!.clock.evaluatedAt));
    const [finding] = await findings(flightId, planRule.id);
    expect(finding).toMatchObject({ status: 'open', latestEvaluation: { readAsPlans: planned!.readAsPlans } });

    // The same record, read by a rule that does not read plans, is not read until its time comes. The result says
    // that a record is on file for a later time and when the rule reads it, and is due again then.
    const [present] = await evaluated(flightId, presentRule.id, 1);
    const from = planned!.readAsPlans!.from;
    expect(present).toMatchObject({
      outcome: 'pending',
      evidenceState: 'insufficient',
      reasonCode: 'record_for_later_time',
      nextBoundary: from,
      inputs: [{ name: 'subject', observationIds: [], later: { from, observationIds: [recorded] } }],
    });
    expect(present!.summary).toBe(
      `An icing forecast is on file for a later time; the rule reads it from ${localizeInstants(from, 'UTC')}.`,
    );
    expect(present!.summary).not.toMatch(/\bNo\b/);
    expect(present).not.toHaveProperty('readAsPlans');
    expect(await findings(flightId, presentRule.id)).toEqual([]);

    // The flight's own findings carry it in the explanation the finding card shows.
    const shown = await call(actor, 'GET', `/v1/flights/${flightId}/findings`);
    expect(shown.statusCode, shown.body).toBe(200);
    const flightFindings = shown.json().findings as FindingRecord[];
    expect(flightFindings.map((item) => item.latestEvaluation.explanation)).toEqual([
      expect.objectContaining({ kind: 'rule', readAsPlans: planned!.readAsPlans }),
    ]);
  });

  it('keeps one finding and one line of evaluations when the plan’s time comes', async () => {
    const flightId = await flight();
    const recorded = await plan(flightId, -3, 5_000);
    const [planned] = await evaluated(flightId, planRule.id, 1);
    expect(planned).toMatchObject({ outcome: 'attention', readAsPlans: { observationIds: [recorded] } });
    await new Promise((resolve) => setTimeout(resolve, 5_500));
    const again = (leafId: string) =>
      withScope(workerPool, worker, (client, principal) =>
        evaluateAdoptedRule(client, principal, {
          subject: { scope: 'ledger', kind: 'flight', id: flightId },
          packId: testPack.packId,
          leafId,
          trigger: { kind: 'observation', eventId: recorded },
        }),
      );
    // The time has come: the plan rule reads the same record and records nothing new.
    expect(await again(planRule.id)).toBeNull();
    expect(await evaluations(flightId, planRule.id)).toEqual([planned]);
    const [finding] = await findings(flightId, planRule.id);
    expect(finding).toMatchObject({ initialEvaluation: { id: planned!.id }, latestEvaluation: { id: planned!.id } });
    expect(await findings(flightId, planRule.id)).toHaveLength(1);
    // Only now does the rule that does not read plans read it.
    expect(await again(presentRule.id)).toMatchObject({
      outcome: 'attention',
      inputs: [{ observationIds: [recorded] }],
    });
  });

  it('counts a finding opened on a plan in the window the plan is about, and stops at the window for other rules', async () => {
    // A finding opened now on a plan about tomorrow.
    const planned = await flight();
    await plan(planned, -3, 86_400_000);
    const [onPlan] = await evaluated(planned, planRule.id, 1);
    // A finding opened now by the rule that does not read plans, once the forecast's time has come.
    const present = await flight();
    const recorded = await plan(present, -3, 3_000);
    await evaluated(present, planRule.id, 1);
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    const opened = await withScope(workerPool, worker, (client, principal) =>
      evaluateAdoptedRule(client, principal, {
        subject: { scope: 'ledger', kind: 'flight', id: present },
        packId: testPack.packId,
        leafId: presentRule.id,
        trigger: { kind: 'observation', eventId: recorded },
      }),
    );
    expect(opened).toMatchObject({ outcome: 'attention' });
    // Its evaluations are append-only; its view is not. Pointed at the evaluation that read the plan, it would be
    // placed tomorrow if the read visited it.
    const updated = await admin.query(
      'UPDATE finding_views SET latest_rule_evaluation_id=$1 WHERE tenant_id=$2 AND latest_rule_evaluation_id=$3',
      [onPlan!.id, tenantId, opened!.id],
    );
    expect(updated.rowCount).toBe(1);
    const from = Date.parse(onPlan!.readAsPlans!.from);
    const gather = (definitionId: string) =>
      withScope(workerPool, worker, (client, principal) =>
        gatherIndicatorInputs(client, principal, {
          definition: { id: definitionId, version: 1 },
          window: { start: new Date(from - 3_600_000).toISOString(), end: new Date(from + 3_600_000).toISOString() },
          recordedThrough: new Date().toISOString(),
          population: {
            subjects: [planned, present].map((id) => ({ scope: 'ledger' as const, kind: 'flight' as const, id })),
            complete: true,
            declaredBy: { kind: 'person' as const, id: actor.id },
          },
        }),
      );
    const plans = await gather(planFindings.id);
    expect(plans.input.events).toEqual([
      expect.objectContaining({ kind: 'finding', subject: expect.objectContaining({ id: planned }) }),
    ]);
    expect(plans.input.events[0]).toMatchObject({ plannedFrom: onPlan!.readAsPlans!.from });
    expect((await gather(presentFindings.id)).input.events).toEqual([]);
  });

  it('evaluates a plan corrected or withdrawn before its time like any correction, under the same finding', async () => {
    const flightId = await flight();
    const first = await plan(flightId, -3, 86_400_000);
    await evaluated(flightId, planRule.id, 1);
    const corrected = await plan(flightId, 4, 86_400_000, first);
    const [replaced] = await evaluated(flightId, planRule.id, 2);
    expect(replaced).toMatchObject({ outcome: 'pass', readAsPlans: { observationIds: [corrected] } });
    const withdrawn = await call(source, 'POST', '/v1/commands', {
      kind: 'observation.withdraw',
      observationId: corrected,
      reason: 'The flight was taken off the plan.',
    });
    expect(withdrawn.statusCode, withdrawn.body).toBe(201);
    const [latest] = await evaluated(flightId, planRule.id, 3);
    expect(latest).toMatchObject({ evidenceState: 'insufficient', inputs: [{ observationIds: [] }] });
    expect(latest).not.toHaveProperty('readAsPlans');
    const all = await findings(flightId, planRule.id);
    expect(all).toHaveLength(1);
    expect(all[0]!.latestEvaluation.id).toBe(latest!.id);
  });
});
