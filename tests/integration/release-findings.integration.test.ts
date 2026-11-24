import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import type {
  MissionAvoidanceResponse,
  MissionReleaseCommand,
  MissionReleaseFindingsResponse,
  MissionReleaseRecordResponse,
  MissionSource,
  OrganizationCoverageResponse,
  PackAdoptionCommand,
  RuleEvaluationRecord,
  RulePackVersion,
} from '../../packages/contracts/src/index.js';
import {
  MissionReleaseFindingsResponseSchema,
  MissionReleaseRecordResponseSchema,
} from '../../packages/contracts/src/index.js';
import { adoptShownPack } from '../../packages/contracts/fixtures/demo/v1/ready.js';
import { missionReleasePolicy } from '../../packages/contracts/fixtures/demo/v1/mission-release.js';
import {
  defineCheckedRule,
  findCheckKind,
  registerObservationTypes,
  registerRulePack,
} from '../../packages/domain/src/index.js';
import { canonicalDigest, sha256 } from '../../packages/integrity/src/index.js';
import { createPool, MemoryObjectStore, type AuthContext } from '../../packages/persistence/src/index.js';
import { rotorIcingObservation, rotorIcingType } from '../unit/rotor-icing-observation.js';
import { runOwnedWork, settleOwnedWork } from './worker-queue.js';

// The rules, their observation type and their pack exist only in this test.
describe.runIf(process.env.LEDGER_ENV !== 'staging')('Open findings in the release basis on PostgreSQL', () => {
  const prefix = `release-findings-${randomUUID()}`;
  const tenantId = `${prefix}:tenant`;
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const workerPool = createPool(process.env.WORKER_DATABASE_URL);
  const readingSource = `${prefix}-sensor`;
  const missionSource = `${prefix}-planner`;
  const type = 'release.icing-reading';
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validFindings = ajv.compile(MissionReleaseFindingsResponseSchema);
  const validRelease = ajv.compile(MissionReleaseRecordResponseSchema);
  let app: Awaited<ReturnType<typeof createApp>>;

  const floor = (id: string, subjectKind: 'flight' | 'aircraft', title: string) =>
    defineCheckedRule({
      id,
      version: 1,
      title,
      source: {
        kind: 'operator_procedure',
        reference: 'Fictional procedure 4.2',
        text: 'Hold while the outside air is at or below zero Celsius.',
      },
      target: { subjectKind },
      reads: [{ name: 'subject', type, versions: [1], about: 'target', required: true, select: 'latest' }],
      check: {
        kind: findCheckKind('value.within-limit', 1)!,
        params: { field: 'values.outsideAirTemperatureCelsius', comparison: 'above', limit: 0 },
      },
    });
  const content = {
    packId: `${prefix}.pack`,
    version: 1,
    title: 'Fictional icing procedure',
    status: 'draft' as const,
    review: 'ai_drafted' as const,
    adopted: false as const,
    bindings: [],
    leaves: [
      floor('test.release-flight-floor', 'flight', 'Flight air above freezing'),
      floor('test.release-aircraft-floor', 'aircraft', 'Aircraft air above freezing'),
    ],
  };
  const pack: RulePackVersion = { ...content, digest: canonicalDigest(content) };
  const base = { tenantId, revision: 1, kind: 'human', name: 'Fictional dispatcher' };
  const operator: AuthContext = {
    ...base,
    id: `${tenantId}:operator`,
    capabilities: [
      'input:write',
      'flight:create',
      'flight:read',
      'decision:write',
      'mission:release',
      'evidence:read',
      'authority:write',
      'pack:adopt',
    ],
  };
  const source: AuthContext = {
    ...base,
    id: `${tenantId}:source`,
    kind: 'source',
    capabilities: ['input:write', 'mission:write', 'flight:read', 'evidence:read'],
  };
  const worker: AuthContext = {
    ...base,
    id: `${tenantId}:worker`,
    kind: 'worker',
    capabilities: ['flight:read', 'evidence:read'],
  };
  const interval = {
    start: new Date(Date.now() - 60_000).toISOString(),
    end: new Date(Date.now() + 3_600_000).toISOString(),
  };

  function call(principal: AuthContext, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
    return app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ledger-dev-${principal.id}`,
        'idempotency-key': randomUUID(),
        ...(method === 'PUT' ? { 'content-type': 'application/octet-stream' } : {}),
      },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  }
  async function settle(): Promise<void> {
    for (let attempt = 0; attempt < 80; attempt++) {
      if (await runOwnedWork(admin, workerPool, [prefix])) continue;
      const pending = await admin.query(
        `SELECT (SELECT COUNT(*) FROM work_items w WHERE w.tenant_id=$1 AND w.state IN ('pending','leased'))
         +(SELECT COUNT(*) FROM rule_evaluation_work r WHERE r.tenant_id=$1 AND r.state IN ('pending','leased')
           AND r.due_at<=clock_timestamp()) AS count`,
        [tenantId],
      );
      if (Number(pending.rows[0].count) === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const stuck = await admin.query(
      `SELECT to_jsonb(w) AS row FROM work_items w WHERE tenant_id=$1 AND state IN ('pending','leased')
       UNION ALL SELECT to_jsonb(r) FROM rule_evaluation_work r WHERE tenant_id=$1 AND state IN ('pending','leased')`,
      [tenantId],
    );
    throw new Error(`Worker did not settle: ${JSON.stringify(stuck.rows)}`);
  }
  async function upload(bytes: Buffer): Promise<string> {
    const created = await call(source, 'POST', '/v1/uploads', {
      contentType: 'application/json',
      byteLength: bytes.byteLength,
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().upload.id as string;
    expect((await call(source, 'PUT', `/v1/uploads/${id}/content`, bytes)).statusCode).toBe(200);
    const finalized = await call(source, 'POST', `/v1/uploads/${id}/finalize`);
    expect(finalized.statusCode, finalized.body).toBe(201);
    return finalized.json().artifact.id as string;
  }
  async function grant(update: Record<string, unknown>): Promise<void> {
    const current = await call(operator, 'GET', `/v1/authority/principals/${encodeURIComponent(source.id)}`);
    expect(current.statusCode, current.body).toBe(200);
    const granted = await call(operator, 'POST', '/v1/commands', {
      kind: 'authority.update',
      principalId: source.id,
      expectedRevision: current.json().principal.revision,
      capabilities: current.json().principal.capabilities,
      ...update,
    });
    expect(granted.statusCode, granted.body).toBe(201);
  }
  async function adopt(mode: PackAdoptionCommand['mode'], revises?: string): Promise<string> {
    const shown = await call(operator, 'GET', '/v1/organization/coverage');
    expect(shown.statusCode, shown.body).toBe(200);
    const command = {
      ...adoptShownPack(
        shown.json<OrganizationCoverageResponse>(),
        pack,
        interval,
        'Fictional icing rules review.',
        mode,
      ),
      ...(revises ? { revises } : {}),
    };
    const adopted = await call(operator, 'POST', '/v1/commands', command);
    expect(adopted.statusCode, adopted.body).toBe(201);
    await settle();
    return adopted.json().command.id as string;
  }
  async function plannedFlight(): Promise<{ flightId: string; raw: MissionSource }> {
    const start = new Date(Date.now() + 60_000).toISOString();
    const end = new Date(Date.now() + 1_800_000).toISOString();
    const raw: MissionSource = {
      sourceMissionId: `${prefix}-mission`,
      sourceRevision: 1,
      aircraftId: `${prefix}-aircraft`,
      occurredAt: new Date(Date.now() - 1000).toISOString(),
      route: {
        coordinateReference: 'WGS84',
        coordinateOrder: 'longitude_latitude',
        segmentInterpolation: 'linear_longitude_latitude',
        geometry: {
          type: 'LineString',
          coordinates: [
            [-87.65, 41.88],
            [-87.6398, 41.8873],
          ],
        },
      },
      lateralToleranceMeters: 20,
      altitude: { minimum: 45, maximum: 60, unit: 'm', reference: 'AGL' },
      operatingInterval: { start, end },
    };
    const created = await call(operator, 'POST', '/v1/flights', {
      originationKey: `${prefix}:flight`,
      aircraft: raw.aircraftId,
      scheduledStart: start,
      scheduledEnd: end,
    });
    expect(created.statusCode, created.body).toBe(201);
    const flightId = created.json().flight.id as string;
    await settle();
    const { sourceRevision, occurredAt, ...payload } = raw;
    const accepted = await call(source, 'POST', '/v1/inputs', {
      kind: 'mission.revision',
      sourceId: missionSource,
      sourceRevision,
      occurredAt,
      subject: { flightId },
      artifactId: await upload(Buffer.from(`${JSON.stringify(raw)}\n`)),
      fidelity: 'synthetic_contract',
      payload,
    });
    expect(accepted.statusCode, accepted.body).toBe(201);
    await settle();
    return { flightId, raw };
  }
  async function report(flightId: string, celsius: number): Promise<void> {
    const observation = rotorIcingObservation(
      {
        subject: { kind: 'flight', id: flightId, scope: 'ledger' },
        secondarySubject: { kind: 'aircraft', id: 'tail-7', scope: 'source' },
        sourceEventId: randomUUID(),
        occurredAt: new Date(Date.now() - 1000).toISOString(),
        values: { severity: 'light', outsideAirTemperatureCelsius: celsius },
      },
      type,
    );
    delete observation.interval;
    const artifactId = await upload(Buffer.from(JSON.stringify({ entered: 'fictional reading log' })));
    const response = await call(source, 'POST', '/v1/inputs', {
      sourceId: readingSource,
      kind: 'observation',
      occurredAt: observation.occurredAt,
      payload: { ...observation, originalArtifactId: artifactId },
    });
    expect(response.statusCode, response.body).toBe(201);
    await settle();
  }
  async function findings(flightId: string): Promise<MissionReleaseFindingsResponse> {
    const response = await call(operator, 'GET', `/v1/flights/${flightId}/mission-release-findings`);
    expect(response.statusCode, response.body).toBe(200);
    expect(validFindings(response.json()), JSON.stringify(validFindings.errors)).toBe(true);
    return response.json();
  }
  async function releaseCommand(flightId: string, raw: MissionSource): Promise<MissionReleaseCommand> {
    const preview = await call(operator, 'GET', `/v1/flights/${flightId}/mission-avoidance`);
    expect(preview.statusCode, preview.body).toBe(200);
    const shown = preview.json<MissionAvoidanceResponse>();
    expect(shown.status).toBe('outside');
    const me = (await call(operator, 'GET', '/v1/me')).json().principal;
    return {
      kind: 'mission.release',
      flightId,
      aircraftId: raw.aircraftId,
      mission: shown.mission!,
      calculation: { id: shown.calculation.id, version: shown.calculation.version, digest: shown.calculation.digest },
      policy: {
        id: missionReleasePolicy.id,
        version: missionReleasePolicy.version,
        digest: missionReleasePolicy.digest,
      },
      expectedContextDigest: shown.contextDigest!,
      expectedFindingsDigest: (await findings(flightId)).basis.digest,
      expectedPrincipalRevision: me.revision,
      departureWindow: raw.operatingInterval,
      note: 'Release this fictional mission; the listed open findings were reviewed.',
    };
  }

  beforeAll(async () => {
    registerObservationTypes(rotorIcingType(type));
    registerRulePack({ packId: pack.packId, versions: [pack] });
    app = await createApp({ pool, env: 'test', objectStore: new MemoryObjectStore() });
    await app.ready();
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, 'Fictional release operator']);
    for (const principal of [operator, source, worker]) {
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
    await grant({ missionSources: [missionSource] });
    await grant({ observationGrants: [{ sourceId: readingSource, observationType: type }] });
  });
  afterAll(async () => {
    await settleOwnedWork([prefix]);
    if (app) await app.close();
    await pool.end();
    await admin.end();
    await workerPool.end();
  });

  it('lists active findings in the release basis, shows shadow ones beside it, and pins the list it recorded', async () => {
    const { flightId, raw } = await plannedFlight();
    const empty = await findings(flightId);
    expect(empty.basis.findings).toEqual([]);
    expect(empty.proposed).toEqual([]);
    expect(empty.basis.subjects.map((subject) => subject.reason).sort()).toEqual(['flight', 'organization']);

    // Proposed rules: recorded and shown, never counted.
    const shadowId = await adopt('shadow');
    await report(flightId, -4);
    const shadow = await findings(flightId);
    expect(shadow.basis.findings).toEqual([]);
    expect(shadow.basis.digest).not.toBe(empty.basis.digest);
    expect(shadow.basis.subjects).toContainEqual({
      subject: { scope: 'source', kind: 'aircraft', id: 'tail-7', sourceId: readingSource },
      subjectKey: `source/${encodeURIComponent(readingSource)}/aircraft/tail-7`,
      reason: 'named',
    });
    expect(shadow.proposed.map((finding) => finding.rule.title).sort()).toEqual([
      'Aircraft air above freezing',
      'Flight air above freezing',
    ]);
    const prepared = await releaseCommand(flightId, raw);
    expect(prepared.expectedFindingsDigest).toBe(shadow.basis.digest);

    // The same pack made active evaluates again; its findings now belong to the basis.
    await adopt('active', shadowId);
    const active = await findings(flightId);
    expect(active.proposed).toEqual([]);
    expect(active.basis.findings.map((finding) => [finding.rule.title, finding.answer.outcome]).sort()).toEqual([
      ['Aircraft air above freezing', 'attention'],
      ['Flight air above freezing', 'attention'],
    ]);
    expect(active.basis.findings.map((finding) => finding.id).sort()).toEqual(
      shadow.proposed.map((finding) => finding.id).sort(),
    );

    // A release prepared before the findings counted is refused as stale.
    const stale = await call(operator, 'POST', '/v1/commands', prepared);
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json().error.code).toBe('release_findings_changed');
    const { expectedFindingsDigest: _digest, ...unpinned } = prepared;
    const missing = await call(operator, 'POST', '/v1/commands', unpinned);
    expect(missing.statusCode, missing.body).toBe(400);
    expect(missing.json().error.code).toBe('release_findings_required');
    // A release names the one registered policy: another version is not a release command, another digest conflicts.
    const earlierPolicy = await call(operator, 'POST', '/v1/commands', {
      ...prepared,
      policy: { ...prepared.policy, version: 1 },
    });
    expect(earlierPolicy.statusCode, earlierPolicy.body).toBe(400);
    const otherPolicy = await call(operator, 'POST', '/v1/commands', {
      ...prepared,
      policy: { ...prepared.policy, digest: 'e'.repeat(64) },
    });
    expect(otherPolicy.statusCode, otherPolicy.body).toBe(409);
    expect(otherPolicy.json().error.code).toBe('release_policy_changed');

    const command = await releaseCommand(flightId, raw);
    expect(command.expectedFindingsDigest).toBe(active.basis.digest);
    const released = await call(operator, 'POST', '/v1/commands', command);
    expect(released.statusCode, released.body).toBe(201);
    await settle();
    const read = await call(operator, 'GET', `/v1/flights/${flightId}/mission-releases/${released.json().command.id}`);
    expect(read.statusCode, read.body).toBe(200);
    expect(validRelease(read.json()), JSON.stringify(validRelease.errors)).toBe(true);
    const { release } = read.json<MissionReleaseRecordResponse>();
    expect(release.version).toBe('flight.mission-release.2');
    expect(release.policy).toEqual(missionReleasePolicy);
    expect(release.basis.findings).toEqual(active.basis);
    for (const listed of release.basis.findings.findings) {
      const evaluation = await call(operator, 'GET', `/v1/evaluations/${encodeURIComponent(listed.evaluation.id)}`);
      expect(evaluation.statusCode, evaluation.body).toBe(200);
      const record = evaluation.json<{ evaluation: RuleEvaluationRecord }>().evaluation;
      expect(listed.evaluation.digest).toBe(canonicalDigest(record));
      expect(listed).toMatchObject({
        subjectKey: record.subjectKey,
        rule: { packId: pack.packId, id: record.rule.id, title: record.rule.title },
        answer: { outcome: record.outcome, evidenceState: record.evidenceState, summary: record.summary },
      });
      expect(record.adoption.mode).toBe('active');
    }
    const validity = await call(
      operator,
      'GET',
      `/v1/flights/${flightId}/mission-releases/${released.json().command.id}/validity`,
    );
    expect(validity.statusCode, validity.body).toBe(200);
    expect(['scheduled', 'current']).toContain(validity.json().status);
  });
});
