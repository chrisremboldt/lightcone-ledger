import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import { processLease, runDueRuleEvaluations, type WorkLease } from '../../apps/workers/src/index.js';
import { leaseExpired, lockWaitStarted, projectOwnedWork, settleOwnedWork, withOwnedWork } from './worker-queue.js';
import type {
  CommandLinkSource,
  CommandLinkBaselineInput,
  CommandLinkBaselineSource,
  HazardMonitoringHistoryResponse,
  MissionAvoidanceResponse,
  MissionBriefingAcknowledgementCommand,
  MissionBriefingAcknowledgementsResponse,
  MissionBriefingCommand,
  MissionBriefingRecordResponse,
  MissionDepartureAuthorizationCommand,
  FlightControlsResponse,
  MissionDepartureAuthorizationResponse,
  MissionInput,
  MissionReleaseCommand,
  MissionReleaseRecordResponse,
  MissionReleaseValidityResponse,
  MissionSource,
  TimelineResponse,
  CommandLinkBaselineRecordResponse,
  FlightMissionRevisionResponse,
  MonitoringReportInputV2,
  MonitoringReportSourceV2,
  MonitoringWindowRecordResponse,
  OrganizationCoverageResponse,
  OrganizationDecisionsResponse,
  RulePackVersion,
} from '../../packages/contracts/src/index.js';
import {
  MissionBriefingAcknowledgementsResponseSchema,
  MissionBriefingRecordResponseSchema,
} from '../../packages/contracts/src/mission-briefing.js';
import { HazardMonitoringHistoryResponseSchema } from '../../packages/contracts/src/assurance-history.js';
import { missionSource } from '../../packages/contracts/fixtures/demo/v1/missions.js';
import { missionReleasePolicy } from '../../packages/contracts/fixtures/demo/v1/mission-release.js';
import { adoptShownPack, reviewShownAdoption } from '../../packages/contracts/fixtures/demo/v1/ready.js';
import { adoptExampleRiskMatrix } from '../../apps/api/src/seed-risk-matrix.js';
import {
  acceptCommand,
  defineIndicator,
  getRulePackVersion,
  registerIndicatorDefinition,
} from '../../packages/domain/src/index.js';
import { controlTypeDigest } from '../../packages/domain/src/control-types.js';
import { getMissionAvoidance } from '../../packages/domain/src/mission-avoidance.js';
import { organization } from '../../packages/domain/src/adoptions.js';
import { lockSubjects } from '../../packages/domain/src/cuts.js';
import { lockSmsRecord } from '../../packages/domain/src/sms-envelope.js';
import { getMissionRelease, getMissionReleaseValidity } from '../../packages/domain/src/mission-release.js';
import { getFlightControls } from '../../packages/domain/src/mission-release-controls.js';
import { getMissionBriefing, getMissionBriefingAcknowledgements } from '../../packages/domain/src/mission-briefing.js';
import { avoidanceAreaControlType } from '../../packages/domain/src/control-type-library.js';
import { COMMAND_LINK_LOSS_LEAF_ID } from '../../packages/domain/src/rules/command-link-evidence-v1.js';
import { canonicalDigest, sha256 } from '../../packages/integrity/src/index.js';
import {
  createPool,
  MemoryObjectStore,
  withScope,
  type AuthContext,
  type PoolClient,
} from '../../packages/persistence/src/index.js';
import { recordRetainedCommandLinkBaseline } from './retained-command-link-intake.js';
import { commandLinkObservationInput } from '../../packages/contracts/fixtures/demo/v1/command-link.js';
import { verifyBundle } from '../../tools/verifier/index.mjs';
import { acceptedAreaControl, openHazard, readSafetyRecord, type PersonCall } from './area-control-records.js';

type Role = 'author' | 'sam' | 'lee' | 'source';
interface Fixture {
  tenantId: string;
  sourceId: string;
  principals: Record<Role, string>;
  tokens: Record<Role, string>;
  worker: AuthContext;
}

describe.runIf(process.env.LEDGER_ENV !== 'staging')('PostgreSQL informational mission briefings', () => {
  const prefix = `briefing-${randomUUID()}`;
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const workerPool = createPool(process.env.WORKER_DATABASE_URL);
  const store = new MemoryObjectStore();
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  const validBriefing = ajv.compile(MissionBriefingRecordResponseSchema);
  const validAcknowledgements = ajv.compile(MissionBriefingAcknowledgementsResponseSchema);
  const validMonitoringHistory = ajv.compile(HazardMonitoringHistoryResponseSchema);
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeAll(async () => {
    app = await createApp({ pool, env: 'test', objectStore: store });
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
    const sourceId = `${tenantId}:source`;
    const principals = {} as Record<Role, string>;
    const tokens = {} as Record<Role, string>;
    const capabilities: Record<Role, string[]> = {
      author: [
        'flight:create',
        'flight:read',
        'identity:write',
        'decision:write',
        'authority:write',
        'risk:accept:high',
        'mission:release',
        'briefing:write',
        'briefing:ack',
        'pack:adopt',
        'sms:read',
        'sms:write',
        'sms:configure',
        'sms:adopt',
        // Promoting a finding to a hazard reads the evidence behind it.
        'evidence:read',
      ],
      sam: ['flight:read', 'briefing:ack'],
      lee: ['flight:read', 'briefing:ack'],
      // command-link:write is the retired authority the retained baselines and reports below were recorded under.
      source: ['input:write', 'flight:read', 'mission:write', 'command-link:write'],
    };
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, 'Fictional briefing operator']);
    for (const role of Object.keys(capabilities) as Role[]) {
      const id = `${tenantId}:${role}`;
      principals[role] = id;
      tokens[role] = `ledger-dev-${id}`;
      await admin.query(
        'INSERT INTO principals(id,tenant_id,name,kind,capabilities,mission_sources,command_link_sources) VALUES($1,$2,$3,$4,$5,$6,$6)',
        [
          id,
          tenantId,
          role === 'sam' ? 'Sam Rivera' : role === 'lee' ? 'Lee Park' : `Fictional ${role}`,
          role === 'source' ? 'source' : 'human',
          capabilities[role],
          role === 'source' ? [sourceId] : [],
        ],
      );
      await admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [
        sha256(tokens[role]),
        id,
      ]);
      if (role === 'source')
        await admin.query(
          "INSERT INTO observation_grants(tenant_id,principal_id,source_id,observation_type) VALUES($1,$2,$3,'link.status')",
          [tenantId, id, sourceId],
        );
    }
    const worker: AuthContext = {
      id: `${tenantId}:worker`,
      tenantId,
      name: 'Briefing worker',
      kind: 'worker',
      capabilities: ['flight:read', 'evidence:read'],
      revision: 1,
    };
    await admin.query("INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,'worker',$4)", [
      worker.id,
      tenantId,
      worker.name,
      worker.capabilities,
    ]);
    const f = { tenantId, sourceId, principals, tokens, worker };
    // An organization assesses a hazard only on a risk matrix it adopted.
    const matrixPeople = {
      drafter: { id: principals.author, token: tokens.author },
      adopter: { token: tokens.author },
      note: 'Adopt the fictional risk matrix.',
    };
    expect(await adoptExampleRiskMatrix(app, matrixPeople)).toBe(true);
    // The lost-link review runs only where the organization adopted the procedures that hold it.
    const adopted = await call(
      f,
      'POST',
      '/v1/commands',
      adoptShownPack(
        (await call(f, 'GET', '/v1/organization/coverage')).json<OrganizationCoverageResponse>(),
        getRulePackVersion('ledger.demo-procedures', 5)!,
        { start: new Date(Date.now() - 1000).toISOString(), end: new Date(Date.now() + 86_400_000).toISOString() },
        'Adopt the fictional flight procedures.',
        'active',
      ),
    );
    expect(adopted.statusCode, adopted.body).toBe(201);
    await drain(f);
    return f;
  }
  function call(
    f: Fixture,
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    payload?: unknown,
    role: Role = 'author',
    key = randomUUID(),
  ) {
    return app.inject({
      method,
      url,
      payload,
      headers: {
        authorization: `Bearer ${f.tokens[role]}`,
        'idempotency-key': key,
        ...(method === 'PUT' ? { 'content-type': 'application/octet-stream' } : {}),
      },
    });
  }
  // The digest of the controls in scope as a person reads them before a briefing or departure.
  async function controlsDigest(f: Fixture, flightId: string): Promise<string> {
    const shown = await call(f, 'GET', `/v1/flights/${flightId}/controls`);
    expect(shown.statusCode, shown.body).toBe(200);
    return shown.json<FlightControlsResponse>().digest;
  }
  async function lease(f: Fixture, eventId?: string, seconds = 30): Promise<WorkLease | null> {
    return withScope(workerPool, f.worker, async (client) => {
      const row = (
        await client.query<WorkLease>(
          `SELECT w.* FROM work_items w WHERE (w.state='pending' OR (w.state='leased' AND w.lease_until<clock_timestamp()))
         AND ($1::text IS NULL OR w.event_id=$1) AND NOT EXISTS(SELECT 1 FROM work_items p WHERE p.stream_id=w.stream_id
         AND p.stream_sequence<w.stream_sequence AND p.state NOT IN ('completed','failed')) ORDER BY w.available_at,w.id LIMIT 1 FOR UPDATE`,
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
    for (let count = 0; count < 120; count++) {
      await projectOwnedWork(admin, workerPool, [f.tenantId], { objectStore: store });
      // Rules an adopted pack holds run on the generic evaluator once their inputs are projected.
      if (!(await withOwnedWork(admin, [f.tenantId], () => runDueRuleEvaluations(workerPool, { limit: 100 })))) return;
    }
    throw new Error('Briefing fixture did not drain');
  }
  async function timeline(f: Fixture, flightId: string): Promise<TimelineResponse> {
    const response = await call(f, 'GET', `/v1/flights/${flightId}/timeline`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }
  async function upload(f: Fixture, raw: unknown, paddedBytes = 0) {
    const json = `${JSON.stringify(raw)}\n`;
    const bytes = Buffer.from(json + ' '.repeat(Math.max(0, paddedBytes - Buffer.byteLength(json))));
    const created = await call(
      f,
      'POST',
      '/v1/uploads',
      { byteLength: bytes.length, contentType: 'application/json' },
      'source',
    );
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().upload.id as string;
    expect((await call(f, 'PUT', `/v1/uploads/${id}/content`, bytes, 'source')).statusCode).toBe(200);
    const finalized = await call(f, 'POST', `/v1/uploads/${id}/finalize`, undefined, 'source');
    expect(finalized.statusCode, finalized.body).toBe(201);
    return finalized.json().artifact.id as string;
  }
  /** The helper's view of a person: their bearer token, a fresh idempotency key and any extra headers. */
  function person(f: Fixture, role: Role): PersonCall {
    return (method, url, payload, headers = {}) =>
      app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${f.tokens[role]}`, 'idempotency-key': randomUUID(), ...headers },
        ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
      });
  }
  async function principal(f: Fixture, role: Role = 'author') {
    const response = await call(f, 'GET', '/v1/me', undefined, role);
    expect(response.statusCode, response.body).toBe(200);
    return response.json().principal as { id: string; revision: number; capabilities: string[] };
  }
  async function authority(f: Fixture, role: Role, capabilities: string[]) {
    const current = await principal(f, role);
    const response = await call(f, 'POST', '/v1/commands', {
      kind: 'authority.update',
      principalId: current.id,
      expectedRevision: current.revision,
      capabilities,
    });
    expect(response.statusCode, response.body).toBe(201);
  }
  async function prepared(name: string) {
    const f = await fixture(name);
    const createFlight = async (label: string) => {
      const created = await call(f, 'POST', '/v1/flights', { originationKey: `${f.tenantId}:${label}` });
      expect(created.statusCode, created.body).toBe(201);
      await drain(f);
      return created.json().flight.id as string;
    };
    const originId = await createFlight('origin');
    const flightId = await createFlight('mission');
    const raw: MissionSource = {
      ...missionSource,
      sourceMissionId: `${f.tenantId}:mission`,
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
    const missionInput = async (revision: number): Promise<MissionInput> => {
      const source = { ...raw, sourceRevision: revision };
      const { sourceRevision, occurredAt, ...payload } = source;
      return {
        kind: 'mission.revision',
        sourceId: f.sourceId,
        sourceRevision,
        occurredAt,
        subject: { flightId },
        artifactId: await upload(f, source),
        fidelity: 'synthetic_contract',
        payload,
      };
    };
    expect((await call(f, 'POST', '/v1/inputs', await missionInput(1), 'source')).statusCode).toBe(201);
    const reportInput = async (sequence: number) => {
      const source: CommandLinkSource = {
        sourceSessionId: `${f.tenantId}:capture`,
        sourceEventId: `link-${sequence}`,
        incidentId: `${f.tenantId}:incident`,
        aircraftId: 'fictional-origin-aircraft',
        occurredAt: new Date(Date.now() - 60_000 + sequence).toISOString(),
        status: sequence === 1 ? 'lost' : 'restored',
      };
      return commandLinkObservationInput(source, await upload(f, source), originId, f.sourceId);
    };
    expect((await call(f, 'POST', '/v1/inputs', await reportInput(1), 'source')).statusCode).toBe(201);
    await drain(f);
    const origin = await timeline(f, originId);
    const finding = origin.findings!.find((item) => item.latestEvaluation.leafId === COMMAND_LINK_LOSS_LEAF_ID)!;
    // The command-link finding on the origin flight is promoted to a hazard on the safety record, which carries the
    // avoidance area as an accepted control record.
    const area = {
      center: { latitude: 38.5848, longitude: -121.5045 },
      radiusMeters: 250,
      effectiveFrom: raw.operatingInterval.start,
      effectiveUntil: raw.operatingInterval.end,
    };
    const records = await acceptedAreaControl({
      safety: person(f, 'author'),
      safetyId: f.principals.author,
      acceptor: person(f, 'author'),
      acceptorToken: f.tokens.author,
      findingId: finding.id,
      title: 'Reported interruption',
      ...area,
    });
    await drain(f);
    const hazard = await readSafetyRecord(person(f, 'author'), records.hazardId);
    const control = hazard.controls!.find((entry) => entry.id === records.controlId)!;
    expect(control).toMatchObject({ accepted: true, versionNumber: 1 });
    const preview = async (): Promise<MissionAvoidanceResponse> => {
      const response = await call(f, 'GET', `/v1/flights/${flightId}/mission-avoidance`);
      expect(response.statusCode, response.body).toBe(200);
      return response.json();
    };
    const avoidance = await preview();
    expect(avoidance).toMatchObject({ status: 'outside', candidateCompleteness: { status: 'complete', count: 1 } });
    const releaseCommand: MissionReleaseCommand = {
      kind: 'mission.release',
      flightId,
      aircraftId: raw.aircraftId,
      mission: avoidance.mission!,
      calculation: {
        id: avoidance.calculation.id,
        version: avoidance.calculation.version,
        digest: avoidance.calculation.digest,
      },
      policy: {
        id: missionReleasePolicy.id,
        version: missionReleasePolicy.version,
        digest: missionReleasePolicy.digest,
      },
      expectedContextDigest: avoidance.contextDigest!,
      expectedFindingsDigest: (await call(f, 'GET', `/v1/flights/${flightId}/mission-release-findings`)).json().basis
        .digest,
      expectedPrincipalRevision: (await principal(f)).revision,
      departureWindow: {
        start: new Date(Date.now() - 1000).toISOString(),
        end: new Date(Date.now() + 1_800_000).toISOString(),
      },
      note: 'Release the exact mission outside the manual avoidance area.',
    };
    const released = await call(f, 'POST', '/v1/commands', releaseCommand);
    expect(released.statusCode, released.body).toBe(201);
    await drain(f);
    const releasePath = `/v1/flights/${flightId}/mission-releases/${released.json().command.id}`;
    const release = (await call(f, 'GET', releasePath)).json<MissionReleaseRecordResponse>();
    const validity = async () => {
      const response = await call(f, 'GET', `${releasePath}/validity`);
      expect(response.statusCode, response.body).toBe(200);
      return response.json<MissionReleaseValidityResponse>();
    };
    const briefingCommand = async (recipients = [f.principals.sam]): Promise<MissionBriefingCommand> => {
      const candidate = release.release.basis.avoidance.candidates[0]!;
      return {
        kind: 'mission.brief',
        flightId,
        purpose: 'informational',
        release: { id: release.release.id, digest: release.digest },
        controls: [
          {
            hazardId: candidate.hazardId,
            controlId: candidate.controlId,
            controlVersion: candidate.controlVersion,
            controlEventId: candidate.controlEventId,
            controlDigest: candidate.controlDigest,
            acceptance: candidate.acceptance,
          },
        ],
        recipientPrincipalIds: recipients,
        message:
          'Review the exact authored manual avoidance instruction and mission context; acknowledge your own review.',
        expectedPrincipalRevision: (await principal(f)).revision,
        expectedControlsDigest: await controlsDigest(f, flightId),
      };
    };
    const read = async (id: string): Promise<MissionBriefingRecordResponse> => {
      const response = await call(f, 'GET', `/v1/flights/${flightId}/briefings/${id}`, undefined, 'sam');
      expect(response.statusCode, response.body).toBe(200);
      expect(validBriefing(response.json()), JSON.stringify(validBriefing.errors)).toBe(true);
      return response.json();
    };
    const acknowledgements = async (id: string): Promise<MissionBriefingAcknowledgementsResponse> => {
      const response = await call(
        f,
        'GET',
        `/v1/flights/${flightId}/briefings/${id}/acknowledgements`,
        undefined,
        'sam',
      );
      expect(response.statusCode, response.body).toBe(200);
      expect(validAcknowledgements(response.json()), JSON.stringify(validAcknowledgements.errors)).toBe(true);
      return response.json();
    };
    const acknowledge = async (
      briefing: MissionBriefingRecordResponse,
      role: Role = 'sam',
    ): Promise<MissionBriefingAcknowledgementCommand> => ({
      kind: 'mission.briefing-acknowledge',
      flightId,
      briefing: { id: briefing.briefing.id, digest: briefing.digest },
      populationDigest: briefing.briefing.population.digest,
      attestation: 'reviewed_exact_briefing',
      expectedPrincipalRevision: (await principal(f, role)).revision,
    });
    return {
      f,
      originId,
      flightId,
      raw,
      records,
      area,
      control,
      release,
      preview,
      validity,
      missionInput,
      reportInput,
      briefingCommand,
      read,
      acknowledgements,
      acknowledge,
    };
  }

  async function preparedMonitoring(
    name: string,
    options: { baselineState?: CommandLinkBaselineSource['state']; complete?: boolean; extraFlight?: boolean } = {},
  ) {
    const context = await prepared(name);
    const { f, flightId, raw, release } = context;
    const end = new Date(Date.now() - 1000).toISOString();
    const start = new Date(Date.parse(end) - 30_000).toISOString();
    const baselineSource: CommandLinkBaselineSource = {
      version: 'command-link.baseline.1',
      sourceId: f.sourceId,
      sourceSessionId: `${f.tenantId}:native`,
      sourceEventId: 'initial',
      flightId,
      aircraftId: raw.aircraftId,
      occurredAt: new Date(Date.parse(start) - 1000).toISOString(),
      state: options.baselineState ?? 'unknown',
    };
    const { sourceId, sourceSessionId, flightId: boundFlight, occurredAt, ...payload } = baselineSource;
    // Baselines are no longer accepted; one recorded earlier is retained evidence the older monitoring cites.
    const baseline = await recordRetainedCommandLinkBaseline(
      pool,
      { id: f.principals.source, tenantId: f.tenantId },
      {
        sourceId,
        sourceSessionId,
        kind: 'command-link.baseline',
        occurredAt,
        subject: { flightId: boundFlight },
        artifactId: await upload(f, baselineSource),
        fidelity: 'synthetic_contract',
        payload,
      },
      store,
    );
    await drain(f);
    const exact = await call(f, 'GET', `/v1/flights/${flightId}/command-link-baselines/${baseline.eventId}`);
    expect(exact.statusCode, exact.body).toBe(200);
    const retained = exact.json<CommandLinkBaselineRecordResponse>();
    const candidate = release.release.basis.avoidance.candidates[0]!;
    const source: MonitoringReportSourceV2 = {
      version: 'monitoring.window.2',
      sourceSessionId: `${f.tenantId}:observer`,
      sourceWindowId: 'window-1',
      sourceRevision: 1,
      occurredAt: end,
      control: {
        hazardId: candidate.hazardId,
        controlId: candidate.controlId,
        controlVersion: candidate.controlVersion,
        controlEventId: candidate.controlEventId,
        controlDigest: candidate.controlDigest,
        acceptance: candidate.acceptance,
      },
      window: { start, end },
      populationComplete: options.complete ?? false,
      completeThrough: options.complete ? end : start,
      flights: [
        {
          flightId,
          aircraftId: raw.aircraftId,
          mission: release.release.basis.avoidance.mission,
          c2SourceId: f.sourceId,
          c2SourceSessionId: baselineSource.sourceSessionId,
          baseline: {
            eventId: retained.baseline.eventId,
            receiptId: retained.baseline.receiptId,
            sourceEventId: retained.baseline.input.payload.sourceEventId,
            digest: retained.digest,
          },
          observedIntervals: [{ start, end }],
          coverageIntervals: options.complete ? [{ start, end }] : null,
          gaps: [],
          declaredC2SourceEventIds: [],
        },
      ],
    };
    if (options.extraFlight) {
      const created = await call(f, 'POST', '/v1/flights', {
        originationKey: `${f.tenantId}:second-monitoring-flight`,
      });
      expect(created.statusCode, created.body).toBe(201);
      await drain(f);
      const additionalFlightId = created.json().flight.id as string;
      const additionalMission: MissionSource = {
        ...raw,
        aircraftId: `${raw.aircraftId}-second`,
        sourceMissionId: `${raw.sourceMissionId}-second`,
      };
      const shown = await timeline(f, additionalFlightId);
      const assigned = await call(f, 'POST', '/v1/commands', {
        kind: 'flight.assign',
        flightId: additionalFlightId,
        aircraft: additionalMission.aircraftId,
        expectedRevision: shown.flight.revision,
        expectedBasisRevision: shown.flight.basisRevision,
      });
      expect(assigned.statusCode, assigned.body).toBe(201);
      const { sourceRevision, occurredAt: missionAt, ...missionPayload } = additionalMission;
      const missionReceipt = await call(
        f,
        'POST',
        '/v1/inputs',
        {
          kind: 'mission.revision',
          sourceId: f.sourceId,
          sourceRevision,
          occurredAt: missionAt,
          subject: { flightId: additionalFlightId },
          artifactId: await upload(f, additionalMission),
          fidelity: 'synthetic_contract',
          payload: missionPayload,
        },
        'source',
      );
      expect(missionReceipt.statusCode, missionReceipt.body).toBe(201);
      const additionalBaseline: CommandLinkBaselineSource = {
        ...baselineSource,
        flightId: additionalFlightId,
        aircraftId: additionalMission.aircraftId,
        sourceSessionId: `${baselineSource.sourceSessionId}-second`,
      };
      const {
        sourceId: c2SourceId,
        sourceSessionId: c2Session,
        occurredAt: c2At,
        flightId: c2Flight,
        ...c2Payload
      } = additionalBaseline;
      const baselineReceipt = await recordRetainedCommandLinkBaseline(
        pool,
        { id: f.principals.source, tenantId: f.tenantId },
        {
          kind: 'command-link.baseline',
          sourceId: c2SourceId,
          sourceSessionId: c2Session,
          occurredAt: c2At,
          subject: { flightId: c2Flight },
          artifactId: await upload(f, additionalBaseline),
          fidelity: 'synthetic_contract',
          payload: c2Payload,
        },
        store,
      );
      await drain(f);
      const missionRead = await call(f, 'GET', `/v1/flights/${additionalFlightId}/mission/revisions/1`);
      expect(missionRead.statusCode, missionRead.body).toBe(200);
      const mission = missionRead.json<FlightMissionRevisionResponse>().mission;
      const baselineRead = await call(
        f,
        'GET',
        `/v1/flights/${additionalFlightId}/command-link-baselines/${baselineReceipt.eventId}`,
      );
      expect(baselineRead.statusCode, baselineRead.body).toBe(200);
      const native = baselineRead.json<CommandLinkBaselineRecordResponse>();
      source.flights.push({
        ...source.flights[0]!,
        flightId: additionalFlightId,
        aircraftId: additionalMission.aircraftId,
        c2SourceSessionId: c2Session,
        mission: {
          missionId: mission.missionId,
          sourceRevision: mission.sourceRevision,
          eventId: mission.id,
          contentDigest: mission.contentDigest,
          recordDigest: canonicalDigest(mission),
        },
        baseline: {
          eventId: native.baseline.eventId,
          receiptId: native.baseline.receiptId,
          sourceEventId: native.baseline.input.payload.sourceEventId,
          digest: native.digest,
        },
      });
      source.flights.sort((left, right) =>
        left.flightId < right.flightId ? -1 : left.flightId > right.flightId ? 1 : 0,
      );
    }
    const monitoringInput = async (original: MonitoringReportSourceV2 = source): Promise<MonitoringReportInputV2> => {
      const { sourceSessionId, occurredAt, ...payload } = original;
      return {
        sourceId: f.sourceId,
        sourceSessionId,
        kind: 'monitoring.window',
        occurredAt,
        artifactId: await upload(f, original),
        fidelity: 'synthetic_contract',
        payload,
      };
    };
    const grantMonitoring = async (role: Role = 'source', sources = [f.sourceId]) => {
      const current = await principal(f, role);
      const capabilities = [...new Set([...current.capabilities, 'input:write', 'monitoring:write'])];
      const changed = await call(f, 'POST', '/v1/commands', {
        kind: 'authority.update',
        principalId: current.id,
        expectedRevision: current.revision,
        capabilities,
        monitoringSources: sources,
      });
      expect(changed.statusCode, changed.body).toBe(201);
    };
    const readMonitoring = async (id: string) => {
      const response = await call(f, 'GET', `/v1/organization/monitoring-windows/${id}`);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.rawPayload.length).toBeLessThanOrEqual(256 * 1024);
      return response.json<MonitoringWindowRecordResponse>();
    };
    return { ...context, source, baselineSource, monitoringInput, grantMonitoring, readMonitoring };
  }

  it('lists a source-reported window for its control in the shape every control window shares', async () => {
    const {
      f,
      flightId,
      source,
      records,
      control: controlRecord,
      monitoringInput,
      grantMonitoring,
    } = await preparedMonitoring('control-window-list', {
      baselineState: 'up',
      complete: true,
    });
    await grantMonitoring();
    await authority(f, 'sam', ['flight:read', 'evidence:read']);
    await drain(f);
    const first = await call(f, 'POST', '/v1/inputs', await monitoringInput(), 'source');
    expect(first.statusCode, first.body).toBe(201);
    const second = await call(
      f,
      'POST',
      '/v1/inputs',
      await monitoringInput({ ...source, sourceRevision: 2, occurredAt: new Date().toISOString() }),
      'source',
    );
    expect(second.statusCode, second.body).toBe(201);
    await drain(f);
    // The hazard's monitoring history, which follows the accepted control record version, lists both revisions.
    const history = await call(
      f,
      'GET',
      `/v1/hazards/${records.hazardId}/monitoring-windows?${new URLSearchParams({ controlEventId: source.control.controlEventId })}`,
      undefined,
      'sam',
    );
    expect(history.statusCode, history.body).toBe(200);
    expect(validMonitoringHistory(history.json()), JSON.stringify(validMonitoringHistory.errors)).toBe(true);
    const revisions = history.json<HazardMonitoringHistoryResponse>();
    expect(revisions).toMatchObject({
      hazardId: records.hazardId,
      controlEventId: source.control.controlEventId,
      controlDigest: controlRecord.bodyDigest,
    });
    expect(revisions.monitoring.map(({ id, sourceRevision }) => ({ id, sourceRevision }))).toEqual([
      { id: second.json().receipt.eventId, sourceRevision: 2 },
      { id: first.json().receipt.eventId, sourceRevision: 1 },
    ]);
    const query = new URLSearchParams({
      controlKind: 'control_record',
      hazardId: source.control.hazardId,
      controlId: source.control.controlId,
    });
    const listed = await call(f, 'GET', `/v1/control-windows?${query}`, undefined, 'sam');
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json()).toMatchObject({
      truncated: false,
      windows: [
        {
          variant: 'retained',
          control: {
            kind: 'control_record',
            hazardId: source.control.hazardId,
            recordId: source.control.controlId,
            versionNumber: source.control.controlVersion,
            bodyDigest: source.control.controlDigest,
            acceptanceId: source.control.acceptance.id,
          },
          period: source.window,
          population: {
            subjectKind: 'flight',
            subjects: [{ scope: 'ledger', kind: 'flight', id: flightId }],
            complete: true,
            declaredBy: { kind: 'source', id: f.sourceId },
          },
          expectedObservations: [],
          indicators: [],
          revision: { number: 2, id: second.json().receipt.eventId },
        },
      ],
    });
    // The retained record stays readable where it was recorded.
    const retained = await call(f, 'GET', `/v1/organization/monitoring-windows/${second.json().receipt.eventId}`);
    expect(retained.statusCode, retained.body).toBe(200);
    expect(retained.json().digest).toBe(listed.json().windows[0].revision.digest);

    // A generic window for the same control record is listed beside it, newest first.
    const flightsFlown = defineIndicator({
      id: 'test.reported-flights-per-flight',
      version: 1,
      title: 'Reported flights per flight',
      description: 'A fictional indicator that only needs flight reports.',
      scope: { kind: 'subject_kind', subjectKind: 'flight' },
      events: { kind: 'observations', type: 'flight.report', versions: [1] },
      exposure: { kind: 'exposure.flights', version: 1, params: {} },
      window: { maxMilliseconds: 24 * 60 * 60 * 1000 },
      completeness: { exposureMustExceed: '0', populationDeclaredComplete: true, coverageWithoutGaps: true },
      unit: { per: 1, label: 'per flight', fractionDigits: 2 },
    });
    registerIndicatorDefinition(flightsFlown);
    await authority(f, 'sam', ['flight:read', 'evidence:read', 'monitoring:write']);
    const control = listed.json().windows[0].control;
    const opened = await call(
      f,
      'POST',
      '/v1/control-windows',
      {
        control,
        period: source.window,
        subjectKind: 'flight',
        subjects: [{ scope: 'ledger', kind: 'flight', id: flightId }],
        complete: true,
        expectedObservations: [{ type: 'flight.report', versions: [1] }],
        indicators: [{ id: flightsFlown.id, version: 1, digest: flightsFlown.digest }],
        note: 'The fictional mission flight.',
      },
      'sam',
    );
    expect(opened.statusCode, opened.body).toBe(201);
    const both = await call(f, 'GET', `/v1/control-windows?${query}`, undefined, 'sam');
    expect(both.statusCode, both.body).toBe(200);
    expect(both.json().windows.map((window: { variant: string }) => window.variant)).toEqual(['generic', 'retained']);
    // Listed, each window also says in plain words what it covers and its indicators' titles.
    const { wording, ...generic } = both.json().windows[0];
    expect(generic).toEqual(opened.json().window);
    expect(wording).toMatchObject({ indicators: [{ id: flightsFlown.id, version: 1, title: flightsFlown.title }] });
    expect(both.json().windows[1].wording).toEqual({
      population: '1 flight, declared complete by the source Fictional source',
      indicators: [],
    });
  });

  it('retains V2 monitoring with explicit source authority, exact scope and fenced informational projection', async () => {
    const { f, flightId, source, monitoringInput, grantMonitoring, readMonitoring, preview, validity } =
      await preparedMonitoring('monitoring-retention');
    const foreign = await fixture('monitoring-foreign');
    const body = await monitoringInput();
    expect((await call(f, 'GET', '/v1/me', undefined, 'source')).json().principal.monitoringSources).toEqual([]);
    expect((await call(f, 'POST', '/v1/inputs', body, 'source')).statusCode).toBe(403);
    await grantMonitoring('source', []);
    expect((await call(f, 'POST', '/v1/inputs', body, 'source')).statusCode).toBe(403);
    await grantMonitoring();
    const key = randomUUID();
    const beforePreview = await preview();
    const beforeValidity = await validity();
    const beforeItems = (await timeline(f, flightId)).items;
    const register = async () =>
      (
        await admin.query<{ revision: string }>('SELECT revision FROM mission_avoidance_register WHERE tenant_id=$1', [
          f.tenantId,
        ])
      ).rows[0].revision;
    const beforeRegister = await register();
    const accepted = await call(f, 'POST', '/v1/inputs', body, 'source', key);
    expect(accepted.statusCode, accepted.body).toBe(201);
    const receipt = accepted.json().receipt;
    expect(receipt).toMatchObject({ kind: 'monitoring.window', linkStatus: 'linked', artifactId: body.artifactId });
    expect(receipt.flightId).toBeUndefined();
    const pending = await readMonitoring(receipt.eventId);
    expect(pending.processing).toBe('pending');
    expect(await register()).toBe(beforeRegister);
    expect((await preview()).contextDigest).toBe(beforePreview.contextDigest);
    expect((await validity()).status).toBe('current');
    expect(pending.digest).toBe(canonicalDigest(pending.monitoring));
    expect(pending.monitoring).toMatchObject({
      source,
      organizationId: `organization:${f.tenantId}`,
      original: { artifactId: body.artifactId },
      authority: {
        principalId: f.principals.source,
        checkedCapabilities: ['input:write', 'monitoring:write'],
        grantedSources: [f.sourceId],
      },
    });
    expect((await call(foreign, 'GET', `/v1/organization/monitoring-windows/${receipt.eventId}`)).statusCode).toBe(404);
    expect(
      await withScope(
        pool,
        { tenantId: foreign.tenantId, id: foreign.principals.author },
        async (client) =>
          (await client.query('SELECT id FROM monitoring_window_revisions WHERE id=$1', [receipt.eventId])).rowCount,
      ),
    ).toBe(0);
    await expect(
      admin.query('UPDATE monitoring_window_revisions SET id=id WHERE id=$1', [receipt.eventId]),
    ).rejects.toThrow('append-only');
    const expired = (await lease(f, receipt.eventId, 2))!;
    await expect(
      processLease(workerPool, expired, {
        objectStore: store,
        beforeCommit: () => leaseExpired(admin, 'work_items', expired.id),
      }),
    ).rejects.toMatchObject({ code: 'worker_lease_expired' });
    expect((await readMonitoring(receipt.eventId)).processing).not.toBe('completed');
    const reclaimed = (await lease(f, receipt.eventId))!;
    expect(await processLease(workerPool, expired, { objectStore: store })).toBe(false);
    expect(await processLease(workerPool, reclaimed, { objectStore: store })).toBe(true);
    expect(await readMonitoring(receipt.eventId)).toEqual({ ...pending, processing: 'completed' });
    await grantMonitoring('source', []);
    const replay = await call(f, 'POST', '/v1/inputs', body, 'source', key);
    expect(replay.statusCode, replay.body).toBe(201);
    expect(replay.json().receipt.id).toBe(receipt.id);
    expect((await call(f, 'POST', '/v1/inputs', body, 'source')).statusCode).toBe(403);
    expect(await register()).toBe(beforeRegister);
    expect((await preview()).contextDigest).toBe(beforePreview.contextDigest);
    expect(await validity()).toMatchObject({
      status: 'current',
      currentContextDigest: beforeValidity.currentContextDigest,
    });
    expect((await timeline(f, flightId)).items).toEqual(beforeItems);
    const link = await call(f, 'POST', '/v1/commands', {
      kind: 'identity.link',
      receiptId: receipt.id,
      flightId,
      expectedRevision: (await timeline(f, flightId)).flight.revision,
    });
    expect(link.statusCode, link.body).toBe(409);
    expect(link.json().error.code).toBe('monitoring_scope_fixed');
  });

  it('serializes monitoring revisions, preserves original semantic retries and rejects changed context or exact pins', async () => {
    const { f, source, monitoringInput, grantMonitoring, readMonitoring, missionInput } =
      await preparedMonitoring('monitoring-identity');
    await grantMonitoring();
    await grantMonitoring('sam');
    const body = await monitoringInput();
    const first = await call(f, 'POST', '/v1/inputs', body, 'source');
    expect(first.statusCode, first.body).toBe(201);
    const secondSource = {
      ...structuredClone(source),
      sourceRevision: 2,
      populationComplete: true,
      completeThrough: source.window.end,
    };
    const second = await monitoringInput(secondSource);
    const competing = await monitoringInput({ ...secondSource, populationComplete: false });
    const race = await Promise.all([
      call(f, 'POST', '/v1/inputs', second, 'source'),
      call(f, 'POST', '/v1/inputs', competing, 'sam'),
    ]);
    expect(race.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    expect(race.find((response) => response.statusCode === 409)!.json().error.code).toBe('source_revision_conflict');
    const same = await monitoringInput();
    const duplicate = await call(f, 'POST', '/v1/inputs', same, 'sam');
    expect(duplicate.statusCode, duplicate.body).toBe(201);
    expect(duplicate.json().receipt.id).toBe(first.json().receipt.id);
    expect(duplicate.json().receipt.artifactId).toBe(body.artifactId);
    const skipped = await call(
      f,
      'POST',
      '/v1/inputs',
      await monitoringInput({ ...source, sourceRevision: 4 }),
      'source',
    );
    expect(skipped.statusCode, skipped.body).toBe(409);
    const moved = await call(
      f,
      'POST',
      '/v1/inputs',
      await monitoringInput({
        ...source,
        sourceRevision: 3,
        window: { ...source.window, start: new Date(Date.parse(source.window.start) - 1).toISOString() },
      }),
      'source',
    );
    expect(moved.statusCode, moved.body).toBe(409);
    expect(moved.json().error.code).toBe('monitoring_context_conflict');
    const invalid = structuredClone(source);
    invalid.sourceWindowId = 'wrong-pin';
    invalid.flights[0]!.baseline.digest = '0'.repeat(64);
    const badPin = await call(f, 'POST', '/v1/inputs', await monitoringInput(invalid), 'source');
    expect([400, 404]).toContain(badPin.statusCode);
    const changedOriginal = await call(
      f,
      'POST',
      '/v1/inputs',
      { ...body, occurredAt: new Date(Date.parse(source.occurredAt) - 1).toISOString() },
      'source',
    );
    expect(changedOriginal.statusCode, changedOriginal.body).toBe(400);
    await drain(f);
    const revisedMission = await call(f, 'POST', '/v1/inputs', await missionInput(2), 'source');
    expect(revisedMission.statusCode, revisedMission.body).toBe(201);
    await drain(f);
    const historicalPins = await call(
      f,
      'POST',
      '/v1/inputs',
      await monitoringInput({ ...source, sourceRevision: 3 }),
      'source',
    );
    expect(historicalPins.statusCode, historicalPins.body).toBe(201);
    await drain(f);
    expect((await readMonitoring(first.json().receipt.eventId)).monitoring.source).toEqual(source);
  });

  it('verifies monitoring V2 receipts and originals in flight, unrelated prefix and organization exports', async () => {
    const { f, flightId, originId, source, monitoringInput, grantMonitoring } =
      await preparedMonitoring('monitoring-exports');
    await grantMonitoring();
    await authority(f, 'author', [...new Set([...(await principal(f)).capabilities, 'evidence:read', 'pack:adopt'])]);
    const body = await monitoringInput();
    const accepted = await call(f, 'POST', '/v1/inputs', body, 'source');
    expect(accepted.statusCode, accepted.body).toBe(201);
    await drain(f);
    const monitoring = await call(f, 'GET', `/v1/organization/monitoring-windows/${accepted.json().receipt.eventId}`);
    expect(monitoring.statusCode, monitoring.body).toBe(200);
    const record = async (id: string) => {
      const shown = await timeline(f, id);
      const recorded = await call(f, 'POST', '/v1/commands', {
        kind: 'decision.record',
        flightId: id,
        expectedRevision: shown.flight.revision,
        expectedBasisRevision: shown.flight.basisRevision,
        inputCut: shown.meta.inputCut,
        expectedDependencyBasis: shown.meta.dependencyBasis!,
        decision: { kind: 'review', note: 'Review retained operational evidence.' },
      });
      expect(recorded.statusCode, recorded.body).toBe(201);
      await drain(f);
      return recorded.json().command.id as string;
    };
    const targetDecision = await record(flightId);
    const unrelatedDecision = await record(originId);
    const pack = (await call(f, 'GET', '/v1/rule-packs/ledger.part108-nprm/versions/1')).json().pack as RulePackVersion;
    const coverage = (await call(f, 'GET', '/v1/organization/coverage')).json<OrganizationCoverageResponse>();
    const adoptedResponse = await call(
      f,
      'POST',
      '/v1/commands',
      adoptShownPack(
        coverage,
        pack,
        { start: new Date(Date.now() - 1000).toISOString(), end: new Date(Date.now() + 60_000).toISOString() },
        'Review retained source evidence.',
        'shadow',
      ),
    );
    expect(adoptedResponse.statusCode, adoptedResponse.body).toBe(201);
    const adopted = (await call(f, 'GET', '/v1/organization/coverage'))
      .json<OrganizationCoverageResponse>()
      .adoptions.find((item) => item.id === adoptedResponse.json().command.id)!;
    const shown = (await call(f, 'GET', '/v1/organization/decisions')).json<OrganizationDecisionsResponse>();
    const review = await call(
      f,
      'POST',
      '/v1/commands',
      reviewShownAdoption(shown, adopted, 'Review monitoring as retained evidence.'),
    );
    expect(review.statusCode, review.body).toBe(201);
    await drain(f);
    for (const target of [
      { path: '/v1/exports', request: { flightId, decisionId: targetDecision, scope: 'whole_tenant_prefixes' } },
      {
        path: '/v1/exports',
        request: { flightId: originId, decisionId: unrelatedDecision, scope: 'whole_tenant_prefixes' },
      },
      {
        path: '/v1/subject-exports',
        request: {
          subject: { kind: 'organization' },
          decisionId: review.json().command.id,
          scope: 'whole_tenant_prefixes',
        },
      },
    ]) {
      const issued = await call(f, 'POST', target.path, target.request);
      expect(issued.statusCode, issued.body).toBe(201);
      const metadata = issued.json().record;
      const content = await call(f, 'GET', `${target.path}/${metadata.id}/content`);
      expect(content.statusCode, content.body.slice(0, 200)).toBe(200);
      const bundle = content.json();
      expect(verifyBundle(bundle, { expectedManifestDigest: metadata.manifestDigest }).status).toBe('verified');
      expect(bundle.receipts.find((item: { id: string }) => item.id === accepted.json().receipt.id)?.kind).toBe(
        'monitoring.window',
      );
      const original = bundle.artifacts.find((item: { id: string }) => item.id === body.artifactId);
      expect(JSON.parse(Buffer.from(original.bytesBase64, 'base64').toString())).toEqual(source);
      const altered = structuredClone(bundle);
      altered.artifacts.find((item: { id: string }) => item.id === body.artifactId).bytesBase64 =
        Buffer.from('{}').toString('base64');
      expect(() => verifyBundle(altered, { expectedManifestDigest: metadata.manifestDigest })).toThrow();
    }
  });

  it('retains exact named briefings and personal historical acknowledgements without changing operational eligibility', async () => {
    const {
      f,
      flightId,
      area,
      control,
      release,
      preview,
      validity,
      missionInput,
      briefingCommand,
      read,
      acknowledgements,
      acknowledge,
    } = await prepared('lifecycle');
    const foreign = await fixture('foreign');
    const invalid = await call(f, 'POST', '/v1/commands', await briefingCommand([foreign.principals.sam]));
    expect(invalid.statusCode, invalid.body).toBe(400);
    expect(invalid.json().error.code).toBe('briefing_recipients_invalid');
    const beforePreview = await preview();
    const beforeValidity = await validity();
    expect(beforeValidity.status).toBe('current');
    const registerRevision = async () =>
      (
        await admin.query<{ revision: string }>('SELECT revision FROM mission_avoidance_register WHERE tenant_id=$1', [
          f.tenantId,
        ])
      ).rows[0].revision;
    const register = await registerRevision();
    const departureCommand: MissionDepartureAuthorizationCommand = {
      kind: 'mission.departure-authorize',
      flightId,
      aircraftId: release.release.aircraftId,
      release: { id: release.release.id, digest: release.digest },
      departureAttemptId: randomUUID(),
      allocation: { id: randomUUID(), digest: sha256(randomUUID()) },
      expectedPrincipalRevision: (await principal(f)).revision,
      expectedControlsDigest: await controlsDigest(f, flightId),
    };
    const departureKey = randomUUID();
    const departure = await call(f, 'POST', '/v1/commands', departureCommand, 'author', departureKey);
    expect(departure.statusCode, departure.body).toBe(201);
    const permit = departure.json<MissionDepartureAuthorizationResponse>().authorization;
    await drain(f);
    const body = await briefingCommand();
    const key = randomUUID();
    const accepted = await call(f, 'POST', '/v1/commands', body, 'author', key);
    expect(accepted.statusCode, accepted.body).toBe(201);
    const briefingId = accepted.json().command.id as string;
    expect(accepted.json().command.payload).toEqual(body);
    const retained = await read(briefingId);
    expect(retained.digest).toBe(canonicalDigest(retained.briefing));
    expect(retained.briefing).toMatchObject({
      context: {
        release: body.release,
        mission: release.release.basis.avoidance.mission,
        controls: body.controls,
        contextDigest: release.release.basis.avoidance.contextDigest,
      },
      content: {
        message: body.message,
        controls: [
          {
            controlType: {
              id: avoidanceAreaControlType.id,
              version: control.controlType.version,
              digest: controlTypeDigest(avoidanceAreaControlType),
              title: avoidanceAreaControlType.title,
            },
            title: control.title,
            description: control.description,
            parameters: { center: area.center, radiusMeters: area.radiusMeters },
            area: { center: area.center, radiusMeters: area.radiusMeters },
            effectiveFrom: area.effectiveFrom,
            effectiveUntil: area.effectiveUntil,
          },
        ],
      },
      population: {
        recipients: [{ principalId: f.principals.sam, kind: 'human', name: 'Sam Rivera', principalRevision: 1 }],
      },
      actor: { id: f.principals.author, checkedCapabilities: ['flight:read', 'briefing:write'] },
    });
    const { digest: populationDigest, ...population } = retained.briefing.population;
    expect(populationDigest).toBe(canonicalDigest(population));
    const path = `/v1/flights/${flightId}/briefings/${briefingId}`;
    expect((await call(foreign, 'GET', path)).statusCode).toBe(404);
    expect((await call(foreign, 'GET', `${path}/acknowledgements`)).statusCode).toBe(404);
    expect(
      await withScope(
        pool,
        { tenantId: foreign.tenantId, id: foreign.principals.author },
        async (client) => (await client.query('SELECT id FROM mission_briefings WHERE id=$1', [briefingId])).rowCount,
      ),
    ).toBe(0);
    await expect(admin.query('UPDATE mission_briefings SET id=id WHERE id=$1', [briefingId])).rejects.toThrow(
      'append-only',
    );
    const expiredLease = (await lease(f, briefingId, 2))!;
    await expect(
      processLease(workerPool, expiredLease, {
        objectStore: store,
        beforeCommit: () => leaseExpired(admin, 'work_items', expiredLease.id),
      }),
    ).rejects.toMatchObject({ code: 'worker_lease_expired' });
    expect((await timeline(f, flightId)).items.some((item) => item.id === briefingId)).toBe(false);
    const reclaimed = (await lease(f, briefingId))!;
    expect(Number(reclaimed.generation)).toBeGreaterThan(Number(expiredLease.generation));
    expect(await processLease(workerPool, expiredLease, { objectStore: store })).toBe(false);
    expect(await processLease(workerPool, reclaimed, { objectStore: store })).toBe(true);
    expect((await timeline(f, flightId)).items.find((item) => item.id === briefingId)).toMatchObject({
      kind: 'mission.brief',
      lane: 'checks',
      actorId: f.principals.author,
    });

    const proxy = await call(f, 'POST', '/v1/commands', await acknowledge(retained, 'author'));
    expect(proxy.statusCode, proxy.body).toBe(403);
    expect(proxy.json().error.code).toBe('briefing_recipient_required');
    const sam = await principal(f, 'sam');
    await authority(f, 'sam', sam.capabilities);
    expect((await principal(f, 'sam')).revision).toBe(2);
    const ackBody = await acknowledge(retained);
    const ackKey = randomUUID();
    const ack = await call(f, 'POST', '/v1/commands', ackBody, 'sam', ackKey);
    expect(ack.statusCode, ack.body).toBe(201);
    expect(ack.json().command.payload).toEqual(ackBody);
    const pending = await acknowledgements(briefingId);
    expect(pending).toMatchObject({
      population: retained.briefing.population,
      scope: 'declared_recipients_only',
      releaseValidity: { status: 'current' },
      recipients: [
        {
          recipientPrincipalId: sam.id,
          processing: 'pending',
          acknowledgement: {
            record: { recipientPrincipalId: sam.id, actor: { id: sam.id, kind: 'human', principalRevision: 2 } },
          },
        },
      ],
    });
    const acknowledgement = pending.recipients[0].acknowledgement!;
    expect(acknowledgement.digest).toBe(canonicalDigest(acknowledgement.record));
    const duplicate = await call(f, 'POST', '/v1/commands', ackBody, 'sam');
    expect(duplicate.statusCode, duplicate.body).toBe(409);
    expect(duplicate.json().error.code).toBe('briefing_already_acknowledged');
    await drain(f);
    expect((await acknowledgements(briefingId)).recipients[0].processing).toBe('completed');
    expect((await timeline(f, flightId)).items.find((item) => item.id === ack.json().command.id)).toMatchObject({
      kind: 'mission.briefing-acknowledge',
      lane: 'checks',
      actorId: sam.id,
    });
    await expect(
      admin.query('UPDATE mission_briefing_acknowledgements SET id=id WHERE id=$1', [acknowledgement.record.id]),
    ).rejects.toThrow('append-only');
    expect(
      await withScope(
        pool,
        { tenantId: foreign.tenantId, id: foreign.principals.author },
        async (client) =>
          (
            await client.query('SELECT id FROM mission_briefing_acknowledgements WHERE id=$1', [
              acknowledgement.record.id,
            ])
          ).rowCount,
      ),
    ).toBe(0);

    const replacement = await call(
      f,
      'POST',
      '/v1/commands',
      await briefingCommand([f.principals.sam, f.principals.lee]),
    );
    expect(replacement.statusCode, replacement.body).toBe(201);
    const replacementId = replacement.json().command.id as string;
    const replacementRecord = await read(replacementId);
    expect(replacementRecord.briefing.population.recipients.map((recipient) => recipient.principalId)).toEqual(
      [f.principals.lee, f.principals.sam].sort(),
    );
    expect(replacementRecord.briefing.population.digest).not.toBe(populationDigest);
    expect(
      (await acknowledgements(replacementId)).recipients.every(
        (recipient) => recipient.acknowledgement === null && recipient.processing === null,
      ),
    ).toBe(true);
    await drain(f);
    expect(await registerRevision()).toBe(register);
    expect((await preview()).contextDigest).toBe(beforePreview.contextDigest);
    expect(await validity()).toMatchObject({
      status: 'current',
      currentContextDigest: beforeValidity.currentContextDigest,
    });
    const permitRecovery = await call(f, 'POST', '/v1/commands', departureCommand, 'author', departureKey);
    expect(permitRecovery.statusCode, permitRecovery.body).toBe(201);
    expect(permitRecovery.json<MissionDepartureAuthorizationResponse>().authorization).toMatchObject({
      permit: permit.permit,
      digest: permit.digest,
      disposition: 'replayed',
    });

    expect((await call(f, 'POST', '/v1/inputs', await missionInput(2), 'source')).statusCode).toBe(201);
    await authority(
      f,
      'author',
      (await principal(f)).capabilities.filter((capability) => capability !== 'briefing:write'),
    );
    await authority(
      f,
      'sam',
      (await principal(f, 'sam')).capabilities.filter((capability) => capability !== 'briefing:ack'),
    );
    const briefReplay = await call(f, 'POST', '/v1/commands', body, 'author', key);
    expect(briefReplay.statusCode, briefReplay.body).toBe(201);
    expect(briefReplay.json().command).toEqual(accepted.json().command);
    const ackReplay = await call(f, 'POST', '/v1/commands', ackBody, 'sam', ackKey);
    expect(ackReplay.statusCode, ackReplay.body).toBe(201);
    expect(ackReplay.json().command).toEqual(ack.json().command);
    expect((await call(f, 'POST', '/v1/commands', body)).statusCode).toBe(403);
    expect((await call(f, 'POST', '/v1/commands', ackBody, 'sam')).statusCode).toBe(403);
    // The record is unchanged; only the instant its standing was read moves.
    const reread = await read(briefingId);
    expect({ ...reread, standing: { ...reread.standing, evaluatedAt: retained.standing.evaluatedAt } }).toEqual(
      retained,
    );
    expect(reread.standing.status).toBe('in_force');
    const changed = await acknowledgements(briefingId);
    expect(changed.releaseValidity.status).toBe('changed');
    expect(changed.recipients[0]).toMatchObject({ acknowledgement, processing: 'completed' });
    const historical = await call(f, 'POST', '/v1/commands', await acknowledge(replacementRecord, 'lee'), 'lee');
    expect(historical.statusCode, historical.body).toBe(201);
    expect(
      (await acknowledgements(replacementId)).recipients.find(
        (recipient) => recipient.recipientPrincipalId === f.principals.lee,
      ),
    ).toMatchObject({ processing: 'pending', acknowledgement: { record: { recipientPrincipalId: f.principals.lee } } });
  });

  it('pins the controls in scope the author saw on a briefing and a departure authorization', async () => {
    const { f, flightId, release, briefingCommand } = await prepared('pinned-controls');
    const shown = await call(f, 'GET', `/v1/flights/${flightId}/controls`);
    expect(shown.statusCode, shown.body).toBe(200);
    const seen = shown.json<FlightControlsResponse>();
    expect(seen.digest).toBe(
      canonicalDigest({
        version: 'flight.controls-seen.1',
        controls: seen.controls,
        notApplicable: seen.notApplicable,
        complete: seen.complete,
        mission: seen.mission,
      }),
    );
    const revision = (await principal(f)).revision;
    const departure = (expectedControlsDigest: string): MissionDepartureAuthorizationCommand => ({
      kind: 'mission.departure-authorize',
      flightId,
      aircraftId: release.release.aircraftId,
      release: { id: release.release.id, digest: release.digest },
      departureAttemptId: randomUUID(),
      allocation: { id: randomUUID(), digest: sha256(randomUUID()) },
      expectedPrincipalRevision: revision,
      expectedControlsDigest,
    });
    // A list other than the current one conflicts and records nothing.
    const stale = await call(f, 'POST', '/v1/commands', departure(sha256('another list')));
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json().error).toMatchObject({
      code: 'flight_controls_changed',
      details: { controlsDigest: seen.digest },
    });
    const staleBriefing = await call(f, 'POST', '/v1/commands', {
      ...(await briefingCommand()),
      expectedControlsDigest: sha256('another list'),
    });
    expect(staleBriefing.statusCode, staleBriefing.body).toBe(409);
    expect(staleBriefing.json().error.code).toBe('flight_controls_changed');
    // With controls in scope, a command that names no list is refused and records nothing.
    expect(seen.controls.length).toBeGreaterThan(0);
    const { expectedControlsDigest: _departureDigest, ...unpinnedDeparture } = departure(seen.digest);
    const { expectedControlsDigest: _briefingDigest, ...unpinnedBriefing } = await briefingCommand();
    for (const unpinned of [unpinnedDeparture, unpinnedBriefing]) {
      const refused = await call(f, 'POST', '/v1/commands', unpinned);
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json().error.code).toBe('flight_controls_not_seen');
    }

    const authorized = await call(f, 'POST', '/v1/commands', departure(seen.digest));
    expect(authorized.statusCode, authorized.body).toBe(201);
    const basis = (
      await admin.query('SELECT issuance_basis FROM mission_departure_authorizations WHERE id=$1', [
        authorized.json().command.id,
      ])
    ).rows[0].issuance_basis;
    expect(basis).toMatchObject({
      version: 'mission.departure-issuance.2',
      controls: { version: 'flight.controls-seen.1', controls: seen.controls, digest: seen.digest },
    });

    const body = { ...(await briefingCommand()), expectedControlsDigest: seen.digest };
    const briefed = await call(f, 'POST', '/v1/commands', body);
    expect(briefed.statusCode, briefed.body).toBe(201);
    const recorded = await call(f, 'GET', `/v1/flights/${flightId}/briefings/${briefed.json().command.id}`);
    expect(recorded.statusCode, recorded.body).toBe(200);
    const { briefing, digest } = recorded.json<MissionBriefingRecordResponse>();
    expect(digest).toBe(canonicalDigest(briefing));
    expect(briefing).toMatchObject({
      version: 'flight.mission-briefing.3',
      controls: { controls: seen.controls, complete: seen.complete, digest: seen.digest },
    });
    // Both records project, each checked against the command that named the list.
    await drain(f);
    const projected = await admin.query(
      `SELECT (SELECT COUNT(*) FROM mission_briefing_projection_views WHERE tenant_id=$1)
        +(SELECT COUNT(*) FROM mission_departure_projection_views WHERE tenant_id=$1) AS count`,
      [f.tenantId],
    );
    expect(Number(projected.rows[0].count)).toBe(2);
    // The command keeps the digest it named, which the database checked against the pinned list at commit.
    const command = await admin.query('SELECT payload FROM command_records WHERE id=$1', [briefed.json().command.id]);
    expect(command.rows[0].payload.expectedControlsDigest).toBe(seen.digest);
  });

  it('keeps native initial-state evidence informational for route avoidance and existing release validity', async () => {
    const { f, originId, flightId, raw, preview, validity } = await prepared('native-baseline');
    const beforePreview = await preview();
    const beforeValidity = await validity();
    const beforeOrigin = await timeline(f, originId);
    const registerRevision = async () =>
      (
        await admin.query<{ revision: string }>('SELECT revision FROM mission_avoidance_register WHERE tenant_id=$1', [
          f.tenantId,
        ])
      ).rows[0].revision;
    const beforeRegister = await registerRevision();
    for (const [index, targetFlight] of [originId, flightId].entries()) {
      const original: CommandLinkBaselineSource = {
        version: 'command-link.baseline.1',
        sourceId: f.sourceId,
        sourceSessionId: `${f.tenantId}:native-${index}`,
        sourceEventId: 'initial',
        flightId: targetFlight,
        aircraftId: index === 0 ? 'fictional-origin-aircraft' : raw.aircraftId,
        occurredAt: new Date(Date.now() - 60_000).toISOString(),
        state: 'unknown',
      };
      const { sourceId, sourceSessionId, flightId: boundFlight, occurredAt, ...payload } = original;
      const body: CommandLinkBaselineInput = {
        sourceId,
        sourceSessionId,
        kind: 'command-link.baseline',
        occurredAt,
        subject: { flightId: boundFlight },
        artifactId: await upload(f, original),
        fidelity: 'synthetic_contract',
        payload,
      };
      await recordRetainedCommandLinkBaseline(pool, { id: f.principals.source, tenantId: f.tenantId }, body, store);
    }
    for (const projected of [false, true]) {
      if (projected) await drain(f);
      expect(await registerRevision()).toBe(beforeRegister);
      expect((await preview()).contextDigest).toBe(beforePreview.contextDigest);
      expect(await validity()).toMatchObject({
        status: 'current',
        currentContextDigest: beforeValidity.currentContextDigest,
      });
      expect((await timeline(f, originId)).findings).toEqual(beforeOrigin.findings);
    }
  });

  it('keeps another flight’s release current when later evidence arrives on the hazard’s origin flight', async () => {
    // A release is changed only when something it pinned changes: a control version, an acceptance, the controls
    // listed or a finding it listed. A newer report on the flight the hazard was promoted from changes none of those;
    // the hazard's record page is where it shows as newer evidence.
    const { f, preview, validity, reportInput } = await prepared('origin-evidence');
    const beforePreview = await preview();
    const beforeValidity = await validity();
    expect(beforeValidity.status).toBe('current');
    expect((await call(f, 'POST', '/v1/inputs', await reportInput(2), 'source')).statusCode).toBe(201);
    await drain(f);
    expect((await preview()).contextDigest).toBe(beforePreview.contextDigest);
    expect(await validity()).toMatchObject({
      status: 'current',
      currentContextDigest: beforeValidity.currentContextDigest,
    });
  });

  // A prepared flight with a recorded briefing, and the same read made twice: once on its own, then with its snapshot
  // taken first and a mission revision accepted and projected, changing the flight view, before the read reaches the
  // flight. Both return the state before the change.
  async function snapshotReads(name: string) {
    const prepared_ = await prepared(name);
    const { f, flightId, missionInput, briefingCommand } = prepared_;
    const briefed = await call(f, 'POST', '/v1/commands', await briefingCommand());
    expect(briefed.statusCode, briefed.body).toBe(201);
    await drain(f);
    const author = { id: f.principals.author, tenantId: f.tenantId };
    const flightRevision = async () =>
      (
        await admin.query<{ revision: string }>('SELECT revision FROM flight_views WHERE tenant_id=$1 AND id=$2', [
          f.tenantId,
          flightId,
        ])
      ).rows[0]!.revision;
    let sourceRevision = 1;
    async function duringProjection<T>(read: (client: PoolClient, principal: AuthContext) => Promise<T>) {
      const before = await withScope(pool, author, read, 'flight:read', true);
      const during = await withScope(
        pool,
        author,
        async (client, principal) => {
          await client.query('SELECT 1 FROM flight_views');
          const projected = await flightRevision();
          const revised = await call(f, 'POST', '/v1/inputs', await missionInput(++sourceRevision), 'source');
          expect(revised.statusCode, revised.body).toBe(201);
          await drain(f);
          expect(await flightRevision()).not.toBe(projected);
          return read(client, principal);
        },
        'flight:read',
        true,
      );
      return { before, during };
    }
    return { ...prepared_, briefingId: briefed.json().command.id as string, duringProjection };
  }

  it('reads the avoidance preview and the controls in scope from the read’s snapshot while the flight is projected', async () => {
    const { flightId, duringProjection } = await snapshotReads('snapshot-avoidance');
    const preview = await duringProjection((client, principal) => getMissionAvoidance(client, principal, flightId));
    expect(preview.during.mission).toEqual(preview.before.mission);
    expect(preview.during.contextDigest).toBe(preview.before.contextDigest);
    const controls = await duringProjection((client, principal) =>
      getFlightControls(client, principal, flightId, true),
    );
    expect(controls.during.digest).toBe(controls.before.digest);
  });

  it('reads a release and its validity from the read’s snapshot while the flight is projected', async () => {
    const { flightId, release, duringProjection } = await snapshotReads('snapshot-release');
    const shown = await duringProjection((client, principal) =>
      getMissionRelease(client, principal, flightId, release.release.id),
    );
    expect(shown.during).toEqual(release);
    const validity = await duringProjection((client, principal) =>
      getMissionReleaseValidity(client, principal, flightId, release.release.id, true),
    );
    expect(validity.during).toMatchObject({
      status: validity.before.status,
      currentContextDigest: validity.before.currentContextDigest,
      reasons: validity.before.reasons,
    });
  });

  it('reads a briefing and its acknowledgements from the read’s snapshot while the flight is projected', async () => {
    const { flightId, briefingId, duringProjection } = await snapshotReads('snapshot-briefing');
    const briefing = await duringProjection((client, principal) =>
      getMissionBriefing(client, principal, flightId, briefingId, true),
    );
    const { standing: during, ...recordDuring } = briefing.during;
    const { standing: before, ...recordBefore } = briefing.before;
    expect(recordDuring).toEqual(recordBefore);
    expect({ ...during, evaluatedAt: undefined }).toEqual({ ...before, evaluatedAt: undefined });
    const acknowledged = await duringProjection((client, principal) =>
      getMissionBriefingAcknowledgements(client, principal, flightId, briefingId),
    );
    expect(acknowledged.during.recipients).toEqual(acknowledged.before.recipients);
    expect(acknowledged.during.releaseValidity.status).toBe(acknowledged.before.releaseValidity.status);
  });

  // A safety decision that closes the hazard or its accepted control, withdrawing the control, made while another
  // transaction holds the organization row.
  async function closeWhileHeld(
    name: string,
    closing: 'hazardId' | 'controlId',
    thenLock: (client: PoolClient, shown: Awaited<ReturnType<typeof prepared>>) => Promise<void>,
  ) {
    const flight = await prepared(name);
    const { f } = flight;
    const recordId = flight.records[closing];
    const shown = await readSafetyRecord(person(f, 'author'), recordId);
    let closed: ReturnType<typeof call> | undefined;
    await withScope(pool, { id: f.principals.author, tenantId: f.tenantId }, async (client) => {
      await organization(client, f.tenantId, 'SHARE');
      closed = call(f, 'POST', '/v1/commands', {
        kind: 'decision.record',
        subject: { kind: 'sms', id: recordId },
        expectedRevision: shown.basis.revision,
        expectedDependencyBasis: shown.basis.dependencyBasis,
        decision: { kind: 'record.close', note: 'The fictional area no longer needs avoiding.' },
      });
      closed.catch(() => undefined);
      await lockWaitStarted(admin);
      await thenLock(client, flight);
    });
    const response = await closed!;
    expect(response.statusCode, response.body).toBe(201);
    await drain(f);
    expect((await readSafetyRecord(person(f, 'author'), recordId)).record.status).toBe('closed');
  }

  it('withdraws an accepted control while a release holds the organization row and wants the register, in one lock order', async () => {
    // A release, departure or briefing takes the organization row, then the avoidance register.
    await closeWhileHeld('register-lock-order', 'controlId', async (client) => {
      await client.query('SELECT ledger_lock_mission_avoidance_register()');
    });
  });

  it('closes a hazard with an accepted control while a flight command holds the organization row and wants a subject, in one lock order', async () => {
    // A flight command takes the organization row, then its flight's subject; the hazard's basis closure reaches the
    // subject of the flight it was promoted from.
    await closeWhileHeld('subject-lock-order', 'hazardId', async (client, { f, originId }) => {
      await lockSubjects(client, f.tenantId, [originId], 'UPDATE');
    });
  });

  it('opens a hazard from a finding while a decision treating the finding holds it, in one lock order', async () => {
    const f = await fixture('finding-lock-order');
    const created = await call(f, 'POST', '/v1/flights', { originationKey: `${f.tenantId}:origin` });
    expect(created.statusCode, created.body).toBe(201);
    const flightId = created.json().flight.id as string;
    await drain(f);
    const source: CommandLinkSource = {
      sourceSessionId: `${f.tenantId}:capture`,
      sourceEventId: 'link-1',
      incidentId: `${f.tenantId}:incident`,
      aircraftId: 'fictional-origin-aircraft',
      occurredAt: new Date(Date.now() - 60_000).toISOString(),
      status: 'lost',
    };
    const reported = await call(
      f,
      'POST',
      '/v1/inputs',
      commandLinkObservationInput(source, await upload(f, source), flightId, f.sourceId),
      'source',
    );
    expect(reported.statusCode, reported.body).toBe(201);
    await drain(f);
    const finding = (await timeline(f, flightId)).findings!.find(
      (item) => item.latestEvaluation.leafId === COMMAND_LINK_LOSS_LEAF_ID,
    )!;
    // A decision treating the finding takes the flight view, the organization row, the flight's basis closure and the
    // finding; the hazard is opened from the finding while those are held, and the decision then wants the flight's
    // subject.
    let opened: Promise<string> | undefined;
    await withScope(pool, { id: f.principals.author, tenantId: f.tenantId }, async (client, who) => {
      await client.query('SELECT id FROM flight_views WHERE id=$1 FOR UPDATE', [flightId]);
      await organization(client, f.tenantId, 'SHARE');
      await lockSubjects(client, f.tenantId, [flightId], 'SHARE');
      await client.query('SELECT id FROM finding_views WHERE id=$1 FOR UPDATE', [finding.id]);
      opened = openHazard({
        safety: person(f, 'author'),
        safetyId: who.id,
        acceptor: person(f, 'author'),
        acceptorToken: f.tokens.author,
        findingId: finding.id,
        title: 'Reported interruption',
        center: { latitude: 38.5848, longitude: -121.5045 },
        radiusMeters: 250,
        effectiveFrom: new Date().toISOString(),
      });
      opened.catch(() => undefined);
      await lockWaitStarted(admin);
      await lockSubjects(client, f.tenantId, [flightId], 'UPDATE');
    });
    const hazardId = await opened!;
    expect((await readSafetyRecord(person(f, 'author'), hazardId)).record.kind).toBe('hazard');
  });

  it('closes a hazard while a revision of its control holds the control, in one lock order', async () => {
    const { f, records } = await prepared('records-lock-order');
    const hazard = await readSafetyRecord(person(f, 'author'), records.hazardId);
    // A control's revision locks its subject and record, then reads its hazard's record; the hazard is closed while
    // the first two are held.
    let closed: ReturnType<typeof call> | undefined;
    await withScope(pool, { id: f.principals.author, tenantId: f.tenantId }, async (client) => {
      await lockSmsRecord(client, f.tenantId, records.controlId);
      closed = call(f, 'POST', '/v1/commands', {
        kind: 'decision.record',
        subject: { kind: 'sms', id: records.hazardId },
        expectedRevision: hazard.basis.revision,
        expectedDependencyBasis: hazard.basis.dependencyBasis,
        decision: { kind: 'record.close', note: 'The fictional interruption is controlled.' },
      });
      closed.catch(() => undefined);
      await lockWaitStarted(admin);
      await client.query('SELECT id FROM sms_records WHERE tenant_id=$1 AND id=$2 FOR SHARE', [
        f.tenantId,
        records.hazardId,
      ]);
    });
    const response = await closed!;
    expect(response.statusCode, response.body).toBe(201);
    expect((await readSafetyRecord(person(f, 'author'), records.hazardId)).record.status).toBe('closed');
  });

  it('protects briefing authors and active populations through commit and serializes relevant safety publication', async () => {
    const { f, flightId, records, briefingCommand, read, validity } = await prepared('commit');
    const body = await briefingCommand();
    for (const role of ['author', 'sam'] as const) {
      const target = await principal(f, role);
      let rolledBackId: string | undefined;
      await expect(
        withScope(pool, { tenantId: f.tenantId, id: f.principals.author }, async (client, who) => {
          rolledBackId = (await acceptCommand(client, who, body)).id;
          await acceptCommand(client, who, {
            kind: 'authority.update',
            principalId: target.id,
            expectedRevision: target.revision,
            capabilities: target.capabilities,
            ...(role === 'sam' ? { active: false } : {}),
          });
        }),
      ).rejects.toMatchObject({ code: 'concurrent_change' });
      expect(rolledBackId).toBeDefined();
      expect((await principal(f, role)).revision).toBe(target.revision);
      expect((await admin.query('SELECT id FROM mission_briefings WHERE id=$1', [rolledBackId])).rowCount).toBe(0);
      expect(
        (await admin.query('SELECT id FROM journal_events WHERE tenant_id=$1 AND id=$2', [f.tenantId, rolledBackId]))
          .rowCount,
      ).toBe(0);
      expect((await admin.query('SELECT id FROM work_items WHERE event_id=$1', [rolledBackId])).rowCount).toBe(0);
    }
    // The relevant safety publication is a newer assessment of the hazard on the safety record, which asks for review
    // before its accepted area counts as current again.
    const hazard = await readSafetyRecord(person(f, 'author'), records.hazardId);
    const reassessment = {
      kind: 'decision.record',
      subject: { kind: 'sms', id: records.hazardId },
      expectedRevision: hazard.basis.revision,
      expectedDependencyBasis: hazard.basis.dependencyBasis,
      decision: {
        kind: 'risk.assess',
        note: 'Reassessed while a briefing is being recorded.',
        matrix: { recordId: hazard.matrix!.record.id, versionNumber: hazard.matrix!.version.versionNumber },
        initial: { severity: 'major', likelihood: 'remote' },
        controls: [{ recordId: records.controlId, versionNumber: 1 }],
        residual: { severity: 'minor', likelihood: 'remote' },
        newHazardCheck: { answer: 'none_identified' },
        ...(hazard.origin?.kind === 'finding' ? { evidence: { evaluationId: hazard.origin.evaluationId } } : {}),
      },
    };
    let announce!: (id: string) => void;
    let release!: () => void;
    const accepted = new Promise<string>((resolve) => {
      announce = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const accepting = withScope(pool, { tenantId: f.tenantId, id: f.principals.author }, async (client, who) => {
      const result = await acceptCommand(client, who, body);
      announce(result.id);
      await held;
      return result;
    });
    const briefingId = await Promise.race([accepted, accepting.then((result) => result.id)]);
    let published = false;
    const sourceChange = call(f, 'POST', '/v1/commands', reassessment).then((response) => {
      published = true;
      return response;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(published).toBe(false);
    } finally {
      release();
    }
    expect((await accepting).id).toBe(briefingId);
    const changed = await sourceChange;
    expect(changed.statusCode, changed.body).toBe(201);
    expect((await read(briefingId)).briefing.context.release).toEqual(body.release);
    expect((await validity()).status).toBe('changed');
    expect(
      (await call(f, 'POST', '/v1/commands', { ...body, message: `${body.message} Recheck current context.` })).json()
        .error.code,
    ).toBe('briefing_release_not_current');
    expect((await timeline(f, flightId)).items.some((item) => item.id === briefingId)).toBe(false);
  });
});
