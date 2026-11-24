import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import { adoptExampleRiskMatrix } from '../../apps/api/src/seed-risk-matrix.js';
import type {
  Capability,
  FlightControlsResponse,
  MissionBriefingRecordResponse,
  MissionAvoidanceResponse,
  MissionReleaseCommand,
  MissionReleaseRecordResponse,
  MissionReleaseValidityResponse,
  MissionSource,
  SmsDecisionInput,
  SmsRecordDetailResponse,
  SmsSigningPreviewResponse,
  TimelineResponse,
} from '../../packages/contracts/src/index.js';
import { MissionAvoidanceResponseSchema } from '../../packages/contracts/src/openapi.js';
import { MissionReleaseRecordResponseSchema } from '../../packages/contracts/src/mission-release.js';
import {
  MissionBriefingRecordResponseSchema,
  missionBriefingControls,
} from '../../packages/contracts/src/mission-briefing.js';
import { missionSource } from '../../packages/contracts/fixtures/demo/v1/missions.js';
import { missionReleasePolicy } from '../../packages/contracts/fixtures/demo/v1/mission-release.js';
import { controlTypeDigest } from '../../packages/domain/src/control-types.js';
import { avoidanceAreaControlType } from '../../packages/domain/src/control-type-library.js';
import { sha256 } from '../../packages/integrity/src/index.js';
import { createPool, MemoryObjectStore, type AuthContext } from '../../packages/persistence/src/index.js';
import { LedgerClient } from '../../packages/contracts/src/client.js';
import { resolveAreaControl } from '../../apps/web/src/area-controls.js';
import { runOwnedWork, settleOwnedWork } from './worker-queue.js';

// A fictional organization's safety lead opens a hazard by hand, with no flight finding behind it, and its executive
// accepts the risk with an avoidance area on the safety record. Route review then reads that area with its geometry
// check, and a release outside it keeps it in its basis.
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
      'flight:create',
      'flight:read',
      'identity:write',
      'mission:release',
      'briefing:write',
    ],
  },
  executive: {
    kind: 'human',
    capabilities: [
      'sms:read',
      'sms:adopt',
      'decision:write',
      'evidence:read',
      'flight:read',
      'briefing:ack',
      'risk:accept:high',
    ],
  },
  source: { kind: 'source', capabilities: ['input:write', 'mission:write', 'flight:read'] },
  worker: { kind: 'worker', capabilities: ['flight:read', 'flight:create', 'evidence:read', 'input:write'] },
};

describe.runIf(process.env.LEDGER_ENV !== 'staging')('Avoidance-area control records in route review', () => {
  const prefix = `avoidance-area-${randomUUID()}`;
  const tenantId = `${prefix}:org`;
  const sourceId = `${prefix}-planner`;
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const workerPool = createPool(process.env.WORKER_DATABASE_URL);
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  const validAvoidance = ajv.compile(MissionAvoidanceResponseSchema);
  const validRelease = ajv.compile(MissionReleaseRecordResponseSchema);
  const validBriefing = ajv.compile(MissionBriefingRecordResponseSchema);
  const who = {} as Record<Role, AuthContext>;
  const hour = 3_600_000;
  const now = Date.now();
  let app: Awaited<ReturnType<typeof createApp>>;

  function call(principal: AuthContext, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, headers = {}) {
    return app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ledger-dev-${principal.id}`,
        'idempotency-key': randomUUID(),
        ...(method === 'PUT' ? { 'content-type': 'application/octet-stream' } : {}),
        ...headers,
      },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  }
  /** The web client a person's screen uses, answered by this app instead of the network. */
  function webClient(principal: AuthContext): LedgerClient {
    return new LedgerClient('http://ledger.test', `ledger-dev-${principal.id}`, (async (input, init) => {
      const url = new URL(String(input));
      const response = await app.inject({
        method: (init?.method ?? 'GET') as 'GET',
        url: `${url.pathname}${url.search}`,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      });
      return new Response(response.body, {
        status: response.statusCode,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch);
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
  // Settles this organization's work; earlier test files may leave work of their own behind.
  async function settle(): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt++) {
      const pending = await admin.query(
        "SELECT COUNT(*) AS count FROM work_items WHERE tenant_id=$1 AND state IN ('pending','leased')",
        [tenantId],
      );
      if (Number(pending.rows[0].count) === 0) return;
      if (!(await runOwnedWork(admin, workerPool, [prefix]))) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Worker did not settle');
  }
  async function registerRevision(): Promise<bigint> {
    const row = await admin.query('SELECT revision FROM mission_avoidance_register WHERE tenant_id=$1', [tenantId]);
    return BigInt(row.rows[0].revision);
  }

  async function createOrganization(): Promise<void> {
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, 'Fictional area organization']);
    for (const [role, person] of Object.entries(people) as [Role, (typeof people)[Role]][]) {
      who[role] = {
        id: `${tenantId}:${role}`,
        tenantId,
        name: `Fictional ${role}`,
        kind: person.kind,
        revision: 1,
        capabilities: person.capabilities,
      };
      await admin.query(
        'INSERT INTO principals(id,tenant_id,name,kind,capabilities,mission_sources) VALUES($1,$2,$3,$4,$5,$6)',
        [who[role].id, tenantId, who[role].name, person.kind, person.capabilities, role === 'source' ? [sourceId] : []],
      );
      await admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [
        sha256(`ledger-dev-${who[role].id}`),
        who[role].id,
      ]);
    }
  }

  /** A flight with an assigned aircraft and one projected mission over the given interval. */
  async function plannedFlight(label: string, interval: { start: string; end: string }) {
    const created = await call(who.safety, 'POST', '/v1/flights', { originationKey: `${tenantId}:${label}` });
    expect(created.statusCode, created.body).toBe(201);
    const flightId = created.json().flight.id as string;
    await settle();
    const raw: MissionSource = {
      ...missionSource,
      sourceMissionId: `${tenantId}:${label}`,
      operatingInterval: interval,
    };
    const shown = (await call(who.safety, 'GET', `/v1/flights/${flightId}/timeline`)).json<TimelineResponse>();
    await command(who.safety, {
      kind: 'flight.assign',
      flightId,
      aircraft: raw.aircraftId,
      expectedRevision: shown.flight.revision,
      expectedBasisRevision: shown.flight.basisRevision,
    });
    const bytes = Buffer.from(JSON.stringify(raw));
    const upload = await call(who.source, 'POST', '/v1/uploads', {
      byteLength: bytes.length,
      contentType: 'application/json',
    });
    expect(upload.statusCode, upload.body).toBe(201);
    const uploadId = upload.json().upload.id as string;
    expect((await call(who.source, 'PUT', `/v1/uploads/${uploadId}/content`, bytes)).statusCode).toBe(200);
    const artifact = await call(who.source, 'POST', `/v1/uploads/${uploadId}/finalize`);
    expect(artifact.statusCode, artifact.body).toBe(201);
    const { sourceRevision, occurredAt, ...payload } = raw;
    const accepted = await call(who.source, 'POST', '/v1/inputs', {
      kind: 'mission.revision',
      sourceId,
      sourceRevision,
      occurredAt,
      subject: { flightId },
      artifactId: artifact.json().artifact.id,
      fidelity: 'synthetic_contract',
      payload,
    });
    expect(accepted.statusCode, accepted.body).toBe(201);
    await settle();
    return { flightId, raw };
  }

  async function preview(flightId: string): Promise<MissionAvoidanceResponse> {
    const response = await call(who.safety, 'GET', `/v1/flights/${flightId}/mission-avoidance`);
    expect(response.statusCode, response.body).toBe(200);
    expect(validAvoidance(response.json()), JSON.stringify(validAvoidance.errors)).toBe(true);
    return response.json();
  }

  /** A hazard a person identified, with no flight or finding behind it. */
  async function manualHazard(title: string): Promise<string> {
    return (
      await command(who.safety, {
        kind: 'sms.record.open',
        record: {
          kind: 'hazard',
          schema: 'sms.hazard.1',
          title,
          ownerId: who.safety.id,
          body: {
            description: 'Crowds gather at the fictional market on delivery routes.',
            consequence: 'A dropped parcel or a forced landing among people.',
            source: { kind: 'manual_identification' },
          },
        },
      })
    ).subject.id;
  }

  async function proposeArea(
    hazardId: string,
    parameters: Record<string, unknown>,
    effective: { from: string; until?: string },
  ): Promise<string> {
    const listed = (await detail(hazardId)).controlTypes!.find((type) => type.id === avoidanceAreaControlType.id)!;
    expect(listed).toMatchObject({ version: 1, appliesTo: ['area'], checkedAutomatically: true });
    expect(listed.digest).toBe(controlTypeDigest(avoidanceAreaControlType));
    return (
      await command(who.safety, {
        kind: 'sms.record.open',
        record: {
          kind: 'control',
          schema: 'sms.control.1',
          title: 'Keep deliveries clear of the market',
          ownerId: who.safety.id,
          body: {
            hazardId,
            controlType: { id: listed.id, version: listed.version, digest: listed.digest },
            parameters,
            effectiveFrom: effective.from,
            ...(effective.until ? { effectiveUntil: effective.until } : {}),
          },
        },
      })
    ).subject.id;
  }

  async function assess(hazardId: string, controls: string[]): Promise<string> {
    const current = await detail(hazardId);
    await command(
      who.safety,
      decide(hazardId, current.basis, {
        kind: 'risk.assess',
        note: 'Assessed with the delivery crews, with the avoidance area in place.',
        matrix: { recordId: current.matrix!.record.id, versionNumber: current.matrix!.version.versionNumber },
        initial: { severity: 'major', likelihood: 'remote' },
        controls: controls.map((recordId) => ({ recordId, versionNumber: 1 })),
        residual: { severity: 'minor', likelihood: 'remote' },
        newHazardCheck: { answer: 'none_identified' },
      }),
    );
    return (await detail(hazardId)).decisions.find((decision) => decision.kind === 'risk.assess')!.id;
  }

  async function accept(hazardId: string, assessmentId: string): Promise<void> {
    const shown = await call(who.executive, 'GET', `/v1/sms/records/${hazardId}/signing?meaning=risk.accept`);
    expect(shown.statusCode, shown.body).toBe(200);
    const signing = shown.json() as SmsSigningPreviewResponse;
    expect(signing.available, signing.reason).toBe(true);
    const grant = await call(who.executive, 'POST', '/v1/local/reauthentications', {
      credential: `ledger-dev-${who.executive.id}`,
    });
    expect(grant.statusCode, grant.body).toBe(201);
    await command(
      who.executive,
      decide(hazardId, signing.basis, {
        kind: 'risk.accept',
        note: 'Residual risk accepted with the avoidance area in place.',
        assessmentId,
        signature: { intent: signing.intent!, contentDigest: signing.contentDigest!, reviewed: true },
      }),
      { 'x-ledger-reauthentication': grant.json().grant as string },
    );
  }

  async function findingsDigest(flightId: string): Promise<string> {
    const read = await call(who.safety, 'GET', `/v1/flights/${flightId}/mission-release-findings`);
    expect(read.statusCode, read.body).toBe(200);
    return read.json().basis.digest as string;
  }

  function releaseCommand(shown: MissionAvoidanceResponse, raw: MissionSource): MissionReleaseCommand {
    return {
      kind: 'mission.release',
      flightId: '',
      aircraftId: raw.aircraftId,
      mission: shown.mission!,
      calculation: { id: shown.calculation.id, version: shown.calculation.version, digest: shown.calculation.digest },
      policy: {
        id: missionReleasePolicy.id,
        version: missionReleasePolicy.version,
        digest: missionReleasePolicy.digest,
      },
      expectedContextDigest: shown.contextDigest!,
      expectedPrincipalRevision: 1,
      departureWindow: { start: raw.operatingInterval.start, end: raw.operatingInterval.end },
      note: 'Release this fictional delivery outside the accepted avoidance areas.',
    };
  }

  beforeAll(async () => {
    app = await createApp({ pool, env: 'test', objectStore: new MemoryObjectStore() });
    await app.ready();
    await createOrganization();
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

  it('reads an accepted area on a hazard a person opened, and reviews the route through it', async () => {
    const interval = { start: new Date(now + hour).toISOString(), end: new Date(now + 2 * hour).toISOString() };
    const { flightId, raw } = await plannedFlight('through', interval);
    expect(await preview(flightId)).toMatchObject({ status: 'outside', candidates: [] });

    // A risk matrix alone is not a safety program; a person who reads flights keeps opening on flights.
    expect((await call(who.safety, 'GET', '/v1/sms/program')).json()).toEqual({
      active: false,
      flights: true,
      safetyRecords: false,
    });
    const hazardId = await manualHazard('Crowds at the fictional market');
    expect((await call(who.safety, 'GET', '/v1/sms/program')).json()).toEqual({
      active: true,
      flights: true,
      safetyRecords: true,
    });
    const [longitude, latitude] = raw.route.geometry.coordinates[0]!;
    const parameters = { center: { latitude, longitude }, radiusMeters: 250, site: 'Fictional market' };
    const control = await proposeArea(hazardId, parameters, {
      from: new Date(now + hour / 2).toISOString(),
      until: new Date(now + 3 * hour).toISOString(),
    });
    // A proposal alone is not a candidate, nor is an assessment that lists it.
    const assessmentId = await assess(hazardId, [control]);
    expect((await preview(flightId)).candidates).toEqual([]);

    const before = await registerRevision();
    await accept(hazardId, assessmentId);
    expect(await registerRevision()).toBeGreaterThan(before);
    const accepted = await detail(hazardId);
    const acceptance = accepted.decisions.find((decision) => decision.kind === 'risk.accept')!;
    const shown = await preview(flightId);
    expect(shown.status).toBe('intersects');
    expect(shown.candidateCompleteness).toEqual({
      status: 'complete',
      count: 1,
      limit: 64,
      considered: 1,
      consideredLimit: 512,
    });
    expect(shown.candidates).toEqual([
      expect.objectContaining({
        hazardId,
        controlId: control,
        controlVersion: 1,
        controlDigest: accepted.controls![0]!.bodyDigest,
        template: {
          id: avoidanceAreaControlType.id,
          version: 1,
          digest: controlTypeDigest(avoidanceAreaControlType),
        },
        acceptance: expect.objectContaining({ id: acceptance.id, acceptedRevision: acceptance.acceptedRevision }),
        assessment: expect.objectContaining({ id: assessmentId }),
        authority: {
          policyVersion: 'ledger.sms-decision-authority.1',
          principalId: who.executive.id,
          principalRevision: 1,
          satisfyingCapability: 'risk:accept:high',
        },
        interval: { start: new Date(now + hour / 2).toISOString(), end: new Date(now + 3 * hour).toISOString() },
        geometry: 'intersects',
        context: 'current',
        reasons: [],
      }),
    ]);
    expect(shown.contextDigest).toMatch(/^[a-f0-9]{64}$/);

    // A flight screen shows the area through the shared web module, named with its hazard, with no error.
    const shownArea = await resolveAreaControl(webClient(who.safety), shown.candidates[0]!);
    expect(shownArea).toMatchObject({
      sourceLabel: 'Route avoidance area on the safety record',
      eventId: shown.candidates[0]!.controlEventId,
      title: 'Keep deliveries clear of the market',
      wording: `Keep planned routes clear of the circle of 250 m around ${latitude}, ${longitude} (Fictional market), at all altitudes.`,
      area: parameters,
      hazard: { id: hazardId, title: 'Crowds at the fictional market' },
      effective: { from: new Date(now + hour / 2).toISOString(), until: new Date(now + 3 * hour).toISOString() },
      owner: { id: who.safety.id },
    });
    // Only an accepted version is readable this way, and a mismatched reference is refused.
    const proposalOnly = await call(who.safety, 'GET', `/v1/area-controls/${hazardId}/${control}/versions/2`);
    expect(proposalOnly.statusCode).toBe(404);
    await expect(
      resolveAreaControl(webClient(who.safety), { ...shown.candidates[0]!, controlDigest: 'a'.repeat(64) }),
    ).rejects.toThrow(/could not be matched/);

    // A release is refused where the route crosses the circle.
    const refused = await call(who.safety, 'POST', '/v1/commands', {
      ...releaseCommand(shown, raw),
      flightId,
      expectedFindingsDigest: await findingsDigest(flightId),
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.code).toBe('release_avoidance_intersection');

    // A newer assessment of the hazard asks for review before the area counts as current again.
    await assess(hazardId, [control]);
    const reassessed = await preview(flightId);
    expect(reassessed.status).toBe('insufficient');
    expect(reassessed.candidates[0]).toMatchObject({ context: 'review_required', reasons: ['assessment_changed'] });
  });

  it('keeps an accepted area outside the route in the retained release basis and briefs it', async () => {
    const interval = { start: new Date(now + 5 * hour).toISOString(), end: new Date(now + 6 * hour).toISOString() };
    const { flightId, raw } = await plannedFlight('outside', interval);
    const hazardId = await manualHazard('Crowds at the fictional stadium');
    // Open-ended: in effect from before the mission and never ending.
    const control = await proposeArea(
      hazardId,
      { center: { latitude: 41.9, longitude: -87.7 }, radiusMeters: 300 },
      { from: new Date(now + 4 * hour).toISOString() },
    );
    await accept(hazardId, await assess(hazardId, [control]));
    const shown = await preview(flightId);
    expect(shown.status).toBe('outside');
    expect(shown.candidates).toEqual([
      expect.objectContaining({
        controlId: control,
        geometry: 'outside',
        context: 'current',
        interval: { start: new Date(now + 4 * hour).toISOString(), end: interval.end },
      }),
    ]);

    const released = await command(who.safety, {
      ...releaseCommand(shown, raw),
      flightId,
      expectedFindingsDigest: await findingsDigest(flightId),
    });
    await settle();
    const read = await call(who.safety, 'GET', `/v1/flights/${flightId}/mission-releases/${released.id}`);
    expect(read.statusCode, read.body).toBe(200);
    expect(validRelease(read.json()), JSON.stringify(validRelease.errors)).toBe(true);
    const retained = read.json() as MissionReleaseRecordResponse;
    expect(retained.release.basis.avoidance.candidates.map((candidate) => candidate.controlId)).toEqual([control]);
    expect(retained.release.basis.candidateContexts).toEqual([
      expect.objectContaining({
        acceptanceId: shown.candidates[0]!.acceptance.id,
        context: expect.objectContaining({
          version: 'mission.avoidance-control-record-context.1',
          hazard: { id: hazardId, latestAcceptanceId: shown.candidates[0]!.acceptance.id },
          control: { recordId: control, versionNumber: 1, status: expect.any(String) },
        }),
      }),
    ]);
    const validity = await call(who.safety, 'GET', `/v1/flights/${flightId}/mission-releases/${released.id}/validity`);
    expect(validity.statusCode, validity.body).toBe(200);
    expect((validity.json() as MissionReleaseValidityResponse).status).toBe('scheduled');

    // The released area is briefed from its control record version, and its recipient acknowledges it.
    const candidate = retained.release.basis.avoidance.candidates[0]!;
    const briefed = await command(who.safety, {
      kind: 'mission.brief',
      flightId,
      purpose: 'informational',
      release: { id: retained.release.id, digest: retained.digest },
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
      recipientPrincipalIds: [who.executive.id],
      message: 'Keep the delivery clear of the stadium area.',
      expectedPrincipalRevision: 1,
      expectedControlsDigest: (
        await call(who.safety, 'GET', `/v1/flights/${flightId}/controls`)
      ).json<FlightControlsResponse>().digest,
    });
    await settle();
    const readBriefing = await call(who.executive, 'GET', `/v1/flights/${flightId}/briefings/${briefed.id}`);
    expect(readBriefing.statusCode, readBriefing.body).toBe(200);
    expect(validBriefing(readBriefing.json()), JSON.stringify(validBriefing.errors)).toBe(true);
    const briefing = readBriefing.json() as MissionBriefingRecordResponse;
    expect(missionBriefingControls(briefing.briefing).map(({ content }) => content)).toEqual([
      {
        controlType: {
          id: avoidanceAreaControlType.id,
          version: 1,
          digest: controlTypeDigest(avoidanceAreaControlType),
          title: avoidanceAreaControlType.title,
        },
        title: 'Keep deliveries clear of the market',
        description: 'Keep planned routes clear of the circle of 300 m around 41.9, -87.7, at all altitudes.',
        parameters: { center: { latitude: 41.9, longitude: -87.7 }, radiusMeters: 300 },
        area: { center: { latitude: 41.9, longitude: -87.7 }, radiusMeters: 300 },
        effectiveFrom: new Date(now + 4 * hour).toISOString(),
        effectiveUntil: null,
      },
    ]);
    const projected = await admin.query(
      'SELECT 1 FROM mission_briefing_projection_views WHERE tenant_id=$1 AND briefing_id=$2',
      [tenantId, briefed.id],
    );
    expect(projected.rowCount).toBe(1);
    await command(who.executive, {
      kind: 'mission.briefing-acknowledge',
      flightId,
      briefing: { id: briefed.id, digest: briefing.digest },
      populationDigest: briefing.briefing.population.digest,
      attestation: 'reviewed_exact_briefing',
      expectedPrincipalRevision: 1,
    });
  });
});
