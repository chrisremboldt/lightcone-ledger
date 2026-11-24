import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import type {
  AcceptedObservation,
  OrganizationCoverageResponse,
  RuleEvaluationRecord,
  RulePackVersion,
} from '../../packages/contracts/src/index.js';
import { adoptShownPack } from '../../packages/contracts/fixtures/demo/v1/ready.js';
import {
  defineCheckedRule,
  findCheckKind,
  listObservations,
  registerObservationTypes,
  registerRulePack,
} from '../../packages/domain/src/index.js';
import { canonicalDigest, sha256 } from '../../packages/integrity/src/index.js';
import { createPool, MemoryObjectStore, withScope, type AuthContext } from '../../packages/persistence/src/index.js';
import { rotorIcingObservation, rotorIcingType } from '../unit/rotor-icing-observation.js';
import { runOwnedWork, settleOwnedWork } from './worker-queue.js';

// The observation type, the rule and its pack exist only in this test. Nothing in intake, the corrections, the
// evaluator or the reads names them.
describe.runIf(process.env.LEDGER_ENV !== 'staging')('Observation corrections on PostgreSQL', () => {
  const prefix = `correction-${randomUUID()}`;
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const workerPool = createPool(process.env.WORKER_DATABASE_URL);
  const sourceId = `${prefix}-sensor`;
  const otherSourceId = `${prefix}-logbook`;
  const type = 'rotor.icing-report';
  let app: Awaited<ReturnType<typeof createApp>>;

  const rule = defineCheckedRule({
    id: 'test.icing-report-above-freezing',
    version: 1,
    title: 'Reported outside air stays above freezing',
    source: { kind: 'operator_procedure', reference: 'Fictional procedure 7.1', text: 'Report air above freezing.' },
    target: { subjectKind: 'flight' },
    reads: [{ name: 'subject', type, versions: [1], about: 'target', required: true, select: 'latest' }],
    check: {
      kind: findCheckKind('value.within-limit', 1)!,
      params: { field: 'values.outsideAirTemperatureCelsius', comparison: 'above', limit: 0 },
    },
  });
  const packContent = {
    packId: `${prefix}.pack`,
    version: 1,
    title: 'Fictional icing reports',
    status: 'draft' as const,
    review: 'ai_drafted' as const,
    adopted: false as const,
    bindings: [],
    leaves: [rule],
  };
  const testPack: RulePackVersion = { ...packContent, digest: canonicalDigest(packContent) };

  interface Tenant {
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
      observationGrants: [sourceId, otherSourceId].map((id) => ({ sourceId: id, observationType: type })),
    });
    expect(granted.statusCode, granted.body).toBe(201);
    return { actor, worker, source, artifactId: await upload(source) };
  }

  async function upload(principal: AuthContext): Promise<string> {
    const bytes = Buffer.from(JSON.stringify({ entered: 'fictional icing report' }));
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

  function submission(t: Tenant, values: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const { replaces, source, ...overrides } = extra;
    const observation = rotorIcingObservation(
      { values: { severity: 'light', ...values }, ...overrides, originalArtifactId: t.artifactId },
      type,
    );
    return {
      sourceId: source ?? sourceId,
      kind: 'observation',
      occurredAt: observation.occurredAt,
      payload: observation,
      ...(replaces ? { replaces } : {}),
    };
  }
  async function submit(t: Tenant, values: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const response = await call(t.source, 'POST', '/v1/inputs', submission(t, values, extra));
    expect(response.statusCode, response.body).toBe(201);
    return response.json().receipt.eventId as string;
  }
  async function command(t: Tenant, body: Record<string, unknown>) {
    return call(t.source, 'POST', '/v1/commands', body);
  }
  async function flight(t: Tenant): Promise<string> {
    const created = await call(t.actor, 'POST', '/v1/flights', { originationKey: `${prefix}-${randomUUID()}` });
    expect(created.statusCode, created.body).toBe(201);
    return created.json().flight.id as string;
  }
  async function evaluations(t: Tenant, flightId: string): Promise<RuleEvaluationRecord[]> {
    const response = await call(t.actor, 'GET', `/v1/evaluations?subjectKind=flight&subjectId=${flightId}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json().evaluations;
  }
  async function evaluated(t: Tenant, flightId: string, count: number): Promise<RuleEvaluationRecord[]> {
    await settle(async () => (await evaluations(t, flightId)).length >= count);
    const found = await evaluations(t, flightId);
    expect(found).toHaveLength(count);
    return found;
  }
  async function read(
    t: Tenant,
    flightId: string,
    cut?: Record<string, number>,
    include?: 'all',
  ): Promise<AcceptedObservation[]> {
    const page = await withScope(workerPool, t.worker, (client, principal) =>
      listObservations(
        client,
        principal,
        {
          subjectKind: 'flight',
          subjectId: flightId,
          type,
          from: '2026-01-01T00:00:00.000Z',
          to: '2027-01-01T00:00:00.000Z',
          ...(include ? { include } : {}),
        },
        cut ? { evidenceCut: cut } : {},
      ),
    );
    return page.observations;
  }
  const ids = (observations: AcceptedObservation[]) => observations.map((item) => item.id);
  const inputIds = (evaluation: RuleEvaluationRecord) => evaluation.inputs[0]!.observationIds;

  beforeAll(async () => {
    registerObservationTypes(rotorIcingType(type));
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
    const adopted = await call(
      tenants.a.actor,
      'POST',
      '/v1/commands',
      adoptShownPack(
        shown.json() as OrganizationCoverageResponse,
        retained.json().pack,
        { start: new Date(now - 60_000).toISOString(), end: new Date(now + 3_600_000).toISOString() },
        'Adopt the fictional icing report rule.',
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

  it('evaluates again after a replacement and a withdrawal, while a read at an earlier cut sees the original', async () => {
    const a = tenants.a;
    const flightId = await flight(a);
    const subject = { kind: 'flight', id: flightId, scope: 'ledger' };
    const original = await submit(a, { outsideAirTemperatureCelsius: -4 }, { subject, sourceEventId: 'r-1' });
    const [first] = await evaluated(a, flightId, 1);
    expect(first).toMatchObject({ outcome: 'attention', trigger: { eventId: original } });
    expect(inputIds(first!)).toEqual([original]);

    // A replacement must come from the same source.
    const elsewhere = await call(
      a.source,
      'POST',
      '/v1/inputs',
      submission(a, { outsideAirTemperatureCelsius: 3 }, { subject, replaces: original, source: otherSourceId }),
    );
    expect(elsewhere.statusCode, elsewhere.body).toBe(409);
    expect(elsewhere.json().error.code).toBe('replacement_source_mismatch');
    // The replacement has an earlier time, so only a read that leaves the replaced one out sees it as latest.
    const replacement = await submit(
      a,
      { outsideAirTemperatureCelsius: 3 },
      {
        subject,
        sourceEventId: 'r-2',
        replaces: original,
        occurredAt: '2026-11-02T09:15:00.000Z',
        interval: { start: '2026-11-02T09:00:00.000Z' },
      },
    );
    const [second] = await evaluated(a, flightId, 2);
    expect(second).toMatchObject({ outcome: 'pass', trigger: { eventId: replacement } });
    expect(inputIds(second!)).toEqual([replacement]);

    // Replayed at the first evaluation's cut, the read still returns the original and nothing replaced it.
    const atFirst = await read(a, flightId, first!.inputCut.streams);
    expect(ids(atFirst)).toEqual([original]);
    expect(atFirst[0]).not.toHaveProperty('replacedBy');
    expect(ids(await read(a, flightId, second!.inputCut.streams))).toEqual([replacement]);
    const everything = await read(a, flightId, undefined, 'all');
    expect(everything.find((item) => item.id === original)).toMatchObject({ replacedBy: replacement });
    expect(everything.find((item) => item.id === replacement)).toMatchObject({ replaces: original });

    const again = await call(
      a.source,
      'POST',
      '/v1/inputs',
      submission(a, { outsideAirTemperatureCelsius: 5 }, { subject, sourceEventId: 'r-3', replaces: original }),
    );
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json().error.code).toBe('observation_replaced');
    const withdrawReplaced = await command(a, { kind: 'observation.withdraw', observationId: original, reason: 'x' });
    expect(withdrawReplaced.statusCode, withdrawReplaced.body).toBe(409);

    const withdrawn = await command(a, {
      kind: 'observation.withdraw',
      observationId: replacement,
      reason: 'The report was entered for the wrong flight.',
    });
    expect(withdrawn.statusCode, withdrawn.body).toBe(201);
    const [third] = await evaluated(a, flightId, 3);
    expect(third).toMatchObject({ evidenceState: 'insufficient', trigger: { eventId: withdrawn.json().command.id } });
    expect(inputIds(third!)).toEqual([]);
    expect(ids(await read(a, flightId, second!.inputCut.streams))).toEqual([replacement]);
    const [kept] = (await read(a, flightId, undefined, 'all')).filter((item) => item.id === replacement);
    expect(kept!.withdrawal).toMatchObject({
      reason: 'The report was entered for the wrong flight.',
      recordedBy: a.source.id,
    });
  });

  it('attaches an unresolved observation to a subject, then moves it, evaluating both subjects', async () => {
    const a = tenants.a;
    const [first, second] = [await flight(a), await flight(a)];
    const unresolved = await submit(
      a,
      { outsideAirTemperatureCelsius: -6 },
      { subject: { kind: 'flight', id: 'trip-77', scope: 'source' }, sourceEventId: 'u-1' },
    );
    await settle();
    expect(await read(a, first)).toEqual([]);

    const attached = await command(a, {
      kind: 'observation.resolve-subject',
      observationId: unresolved,
      ledgerSubjectId: first,
      reason: 'Trip 77 is this flight in the dispatch log.',
    });
    expect(attached.statusCode, attached.body).toBe(201);
    const [onFirst] = await evaluated(a, first, 1);
    expect(onFirst).toMatchObject({ outcome: 'attention', trigger: { eventId: attached.json().command.id } });
    expect(inputIds(onFirst!)).toEqual([unresolved]);
    expect((await read(a, first))[0]!.subject).toMatchObject({
      ledgerId: first,
      resolution: 'record',
      resolutionId: attached.json().command.id,
    });

    const moved = await command(a, {
      kind: 'observation.resolve-subject',
      observationId: unresolved,
      ledgerSubjectId: second,
      reason: 'Trip 77 was the second sortie.',
    });
    expect(moved.statusCode, moved.body).toBe(201);
    const [leftFirst] = await evaluated(a, first, 2);
    expect(inputIds(leftFirst!)).toEqual([]);
    const [onSecond] = await evaluated(a, second, 1);
    expect(inputIds(onSecond!)).toEqual([unresolved]);
    expect(ids(await read(a, first))).toEqual([]);
    expect(ids(await read(a, second))).toEqual([unresolved]);
    // The earlier resolution is still what a read at the earlier cut sees.
    expect(ids(await read(a, first, onFirst!.inputCut.streams))).toEqual([unresolved]);

    const unchanged = await command(a, {
      kind: 'observation.resolve-subject',
      observationId: unresolved,
      ledgerSubjectId: second,
      reason: 'Again.',
    });
    expect(unchanged.statusCode, unchanged.body).toBe(409);
    expect(unchanged.json().error.code).toBe('subject_unchanged');
  });

  it('attaches earlier unresolved observations through a new alias, and later ones resolve at intake', async () => {
    const a = tenants.a;
    const flightId = await flight(a);
    const subject = { kind: 'flight', id: 'trip-88', scope: 'source' };
    const earlier = await submit(a, { outsideAirTemperatureCelsius: 2 }, { subject, sourceEventId: 'a-1' });
    await settle();
    const aliased = await command(a, {
      kind: 'subject.alias',
      sourceId,
      subjectKind: 'flight',
      externalId: 'trip-88',
      ledgerSubjectId: flightId,
      reason: 'Trip 88 is this flight.',
    });
    expect(aliased.statusCode, aliased.body).toBe(201);
    const [attached] = await evaluated(a, flightId, 1);
    expect(inputIds(attached!)).toEqual([earlier]);

    const later = await submit(
      a,
      { outsideAirTemperatureCelsius: -1 },
      {
        subject,
        sourceEventId: 'a-2',
        occurredAt: '2026-11-02T12:15:00.000Z',
        interval: { start: '2026-11-02T12:00:00.000Z' },
      },
    );
    const [, latest] = (await evaluated(a, flightId, 2)).reverse();
    expect(inputIds(latest!)).toEqual([later]);
    expect((await read(a, flightId)).find((item) => item.id === later)!.subject).toMatchObject({
      ledgerId: flightId,
      resolution: 'alias',
    });
    const duplicate = await command(a, {
      kind: 'subject.alias',
      sourceId,
      subjectKind: 'flight',
      externalId: 'trip-88',
      ledgerSubjectId: await flight(a),
      reason: 'Another flight.',
    });
    expect(duplicate.statusCode, duplicate.body).toBe(409);
    expect(duplicate.json().error.code).toBe('alias_exists');
  });

  it('keeps all three records inside their tenant and to principals granted the observation', async () => {
    const [a, b] = [tenants.a, tenants.b];
    const flightId = await flight(a);
    const observationId = await submit(
      a,
      { outsideAirTemperatureCelsius: 1 },
      { subject: { kind: 'flight', id: 'trip-99', scope: 'source' }, sourceEventId: 't-1' },
    );
    const own = await submit(
      b,
      { outsideAirTemperatureCelsius: 1 },
      { subject: { kind: 'flight', id: 'trip-99', scope: 'source' }, sourceEventId: 't-1' },
    );
    await settle();
    const foreignReplacement = await call(
      b.source,
      'POST',
      '/v1/inputs',
      submission(b, { outsideAirTemperatureCelsius: 4 }, { sourceEventId: 't-2', replaces: observationId }),
    );
    expect(foreignReplacement.statusCode, foreignReplacement.body).toBe(404);
    for (const body of [
      { kind: 'observation.withdraw', observationId, reason: 'Not ours.' },
      { kind: 'observation.resolve-subject', observationId, ledgerSubjectId: flightId, reason: 'Not ours.' },
    ]) {
      const refused = await command(b, body);
      expect(refused.statusCode, refused.body).toBe(404);
      expect(refused.json().error.code).toBe('observation_not_found');
    }
    for (const body of [
      { kind: 'observation.resolve-subject', observationId: own, ledgerSubjectId: flightId, reason: 'Not ours.' },
      {
        kind: 'subject.alias',
        sourceId,
        subjectKind: 'flight',
        externalId: 'trip-99',
        ledgerSubjectId: flightId,
        reason: 'Not ours.',
      },
    ]) {
      const refused = await command(b, body);
      expect(refused.statusCode, refused.body).toBe(404);
      expect(refused.json().error.code).toBe('subject_not_found');
    }
    // Withdrawing needs the grant that submitting the observation needs.
    const ungranted = await call(a.actor, 'POST', '/v1/commands', {
      kind: 'observation.withdraw',
      observationId,
      reason: 'No grant.',
    });
    expect(ungranted.statusCode, ungranted.body).toBe(403);
    expect(ungranted.json().error.code).toBe('observation_grant_required');
    const rows = await withScope(workerPool, b.worker, async (client) => ({
      withdrawals: (await client.query('SELECT id FROM observation_withdrawals')).rowCount,
      resolutions: (await client.query('SELECT id FROM observation_subject_resolutions')).rowCount,
      replacements: (await client.query('SELECT id FROM observations WHERE replaces_observation_id IS NOT NULL'))
        .rowCount,
    }));
    expect(rows).toEqual({ withdrawals: 0, resolutions: 0, replacements: 0 });
    expect(ids(await read(b, flightId))).toEqual([]);
  });
});
