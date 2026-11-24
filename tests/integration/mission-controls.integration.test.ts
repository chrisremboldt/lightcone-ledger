import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import { adoptExampleRiskMatrix } from '../../apps/api/src/seed-risk-matrix.js';
import {
  processLease,
  processRuleSelectionLease,
  runDueRuleEvaluations,
  type WorkLease,
  type RuleSelectionLease,
} from '../../apps/workers/src/index.js';
import {
  databaseNow,
  leaseExpired,
  lockWaitStarted,
  projectOwnedWork,
  settleOwnedWork,
  withOwnedWork,
} from './worker-queue.js';
import type {
  FlightControlsResponse,
  OrganizationCoverageResponse,
  TimelineResponse,
  MissionAvoidanceResponse,
  MissionReleaseCommand,
  MissionReleaseRecordResponse,
  MissionReleaseValidityResponse,
  MissionDepartureAuthorizationCommand,
  MissionDepartureAuthorizationResponse,
  MissionDeparturePermit,
  MissionSource,
  TelemetrySegment,
  FlightPredepartureConfig,
  FlightPredepartureProgress,
  FlightPredepartureProgressResponse,
  FlightPredepartureResponse,
  SmsSigningPreviewResponse,
  MissionAvoidanceCandidate,
  MissionBriefingCommand,
  MissionBriefingRecord,
  MissionBriefingRecordResponse,
  MissionBriefingAcknowledgementCommand,
  AcceptedAreaControlResponse,
} from '../../packages/contracts/src/index.js';
import { MissionAvoidanceResponseSchema } from '../../packages/contracts/src/openapi.js';
import {
  MissionReleaseRecordResponseSchema,
  MissionReleaseValidityResponseSchema,
  MissionDepartureAuthorizationResultSchema,
} from '../../packages/contracts/src/mission-release.js';
import { adoptShownPack } from '../../packages/contracts/fixtures/demo/v1/ready.js';
import { missionSource } from '../../packages/contracts/fixtures/demo/v1/missions.js';
import { missionReleasePolicy } from '../../packages/contracts/fixtures/demo/v1/mission-release.js';
import { acceptCommand, getRulePackVersion } from '../../packages/domain/src/index.js';
import { controlTypeDigest } from '../../packages/domain/src/control-types.js';
import type { MissionDepartureIssuanceBasis } from '../../packages/domain/src/mission-departure-types.js';
import { avoidanceAreaControlType } from '../../packages/domain/src/control-type-library.js';
import { canonicalDigest, sha256 } from '../../packages/integrity/src/index.js';
import {
  appendEvent,
  createPool,
  MemoryObjectStore,
  withScope,
  type AuthContext,
  type PoolClient,
} from '../../packages/persistence/src/index.js';
import { verifyBundle } from '../../tools/verifier/index.mjs';
import {
  acceptedAreaControl,
  acceptRisk,
  assessWithControls,
  openHazard,
  proposeArea,
  readSafetyRecord,
  type AreaControlPlan,
  type PersonCall,
} from './area-control-records.js';

// Route review, release, briefing readiness and departure read accepted avoidance areas from the safety record: a
// hazard opened there carries a control record of type control.avoidance-area, assessed on the organization's adopted
// risk matrix and accepted by a person holding risk acceptance authority.
type Role = 'author' | 'source' | 'reader';
interface Fixture {
  tenantId: string;
  sourceId: string;
  worker: AuthContext;
  tokens: Record<Role, string>;
  author: string;
}
type Area = Partial<AreaControlPlan> & Pick<AreaControlPlan, 'center' | 'effectiveFrom'>;

describe.runIf(process.env.LEDGER_ENV !== 'staging')('PostgreSQL mission controls on control records', () => {
  const prefix = `mission-controls-${randomUUID()}`;
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const workerPool = createPool(process.env.WORKER_DATABASE_URL);
  const store = new MemoryObjectStore();
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  const validAvoidance = ajv.compile(MissionAvoidanceResponseSchema);
  const validReleaseRecord = ajv.compile(MissionReleaseRecordResponseSchema);
  const validReleaseValidity = ajv.compile(MissionReleaseValidityResponseSchema);
  const validDeparture = ajv.compile(MissionDepartureAuthorizationResultSchema);
  const areaType = {
    id: avoidanceAreaControlType.id,
    version: avoidanceAreaControlType.version,
    digest: controlTypeDigest(avoidanceAreaControlType),
  };
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeAll(async () => {
    const flightPredeparture: FlightPredepartureConfig = {
      version: 'flight.predeparture-config.1',
      tenants: ['ordinary-dispatch', 'ordinary-dispatch-peer', 'ordinary-dispatch-controls', 'progress-lock-order'].map(
        (name) => ({
          tenantId: `${prefix}:${name}`,
          source: {
            principalId: `${prefix}:${name}:source`,
            missionSourceId: `${prefix}:${name}:link`,
            automaticReleasePrincipalId: `${prefix}:${name}:source`,
          },
        }),
      ),
    };
    app = await createApp({ pool, env: 'test', objectStore: store, flightPredeparture });
    await app.ready();
  });
  afterAll(async () => {
    await settleOwnedWork([prefix], { objectStore: store });
    await app?.close();
    await pool.end();
    await admin.end();
    await workerPool.end();
  });
  async function fixture(name: string): Promise<Fixture> {
    const tenantId = `${prefix}:${name}`;
    const sourceId = `${tenantId}:link`;
    const tokens = {} as Record<Role, string>;
    const capabilities: Record<Role, string[]> = {
      author: [
        'flight:create',
        'flight:read',
        'decision:write',
        'evidence:read',
        'pack:adopt',
        'authority:write',
        // The author keeps the safety record and accepts risk on it.
        'sms:read',
        'sms:write',
        'sms:configure',
        'sms:adopt',
        'risk:accept:high',
      ],
      source: ['input:write', 'flight:read'],
      reader: ['flight:read'],
    };
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, 'Fictional safety operator']);
    for (const role of ['author', 'source', 'reader'] as const) {
      const id = `${tenantId}:${role}`;
      tokens[role] = `ledger-dev-${id}`;
      await admin.query('INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,$4,$5)', [
        id,
        tenantId,
        `Fictional ${role}`,
        role === 'source' ? 'source' : 'human',
        capabilities[role],
      ]);
      await admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [
        sha256(tokens[role]),
        id,
      ]);
    }
    const worker: AuthContext = {
      id: `${tenantId}:worker`,
      tenantId,
      name: 'Safety worker',
      kind: 'worker',
      // The generic evaluator reads observations as this worker.
      capabilities: ['flight:read', 'evidence:read'],
      revision: 1,
    };
    await admin.query("INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,'worker',$4)", [
      worker.id,
      tenantId,
      worker.name,
      worker.capabilities,
    ]);
    const f = { tenantId, sourceId, tokens, worker, author: `${tenantId}:author` };
    // An organization assesses a hazard only on a risk matrix it adopted.
    expect(
      await adoptExampleRiskMatrix(app, {
        drafter: { id: f.author, token: tokens.author },
        adopter: { token: tokens.author },
        note: 'Adopt the fictional risk matrix.',
      }),
    ).toBe(true);
    // A test that adopts the flight procedures over another interval itself names its fixture here.
    await adoptProcedures(f);
    return f;
  }
  async function adoptProcedures(f: Fixture, end = new Date(Date.now() + 86_400_000).toISOString()) {
    const shown = await call(f, 'GET', '/v1/organization/coverage');
    expect(shown.statusCode, shown.body).toBe(200);
    const adopted = await call(
      f,
      'POST',
      '/v1/commands',
      adoptShownPack(
        shown.json() as OrganizationCoverageResponse,
        getRulePackVersion('ledger.demo-procedures', 5)!,
        { start: new Date(Date.now() - 1000).toISOString(), end },
        'Adopt the fictional flight procedures.',
        'active',
      ),
    );
    expect(adopted.statusCode, adopted.body).toBe(201);
    await drain(f);
    await selectionDrain(f);
  }
  function call(
    f: Fixture,
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    payload?: unknown,
    role: Role = 'author',
    key = randomUUID(),
    headers: Record<string, string> = {},
  ) {
    return app.inject({
      method,
      url,
      payload,
      headers: {
        authorization: `Bearer ${f.tokens[role]}`,
        'idempotency-key': key,
        ...(method === 'PUT' ? { 'content-type': 'application/octet-stream' } : {}),
        ...headers,
      },
    });
  }
  /** The area helper's view of a person: their bearer token, a fresh idempotency key and any extra headers. */
  function person(f: Fixture, role: Role = 'author'): PersonCall {
    return (method, url, payload, headers = {}) =>
      app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${f.tokens[role]}`, 'idempotency-key': randomUUID(), ...headers },
        ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
      });
  }
  /** The author keeps the safety record and accepts the risk; a hazard is opened by hand unless a finding is named. */
  function areaPlan(f: Fixture, area: Area): AreaControlPlan {
    return {
      safety: person(f),
      safetyId: f.author,
      acceptor: person(f),
      acceptorToken: f.tokens.author,
      radiusMeters: 250,
      ...area,
    };
  }
  /** Records a new version of an area control record; route review then asks for review until it is reassessed. */
  async function reviseArea(f: Fixture, hazardId: string, controlId: string, area: Area & { title: string }) {
    const shown = await readSafetyRecord(person(f), controlId);
    const response = await call(f, 'POST', '/v1/commands', {
      kind: 'sms.record.revise',
      recordId: controlId,
      expectedRevision: shown.basis.revision,
      record: {
        kind: 'control',
        schema: 'sms.control.1',
        title: area.title,
        ownerId: f.author,
        body: {
          hazardId,
          controlType: areaType,
          parameters: { center: area.center, radiusMeters: area.radiusMeters ?? 250 },
          effectiveFrom: area.effectiveFrom,
          ...(area.effectiveUntil ? { effectiveUntil: area.effectiveUntil } : {}),
        },
      },
    });
    expect(response.statusCode, response.body).toBe(201);
  }
  async function riskAuthority(f: Fixture, level?: 'low' | 'medium' | 'high') {
    const principal = (await call(f, 'GET', '/v1/me')).json().principal;
    const capabilities = principal.capabilities.filter((capability: string) => !capability.startsWith('risk:accept:'));
    if (level) capabilities.push(`risk:accept:${level}`);
    const response = await call(f, 'POST', '/v1/commands', {
      kind: 'authority.update',
      principalId: principal.id,
      expectedRevision: principal.revision,
      capabilities,
    });
    expect(response.statusCode, response.body).toBe(201);
  }
  async function lease(f: Fixture, eventId?: string, seconds = 30): Promise<WorkLease | null> {
    return withScope(workerPool, f.worker, async (client) => {
      const row = (
        await client.query<WorkLease>(
          `SELECT w.* FROM work_items w WHERE
          (w.state='pending' OR (w.state='leased' AND w.lease_until<clock_timestamp()))
          AND ($1::text IS NULL OR w.event_id=$1)
          AND NOT EXISTS(SELECT 1 FROM work_items p WHERE p.stream_id=w.stream_id AND p.stream_sequence<w.stream_sequence AND p.state NOT IN ('completed','failed'))
          ORDER BY w.available_at,w.id LIMIT 1 FOR UPDATE`,
          [eventId ?? null],
        )
      ).rows[0];
      if (!row) return null;
      const claimed = (
        await client.query<WorkLease>(
          "UPDATE work_items SET state='leased',generation=generation+1,lease_owner=$1,lease_until=clock_timestamp()+make_interval(secs=>$3::double precision) WHERE id=$2 RETURNING *",
          [prefix, row.id, seconds],
        )
      ).rows[0];
      return { ...claimed, worker_id: f.worker.id };
    });
  }
  async function drain(f: Fixture) {
    for (let round = 0; round < 20; round++) {
      await project(f);
      // Rules an adopted pack holds run on the generic evaluator once their inputs are projected.
      if (!(await withOwnedWork(admin, [f.tenantId], () => runDueRuleEvaluations(workerPool, { limit: 100 })))) return;
    }
    throw new Error('Safety fixture evaluation did not drain');
  }
  async function project(f: Fixture) {
    await projectOwnedWork(admin, workerPool, [f.tenantId], { objectStore: store });
  }
  async function selectionDrain(f: Fixture) {
    for (let count = 0; count < 60; count++) {
      const lease = await withScope(workerPool, f.worker, async (client) => {
        const row = (
          await client.query<RuleSelectionLease>(
            "SELECT * FROM selection_work WHERE state='pending' AND available_at<=clock_timestamp() AND due_at<=clock_timestamp() ORDER BY available_at,id LIMIT 1 FOR UPDATE",
          )
        ).rows[0];
        if (!row) return null;
        const claimed = (
          await client.query<RuleSelectionLease>(
            "UPDATE selection_work SET state='leased',generation=generation+1,lease_owner=$1,lease_until=clock_timestamp()+interval '30 seconds' WHERE id=$2 RETURNING *",
            [prefix, row.id],
          )
        ).rows[0];
        return { ...claimed, worker_id: f.worker.id };
      });
      if (!lease) return;
      expect(await processRuleSelectionLease(workerPool, lease)).toBe(true);
    }
    throw new Error('Safety selection work did not drain');
  }
  async function timeline(f: Fixture, id: string): Promise<TimelineResponse> {
    const response = await call(f, 'GET', `/v1/flights/${id}/timeline`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }
  const databaseClock = async () => Date.parse(await databaseNow(admin));
  // A departure window open now on the database clock that stays open for three times the measured cost of the work
  // that must happen inside it, so the work fits however loaded the machine is. A test that needs the window closed
  // waits for its end explicitly. Below 30 seconds, a permit issued in it ends with the window.
  async function closingWindow(costMs: number): Promise<MissionReleaseCommand['departureWindow']> {
    const now = await databaseClock();
    return {
      start: new Date(now - 1000).toISOString(),
      end: new Date(now + Math.min(25_000, Math.max(2000, 3 * costMs))).toISOString(),
    };
  }

  async function departureFixture(name: string) {
    const f = await fixture(name);
    const grant = async (role: Role, capabilities: string[]) => {
      const principal = (await call(f, 'GET', '/v1/me', undefined, role)).json().principal;
      const response = await call(f, 'POST', '/v1/commands', {
        kind: 'authority.update',
        principalId: principal.id,
        expectedRevision: principal.revision,
        capabilities: [...new Set([...principal.capabilities, ...capabilities])],
        ...(role === 'source' ? { missionSources: [f.sourceId] } : {}),
      });
      expect(response.statusCode, response.body).toBe(201);
    };
    await grant('source', ['mission:write']);
    await grant('author', ['identity:write', 'mission:release']);
    await grant('reader', ['decision:write', 'mission:release']);
    await drain(f);
    const makeMission = async (label: string) => {
      const created = await call(f, 'POST', '/v1/flights', { originationKey: `${f.tenantId}:${label}` });
      expect(created.statusCode, created.body).toBe(201);
      const flightId = created.json().flight.id as string;
      await drain(f);
      const raw: MissionSource = {
        ...missionSource,
        sourceMissionId: `${f.tenantId}:${label}:mission`,
        operatingInterval: {
          start: new Date(Date.now() - 60_000).toISOString(),
          end: new Date(Date.now() + 3_600_000).toISOString(),
        },
      };
      const shown = await timeline(f, flightId);
      const assigned = await call(f, 'POST', '/v1/commands', {
        kind: 'flight.assign',
        flightId,
        aircraft: raw.aircraftId,
        expectedRevision: shown.flight.revision,
        expectedBasisRevision: shown.flight.basisRevision,
      });
      expect(assigned.statusCode, assigned.body).toBe(201);
      await drain(f);
      const submit = async (source: MissionSource) => {
        const bytes = Buffer.from(JSON.stringify(source));
        const upload = await call(
          f,
          'POST',
          '/v1/uploads',
          { byteLength: bytes.length, contentType: 'application/json' },
          'source',
        );
        expect(upload.statusCode, upload.body).toBe(201);
        const uploadId = upload.json().upload.id as string;
        expect((await call(f, 'PUT', `/v1/uploads/${uploadId}/content`, bytes, 'source')).statusCode).toBe(200);
        const artifact = await call(f, 'POST', `/v1/uploads/${uploadId}/finalize`, undefined, 'source');
        expect(artifact.statusCode, artifact.body).toBe(201);
        const { sourceRevision, occurredAt, ...payload } = source;
        const accepted = await call(
          f,
          'POST',
          '/v1/inputs',
          {
            kind: 'mission.revision',
            sourceId: f.sourceId,
            sourceRevision,
            occurredAt,
            subject: { flightId },
            artifactId: artifact.json().artifact.id,
            fidelity: 'synthetic_contract',
            payload,
          },
          'source',
        );
        expect(accepted.statusCode, accepted.body).toBe(201);
        return accepted.json().receipt;
      };
      await submit(raw);
      await drain(f);
      const release = async (window?: MissionReleaseCommand['departureWindow'], role: Role = 'author') => {
        const response = await call(f, 'GET', `/v1/flights/${flightId}/mission-avoidance`);
        expect(response.statusCode, response.body).toBe(200);
        const preview = response.json<MissionAvoidanceResponse>();
        expect(preview.status, response.body).toBe('outside');
        const principal = (await call(f, 'GET', '/v1/me', undefined, role)).json().principal;
        const findings = await call(f, 'GET', `/v1/flights/${flightId}/mission-release-findings`, undefined, role);
        expect(findings.statusCode, findings.body).toBe(200);
        const command: MissionReleaseCommand = {
          kind: 'mission.release',
          flightId,
          aircraftId: raw.aircraftId,
          mission: preview.mission!,
          calculation: {
            id: preview.calculation.id,
            version: preview.calculation.version,
            digest: preview.calculation.digest,
          },
          policy: {
            id: missionReleasePolicy.id,
            version: missionReleasePolicy.version,
            digest: missionReleasePolicy.digest,
          },
          expectedContextDigest: preview.contextDigest!,
          expectedFindingsDigest: findings.json().basis.digest,
          expectedPrincipalRevision: principal.revision,
          departureWindow: window ?? {
            start: new Date(Date.now() - 1000).toISOString(),
            end: new Date(Date.now() + 1_800_000).toISOString(),
          },
          note: 'Release this exact fictional mission before final departure authorization.',
        };
        const accepted = await call(f, 'POST', '/v1/commands', command, role);
        expect(accepted.statusCode, accepted.body).toBe(201);
        const id = accepted.json().command.id as string;
        const retained = await call(f, 'GET', `/v1/flights/${flightId}/mission-releases/${id}`);
        expect(retained.statusCode, retained.body).toBe(200);
        return retained.json<MissionReleaseRecordResponse>();
      };
      return { flightId, raw, submit, release };
    };
    const command = async (
      release: MissionReleaseRecordResponse,
      role: Role = 'author',
    ): Promise<MissionDepartureAuthorizationCommand> => {
      const principal = (await call(f, 'GET', '/v1/me', undefined, role)).json().principal;
      const controls = await call(f, 'GET', `/v1/flights/${release.release.flightId}/controls`, undefined, role);
      expect(controls.statusCode, controls.body).toBe(200);
      return {
        kind: 'mission.departure-authorize',
        flightId: release.release.flightId,
        aircraftId: release.release.aircraftId,
        release: { id: release.release.id, digest: release.digest },
        departureAttemptId: randomUUID(),
        allocation: { id: randomUUID(), digest: sha256(randomUUID()) },
        expectedPrincipalRevision: principal.revision,
        expectedControlsDigest: controls.json<FlightControlsResponse>().digest,
      };
    };
    const authorization = (response: Awaited<ReturnType<typeof call>>) => {
      expect(response.statusCode, response.body).toBe(201);
      const result = response.json<MissionDepartureAuthorizationResponse>();
      expect(validDeparture(result.authorization), JSON.stringify(validDeparture.errors)).toBe(true);
      return result;
    };
    return { f, makeMission, command, authorization, grant };
  }

  it('retains ordinary predeparture identity, unknown recovery and honest post-permit blocks outside the safety basis', async () => {
    const { f, makeMission, grant, command, authorization } = await departureFixture('ordinary-dispatch');
    const peer = await departureFixture('ordinary-dispatch-peer');
    const target = await makeMission('human');
    const path = `/v1/flights/${target.flightId}/predeparture`;
    const before = await timeline(f, target.flightId);
    const initial = await call(f, 'GET', path);
    expect(initial.statusCode, initial.body).toBe(200);
    expect(initial.json()).toMatchObject({ enabled: true, progress: null });
    expect((await call(peer.f, 'GET', path)).statusCode).toBe(404);
    const head = (await call(f, 'GET', `/v1/flights/${target.flightId}/mission`)).json().projectedHead;
    const request: FlightPredepartureProgress = {
      version: 'flight.predeparture-progress.1',
      expectedRevision: 0,
      execution: {
        runId: `${f.tenantId}:run`,
        reservationId: `${f.tenantId}:human`,
        aircraftId: target.raw.aircraftId,
        sourceMissionId: target.raw.sourceMissionId,
      },
      sourceObservedAt: initial.json<FlightPredepartureResponse>().readAt,
      phase: 'awaiting_release',
      code: 'human_release_pending',
      retryable: true,
      reason: 'This exact held mission needs a human release.',
      needsHumanReview: true,
      references: {
        mission: {
          missionId: head.missionId,
          eventId: head.id,
          sourceRevision: head.sourceRevision,
          contentDigest: head.contentDigest,
          recordDigest: canonicalDigest(head),
        },
        briefings: [],
      },
    };
    expect((await call(f, 'POST', `${path}/progress`, request)).statusCode).toBe(403);
    expect((await call(peer.f, 'POST', `${path}/progress`, request, 'source')).statusCode).toBe(404);
    const future = await call(
      f,
      'POST',
      `${path}/progress`,
      {
        ...request,
        sourceObservedAt: new Date(Date.now() + 60_000).toISOString(),
      },
      'source',
    );
    expect(future.statusCode, future.body).toBe(409);
    const key = randomUUID();
    const accepted = await call(f, 'POST', `${path}/progress`, request, 'source', key);
    expect(accepted.statusCode, accepted.body).toBe(201);
    const original = accepted.json<FlightPredepartureProgressResponse>();
    await drain(f);
    const after = await timeline(f, target.flightId);
    expect(after.flight.revision).toBe(before.flight.revision);
    expect(after.flight.basisRevision).toBe(before.flight.basisRevision);
    expect(after.items.some((item) => item.kind === 'flight.predeparture-progress')).toBe(false);
    const roster = await call(f, 'GET', '/v1/flights');
    expect(
      roster.json().flights.find((row: { id: string }) => row.id === target.flightId).operation.predeparture,
    ).toMatchObject({ phase: 'awaiting_release', needsHumanReview: true, processing: 'completed' });
    const released = await target.release();
    await drain(f);
    const ready: FlightPredepartureProgress = {
      ...request,
      expectedRevision: 1,
      phase: 'ready',
      code: 'human_review_complete',
      references: { ...request.references, release: { id: released.release.id, digest: released.digest } },
    };
    expect(
      (await call(f, 'POST', `${path}/progress`, { ...ready, needsHumanReview: false }, 'source')).statusCode,
    ).toBe(409);
    expect(
      (
        await call(
          f,
          'POST',
          `${path}/progress`,
          {
            ...ready,
            execution: { ...ready.execution, reservationId: 'another-reservation' },
          },
          'source',
        )
      ).statusCode,
    ).toBe(409);
    const raced = await Promise.all([
      call(f, 'POST', `${path}/progress`, ready, 'source'),
      call(f, 'POST', `${path}/progress`, ready, 'source'),
    ]);
    expect(raced.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    const source = (await call(f, 'GET', '/v1/me', undefined, 'source')).json().principal;
    expect(source.kind).toBe('source');
    expect(
      (
        await call(f, 'POST', '/v1/commands', {
          kind: 'authority.update',
          principalId: source.id,
          expectedRevision: source.revision,
          capabilities: source.capabilities.filter((capability: string) => capability !== 'mission:write'),
          missionSources: [],
        })
      ).statusCode,
    ).toBe(201);
    expect((await call(f, 'POST', `${path}/progress`, request, 'source', key)).json()).toEqual(original);
    expect((await call(f, 'POST', `${path}/progress`, { ...ready, expectedRevision: 2 }, 'source')).statusCode).toBe(
      403,
    );
    await grant('source', ['mission:write', 'decision:write', 'mission:release']);
    await drain(f);

    const automatic = await makeMission('automatic');
    const autoPath = `/v1/flights/${automatic.flightId}/predeparture`;
    const wrongRelease = await automatic.release();
    await drain(f);
    const auto: FlightPredepartureProgress = {
      ...request,
      execution: {
        ...request.execution,
        reservationId: `${f.tenantId}:automatic`,
        sourceMissionId: automatic.raw.sourceMissionId,
      },
      phase: 'ready',
      code: 'clear_route',
      needsHumanReview: false,
      references: {
        mission: wrongRelease.release.basis.avoidance.mission,
        release: { id: wrongRelease.release.id, digest: wrongRelease.digest },
        briefings: [],
      },
    };
    expect((await call(f, 'POST', `${autoPath}/progress`, auto, 'source')).statusCode).toBe(409);
    const serviceRelease = await automatic.release(undefined, 'source');
    await drain(f);
    auto.references.release = { id: serviceRelease.release.id, digest: serviceRelease.digest };
    const releaseAuthority = (await call(f, 'GET', '/v1/me', undefined, 'source')).json().principal;
    expect(
      (
        await call(f, 'POST', '/v1/commands', {
          kind: 'authority.update',
          principalId: releaseAuthority.id,
          expectedRevision: releaseAuthority.revision,
          capabilities: releaseAuthority.capabilities.filter((capability: string) => capability !== 'mission:release'),
        })
      ).statusCode,
    ).toBe(201);
    const unavailable = await call(f, 'POST', `${autoPath}/progress`, auto, 'source');
    expect(unavailable.statusCode, unavailable.body).toBe(409);
    expect(unavailable.json().error.code).toBe('predeparture_automatic_authority_unavailable');
    await grant('source', ['mission:release']);
    await drain(f);
    const serviceReady = await call(f, 'POST', `${autoPath}/progress`, auto, 'source');
    expect(serviceReady.statusCode, serviceReady.body).toBe(201);
    const issued = authorization(
      await call(f, 'POST', '/v1/commands', await command(serviceRelease, 'source'), 'source'),
    );
    const pending: FlightPredepartureProgress = {
      ...auto,
      expectedRevision: 1,
      phase: 'departure_unknown',
      code: 'departure_response_unknown',
      references: {
        ...auto.references,
        permit: { id: issued.authorization.permit.id, digest: issued.authorization.digest },
      },
    };
    expect((await call(f, 'POST', `${autoPath}/progress`, pending, 'source')).statusCode).toBe(201);
    // After the permit, an avoidance area away from the route is accepted on a hazard on the safety record.
    await acceptedAreaControl(
      areaPlan(f, {
        title: 'Fictional crane beside the depot',
        center: { latitude: 41.9, longitude: -87.7 },
        effectiveFrom: automatic.raw.operatingInterval.start,
        effectiveUntil: automatic.raw.operatingInterval.end,
      }),
    );
    await drain(f);
    const blocked: FlightPredepartureProgress = {
      ...pending,
      expectedRevision: 2,
      phase: 'blocked',
      code: 'accepted_control_changed',
      needsHumanReview: true,
      reason: 'A newly accepted control was found before physical departure.',
    };
    const honestBlock = await call(f, 'POST', `${autoPath}/progress`, blocked, 'source');
    expect(honestBlock.statusCode, honestBlock.body).toBe(201);
    const shown = (await call(f, 'GET', autoPath)).json<FlightPredepartureResponse>();
    expect(shown.progress).toMatchObject({ phase: 'blocked', needsHumanReview: true, references: pending.references });
    expect(shown.current.releaseValidity?.status).toBe('changed');
    expect(
      (await call(f, 'POST', `${autoPath}/progress`, { ...blocked, expectedRevision: 3, phase: 'ready' }, 'source'))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await call(
          f,
          'POST',
          `${autoPath}/progress`,
          { ...blocked, expectedRevision: 3, needsHumanReview: false },
          'source',
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await call(
          f,
          'POST',
          `${autoPath}/progress`,
          {
            ...blocked,
            expectedRevision: 3,
            references: { ...blocked.references, permit: undefined },
          },
          'source',
        )
      ).statusCode,
    ).toBe(409);
    const cut = await timeline(f, automatic.flightId);
    const note = await call(f, 'POST', '/v1/commands', {
      kind: 'decision.record',
      flightId: automatic.flightId,
      expectedRevision: cut.flight.revision,
      expectedBasisRevision: cut.flight.basisRevision,
      inputCut: cut.meta.inputCut,
      expectedDependencyBasis: cut.meta.dependencyBasis,
      decision: { kind: 'dispatch.review', note: 'Review the retained blocked execution without changing its permit.' },
    });
    expect(note.statusCode, note.body).toBe(201);
    await drain(f);
    const exported = await call(f, 'POST', '/v1/exports', {
      flightId: automatic.flightId,
      decisionId: note.json().command.id,
      scope: 'whole_tenant_prefixes',
    });
    expect(exported.statusCode, exported.body).toBe(201);
    const content = await call(f, 'GET', `/v1/exports/${exported.json().record.id}/content`);
    const bundle = content.json();
    expect(verifyBundle(bundle, { expectedManifestDigest: exported.json().record.manifestDigest }).status).toBe(
      'verified',
    );
    expect(JSON.stringify(bundle)).toContain('flight.predeparture-progress');
  });

  it('requires each applicable control briefing and actual personal acknowledgement before ordinary human readiness', async () => {
    const { f, makeMission, grant, command, authorization } = await departureFixture('ordinary-dispatch-controls');
    await grant('author', ['briefing:write', 'briefing:ack']);
    await grant('source', ['decision:write', 'mission:release']);
    const target = await makeMission('held');
    // One hazard on the safety record, accepted with two avoidance areas away from the route.
    const plan = areaPlan(f, {
      title: 'Fictional rooftop works near the route',
      center: { latitude: 41.9, longitude: -87.7 },
      effectiveFrom: target.raw.operatingInterval.start,
      effectiveUntil: target.raw.operatingInterval.end,
    });
    const hazardId = await openHazard(plan);
    const areas: string[] = [];
    for (const latitude of [41.9, 41.92])
      areas.push(await proposeArea({ ...plan, center: { latitude, longitude: -87.7 } }, hazardId));
    await acceptRisk(plan, hazardId, await assessWithControls(plan, hazardId, areas));
    await drain(f);
    const released = await target.release();
    await drain(f);
    expect(released.release.basis.avoidance.candidates).toHaveLength(2);
    expect(released.release.basis.avoidance.candidates.map((candidate) => candidate.controlId).sort()).toEqual(
      [...areas].sort(),
    );
    const path = `/v1/flights/${target.flightId}/predeparture/progress`;
    const ready: FlightPredepartureProgress = {
      version: 'flight.predeparture-progress.1',
      expectedRevision: 0,
      execution: {
        runId: `${f.tenantId}:run`,
        reservationId: `${f.tenantId}:held`,
        aircraftId: target.raw.aircraftId,
        sourceMissionId: target.raw.sourceMissionId,
      },
      sourceObservedAt: released.release.recordedAt,
      phase: 'ready',
      code: 'human_review_complete',
      retryable: true,
      reason: 'The exact held mission has completed human review.',
      needsHumanReview: true,
      references: {
        mission: released.release.basis.avoidance.mission,
        release: { id: released.release.id, digest: released.digest },
        briefings: [],
      },
    };
    expect((await call(f, 'POST', path, ready, 'source')).statusCode).toBe(409);
    for (const candidate of released.release.basis.avoidance.candidates) {
      const { hazardId, controlId, controlVersion, controlEventId, controlDigest, acceptance } = candidate;
      const principal = (await call(f, 'GET', '/v1/me')).json().principal;
      const brief = await call(f, 'POST', '/v1/commands', {
        kind: 'mission.brief',
        flightId: target.flightId,
        purpose: 'informational',
        release: ready.references.release,
        controls: [{ hazardId, controlId, controlVersion, controlEventId, controlDigest, acceptance }],
        recipientPrincipalIds: [f.author],
        message: 'Review this exact avoidance area before departure.',
        expectedPrincipalRevision: principal.revision,
        expectedControlsDigest: (
          await call(f, 'GET', `/v1/flights/${target.flightId}/controls`)
        ).json<FlightControlsResponse>().digest,
      });
      expect(brief.statusCode, brief.body).toBe(201);
      await drain(f);
      const briefing = (
        await call(f, 'GET', `/v1/flights/${target.flightId}/briefings/${brief.json().command.id}`)
      ).json();
      ready.references.briefings.push({
        controlEventId,
        briefing: { id: briefing.briefing.id, digest: briefing.digest },
      });
      expect((await call(f, 'POST', path, ready, 'source')).statusCode).toBe(409);
      const ack = await call(f, 'POST', '/v1/commands', {
        kind: 'mission.briefing-acknowledge',
        flightId: target.flightId,
        briefing: { id: briefing.briefing.id, digest: briefing.digest },
        populationDigest: briefing.briefing.population.digest,
        attestation: 'reviewed_exact_briefing',
        expectedPrincipalRevision: principal.revision,
      });
      expect(ack.statusCode, ack.body).toBe(201);
      await drain(f);
    }
    const accepted = await call(f, 'POST', path, ready, 'source');
    expect(accepted.statusCode, accepted.body).toBe(201);
    const permit = authorization(await call(f, 'POST', '/v1/commands', await command(released, 'source'), 'source'));
    const receipt = await call(
      f,
      'POST',
      '/v1/inputs',
      {
        sourceId: f.sourceId,
        kind: 'flight.observation',
        occurredAt: permit.authorization.permit.authorizedAt,
        subject: { flightId: target.flightId },
        payload: { activity: 'active', aircraft: target.raw.aircraftId, title: 'Actual fictional departure' },
      },
      'source',
    );
    expect(receipt.statusCode, receipt.body).toBe(201);
    await drain(f);
    const departed: FlightPredepartureProgress = {
      ...ready,
      expectedRevision: 1,
      sourceObservedAt: (
        await call(f, 'GET', `/v1/flights/${target.flightId}/predeparture`)
      ).json<FlightPredepartureResponse>().readAt,
      phase: 'departed',
      retryable: false,
      code: 'native_departure_retained',
      references: {
        ...ready.references,
        permit: { id: permit.authorization.permit.id, digest: permit.authorization.digest },
        departureReceipt: receipt.json().receipt.id,
      },
    };
    const complete = await call(f, 'POST', path, departed, 'source');
    expect(complete.statusCode, complete.body).toBe(201);
    expect((await call(f, 'POST', path, { ...departed, expectedRevision: 2 }, 'source')).statusCode).toBe(409);
  });

  it('covers several controls with one briefing and one personal review before ordinary human readiness and departure', async () => {
    const { f, makeMission, grant, command, authorization } = await departureFixture('ordinary-dispatch-several');
    // The configuration holds at most four tenants, so this one is configured on an app of its own.
    const configured = await createApp({
      pool,
      env: 'test',
      objectStore: store,
      flightPredeparture: {
        version: 'flight.predeparture-config.1',
        tenants: [
          {
            tenantId: f.tenantId,
            source: {
              principalId: `${f.tenantId}:source`,
              missionSourceId: f.sourceId,
              automaticReleasePrincipalId: `${f.tenantId}:source`,
            },
          },
        ],
      },
    });
    const report = (flightId: string, body: FlightPredepartureProgress) =>
      configured.inject({
        method: 'POST',
        url: `/v1/flights/${flightId}/predeparture/progress`,
        payload: body,
        headers: { authorization: `Bearer ${f.tokens.source}`, 'idempotency-key': randomUUID() },
      });
    await grant('author', ['briefing:write', 'briefing:ack']);
    await grant('source', ['decision:write', 'mission:release']);
    const target = await makeMission('held');
    const mixed = await makeMission('mixed');
    const { start, end } = target.raw.operatingInterval;
    // One hazard accepted with three avoidance areas away from the routes, and a fourth area that takes effect only
    // after these flights, so it is not a candidate of their releases.
    const plan = areaPlan(f, {
      title: 'Fictional crane works near the routes',
      center: { latitude: 41.9, longitude: -87.7 },
      effectiveFrom: start,
      effectiveUntil: new Date(Date.parse(end) + 60_000).toISOString(),
    });
    const hazardId = await openHazard(plan);
    const areas: string[] = [];
    for (const latitude of [41.9, 41.92, 41.94])
      areas.push(await proposeArea({ ...plan, center: { latitude, longitude: -87.7 } }, hazardId));
    const later = await proposeArea(
      {
        ...plan,
        center: { latitude: 41.96, longitude: -87.7 },
        effectiveFrom: new Date(Date.parse(end) + 2 * 86_400_000).toISOString(),
        effectiveUntil: new Date(Date.parse(end) + 3 * 86_400_000).toISOString(),
      },
      hazardId,
    );
    await acceptRisk(plan, hazardId, await assessWithControls(plan, hazardId, [...areas, later]));
    await drain(f);
    const released = await target.release();
    const mixedRelease = await mixed.release();
    await drain(f);
    const candidates = released.release.basis.avoidance.candidates;
    expect(candidates.map((candidate) => candidate.controlId).sort()).toEqual([...areas].sort());
    const reference = (candidate: MissionAvoidanceCandidate) => {
      const { hazardId, controlId, controlVersion, controlEventId, controlDigest, acceptance } = candidate;
      return { hazardId, controlId, controlVersion, controlEventId, controlDigest, acceptance };
    };
    const listed = candidates.map(reference);
    const laterVersion = (
      await call(f, 'GET', `/v1/area-controls/${hazardId}/${later}/versions/1`)
    ).json<AcceptedAreaControlResponse>().control;
    const notCandidate = {
      hazardId,
      controlId: later,
      controlVersion: 1,
      controlEventId: laterVersion.controlEventId,
      controlDigest: laterVersion.bodyDigest,
      acceptance: candidates[0]!.acceptance,
    };
    const briefingCommand = async (
      release: MissionReleaseRecordResponse,
      controls: unknown[],
    ): Promise<MissionBriefingCommand> => ({
      kind: 'mission.brief',
      flightId: release.release.flightId,
      purpose: 'informational',
      release: { id: release.release.id, digest: release.digest },
      controls: controls as MissionBriefingCommand['controls'],
      recipientPrincipalIds: [f.author],
      message: 'Review these exact avoidance areas before departure.',
      expectedPrincipalRevision: (await call(f, 'GET', '/v1/me')).json().principal.revision,
      expectedControlsDigest: (
        await call(f, 'GET', `/v1/flights/${release.release.flightId}/controls`)
      ).json<FlightControlsResponse>().digest,
    });
    const briefingsOf = async (flightId: string) =>
      Number(
        (
          await admin.query('SELECT COUNT(*) FROM mission_briefings WHERE tenant_id=$1 AND flight_id=$2', [
            f.tenantId,
            flightId,
          ])
        ).rows[0].count,
      );

    // The earlier command named one control; every sender now lists them, so that form is refused by name.
    const { controls: _controls, ...single } = await briefingCommand(released, listed);
    const refusals: [unknown, number, string][] = [
      [{ ...single, control: listed[0] }, 400, 'briefing_controls_required'],
      [await briefingCommand(released, [listed[0], listed[0]]), 400, 'briefing_controls_invalid'],
      [await briefingCommand(released, [...listed].reverse()), 400, 'briefing_controls_invalid'],
      [
        await briefingCommand(released, [{ ...listed[0]!, controlEventId: 'unknown-control' }]),
        409,
        'briefing_control_mismatch',
      ],
      [await briefingCommand(released, [{ ...listed[0]!, controlVersion: 2 }]), 409, 'briefing_control_mismatch'],
      [await briefingCommand(released, [...listed, notCandidate]), 409, 'briefing_control_mismatch'],
      [
        await briefingCommand(
          released,
          Array.from({ length: 65 }, (_, index) => ({ ...listed[0]!, controlEventId: `control-${index}` })),
        ),
        400,
        'invalid_request',
      ],
    ];
    for (const [body, status, code] of refusals) {
      const refused = await call(f, 'POST', '/v1/commands', body);
      expect(refused.statusCode, refused.body).toBe(status);
      expect(refused.json().error.code).toBe(code);
    }
    expect(await briefingsOf(target.flightId)).toBe(0);

    // One briefing lists all three, in the release's order, each with its own content.
    const body = await briefingCommand(released, listed);
    const brief = await call(f, 'POST', '/v1/commands', body);
    expect(brief.statusCode, brief.body).toBe(201);
    await drain(f);
    const recorded = (
      await call(f, 'GET', `/v1/flights/${target.flightId}/briefings/${brief.json().command.id}`)
    ).json<MissionBriefingRecordResponse>();
    expect(recorded.briefing.version).toBe('flight.mission-briefing.3');
    expect(recorded.briefing.context.controls).toEqual(listed);
    expect(recorded.briefing.content.controls.map((content) => content.parameters.center)).toEqual(
      candidates.map((candidate) => ({
        latitude: [41.9, 41.92, 41.94][areas.indexOf(candidate.controlId)],
        longitude: -87.7,
      })),
    );
    expect(await trigger(f, recorded.briefing)).toEqual(['accepted']);

    // The database refuses a record listing anything but exact candidates, each once and in the release's order.
    const contents = recorded.briefing.content.controls;
    for (const [controls, briefed, message] of [
      [[{ ...listed[0]!, controlEventId: 'unknown-control' }], [contents[0]!], 'not an exact released candidate'],
      [[listed[0]!, listed[0]!], [contents[0]!, contents[0]!], 'repeat or leave the release order'],
      [[listed[1]!, listed[0]!], [contents[1]!, contents[0]!], 'repeat or leave the release order'],
      [[listed[0]!, notCandidate], [contents[0]!, contents[0]!], 'not an exact released candidate'],
      [[{ ...listed[0]!, controlVersion: 2 }], [contents[0]!], 'not an exact released candidate'],
      [[listed[0]!], [{ ...contents[0]!, title: 'Another title' }], 'differs from its retained control'],
    ] as const)
      expect(
        await trigger(f, {
          ...recorded.briefing,
          context: { ...recorded.briefing.context, controls: [...controls] },
          content: { ...recorded.briefing.content, controls: [...briefed] },
        }),
      ).toEqual([expect.stringContaining(message)]);
    // More than the bound is refused by the record's own shape.
    expect(
      await trigger(f, {
        ...recorded.briefing,
        context: { ...recorded.briefing.context, controls: Array.from({ length: 65 }, () => listed[0]!) },
        content: { ...recorded.briefing.content, controls: Array.from({ length: 65 }, () => contents[0]!) },
      }),
    ).toEqual([expect.stringContaining('mission_briefings_record_identity')]);
    expect(await briefingsOf(target.flightId)).toBe(1);

    // One personal review acknowledges the briefing, hence all three controls; readiness names it for each.
    const ready: FlightPredepartureProgress = {
      version: 'flight.predeparture-progress.1',
      expectedRevision: 0,
      execution: {
        runId: `${f.tenantId}:run`,
        reservationId: `${f.tenantId}:held`,
        aircraftId: target.raw.aircraftId,
        sourceMissionId: target.raw.sourceMissionId,
      },
      sourceObservedAt: released.release.recordedAt,
      phase: 'ready',
      code: 'human_review_complete',
      retryable: true,
      reason: 'The exact held mission has completed human review.',
      needsHumanReview: true,
      references: {
        mission: released.release.basis.avoidance.mission,
        release: { id: released.release.id, digest: released.digest },
        briefings: listed.map(({ controlEventId }) => ({
          controlEventId,
          briefing: { id: recorded.briefing.id, digest: recorded.digest },
        })),
      },
    };
    expect((await report(target.flightId, ready)).statusCode).toBe(409);
    await acknowledge(f, recorded);
    // A briefing covers only the controls it lists: leaving one without a briefing still holds the flight.
    const partial = { ...ready, references: { ...ready.references, briefings: ready.references.briefings.slice(1) } };
    expect((await report(target.flightId, partial)).statusCode).toBe(409);
    const accepted = await report(target.flightId, ready);
    expect(accepted.statusCode, accepted.body).toBe(201);
    const permit = authorization(await call(f, 'POST', '/v1/commands', await command(released, 'source'), 'source'));
    expect(permit.authorization.permit.release).toEqual(ready.references.release);

    // On the other flight, one briefing covers one candidate and another briefing that lists the other two covers
    // them; each is counted as recorded.
    const mixedCandidates = mixedRelease.release.basis.avoidance.candidates.map(reference);
    const newer = await call(f, 'POST', '/v1/commands', await briefingCommand(mixedRelease, mixedCandidates.slice(1)));
    expect(newer.statusCode, newer.body).toBe(201);
    await drain(f);
    const newerRecord = (
      await call(f, 'GET', `/v1/flights/${mixed.flightId}/briefings/${newer.json().command.id}`)
    ).json<MissionBriefingRecordResponse>();
    const older = await call(
      f,
      'POST',
      '/v1/commands',
      await briefingCommand(mixedRelease, mixedCandidates.slice(0, 1)),
    );
    expect(older.statusCode, older.body).toBe(201);
    await drain(f);
    const olderRecord = (
      await call(f, 'GET', `/v1/flights/${mixed.flightId}/briefings/${older.json().command.id}`)
    ).json<MissionBriefingRecordResponse>();
    expect(olderRecord.briefing.context.controls).toEqual([mixedCandidates[0]]);
    const projected = await admin.query(
      'SELECT COUNT(*) FROM mission_briefing_projection_views WHERE tenant_id=$1 AND flight_id=$2',
      [f.tenantId, mixed.flightId],
    );
    expect(Number(projected.rows[0].count)).toBe(2);
    await acknowledge(f, olderRecord);
    await acknowledge(f, newerRecord);
    const mixedReady: FlightPredepartureProgress = {
      ...ready,
      execution: {
        ...ready.execution,
        runId: `${f.tenantId}:mixed-run`,
        reservationId: `${f.tenantId}:mixed`,
        sourceMissionId: mixed.raw.sourceMissionId,
      },
      sourceObservedAt: mixedRelease.release.recordedAt,
      references: {
        mission: mixedRelease.release.basis.avoidance.mission,
        release: { id: mixedRelease.release.id, digest: mixedRelease.digest },
        briefings: mixedCandidates.map(({ controlEventId }, index) => ({
          controlEventId,
          briefing:
            index === 0
              ? { id: olderRecord.briefing.id, digest: olderRecord.digest }
              : { id: newerRecord.briefing.id, digest: newerRecord.digest },
        })),
      },
    };
    // Naming the newer briefing for the control only the older one lists is refused.
    const misnamed = {
      ...mixedReady,
      references: {
        ...mixedReady.references,
        briefings: mixedReady.references.briefings.map((entry) => ({
          ...entry,
          briefing: { id: newerRecord.briefing.id, digest: newerRecord.digest },
        })),
      },
    };
    expect((await report(mixed.flightId, misnamed)).statusCode).toBe(409);
    const mixedAccepted = await report(mixed.flightId, mixedReady);
    expect(mixedAccepted.statusCode, mixedAccepted.body).toBe(201);
    const shown = (
      await call(f, 'GET', `/v1/flights/${mixed.flightId}/predeparture`)
    ).json<FlightPredepartureResponse>();
    expect(shown.current.briefings.map(({ acknowledged, recipients }) => [acknowledged, recipients])).toEqual([
      [1, 1],
      [1, 1],
      [1, 1],
    ]);
    await configured.close();
  });

  /** Records the author's personal review of an exact briefing and projects it. */
  const acknowledgementCommand = async (f: Fixture, briefing: MissionBriefingRecordResponse) =>
    ({
      kind: 'mission.briefing-acknowledge',
      flightId: briefing.briefing.flightId,
      briefing: { id: briefing.briefing.id, digest: briefing.digest },
      populationDigest: briefing.briefing.population.digest,
      attestation: 'reviewed_exact_briefing',
      expectedPrincipalRevision: (await call(f, 'GET', '/v1/me')).json().principal.revision,
    }) satisfies MissionBriefingAcknowledgementCommand;
  async function acknowledge(f: Fixture, briefing: MissionBriefingRecordResponse) {
    const ack = await call(f, 'POST', '/v1/commands', await acknowledgementCommand(f, briefing));
    expect(ack.statusCode, ack.body).toBe(201);
    await drain(f);
  }

  /**
   * Inserts a copy of a recorded briefing under a new journal event as its author, without the command it answers,
   * and reports how the database answered at commit: 'accepted' when the commit check found nothing wrong before
   * reaching the missing command, otherwise the refusal. The copy is never kept: a missing command refuses it.
   */
  async function trigger(f: Fixture, record: MissionBriefingRecord): Promise<string[]> {
    const row = (
      await admin.query<{ register_revision: string; valid_until: Date }>(
        'SELECT register_revision,valid_until FROM mission_briefings WHERE tenant_id=$1 AND id=$2',
        [f.tenantId, record.id],
      )
    ).rows[0]!;
    try {
      await withScope(pool, { tenantId: f.tenantId, id: f.author }, async (client, who) => {
        // A journal event and command record the copy is recorded under, without the command a briefing answers.
        const event = await appendEvent(client, who, {
          type: 'mission.brief',
          stream: `flight:${record.flightId}`,
          payload: { flightId: record.flightId },
        });
        await client.query(
          'INSERT INTO command_records(id,tenant_id,kind,flight_id,actor_id,recorded_at,payload) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [event.id, f.tenantId, 'mission.brief', record.flightId, f.author, event.received_at, event.payload],
        );
        const copy = { ...record, id: event.id, recordedAt: event.received_at.toISOString() };
        await client.query(
          'INSERT INTO mission_briefings(id,tenant_id,flight_id,organization_id,release_id,release_digest,actor_id,register_revision,valid_until,record,record_digest,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
          [
            copy.id,
            f.tenantId,
            copy.flightId,
            copy.organizationId,
            copy.context.release.id,
            copy.context.release.digest,
            f.author,
            row.register_revision,
            row.valid_until,
            copy,
            canonicalDigest(copy),
            event.received_at,
          ],
        );
      });
    } catch (failure) {
      const message = (failure as Error).message;
      return [message.includes('differs from its original journal and command') ? 'accepted' : message];
    }
    return ['kept'];
  }

  it('projects source progress while a person’s command on the same flight holds it, in one lock order', async () => {
    const { f, makeMission } = await departureFixture('progress-lock-order');
    const target = await makeMission('held');
    await drain(f);
    const path = `/v1/flights/${target.flightId}/predeparture`;
    const head = (await call(f, 'GET', `/v1/flights/${target.flightId}/mission`)).json().projectedHead;
    const progress: FlightPredepartureProgress = {
      version: 'flight.predeparture-progress.1',
      expectedRevision: 0,
      execution: {
        runId: `${f.tenantId}:run`,
        reservationId: `${f.tenantId}:held`,
        aircraftId: target.raw.aircraftId,
        sourceMissionId: target.raw.sourceMissionId,
      },
      sourceObservedAt: (await call(f, 'GET', path)).json<FlightPredepartureResponse>().readAt,
      phase: 'awaiting_route',
      code: 'accepted_control_intersection',
      retryable: true,
      reason: 'The planned corridor intersects an accepted control.',
      needsHumanReview: true,
      references: {
        mission: {
          missionId: head.missionId,
          eventId: head.id,
          sourceRevision: head.sourceRevision,
          contentDigest: head.contentDigest,
          recordDigest: canonicalDigest(head),
        },
        briefings: [],
      },
    };
    const posted = await call(f, 'POST', `${path}/progress`, progress, 'source');
    expect(posted.statusCode, posted.body).toBe(201);
    const progressLease = (await lease(f, posted.json<FlightPredepartureProgressResponse>().progress.id))!;
    const basis = await timeline(f, target.flightId);
    // The person's command locks the flight first, as every flight command does; the source's progress is projected
    // while that lock is held, and only then does the command append its live change.
    let projected: Promise<boolean> | undefined;
    const recorded = await withScope(pool, { id: f.author, tenantId: f.tenantId }, async (client, who) => {
      await client.query('SELECT id FROM flight_views WHERE id=$1 FOR UPDATE', [target.flightId]);
      projected = processLease(workerPool, progressLease, { objectStore: store });
      projected.catch(() => undefined);
      await lockWaitStarted(admin);
      return acceptCommand(client, who, {
        kind: 'decision.record',
        flightId: target.flightId,
        expectedRevision: basis.flight.revision,
        expectedBasisRevision: basis.flight.basisRevision,
        inputCut: basis.meta.inputCut,
        expectedDependencyBasis: basis.meta.dependencyBasis!,
        decision: { kind: 'reviewed', note: 'Fictional review of the held flight while its source reports progress.' },
      });
    });
    expect(recorded.kind).toBe('decision.record');
    expect(await projected).toBe(true);
    expect((await call(f, 'GET', path)).json<FlightPredepartureResponse>()).toMatchObject({
      progress: { phase: 'awaiting_route' },
      processing: 'completed',
    });
  });

  it('previews complete operative mission controls with narrow context and atomic publication', async () => {
    const f = await fixture('avoidance');
    const other = await fixture('avoidance-foreign');
    const makeFlight = async (name: string) => {
      const made = await call(f, 'POST', '/v1/flights', { originationKey: `${f.tenantId}:${name}` });
      expect(made.statusCode, made.body).toBe(201);
      await drain(f);
      return made.json().flight.id as string;
    };
    const neighbourId = await makeFlight('neighbour');
    const flightId = await makeFlight('mission');
    const path = `/v1/flights/${flightId}/mission-avoidance`;
    const preview = async (): Promise<MissionAvoidanceResponse> => {
      const shown = await call(f, 'GET', path, undefined, 'reader');
      expect(shown.statusCode, shown.body).toBe(200);
      expect(validAvoidance(shown.json()), JSON.stringify(validAvoidance.errors)).toBe(true);
      return shown.json();
    };
    const registryRevision = async () =>
      (
        await admin.query<{ revision: string }>('SELECT revision FROM mission_avoidance_register WHERE tenant_id=$1', [
          f.tenantId,
        ])
      ).rows[0].revision;
    expect((await preview()).status).toBe('insufficient');
    expect((await call(other, 'GET', path)).statusCode).toBe(404);
    const hidden = await withScope(pool, { id: other.author, tenantId: other.tenantId }, (client) =>
      client.query('SELECT revision FROM mission_avoidance_register WHERE tenant_id=$1', [f.tenantId]),
    );
    expect(hidden.rowCount).toBe(0);
    await expect(
      withScope(pool, { id: f.author, tenantId: f.tenantId }, (client) =>
        client.query('UPDATE mission_avoidance_register SET revision=revision+1 WHERE tenant_id=$1', [f.tenantId]),
      ),
    ).rejects.toThrow(/permission denied/);
    const principal = (await call(f, 'GET', '/v1/me', undefined, 'source')).json().principal;
    expect(
      (
        await call(f, 'POST', '/v1/commands', {
          kind: 'authority.update',
          principalId: principal.id,
          expectedRevision: principal.revision,
          capabilities: [...principal.capabilities, 'mission:write'],
          missionSources: [f.sourceId],
        })
      ).statusCode,
    ).toBe(201);
    const now = Date.now();
    const raw: MissionSource = {
      ...missionSource,
      sourceMissionId: `${f.tenantId}:planned`,
      operatingInterval: {
        start: new Date(now + 3_600_000).toISOString(),
        end: new Date(now + 7_200_000).toISOString(),
      },
    };
    const retainSource = async (bytes: Buffer) => {
      const made = await call(
        f,
        'POST',
        '/v1/uploads',
        { byteLength: bytes.length, contentType: 'application/json' },
        'source',
      );
      expect(made.statusCode, made.body).toBe(201);
      const id = made.json().upload.id;
      expect((await call(f, 'PUT', `/v1/uploads/${id}/content`, bytes, 'source')).statusCode).toBe(200);
      const finalized = await call(f, 'POST', `/v1/uploads/${id}/finalize`, undefined, 'source');
      expect(finalized.statusCode, finalized.body).toBe(201);
      return finalized.json().artifact.id as string;
    };
    const submitMission = async (source: MissionSource) => {
      const artifactId = await retainSource(Buffer.from(JSON.stringify(source)));
      const { sourceRevision, occurredAt, ...payload } = source;
      const accepted = await call(
        f,
        'POST',
        '/v1/inputs',
        {
          kind: 'mission.revision',
          sourceId: f.sourceId,
          sourceRevision,
          occurredAt,
          subject: { flightId },
          artifactId,
          fidelity: 'synthetic_contract',
          payload,
        },
        'source',
      );
      expect(accepted.statusCode, accepted.body).toBe(201);
      return accepted.json().receipt;
    };
    await submitMission(raw);
    expect((await preview()).status).toBe('insufficient');
    await drain(f);
    expect((await preview()).status).toBe('outside');

    // A hazard on the safety record with an area on the route's first point, in effect across the mission.
    const plan = areaPlan(f, {
      title: 'Fictional crowd at the launch site',
      center: {
        longitude: raw.route.geometry.coordinates[0][0],
        latitude: raw.route.geometry.coordinates[0][1],
      },
      effectiveFrom: new Date(now + 1_800_000).toISOString(),
      effectiveUntil: new Date(now + 10_800_000).toISOString(),
    });
    const hazardId = await openHazard(plan);
    const firstControl = await proposeArea(plan, hazardId);
    await drain(f);
    // A proposal alone is not a candidate, nor is an assessment that lists it.
    expect((await preview()).candidates).toEqual([]);
    const assessmentId = await assessWithControls(plan, hazardId, [firstControl]);
    await drain(f);
    expect((await preview()).candidates).toEqual([]);

    const signing = await call(f, 'GET', `/v1/sms/records/${hazardId}/signing?meaning=risk.accept`);
    expect(signing.statusCode, signing.body).toBe(200);
    const signed = signing.json<SmsSigningPreviewResponse>();
    expect(signed.available, signed.reason).toBe(true);
    const reauthentication = await call(f, 'POST', '/v1/local/reauthentications', { credential: f.tokens.author });
    expect(reauthentication.statusCode, reauthentication.body).toBe(201);
    const confirmed = { 'x-ledger-reauthentication': reauthentication.json().grant as string };
    const acceptance = {
      kind: 'decision.record',
      subject: { kind: 'sms', id: hazardId },
      expectedRevision: signed.basis.revision,
      expectedDependencyBasis: signed.basis.dependencyBasis,
      decision: {
        kind: 'risk.accept',
        note: 'Residual risk accepted with the launch-site area in place.',
        assessmentId,
        signature: { intent: signed.intent!, contentDigest: signed.contentDigest!, reviewed: true },
      },
    };
    const key = randomUUID();
    const beforeAcceptance = await registryRevision();
    const accepted = await call(f, 'POST', '/v1/commands', acceptance, 'author', key, confirmed);
    expect(accepted.statusCode, accepted.body).toBe(201);
    const afterAcceptance = await registryRevision();
    expect(BigInt(afterAcceptance)).toBeGreaterThan(BigInt(beforeAcceptance));
    expect((await call(f, 'POST', '/v1/commands', acceptance, 'author', key, confirmed)).json().command).toEqual(
      accepted.json().command,
    );
    expect(await registryRevision()).toBe(afterAcceptance);
    // The accepted area is read from the committed safety record, so it is current without waiting on projection.
    let shown = await preview();
    expect(shown.status).toBe('intersects');
    expect(shown.candidates).toEqual([
      expect.objectContaining({
        hazardId,
        controlId: firstControl,
        controlVersion: 1,
        template: areaType,
        assessment: expect.objectContaining({ id: assessmentId }),
        acceptance: expect.objectContaining({ id: accepted.json().command.id }),
        authority: {
          policyVersion: 'ledger.sms-decision-authority.1',
          principalId: f.author,
          principalRevision: 1,
          satisfyingCapability: 'risk:accept:high',
        },
        geometry: 'intersects',
        context: 'current',
        reasons: [],
      }),
    ]);

    // A second area on the same hazard, away from the route, is accepted with the first.
    const outsideControl = await proposeArea({ ...plan, center: { longitude: -87.7, latitude: 41.9 } }, hazardId);
    await acceptRisk(plan, hazardId, await assessWithControls(plan, hazardId, [firstControl, outsideControl]));
    await drain(f);
    shown = await preview();
    expect(shown.status).toBe('intersects');
    expect(shown.candidates).toHaveLength(2);
    expect(shown.candidates.find((item) => item.controlId === firstControl)!.geometry).toBe('intersects');
    expect(shown.candidates.find((item) => item.controlId === outsideControl)!.geometry).toBe('outside');
    const suggestion = await call(
      f,
      'POST',
      `/v1/flights/${flightId}/mission/route-suggestion`,
      {
        expectedMission: shown.mission,
        expectedContextDigest: shown.contextDigest,
        clearanceMeters: 25,
      },
      'reader',
    );
    expect(suggestion.statusCode, suggestion.body).toBe(200);
    expect(suggestion.json()).toMatchObject({
      status: 'unsupported',
      proposedRoute: null,
      reasons: ['route_planning_context_missing'],
      timeFit: { status: 'unsupported' },
    });
    expect(suggestion.json().candidates).toEqual(shown.candidates);
    const stableContext = shown.contextDigest;
    // The acceptor's later loss of risk authority does not change what was accepted, and ordinary records on another
    // flight do not touch the register.
    await riskAuthority(f);
    const neighbour = await timeline(f, neighbourId);
    const note = await call(f, 'POST', '/v1/commands', {
      kind: 'decision.record',
      flightId: neighbourId,
      expectedRevision: neighbour.flight.revision,
      expectedBasisRevision: neighbour.flight.basisRevision,
      inputCut: neighbour.meta.inputCut,
      expectedDependencyBasis: neighbour.meta.dependencyBasis,
      decision: {
        kind: 'operational.review',
        note: 'An informational review does not change the avoidance instruction.',
      },
    });
    expect(note.statusCode, note.body).toBe(201);
    await drain(f);
    expect((await preview()).contextDigest).toBe(stableContext);
    const beforeTelemetry = await registryRevision();
    const telemetryAt = new Date(now).toISOString();
    const packet = Buffer.from(
      JSON.stringify({
        tid: 'ordinary-position',
        bid: 'ordinary-batch',
        gateway: 'fictional-dock',
        timestamp: now,
        data: { latitude: 41.88, longitude: -87.63 },
      }),
    );
    const telemetry: TelemetrySegment = {
      format: 'ledger.telemetry-segment.1',
      sourceId: 'ordinary-telemetry',
      sourceSessionId: `${f.tenantId}:telemetry`,
      deviceId: 'fictional-device',
      gatewayId: 'fictional-dock',
      decoderVersion: 'dji-osd.synthetic.1',
      fidelity: 'synthetic_contract',
      coordinateReference: 'WGS84',
      sequenceBasis: 'adapter_capture',
      sessionStartSequence: 1,
      samples: [
        {
          sequence: 1,
          occurredAt: telemetryAt,
          latitude: 41.88,
          longitude: -87.63,
          altitudeMeters: null,
          altitudeReference: 'unknown',
          original: { topic: 'thing/product/fictional-device/osd', bytesBase64: packet.toString('base64') },
        },
      ],
    };
    const ordinary = await call(
      f,
      'POST',
      '/v1/inputs',
      {
        sourceId: telemetry.sourceId,
        sourceSessionId: telemetry.sourceSessionId,
        kind: 'telemetry.segment',
        occurredAt: telemetryAt,
        subject: { flightId: neighbourId },
        artifactId: await retainSource(Buffer.from(JSON.stringify(telemetry))),
        fidelity: 'synthetic_contract',
        payload: {
          format: telemetry.format,
          deviceId: telemetry.deviceId,
          gatewayId: telemetry.gatewayId,
          decoderVersion: telemetry.decoderVersion,
          sequenceBasis: telemetry.sequenceBasis,
          sessionStartSequence: 1,
          sampleCount: 1,
          firstSequence: 1,
          lastSequence: 1,
          firstOccurredAt: telemetryAt,
          lastOccurredAt: telemetryAt,
        },
      },
      'source',
    );
    expect(ordinary.statusCode, ordinary.body).toBe(201);
    await drain(f);
    expect(await registryRevision()).toBe(beforeTelemetry);
    expect((await preview()).contextDigest).toBe(stableContext);

    // A new assessment of the hazard publishes on the register: it waits for a reader holding the register and then
    // asks for review of every area accepted on the earlier assessment.
    let publication: Promise<string> | undefined;
    await withScope(pool, { id: f.author, tenantId: f.tenantId }, async (client) => {
      await client.query('SELECT id FROM flight_views WHERE id=$1 FOR SHARE', [flightId]);
      await client.query('SELECT ledger_lock_mission_avoidance_register()');
      const holder = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      publication = assessWithControls(plan, hazardId, [firstControl, outsideControl]);
      let waiting = false;
      for (let attempt = 0; attempt < 80; attempt++) {
        const blocked = await admin.query<{ waiting: boolean }>(
          'SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))) AS waiting',
          [holder],
        );
        if (blocked.rows[0].waiting) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(waiting).toBe(true);
    });
    await publication;
    shown = await preview();
    expect(shown.status).toBe('insufficient');
    expect(shown.contextDigest).not.toBe(stableContext);
    expect(shown.candidates).toHaveLength(2);
    for (const candidate of shown.candidates)
      expect(candidate).toMatchObject({ context: 'review_required', reasons: ['assessment_changed'] });
    await drain(f);

    // Areas that apply past the candidate limit leave route review incomplete. These declare no reach, so each applies.
    // A hazard's assessment lists at most 30 controls, so the areas sit on several hazards.
    await riskAuthority(f, 'high');
    await acceptRisk(
      plan,
      hazardId,
      (await readSafetyRecord(person(f), hazardId)).decisions.find((decision) => decision.kind === 'risk.assess')!.id,
    );
    expect((await preview()).candidates.every((item) => item.context === 'current')).toBe(true);
    for (const [index, size] of [30, 30, 3].entries()) {
      const more = { ...plan, title: `Fictional crowd ${index + 1} at the launch site` };
      const moreId = await openHazard(more);
      const areas: string[] = [];
      for (let count = 0; count < size; count++) areas.push(await proposeArea(more, moreId));
      await acceptRisk(more, moreId, await assessWithControls(more, moreId, areas));
    }
    await drain(f);
    shown = await preview();
    expect(shown.status).toBe('insufficient');
    expect(shown.candidateCompleteness).toEqual({
      status: 'incomplete',
      count: 65,
      limit: 64,
      considered: 65,
      consideredLimit: 512,
    });
    expect(shown.reasons).toContain('candidate_limit_exceeded');
    expect(shown.contextDigest).toBeNull();
    const higher = await submitMission({ ...raw, sourceRevision: 2 });
    await withScope(workerPool, f.worker, (client) =>
      client.query("UPDATE work_items SET state='failed' WHERE event_id=$1", [higher.eventId]),
    );
    shown = await preview();
    expect(shown.status).toBe('insufficient');
    expect(shown.mission?.sourceRevision).toBe(2);
  });

  it('records exact mission releases with narrow validity, immutable recovery and fenced projection', async () => {
    const f = await fixture('release');
    const other = await fixture('release-foreign');
    const response = await call(f, 'POST', '/v1/flights', { originationKey: `${f.tenantId}:mission` });
    expect(response.statusCode, response.body).toBe(201);
    await drain(f);
    const flightId = response.json().flight.id as string;
    const now = Date.now();
    const raw: MissionSource = {
      ...missionSource,
      sourceMissionId: `${f.tenantId}:mission`,
      operatingInterval: {
        start: new Date(now - 60_000).toISOString(),
        end: new Date(now + 3_600_000).toISOString(),
      },
    };
    const source = (await call(f, 'GET', '/v1/me', undefined, 'source')).json().principal;
    expect(
      (
        await call(f, 'POST', '/v1/commands', {
          kind: 'authority.update',
          principalId: source.id,
          expectedRevision: source.revision,
          capabilities: [...source.capabilities, 'mission:write'],
          missionSources: [f.sourceId],
        })
      ).statusCode,
    ).toBe(201);
    const grant = async (capability: 'identity:write' | 'mission:release') => {
      const principal = (await call(f, 'GET', '/v1/me')).json().principal;
      const response = await call(f, 'POST', '/v1/commands', {
        kind: 'authority.update',
        principalId: principal.id,
        expectedRevision: principal.revision,
        capabilities: [...principal.capabilities, capability],
      });
      expect(response.statusCode, response.body).toBe(201);
      await drain(f);
    };
    await grant('identity:write');
    const unassigned = await timeline(f, flightId);
    const assignment = await call(f, 'POST', '/v1/commands', {
      kind: 'flight.assign',
      flightId,
      aircraft: raw.aircraftId,
      expectedRevision: unassigned.flight.revision,
      expectedBasisRevision: unassigned.flight.basisRevision,
    });
    expect(assignment.statusCode, assignment.body).toBe(201);
    await drain(f);

    const retainSource = async (bytes: Buffer) => {
      const upload = await call(
        f,
        'POST',
        '/v1/uploads',
        { byteLength: bytes.length, contentType: 'application/json' },
        'source',
      );
      expect(upload.statusCode, upload.body).toBe(201);
      const id = upload.json().upload.id;
      expect((await call(f, 'PUT', `/v1/uploads/${id}/content`, bytes, 'source')).statusCode).toBe(200);
      const finalized = await call(f, 'POST', `/v1/uploads/${id}/finalize`, undefined, 'source');
      expect(finalized.statusCode, finalized.body).toBe(201);
      return finalized.json().artifact.id as string;
    };
    const submitMission = async (source: MissionSource) => {
      const { sourceRevision, occurredAt, ...payload } = source;
      const response = await call(
        f,
        'POST',
        '/v1/inputs',
        {
          kind: 'mission.revision',
          sourceId: f.sourceId,
          sourceRevision,
          occurredAt,
          subject: { flightId },
          artifactId: await retainSource(Buffer.from(JSON.stringify(source))),
          fidelity: 'synthetic_contract',
          payload,
        },
        'source',
      );
      expect(response.statusCode, response.body).toBe(201);
      return response.json().receipt;
    };
    await submitMission(raw);
    await drain(f);
    // A hazard on the safety record accepted with one avoidance area beside the route.
    const area = {
      title: 'Fictional rooftop works by the river',
      center: { latitude: 38.5848, longitude: -121.5045 },
      effectiveFrom: raw.operatingInterval.start,
      effectiveUntil: raw.operatingInterval.end,
    };
    const plan = areaPlan(f, area);
    const records = await acceptedAreaControl(plan);
    const { hazardId } = records;
    await drain(f);

    const preview = async (): Promise<MissionAvoidanceResponse> => {
      const response = await call(f, 'GET', `/v1/flights/${flightId}/mission-avoidance`);
      expect(response.statusCode, response.body).toBe(200);
      return response.json();
    };
    const releaseBody = async (): Promise<MissionReleaseCommand> => {
      const shown = await preview();
      const principal = (await call(f, 'GET', '/v1/me')).json().principal;
      const findings = (await call(f, 'GET', `/v1/flights/${flightId}/mission-release-findings`)).json();
      return {
        kind: 'mission.release',
        flightId,
        aircraftId: raw.aircraftId,
        mission: shown.mission!,
        calculation: {
          id: shown.calculation.id,
          version: shown.calculation.version,
          digest: shown.calculation.digest,
        },
        policy: {
          id: missionReleasePolicy.id,
          version: missionReleasePolicy.version,
          digest: missionReleasePolicy.digest,
        },
        expectedContextDigest: shown.contextDigest!,
        expectedFindingsDigest: findings.basis.digest,
        expectedPrincipalRevision: principal.revision,
        departureWindow: {
          start: new Date(now - 1000).toISOString(),
          end: new Date(now + 1_800_000).toISOString(),
        },
        note: 'Release the exact assigned mission outside the accepted avoidance circles.',
      };
    };
    expect((await preview()).status).toBe('outside');
    expect((await call(f, 'POST', '/v1/commands', await releaseBody())).statusCode).toBe(403);
    await grant('mission:release');
    const reservedPurpose = await timeline(f, flightId);
    const genericRelease = await call(f, 'POST', '/v1/commands', {
      kind: 'decision.record',
      flightId,
      expectedRevision: reservedPurpose.flight.revision,
      expectedBasisRevision: reservedPurpose.flight.basisRevision,
      inputCut: reservedPurpose.meta.inputCut,
      expectedDependencyBasis: reservedPurpose.meta.dependencyBasis,
      decision: { kind: 'mission.release', note: 'An informational note cannot release this mission.' },
    });
    expect(genericRelease.statusCode, genericRelease.body).toBe(400);
    const command = await releaseBody();
    for (const [departureWindow, status] of [
      [{ start: command.departureWindow.end, end: command.departureWindow.end }, 400],
      [
        {
          start: new Date(Date.parse(raw.operatingInterval.start) - 1).toISOString(),
          end: command.departureWindow.end,
        },
        400,
      ],
      [{ start: raw.operatingInterval.start, end: new Date(now - 10_000).toISOString() }, 409],
    ] as const) {
      const rejected = await call(f, 'POST', '/v1/commands', { ...command, departureWindow });
      expect(rejected.statusCode, rejected.body).toBe(status);
      expect(rejected.json().error.code).toBe('invalid_departure_window');
    }
    const key = randomUUID();
    const accepted = await call(f, 'POST', '/v1/commands', command, 'author', key);
    expect(accepted.statusCode, accepted.body).toBe(201);
    const releaseId = accepted.json().command.id as string;
    const path = `/v1/flights/${flightId}/mission-releases/${releaseId}`;
    const read = async (): Promise<MissionReleaseRecordResponse> => {
      const response = await call(f, 'GET', path, undefined, 'reader');
      expect(response.statusCode, response.body).toBe(200);
      expect(validReleaseRecord(response.json()), JSON.stringify(validReleaseRecord.errors)).toBe(true);
      return response.json();
    };
    const validity = async (id = releaseId): Promise<MissionReleaseValidityResponse> => {
      const response = await call(
        f,
        'GET',
        `/v1/flights/${flightId}/mission-releases/${id}/validity`,
        undefined,
        'reader',
      );
      expect(response.statusCode, response.body).toBe(200);
      expect(validReleaseValidity(response.json()), JSON.stringify(validReleaseValidity.errors)).toBe(true);
      return response.json();
    };
    const retained = await read();
    expect(retained.digest).toBe(canonicalDigest(retained.release));
    expect(retained.release).toMatchObject({
      id: releaseId,
      flightId,
      aircraftId: raw.aircraftId,
      departureWindow: command.departureWindow,
      policy: missionReleasePolicy,
      actor: {
        id: f.author,
        principalRevision: command.expectedPrincipalRevision,
        checkedCapabilities: ['decision:write', 'flight:read', 'mission:release'],
        policyVersion: 'ledger.mission-release-authority.1',
        scope: { kind: 'flight', id: flightId },
      },
    });
    expect(retained.release.actor.capabilities).toEqual(
      expect.arrayContaining(retained.release.actor.checkedCapabilities),
    );
    expect(canonicalDigest(retained.release.basis.mission)).toBe(command.mission.recordDigest);
    expect(retained.release.basis.avoidance.contextDigest).toBe(command.expectedContextDigest);
    const { previewDigest, ...retainedPreview } = retained.release.basis.avoidance;
    expect(previewDigest).toBe(canonicalDigest(retainedPreview));
    expect(command.expectedContextDigest).toBe(
      canonicalDigest({
        version: 'mission.avoidance-context.1',
        mission: command.mission,
        calculation: command.calculation,
        candidates: retainedPreview.candidates,
        notApplicable: retainedPreview.notApplicable,
        consideredTypes: retainedPreview.consideredTypes,
        candidateCompleteness: retainedPreview.candidateCompleteness,
      }),
    );
    expect(retained.release.basis.avoidance.candidates).toHaveLength(1);
    expect(retained.release.basis.candidateContexts).toHaveLength(1);
    for (const candidate of retained.release.basis.avoidance.candidates) {
      const entry = retained.release.basis.candidateContexts.find(
        (item) => item.controlEventId === candidate.controlEventId && item.acceptanceId === candidate.acceptance.id,
      )!;
      expect(entry).toBeDefined();
      expect(canonicalDigest(entry.context)).toBe(candidate.safetyContextDigest);
      // The context is the hazard's current assessment, its latest acceptance and the control record's version.
      expect(entry.context).toMatchObject({
        version: 'mission.avoidance-control-record-context.1',
        assessment: candidate.assessment,
        hazard: { id: hazardId, latestAcceptanceId: candidate.acceptance.id },
        control: { recordId: records.controlId, versionNumber: 1 },
      });
      expect(candidate).toMatchObject({
        hazardId,
        controlId: records.controlId,
        template: areaType,
        geometry: 'outside',
        context: 'current',
      });
    }
    expect(retained.release.basis.basisManifest.principalId).toBe(f.author);
    expect(retained.release.basis.basisManifest.principalRevision).toBe(command.expectedPrincipalRevision);
    expect((await validity()).status).toBe('pending');
    expect((await call(other, 'GET', path)).statusCode).toBe(404);
    expect((await call(other, 'GET', `${path}/validity`)).statusCode).toBe(404);
    const hidden = await withScope(pool, { id: other.author, tenantId: other.tenantId }, (client) =>
      client.query('SELECT id FROM mission_releases WHERE tenant_id=$1 AND id=$2', [f.tenantId, releaseId]),
    );
    expect(hidden.rowCount).toBe(0);
    await expect(admin.query('UPDATE mission_releases SET record=record WHERE id=$1', [releaseId])).rejects.toThrow(
      /append-only/,
    );

    const registerRevision = async () =>
      (
        await admin.query<{ revision: string }>('SELECT revision FROM mission_avoidance_register WHERE tenant_id=$1', [
          f.tenantId,
        ])
      ).rows[0].revision;
    const beforeReleaseProjection = await registerRevision();
    const expiredLease = (await lease(f, releaseId, 2))!;
    expect(expiredLease).toBeTruthy();
    await expect(
      processLease(workerPool, expiredLease, {
        objectStore: store,
        beforeCommit: () => leaseExpired(admin, 'work_items', expiredLease.id),
      }),
    ).rejects.toMatchObject({ code: 'worker_lease_expired' });
    expect(await registerRevision()).toBe(beforeReleaseProjection);
    expect((await timeline(f, flightId)).items.some((item) => item.id === releaseId)).toBe(false);
    expect((await validity()).status).toBe('pending');
    const reclaimed = (await lease(f, releaseId))!;
    expect(Number(reclaimed.generation)).toBeGreaterThan(Number(expiredLease.generation));
    expect(await processLease(workerPool, expiredLease, { objectStore: store })).toBe(false);
    expect(await processLease(workerPool, reclaimed, { objectStore: store })).toBe(true);
    expect(await registerRevision()).toBe(beforeReleaseProjection);
    expect((await timeline(f, flightId)).items.find((item) => item.id === releaseId)).toMatchObject({
      kind: 'mission.release',
      lane: 'checks',
      title: 'Mission route release recorded',
      actorId: f.author,
    });
    expect((await validity()).status).toBe('current');

    const scheduled = await releaseBody();
    scheduled.departureWindow = {
      start: new Date(now + 2_400_000).toISOString(),
      end: new Date(now + 3_000_000).toISOString(),
    };
    const scheduledResponse = await call(f, 'POST', '/v1/commands', scheduled);
    expect(scheduledResponse.statusCode, scheduledResponse.body).toBe(201);
    await drain(f);
    expect((await validity(scheduledResponse.json().command.id)).status).toBe('scheduled');
    const expiring = await releaseBody();
    expiring.departureWindow.end = new Date(Date.now() + 1500).toISOString();
    const expiringResponse = await call(f, 'POST', '/v1/commands', expiring);
    expect(expiringResponse.statusCode, expiringResponse.body).toBe(201);
    await drain(f);
    await admin.query('SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))+0.025)', [
      expiring.departureWindow.end,
    ]);
    expect((await validity(expiringResponse.json().command.id)).status).toBe('expired');

    const shown = await timeline(f, flightId);
    const note = await call(f, 'POST', '/v1/commands', {
      kind: 'decision.record',
      flightId,
      expectedRevision: shown.flight.revision,
      expectedBasisRevision: shown.flight.basisRevision,
      inputCut: shown.meta.inputCut,
      expectedDependencyBasis: shown.meta.dependencyBasis,
      decision: { kind: 'operational.review', note: 'An informational note does not alter the released route.' },
    });
    expect(note.statusCode, note.body).toBe(201);
    const telemetryAt = new Date().toISOString();
    const packet = Buffer.from(
      JSON.stringify({
        tid: 'release-ordinary-position',
        bid: 'release-ordinary-batch',
        gateway: 'fictional-dock',
        timestamp: Date.parse(telemetryAt),
        data: { latitude: 41.88, longitude: -87.63 },
      }),
    );
    const segment: TelemetrySegment = {
      format: 'ledger.telemetry-segment.1',
      sourceId: 'release-ordinary-telemetry',
      sourceSessionId: `${f.tenantId}:telemetry`,
      deviceId: 'fictional-device',
      gatewayId: 'fictional-dock',
      decoderVersion: 'dji-osd.synthetic.1',
      fidelity: 'synthetic_contract',
      coordinateReference: 'WGS84',
      sequenceBasis: 'adapter_capture',
      sessionStartSequence: 1,
      samples: [
        {
          sequence: 1,
          occurredAt: telemetryAt,
          latitude: 41.88,
          longitude: -87.63,
          altitudeMeters: null,
          altitudeReference: 'unknown',
          original: { topic: 'thing/product/fictional-device/osd', bytesBase64: packet.toString('base64') },
        },
      ],
    };
    const telemetry = await call(
      f,
      'POST',
      '/v1/inputs',
      {
        sourceId: segment.sourceId,
        sourceSessionId: segment.sourceSessionId,
        kind: 'telemetry.segment',
        occurredAt: telemetryAt,
        subject: { flightId },
        artifactId: await retainSource(Buffer.from(JSON.stringify(segment))),
        fidelity: 'synthetic_contract',
        payload: {
          format: segment.format,
          deviceId: segment.deviceId,
          gatewayId: segment.gatewayId,
          decoderVersion: segment.decoderVersion,
          sequenceBasis: segment.sequenceBasis,
          sessionStartSequence: 1,
          sampleCount: 1,
          firstSequence: 1,
          lastSequence: 1,
          firstOccurredAt: telemetryAt,
          lastOccurredAt: telemetryAt,
        },
      },
      'source',
    );
    expect(telemetry.statusCode, telemetry.body).toBe(201);
    await drain(f);
    expect(await validity()).toMatchObject({ status: 'current', currentContextDigest: command.expectedContextDigest });
    expect(await read()).toEqual(retained);

    const short = await releaseBody();
    let rolledBackId: string | undefined;
    await expect(
      withScope(pool, { id: f.author, tenantId: f.tenantId }, async (client, who) => {
        const clock = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now;
        short.departureWindow.end = new Date(clock.getTime() + 1000).toISOString();
        rolledBackId = (await acceptCommand(client, who, short)).id;
        await client.query(
          'SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))+0.025)',
          [short.departureWindow.end],
        );
      }),
    ).rejects.toMatchObject({ code: 'concurrent_change' });
    expect(rolledBackId).toBeDefined();
    expect((await admin.query('SELECT id FROM mission_releases WHERE id=$1', [rolledBackId])).rowCount).toBe(0);
    expect((await admin.query('SELECT id FROM work_items WHERE event_id=$1', [rolledBackId])).rowCount).toBe(0);

    // Another area accepted on the hazard changes the context a release prepared earlier was shown.
    const beforeControl = await releaseBody();
    const anotherArea = {
      ...area,
      title: 'Fictional rooftop works upstream',
      center: { latitude: 38.59, longitude: -121.51 },
    };
    const anotherControl = await proposeArea({ ...plan, ...anotherArea }, hazardId);
    await acceptRisk(plan, hazardId, await assessWithControls(plan, hazardId, [records.controlId, anotherControl]));
    expect((await call(f, 'POST', '/v1/commands', beforeControl)).statusCode).toBe(409);
    expect((await validity()).status).toBe('changed');
    await drain(f);
    // A new version of an accepted control record does too, and asks for review until it is reassessed.
    const beforeRevision = await releaseBody();
    await reviseArea(f, hazardId, anotherControl, {
      ...anotherArea,
      title: 'Fictional rooftop works upstream, revised',
    });
    expect((await call(f, 'POST', '/v1/commands', beforeRevision)).statusCode).toBe(409);
    expect((await preview()).candidates.find((item) => item.controlId === anotherControl)).toMatchObject({
      controlVersion: 1,
      context: 'review_required',
      reasons: expect.arrayContaining(['control_changed']),
    });
    const revised: MissionSource = {
      ...raw,
      sourceRevision: 2,
      operatingInterval: {
        start: new Date(now + 7_200_000).toISOString(),
        end: new Date(now + 10_800_000).toISOString(),
      },
    };
    const higher = await submitMission(revised);
    expect(higher.processing.status).toBe('pending');
    expect(await validity()).toMatchObject({ status: 'changed', currentContextDigest: null });
    const replay = await call(f, 'POST', '/v1/commands', command, 'author', key);
    expect(replay.statusCode, replay.body).toBe(201);
    expect(replay.json().command).toEqual(accepted.json().command);
    expect(await read()).toEqual(retained);
    const beforeRevocation = await validity();
    const author = (await call(f, 'GET', '/v1/me')).json().principal;
    const revoked = await call(f, 'POST', '/v1/commands', {
      kind: 'authority.update',
      principalId: author.id,
      expectedRevision: author.revision,
      capabilities: author.capabilities.filter((capability: string) => capability !== 'mission:release'),
    });
    expect(revoked.statusCode, revoked.body).toBe(201);
    const recovered = await call(f, 'POST', '/v1/commands', command, 'author', key);
    expect(recovered.statusCode, recovered.body).toBe(201);
    expect(recovered.json().command).toEqual(accepted.json().command);
    expect((await call(f, 'POST', '/v1/commands', command)).statusCode).toBe(403);
    expect(await validity()).toMatchObject({
      status: beforeRevocation.status,
      processing: beforeRevocation.processing,
      currentContextDigest: beforeRevocation.currentContextDigest,
    });
    expect(await read()).toEqual(retained);

    await grant('mission:release');
    // The first area is revised to cover the revised mission, reassessed with both and accepted again.
    await reviseArea(f, hazardId, records.controlId, {
      ...area,
      effectiveFrom: revised.operatingInterval.start,
      effectiveUntil: revised.operatingInterval.end,
    });
    await acceptRisk(plan, hazardId, await assessWithControls(plan, hazardId, [records.controlId, anotherControl]));
    await drain(f);
    const adoptedPreview = await preview();
    expect(adoptedPreview).toMatchObject({
      status: 'outside',
      mission: { sourceRevision: 2 },
      candidateCompleteness: { status: 'complete', count: 1 },
    });
    expect(adoptedPreview.candidates[0]).toMatchObject({
      controlId: records.controlId,
      controlVersion: 2,
      context: 'current',
    });
  });

  it('issues one finite departure lease with exact recovery, fixed bindings and fenced history', async () => {
    const { f, makeMission, command, authorization } = await departureFixture('departure');
    const foreign = await fixture('departure-foreign');
    const mission = await makeMission('main');
    const spare = await makeMission('spare');
    const short = await makeMission('short');
    const rollback = await makeMission('rollback');
    // Every release below carries one accepted area away from the routes, from the safety record.
    const area = await acceptedAreaControl(
      areaPlan(f, {
        title: 'Fictional stadium crowd',
        center: { latitude: 41.9, longitude: -87.7 },
        effectiveFrom: new Date(Date.now() - 120_000).toISOString(),
        effectiveUntil: new Date(Date.now() + 7_200_000).toISOString(),
      }),
    );
    await drain(f);
    const released = await mission.release();
    expect(released.release.basis.candidateContexts).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({
          version: 'mission.avoidance-control-record-context.1',
          control: expect.objectContaining({ recordId: area.controlId }),
        }),
      }),
    ]);
    const requested = await command(released);
    const pending = await call(f, 'POST', '/v1/commands', requested);
    expect(pending.statusCode, pending.body).toBe(409);
    expect(pending.json().error).toMatchObject({
      code: 'departure_release_not_current',
      details: { status: 'pending' },
    });
    await drain(f);

    const scheduledAt = await databaseClock();
    const scheduled = await spare.release({
      start: new Date(scheduledAt + 60_000).toISOString(),
      end: new Date(scheduledAt + 120_000).toISOString(),
    });
    await drain(f);
    const scheduledAttempt = await call(f, 'POST', '/v1/commands', await command(scheduled));
    const releaseCost = (await databaseClock()) - scheduledAt;
    expect(scheduledAttempt.statusCode, scheduledAttempt.body).toBe(409);
    expect(scheduledAttempt.json().error).toMatchObject({
      code: 'departure_release_not_current',
      details: { status: 'scheduled' },
    });
    const elapsed = await spare.release(await closingWindow(releaseCost));
    await drain(f);
    await admin.query('SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))+0.025)', [
      elapsed.release.departureWindow.end,
    ]);
    const expiredRelease = await call(f, 'POST', '/v1/commands', await command(elapsed));
    expect(expiredRelease.statusCode, expiredRelease.body).toBe(409);
    expect(expiredRelease.json().error).toMatchObject({
      code: 'departure_release_not_current',
      details: { status: 'expired' },
    });
    const superseded = await spare.release();
    await drain(f);
    const higher = await spare.submit({ ...spare.raw, sourceRevision: 2 });
    expect(higher.processing.status).toBe('pending');
    const changed = await call(f, 'POST', '/v1/commands', await command(superseded));
    expect(changed.statusCode, changed.body).toBe(409);
    expect(changed.json().error).toMatchObject({
      code: 'departure_release_not_current',
      details: { status: 'changed' },
    });
    await drain(f);
    const authorizationStartedAt = await databaseClock();
    const spareRelease = await spare.release();
    await drain(f);

    expect((await call(foreign, 'POST', '/v1/commands', requested)).statusCode).toBe(404);
    const keys = [randomUUID(), randomUUID()];
    const requests = [requested, await command(released)];
    const raced = await Promise.all(
      requests.map((body, index) => call(f, 'POST', '/v1/commands', body, 'author', keys[index])),
    );
    expect(raced.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    const winner = raced.findIndex((response) => response.statusCode === 201);
    expect(raced[1 - winner].json().error.code).toBe('departure_flight_already_authorized');
    const issued = authorization(raced[winner]);
    // Release, drain and authorization of one mission on this machine as it is loaded now, on the database clock.
    const authorizationCost = (await databaseClock()) - authorizationStartedAt;
    const { permit, digest } = issued.authorization;
    expect(issued.authorization.disposition).toBe('issued');
    expect(issued.command).toMatchObject({
      id: permit.id,
      kind: 'mission.departure-authorize',
      flightId: mission.flightId,
      actorId: f.author,
      payload: { permit, digest },
    });
    expect(digest).toBe(canonicalDigest(permit));
    expect(permit).toMatchObject({
      flightId: mission.flightId,
      aircraftId: mission.raw.aircraftId,
      release: { id: released.release.id, digest: released.digest },
      mission: released.release.basis.avoidance.mission,
      departureAttemptId: requests[winner].departureAttemptId,
      allocation: requests[winner].allocation,
      actor: {
        id: f.author,
        checkedCapabilities: ['decision:write', 'flight:read', 'mission:release'],
        policyVersion: 'ledger.mission-departure-authority.1',
        scope: { kind: 'flight', id: mission.flightId },
      },
    });
    expect(Date.parse(permit.validUntil) - Date.parse(permit.authorizedAt)).toBe(30_000);
    expect(issued.command.recordedAt).toBe(permit.authorizedAt);
    const retained = (
      await admin.query<{
        permit: typeof permit;
        permit_digest: string;
        issuance_basis: { release: MissionReleaseRecordResponse['release'] };
      }>(
        'SELECT permit,permit_digest,issuance_basis FROM mission_departure_authorizations WHERE tenant_id=$1 AND id=$2',
        [f.tenantId, permit.id],
      )
    ).rows[0];
    expect(retained).toMatchObject({ permit, permit_digest: digest, issuance_basis: { release: released.release } });
    expect(
      await withScope(
        pool,
        { id: foreign.author, tenantId: foreign.tenantId },
        async (client) =>
          (await client.query('SELECT id FROM mission_departure_authorizations WHERE id=$1', [permit.id])).rowCount,
      ),
    ).toBe(0);
    await expect(
      admin.query('UPDATE mission_departure_authorizations SET permit=permit WHERE id=$1', [permit.id]),
    ).rejects.toThrow('append-only');

    const binding = await command(spareRelease);
    for (const [conflict, code] of [
      [{ ...binding, departureAttemptId: permit.departureAttemptId }, 'departure_attempt_conflict'],
      [{ ...binding, allocation: permit.allocation }, 'departure_allocation_conflict'],
    ] as const) {
      const response = await call(f, 'POST', '/v1/commands', conflict);
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().error.code).toBe(code);
    }
    expect(
      (
        await admin.query('SELECT id FROM mission_departure_authorizations WHERE tenant_id=$1 AND flight_id=$2', [
          f.tenantId,
          spare.flightId,
        ])
      ).rowCount,
    ).toBe(0);

    const registerRevision = async () =>
      (
        await admin.query<{ revision: string }>('SELECT revision FROM mission_avoidance_register WHERE tenant_id=$1', [
          f.tenantId,
        ])
      ).rows[0].revision;
    const beforeProjection = await registerRevision();
    const expiredLease = (await lease(f, permit.id, 2))!;
    await expect(
      processLease(workerPool, expiredLease, {
        objectStore: store,
        beforeCommit: () => leaseExpired(admin, 'work_items', expiredLease.id),
      }),
    ).rejects.toMatchObject({ code: 'worker_lease_expired' });
    expect(
      (
        await admin.query('SELECT authorization_id FROM mission_departure_projection_views WHERE authorization_id=$1', [
          permit.id,
        ])
      ).rowCount,
    ).toBe(0);
    expect((await timeline(f, mission.flightId)).items.some((item) => item.id === permit.id)).toBe(false);
    expect(await registerRevision()).toBe(beforeProjection);
    const recoveredLease = (await lease(f, permit.id))!;
    expect(Number(recoveredLease.generation)).toBeGreaterThan(Number(expiredLease.generation));
    expect(await processLease(workerPool, expiredLease, { objectStore: store })).toBe(false);
    expect(await processLease(workerPool, recoveredLease, { objectStore: store })).toBe(true);
    expect(await registerRevision()).toBe(beforeProjection);
    expect((await timeline(f, mission.flightId)).items.find((item) => item.id === permit.id)).toMatchObject({
      kind: 'mission.departure-authorize',
      lane: 'checks',
      title: 'Departure authorization recorded',
      actorId: f.author,
    });
    expect(
      (
        await admin.query('SELECT authorization_id FROM mission_departure_projection_views WHERE authorization_id=$1', [
          permit.id,
        ])
      ).rowCount,
    ).toBe(1);

    await mission.submit({ ...mission.raw, sourceRevision: 2 });
    const principal = (await call(f, 'GET', '/v1/me')).json().principal;
    const revoked = await call(f, 'POST', '/v1/commands', {
      kind: 'authority.update',
      principalId: principal.id,
      expectedRevision: principal.revision,
      capabilities: principal.capabilities.filter((capability: string) => capability !== 'mission:release'),
    });
    expect(revoked.statusCode, revoked.body).toBe(201);
    const replayed = authorization(await call(f, 'POST', '/v1/commands', requests[winner], 'author', keys[winner]));
    expect(replayed.command).toEqual(issued.command);
    expect(replayed.authorization).toMatchObject({ permit, digest, disposition: 'replayed' });
    expect(Date.parse(replayed.authorization.evaluatedAt)).toBeGreaterThan(
      Date.parse(issued.authorization.evaluatedAt),
    );
    expect((await call(f, 'POST', '/v1/commands', requests[winner])).statusCode).toBe(403);
    const otherPrincipal = await call(f, 'POST', '/v1/commands', await command(released, 'reader'), 'reader');
    expect(otherPrincipal.statusCode, otherPrincipal.body).toBe(409);
    expect(otherPrincipal.json().error.code).toBe('departure_flight_already_authorized');
    const restore = (await call(f, 'GET', '/v1/me')).json().principal;
    expect(
      (
        await call(f, 'POST', '/v1/commands', {
          kind: 'authority.update',
          principalId: restore.id,
          expectedRevision: restore.revision,
          capabilities: [...restore.capabilities, 'mission:release'],
        })
      ).statusCode,
    ).toBe(201);
    const repeated = await call(f, 'POST', '/v1/commands', await command(released));
    expect(repeated.statusCode, repeated.body).toBe(409);
    expect(repeated.json().error.code).toBe('departure_flight_already_authorized');
    await drain(f);

    const shortRelease = await short.release(await closingWindow(authorizationCost));
    await drain(f);
    const shortBody = await command(shortRelease);
    const shortKey = randomUUID();
    const clipped = authorization(await call(f, 'POST', '/v1/commands', shortBody, 'author', shortKey));
    expect(clipped.authorization.permit.validUntil).toBe(shortRelease.release.departureWindow.end);
    expect(
      Date.parse(clipped.authorization.permit.validUntil) - Date.parse(clipped.authorization.permit.authorizedAt),
    ).toBeLessThan(30_000);
    const originalConnect = pool.connect;
    const connect = originalConnect.bind(pool);
    type ConnectCallback = Parameters<typeof pool.connect>[0];
    let delayedCommit = false;
    function delayReplayCommit(): Promise<PoolClient>;
    function delayReplayCommit(callback: ConnectCallback): void;
    function delayReplayCommit(callback?: ConnectCallback) {
      if (callback) return connect(callback);
      return connect().then(
        (client) =>
          new Proxy(client, {
            get(target, property, receiver) {
              if (property === 'query')
                return (query: unknown, ...args: unknown[]) => {
                  if (query === 'COMMIT') {
                    delayedCommit = true;
                    return target
                      .query(
                        'SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))+0.025)',
                        [clipped.authorization.permit.validUntil],
                      )
                      .then(() => target.query('COMMIT'));
                  }
                  return Reflect.apply(target.query, target, [query, ...args]);
                };
              if (property === 'release') return target.release.bind(target);
              return Reflect.get(target, property, receiver);
            },
          }),
      );
    }
    try {
      pool.connect = delayReplayCommit;
      const crossedExpiry = await call(f, 'POST', '/v1/commands', shortBody, 'author', shortKey);
      expect(delayedCommit).toBe(true);
      expect(crossedExpiry.statusCode, crossedExpiry.body).toBe(409);
      expect(crossedExpiry.json().error.code).toBe('departure_permit_expired');
    } finally {
      pool.connect = originalConnect;
    }
    const expiredReplay = await call(f, 'POST', '/v1/commands', shortBody, 'author', shortKey);
    expect(expiredReplay.statusCode, expiredReplay.body).toBe(409);
    expect(expiredReplay.json().error.code).toBe('departure_permit_expired');
    const noReplacement = await call(f, 'POST', '/v1/commands', await command(shortRelease));
    expect(noReplacement.statusCode, noReplacement.body).toBe(409);
    expect(noReplacement.json().error.code).toBe('departure_flight_already_authorized');
    expect(
      (await admin.query('SELECT permit,permit_digest FROM mission_departure_authorizations WHERE id=$1', [permit.id]))
        .rows[0],
    ).toEqual({ permit, permit_digest: digest });

    const rollbackRelease = await rollback.release(await closingWindow(authorizationCost));
    await drain(f);
    const rollbackBody = await command(rollbackRelease);
    let rolledBackId: string | undefined;
    await expect(
      withScope(pool, { id: f.author, tenantId: f.tenantId }, async (client, who) => {
        rolledBackId = (await acceptCommand(client, who, rollbackBody)).id;
        await client.query(
          'SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))+0.025)',
          [rollbackRelease.release.departureWindow.end],
        );
      }),
    ).rejects.toMatchObject({ code: 'concurrent_change' });
    expect(rolledBackId).toBeDefined();
    for (const table of ['mission_departure_authorizations', 'command_records', 'journal_events'])
      expect(
        (await admin.query(`SELECT id FROM ${table} WHERE tenant_id=$1 AND id=$2`, [f.tenantId, rolledBackId]))
          .rowCount,
      ).toBe(0);
    expect((await admin.query('SELECT id FROM work_items WHERE event_id=$1', [rolledBackId])).rowCount).toBe(0);
  });

  it('clips departure leases and commit eligibility at the next instant an accepted control starts or ends', async () => {
    // A lease never outlives the basis it was issued on. The controls in force change, without a new decision, when an
    // accepted control's effective interval starts or ends; a lease is clipped at the first such instant after issue.
    const { f, makeMission, command, authorization } = await departureFixture('departure-boundary');
    const whole = await makeMission('whole');
    const held = await makeMission('held');
    const clipped = await makeMission('clipped');
    await acceptedAreaControl(
      areaPlan(f, {
        title: 'Fictional rooftop works by the river',
        center: { latitude: 38.5848, longitude: -121.5045 },
        effectiveFrom: whole.raw.operatingInterval.start,
        effectiveUntil: whole.raw.operatingInterval.end,
      }),
    );
    await drain(f);
    // No control starts or ends inside the lease: it keeps its full thirty seconds.
    const wholeRelease = await whole.release();
    await drain(f);
    const full = authorization(await call(f, 'POST', '/v1/commands', await command(wholeRelease)));
    expect(Date.parse(full.authorization.permit.validUntil) - Date.parse(full.authorization.permit.authorizedAt)).toBe(
      30_000,
    );

    // One control ends shortly and another starts a little later, both away from the routes.
    const t0 = Date.now();
    const ending = new Date(t0 + 12_000).toISOString();
    const starting = new Date(t0 + 30_000).toISOString();
    await acceptedAreaControl(
      areaPlan(f, {
        title: 'Fictional crane lift ending soon',
        center: { latitude: 38.75, longitude: -121.75 },
        effectiveFrom: new Date(t0 - 60_000).toISOString(),
        effectiveUntil: ending,
      }),
    );
    await acceptedAreaControl(
      areaPlan(f, {
        title: 'Fictional event starting soon',
        center: { latitude: 38.76, longitude: -121.76 },
        effectiveFrom: starting,
        effectiveUntil: new Date(t0 + 3_600_000).toISOString(),
      }),
    );
    await drain(f);
    const heldRelease = await held.release();
    await drain(f);
    const validity = await call(
      f,
      'GET',
      `/v1/flights/${held.flightId}/mission-releases/${heldRelease.release.id}/validity`,
    );
    expect(validity.statusCode, validity.body).toBe(200);
    expect(Date.parse(validity.json<MissionReleaseValidityResponse>().nextBoundary!)).toBe(Date.parse(ending));

    // A lease issued now ends when the first control ends, and a commit held past that instant records nothing.
    const heldBody = await command(heldRelease);
    let heldId: string | undefined;
    await expect(
      withScope(pool, { id: f.author, tenantId: f.tenantId }, async (client, who) => {
        heldId = (await acceptCommand(client, who, heldBody)).id;
        const row = (
          await client.query<{ valid_until: Date }>(
            'SELECT valid_until FROM mission_departure_authorizations WHERE id=$1',
            [heldId],
          )
        ).rows[0];
        expect(row.valid_until.getTime()).toBe(Date.parse(ending));
        await client.query(
          'SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))+0.05)',
          [ending],
        );
      }),
    ).rejects.toThrow();
    expect(heldId).toBeDefined();
    expect((await admin.query('SELECT id FROM mission_departure_authorizations WHERE id=$1', [heldId])).rowCount).toBe(
      0,
    );

    // Once it has ended, the next instant is the other control taking effect.
    const clippedRelease = await clipped.release();
    await drain(f);
    const issued = authorization(await call(f, 'POST', '/v1/commands', await command(clippedRelease)));
    const remaining = Date.parse(starting) - Date.parse(issued.authorization.permit.authorizedAt);
    expect(Date.parse(issued.authorization.permit.validUntil)).toBe(
      remaining < 30_000 ? Date.parse(starting) : Date.parse(issued.authorization.permit.authorizedAt) + 30_000,
    );
    expect(remaining).toBeLessThan(30_000);
  });
  it('pins the empty list when no control is in scope, whether or not the command names its digest', async () => {
    const { f, makeMission, command, authorization } = await departureFixture('no-controls');
    const issuanceBasis = async (permitId: string) =>
      (await admin.query('SELECT issuance_basis FROM mission_departure_authorizations WHERE id=$1', [permitId])).rows[0]
        .issuance_basis;

    // Without the digest: accepted, and the issuance basis pins the empty list.
    const unpinned = await makeMission('unpinned');
    const unpinnedRelease = await unpinned.release();
    await drain(f);
    const empty = await call(f, 'GET', `/v1/flights/${unpinned.flightId}/controls`);
    expect(empty.statusCode, empty.body).toBe(200);
    expect(empty.json<FlightControlsResponse>()).toMatchObject({ controls: [], complete: true });
    const { expectedControlsDigest: _digest, ...withoutDigest } = await command(unpinnedRelease);
    const plain = authorization(await call(f, 'POST', '/v1/commands', withoutDigest));
    expect(await issuanceBasis(plain.authorization.permit.id)).toMatchObject({
      version: 'mission.departure-issuance.2',
      controls: { version: 'flight.controls-seen.1', controls: [], complete: true, digest: empty.json().digest },
    });

    // With the digest of the empty list: the same list, and the command names it.
    const pinned = await makeMission('pinned');
    const pinnedRelease = await pinned.release();
    await drain(f);
    const seen = (await call(f, 'GET', `/v1/flights/${pinned.flightId}/controls`)).json<FlightControlsResponse>();
    expect(seen.controls).toEqual([]);
    const body = await command(pinnedRelease);
    expect(body.expectedControlsDigest).toBe(seen.digest);
    const named = authorization(await call(f, 'POST', '/v1/commands', body));
    expect(await issuanceBasis(named.authorization.permit.id)).toMatchObject({
      version: 'mission.departure-issuance.2',
      controls: { version: 'flight.controls-seen.1', controls: [], complete: true, digest: seen.digest },
    });
    await drain(f);
  });

  // Positions by local north and east offsets in metres; close enough here for areas placed hundreds of metres apart.
  // Six decimal places, as a person places a centre.
  const offset = ([longitude, latitude]: [number, number], north: number, east: number) => ({
    latitude: Math.round((latitude + north / 111_034) * 1e6) / 1e6,
    longitude: Math.round((longitude + east / (111_320 * Math.cos((latitude * Math.PI) / 180))) * 1e6) / 1e6,
  });
  const metres = ([fromLongitude, fromLatitude]: [number, number], [toLongitude, toLatitude]: [number, number]) => ({
    north: (toLatitude - fromLatitude) * 111_034,
    east: (toLongitude - fromLongitude) * 111_320 * Math.cos((fromLatitude * Math.PI) / 180),
  });
  // 300 m from the route: the area's edge, 550 m from its centre, beside the middle of a leg.
  const beside = (from: [number, number], to: [number, number], side: 1 | -1) => {
    const { north, east } = metres(from, to);
    const length = Math.hypot(north, east);
    const middle: [number, number] = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
    return offset(middle, (-side * east * 550) / length, (side * north * 550) / length);
  };

  /** The predeparture configuration holds at most four tenants, so a test that reports readiness names its own app. */
  async function readinessApp(f: Fixture) {
    const configured = await createApp({
      pool,
      env: 'test',
      objectStore: store,
      flightPredeparture: {
        version: 'flight.predeparture-config.1',
        tenants: [
          {
            tenantId: f.tenantId,
            source: {
              principalId: `${f.tenantId}:source`,
              missionSourceId: f.sourceId,
              automaticReleasePrincipalId: `${f.tenantId}:source`,
            },
          },
        ],
      },
    });
    const report = (flightId: string, body: FlightPredepartureProgress) =>
      configured.inject({
        method: 'POST',
        url: `/v1/flights/${flightId}/predeparture/progress`,
        payload: body,
        headers: { authorization: `Bearer ${f.tokens.source}`, 'idempotency-key': randomUUID() },
      });
    return { configured, report };
  }

  it('lists the 2 controls that apply among 102 considered, and the third a detour brings near', async () => {
    const { f, makeMission, grant } = await departureFixture('applicability-acceptance');
    const { configured, report } = await readinessApp(f);
    await grant('author', ['briefing:write', 'briefing:ack']);
    await grant('source', ['decision:write', 'mission:release']);
    const target = await makeMission('held');
    const { start, end } = target.raw.operatingInterval;
    const [a, b, c] = target.raw.route.geometry.coordinates as [number, number][];
    const near = [beside(a, b, 1), beside(b, c, -1)];
    // One area 21 km south of the route's start, which a later detour comes within 200 m of, and 99 in a grid about
    // 35 km away: all at least 20 km from the route.
    const detoured = offset(a, -21_000, 0);
    const grid = Array.from({ length: 99 }, (_, index) =>
      offset(a, 25_000 + Math.floor(index / 10) * 1000, -25_000 + (index % 10) * 1000),
    );
    const centres = [...near, detoured, ...grid];
    const plan = areaPlan(f, {
      title: 'Fictional survey works around the region',
      center: centres[0]!,
      appliesWithinMeters: 500,
      effectiveFrom: start,
      effectiveUntil: end,
    });
    // An assessment relies on at most 30 controls, so the 102 areas are accepted on four hazards.
    const controlIds: string[] = [];
    for (let first = 0; first < centres.length; first += 30) {
      const hazardId = await openHazard(plan);
      const proposed: string[] = [];
      for (const center of centres.slice(first, first + 30))
        proposed.push(await proposeArea({ ...plan, center }, hazardId));
      await acceptRisk(plan, hazardId, await assessWithControls(plan, hazardId, proposed));
      controlIds.push(...proposed);
    }
    await drain(f);
    const [nearIds, detouredId] = [controlIds.slice(0, 2), controlIds[2]!];

    const reviewStarted = Date.now();
    const reviewed = await call(f, 'GET', `/v1/flights/${target.flightId}/mission-avoidance`);
    const reviewMs = Date.now() - reviewStarted;
    expect(reviewed.statusCode, reviewed.body).toBe(200);
    const preview = reviewed.json<MissionAvoidanceResponse>();
    expect(validAvoidance(preview), JSON.stringify(validAvoidance.errors)).toBe(true);
    expect(preview.status, JSON.stringify([preview.reasons, preview.candidateCompleteness])).toBe('outside');
    expect(preview.candidates.map((candidate) => candidate.controlId).sort()).toEqual([...nearIds].sort());
    expect(preview.candidates.every((candidate) => candidate.geometry === 'outside')).toBe(true);
    expect(preview.notApplicable).toHaveLength(100);
    expect(preview.candidateCompleteness).toEqual({
      status: 'complete',
      count: 2,
      limit: 64,
      considered: 102,
      consideredLimit: 512,
    });
    for (const entry of preview.notApplicable) {
      expect(entry.applicability).toMatchObject({
        outcome: 'does_not_apply',
        basis: 'rule',
        rule: { id: 'ledger.control-applicability.area-reach', version: 1 },
        inputs: { mission: preview.mission },
      });
      expect(entry.applicability.measured[0]!.value).toBeGreaterThanOrEqual(19_000);
      // Each entry names and places its control, so a screen needs no read of the control version to list or draw it.
      expect(entry.title).toBe('Keep routes clear of the fictional site');
      expect(entry.area).toEqual({ center: centres[controlIds.indexOf(entry.controlId)], radiusMeters: 250 });
    }
    // One review of 102 controls is plain computation inside the read; it takes well under the request budget.
    expect(reviewMs).toBeLessThan(10_000);

    const released = await target.release();
    await drain(f);
    expect(released.release.basis.avoidance.candidates).toHaveLength(2);
    expect(released.release.basis.avoidance.notApplicable).toHaveLength(100);
    expect(released.release.basis.avoidance.notApplicable).toEqual(preview.notApplicable);
    expect(released.release.basis.notApplicableContexts).toHaveLength(100);
    expect(released.release.basis.avoidance.contextDigest).toBe(preview.contextDigest);

    const controls = (await call(f, 'GET', `/v1/flights/${target.flightId}/controls`)).json<FlightControlsResponse>();
    // All 102 are listed: the two that apply in full, the 100 that do not in the list's compact part.
    expect(controls.complete).toBe(true);
    expect(controls.mission).toEqual(preview.mission);
    expect(controls.controls.map((item) => [item.control.id, item.results[0]!.result]).sort()).toEqual(
      nearIds.map((id) => [id, 'pass']).sort(),
    );
    const notApplying = controls.notApplicable;
    expect(notApplying).toHaveLength(100);
    for (const result of notApplying) {
      expect(result.summary).toMatch(
        /^The planned corridor stays at least [\d ]+ m from the area; the control applies within 500 m\.$/,
      );
      expect(result.applicability).toMatchObject({ outcome: 'does_not_apply', basis: 'rule' });
    }

    const brief = async (release: MissionReleaseRecordResponse) => {
      const candidates = release.release.basis.avoidance.candidates;
      const response = await call(f, 'POST', '/v1/commands', {
        kind: 'mission.brief',
        flightId: target.flightId,
        purpose: 'informational',
        release: { id: release.release.id, digest: release.digest },
        controls: candidates.map(
          ({ hazardId, controlId, controlVersion, controlEventId, controlDigest, acceptance }) => ({
            hazardId,
            controlId,
            controlVersion,
            controlEventId,
            controlDigest,
            acceptance,
          }),
        ),
        recipientPrincipalIds: [f.author],
        message: 'Review the exact avoidance areas that apply to this route before departure.',
        expectedPrincipalRevision: (await call(f, 'GET', '/v1/me')).json().principal.revision,
        expectedControlsDigest: (
          await call(f, 'GET', `/v1/flights/${target.flightId}/controls`)
        ).json<FlightControlsResponse>().digest,
      });
      expect(response.statusCode, response.body).toBe(201);
      await drain(f);
      const shown = (
        await call(f, 'GET', `/v1/flights/${target.flightId}/briefings/${response.json().command.id}`)
      ).json<MissionBriefingRecordResponse>();
      const acknowledged = await call(f, 'POST', '/v1/commands', {
        kind: 'mission.briefing-acknowledge',
        flightId: target.flightId,
        briefing: { id: shown.briefing.id, digest: shown.digest },
        populationDigest: shown.briefing.population.digest,
        attestation: 'reviewed_exact_briefing',
        expectedPrincipalRevision: (await call(f, 'GET', '/v1/me')).json().principal.revision,
      });
      expect(acknowledged.statusCode, acknowledged.body).toBe(201);
      await drain(f);
      return shown;
    };
    const briefing = await brief(released);
    expect(briefing.briefing.context.controls).toHaveLength(2);
    expect(briefing.briefing.controls?.controls).toHaveLength(2);
    expect(briefing.briefing.controls?.notApplicable).toHaveLength(100);
    const { size } = (
      await admin.query<{ size: number }>(
        'SELECT octet_length(record::text) AS size FROM mission_briefings WHERE id=$1',
        [briefing.briefing.id],
      )
    ).rows[0]!;
    expect(size).toBeLessThanOrEqual(1024 * 1024);

    const ready = (release: MissionReleaseRecordResponse, briefed: MissionBriefingRecordResponse, revision = 0) =>
      ({
        version: 'flight.predeparture-progress.1',
        expectedRevision: revision,
        execution: {
          runId: `${f.tenantId}:run`,
          reservationId: `${f.tenantId}:held`,
          aircraftId: target.raw.aircraftId,
          sourceMissionId: target.raw.sourceMissionId,
        },
        sourceObservedAt: release.release.recordedAt,
        phase: 'ready',
        code: 'human_review_complete',
        retryable: true,
        reason: 'The exact held mission has completed human review.',
        needsHumanReview: true,
        references: {
          mission: release.release.basis.avoidance.mission,
          release: { id: release.release.id, digest: release.digest },
          briefings: release.release.basis.avoidance.candidates.map(({ controlEventId }) => ({
            controlEventId,
            briefing: { id: briefed.briefing.id, digest: briefed.digest },
          })),
        },
      }) satisfies FlightPredepartureProgress;
    // Readiness asks for a briefing on the two candidates only; the 100 that do not apply need none.
    const readied = await report(target.flightId, ready(released, briefing));
    expect(readied.statusCode, readied.body).toBe(201);
    await drain(f);

    // A new mission revision comes within 200 m of one of the 100: every considered control is evaluated again.
    const south: [number, number] = [a[0], detoured.latitude + 450 / 111_034];
    await target.submit({
      ...target.raw,
      sourceRevision: 2,
      route: { ...target.raw.route, geometry: { type: 'LineString', coordinates: [south, a, b, c] } },
    });
    await drain(f);
    const detour = (
      await call(f, 'GET', `/v1/flights/${target.flightId}/mission-avoidance`)
    ).json<MissionAvoidanceResponse>();
    expect(detour.status).toBe('outside');
    expect(detour.candidates.map((candidate) => candidate.controlId).sort()).toEqual([...nearIds, detouredId].sort());
    expect(detour.notApplicable).toHaveLength(99);
    expect(detour.candidates.find((candidate) => candidate.controlId === detouredId)!.applicability.summary).toBe(
      'The planned corridor comes within 500 m of the area; the control applies within 500 m.',
    );
    const earlier = await call(
      f,
      'GET',
      `/v1/flights/${target.flightId}/mission-releases/${released.release.id}/validity`,
    );
    expect(earlier.json<MissionReleaseValidityResponse>()).toMatchObject({ status: 'changed' });
    expect(earlier.json<MissionReleaseValidityResponse>().reasons).toContain('mission_changed');
    // The earlier briefing names the earlier release, which no longer reads as current.
    const stale = await report(target.flightId, {
      ...ready(released, briefing, 1),
      references: { ...ready(released, briefing, 1).references, mission: detour.mission! },
    });
    expect(stale.statusCode, stale.body).toBe(409);
    const rereleased = await target.release();
    await drain(f);
    expect(rereleased.release.basis.avoidance.candidates).toHaveLength(3);
    const rebriefed = await brief(rereleased);
    expect(rebriefed.briefing.context.controls).toHaveLength(3);
    const readyAgain = await report(target.flightId, ready(rereleased, rebriefed, 1));
    expect(readyAgain.statusCode, readyAgain.body).toBe(201);
    await configured.close();
  }, 300_000);

  /** A briefing on every candidate of the release, as its author sends it after reading the flight's controls. */
  async function briefCommand(f: Fixture, release: MissionReleaseRecordResponse): Promise<MissionBriefingCommand> {
    await drain(f);
    const flightId = release.release.flightId;
    const controls = await call(f, 'GET', `/v1/flights/${flightId}/controls`);
    expect(controls.statusCode, controls.body).toBe(200);
    return {
      kind: 'mission.brief',
      flightId,
      purpose: 'informational',
      release: { id: release.release.id, digest: release.digest },
      controls: release.release.basis.avoidance.candidates.map(
        ({ hazardId, controlId, controlVersion, controlEventId, controlDigest, acceptance }) => ({
          hazardId,
          controlId,
          controlVersion,
          controlEventId,
          controlDigest,
          acceptance,
        }),
      ),
      recipientPrincipalIds: [f.author],
      message: 'Review the exact avoidance areas that apply to this route before departure.',
      expectedPrincipalRevision: (await call(f, 'GET', '/v1/me')).json().principal.revision,
      expectedControlsDigest: controls.json<FlightControlsResponse>().digest,
    };
  }
  /**
   * Records a briefing whose commit waits until the database clock has passed the instant. The instant must still be
   * ahead when it starts; the result names the command and how its commit was answered.
   */
  async function briefAcross(f: Fixture, body: MissionBriefingCommand, instant: string) {
    expect(await databaseClock(), `the test reached ${instant} before it could wait for it`).toBeLessThan(
      Date.parse(instant),
    );
    let id: string | undefined;
    try {
      await withScope(pool, { id: f.author, tenantId: f.tenantId }, async (client, who) => {
        id = (await acceptCommand(client, who, body)).id;
        await client.query(
          'SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))+0.05)',
          [instant],
        );
      });
      return { id, error: undefined };
    } catch (error) {
      return { id, error };
    }
  }
  /** Acknowledges a briefing as its author in a transaction whose commit waits until the database clock passes the instant. */
  async function acknowledgeAcross(f: Fixture, briefing: MissionBriefingRecordResponse, instant: string) {
    expect(await databaseClock(), `the test reached ${instant} before it could wait for it`).toBeLessThan(
      Date.parse(instant),
    );
    let id: string | undefined;
    try {
      await withScope(pool, { id: f.author, tenantId: f.tenantId }, async (client, who) => {
        id = (await acceptCommand(client, who, await acknowledgementCommand(f, briefing))).id;
        await client.query(
          'SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))+0.05)',
          [instant],
        );
      });
      return { id, error: undefined };
    } catch (error) {
      return { id, error };
    }
  }
  async function readBriefing(f: Fixture, flightId: string, id: string) {
    const response = await call(f, 'GET', `/v1/flights/${flightId}/briefings/${id}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<MissionBriefingRecordResponse>();
  }
  const briefingValidUntil = async (id: string) =>
    (
      await admin.query<{ valid_until: Date }>('SELECT valid_until FROM mission_briefings WHERE id=$1', [id])
    ).rows[0]!.valid_until.getTime();
  async function releaseValidity(f: Fixture, release: MissionReleaseRecordResponse) {
    const response = await call(
      f,
      'GET',
      `/v1/flights/${release.release.flightId}/mission-releases/${release.release.id}/validity`,
    );
    expect(response.statusCode, response.body).toBe(200);
    const validity = response.json<MissionReleaseValidityResponse>();
    expect(validReleaseValidity(validity), JSON.stringify(validReleaseValidity.errors)).toBe(true);
    return validity;
  }

  it('ends a briefing where a control that applies starts or ends, not one the release recorded as not applying', async () => {
    const { f, makeMission, grant } = await departureFixture('briefing-boundary-area');
    const { configured, report } = await readinessApp(f);
    await grant('author', ['briefing:write', 'briefing:ack']);
    await grant('source', ['decision:write', 'mission:release']);
    const target = await makeMission('held');
    const [a, b] = target.raw.route.geometry.coordinates as [number, number][];
    // On one hazard, two areas declaring a reach of 500 m: one 300 m from the route, which applies, and one 21 km
    // away, which does not. The far one ends first, then the near one; each instant is far enough ahead for the
    // release and briefings below to be recorded before it.
    const t0 = await databaseClock();
    const farEnds = new Date(t0 + 30_000).toISOString();
    const nearEnds = new Date(t0 + 50_000).toISOString();
    const plan = areaPlan(f, {
      title: 'Fictional survey works near the route',
      center: beside(a, b, 1),
      appliesWithinMeters: 500,
      effectiveFrom: target.raw.operatingInterval.start,
    });
    const hazardId = await openHazard(plan);
    const nearId = await proposeArea({ ...plan, effectiveUntil: nearEnds }, hazardId);
    const farId = await proposeArea({ ...plan, center: offset(a, -21_000, 0), effectiveUntil: farEnds }, hazardId);
    await acceptRisk(plan, hazardId, await assessWithControls(plan, hazardId, [nearId, farId]));
    await drain(f);
    const released = await target.release();
    await drain(f);
    expect(released.release.basis.avoidance.candidates.map((candidate) => candidate.controlId)).toEqual([nearId]);
    expect(released.release.basis.avoidance.notApplicable.map((entry) => entry.controlId)).toEqual([farId]);
    // The release's recheck time is the near area's end: the far area's end cannot change what it recorded.
    const before = await releaseValidity(f, released);
    expect(before.status).toBe('current');
    expect(Date.parse(before.nextBoundary!)).toBe(Date.parse(nearEnds));

    const first = await call(f, 'POST', '/v1/commands', await briefCommand(f, released));
    expect(first.statusCode, first.body).toBe(201);
    const firstId = first.json().command.id as string;
    expect(await briefingValidUntil(firstId)).toBe(Date.parse(nearEnds));
    await drain(f);
    // A briefing whose commit waits past the far area's end is recorded: that instant ends nothing for this flight.
    const across = await briefAcross(f, await briefCommand(f, released), farEnds);
    expect(across.error).toBeUndefined();
    expect(await briefingValidUntil(across.id!)).toBe(Date.parse(nearEnds));
    await drain(f);

    // Past that instant the first briefing is still in force: it is acknowledged, and readiness accepts it.
    const briefing = await readBriefing(f, target.flightId, firstId);
    expect(briefing.standing).toMatchObject({ status: 'in_force', validUntil: nearEnds, boundary: 'control_boundary' });
    expect(Date.parse(briefing.standing.evaluatedAt)).toBeGreaterThan(Date.parse(farEnds));
    await acknowledge(f, briefing);
    const readiness = (revision: number, briefed: MissionBriefingRecordResponse): FlightPredepartureProgress => ({
      version: 'flight.predeparture-progress.1',
      expectedRevision: revision,
      execution: {
        runId: `${f.tenantId}:run`,
        reservationId: `${f.tenantId}:held`,
        aircraftId: target.raw.aircraftId,
        sourceMissionId: target.raw.sourceMissionId,
      },
      sourceObservedAt: released.release.recordedAt,
      phase: 'ready',
      code: 'human_review_complete',
      retryable: true,
      reason: 'The exact held mission has completed human review.',
      needsHumanReview: true,
      references: {
        mission: released.release.basis.avoidance.mission,
        release: { id: released.release.id, digest: released.digest },
        briefings: [
          {
            controlEventId: released.release.basis.avoidance.candidates[0]!.controlEventId,
            briefing: { id: briefed.briefing.id, digest: briefed.digest },
          },
        ],
      },
    });
    const readied = await report(target.flightId, readiness(0, briefing));
    expect(readied.statusCode, readied.body).toBe(201);
    await drain(f);
    const between = await releaseValidity(f, released);
    expect(between.status).toBe('current');
    expect(Date.parse(between.nextBoundary!)).toBe(Date.parse(nearEnds));

    // A briefing whose commit waits past the near area's end records nothing.
    const late = await briefAcross(f, await briefCommand(f, released), nearEnds);
    expect(late.id).toBeDefined();
    expect(late.error).toMatchObject({ code: 'concurrent_change' });
    expect((await admin.query('SELECT id FROM mission_briefings WHERE id=$1', [late.id])).rowCount).toBe(0);
    await drain(f);

    // Past the near area's end both briefings have lapsed. The first keeps its acknowledgement, recorded in time,
    // but no longer counts toward readiness; the second can no longer be acknowledged.
    const lapsed = await readBriefing(f, target.flightId, firstId);
    expect(lapsed.standing).toMatchObject({ status: 'lapsed', validUntil: nearEnds, boundary: 'control_boundary' });
    const progress = await call(f, 'GET', `/v1/flights/${target.flightId}/predeparture`);
    expect(progress.statusCode, progress.body).toBe(200);
    expect(progress.json<FlightPredepartureResponse>().current.briefings).toEqual([
      expect.objectContaining({
        briefing: { id: firstId, digest: briefing.digest },
        acknowledged: 1,
        recipients: 1,
        standing: expect.objectContaining({ status: 'lapsed', validUntil: nearEnds }),
      }),
    ]);
    const stale = await report(target.flightId, readiness(1, briefing));
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json().error).toMatchObject({
      code: 'briefing_lapsed',
      details: { briefingId: firstId, validUntil: nearEnds, boundary: 'control_boundary' },
    });
    expect(stale.json().error.message).toContain('a new briefing is needed');
    const unacknowledged = await call(
      f,
      'POST',
      '/v1/commands',
      await acknowledgementCommand(f, await readBriefing(f, target.flightId, across.id!)),
    );
    expect(unacknowledged.statusCode, unacknowledged.body).toBe(409);
    expect(unacknowledged.json().error.code).toBe('briefing_lapsed');
    expect(
      (await admin.query('SELECT id FROM mission_briefing_acknowledgements WHERE briefing_id=$1', [across.id]))
        .rowCount,
    ).toBe(0);

    // A new briefing, in force until the release window ends, restores readiness.
    const renewedCommand = await call(f, 'POST', '/v1/commands', await briefCommand(f, released));
    expect(renewedCommand.statusCode, renewedCommand.body).toBe(201);
    await drain(f);
    const renewed = await readBriefing(f, target.flightId, renewedCommand.json().command.id);
    expect(renewed.standing).toMatchObject({
      status: 'in_force',
      validUntil: new Date(released.release.departureWindow.end).toISOString(),
      boundary: 'release_window_end',
    });
    await acknowledge(f, renewed);
    const restored = await report(target.flightId, readiness(1, renewed));
    expect(restored.statusCode, restored.body).toBe(201);
    await drain(f);

    // Accepting another area after the release changes the register, and the release no longer reads as current,
    // though the new area is far from the route and does not apply.
    await acceptedAreaControl({ ...plan, center: offset(a, -22_000, 0) });
    await drain(f);
    const after = await releaseValidity(f, released);
    expect(after.status).toBe('changed');
    expect(after.reasons).toContain('safety_context_changed');
    const refused = await call(f, 'POST', '/v1/commands', await briefCommand(f, released));
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.code).toBe('briefing_release_not_current');
    await configured.close();
  }, 180_000);

  it('ends a briefing where a rule control or a control a person checks starts or ends', async () => {
    const { f, makeMission, grant } = await departureFixture('briefing-boundary-rules');
    await grant('author', ['briefing:write', 'briefing:ack']);
    const target = await makeMission('held');
    const { start, end } = target.raw.operatingInterval;
    const [a, b] = target.raw.route.geometry.coordinates as [number, number][];
    // An area that applies, in force for the whole operating interval, so the release has a candidate to brief.
    const area = areaPlan(f, {
      title: 'Fictional survey works near the route',
      center: beside(a, b, 1),
      appliesWithinMeters: 500,
      effectiveFrom: start,
      effectiveUntil: end,
    });
    await acceptedAreaControl(area);
    // On another hazard, an operating limit, which becomes a rule, and a measure a person confirms. The limit ends
    // first, then the measure.
    const t0 = await databaseClock();
    const ruleEnds = new Date(t0 + 25_000).toISOString();
    const personEnds = new Date(t0 + 40_000).toISOString();
    const hazardId = await openHazard({ ...area, title: 'Fictional battery exhausted before landing' });
    const hazard = await readSafetyRecord(person(f), hazardId);
    const propose = async (title: string, typeId: string, parameters: object, effectiveUntil: string) => {
      const type = hazard.controlTypes!.find((entry) => entry.id === typeId)!;
      const opened = await call(f, 'POST', '/v1/commands', {
        kind: 'sms.record.open',
        record: {
          kind: 'control',
          schema: 'sms.control.1',
          title,
          ownerId: f.author,
          body: {
            hazardId,
            controlType: { id: type.id, version: type.version, digest: type.digest },
            parameters,
            effectiveFrom: start,
            effectiveUntil,
          },
        },
      });
      expect(opened.statusCode, opened.body).toBe(201);
      return opened.json().command.subject.id as string;
    };
    const limitId = await propose(
      'Battery reserve',
      'control.operating-limit',
      {
        observationType: 'battery.state',
        observationVersion: 1,
        field: 'values.totalRemainingPercent',
        comparison: 'at_least',
        limit: 30,
        unit: 'percent',
        scope: 'organization',
      },
      ruleEnds,
    );
    const measureId = await propose(
      'Reserve briefing',
      'control.described-measure',
      { measure: 'Brief the crew on the battery reserve before each inspection.' },
      personEnds,
    );
    await acceptRisk(area, hazardId, await assessWithControls(area, hazardId, [limitId, measureId]));
    await drain(f);
    const released = await target.release();
    await drain(f);
    expect(released.release.basis.avoidance.candidates).toHaveLength(1);
    expect(released.release.basis.avoidance.notApplicable).toEqual([]);
    const listed = (await call(f, 'GET', `/v1/flights/${target.flightId}/controls`)).json<FlightControlsResponse>();
    expect(
      listed.controls
        .filter((item) => [limitId, measureId].includes(item.control.id))
        .map((item) => [item.control.id, item.check])
        .sort(),
    ).toEqual(
      [
        [limitId, 'rule'],
        [measureId, 'person'],
      ].sort(),
    );

    // The rule control's end is the first that can matter: it ends a briefing and is the release's recheck time.
    expect(Date.parse((await releaseValidity(f, released)).nextBoundary!)).toBe(Date.parse(ruleEnds));
    const first = await call(f, 'POST', '/v1/commands', await briefCommand(f, released));
    expect(first.statusCode, first.body).toBe(201);
    expect(await briefingValidUntil(first.json().command.id)).toBe(Date.parse(ruleEnds));
    const late = await briefAcross(f, await briefCommand(f, released), ruleEnds);
    expect(late.id).toBeDefined();
    expect(late.error).toMatchObject({ code: 'concurrent_change' });
    expect((await admin.query('SELECT id FROM mission_briefings WHERE id=$1', [late.id])).rowCount).toBe(0);

    // Past it, the end of the measure a person confirms is the next.
    const second = await call(f, 'POST', '/v1/commands', await briefCommand(f, released));
    expect(second.statusCode, second.body).toBe(201);
    expect(await briefingValidUntil(second.json().command.id)).toBe(Date.parse(personEnds));
    const validity = await releaseValidity(f, released);
    expect(validity.status).toBe('current');
    expect(Date.parse(validity.nextBoundary!)).toBe(Date.parse(personEnds));
    await drain(f);

    // An acknowledgement whose commit reaches the second briefing's valid-until is refused at commit; read again
    // after it, the briefing has lapsed and the acknowledgement is refused with its own code.
    const secondId = second.json().command.id as string;
    expect((await readBriefing(f, target.flightId, secondId)).standing.status).toBe('in_force');
    const lateAck = await acknowledgeAcross(f, await readBriefing(f, target.flightId, secondId), personEnds);
    expect(lateAck.id).toBeDefined();
    expect(lateAck.error).toMatchObject({ code: 'concurrent_change' });
    expect(
      (await admin.query('SELECT id FROM mission_briefing_acknowledgements WHERE id=$1', [lateAck.id])).rowCount,
    ).toBe(0);
    const afterEnd = await readBriefing(f, target.flightId, secondId);
    expect(afterEnd.standing).toMatchObject({ status: 'lapsed', validUntil: personEnds, boundary: 'control_boundary' });
    const refusedAck = await call(f, 'POST', '/v1/commands', await acknowledgementCommand(f, afterEnd));
    expect(refusedAck.statusCode, refusedAck.body).toBe(409);
    expect(refusedAck.json().error.code).toBe('briefing_lapsed');
  }, 180_000);

  it('authorizes departure while another transaction holds the flight and then wants the register, in one lock order', async () => {
    const { f, makeMission, command, authorization } = await departureFixture('departure-lock-order');
    const target = await makeMission('held');
    const plan = areaPlan(f, {
      title: 'Fictional works far from the route',
      center: { latitude: 41.6, longitude: -87.63 },
      appliesWithinMeters: 500,
      effectiveFrom: target.raw.operatingInterval.start,
      effectiveUntil: target.raw.operatingInterval.end,
    });
    await acceptedAreaControl(plan);
    await drain(f);
    const released = await target.release();
    await drain(f);
    expect(released.release.basis.avoidance.notApplicable).toHaveLength(1);
    const body = await command(released);
    // The departure's commit trigger takes the flight, its author, then the safety register: the same order as a
    // transaction that holds the flight and then wants the register.
    let authorized: ReturnType<typeof call> | undefined;
    await withScope(pool, { id: f.author, tenantId: f.tenantId }, async (client) => {
      await client.query('SELECT id FROM flight_views WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [
        f.tenantId,
        target.flightId,
      ]);
      authorized = call(f, 'POST', '/v1/commands', body);
      authorized.catch(() => undefined);
      await lockWaitStarted(admin);
      await client.query('SELECT ledger_lock_mission_avoidance_register()');
    });
    const result = authorization(await authorized!);
    expect(result.authorization.disposition).toBe('issued');
    // The basis keeps the review it re-checked without the controls that do not apply: the release records them.
    const retained = (
      await admin.query<{ issuance_basis: MissionDepartureIssuanceBasis }>(
        'SELECT issuance_basis FROM mission_departure_authorizations WHERE id=$1',
        [result.authorization.permit.id],
      )
    ).rows[0]!.issuance_basis;
    expect(retained).not.toHaveProperty('notApplicableContexts');
    expect(retained.avoidance).not.toHaveProperty('notApplicable');
    expect(retained.avoidance.contextDigest).toBe(released.release.basis.avoidance.contextDigest);
  });

  /** Accepts one area control at each centre, each with the reach, at most 30 on one hazard as an assessment allows. */
  async function acceptAreas(plan: AreaControlPlan, centres: AreaControlPlan['center'][]): Promise<string[]> {
    const controlIds: string[] = [];
    for (let first = 0; first < centres.length; first += 30) {
      const hazardId = await openHazard(plan);
      const proposed: string[] = [];
      for (const center of centres.slice(first, first + 30))
        proposed.push(await proposeArea({ ...plan, center }, hazardId));
      await acceptRisk(plan, hazardId, await assessWithControls(plan, hazardId, proposed));
      controlIds.push(...proposed);
    }
    return controlIds;
  }

  it('records a release, a briefing, readiness and a permit at the bound of 512 considered controls, and refuses a 513th', async () => {
    const setupStarted = Date.now();
    const { f, makeMission, grant, command, authorization } = await departureFixture('applicability-bound');
    const { configured, report } = await readinessApp(f);
    await grant('author', ['briefing:write', 'briefing:ack']);
    await grant('source', ['decision:write', 'mission:release']);
    const target = await makeMission('held');
    const { start, end } = target.raw.operatingInterval;
    const [a, b] = target.raw.route.geometry.coordinates as [number, number][];
    // Two areas 550 m from the route's first leg on either side, and 510 in a grid 25 km and more away.
    const across = (side: 1 | -1) => {
      const north = (b[1] - a[1]) * 111_034;
      const east = (b[0] - a[0]) * 111_320 * Math.cos((a[1] * Math.PI) / 180);
      const length = Math.hypot(north, east);
      return offset(
        [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
        (-side * east * 550) / length,
        (side * north * 550) / length,
      );
    };
    const grid = Array.from({ length: 510 }, (_, index) =>
      offset(a, 25_000 + Math.floor(index / 23) * 1000, -25_000 + (index % 23) * 1000),
    );
    const plan = areaPlan(f, {
      title: 'Fictional survey works',
      center: across(1),
      appliesWithinMeters: 500,
      effectiveFrom: start,
      effectiveUntil: end,
    });
    const controlIds = await acceptAreas(plan, [across(1), across(-1), ...grid]);
    expect(controlIds).toHaveLength(512);
    await drain(f);
    const setupMs = Date.now() - setupStarted;

    const reviewStarted = Date.now();
    const reviewed = await call(f, 'GET', `/v1/flights/${target.flightId}/mission-avoidance`);
    const reviewMs = Date.now() - reviewStarted;
    expect(reviewed.statusCode, reviewed.body).toBe(200);
    const preview = reviewed.json<MissionAvoidanceResponse>();
    expect(validAvoidance(preview), JSON.stringify(validAvoidance.errors)).toBe(true);
    expect(preview.status, JSON.stringify(preview.reasons)).toBe('outside');
    expect(preview.candidateCompleteness).toEqual({
      status: 'complete',
      count: 2,
      limit: 64,
      considered: 512,
      consideredLimit: 512,
    });
    expect(preview.notApplicable).toHaveLength(510);
    for (const entry of preview.notApplicable)
      expect(entry).toMatchObject({ title: 'Keep routes clear of the fictional site', area: { radiusMeters: 250 } });

    const released = await target.release();
    await drain(f);
    expect(released.release.basis.avoidance.notApplicable).toHaveLength(510);
    const controls = (await call(f, 'GET', `/v1/flights/${target.flightId}/controls`)).json<FlightControlsResponse>();
    expect(controls).toMatchObject({ complete: true, mission: preview.mission });
    expect(controls.controls).toHaveLength(2);
    expect(controls.notApplicable).toHaveLength(510);

    const candidates = released.release.basis.avoidance.candidates;
    const principal = async () => (await call(f, 'GET', '/v1/me')).json().principal;
    const brief = await call(f, 'POST', '/v1/commands', {
      kind: 'mission.brief',
      flightId: target.flightId,
      purpose: 'informational',
      release: { id: released.release.id, digest: released.digest },
      controls: candidates.map(
        ({ hazardId, controlId, controlVersion, controlEventId, controlDigest, acceptance }) => ({
          hazardId,
          controlId,
          controlVersion,
          controlEventId,
          controlDigest,
          acceptance,
        }),
      ),
      recipientPrincipalIds: [f.author],
      message: 'Review the exact avoidance areas that apply to this route before departure.',
      expectedPrincipalRevision: (await principal()).revision,
      expectedControlsDigest: controls.digest,
    });
    expect(brief.statusCode, brief.body).toBe(201);
    await drain(f);
    const briefing = (
      await call(f, 'GET', `/v1/flights/${target.flightId}/briefings/${brief.json().command.id}`)
    ).json<MissionBriefingRecordResponse>();
    expect(briefing.briefing.controls?.notApplicable).toHaveLength(510);
    await acknowledge(f, briefing);
    const ready: FlightPredepartureProgress = {
      version: 'flight.predeparture-progress.1',
      expectedRevision: 0,
      execution: {
        runId: `${f.tenantId}:run`,
        reservationId: `${f.tenantId}:held`,
        aircraftId: target.raw.aircraftId,
        sourceMissionId: target.raw.sourceMissionId,
      },
      sourceObservedAt: released.release.recordedAt,
      phase: 'ready',
      code: 'human_review_complete',
      retryable: true,
      reason: 'The exact held mission has completed human review.',
      needsHumanReview: true,
      references: {
        mission: released.release.basis.avoidance.mission,
        release: { id: released.release.id, digest: released.digest },
        briefings: candidates.map(({ controlEventId }) => ({
          controlEventId,
          briefing: { id: briefing.briefing.id, digest: briefing.digest },
        })),
      },
    };
    const readied = await report(target.flightId, ready);
    expect(readied.statusCode, readied.body).toBe(201);
    await drain(f);
    const permit = authorization(await call(f, 'POST', '/v1/commands', await command(released)));

    const size = async (sql: string, id: string) =>
      Number((await admin.query<{ size: string }>(sql, [id])).rows[0]!.size);
    const sizes = {
      release: await size(
        'SELECT octet_length(record::text) AS size FROM mission_releases WHERE id=$1',
        released.release.id,
      ),
      briefing: await size(
        'SELECT octet_length(record::text) AS size FROM mission_briefings WHERE id=$1',
        briefing.briefing.id,
      ),
      acknowledgement: await size(
        'SELECT max(octet_length(record::text)) AS size FROM mission_briefing_acknowledgements WHERE briefing_id=$1',
        briefing.briefing.id,
      ),
      departure: await size(
        'SELECT octet_length(permit::text)+octet_length(issuance_basis::text) AS size FROM mission_departure_authorizations WHERE id=$1',
        permit.authorization.permit.id,
      ),
    };
    // Each record keeps at least 40% of its bound in reserve at the bound of considered controls, so longer hazard or
    // control text cannot make a release, briefing or departure impossible unnoticed.
    expect(sizes.release).toBeLessThan(0.6 * 4 * 1024 * 1024);
    expect(sizes.briefing).toBeLessThan(0.6 * 1024 * 1024);
    expect(sizes.acknowledgement).toBeLessThan(0.6 * 16 * 1024);
    expect(sizes.departure).toBeLessThan(0.6 * 4 * 1024 * 1024);
    // One review of 512 controls is plain computation inside the read.
    expect(reviewMs).toBeLessThan(10_000);
    if (process.env.LEDGER_REPORT_SIZES)
      process.stdout.write(`SIZES ${JSON.stringify({ ...sizes, reviewMs, setupMs })}\n`);

    // A 513th considered control leaves route review incomplete, and a release is refused.
    await acceptAreas(plan, [offset(a, -30_000, 0)]);
    await drain(f);
    const over = (
      await call(f, 'GET', `/v1/flights/${target.flightId}/mission-avoidance`)
    ).json<MissionAvoidanceResponse>();
    expect(over.status).toBe('insufficient');
    expect(over.reasons).toContain('considered_limit_exceeded');
    expect(over.candidateCompleteness).toMatchObject({ status: 'incomplete', considered: 513 });
    expect(over.contextDigest).toBeNull();
    const refused = await call(f, 'POST', '/v1/commands', {
      kind: 'mission.release',
      flightId: target.flightId,
      aircraftId: released.release.aircraftId,
      mission: over.mission,
      calculation: {
        id: over.calculation.id,
        version: over.calculation.version,
        digest: over.calculation.digest,
      },
      policy: {
        id: missionReleasePolicy.id,
        version: missionReleasePolicy.version,
        digest: missionReleasePolicy.digest,
      },
      expectedContextDigest: preview.contextDigest,
      expectedFindingsDigest: (await call(f, 'GET', `/v1/flights/${target.flightId}/mission-release-findings`)).json()
        .basis.digest,
      expectedPrincipalRevision: (await principal()).revision,
      departureWindow: released.release.departureWindow,
      note: 'Release again with one more considered control.',
    });
    expect(refused.statusCode, refused.body).toBe(409);
    await configured.close();
  }, 600_000);

  it('refuses at commit a departure whose issuance basis does not hold its release’s route review', async () => {
    const { f, makeMission, command } = await departureFixture('departure-not-applicable');
    const target = await makeMission('held');
    await acceptedAreaControl(
      areaPlan(f, {
        title: 'Fictional works far from the route',
        center: { latitude: 41.6, longitude: -87.63 },
        appliesWithinMeters: 500,
        effectiveFrom: target.raw.operatingInterval.start,
        effectiveUntil: target.raw.operatingInterval.end,
      }),
    );
    await drain(f);
    const released = await target.release();
    await drain(f);
    expect(released.release.basis.notApplicableContexts).toHaveLength(1);
    const body = await command(released);
    // The row the application would record, read inside a transaction that is then rolled back.
    let row: Record<string, unknown> | undefined;
    await withScope(pool, { tenantId: f.tenantId, id: f.author }, async (client, who) => {
      const accepted = await acceptCommand(client, who, body);
      row = (
        await client.query('SELECT * FROM mission_departure_authorizations WHERE tenant_id=$1 AND id=$2', [
          f.tenantId,
          accepted.id,
        ])
      ).rows[0];
      throw new Error('rolled back on purpose');
    }).catch((failure: Error) => {
      if (failure.message !== 'rolled back on purpose') throw failure;
    });
    expect(row).toBeDefined();
    /**
     * Inserts a copy under a new journal event, without the command it answers, and reports how the database answered
     * at commit: 'accepted' when the check reached the missing command, otherwise the refusal.
     */
    const crafted = async (change: (basis: MissionDepartureIssuanceBasis) => void) => {
      // The commit check runs when constraints are checked; the transaction's own wrapper would hide which one refused.
      let refusal: string | undefined;
      try {
        await withScope(pool, { tenantId: f.tenantId, id: f.author }, async (client, who) => {
          const event = await appendEvent(client, who, {
            type: 'mission.departure-authorize',
            stream: `flight:${target.flightId}`,
            payload: { flightId: target.flightId },
          });
          await client.query(
            'INSERT INTO command_records(id,tenant_id,kind,flight_id,actor_id,recorded_at,payload) VALUES($1,$2,$3,$4,$5,$6,$7)',
            [
              event.id,
              f.tenantId,
              'mission.departure-authorize',
              target.flightId,
              f.author,
              event.received_at,
              event.payload,
            ],
          );
          const basis = structuredClone(row!.issuance_basis) as MissionDepartureIssuanceBasis;
          change(basis);
          const permit = { ...(row!.permit as MissionDeparturePermit), id: event.id };
          await client.query(
            `INSERT INTO mission_departure_authorizations(id,tenant_id,flight_id,release_id,release_digest,departure_attempt_id,
             allocation_id,allocation_digest,actor_id,authorized_at,valid_until,register_revision,permit,permit_digest,issuance_basis,original_command,recorded_at)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
            [
              event.id,
              f.tenantId,
              target.flightId,
              row!.release_id,
              row!.release_digest,
              row!.departure_attempt_id,
              row!.allocation_id,
              row!.allocation_digest,
              f.author,
              row!.authorized_at,
              row!.valid_until,
              row!.register_revision,
              permit,
              canonicalDigest(permit),
              basis,
              row!.original_command,
              row!.recorded_at,
            ],
          );
          await client.query('SET CONSTRAINTS ALL IMMEDIATE').catch((failure: Error) => {
            refusal = failure.message;
            throw failure;
          });
        });
      } catch (failure) {
        const message = refusal ?? (failure as Error).message;
        return message.includes('differs from its journal and command') ? 'accepted' : message;
      }
      return 'kept';
    };
    expect(await crafted(() => undefined)).toBe('accepted');
    // A context digest other than the release's, which covers the controls that do not apply, is refused.
    expect(
      await crafted((basis) => {
        basis.avoidance.contextDigest = 'f'.repeat(64);
      }),
    ).toContain('Departure release is not exact and current before commit');
    // So are candidates other than the release's: here the release has none, and the copy lists its far control.
    expect(released.release.basis.avoidance.candidates).toEqual([]);
    expect(
      await crafted((basis) => {
        const [far] = released.release.basis.avoidance.notApplicable;
        basis.avoidance.candidates = [{ ...far!, geometry: 'outside' } as (typeof basis.avoidance.candidates)[number]];
      }),
    ).toContain('Departure release is not exact and current before commit');
    expect(
      (await admin.query('SELECT id FROM mission_departure_authorizations WHERE flight_id=$1', [target.flightId]))
        .rowCount,
    ).toBe(0);
  });
});
