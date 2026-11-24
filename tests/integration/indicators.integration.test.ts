import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import type {
  OrganizationCoverageResponse,
  RulePackVersion,
  SubjectFindingRecord,
  SubjectReference,
} from '../../packages/contracts/src/index.js';
import { adoptShownPack } from '../../packages/contracts/fixtures/demo/v1/ready.js';
import {
  calculateIndicator,
  defineCheckedRule,
  defineIndicator,
  findCheckKind,
  gatherIndicatorInputs,
  registerIndicatorDefinition,
  registerObservationTypes,
  registerRulePack,
  type IndicatorDefinitionSpec,
  type IndicatorGatherRequest,
} from '../../packages/domain/src/index.js';
import { canonicalDigest, sha256 } from '../../packages/integrity/src/index.js';
import { createPool, MemoryObjectStore, withScope, type AuthContext } from '../../packages/persistence/src/index.js';
import { rotorIcingObservation, rotorIcingType } from '../unit/rotor-icing-observation.js';
import { databaseNow, runOwnedWork, settleOwnedWork } from './worker-queue.js';

// Everything problem-specific lives in this test: the observation type, the rule, its pack and both indicator
// definitions. Gathering and calculation read stored observations and generic findings through the ordinary reads.
describe.runIf(process.env.LEDGER_ENV !== 'staging')('Indicators over stored evidence on PostgreSQL', () => {
  const prefix = `indicator-${randomUUID()}`;
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const workerPool = createPool(process.env.WORKER_DATABASE_URL);
  const sourceId = `${prefix}-log`;
  const icingType = 'rotor.icing-indicator';
  let app: Awaited<ReturnType<typeof createApp>>;

  const icingRule = defineCheckedRule({
    id: 'test.indicator-icing-floor',
    version: 1,
    title: 'Outside air stays above the icing floor',
    source: { kind: 'operator_procedure', reference: 'Fictional procedure 7.1', text: 'Stop at or below the floor.' },
    target: { subjectKind: 'aircraft' },
    reads: [{ name: 'subject', type: icingType, versions: [1], about: 'target', required: true, select: 'latest' }],
    check: {
      kind: findCheckKind('value.within-limit', 1)!,
      params: { field: 'values.outsideAirTemperatureCelsius', comparison: 'above', limit: 0 },
    },
  });
  // Severe icing opens an episode on the aircraft and light icing closes it; every episode is reviewed.
  const episodeRule = defineCheckedRule({
    id: 'test.indicator-icing-episode',
    version: 1,
    title: 'Severe icing episodes are reviewed',
    source: { kind: 'operator_procedure', reference: 'Fictional procedure 7.2', text: 'Review each severe icing.' },
    target: { subjectKind: 'aircraft' },
    reads: [{ name: 'transitions', type: icingType, versions: [1], about: 'target', required: false, select: 'all' }],
    check: {
      kind: findCheckKind('episode.open', 1)!,
      params: {
        scopeFields: ['subject.id'],
        stateField: 'values.severity',
        opening: ['severe'],
        closing: ['light'],
        attention: 'any',
      },
    },
  });
  const packContent = {
    packId: `${prefix}.pack`,
    version: 1,
    title: 'Fictional icing procedures',
    status: 'draft' as const,
    review: 'ai_drafted' as const,
    adopted: false as const,
    bindings: [],
    leaves: [icingRule, episodeRule],
  };
  const testPack: RulePackVersion = { ...packContent, digest: canonicalDigest(packContent) };
  const tail = (id: string): SubjectReference => ({ scope: 'source', kind: 'aircraft', id, sourceId });
  const findingRate = defineIndicator({
    id: 'test.icing-findings-per-flight-hour',
    version: 1,
    title: 'Icing-floor findings per flight hour',
    description: 'Findings the fictional icing-floor rule opened, per reported flight hour.',
    scope: { kind: 'subject_kind', subjectKind: 'aircraft' },
    events: { kind: 'findings', packId: testPack.packId, ruleId: icingRule.id },
    exposure: { kind: 'exposure.flight-hours', version: 1, params: {} },
    window: { maxMilliseconds: 24 * 60 * 60 * 1000 },
    completeness: { exposureMustExceed: '0', populationDeclaredComplete: true, coverageWithoutGaps: true },
    unit: { per: 1, label: 'per flight hour', fractionDigits: 3 },
  });
  const readingRate = defineIndicator({
    id: 'test.cold-readings-per-flight',
    version: 1,
    title: 'Readings below freezing per flight',
    description: 'Icing readings below zero Celsius, per reported flight, for two listed aircraft.',
    scope: { kind: 'subjects', subjects: [tail('tail-1'), tail('tail-2')] },
    events: {
      kind: 'observations',
      type: icingType,
      versions: [1],
      condition: { field: 'values.outsideAirTemperatureCelsius', operator: 'below', value: 0 },
    },
    exposure: { kind: 'exposure.flights', version: 1, params: {} },
    window: { maxMilliseconds: 24 * 60 * 60 * 1000 },
    completeness: { exposureMustExceed: '0', populationDeclaredComplete: true, coverageWithoutGaps: true },
    unit: { per: 1, label: 'per flight', fractionDigits: 2 },
  });

  const issueSpec: IndicatorDefinitionSpec = {
    id: 'test.icing-episodes-per-flight-hour',
    version: 1,
    title: 'Severe icing episodes per flight hour',
    description: 'Episodes the fictional icing-episode rule named, per reported flight hour.',
    scope: { kind: 'subject_kind', subjectKind: 'aircraft' },
    events: { kind: 'issues', packId: testPack.packId, ruleId: episodeRule.id },
    exposure: { kind: 'exposure.flight-hours', version: 1, params: {} },
    window: { maxMilliseconds: 24 * 60 * 60 * 1000 },
    completeness: { exposureMustExceed: '0', populationDeclaredComplete: true, coverageWithoutGaps: true },
    unit: { per: 1, label: 'per flight hour', fractionDigits: 3 },
  };
  const issueRate = defineIndicator(issueSpec);
  const coveredRate = defineIndicator({
    ...issueSpec,
    id: 'test.icing-episodes-per-reported-hour',
    title: 'Severe icing episodes per flight hour with icing reports',
    description: 'Episodes per flight hour during which icing reports were received for the flight.',
    exposure: {
      kind: 'exposure.covered-flight-hours',
      version: 1,
      params: { type: icingType, versions: [1], maxSilenceMilliseconds: 10 * 60_000 },
    },
  });

  interface Tenant {
    actor: AuthContext;
    source: AuthContext;
    artifactId: string;
  }
  const tenants: Record<'a' | 'b', Tenant> = {} as Record<'a' | 'b', Tenant>;
  const start = new Date(Math.floor(Date.now() / 1000) * 1000 - 2 * 3_600_000);
  const at = (minutes: number) => new Date(start.getTime() + minutes * 60_000).toISOString();
  let end: string;

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
      capabilities: ['flight:read', 'evidence:read', 'authority:write', 'pack:adopt', 'input:write'],
    };
    const source: AuthContext = {
      ...base,
      id: `${tenantId}:source`,
      kind: 'source',
      capabilities: ['input:write', 'flight:read', 'evidence:read'],
    };
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, `Fictional ${name}`]);
    // The worker principal is the identity the worker projects this tenant's work as.
    const worker: AuthContext = {
      ...base,
      id: `${tenantId}:worker`,
      kind: 'worker',
      capabilities: ['flight:read', 'evidence:read', 'input:write'],
    };
    for (const principal of [actor, source, worker]) {
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
      observationGrants: [icingType, 'flight.report'].map((observationType) => ({ sourceId, observationType })),
    });
    expect(granted.statusCode, granted.body).toBe(201);
    return { actor, source, artifactId: await upload(source) };
  }

  async function upload(principal: AuthContext): Promise<string> {
    const bytes = Buffer.from(JSON.stringify({ entered: 'fictional flight log' }));
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

  async function settle(): Promise<void> {
    for (let attempt = 0; attempt < 60; attempt++) {
      const completed = await runOwnedWork(admin, workerPool, [prefix]);
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
  }

  function reading(tailId: string, minutes: number, celsius: number, severity = 'light', flightId?: string) {
    return rotorIcingObservation(
      {
        subject: { kind: 'aircraft', id: tailId, scope: 'source' },
        ...(flightId ? { secondarySubject: { kind: 'flight', id: flightId, scope: 'source' } } : {}),
        sourceEventId: `${tailId}-reading-${minutes}`,
        occurredAt: at(minutes),
        interval: { start: at(minutes) },
        values: { severity, outsideAirTemperatureCelsius: celsius },
      },
      icingType,
    );
  }

  function flightReport(tailId: string, flightId: string, takeoff: number, landing?: number) {
    return {
      type: 'flight.report',
      version: 1,
      subject: { kind: 'flight', id: flightId, scope: 'source' },
      secondarySubject: { kind: 'aircraft', id: tailId, scope: 'source' },
      sourceEventId: `${flightId}-report`,
      occurredAt: at(landing ?? takeoff),
      fidelity: 'synthetic_contract',
      limitations: ['Synthetic test data.'],
      values: {
        activity: landing === undefined ? 'active' : 'landed',
        takeoffAt: at(takeoff),
        ...(landing === undefined ? {} : { landingAt: at(landing) }),
      },
    };
  }

  async function findings(principal: AuthContext, tailId: string): Promise<SubjectFindingRecord[]> {
    const query = new URLSearchParams({ subjectKind: 'aircraft', subjectId: tailId, subjectScope: 'source', sourceId });
    const response = await call(principal, 'GET', `/v1/findings?${query}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json().findings;
  }

  function gather(t: Tenant, request: Omit<IndicatorGatherRequest, 'window' | 'recordedThrough'>) {
    return withScope(pool, t.actor, (client, principal) =>
      gatherIndicatorInputs(client, principal, {
        window: { start: start.toISOString(), end },
        recordedThrough: end,
        ...request,
      }),
    );
  }

  const population = (t: Tenant, ids: string[]) => ({
    subjects: ids.map(tail),
    complete: true,
    declaredBy: { kind: 'person' as const, id: t.actor.id },
  });

  beforeAll(async () => {
    registerObservationTypes(rotorIcingType(icingType));
    registerRulePack({ packId: testPack.packId, versions: [testPack] });
    registerIndicatorDefinition(findingRate);
    registerIndicatorDefinition(readingRate);
    registerIndicatorDefinition(issueRate);
    registerIndicatorDefinition(coveredRate);
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
    const adopted = await call(
      tenants.a.actor,
      'POST',
      '/v1/commands',
      adoptShownPack(
        shown.json() as OrganizationCoverageResponse,
        retained.json().pack,
        { start: new Date(Date.now() - 60_000).toISOString(), end: new Date(Date.now() + 3_600_000).toISOString() },
        'Adopt the fictional icing procedures.',
        'active',
      ),
    );
    expect(adopted.statusCode, adopted.body).toBe(201);
    await settle();

    // Tenant a: two aircraft breach the floor and open findings, one stays above it; two flight hours in all.
    const a = tenants.a;
    await submit(a, reading('tail-1', 15, -3));
    await submit(a, reading('tail-2', 45, -6));
    await submit(a, reading('tail-3', 75, 4));
    await settle();
    // tail-1 then reports a severe icing episode during flight-1, closed five minutes later.
    await submit(a, reading('tail-1', 20, 2, 'severe', 'flight-1'));
    await submit(a, reading('tail-1', 25, 2, 'light', 'flight-1'));
    await submit(a, flightReport('tail-1', 'flight-1', 10, 40));
    await submit(a, flightReport('tail-2', 'flight-2', 40, 70));
    await submit(a, flightReport('tail-3', 'flight-3', 60, 120));
    // tail-4 took off with no reported landing.
    await submit(a, flightReport('tail-4', 'flight-4', 90));
    // Tenant b: the same source identities, its own single flight hour, no adopted rule and so no findings.
    await submit(tenants.b, reading('tail-1', 15, -3));
    await submit(tenants.b, flightReport('tail-1', 'flight-1', 10, 70));
    await settle();
    const icingFindings = async (tailId: string) =>
      (await findings(a.actor, tailId)).filter((finding) => finding.ruleId === icingRule.id);
    expect(await icingFindings('tail-1')).toHaveLength(1);
    expect(await icingFindings('tail-2')).toHaveLength(1);
    // The window and its cut end at the database's clock now, after every finding above was recorded by that clock.
    end = await databaseNow(admin);
  });
  afterAll(async () => {
    await settleOwnedWork([prefix]);
    if (app) await app.close();
    await pool.end();
    await admin.end();
    await workerPool.end();
  });

  it('gathers generic findings and flight reports and calculates findings per flight hour for a control', async () => {
    const a = tenants.a;
    const gathered = await gather(a, {
      definition: { id: findingRate.id, version: 1 },
      control: { id: 'fictional-heater-control', version: 1 },
      population: population(a, ['tail-1', 'tail-2', 'tail-3']),
    });
    expect(gathered.outcome).toBe('complete');
    expect(gathered.input.events.map((event) => event.kind)).toEqual(['finding', 'finding']);
    const result = calculateIndicator(gathered.definition, gathered.input);
    expect(result).toMatchObject({
      status: 'supported',
      eventCount: 2,
      exposure: { value: { numerator: '2', denominator: '1' }, decimal: '2.000', unit: 'flight_hour', gaps: [] },
      rate: { value: { numerator: '1', denominator: '1' }, decimal: '1.000', label: 'per flight hour' },
      control: { id: 'fictional-heater-control', version: 1 },
      definition: { id: findingRate.id, version: 1, digest: findingRate.digest },
      reasons: [],
    });
    expect(result.counted.exposure).toHaveLength(3);
    // Gathering again at the same cut gives the same input digest.
    const again = await gather(a, {
      definition: { id: findingRate.id, version: 1 },
      control: { id: 'fictional-heater-control', version: 1 },
      population: population(a, ['tail-3', 'tail-2', 'tail-1']),
    });
    expect(calculateIndicator(again.definition, again.input).inputDigest).toBe(result.inputDigest);
  });

  it('is insufficient when a subject in the population has a flight with no reported landing', async () => {
    const a = tenants.a;
    const gathered = await gather(a, {
      definition: { id: findingRate.id, version: 1 },
      population: population(a, ['tail-1', 'tail-2', 'tail-3', 'tail-4']),
    });
    const result = calculateIndicator(gathered.definition, gathered.input);
    expect(result).toMatchObject({ status: 'insufficient', rate: null, reasons: ['exposure_coverage_gaps'] });
    expect(result.exposure.gaps).toMatchObject([{ code: 'landing_unreported' }]);
  });

  it('counts observations meeting a condition for subjects the definition lists', async () => {
    const gathered = await gather(tenants.a, { definition: { id: readingRate.id, version: 1 } });
    expect(gathered.input.population).toMatchObject({
      complete: true,
      declaredBy: { kind: 'definition', id: `${readingRate.id}@1` },
    });
    const result = calculateIndicator(gathered.definition, gathered.input);
    expect(result).toMatchObject({
      status: 'supported',
      eventCount: 2,
      exposure: { decimal: '2.00', unit: 'flight', coverage: 'checked' },
      rate: { decimal: '1.00' },
    });
  });

  it('reports an incomplete selection when a read bound is reached', async () => {
    const a = tenants.a;
    const gathered = await gather(a, {
      definition: { id: findingRate.id, version: 1 },
      population: population(a, ['tail-1', 'tail-2', 'tail-3']),
      limits: { maxExposureObservations: 2 },
    });
    expect(gathered.outcome).toBe('incomplete_selection');
    expect(gathered.input.selection).toEqual({ complete: false, exceeded: ['exposure'], pending: false });
    expect(calculateIndicator(gathered.definition, gathered.input)).toMatchObject({
      status: 'insufficient',
      rate: null,
      reasons: expect.arrayContaining(['selection_incomplete']),
    });
  });

  it('requires a declared population for an indicator scoped by subject kind', async () => {
    await expect(gather(tenants.a, { definition: { id: findingRate.id, version: 1 } })).rejects.toMatchObject({
      code: 'indicator_population_required',
    });
  });

  it('reads only the caller’s tenant', async () => {
    const b = tenants.b;
    const gathered = await gather(b, {
      definition: { id: findingRate.id, version: 1 },
      population: population(b, ['tail-1', 'tail-2', 'tail-3']),
    });
    expect(gathered.input.events).toEqual([]);
    const result = calculateIndicator(gathered.definition, gathered.input);
    expect(result).toMatchObject({
      status: 'supported',
      eventCount: 0,
      exposure: { decimal: '1.000' },
      rate: { decimal: '0.000' },
    });
    const own = gathered.input.exposure.map((observation) => observation.id);
    const foreign = (
      await gather(tenants.a, {
        definition: { id: findingRate.id, version: 1 },
        population: population(tenants.a, ['tail-1']),
      })
    ).input.exposure.map((observation) => observation.id);
    expect(own.filter((id) => foreign.includes(id))).toEqual([]);
  });

  it('counts each issue a rule named once, after the episode closed, from the rule’s evaluations', async () => {
    const a = tenants.a;
    const gathered = await gather(a, {
      definition: { id: issueRate.id, version: 1 },
      population: population(a, ['tail-1', 'tail-2', 'tail-3']),
    });
    expect(gathered.outcome).toBe('complete');
    expect(gathered.input.events).toMatchObject([{ kind: 'issue', subject: tail('tail-1'), conflicting: false }]);
    const result = calculateIndicator(gathered.definition, gathered.input);
    expect(result).toMatchObject({ status: 'supported', eventCount: 1, rate: { decimal: '0.500' }, reasons: [] });
    // The evaluations recorded after the cut are not read.
    const early = await withScope(pool, a.actor, (client, principal) =>
      gatherIndicatorInputs(client, principal, {
        definition: { id: issueRate.id, version: 1 },
        window: { start: start.toISOString(), end },
        recordedThrough: start.toISOString(),
        population: population(a, ['tail-1']),
      }),
    );
    expect(early.input.events).toEqual([]);
    const bounded = await gather(a, {
      definition: { id: issueRate.id, version: 1 },
      population: population(a, ['tail-1']),
      limits: { maxEvaluations: 0 },
    });
    expect(bounded.input.selection).toEqual({ complete: false, exceeded: ['evaluations'], pending: false });
  });

  it('measures flight time while observations of a declared type were received, with the rest as a gap', async () => {
    const a = tenants.a;
    const gathered = await gather(a, {
      definition: { id: coveredRate.id, version: 1 },
      population: population(a, ['tail-1']),
    });
    const result = calculateIndicator(gathered.definition, gathered.input);
    // Icing reports for flight-1 at minutes 20 and 25 cover five of its thirty airborne minutes.
    expect(result).toMatchObject({
      status: 'insufficient',
      eventCount: 1,
      exposure: { value: { numerator: '1', denominator: '12' }, unit: 'flight_hour' },
      rate: null,
      reasons: ['exposure_coverage_gaps'],
    });
    expect(result.exposure.gaps).toMatchObject([{ code: 'coverage_not_received' }]);
  });

  it('is insufficient while evaluations are due for the population, and clears once the worker has run', async () => {
    const a = tenants.a;
    await submit(a, reading('tail-2', 50, 3, 'severe'));
    // Each cut is the database's clock now: after the reading's receipt, and before the evaluation the worker records.
    let cut = await databaseNow(admin);
    const read = () =>
      withScope(pool, a.actor, (client, principal) =>
        gatherIndicatorInputs(client, principal, {
          definition: { id: issueRate.id, version: 1 },
          window: { start: start.toISOString(), end: cut },
          recordedThrough: cut,
          population: population(a, ['tail-1', 'tail-2', 'tail-3']),
        }),
      );
    const pending = await read();
    expect(pending.input.selection.pending).toBe(true);
    expect(calculateIndicator(pending.definition, pending.input)).toMatchObject({
      status: 'insufficient',
      reasons: ['evaluations_pending'],
    });
    await settle();
    // At the same cut the evaluation recorded after it is not read, and the result says so without changing status.
    const sameCut = await read();
    expect(calculateIndicator(sameCut.definition, sameCut.input)).toMatchObject({
      status: 'supported',
      eventCount: 1,
      limitations: ['evaluations_recorded_after_cut'],
    });
    // A later cut, as a window revised after the worker ran, reads the evaluation it recorded.
    cut = await databaseNow(admin);
    const settled = await read();
    const later = calculateIndicator(settled.definition, settled.input);
    expect(later).toMatchObject({ status: 'supported', eventCount: 2, reasons: [] });
    expect(later.limitations).toBeUndefined();
  });
});
