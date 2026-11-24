import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import { adoptExampleRiskMatrix } from '../../apps/api/src/seed-risk-matrix.js';
import type {
  Capability,
  FindingRecord,
  OrganizationCoverageResponse,
  RulePackVersion,
  SmsAdoptedMatrix,
  SmsAssessmentOutcome,
  SmsDecisionInput,
  SmsFindingPromotionResponse,
  SmsRecordDetailResponse,
  SmsRegisterResponse,
  SmsSigningPreviewResponse,
  SubjectFindingRecord,
} from '../../packages/contracts/src/index.js';
import { adoptShownPack } from '../../packages/contracts/fixtures/demo/v1/ready.js';
import {
  defineCheckedRule,
  exampleRiskMatrix,
  findCheckKind,
  registerObservationTypes,
  registerRulePack,
} from '../../packages/domain/src/index.js';
import { canonicalDigest, sha256 } from '../../packages/integrity/src/index.js';
import { createPool, MemoryObjectStore, withScope, type AuthContext } from '../../packages/persistence/src/index.js';
import { rotorIcingObservation, rotorIcingType } from '../unit/rotor-icing-observation.js';
import { runOwnedWork, settleOwnedWork } from './worker-queue.js';

// Any finding can become a safety-program hazard. Every rule below is defined in this test and reaches the hazard
// only through the generic evaluator; nothing in the hazard code names it. The organizations are created here with
// both rule packs and safety-program capabilities.
type Role = 'safety' | 'executive' | 'colleague' | 'source' | 'worker';
const people: Record<Role, { kind: string; capabilities: Capability[] }> = {
  safety: {
    kind: 'human',
    capabilities: [
      'sms:read',
      'sms:write',
      'sms:configure',
      'sms:report:read',
      'decision:write',
      'evidence:read',
      'input:write',
      'flight:read',
      'flight:create',
      'authority:write',
      'pack:adopt',
      'risk:accept:low',
      'risk:accept:medium',
      'correction:write',
    ],
  },
  executive: {
    kind: 'human',
    capabilities: ['sms:read', 'sms:adopt', 'decision:write', 'evidence:read', 'risk:accept:high'],
  },
  colleague: { kind: 'human', capabilities: ['sms:read', 'sms:write', 'decision:write', 'evidence:read'] },
  source: { kind: 'source', capabilities: ['input:write', 'flight:read', 'evidence:read'] },
  worker: { kind: 'worker', capabilities: ['flight:read', 'flight:create', 'evidence:read', 'input:write'] },
};

describe.runIf(process.env.LEDGER_ENV !== 'staging')('Hazards opened from any finding on PostgreSQL', () => {
  const prefix = `hazard-origin-${randomUUID()}`;
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const workerPool = createPool(process.env.WORKER_DATABASE_URL);
  const sourceId = `${prefix}-sensor`;
  const types = { icing: 'rotor.icing-hazard', battery: 'battery.state' };
  let app: Awaited<ReturnType<typeof createApp>>;

  const icingRule = defineCheckedRule({
    id: 'test.hazard-icing-floor',
    version: 1,
    title: 'Outside air stays above the icing floor',
    source: { kind: 'operator_procedure', reference: 'Fictional procedure 7.1', text: 'Stop at the icing floor.' },
    target: { subjectKind: 'aircraft' },
    reads: [{ name: 'subject', type: types.icing, versions: [1], about: 'target', required: true, select: 'latest' }],
    check: {
      kind: findCheckKind('value.within-limit', 1)!,
      params: { field: 'values.outsideAirTemperatureCelsius', comparison: 'above', limit: 0 },
    },
  });
  const batteryRule = defineCheckedRule({
    id: 'test.hazard-battery-reserve',
    version: 1,
    title: 'Charge stays above the landing reserve',
    source: { kind: 'operator_procedure', reference: 'Fictional procedure 7.2', text: 'Land before the reserve.' },
    target: { subjectKind: 'flight' },
    reads: [{ name: 'subject', type: types.battery, versions: [1], about: 'target', required: true, select: 'latest' }],
    check: {
      kind: findCheckKind('value.within-limit', 1)!,
      params: { field: 'values.totalRemainingPercent', comparison: 'above', limit: 20 },
    },
  });
  const packContent = {
    packId: `${prefix}.pack`,
    version: 1,
    title: 'Fictional hazard-origin procedures',
    status: 'draft' as const,
    review: 'ai_drafted' as const,
    adopted: false as const,
    bindings: [],
    leaves: [icingRule, batteryRule],
  };
  const testPack: RulePackVersion = { ...packContent, digest: canonicalDigest(packContent) };

  interface Tenant {
    id: string;
    who: Record<Role, AuthContext>;
    artifactId: string;
  }
  const tenants = {} as Record<'a' | 'b', Tenant>;

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
  async function refused(principal: AuthContext, payload: unknown, status: number, code: string) {
    const response = await call(principal, 'POST', '/v1/commands', payload);
    expect(response.statusCode, response.body).toBe(status);
    expect(response.json().error.code).toBe(code);
    return response.json().error as { details?: Record<string, unknown> };
  }

  async function tenant(name: string, adopt: boolean): Promise<Tenant> {
    const tenantId = `${prefix}:${name}`;
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, `Fictional ${name}`]);
    const who = {} as Record<Role, AuthContext>;
    for (const [role, person] of Object.entries(people) as [Role, (typeof people)[Role]][]) {
      who[role] = {
        id: `${tenantId}:${role}`,
        tenantId,
        name: `Fictional ${role} of ${name}`,
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
      observationGrants: Object.values(types).map((observationType) => ({ sourceId, observationType })),
    });
    const t = { id: tenantId, who, artifactId: await upload(who.source) };
    if (adopt) await adoptPack(t);
    await program(t);
    return t;
  }

  async function upload(principal: AuthContext): Promise<string> {
    const bytes = Buffer.from(JSON.stringify({ entered: 'fictional sensor log' }));
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

  async function adoptPack(t: Tenant): Promise<void> {
    const shown = await call(t.who.safety, 'GET', '/v1/organization/coverage');
    expect(shown.statusCode, shown.body).toBe(200);
    const retained = await call(
      t.who.safety,
      'GET',
      `/v1/rule-packs/${encodeURIComponent(testPack.packId)}/versions/1`,
    );
    expect(retained.statusCode, retained.body).toBe(200);
    const now = Date.now();
    await command(
      t.who.safety,
      adoptShownPack(
        shown.json() as OrganizationCoverageResponse,
        retained.json().pack,
        { start: new Date(now - 60_000).toISOString(), end: new Date(now + 3_600_000).toISOString() },
        'Adopt the fictional procedures.',
        'active',
      ),
    );
    await settle();
  }

  // The organization adopts the example matrix through the same seed helper the seeded organizations use.
  async function program(t: Tenant): Promise<void> {
    const drafter = { id: t.who.safety.id, token: `ledger-dev-${t.who.safety.id}` };
    const adopter = { token: `ledger-dev-${t.who.executive.id}` };
    const note = 'Adopting the program matrix for fictional testing.';
    expect(await adoptExampleRiskMatrix(app, { drafter, adopter, note })).toBe(true);
    expect(await adoptExampleRiskMatrix(app, { drafter, adopter, note })).toBe(false);
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
    const response = await call(t.who.source, 'POST', '/v1/inputs', {
      sourceId,
      kind: 'observation',
      occurredAt: observation.occurredAt,
      payload: { ...observation, originalArtifactId: t.artifactId },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().receipt as { id: string; eventId: string };
  }
  function icing(tail: string, sourceEventId: string, celsius: number, occurredAt = '2026-11-02T10:15:00.000Z') {
    return rotorIcingObservation(
      {
        subject: { kind: 'aircraft', id: tail, scope: 'source' },
        sourceEventId,
        occurredAt,
        interval: { start: new Date(Date.parse(occurredAt) - 600_000).toISOString(), end: occurredAt },
        values: { severity: 'light', outsideAirTemperatureCelsius: celsius },
      },
      types.icing,
    );
  }
  function battery(flightId: string, sourceEventId: string, percent: number) {
    return {
      type: types.battery,
      version: 1,
      subject: { kind: 'flight', id: flightId, scope: 'ledger' },
      occurredAt: '2026-11-03T09:30:00.000Z',
      sourceEventId,
      fidelity: 'synthetic_contract',
      limitations: ['Synthetic test data.'],
      values: { totalRemainingPercent: percent },
    };
  }
  async function subjectFindings(t: Tenant, query: Record<string, string>): Promise<SubjectFindingRecord[]> {
    const response = await call(t.who.safety, 'GET', `/v1/findings?${new URLSearchParams(query)}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json().findings;
  }
  async function sourceFinding(t: Tenant, tail: string, evaluations = 1): Promise<SubjectFindingRecord> {
    const query = { subjectKind: 'aircraft', subjectId: tail, subjectScope: 'source', sourceId };
    let found: SubjectFindingRecord | undefined;
    await settle(async () => {
      found = (await subjectFindings(t, query))[0];
      const all = await call(t.who.safety, 'GET', `/v1/evaluations?${new URLSearchParams(query)}`);
      return Boolean(found) && all.json().evaluations.length >= evaluations;
    });
    found = (await subjectFindings(t, query))[0];
    expect(found).toBeDefined();
    return found!;
  }
  async function promotion(t: Tenant, findingId: string, role: Role = 'safety') {
    return call(t.who[role], 'GET', `/v1/sms/findings/${encodeURIComponent(findingId)}/promotion`);
  }
  async function shownPromotion(
    t: Tenant,
    findingId: string,
    role: Role = 'safety',
  ): Promise<SmsFindingPromotionResponse> {
    const response = await promotion(t, findingId, role);
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }
  function openFrom(t: Tenant, shown: SmsFindingPromotionResponse, title = 'Promoted finding') {
    return {
      kind: 'sms.record.open',
      record: {
        kind: 'hazard',
        schema: 'sms.hazard.1',
        title,
        ownerId: t.who.safety.id,
        body: {
          description: `Raised from: ${shown.evaluation.summary}`,
          consequence: 'Loss of the fictional aircraft over the work site.',
          source: { kind: 'finding' },
        },
      },
      origin: {
        kind: 'finding',
        findingId: shown.origin.findingId,
        evaluationId: shown.origin.evaluationId,
        expectedDependencyBasis: shown.basis.dependencyBasis,
      },
    };
  }
  async function detail(t: Tenant, id: string, role: Role = 'safety'): Promise<SmsRecordDetailResponse> {
    const response = await call(t.who[role], 'GET', `/v1/sms/records/${id}`);
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
  function assessment(shown: SmsRecordDetailResponse, evaluationId?: string): SmsDecisionInput {
    return {
      kind: 'risk.assess',
      note: 'Assessed against the finding evaluation shown.',
      matrix: { recordId: shown.matrix!.record.id, versionNumber: shown.matrix!.version.versionNumber },
      initial: { severity: 'major', likelihood: 'remote' },
      controls: [],
      residual: { severity: 'minor', likelihood: 'remote' },
      newHazardCheck: { answer: 'none_identified' },
      ...(evaluationId ? { evidence: { evaluationId } } : {}),
    };
  }

  beforeAll(async () => {
    registerObservationTypes(rotorIcingType(types.icing));
    registerRulePack({ packId: testPack.packId, versions: [testPack] });
    app = await createApp({ pool, env: 'test', objectStore: new MemoryObjectStore() });
    await app.ready();
    tenants.a = await tenant('a', true);
    tenants.b = await tenant('b', false);
  });
  afterAll(async () => {
    await settleOwnedWork([prefix]);
    if (app) await app.close();
    await pool.end();
    await admin.end();
    await workerPool.end();
  });

  it('promotes a battery finding on a flight to a hazard and assesses it with the evaluation pinned', async () => {
    const a = tenants.a;
    const created = await call(a.who.safety, 'POST', '/v1/flights', { originationKey: `${prefix}-battery` });
    expect(created.statusCode, created.body).toBe(201);
    const flightId = created.json().flight.id as string;
    await submit(a, battery(flightId, 'battery-1', 12));
    const query = { subjectKind: 'flight', subjectId: flightId };
    await settle(async () => (await subjectFindings(a, query)).length > 0);
    const [finding] = await subjectFindings(a, query);
    expect(finding).toMatchObject({ ruleId: batteryRule.id, latestEvaluation: { outcome: 'attention' } });

    const shown = await shownPromotion(a, finding!.id);
    expect(shown).toMatchObject({
      origin: {
        kind: 'finding',
        findingId: finding!.id,
        findingKind: 'subject',
        subject: { scope: 'ledger', kind: 'flight', id: flightId },
        evaluationId: finding!.latestEvaluation.id,
        evaluationDigest: canonicalDigest(finding!.latestEvaluation),
        rule: { packId: testPack.packId, packVersion: 1, ruleId: batteryRule.id, ruleDigest: batteryRule.digest },
      },
      evaluation: { outcome: 'attention' },
      existingHazard: null,
    });
    const opened = await command(a.who.safety, openFrom(a, shown, 'Battery below the landing reserve'));
    const id = opened.subject.id;
    const hazard = await detail(a, id);
    expect(hazard.origin).toEqual(shown.origin);
    expect(hazard.links).toEqual([{ relation: 'derived_from', target: { kind: 'finding', id: finding!.id } }]);
    expect(hazard.evidence).toMatchObject({
      sinceOpened: {
        pinned: { id: shown.origin.evaluationId },
        newerEvaluation: false,
        newerRecords: [],
        sourceProjectionPending: false,
      },
      sinceAssessed: null,
    });
    // The hazard's basis covers the flight it came from.
    const edge = await admin.query(
      'SELECT 1 FROM subject_dependencies WHERE tenant_id=$1 AND subject_id=$2 AND dependency_subject_id=$3',
      [a.id, id, flightId],
    );
    expect(edge.rowCount).toBe(1);

    await refused(a.who.safety, decide(id, hazard.basis, assessment(hazard)), 400, 'evidence_required');
    // There is no fixed scale beside the adopted matrix: the retired 3×3 categories are refused.
    const fixedScale = assessment(hazard, shown.origin.evaluationId) as Extract<
      SmsDecisionInput,
      { kind: 'risk.assess' }
    >;
    await refused(
      a.who.safety,
      decide(id, hazard.basis, { ...fixedScale, initial: { severity: 'severe', likelihood: 'likely' } }),
      400,
      'unknown_matrix_position',
    );
    await command(a.who.safety, decide(id, hazard.basis, assessment(hazard, shown.origin.evaluationId)));
    const assessed = await detail(a, id);
    expect(assessed.record.status).toBe('awaiting_acceptance');
    // The flight finding is assessed on the organization's adopted matrix, pinned by version and digest.
    const adopted = hazard.matrix as SmsAdoptedMatrix;
    const outcome = assessed.decisions[0]!.outcome as SmsAssessmentOutcome;
    expect(outcome.matrix).toEqual({
      recordId: adopted.record.id,
      versionNumber: adopted.version.versionNumber,
      bodyDigest: adopted.version.bodyDigest,
    });
    expect(adopted.version.body).toEqual(exampleRiskMatrix);
    expect(outcome.initial).toEqual({ severity: 'major', likelihood: 'remote', level: 'medium', acceptance: 'medium' });
    expect(outcome.residual).toEqual({ severity: 'minor', likelihood: 'remote', level: 'low', acceptance: 'low' });
    expect((assessed.decisions[0]!.outcome as SmsAssessmentOutcome).evidence).toEqual({
      findingId: finding!.id,
      findingKind: 'subject',
      evaluationId: shown.origin.evaluationId,
      evaluationDigest: shown.origin.evaluationDigest,
      evaluationRecordedAt: shown.origin.evaluationRecordedAt,
    });
    expect(assessed.evidence?.sinceAssessed).toMatchObject({ newerEvaluation: false, newerRecords: [] });
  });

  it('lists hazards newest first with their origin, page by page, and finds them by the finding they came from', async () => {
    const a = tenants.a;
    const created = await call(a.who.safety, 'POST', '/v1/flights', { originationKey: `${prefix}-register` });
    expect(created.statusCode, created.body).toBe(201);
    const flightId = created.json().flight.id as string;
    await submit(a, battery(flightId, 'battery-register', 11));
    const query = { subjectKind: 'flight', subjectId: flightId };
    await settle(async () => (await subjectFindings(a, query)).length > 0);
    const [finding] = await subjectFindings(a, query);
    const promoted = (
      await command(a.who.safety, openFrom(a, await shownPromotion(a, finding!.id), 'Register finding'))
    ).subject.id;
    const manual = (
      await command(a.who.safety, {
        kind: 'sms.record.open',
        record: {
          kind: 'hazard',
          schema: 'sms.hazard.1',
          title: 'Register manual hazard',
          ownerId: a.who.safety.id,
          body: {
            description: 'Identified directly.',
            consequence: 'A fictional consequence.',
            source: { kind: 'manual_identification' },
          },
        },
      })
    ).subject.id;
    const register = async (search: Record<string, string>) => {
      const response = await call(a.who.safety, 'GET', `/v1/sms/records?${new URLSearchParams(search)}`);
      expect(response.statusCode, response.body).toBe(200);
      return response.json() as SmsRegisterResponse;
    };

    const first = await register({ kind: 'hazard', limit: '1' });
    expect(first.records.map((record) => record.id)).toEqual([manual]);
    expect(first.records[0]!.origin).toEqual({ kind: 'manual' });
    expect(first).toMatchObject({ limit: 1, hasMore: true, nextCursor: manual });
    const second = await register({ kind: 'hazard', limit: '1', cursor: first.nextCursor! });
    expect(second.records.map((record) => record.id)).toEqual([promoted]);
    expect(second.records[0]!.origin).toEqual({
      kind: 'finding',
      findingId: finding!.id,
      subject: { scope: 'ledger', kind: 'flight', id: flightId },
    });

    const fromFinding = await register({ kind: 'hazard', findingId: finding!.id });
    expect(fromFinding.records.map((record) => record.id)).toEqual([promoted]);
    expect(fromFinding).toMatchObject({ hasMore: false, nextCursor: null });
    expect((await register({ kind: 'hazard', findingId: 'no-such-finding' })).records).toEqual([]);
    const unknown = await call(a.who.safety, 'GET', '/v1/sms/records?kind=hazard&cursor=no-such-record');
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.code).toBe('invalid_cursor');
    // Another organization cannot page from this organization's records.
    const elsewhere = await call(tenants.b.who.safety, 'GET', `/v1/sms/records?kind=hazard&cursor=${promoted}`);
    expect(elsewhere.statusCode).toBe(400);
  });

  it('promotes a made-up finding from a source subject, refuses stale and duplicate promotions, and lists newer evidence', async () => {
    const a = tenants.a;
    await submit(a, icing('tail-1', 'reading-1', -4));
    const first = await sourceFinding(a, 'tail-1');
    const shown = await shownPromotion(a, first.id);
    expect(shown.origin).toMatchObject({
      findingKind: 'subject',
      subject: { scope: 'source', kind: 'aircraft', id: 'tail-1', sourceId },
      rule: { packId: testPack.packId, ruleId: icingRule.id },
    });

    // The source kind follows the origin.
    const mismatched = openFrom(a, shown);
    await refused(
      a.who.safety,
      {
        ...mismatched,
        record: { ...mismatched.record, body: { ...mismatched.record.body, source: { kind: 'audit' } } },
      },
      400,
      'hazard_source_mismatch',
    );
    const opened = await command(a.who.safety, openFrom(a, shown, 'Rotor icing at the floor'));
    const id = opened.subject.id;
    // The basis is each person's own view, so a colleague promotes from what they were shown.
    const duplicate = await refused(
      a.who.colleague,
      openFrom(a, await shownPromotion(a, first.id, 'colleague')),
      409,
      'hazard_already_opened',
    );
    expect(duplicate.details?.existingRecordId).toBe(id);
    expect((await shownPromotion(a, first.id)).existingHazard).toEqual({
      recordId: id,
      title: 'Rotor icing at the floor',
    });

    // A newer reading is evaluated again; the hazard lists exactly which retained records are newer.
    const newer = await submit(a, icing('tail-1', 'reading-2', -9, '2026-11-02T10:45:00.000Z'));
    const second = await sourceFinding(a, 'tail-1', 2);
    expect(second.latestEvaluation.id).not.toBe(shown.origin.evaluationId);
    const flagged = await detail(a, id);
    expect(flagged.evidence?.sinceOpened).toMatchObject({
      pinned: { id: shown.origin.evaluationId },
      latestEvaluation: { id: second.latestEvaluation.id },
      newerEvaluation: true,
      newerRecordsTruncated: false,
      sourceProjectionPending: false,
    });
    expect(flagged.evidence!.sinceOpened.newerRecords.map((record) => record.eventId)).toEqual([newer.eventId]);
    expect(Date.parse(flagged.evidence!.sinceOpened.newerRecords[0]!.recordedAt)).toBeGreaterThan(
      Date.parse(shown.origin.evaluationRecordedAt),
    );

    // What the earlier promotion showed is now stale in both ways.
    await refused(a.who.safety, openFrom(a, shown), 409, 'stale_basis');
    const current = await shownPromotion(a, first.id);
    const staleEvaluation = openFrom(a, current);
    const stale = await refused(
      a.who.safety,
      { ...staleEvaluation, origin: { ...staleEvaluation.origin, evaluationId: shown.origin.evaluationId } },
      409,
      'stale_finding',
    );
    expect(stale.details?.currentEvaluationId).toBe(second.latestEvaluation.id);

    // The assessment pins the evaluation current at that moment and refuses an older view of it.
    await refused(
      a.who.safety,
      decide(id, flagged.basis, assessment(flagged, shown.origin.evaluationId)),
      409,
      'stale_finding',
    );
    await command(a.who.safety, decide(id, flagged.basis, assessment(flagged, second.latestEvaluation.id)));
    const assessed = await detail(a, id);
    expect(assessed.evidence?.sinceAssessed).toMatchObject({
      pinned: { id: second.latestEvaluation.id },
      newerEvaluation: false,
      newerRecords: [],
    });
    expect(assessed.evidence?.sinceOpened.newerEvaluation).toBe(true);
  });

  it('promotes a landing finding about a flight through the same origin', async () => {
    const a = tenants.a;
    // The landing checks run on the generic evaluator once the organization adopts the procedures holding them.
    const coverage = await call(a.who.safety, 'GET', '/v1/organization/coverage');
    const procedures = await call(a.who.safety, 'GET', '/v1/rule-packs/ledger.demo-procedures/versions/4');
    await command(
      a.who.safety,
      adoptShownPack(
        coverage.json() as OrganizationCoverageResponse,
        procedures.json().pack,
        { start: new Date(Date.now() - 60_000).toISOString(), end: new Date(Date.now() + 3_600_000).toISOString() },
        'Adopt the fictional flight procedures.',
        'active',
      ),
    );
    await settle();
    const created = await call(a.who.safety, 'POST', '/v1/flights', {
      originationKey: `${prefix}-flight-finding`,
      label: 'Fictional inspection',
      scheduledEnd: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(created.statusCode, created.body).toBe(201);
    const flightId = created.json().flight.id as string;
    await settle();
    for (const [source, landingTime] of [
      [`${prefix}:live`, '2026-10-15T14:20:00Z'],
      [`${prefix}:buffered`, '2026-10-15T14:22:00Z'],
    ]) {
      const response = await call(a.who.safety, 'POST', '/v1/inputs', {
        sourceId: source,
        kind: 'flight.observation',
        occurredAt: landingTime,
        subject: { flightId },
        payload: { activity: 'landed', landingTime },
      });
      expect(response.statusCode, response.body).toBe(201);
      await settle();
    }
    const onFlight = await call(a.who.safety, 'GET', `/v1/flights/${flightId}/findings`);
    expect(onFlight.statusCode, onFlight.body).toBe(200);
    const [shownOnFlight] = onFlight.json().findings as FindingRecord[];
    expect(shownOnFlight).toBeDefined();
    const query = new URLSearchParams({ subjectKind: 'flight', subjectId: flightId }).toString();
    const findings = await call(a.who.safety, 'GET', `/v1/findings?${query}`);
    expect(findings.statusCode, findings.body).toBe(200);
    const finding = (findings.json().findings as SubjectFindingRecord[]).find((item) => item.id === shownOnFlight!.id);
    expect(finding).toBeDefined();
    const shown = await shownPromotion(a, finding!.id);
    expect(shown.origin).toMatchObject({
      findingKind: 'subject',
      subject: { scope: 'ledger', kind: 'flight', id: flightId },
      evaluationId: finding!.latestEvaluation.id,
      evaluationDigest: canonicalDigest(finding!.latestEvaluation),
      rule: { packId: 'ledger.demo-procedures', ruleId: finding!.ruleId },
    });
    const id = (await command(a.who.safety, openFrom(a, shown, 'Flight finding promoted'))).subject.id;
    const hazard = await detail(a, id);
    expect(hazard.origin).toEqual(shown.origin);
    expect(hazard.evidence?.sinceOpened).toMatchObject({ newerEvaluation: false, newerRecords: [] });
    await command(a.who.safety, decide(id, hazard.basis, assessment(hazard, shown.origin.evaluationId)));
    expect((await detail(a, id)).record.status).toBe('awaiting_acceptance');
  });

  /** The proposed Part 108 pack, which reads what is on file, adopted in shadow once as the demonstration does. */
  let part108Adopted = false;
  async function adoptPart108(t: Tenant): Promise<void> {
    if (part108Adopted) return;
    part108Adopted = true;
    const a = t;
    const coverage = await call(a.who.safety, 'GET', '/v1/organization/coverage');
    const part108 = (await call(a.who.safety, 'GET', '/v1/rule-packs/ledger.part108-nprm/versions/3')).json()
      .pack as RulePackVersion;
    const parameters = Object.fromEntries(
      part108.leaves.flatMap((leaf) =>
        'adoptionParameters' in leaf && leaf.adoptionParameters.length
          ? [
              [
                leaf.id,
                Object.fromEntries(
                  leaf.adoptionParameters.map((parameter) => [
                    parameter.name,
                    parameter.valueType === 'string' ? 'UTC' : (parameter.minimum ?? 1),
                  ]),
                ),
              ],
            ]
          : [],
      ),
    );
    await command(a.who.safety, {
      ...adoptShownPack(
        coverage.json() as OrganizationCoverageResponse,
        part108,
        { start: new Date(Date.now() - 60_000).toISOString(), end: new Date(Date.now() + 3_600_000).toISOString() },
        'See what the proposed rule would find.',
        'shadow',
      ),
      parameters,
    });
    await settle();
  }

  /** A flight with two landing reports that disagree, and the finding the landing rule opens on it. */
  async function landingFinding(t: Tenant, label: string) {
    const created = await call(t.who.safety, 'POST', '/v1/flights', {
      originationKey: `${prefix}-flight-${label}`,
      label: `Fictional inspection, ${label}`,
      scheduledEnd: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(created.statusCode, created.body).toBe(201);
    const flightId = created.json().flight.id as string;
    await settle();
    const receipts: { eventId: string }[] = [];
    for (const [source, landingTime] of [
      [`${prefix}:${label}-live`, '2026-10-15T14:20:00Z'],
      [`${prefix}:${label}-buffered`, '2026-10-15T14:22:00Z'],
    ]) {
      const response = await call(t.who.safety, 'POST', '/v1/inputs', {
        sourceId: source,
        kind: 'flight.observation',
        occurredAt: landingTime,
        subject: { flightId },
        payload: { activity: 'landed', landingTime },
      });
      expect(response.statusCode, response.body).toBe(201);
      receipts.push(response.json().receipt);
      await settle();
    }
    const query = new URLSearchParams({ subjectKind: 'flight', subjectId: flightId }).toString();
    const findings = await call(t.who.safety, 'GET', `/v1/findings?${query}`);
    const finding = (findings.json().findings as SubjectFindingRecord[])[0]!;
    expect(finding).toBeDefined();
    return { flightId, finding, receipts };
  }

  it('assesses a hazard opened from a flight finding with an area control, as the mission fixture does, with the worker running between steps', async () => {
    const a = tenants.a;
    await adoptPart108(a);
    const { finding } = await landingFinding(a, 'mission');
    const shown = await shownPromotion(a, finding.id);
    await settle();
    const id = (await command(a.who.safety, openFrom(a, shown, 'Route avoidance'))).subject.id;
    const opened = await detail(a, id);
    await settle();
    const type = opened.controlTypes!.find((entry) => entry.id === 'control.avoidance-area')!;
    const controlId = (
      await command(a.who.safety, {
        kind: 'sms.record.open',
        record: {
          kind: 'control',
          schema: 'sms.control.1',
          title: 'Keep routes clear of the fictional market',
          ownerId: a.who.safety.id,
          body: {
            hazardId: id,
            controlType: { id: type.id, version: type.version, digest: type.digest },
            parameters: { center: { latitude: 41.8873, longitude: -87.6398 }, radiusMeters: 200 },
            effectiveFrom: new Date(Date.now() - 60_000).toISOString(),
          },
        },
      })
    ).subject.id;
    await settle();
    // The record read before the worker ran is still the basis the decision is made on.
    const shownBefore = await detail(a, id);
    await settle();
    await command(
      a.who.safety,
      decide(id, shownBefore.basis, {
        ...assessment(shownBefore, shown.origin.evaluationId),
        controls: [{ recordId: controlId, versionNumber: 1 }],
      }),
    );
    const assessed = await detail(a, id);
    await settle();
    expect((await detail(a, id)).basis).toEqual(assessed.basis);
  });

  it('assesses a hazard opened from a corrected landing finding with the basis read before the worker ran', async () => {
    const a = tenants.a;
    await adoptPart108(a);
    const { flightId, finding, receipts } = await landingFinding(a, 'corrected');
    // The guided correction appends a correction of the buffered report.
    const timeline = (await call(a.who.safety, 'GET', `/v1/flights/${flightId}/timeline`)).json();
    await command(a.who.safety, {
      kind: 'evidence.correct',
      flightId,
      correctionOf: receipts[1]!.eventId,
      expectedRevision: timeline.flight.revision,
      expectedBasisRevision: timeline.flight.basisRevision,
      inputCut: timeline.meta.inputCut,
      expectedDependencyBasis: timeline.meta.dependencyBasis,
      occurredAt: '2026-10-15T14:22:00Z',
      note: 'The handset clock was 30 seconds fast.',
      payload: { activity: 'landed', landingTime: '2026-10-15T14:20:00Z' },
    });
    await settle();
    const shown = await shownPromotion(a, finding.id);
    const id = (await command(a.who.safety, openFrom(a, shown, 'Landing reports disagreed'))).subject.id;
    const opened = await detail(a, id);
    await settle();
    expect((await detail(a, id)).basis).toEqual(opened.basis);
    await command(a.who.safety, decide(id, opened.basis, assessment(opened, shown.origin.evaluationId)));
    expect((await detail(a, id)).decisions.some((decision) => decision.kind === 'risk.assess')).toBe(true);
  });

  it('records report and manual origins, links flights, and lets only the owner close a hazard', async () => {
    const a = tenants.a;
    const report = await command(a.who.safety, {
      kind: 'sms.record.open',
      confidentiality: 'safety_report',
      record: {
        kind: 'report',
        schema: 'sms.report.1',
        title: 'Report of a near miss',
        ownerId: a.who.safety.id,
        body: { narrative: 'A fictional aircraft passed close to a line.', received: { channel: 'app' } },
      },
    });
    const hazard = (source: string, title: string) => ({
      kind: 'hazard',
      schema: 'sms.hazard.1',
      title,
      ownerId: a.who.safety.id,
      body: { description: 'Fictional hazard.', consequence: 'Fictional consequence.', source: { kind: source } },
    });
    await refused(
      a.who.safety,
      {
        kind: 'sms.record.open',
        record: hazard('report', 'Stale report'),
        origin: { kind: 'report', recordId: report.subject.id, versionNumber: 2 },
      },
      409,
      'stale_basis',
    );
    const fromReport = await command(a.who.safety, {
      kind: 'sms.record.open',
      record: hazard('report', 'From the near-miss report'),
      origin: { kind: 'report', recordId: report.subject.id, versionNumber: 1 },
    });
    const reported = await detail(a, fromReport.subject.id);
    expect(reported.origin).toMatchObject({ kind: 'report', recordId: report.subject.id, versionNumber: 1 });
    expect(reported.evidence).toBeUndefined();
    expect(reported.links).toMatchObject([
      { relation: 'derived_from', target: { kind: 'sms_record', id: report.subject.id } },
    ]);
    await refused(
      a.who.safety,
      { kind: 'sms.record.open', record: hazard('finding', 'Claims a finding') },
      400,
      'hazard_source_mismatch',
    );
    await refused(
      a.who.safety,
      {
        kind: 'sms.record.open',
        record: {
          ...hazard('audit', 'Not a hazard'),
          kind: 'document',
          schema: 'sms.document.1',
          body: { documentType: 'procedure', summary: 'Fictional.' },
        },
        origin: { kind: 'manual' },
      },
      400,
      'origin_not_supported',
    );
    const flight = await call(a.who.safety, 'POST', '/v1/flights', { originationKey: `${prefix}-linked` });
    const flightId = flight.json().flight.id as string;
    const manual = await command(a.who.safety, {
      kind: 'sms.record.open',
      record: {
        ...hazard('audit', 'Found during audit'),
        links: [{ relation: 'affects', target: { kind: 'flight', id: flightId } }],
      },
    });
    const shown = await detail(a, manual.subject.id);
    expect(shown.origin).toEqual({ kind: 'manual' });
    expect(shown.links).toEqual([{ relation: 'affects', target: { kind: 'flight', id: flightId } }]);
    await refused(
      a.who.safety,
      {
        kind: 'sms.record.links',
        recordId: manual.subject.id,
        expectedRevision: shown.basis.revision,
        links: [{ relation: 'affects', target: { kind: 'flight', id: `${prefix}-missing` } }],
      },
      400,
      'link_target_unavailable',
    );
    // A new version keeps the source its origin implies.
    await refused(
      a.who.safety,
      {
        kind: 'sms.record.revise',
        recordId: fromReport.subject.id,
        expectedRevision: reported.basis.revision,
        record: hazard('audit', 'From the near-miss report'),
      },
      400,
      'hazard_source_mismatch',
    );

    const byColleague = await detail(a, manual.subject.id, 'colleague');
    expect(byColleague.actions.close.available).toBe(false);
    await refused(
      a.who.colleague,
      decide(manual.subject.id, byColleague.basis, { kind: 'record.close', note: 'Not mine to close.' }),
      403,
      'owner_required',
    );
    expect(shown.actions.close.available).toBe(true);
    await command(a.who.safety, decide(manual.subject.id, shown.basis, { kind: 'record.close', note: 'Controlled.' }));
    expect((await detail(a, manual.subject.id)).record.status).toBe('closed');
  });

  it('keeps origins, promotions and newer-evidence reads inside their organization', async () => {
    const [a, b] = [tenants.a, tenants.b];
    const finding = await sourceFinding(a, 'tail-1', 2);
    expect((await promotion(b, finding.id)).statusCode).toBe(404);
    await refused(
      b.who.safety,
      openFrom(b, await shownPromotion(a, finding.id), 'Borrowed finding'),
      404,
      'finding_not_found',
    );
    const origins = await withScope(pool, a.who.safety, (client) =>
      client.query<{ record_id: string }>("SELECT record_id FROM sms_hazard_origins WHERE kind='finding'"),
    );
    expect(origins.rowCount).toBeGreaterThan(0);
    expect((await call(b.who.safety, 'GET', `/v1/sms/records/${origins.rows[0]!.record_id}`)).statusCode).toBe(404);
    const foreign = await withScope(pool, b.who.safety, (client) => client.query('SELECT id FROM sms_hazard_origins'));
    // Tenant b only holds the manual origin rows it never wrote: none.
    expect(foreign.rowCount).toBe(0);
    // A person who cannot edit safety records is not shown a promotion.
    expect((await promotion(a, finding.id, 'executive')).statusCode).toBe(403);
    // Origins are append-only.
    await expect(admin.query("UPDATE sms_hazard_origins SET kind='manual' WHERE tenant_id=$1", [a.id])).rejects.toThrow(
      /append-only/,
    );
  });
});
