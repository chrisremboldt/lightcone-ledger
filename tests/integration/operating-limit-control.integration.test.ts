import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import { adoptExampleRiskMatrix } from '../../apps/api/src/seed-risk-matrix.js';
import type {
  Capability,
  OrganizationCoverageResponse,
  SmsAssessmentOutcome,
  SmsDecisionInput,
  SmsFindingPromotionResponse,
  SmsRecordDetailResponse,
  SmsSigningPreviewResponse,
  SubjectFindingRecord,
} from '../../packages/contracts/src/index.js';
import { adoptShownPack } from '../../packages/contracts/fixtures/demo/v1/ready.js';
import { controlTypeDigest } from '../../packages/domain/src/control-types.js';
import { operatingLimitControlType } from '../../packages/domain/src/control-type-library.js';
import { sha256 } from '../../packages/integrity/src/index.js';
import { createPool, MemoryObjectStore, type AuthContext } from '../../packages/persistence/src/index.js';
import {
  BATTERY_RESERVE_LEAF_ID,
  EXAMPLE_OPERATIONS_PACK_ID,
} from '../../packages/pack-example-operations/src/index.js';
import { runOwnedWork, settleOwnedWork } from './worker-queue.js';

// A fictional organization adopts the example battery reserve rule. A low reading opens a finding, the finding becomes
// a hazard, and the hazard is accepted with an operating limit on the same reported field. The control type is the
// generic one from the library; nothing here or in core code names it beyond its registered id.
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
    ],
  },
  executive: {
    kind: 'human',
    capabilities: ['sms:read', 'sms:adopt', 'decision:write', 'evidence:read', 'risk:accept:high'],
  },
  source: { kind: 'source', capabilities: ['input:write', 'flight:read', 'evidence:read'] },
  // The worker processes an organization's work as this principal.
  worker: { kind: 'worker', capabilities: ['flight:read', 'flight:create', 'evidence:read', 'input:write'] },
};

describe.runIf(process.env.LEDGER_ENV !== 'staging')('Operating-limit control on PostgreSQL', () => {
  const prefix = `operating-limit-${randomUUID()}`;
  const tenantId = `${prefix}:org`;
  const sourceId = `${prefix}-telemetry`;
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const workerPool = createPool(process.env.WORKER_DATABASE_URL);
  const who = {} as Record<Role, AuthContext>;
  let app: Awaited<ReturnType<typeof createApp>>;
  let artifactId: string;

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
    return response.json().error as { message: string };
  }
  async function detail(id: string, role: Role = 'safety'): Promise<SmsRecordDetailResponse> {
    const response = await call(who[role], 'GET', `/v1/sms/records/${id}`);
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
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, 'Fictional limit organization']);
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
      observationGrants: [{ sourceId, observationType: 'battery.state' }],
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

  // The organization sets its reserve when it adopts the example procedure.
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

  async function submitBattery(tail: string, sourceEventId: string, percent: number) {
    const occurredAt = '2026-11-03T09:30:00.000Z';
    const response = await call(who.source, 'POST', '/v1/inputs', {
      sourceId,
      kind: 'observation',
      occurredAt,
      payload: {
        type: 'battery.state',
        version: 1,
        subject: { kind: 'aircraft', id: tail, scope: 'source' },
        occurredAt,
        sourceEventId,
        fidelity: 'synthetic_contract',
        limitations: ['Synthetic test data.'],
        values: { totalRemainingPercent: percent },
        originalArtifactId: artifactId,
      },
    });
    expect(response.statusCode, response.body).toBe(201);
  }

  async function findingFor(tail: string): Promise<SubjectFindingRecord> {
    const query = new URLSearchParams({ subjectKind: 'aircraft', subjectId: tail, subjectScope: 'source', sourceId });
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

  beforeAll(async () => {
    app = await createApp({ pool, env: 'test', objectStore: new MemoryObjectStore() });
    await app.ready();
    await createOrganization();
    artifactId = await upload();
    await adoptExamplePack(30);
    const drafter = { id: who.safety.id, token: `ledger-dev-${who.safety.id}` };
    const adopter = { token: `ledger-dev-${who.executive.id}` };
    expect(await adoptExampleRiskMatrix(app, { drafter, adopter, note: 'Adopting the fictional matrix.' })).toBe(true);
  });
  afterAll(async () => {
    await settleOwnedWork([prefix]);
    if (app) await app.close();
    await pool.end();
    await admin.end();
    await workerPool.end();
  });

  it('accepts a battery-reserve hazard with an operating limit, keeping its type and parameters', async () => {
    await submitBattery('tail-7', 'battery-1', 12);
    const finding = await findingFor('tail-7');
    expect(finding).toMatchObject({ ruleId: BATTERY_RESERVE_LEAF_ID, latestEvaluation: { outcome: 'attention' } });

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

    const opened = await detail(hazardId);
    const listed = opened.controlTypes!.find((type) => type.id === operatingLimitControlType.id)!;
    expect(listed).toMatchObject({ version: 1, checkedAutomatically: true });
    expect(listed.digest).toBe(controlTypeDigest(operatingLimitControlType));
    // The form picks the observation type and its numeric field by registered title.
    expect(listed.parameterChoices).toEqual({
      observationType: { from: 'observation_type', versionParameter: 'observationVersion' },
      field: {
        from: 'observation_numeric_field',
        typeParameter: 'observationType',
        versionParameter: 'observationVersion',
      },
    });
    expect(opened.observationTypes!.find((type) => type.type === 'battery.state')).toMatchObject({
      version: 1,
      title: 'Battery state',
      numericFields: expect.arrayContaining([
        { field: 'values.totalRemainingPercent', title: 'Battery remaining (%)' },
      ]),
    });
    const controlType = { id: listed.id, version: listed.version, digest: listed.digest };
    const parameters = {
      observationType: 'battery.state',
      observationVersion: 1,
      field: 'values.totalRemainingPercent',
      comparison: 'at_least',
      limit: 30,
      unit: 'percent',
      scope: 'subject_kind',
      subjectKind: 'aircraft',
    };
    const draft = (values: Record<string, unknown>) => ({
      kind: 'sms.record.open',
      record: {
        kind: 'control',
        schema: 'sms.control.1',
        title: 'Battery reserve of 30 percent',
        ownerId: who.safety.id,
        body: { hazardId, controlType, parameters: values, effectiveFrom: '2026-12-01T00:00:00Z' },
      },
    });
    // What can be told without a problem is refused at proposal.
    const unregistered = await refused(
      who.safety,
      draft({ ...parameters, observationType: 'toy.unregistered' }),
      400,
      'invalid_control',
    );
    expect(unregistered.message).toMatch(/not registered/);
    await refused(who.safety, draft({ ...parameters, field: 'values..remaining' }), 400, 'invalid_control');
    await refused(who.safety, draft({ ...parameters, subjectKind: 'person' }), 400, 'invalid_control');

    const control = (await command(who.safety, draft(parameters))).subject.id;
    const description =
      'Keep the reported values.totalRemainingPercent of battery.state version 1 at least 30 percent, for every aircraft.';
    expect((await detail(hazardId)).controls).toEqual([
      expect.objectContaining({
        id: control,
        parameters,
        description,
        wording: 'Keep the Battery remaining (%) of each Battery state at least 30 percent, for every aircraft.',
        accepted: false,
      }),
    ]);

    const current = await detail(hazardId);
    await command(
      who.safety,
      decide(hazardId, current.basis, {
        kind: 'risk.assess',
        note: 'Assessed against the finding evaluation shown, with the reserve limit in place.',
        matrix: { recordId: current.matrix!.record.id, versionNumber: current.matrix!.version.versionNumber },
        initial: { severity: 'major', likelihood: 'remote' },
        controls: [{ recordId: control, versionNumber: 1 }],
        residual: { severity: 'minor', likelihood: 'remote' },
        newHazardCheck: { answer: 'none_identified' },
        evidence: { evaluationId: shown.origin.evaluationId },
      }),
    );
    const assessed = await detail(hazardId);
    const assessment = assessed.decisions.find((decision) => decision.kind === 'risk.assess')!;
    expect((assessment.outcome as SmsAssessmentOutcome).controls).toEqual([
      expect.objectContaining({ recordId: control, controlType, type: 'Operating limit', description }),
    ]);

    const preview = await call(who.executive, 'GET', `/v1/sms/records/${hazardId}/signing?meaning=risk.accept`);
    expect(preview.statusCode, preview.body).toBe(200);
    const signing = preview.json() as SmsSigningPreviewResponse;
    expect(signing.available, signing.reason).toBe(true);
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
    expect(accepted.record.status).toBe('accepted');
    expect(accepted.controls![0]).toMatchObject({ id: control, accepted: true });
    // The accepted-control row pins the type; its body digest pins the version that carries the parameters.
    const rows = await admin.query(
      `SELECT a.control_type_id,a.control_type_version,a.control_type_digest,v.body->'parameters' AS parameters
       FROM accepted_hazard_controls a
       JOIN sms_record_versions v ON v.tenant_id=a.tenant_id AND v.record_id=a.control_id
         AND v.version_number=a.control_version_number AND v.body_digest=a.control_body_digest
       WHERE a.tenant_id=$1 AND a.hazard_id=$2`,
      [tenantId, hazardId],
    );
    expect(rows.rows).toEqual([
      {
        control_type_id: operatingLimitControlType.id,
        control_type_version: 1,
        control_type_digest: controlType.digest,
        parameters,
      },
    ]);
  });
});
