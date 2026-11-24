import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import type {
  OrganizationCoverageResponse,
  RuleEvaluationRecord,
  RulePackVersion,
  OpenFindingsResponse,
  SubjectFindingRecord,
} from '../../packages/contracts/src/index.js';
import { adoptShownPack } from '../../packages/contracts/fixtures/demo/v1/ready.js';
import {
  defineCheckedRule,
  evaluateAdoptedRule,
  findCheckKind,
  registerObservationTypes,
  registerRulePack,
} from '../../packages/domain/src/index.js';
import { canonicalDigest, sha256 } from '../../packages/integrity/src/index.js';
import { createPool, MemoryObjectStore, withScope, type AuthContext } from '../../packages/persistence/src/index.js';
import { rotorIcingObservation, rotorIcingType } from '../unit/rotor-icing-observation.js';
import { runOwnedWork, settleOwnedWork } from './worker-queue.js';

// Everything rule-specific below lives in this test: the observation types, the rules and their pack. Nothing in
// intake, the evaluator, the worker or the reads names them.
describe.runIf(process.env.LEDGER_ENV !== 'staging')('Generic rule evaluation on PostgreSQL', () => {
  const prefix = `rule-evaluation-${randomUUID()}`;
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const workerPool = createPool(process.env.WORKER_DATABASE_URL);
  const sourceId = `${prefix}-sensor`;
  const types = { limit: 'rotor.icing-limit', heater: 'rotor.icing-heater', window: 'rotor.icing-window' };
  let app: Awaited<ReturnType<typeof createApp>>;

  const limitRule = defineCheckedRule({
    id: 'test.icing-temperature-floor',
    version: 1,
    title: 'Outside air stays above the icing floor',
    source: {
      kind: 'operator_procedure',
      reference: 'Fictional procedure 4.2',
      text: 'Stop while the outside air is at or below the icing floor the operator sets.',
    },
    target: { subjectKind: 'aircraft' },
    reads: [{ name: 'subject', type: types.limit, versions: [1], about: 'target', required: true, select: 'latest' }],
    check: {
      kind: findCheckKind('value.within-limit', 1)!,
      params: { field: 'values.outsideAirTemperatureCelsius', comparison: 'above' },
    },
    adoptionParameters: [{ name: 'limit', title: 'Icing floor (Celsius)', valueType: 'number', minimum: -60 }],
  });
  const pairRule = defineCheckedRule({
    id: 'test.icing-heater-on-flight',
    version: 1,
    title: 'Rotor heater reports power during icing',
    source: { kind: 'operator_procedure', reference: 'Fictional procedure 4.3', text: 'Report heater power in icing.' },
    target: { subjectKind: 'flight' },
    reads: [
      { name: 'context', type: types.limit, versions: [1], about: 'target', required: true, select: 'latest' },
      { name: 'subject', type: types.heater, versions: [1], about: 'target', required: true, select: 'latest' },
    ],
    check: {
      kind: findCheckKind('value.within-limit', 1)!,
      params: { field: 'values.outsideAirTemperatureCelsius', comparison: 'above', limit: 0 },
    },
  });
  const windowRule = defineCheckedRule({
    id: 'test.icing-protection-in-effect',
    version: 1,
    title: 'Icing protection is in effect',
    source: {
      kind: 'operator_procedure',
      reference: 'Fictional procedure 4.4',
      text: 'Keep icing protection current.',
    },
    target: { subjectKind: 'aircraft' },
    reads: [{ name: 'interval', type: types.window, versions: [1], about: 'target', required: true, select: 'all' }],
    check: { kind: findCheckKind('interval.covers-window', 1)! },
  });
  const packContent = {
    packId: `${prefix}.pack`,
    version: 1,
    title: 'Fictional icing procedures',
    status: 'draft' as const,
    review: 'ai_drafted' as const,
    adopted: false as const,
    bindings: [],
    leaves: [limitRule, pairRule, windowRule],
  };
  const testPack: RulePackVersion = { ...packContent, digest: canonicalDigest(packContent) };

  interface Tenant {
    id: string;
    actor: AuthContext;
    worker: AuthContext;
    source: AuthContext;
    artifactId: string;
  }
  const tenants: Record<'a' | 'b', Tenant> = {} as Record<'a' | 'b', Tenant>;

  function call(principal: AuthContext, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
    return app.inject({
      method,
      url,
      headers: { authorization: `Bearer ledger-dev-${principal.id}`, 'idempotency-key': randomUUID() },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  }

  async function tenant(name: string): Promise<Tenant> {
    const tenantId = `${prefix}:${name}`;
    const base = { tenantId, revision: 1, kind: 'human', name: `Fictional ${name} owner` };
    const actor: AuthContext = {
      ...base,
      id: `${tenantId}:actor`,
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
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, `Fictional ${name}`]);
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
      observationGrants: Object.values(types).map((observationType) => ({ sourceId, observationType })),
    });
    expect(granted.statusCode, granted.body).toBe(201);
    return { id: tenantId, actor, worker, source, artifactId: await upload(source) };
  }

  async function upload(principal: AuthContext): Promise<string> {
    const bytes = Buffer.from(JSON.stringify({ entered: 'fictional icing log' }));
    const created = await call(principal, 'POST', '/v1/uploads', {
      contentType: 'application/json',
      byteLength: bytes.byteLength,
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().upload.id as string;
    const stored = await app.inject({
      method: 'PUT',
      url: `/v1/uploads/${id}/content`,
      headers: {
        authorization: `Bearer ledger-dev-${principal.id}`,
        'idempotency-key': randomUUID(),
        'content-type': 'application/octet-stream',
      },
      payload: bytes,
    });
    expect(stored.statusCode, stored.body).toBe(200);
    const finalized = await call(principal, 'POST', `/v1/uploads/${id}/finalize`);
    expect(finalized.statusCode, finalized.body).toBe(201);
    return finalized.json().artifact.id as string;
  }

  async function settle(done: () => Promise<boolean> = async () => false): Promise<void> {
    for (let attempt = 0; attempt < 60; attempt++) {
      const completed = await runOwnedWork(admin, workerPool, [prefix]);
      if (await done()) return;
      if (!completed) {
        const pending = await admin.query(
          `SELECT (SELECT COUNT(*) FROM work_items w WHERE w.tenant_id LIKE $1 AND w.state IN ('pending','leased'))
           +(SELECT COUNT(*) FROM rule_evaluation_work r WHERE r.tenant_id LIKE $1 AND r.state IN ('pending','leased')
             AND r.due_at<=clock_timestamp()) AS count`,
          [`${prefix}%`],
        );
        if (Number(pending.rows[0].count) === 0) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    throw new Error('Worker did not settle');
  }

  async function submit(t: Tenant, observation: Record<string, unknown>) {
    const response = await call(t.source, 'POST', '/v1/inputs', {
      sourceId,
      kind: 'observation',
      occurredAt: observation.occurredAt,
      payload: { ...observation, originalArtifactId: t.artifactId },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().receipt as { id: string; eventId: string };
  }

  function sourceSubject(id: string) {
    return { kind: 'aircraft', id, scope: 'source' };
  }
  function query(id: string, scope: 'source' | 'ledger' = 'source', kind = 'aircraft') {
    return new URLSearchParams({
      subjectKind: kind,
      subjectId: id,
      ...(scope === 'source' ? { subjectScope: 'source', sourceId } : {}),
    }).toString();
  }
  async function evaluations(principal: AuthContext, q: string): Promise<RuleEvaluationRecord[]> {
    const response = await call(principal, 'GET', `/v1/evaluations?${q}`);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    return response.json().evaluations;
  }
  async function findings(principal: AuthContext, q: string): Promise<SubjectFindingRecord[]> {
    const response = await call(principal, 'GET', `/v1/findings?${q}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json().findings;
  }

  beforeAll(async () => {
    registerObservationTypes(...Object.values(types).map((type) => rotorIcingType(type)));
    registerRulePack({ packId: testPack.packId, versions: [testPack] });
    app = await createApp({ pool, env: 'test', objectStore: new MemoryObjectStore() });
    await app.ready();
    tenants.a = await tenant('a');
    tenants.b = await tenant('b');
    const shown = await call(tenants.a.actor, 'GET', '/v1/organization/coverage');
    expect(shown.statusCode, shown.body).toBe(200);
    const retained = await call(
      tenants.a.actor,
      'GET',
      `/v1/rule-packs/${encodeURIComponent(testPack.packId)}/versions/1`,
    );
    expect(retained.statusCode, retained.body).toBe(200);
    const now = Date.now();
    const command = adoptShownPack(
      shown.json() as OrganizationCoverageResponse,
      retained.json().pack,
      { start: new Date(now - 60_000).toISOString(), end: new Date(now + 3_600_000).toISOString() },
      'Adopt the fictional icing procedures with our floor.',
      'active',
    );
    const missing = await call(tenants.a.actor, 'POST', '/v1/commands', command);
    expect(missing.statusCode, missing.body).toBe(400);
    expect(missing.json().error.code).toBe('invalid_adoption_parameters');
    const adopted = await call(tenants.a.actor, 'POST', '/v1/commands', {
      ...command,
      parameters: { [limitRule.id]: { limit: -2 } },
    });
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

  it('opens a finding when an observation breaches the adopted limit, for an unresolved source subject', async () => {
    const a = tenants.a;
    const receipt = await submit(
      a,
      rotorIcingObservation(
        {
          subject: sourceSubject('tail-1'),
          sourceEventId: 'reading-1',
          values: { severity: 'light', outsideAirTemperatureCelsius: -4 },
        },
        types.limit,
      ),
    );
    await settle(async () => (await evaluations(a.actor, query('tail-1'))).length > 0);
    const [evaluation] = await evaluations(a.actor, query('tail-1'));
    expect(evaluation).toMatchObject({
      version: 'ledger.rule-evaluation.1',
      subject: { scope: 'source', kind: 'aircraft', id: 'tail-1', sourceId },
      pack: { id: testPack.packId, version: 1, digest: testPack.digest },
      rule: { id: limitRule.id, version: 1, digest: limitRule.digest, source: { sha256: limitRule.source.sha256 } },
      check: { kind: 'value.within-limit', version: 1, definitionDigest: limitRule.check.definitionDigest },
      parameters: { field: 'values.outsideAirTemperatureCelsius', comparison: 'above', limit: -2 },
      evidenceState: 'supported',
      outcome: 'attention',
      reasonCode: 'value_outside_limit',
      trigger: { kind: 'observation', eventId: receipt.eventId },
      evidence: [{ eventId: receipt.eventId, receiptId: receipt.id, sourceId, type: types.limit }],
    });
    expect(Object.keys(evaluation!.inputCut.streams).length).toBeGreaterThan(0);
    const event = await withScope(pool, a.actor, (client) =>
      client.query('SELECT event_type,causation_id,payload FROM journal_events WHERE id=$1', [evaluation!.id]),
    );
    expect(event.rows[0]).toMatchObject({ event_type: 'rule-evaluation.recorded', causation_id: receipt.eventId });
    expect(event.rows[0].payload.evaluation.inputDigest).toBe(evaluation!.inputDigest);
    const [finding] = await findings(a.actor, query('tail-1'));
    expect(finding).toMatchObject({
      subject: { scope: 'source', kind: 'aircraft', id: 'tail-1', sourceId },
      packId: testPack.packId,
      ruleId: limitRule.id,
      status: 'open',
      owner: null,
      initialEvaluation: { id: evaluation!.id },
      latestEvaluation: { id: evaluation!.id },
      treatments: [],
    });
    const single = await call(a.actor, 'GET', `/v1/evaluations/${evaluation!.id}`);
    expect(single.statusCode, single.body).toBe(200);
    expect(single.json().evaluation).toEqual(evaluation);
  });

  it('does not evaluate or record the same rule, subject and inputs twice', async () => {
    const a = tenants.a;
    const before = await evaluations(a.actor, query('tail-1'));
    // Resending the same source event returns its receipt and queues nothing new.
    await submit(
      a,
      rotorIcingObservation(
        {
          subject: sourceSubject('tail-1'),
          sourceEventId: 'reading-1',
          values: { severity: 'light', outsideAirTemperatureCelsius: -4 },
        },
        types.limit,
      ),
    );
    await settle();
    // Running the engine again directly, as a redelivered work item would, records nothing.
    const again = await withScope(workerPool, a.worker, (client, principal) =>
      evaluateAdoptedRule(client, principal, {
        subject: { scope: 'source', kind: 'aircraft', id: 'tail-1', sourceId },
        packId: testPack.packId,
        leafId: limitRule.id,
        trigger: { kind: 'observation', eventId: before[0]!.trigger.eventId! },
      }),
    );
    expect(again).toBeNull();
    expect(await evaluations(a.actor, query('tail-1'))).toEqual(before);
  });

  it('records a new evaluation and updates the finding when a later observation changes the answer', async () => {
    const a = tenants.a;
    const [first] = await evaluations(a.actor, query('tail-1'));
    await submit(
      a,
      rotorIcingObservation(
        {
          subject: sourceSubject('tail-1'),
          sourceEventId: 'reading-2',
          occurredAt: '2026-11-02T11:15:00.000Z',
          interval: { start: '2026-11-02T11:00:00.000Z', end: '2026-11-02T11:10:00.000Z' },
          values: { severity: 'trace', outsideAirTemperatureCelsius: 3 },
        },
        types.limit,
      ),
    );
    await settle(async () => (await evaluations(a.actor, query('tail-1'))).length > 1);
    const [latest, previous] = await evaluations(a.actor, query('tail-1'));
    expect(previous!.id).toBe(first!.id);
    expect(latest).toMatchObject({ evidenceState: 'supported', outcome: 'pass', reasonCode: 'value_within_limit' });
    expect(latest!.observationDigest).not.toBe(first!.observationDigest);
    const [finding] = await findings(a.actor, query('tail-1'));
    // A later reading back inside the limit is the world moving on, not a record people keep answering the finding:
    // what it reported still happened, so it stays open, shown as no longer needing attention, for a person to close.
    expect(finding).toMatchObject({
      status: 'open',
      initialEvaluation: { id: first!.id, outcome: 'attention' },
      latestEvaluation: { id: latest!.id, outcome: 'pass' },
    });
    expect(finding!.closure).toBeUndefined();
    const listed = await call(a.actor, 'GET', '/v1/organization/open-findings?result=cleared');
    expect(listed.statusCode, listed.body).toBe(200);
    expect((listed.json() as OpenFindingsResponse).findings.find((item) => item.id === finding!.id)).toMatchObject({
      cleared: true,
      status: 'open',
    });
    const stillAttention = await call(a.actor, 'GET', '/v1/organization/open-findings?result=attention');
    expect((stillAttention.json() as OpenFindingsResponse).findings.map((item) => item.id)).not.toContain(finding!.id);
  });

  it('records insufficient evidence for a Ledger flight when a required observation is missing', async () => {
    const a = tenants.a;
    const created = await call(a.actor, 'POST', '/v1/flights', { originationKey: `${prefix}-flight` });
    expect(created.statusCode, created.body).toBe(201);
    const flightId = created.json().flight.id as string;
    await submit(
      a,
      rotorIcingObservation(
        { subject: { kind: 'flight', id: flightId, scope: 'ledger' }, sourceEventId: 'flight-1' },
        types.limit,
      ),
    );
    const q = query(flightId, 'ledger', 'flight');
    await settle(async () => (await evaluations(a.actor, q)).length > 0);
    const [evaluation] = await evaluations(a.actor, q);
    expect(evaluation).toMatchObject({
      subject: { scope: 'ledger', kind: 'flight', id: flightId },
      rule: { id: pairRule.id },
      applicability: 'applicable',
      evidenceState: 'insufficient',
      outcome: 'pending',
      reasonCode: 'required_input_missing',
      evidence: [],
    });
    expect(evaluation!.inputs.map((input) => [input.name, input.observationIds.length])).toEqual([
      ['context', 1],
      ['subject', 0],
    ]);
    expect(await findings(a.actor, q)).toEqual([]);
  });

  it('evaluates again when a recorded boundary passes, with no new observation', async () => {
    const a = tenants.a;
    const now = Date.now();
    const end = new Date(now + 3_000).toISOString();
    await submit(
      a,
      rotorIcingObservation(
        {
          subject: sourceSubject('tail-2'),
          sourceEventId: 'protection-1',
          occurredAt: new Date(now - 1_000).toISOString(),
          interval: { start: new Date(now - 3_600_000).toISOString(), end },
        },
        types.window,
      ),
    );
    await settle(async () => (await evaluations(a.actor, query('tail-2'))).length > 0);
    const [covered] = await evaluations(a.actor, query('tail-2'));
    expect(covered).toMatchObject({ outcome: 'pass', reasonCode: 'window_covered', nextBoundary: end });
    expect(await findings(a.actor, query('tail-2'))).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Date.parse(end) - Date.now()) + 300));
    await settle(async () => (await evaluations(a.actor, query('tail-2'))).length > 1);
    const [lapsed] = await evaluations(a.actor, query('tail-2'));
    expect(lapsed).toMatchObject({
      evidenceState: 'insufficient',
      outcome: 'attention',
      reasonCode: 'window_not_covered',
      trigger: { kind: 'deadline', eventId: covered!.id, dueAt: end },
      observationDigest: covered!.observationDigest,
    });
    expect(lapsed!.inputDigest).not.toBe(covered!.inputDigest);
    const [finding] = await findings(a.actor, query('tail-2'));
    expect(finding).toMatchObject({ status: 'open', latestEvaluation: { id: lapsed!.id } });
  });

  it('keeps evaluations and findings inside their tenant', async () => {
    const [a, b] = [tenants.a, tenants.b];
    // The same breach in a tenant that adopted nothing is retained but not evaluated.
    await submit(
      b,
      rotorIcingObservation(
        {
          subject: sourceSubject('tail-1'),
          sourceEventId: 'reading-1',
          values: { severity: 'light', outsideAirTemperatureCelsius: -4 },
        },
        types.limit,
      ),
    );
    await settle();
    expect(await evaluations(b.actor, query('tail-1'))).toEqual([]);
    expect(await findings(b.actor, query('tail-1'))).toEqual([]);
    const [evaluation] = await evaluations(a.actor, query('tail-1'));
    const foreign = await call(b.actor, 'GET', `/v1/evaluations/${evaluation!.id}`);
    expect(foreign.statusCode).toBe(404);
    const rows = await withScope(workerPool, b.worker, async (client) => ({
      evaluations: (await client.query('SELECT id FROM rule_evaluations')).rowCount,
      findings: (await client.query('SELECT id FROM findings WHERE subject_key IS NOT NULL')).rowCount,
      work: (await client.query('SELECT id FROM rule_evaluation_work')).rowCount,
    }));
    expect(rows).toEqual({ evaluations: 0, findings: 0, work: 0 });
  });
});
