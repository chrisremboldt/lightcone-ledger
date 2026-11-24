import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import {
  FidelitySchema,
  ObservationSubjectSchema,
  type ObservationTypeDefinition,
  type OrganizationCoverageResponse,
  type RuleEvaluationRecord,
  type RulePackVersion,
} from '../../packages/contracts/src/index.js';
import { adoptShownPack } from '../../packages/contracts/fixtures/demo/v1/ready.js';
import {
  defineCheckedRule,
  findCheckKind,
  registerObservationTypes,
  registerRulePack,
} from '../../packages/domain/src/index.js';
import { canonicalDigest, sha256 } from '../../packages/integrity/src/index.js';
import { createPool, MemoryObjectStore, type AuthContext } from '../../packages/persistence/src/index.js';
import { runOwnedWork, settleOwnedWork } from './worker-queue.js';

// Everything rule-specific lives in this test: the observation types, the rules and their packs. Nothing in intake,
// the evaluator or the worker names them.
describe.runIf(process.env.LEDGER_ENV !== 'staging')('What queues a rule for evaluation', () => {
  const prefix = `rule-queueing-${randomUUID()}`;
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const workerPool = createPool(process.env.WORKER_DATABASE_URL);
  const sourceId = `${prefix}-log`;
  const tenantId = `${prefix}:tenant`;
  const organizationId = `organization:${tenantId}`;
  const types = { reading: 'queueing.reading', record: 'queueing.organization-record' };
  let app: Awaited<ReturnType<typeof createApp>>;
  let artifactId: string;

  function observationType(type: string, subjectKinds: ObservationTypeDefinition['subjectKinds']) {
    const schema = {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'version', 'subject', 'occurredAt', 'fidelity', 'limitations', 'originalArtifactId', 'values'],
      properties: {
        type: { const: type },
        version: { const: 1 },
        subject: ObservationSubjectSchema,
        occurredAt: { type: 'string', format: 'date-time' },
        sourceEventId: { type: 'string', minLength: 1, maxLength: 200 },
        fidelity: FidelitySchema,
        limitations: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 1000 } },
        originalArtifactId: { type: 'string', minLength: 1, maxLength: 200 },
        values: {
          type: 'object',
          additionalProperties: false,
          required: ['amountCount'],
          properties: {
            topic: { enum: ['reading', 'reading-limit', 'other'] },
            amountCount: { type: 'integer', minimum: 0 },
          },
        },
      },
    };
    return {
      type,
      version: 1,
      timing: 'instant',
      subjectKinds,
      description: 'Made-up test type: a counted amount.',
      mayInfer: ['The source recorded this amount.'],
      mayNotInfer: ['Nothing beyond the recorded amount.'],
      schema: schema as unknown as ObservationTypeDefinition['schema'],
    } as ObservationTypeDefinition;
  }

  const source = {
    kind: 'operator_procedure' as const,
    reference: 'Fictional procedure 9.1',
    text: 'Keep each flight’s counted amount within the limit the organization records.',
  };
  const limitRule = defineCheckedRule({
    id: 'test.amount-within-organization-limit',
    version: 1,
    title: 'Counted amount within the organization’s limit',
    source,
    target: { subjectKind: 'flight' },
    reads: [
      {
        name: 'quantity',
        type: types.reading,
        versions: [1],
        about: 'target',
        required: true,
        select: 'latest',
        where: [{ field: 'values.topic', oneOf: ['reading'] }],
      },
      {
        name: 'limit',
        type: types.record,
        versions: [1],
        about: 'organization',
        required: true,
        select: 'latest',
        where: [{ field: 'values.topic', oneOf: ['reading-limit'] }],
      },
    ],
    check: {
      kind: findCheckKind('value.within-limit', 2)!,
      params: { field: 'values.amountCount', comparison: 'at_most', limitField: 'values.amountCount' },
    },
  });
  const packContent = {
    packId: `${prefix}.pack`,
    version: 1,
    title: 'Fictional amount procedures',
    status: 'draft' as const,
    review: 'ai_drafted' as const,
    adopted: false as const,
    bindings: [],
    leaves: [limitRule],
  };
  const testPack: RulePackVersion = { ...packContent, digest: canonicalDigest(packContent) };

  function stateRule(version: number) {
    return defineCheckedRule({
      id: 'test.flight-status-recorded',
      version,
      title: `Flight status is recorded, version ${version}`,
      source,
      target: { subjectKind: 'flight' },
      reads: [
        { name: 'notes', type: types.reading, versions: [1], about: 'target', required: false, select: 'latest' },
      ],
      subjectState: { name: 'subject', required: true },
      check: { kind: findCheckKind('value.one-of', 1)!, params: { field: 'status', expected: ['planned', 'landed'] } },
    });
  }
  function statePack(version: number): RulePackVersion {
    const content = {
      packId: `${prefix}.state-pack`,
      version,
      title: 'Fictional status procedures',
      status: 'draft' as const,
      review: 'ai_drafted' as const,
      adopted: false as const,
      bindings: [],
      leaves: [stateRule(version)],
    };
    return { ...content, digest: canonicalDigest(content) };
  }

  const actor: AuthContext = {
    tenantId,
    revision: 1,
    name: 'Fictional amount owner',
    id: `${tenantId}:actor`,
    kind: 'human',
    capabilities: ['flight:read', 'flight:create', 'evidence:read', 'authority:write', 'pack:adopt', 'input:write'],
  };
  const sourcePrincipal: AuthContext = {
    ...actor,
    id: `${tenantId}:source`,
    kind: 'source',
    capabilities: ['input:write', 'flight:read', 'evidence:read'],
  };
  const worker: AuthContext = {
    ...actor,
    id: `${tenantId}:worker`,
    kind: 'worker',
    capabilities: ['flight:read', 'evidence:read', 'input:write'],
  };

  function call(principal: AuthContext, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
    return app.inject({
      method,
      url,
      headers: { authorization: `Bearer ledger-dev-${principal.id}`, 'idempotency-key': randomUUID() },
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

  async function upload(): Promise<string> {
    const bytes = Buffer.from(JSON.stringify({ entered: 'fictional amount log' }));
    const created = await call(sourcePrincipal, 'POST', '/v1/uploads', {
      contentType: 'application/json',
      byteLength: bytes.byteLength,
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().upload.id as string;
    const stored = await app.inject({
      method: 'PUT',
      url: `/v1/uploads/${id}/content`,
      headers: {
        authorization: `Bearer ledger-dev-${sourcePrincipal.id}`,
        'idempotency-key': randomUUID(),
        'content-type': 'application/octet-stream',
      },
      payload: bytes,
    });
    expect(stored.statusCode, stored.body).toBe(200);
    const finalized = await call(sourcePrincipal, 'POST', `/v1/uploads/${id}/finalize`);
    expect(finalized.statusCode, finalized.body).toBe(201);
    return finalized.json().artifact.id as string;
  }

  async function adopt(pack: RulePackVersion, interval: { start: string; end: string }): Promise<void> {
    const shown = await call(actor, 'GET', '/v1/organization/coverage');
    expect(shown.statusCode, shown.body).toBe(200);
    const retained = await call(
      actor,
      'GET',
      `/v1/rule-packs/${encodeURIComponent(pack.packId)}/versions/${pack.version}`,
    );
    expect(retained.statusCode, retained.body).toBe(200);
    const adopted = await call(
      actor,
      'POST',
      '/v1/commands',
      adoptShownPack(
        shown.json() as OrganizationCoverageResponse,
        retained.json().pack,
        interval,
        'Adopt the fictional procedures.',
        'active',
      ),
    );
    expect(adopted.statusCode, adopted.body).toBe(201);
    await settle();
  }

  async function submit(
    type: string,
    subject: { kind: string; id: string; scope: 'ledger' },
    values: Record<string, unknown>,
    occurredAt: string,
    replaces?: string,
  ): Promise<string> {
    const response = await call(sourcePrincipal, 'POST', '/v1/inputs', {
      sourceId,
      kind: 'observation',
      occurredAt,
      payload: {
        type,
        version: 1,
        subject,
        occurredAt,
        fidelity: 'synthetic_contract',
        limitations: ['Synthetic test data.'],
        originalArtifactId: artifactId,
        values,
      },
      ...(replaces ? { replaces } : {}),
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().receipt.eventId as string;
  }
  const organization = { kind: 'organization', id: organizationId, scope: 'ledger' as const };
  function flightSubject(id: string) {
    return { kind: 'flight', id, scope: 'ledger' as const };
  }

  async function flight(): Promise<string> {
    const created = await call(actor, 'POST', '/v1/flights', { originationKey: `${prefix}-${randomUUID()}` });
    expect(created.statusCode, created.body).toBe(201);
    return created.json().flight.id as string;
  }
  async function evaluations(flightId: string, leafId = limitRule.id): Promise<RuleEvaluationRecord[]> {
    const response = await call(actor, 'GET', `/v1/evaluations?subjectKind=flight&subjectId=${flightId}`);
    expect(response.statusCode, response.body).toBe(200);
    return (response.json().evaluations as RuleEvaluationRecord[]).filter((item) => item.rule.id === leafId);
  }
  async function evaluated(flightId: string, count: number, leafId = limitRule.id): Promise<RuleEvaluationRecord[]> {
    await settle(async () => (await evaluations(flightId, leafId)).length >= count);
    const found = await evaluations(flightId, leafId);
    expect(found).toHaveLength(count);
    return found;
  }
  async function workFor(eventId: string): Promise<number> {
    const rows = await admin.query(
      'SELECT COUNT(*) AS count FROM rule_evaluation_work WHERE tenant_id=$1 AND trigger_event_id=$2',
      [tenantId, eventId],
    );
    return Number(rows.rows[0].count);
  }

  beforeAll(async () => {
    registerObservationTypes(
      observationType(types.reading, ['flight']),
      observationType(types.record, ['organization']),
    );
    registerRulePack({ packId: testPack.packId, versions: [testPack] });
    registerRulePack({ packId: `${prefix}.state-pack`, versions: [statePack(1), statePack(2)] });
    app = await createApp({ pool, env: 'test', objectStore: new MemoryObjectStore() });
    await app.ready();
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, 'Fictional amount tenant']);
    for (const principal of [actor, worker, sourcePrincipal]) {
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
    const current = await call(actor, 'GET', `/v1/authority/principals/${encodeURIComponent(sourcePrincipal.id)}`);
    expect(current.statusCode, current.body).toBe(200);
    const granted = await call(actor, 'POST', '/v1/commands', {
      kind: 'authority.update',
      principalId: sourcePrincipal.id,
      expectedRevision: current.json().principal.revision,
      capabilities: current.json().principal.capabilities,
      observationGrants: Object.values(types).map((observationType) => ({ sourceId, observationType })),
    });
    expect(granted.statusCode, granted.body).toBe(201);
    artifactId = await upload();
    const now = Date.now();
    await adopt(testPack, {
      start: new Date(now - 60_000).toISOString(),
      end: new Date(now + 3_600_000).toISOString(),
    });
  });
  afterAll(async () => {
    await settleOwnedWork([prefix]);
    if (app) await app.close();
    await pool.end();
    await admin.end();
    await workerPool.end();
  });

  it('evaluates a flight rule again when the organization record it reads is replaced', async () => {
    const limit = await submit(types.record, organization, { topic: 'reading-limit', amountCount: 10 }, at(-50));
    const flightId = await flight();
    await submit(types.reading, flightSubject(flightId), { topic: 'reading', amountCount: 8 }, at(-40));
    const [first] = await evaluated(flightId, 1);
    expect(first).toMatchObject({ outcome: 'pass', reasonCode: 'value_within_limit' });
    expect(first!.inputs.find((input) => input.name === 'limit')!.observationIds).toEqual([limit]);

    const replacement = await submit(
      types.record,
      organization,
      { topic: 'reading-limit', amountCount: 5 },
      at(-50),
      limit,
    );
    const [latest] = await evaluated(flightId, 2);
    expect(latest).toMatchObject({
      outcome: 'attention',
      reasonCode: 'value_outside_limit',
      trigger: { eventId: replacement },
    });
    expect(latest!.inputs.find((input) => input.name === 'limit')!.observationIds).toEqual([replacement]);

    // A new organization record queues the rule for every flight it has evaluated, once per flight.
    const other = await flight();
    await submit(types.reading, flightSubject(other), { topic: 'reading', amountCount: 1 }, at(-40));
    await evaluated(other, 1);
    const raised = await submit(types.record, organization, { topic: 'reading-limit', amountCount: 2 }, at(-30));
    expect((await evaluated(flightId, 3))[0]).toMatchObject({ outcome: 'attention', trigger: { eventId: raised } });
    expect((await evaluated(other, 2))[0]).toMatchObject({ outcome: 'pass', trigger: { eventId: raised } });
    expect(await workFor(raised)).toBe(2);
  });

  it('queues nothing for a record the rule’s conditions leave out', async () => {
    const flightId = await flight();
    await submit(types.reading, flightSubject(flightId), { topic: 'reading', amountCount: 1 }, at(-40));
    await evaluated(flightId, 1);
    const note = await submit(types.reading, flightSubject(flightId), { topic: 'other', amountCount: 50 }, at(-10));
    await settle();
    expect(await workFor(note)).toBe(0);
    const unrelated = await submit(types.record, organization, { topic: 'other', amountCount: 99 }, at(-20));
    await settle();
    expect(await workFor(unrelated)).toBe(0);
    await evaluated(flightId, 1);
    // Withdrawing it queues nothing either: the rule never read it.
    const withdrawn = await call(sourcePrincipal, 'POST', '/v1/commands', {
      kind: 'observation.withdraw',
      observationId: unrelated,
      reason: 'The fictional record was entered twice.',
    });
    expect(withdrawn.statusCode, withdrawn.body).toBe(201);
    await settle();
    expect(await workFor(withdrawn.json().command.id as string)).toBe(0);
  });

  it('evaluates again when a withdrawal returns the rule to inputs it read before', async () => {
    const flightId = await flight();
    const earlier = await submit(types.reading, flightSubject(flightId), { topic: 'reading', amountCount: 1 }, at(-40));
    const [first] = await evaluated(flightId, 1);
    expect(first).toMatchObject({ outcome: 'pass' });
    const later = await submit(types.reading, flightSubject(flightId), { topic: 'reading', amountCount: 9 }, at(-35));
    const [second] = await evaluated(flightId, 2);
    expect(second).toMatchObject({ outcome: 'attention' });
    expect(second!.inputs.find((input) => input.name === 'quantity')!.observationIds).toEqual([later]);

    const withdrawn = await call(sourcePrincipal, 'POST', '/v1/commands', {
      kind: 'observation.withdraw',
      observationId: later,
      reason: 'The fictional reading belonged to another flight.',
    });
    expect(withdrawn.statusCode, withdrawn.body).toBe(201);
    const [latest] = await evaluated(flightId, 3);
    expect(latest).toMatchObject({
      outcome: 'pass',
      trigger: { kind: 'correction', eventId: withdrawn.json().command.id },
      observationDigest: first!.observationDigest,
    });
    expect(latest!.inputs.find((input) => input.name === 'quantity')!.observationIds).toEqual([earlier]);
    expect(latest!.inputDigest).not.toBe(first!.inputDigest);
  });

  it('queues a state reader when the leaf version in effect has not read the flight’s current state', async () => {
    const now = Date.now();
    const switchAt = now + 6_000;
    await adopt(statePack(1), { start: new Date(now - 60_000).toISOString(), end: new Date(switchAt).toISOString() });
    await adopt(statePack(2), {
      start: new Date(switchAt).toISOString(),
      end: new Date(now + 3_600_000).toISOString(),
    });
    const leafId = stateRule(1).id;
    const flightId = await flight();
    await evaluated(flightId, 1, leafId);
    const landingTime = new Date(Date.now() - 60_000).toISOString();
    const landed = await call(actor, 'POST', '/v1/inputs', {
      sourceId,
      kind: 'flight.observation',
      occurredAt: landingTime,
      subject: { flightId },
      payload: { activity: 'landed', landingTime },
    });
    expect(landed.statusCode, landed.body).toBe(201);
    const [underFirst] = await evaluated(flightId, 2, leafId);
    expect(underFirst).toMatchObject({ rule: { version: 1 }, subjectState: { state: { status: 'landed' } } });

    await new Promise((resolve) => setTimeout(resolve, Math.max(0, switchAt - Date.now()) + 300));
    // The state is as version 1 last read it, but version 2 has not read it.
    const unchanged = await call(actor, 'POST', '/v1/inputs', {
      sourceId,
      kind: 'flight.observation',
      occurredAt: new Date(Date.now() - 30_000).toISOString(),
      subject: { flightId },
      payload: { activity: 'landed', title: 'Post-flight note' },
    });
    expect(unchanged.statusCode, unchanged.body).toBe(201);
    const [underSecond] = await evaluated(flightId, 3, leafId);
    expect(underSecond).toMatchObject({
      rule: { version: 2 },
      trigger: { kind: 'state', eventId: unchanged.json().receipt.eventId },
      subjectState: { revision: underFirst!.subjectState!.revision },
    });

    // Once version 2 has read the state, an event that leaves it as it was queues nothing.
    const again = await call(actor, 'POST', '/v1/inputs', {
      sourceId,
      kind: 'flight.observation',
      occurredAt: new Date(Date.now() - 20_000).toISOString(),
      subject: { flightId },
      payload: { activity: 'landed', title: 'Second post-flight note' },
    });
    expect(again.statusCode, again.body).toBe(201);
    await settle();
    expect(await workFor(again.json().receipt.eventId as string)).toBe(0);
    await evaluated(flightId, 3, leafId);
  });

  function at(minutes: number): string {
    return new Date(Date.now() + minutes * 60_000).toISOString();
  }
});
