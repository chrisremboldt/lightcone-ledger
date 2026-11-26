import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import { adoptExampleRiskMatrix } from '../../apps/api/src/seed-risk-matrix.js';
import type {
  Capability,
  ControlIndicatorResultResponse,
  ControlWindow,
  ControlWindowIndicatorResponse,
  ControlWindowListResponse,
  OrganizationCoverageResponse,
  SmsDecisionInput,
  SmsFindingPromotionResponse,
  SmsRecordDetailResponse,
  SmsSigningPreviewResponse,
  SubjectFindingRecord,
  SubjectReference,
} from '../../packages/contracts/src/index.js';
import { adoptShownPack } from '../../packages/contracts/fixtures/demo/v1/ready.js';
import { operatingLimitControlType } from '../../packages/domain/src/control-type-library.js';
import {
  calculateIndicator,
  controlWindowIndicatorRequest,
  defineIndicator,
  gatherIndicatorInputs,
  registerIndicatorDefinition,
} from '../../packages/domain/src/index.js';
import { canonicalDigest, sha256 } from '../../packages/integrity/src/index.js';
import { createPool, MemoryObjectStore, withScope, type AuthContext } from '../../packages/persistence/src/index.js';
import {
  BATTERY_RESERVE_LEAF_ID,
  EXAMPLE_OPERATIONS_PACK_ID,
} from '../../packages/pack-example-operations/src/index.js';
import { runOwnedWork, settleOwnedWork } from './worker-queue.js';

// A fictional organization accepts an operating limit on battery reserve, then opens a window over listed aircraft
// and calculates an indicator defined here for it. Nothing in core code names the rule, the control type or the
// observation types; the window carries them as data.
type Role = 'safety' | 'executive' | 'source' | 'worker';
const people: Record<Role, { kind: string; capabilities: Capability[] }> = {
  safety: {
    kind: 'human',
    capabilities: [
      'sms:read',
      'sms:write',
      'sms:configure',
      'decision:write',
      'evidence:read',
      'flight:read',
      'authority:write',
      'pack:adopt',
      'monitoring:write',
    ],
  },
  executive: {
    kind: 'human',
    capabilities: ['sms:read', 'sms:adopt', 'decision:write', 'evidence:read', 'risk:accept:high'],
  },
  source: { kind: 'source', capabilities: ['input:write', 'flight:read', 'evidence:read'] },
  worker: { kind: 'worker', capabilities: ['flight:read', 'flight:create', 'evidence:read', 'input:write'] },
};

describe.runIf(process.env.LEDGER_ENV !== 'staging')('Control windows on PostgreSQL', () => {
  const prefix = `control-window-${randomUUID()}`;
  const tenantId = `${prefix}:org`;
  const sourceId = `${prefix}-telemetry`;
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const workerPool = createPool(process.env.WORKER_DATABASE_URL);
  const who = {} as Record<Role, AuthContext>;
  let app: Awaited<ReturnType<typeof createApp>>;
  let artifactId: string;

  // The period closed before the test began, so a declaration made now covers all of it.
  const start = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 3 * 3_600_000);
  const at = (minutes: number) => new Date(start.getTime() + minutes * 60_000).toISOString();
  const period = { start: at(0), end: at(120) };
  const tail = (id: string): SubjectReference => ({ scope: 'source', kind: 'aircraft', id, sourceId });

  const lowReserveRate = defineIndicator({
    id: `test.low-reserve-readings-per-flight-${prefix.slice(-12)}`,
    version: 1,
    title: 'Readings under the battery reserve per 100 flights',
    description: 'Battery readings under 30 percent remaining, per 100 reported flights, for the listed aircraft.',
    scope: { kind: 'subject_kind', subjectKind: 'aircraft' },
    events: {
      kind: 'observations',
      type: 'battery.state',
      versions: [1],
      condition: { field: 'values.totalRemainingPercent', operator: 'below', value: 30 },
    },
    exposure: { kind: 'exposure.flights', version: 1, params: {} },
    window: { maxMilliseconds: 24 * 60 * 60 * 1000 },
    completeness: { exposureMustExceed: '0', populationDeclaredComplete: true, coverageWithoutGaps: true },
    unit: { per: 100, label: 'per 100 flights', fractionDigits: 2 },
    limit: { rate: '50', label: 'Alert level' },
  });
  const expectedObservations = [
    { type: 'battery.state', versions: [1] },
    { type: 'flight.report', versions: [1] },
  ];

  function call(principal: AuthContext, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, headers = {}) {
    return app.inject({
      method,
      url,
      headers: { authorization: `Bearer ledger-dev-${principal.id}`, 'idempotency-key': randomUUID(), ...headers },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  }
  async function command(principal: AuthContext, payload: unknown, headers = {}) {
    const response = await call(principal, 'POST', '/v1/commands', payload, headers);
    expect(response.statusCode, response.body).toBe(201);
    return response.json().command as { id: string; subject: { id: string } };
  }
  async function detail(id: string): Promise<SmsRecordDetailResponse> {
    const response = await call(who.safety, 'GET', `/v1/sms/records/${id}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }
  function decide(id: string, shown: { revision: number; dependencyBasis: string }, decision: SmsDecisionInput) {
    return {
      kind: 'decision.record' as const,
      subject: { kind: 'sms' as const, id },
      expectedRevision: shown.revision,
      expectedDependencyBasis: shown.dependencyBasis,
      decision,
    };
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

  async function createOrganization(): Promise<void> {
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, 'Fictional window organization']);
    for (const [role, person] of Object.entries(people) as [Role, (typeof people)[Role]][]) {
      who[role] = {
        id: `${tenantId}:${role}`,
        tenantId,
        name: `Fictional ${role}`,
        kind: person.kind,
        revision: 1,
        capabilities: person.capabilities,
      };
      await admin.query('INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,$4,$5)', [
        who[role].id,
        tenantId,
        who[role].name,
        person.kind,
        person.capabilities,
      ]);
      await admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [
        sha256(`ledger-dev-${who[role].id}`),
        who[role].id,
      ]);
    }
    const current = await call(who.safety, 'GET', `/v1/authority/principals/${encodeURIComponent(who.source.id)}`);
    expect(current.statusCode, current.body).toBe(200);
    await command(who.safety, {
      kind: 'authority.update',
      principalId: who.source.id,
      expectedRevision: current.json().principal.revision,
      capabilities: current.json().principal.capabilities,
      observationGrants: ['battery.state', 'flight.report'].map((observationType) => ({ sourceId, observationType })),
    });
  }

  async function upload(): Promise<string> {
    const bytes = Buffer.from(JSON.stringify({ entered: 'fictional telemetry log' }));
    const created = await call(who.source, 'POST', '/v1/uploads', {
      contentType: 'application/json',
      byteLength: bytes.byteLength,
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().upload.id as string;
    const stored = await app.inject({
      method: 'PUT',
      url: `/v1/uploads/${id}/content`,
      headers: {
        authorization: `Bearer ledger-dev-${who.source.id}`,
        'idempotency-key': randomUUID(),
        'content-type': 'application/octet-stream',
      },
      payload: bytes,
    });
    expect(stored.statusCode, stored.body).toBe(200);
    const finalized = await call(who.source, 'POST', `/v1/uploads/${id}/finalize`);
    expect(finalized.statusCode, finalized.body).toBe(201);
    return finalized.json().artifact.id as string;
  }

  async function adoptExamplePack(reservePercent: number): Promise<void> {
    const shown = await call(who.safety, 'GET', '/v1/organization/coverage');
    expect(shown.statusCode, shown.body).toBe(200);
    const retained = await call(
      who.safety,
      'GET',
      `/v1/rule-packs/${encodeURIComponent(EXAMPLE_OPERATIONS_PACK_ID)}/versions/1`,
    );
    expect(retained.statusCode, retained.body).toBe(200);
    const now = Date.now();
    await command(who.safety, {
      ...adoptShownPack(
        shown.json() as OrganizationCoverageResponse,
        retained.json().pack,
        { start: new Date(now - 60_000).toISOString(), end: new Date(now + 3_600_000).toISOString() },
        'Adopt the example procedures with our battery reserve.',
        'active',
      ),
      parameters: { [BATTERY_RESERVE_LEAF_ID]: { limit: reservePercent } },
    });
    await settle();
  }

  async function submit(observation: Record<string, unknown>) {
    const response = await call(who.source, 'POST', '/v1/inputs', {
      sourceId,
      kind: 'observation',
      occurredAt: observation.occurredAt,
      payload: {
        fidelity: 'synthetic_contract',
        limitations: ['Synthetic test data.'],
        ...observation,
        originalArtifactId: artifactId,
      },
    });
    expect(response.statusCode, response.body).toBe(201);
  }
  const battery = (tailId: string, minutes: number, percent: number) =>
    submit({
      type: 'battery.state',
      version: 1,
      subject: { kind: 'aircraft', id: tailId, scope: 'source' },
      occurredAt: at(minutes),
      sourceEventId: `${tailId}-battery-${minutes}`,
      values: { totalRemainingPercent: percent },
    });
  const flight = (tailId: string, flightId: string, takeoff: number, landing: number) =>
    submit({
      type: 'flight.report',
      version: 1,
      subject: { kind: 'flight', id: flightId, scope: 'source' },
      secondarySubject: { kind: 'aircraft', id: tailId, scope: 'source' },
      occurredAt: at(landing),
      sourceEventId: `${flightId}-report`,
      values: { activity: 'landed', takeoffAt: at(takeoff), landingAt: at(landing) },
    });

  async function findingFor(tailId: string): Promise<SubjectFindingRecord> {
    const query = new URLSearchParams({ subjectKind: 'aircraft', subjectId: tailId, subjectScope: 'source', sourceId });
    const findings = async () => {
      const response = await call(who.safety, 'GET', `/v1/findings?${query}`);
      expect(response.statusCode, response.body).toBe(200);
      return response.json().findings as SubjectFindingRecord[];
    };
    await settle(async () => (await findings()).length > 0);
    const [finding] = await findings();
    expect(finding).toBeDefined();
    return finding!;
  }

  /** Opens a hazard from the finding and accepts it with an operating limit; returns the accepted control. */
  async function acceptOperatingLimit(finding: SubjectFindingRecord) {
    const promotion = await call(who.safety, 'GET', `/v1/sms/findings/${encodeURIComponent(finding.id)}/promotion`);
    expect(promotion.statusCode, promotion.body).toBe(200);
    const shown = promotion.json() as SmsFindingPromotionResponse;
    const hazardId = (
      await command(who.safety, {
        kind: 'sms.record.open',
        record: {
          kind: 'hazard',
          schema: 'sms.hazard.1',
          title: 'Battery below the adopted reserve',
          ownerId: who.safety.id,
          body: {
            description: `Raised from: ${shown.evaluation.summary}`,
            consequence: 'Forced landing of the fictional aircraft away from the work site.',
            source: { kind: 'finding' },
          },
        },
        origin: {
          kind: 'finding',
          findingId: shown.origin.findingId,
          evaluationId: shown.origin.evaluationId,
          expectedDependencyBasis: shown.basis.dependencyBasis,
        },
      })
    ).subject.id;
    const listed = (await detail(hazardId)).controlTypes!.find((type) => type.id === operatingLimitControlType.id)!;
    const controlId = (
      await command(who.safety, {
        kind: 'sms.record.open',
        record: {
          kind: 'control',
          schema: 'sms.control.1',
          title: 'Battery reserve of 30 percent',
          ownerId: who.safety.id,
          body: {
            hazardId,
            controlType: { id: listed.id, version: listed.version, digest: listed.digest },
            parameters: {
              observationType: 'battery.state',
              observationVersion: 1,
              field: 'values.totalRemainingPercent',
              comparison: 'at_least',
              limit: 30,
              unit: 'percent',
              scope: 'subject_kind',
              subjectKind: 'aircraft',
            },
            effectiveFrom: period.start,
          },
        },
      })
    ).subject.id;
    const current = await detail(hazardId);
    await command(
      who.safety,
      decide(hazardId, current.basis, {
        kind: 'risk.assess',
        note: 'Assessed against the finding evaluation shown, with the reserve limit in place.',
        matrix: { recordId: current.matrix!.record.id, versionNumber: current.matrix!.version.versionNumber },
        initial: { severity: 'major', likelihood: 'remote' },
        controls: [{ recordId: controlId, versionNumber: 1 }],
        residual: { severity: 'minor', likelihood: 'remote' },
        newHazardCheck: { answer: 'none_identified' },
        evidence: { evaluationId: shown.origin.evaluationId },
      }),
    );
    const assessment = (await detail(hazardId)).decisions.find((decision) => decision.kind === 'risk.assess')!;
    const preview = await call(who.executive, 'GET', `/v1/sms/records/${hazardId}/signing?meaning=risk.accept`);
    expect(preview.statusCode, preview.body).toBe(200);
    const signing = preview.json() as SmsSigningPreviewResponse;
    const grant = await call(who.executive, 'POST', '/v1/local/reauthentications', {
      credential: `ledger-dev-${who.executive.id}`,
    });
    expect(grant.statusCode, grant.body).toBe(201);
    await command(
      who.executive,
      decide(hazardId, signing.basis, {
        kind: 'risk.accept',
        note: 'Residual risk accepted with the battery reserve limit in place.',
        assessmentId: assessment.id,
        signature: { intent: signing.intent!, contentDigest: signing.contentDigest!, reviewed: true },
      }),
      { 'x-ledger-reauthentication': grant.json().grant as string },
    );
    const accepted = await detail(hazardId);
    expect(accepted.controls![0]).toMatchObject({ id: controlId, accepted: true });
    // The acceptance records the hazard on file for the organization; project it before reading an indicator.
    await settle();
    return {
      kind: 'control_record' as const,
      hazardId,
      recordId: controlId,
      versionNumber: 1,
      bodyDigest: accepted.controls![0]!.bodyDigest,
      acceptanceId: accepted.decisions.find((decision) => decision.kind === 'risk.accept')!.id,
    };
  }

  async function calculate(windowId: string) {
    const response = await call(
      who.safety,
      'GET',
      `/v1/control-windows/${windowId}/indicators/${encodeURIComponent(lowReserveRate.id)}/versions/1`,
    );
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as ControlWindowIndicatorResponse;
  }

  beforeAll(async () => {
    registerIndicatorDefinition(lowReserveRate);
    app = await createApp({ pool, env: 'test', objectStore: new MemoryObjectStore() });
    await app.ready();
    await createOrganization();
    artifactId = await upload();
    await adoptExamplePack(30);
    const drafter = { id: who.safety.id, token: `ledger-dev-${who.safety.id}` };
    const adopter = { token: `ledger-dev-${who.executive.id}` };
    expect(await adoptExampleRiskMatrix(app, { drafter, adopter, note: 'Adopting the fictional matrix.' })).toBe(true);
    // Two of four readings of the listed aircraft are under the reserve, each the latest for its aircraft, over three
    // flights. tail-9 is not listed.
    await battery('tail-7', 15, 45);
    await battery('tail-7', 55, 12);
    await battery('tail-8', 90, 60);
    await battery('tail-8', 110, 20);
    await battery('tail-9', 30, 5);
    await flight('tail-7', 'flight-a', 10, 40);
    await flight('tail-7', 'flight-b', 50, 80);
    await flight('tail-8', 'flight-c', 85, 115);
    await flight('tail-9', 'flight-d', 20, 50);
    await settle();
  });
  afterAll(async () => {
    await settleOwnedWork([prefix]);
    if (app) await app.close();
    await pool.end();
    await admin.end();
    await workerPool.end();
  });

  it('opens a window for an accepted battery-reserve control and calculates an indicator from it', async () => {
    const control = await acceptOperatingLimit(await findingFor('tail-7'));
    const opening = {
      control,
      period,
      subjectKind: 'aircraft',
      subjects: [tail('tail-8'), tail('tail-7')],
      complete: false,
      expectedObservations,
      indicators: [{ id: lowReserveRate.id, version: 1, digest: lowReserveRate.digest }],
      note: 'Aircraft flying under the reserve limit this morning.',
    };
    const opened = await call(who.safety, 'POST', '/v1/control-windows', opening);
    expect(opened.statusCode, opened.body).toBe(201);
    const first = opened.json().window as ControlWindow;
    expect(first).toMatchObject({
      variant: 'generic',
      control,
      period,
      population: {
        subjectKind: 'aircraft',
        subjects: [tail('tail-7'), tail('tail-8')],
        complete: false,
        declaredBy: { kind: 'person', id: who.safety.id },
      },
      expectedObservations,
      revision: { number: 1 },
    });

    // Not yet declared complete: the indicator states no rate and says why.
    const before = await calculate(first.id);
    expect(before.result).toMatchObject({ status: 'insufficient', rate: null });
    expect(before.result.reasons).toContain('population_not_declared_complete');
    expect(before.wording).toMatchObject({
      title: 'Readings under the battery reserve per 100 flights',
      rate: null,
      population: '2 aircraft listed by Fictional safety, not declared complete',
    });
    expect(before.wording.reasons).toContainEqual({
      code: 'population_not_declared_complete',
      sentence: 'This indicator needs the population declared complete by a named person or source, and it is not.',
    });

    const revised = await call(who.safety, 'POST', `/v1/control-windows/${first.id}/revisions`, {
      expectedRevision: 1,
      subjects: [tail('tail-7'), tail('tail-8')],
      complete: true,
      note: 'Every aircraft that flew is listed.',
    });
    expect(revised.statusCode, revised.body).toBe(201);
    const window = revised.json().window as ControlWindow;
    expect(window).toMatchObject({ id: first.id, population: { complete: true }, revision: { number: 2 } });
    const stale = await call(who.safety, 'POST', `/v1/control-windows/${first.id}/revisions`, {
      expectedRevision: 1,
      subjects: [tail('tail-7')],
      complete: true,
      note: 'Shown before the last revision.',
    });
    expect(stale.statusCode, stale.body).toBe(409);

    const calculated = await calculate(window.id);
    expect(calculated).toMatchObject({ windowId: window.id, revision: 2, selection: 'complete' });
    expect(calculated.result).toMatchObject({
      status: 'supported',
      control: { id: control.recordId, version: 1 },
      window: period,
      recordedThrough: window.revision.recordedAt,
      eventCount: 2,
      exposure: { value: { numerator: '3', denominator: '1' }, unit: 'flight', gaps: [] },
      rate: { value: { numerator: '200', denominator: '3' }, decimal: '66.67', label: 'per 100 flights' },
      population: { subjectCount: 2, complete: true, declaredBy: { kind: 'person', id: who.safety.id } },
      reasons: [],
    });
    expect(calculated.wording).toEqual({
      title: 'Readings under the battery reserve per 100 flights',
      description: lowReserveRate.description,
      rate: '66.67 per 100 flights',
      events: '2 matching reports',
      exposure: '3 flights',
      population: '2 aircraft, declared complete by Fictional safety',
      reasons: [],
      limitations: [],
      gaps: [],
      conflicts: [],
    });

    // The window alone gives the population declaration and cut that gathering takes.
    const request = controlWindowIndicatorRequest(window, { id: lowReserveRate.id, version: 1 });
    expect(request).toEqual({
      definition: { id: lowReserveRate.id, version: 1 },
      window: period,
      recordedThrough: window.revision.recordedAt,
      control: { id: control.recordId, version: 1 },
      population: {
        subjects: [tail('tail-7'), tail('tail-8')],
        complete: true,
        declaredBy: { kind: 'person', id: who.safety.id },
      },
    });
    const gathered = await withScope(pool, who.safety, (client, principal) =>
      gatherIndicatorInputs(client, principal, request),
    );
    expect(gathered.definition.digest).toBe(lowReserveRate.digest);
    expect(calculateIndicator(gathered.definition, gathered.input).inputDigest).toBe(calculated.result.inputDigest);

    const query = new URLSearchParams({
      controlKind: 'control_record',
      hazardId: control.hazardId,
      controlId: control.recordId,
    });
    const listed = await call(who.safety, 'GET', `/v1/control-windows?${query}`);
    expect(listed.statusCode, listed.body).toBe(200);
    // Listed, the window also says in plain words what it covers, who declared it, and its indicators' titles.
    expect(listed.json() as ControlWindowListResponse).toEqual({
      windows: [
        {
          ...window,
          wording: {
            population: '2 aircraft, declared complete by Fictional safety',
            indicators: [{ id: lowReserveRate.id, version: 1, title: lowReserveRate.title }],
          },
        },
      ],
      truncated: false,
    });
    const read = await call(who.safety, 'GET', `/v1/control-windows/${window.id}`);
    expect(read.json()).toEqual({ window });

    // The result is recorded with its request, then a person reviews the recorded result by its digest.
    const definition = { id: lowReserveRate.id, version: 1, digest: lowReserveRate.digest };
    const shown = { number: window.revision.number, digest: window.revision.digest };
    const staleRecord = await call(who.safety, 'POST', `/v1/control-windows/${window.id}/indicator-results`, {
      definition,
      expectedRevision: { number: 1, digest: first.revision.digest },
    });
    expect(staleRecord.statusCode, staleRecord.body).toBe(409);
    const recorded = await call(who.safety, 'POST', `/v1/control-windows/${window.id}/indicator-results`, {
      definition,
      expectedRevision: shown,
    });
    expect(recorded.statusCode, recorded.body).toBe(201);
    const result = recorded.json() as ControlIndicatorResultResponse;
    expect(result).toMatchObject({
      record: {
        format: 'ledger.control-indicator-result.1',
        windowId: window.id,
        windowRevision: 2,
        windowRevisionDigest: window.revision.digest,
        control,
        request: { definition: { id: lowReserveRate.id, version: 1 }, recordedThrough: window.revision.recordedAt },
        result: { ...calculated.result },
      },
      currentness: { status: 'current', inputDigest: calculated.result.inputDigest },
      wording: calculated.wording,
    });
    expect(canonicalDigest(result.record)).toBe(result.digest);
    const again = await call(who.safety, 'GET', `/v1/control-indicator-results/${result.record.id}`);
    expect(again.json()).toMatchObject({ record: result.record, digest: result.digest });
    const reviewed = await call(who.safety, 'POST', '/v1/control-indicator-reviews', {
      result: { id: result.record.id, digest: result.digest },
      conclusion: 'effective',
      note: 'Two of three flights under the reserve is above what we accept; reviewed with the chief pilot.',
    });
    expect(reviewed.statusCode, reviewed.body).toBe(201);
    expect(reviewed.json()).toMatchObject({
      record: {
        format: 'ledger.control-indicator-review.1',
        result: { id: result.record.id, digest: result.digest },
        resultStatus: 'supported',
        conclusion: 'effective',
        actor: { id: who.safety.id, policyVersion: 'ledger.control-effectiveness-review-authority.2' },
      },
    });
    const wrongDigest = await call(who.safety, 'POST', '/v1/control-indicator-reviews', {
      result: { id: result.record.id, digest: '0'.repeat(64) },
      conclusion: 'inconclusive',
      note: 'Cited from another screen.',
    });
    expect(wrongDigest.statusCode, wrongDigest.body).toBe(409);
    const listedResults = await call(who.safety, 'GET', `/v1/control-windows/${window.id}/indicator-results`);
    expect(listedResults.json()).toMatchObject({
      results: [{ digest: result.digest, wording: calculated.wording }],
      reviews: [{ record: { conclusion: 'effective' } }],
    });
    // The indicator's results over time hold the same recorded result, with the level its definition sets.
    const history = await call(who.safety, 'GET', `/v1/reports/indicators/${lowReserveRate.id}/versions/1`);
    expect(history.statusCode, history.body).toBe(200);
    expect(history.json()).toMatchObject({
      definition: { id: lowReserveRate.id, title: lowReserveRate.title, limit: { rate: '50', label: 'Alert level' } },
      results: [
        {
          id: result.record.id,
          digest: result.digest,
          windowId: window.id,
          hazardId: control.hazardId,
          window: result.record.result.window,
          status: result.record.result.status,
          eventCount: result.record.result.eventCount,
          rate: result.record.result.rate
            ? { decimal: result.record.result.rate.decimal, label: 'per 100 flights' }
            : null,
        },
      ],
    });
    const indicators = await call(who.safety, 'GET', '/v1/reports/indicators');
    expect(indicators.json().indicators).toContainEqual(
      expect.objectContaining({ id: lowReserveRate.id, version: 1, results: 1, title: lowReserveRate.title }),
    );

    // The hazard's owner may close it citing that review, exactly as recorded and of a control the hazard binds.
    const review = reviewed.json() as { record: { id: string }; digest: string };
    const open = await detail(control.hazardId);
    expect(open.closingReviews).toEqual([
      expect.objectContaining({
        id: review.record.id,
        digest: review.digest,
        conclusion: 'effective',
        control: expect.objectContaining({ id: control.recordId, versionNumber: 1 }),
      }),
    ]);
    const close = (id: string, shown: { revision: number; dependencyBasis: string }, digest: string) =>
      call(
        who.safety,
        'POST',
        '/v1/commands',
        decide(id, shown, {
          kind: 'record.close',
          note: 'The reserve limit works as accepted.',
          review: { id: review.record.id, digest },
        }),
      );
    const mismatched = await close(control.hazardId, open.basis, '0'.repeat(64));
    expect(mismatched.statusCode, mismatched.body).toBe(409);
    expect(mismatched.json().error.code).toBe('review_citation_mismatch');
    const unrelatedId = (
      await command(who.safety, {
        kind: 'sms.record.open',
        record: {
          kind: 'hazard',
          schema: 'sms.hazard.1',
          title: 'Another fictional hazard',
          ownerId: who.safety.id,
          body: {
            description: 'Identified directly.',
            consequence: 'A fictional consequence.',
            source: { kind: 'manual_identification' },
          },
        },
      })
    ).subject.id;
    const unrelated = await detail(unrelatedId);
    expect(unrelated.closingReviews).toEqual([]);
    const unbound = await close(unrelatedId, unrelated.basis, review.digest);
    expect(unbound.statusCode, unbound.body).toBe(409);
    expect(unbound.json().error.code).toBe('review_control_not_bound');
    const closed = await close(control.hazardId, (await detail(control.hazardId)).basis, review.digest);
    expect(closed.statusCode, closed.body).toBe(201);
    const after = await detail(control.hazardId);
    expect(after.record.status).toBe('closed');
    expect(after.decisions.find((decision) => decision.kind === 'record.close')!.outcome).toMatchObject({
      status: 'closed',
      review: { id: review.record.id, digest: review.digest, conclusion: 'effective', controlId: control.recordId },
    });
  });

  it('refuses a window the indicator cannot be read from, or for a control that is not accepted', async () => {
    const control = await acceptOperatingLimit(await findingFor('tail-8'));
    const opening = {
      control,
      period,
      subjectKind: 'aircraft',
      subjects: [tail('tail-7')],
      complete: true,
      expectedObservations,
      indicators: [{ id: lowReserveRate.id, version: 1, digest: lowReserveRate.digest }],
      note: 'A window that should be refused.',
    };
    const refused = async (payload: unknown, status: number, code: string) => {
      const response = await call(who.safety, 'POST', '/v1/control-windows', payload);
      expect(response.statusCode, response.body).toBe(status);
      expect(response.json().error.code).toBe(code);
    };
    await refused({ ...opening, expectedObservations: [expectedObservations[0]] }, 400, 'invalid_control_window');
    await refused({ ...opening, subjectKind: 'flight' }, 400, 'invalid_control_window');
    await refused(
      { ...opening, indicators: [{ id: lowReserveRate.id, version: 1, digest: '0'.repeat(64) }] },
      400,
      'invalid_control_window',
    );
    await refused({ ...opening, control: { ...control, versionNumber: 2 } }, 404, 'control_not_accepted');
    await refused({ ...opening, control: { ...control, bodyDigest: '0'.repeat(64) } }, 404, 'control_not_accepted');
    const withoutCapability = await call(who.executive, 'POST', '/v1/control-windows', opening);
    expect(withoutCapability.statusCode, withoutCapability.body).toBe(403);
  });
});
