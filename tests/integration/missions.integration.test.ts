import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import { processLease, type WorkLease } from '../../apps/workers/src/index.js';
import { leaseExpired, projectOwnedWork, settleOwnedWork } from './worker-queue.js';
import type {
  FlightMissionResponse,
  FlightMissionRevisionResponse,
  MissionInput,
  MissionSource,
  OrganizationCoverageResponse,
  OrganizationDecisionsResponse,
  Receipt,
  TimelineResponse,
  MissionAvoidanceResponse,
  MissionRouteSuggestionRequest,
  MissionRouteSuggestionResponse,
} from '../../packages/contracts/src/index.js';
import {
  FlightMissionResponseSchema,
  FlightMissionRevisionResponseSchema,
  MissionRouteSuggestionResponseSchema,
} from '../../packages/contracts/src/openapi.js';
import { adoptShownPack, reviewShownAdoption } from '../../packages/contracts/fixtures/demo/v1/ready.js';
import { getRulePackVersion } from '../../packages/domain/src/index.js';
import { sha256 } from '../../packages/integrity/src/index.js';
import { createPool, MemoryObjectStore, withScope, type AuthContext } from '../../packages/persistence/src/index.js';
import { verifyBundle } from '../../tools/verifier/index.mjs';

type Role = 'operator' | 'sourceA' | 'sourceB' | 'ordinary';
interface Fixture {
  tenantId: string;
  sourceId: string;
  worker: AuthContext;
  principals: Record<Role, string>;
  tokens: Record<Role, string>;
}

describe.runIf(process.env.LEDGER_ENV !== 'staging')('PostgreSQL recorded mission geometry', () => {
  const prefix = `mission-${randomUUID()}`;
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const workerPool = createPool(process.env.WORKER_DATABASE_URL);
  const store = new MemoryObjectStore();
  const sourceCapabilities = ['input:write', 'mission:write', 'flight:read'];
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  const validCurrent = ajv.compile(FlightMissionResponseSchema);
  const validRevision = ajv.compile(FlightMissionRevisionResponseSchema);
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
    const principals = {} as Record<Role, string>;
    const tokens = {} as Record<Role, string>;
    const roles: Record<Role, string[]> = {
      operator: [
        'input:write',
        'flight:create',
        'flight:read',
        'decision:write',
        'identity:write',
        'correction:write',
        'authority:write',
        'evidence:read',
        'pack:adopt',
      ],
      sourceA: sourceCapabilities,
      sourceB: sourceCapabilities,
      ordinary: ['input:write', 'flight:read'],
    };
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, 'Fictional mission operator']);
    for (const role of Object.keys(roles) as Role[]) {
      const id = `${tenantId}:${role}`;
      principals[role] = id;
      tokens[role] = `ledger-dev-${id}`;
      await admin.query('INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,$4,$5)', [
        id,
        tenantId,
        `Fictional ${role}`,
        role === 'operator' ? 'human' : 'source',
        roles[role],
      ]);
      await admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [
        sha256(tokens[role]),
        id,
      ]);
    }
    const worker: AuthContext = {
      id: `${tenantId}:worker`,
      tenantId,
      name: 'Mission worker',
      kind: 'worker',
      capabilities: ['flight:read'],
      revision: 1,
    };
    await admin.query("INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,'worker',$4)", [
      worker.id,
      tenantId,
      worker.name,
      worker.capabilities,
    ]);
    return { tenantId, sourceId: `${tenantId}:planner`, worker, principals, tokens };
  }
  function call(
    f: Fixture,
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    payload?: unknown,
    role: Role = 'operator',
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
  async function grant(f: Fixture, role: 'sourceA' | 'sourceB', sources: string[]) {
    const principal = (await call(f, 'GET', '/v1/me', undefined, role)).json().principal;
    const response = await call(f, 'POST', '/v1/commands', {
      kind: 'authority.update',
      principalId: principal.id,
      expectedRevision: principal.revision,
      capabilities: principal.capabilities,
      missionSources: sources,
    });
    expect(response.statusCode, response.body).toBe(201);
  }
  async function lease(f: Fixture, eventId?: string, seconds = 30): Promise<WorkLease | null> {
    return withScope(workerPool, f.worker, async (client) => {
      const row = (
        await client.query<WorkLease>(
          `SELECT w.* FROM work_items w
        WHERE (w.state='pending' OR (w.state='leased' AND w.lease_until<clock_timestamp())) AND ($1::text IS NULL OR w.event_id=$1)
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
    await projectOwnedWork(admin, workerPool, [f.tenantId], { objectStore: store });
  }
  async function flight(f: Fixture, name: string) {
    const response = await call(f, 'POST', '/v1/flights', {
      originationKey: `${f.tenantId}:${name}`,
      aircraft: 'Display aircraft label',
      scheduledStart: '2026-10-01T17:00:00Z',
      scheduledEnd: '2026-10-01T17:30:00Z',
    });
    expect(response.statusCode, response.body).toBe(201);
    await drain(f);
    return response.json().flight.id as string;
  }
  async function timeline(f: Fixture, id: string): Promise<TimelineResponse> {
    const response = await call(f, 'GET', `/v1/flights/${id}/timeline`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }
  async function mission(f: Fixture, id: string): Promise<FlightMissionResponse> {
    const response = await call(f, 'GET', `/v1/flights/${id}/mission`);
    expect(response.statusCode, response.body).toBe(200);
    expect(validCurrent(response.json()), JSON.stringify(validCurrent.errors)).toBe(true);
    return response.json();
  }
  function source(revision: number, missionId = 'reported-mission-1'): MissionSource {
    return {
      sourceMissionId: missionId,
      sourceRevision: revision,
      aircraftId: 'reported-aircraft-1',
      occurredAt: '2026-10-01T16:00:00Z',
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
      operatingInterval: { start: '2026-10-01T18:00:00Z', end: '2026-10-01T18:20:00Z' },
    };
  }
  async function input(
    f: Fixture,
    flightId: string,
    raw: MissionSource,
    role: Role = 'sourceA',
    bytes = Buffer.from(`${JSON.stringify(raw)}\n`),
  ): Promise<MissionInput> {
    const uploaded = await call(
      f,
      'POST',
      '/v1/uploads',
      { byteLength: bytes.length, contentType: 'application/json' },
      role,
    );
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const uploadId = uploaded.json().upload.id;
    expect((await call(f, 'PUT', `/v1/uploads/${uploadId}/content`, bytes, role)).statusCode).toBe(200);
    const finalized = await call(f, 'POST', `/v1/uploads/${uploadId}/finalize`, undefined, role);
    expect(finalized.statusCode, finalized.body).toBe(201);
    const { sourceRevision, occurredAt, ...payload } = raw;
    return {
      kind: 'mission.revision',
      sourceId: f.sourceId,
      sourceRevision,
      occurredAt,
      subject: { flightId },
      artifactId: finalized.json().artifact.id,
      fidelity: 'synthetic_contract',
      payload,
    };
  }
  function decision(shown: TimelineResponse, note = 'Review the exact displayed operational record.') {
    return {
      kind: 'decision.record',
      flightId: shown.flight.id,
      expectedRevision: shown.flight.revision,
      expectedBasisRevision: shown.flight.basisRevision,
      inputCut: shown.meta.inputCut,
      expectedDependencyBasis: shown.meta.dependencyBasis,
      decision: { kind: 'operational.review', note },
    };
  }

  it('retains source planning bounds and pins a tenant-scoped suggestion to the current projected source', async () => {
    const f = await fixture('planning');
    const other = await fixture('planning-foreign');
    const flightId = await flight(f, 'planned');
    const raw = source(1, 'planned-return');
    const start = new Date(Date.now() + 60_000).toISOString();
    const end = new Date(Date.now() + 1_800_000).toISOString();
    raw.operatingInterval = { start, end };
    raw.route.geometry.coordinates.push([...raw.route.geometry.coordinates[0]!]);
    raw.routePlanning = {
      version: 'mission.route-planning.1',
      requiredLocations: [
        { role: 'launch', position: [...raw.route.geometry.coordinates[0]!] },
        { role: 'service', position: [...raw.route.geometry.coordinates[1]!] },
        { role: 'return', position: [...raw.route.geometry.coordinates.at(-1)!] },
      ],
      cruiseMetersPerSecond: 15,
      ascentMs: 20_000,
      serviceMs: 20_000,
      descentMs: 20_000,
      holdAllowanceMs: 30_000,
      handoffAllowanceMs: 30_000,
      marginMs: 10_000,
      customerInterval: { start, end },
      resourceInterval: { start, end },
    };
    const prepared = await input(f, flightId, raw);
    expect((await call(f, 'POST', '/v1/inputs', prepared, 'sourceA')).statusCode).toBe(403);
    expect((await call(f, 'POST', '/v1/inputs', prepared, 'operator')).statusCode).toBe(403);
    await grant(f, 'sourceA', [f.sourceId]);
    const accepted = await call(f, 'POST', '/v1/inputs', prepared, 'sourceA');
    expect(accepted.statusCode, accepted.body).toBe(201);
    expect((await mission(f, flightId)).acceptedHead!.record.routePlanning).toEqual(raw.routePlanning);
    await drain(f);
    expect((await mission(f, flightId)).projectedHead!.routePlanning).toEqual(raw.routePlanning);
    const original = await call(f, 'GET', `/v1/artifacts/${prepared.artifactId}/content`);
    expect(original.statusCode, original.body).toBe(200);
    expect(JSON.parse(original.body)).toEqual(raw);

    for (const invalid of [
      {
        ...structuredClone(raw),
        sourceRevision: 2,
        routePlanning: {
          ...raw.routePlanning,
          requiredLocations: [
            raw.routePlanning.requiredLocations[0]!,
            { role: 'service' as const, position: [0, 0] as [number, number] },
            raw.routePlanning.requiredLocations[2]!,
          ],
        },
      },
      {
        ...structuredClone(raw),
        sourceRevision: 2,
        operatingInterval: { start: new Date(Date.parse(start) - 1).toISOString(), end },
      },
    ]) {
      const rejected = await call(f, 'POST', '/v1/inputs', await input(f, flightId, invalid), 'sourceA');
      expect(rejected.statusCode, rejected.body).toBe(400);
      expect(rejected.json().error.code).toBe('mission_source_invalid');
    }
    const preview = (
      await call(f, 'GET', `/v1/flights/${flightId}/mission-avoidance`)
    ).json<MissionAvoidanceResponse>();
    expect(preview.status).toBe('outside');
    const request: MissionRouteSuggestionRequest = {
      expectedMission: preview.mission!,
      expectedContextDigest: preview.contextDigest!,
      clearanceMeters: 25,
    };
    const path = `/v1/flights/${flightId}/mission/route-suggestion`;
    const suggested = await call(f, 'POST', path, request, 'ordinary');
    expect(suggested.statusCode, suggested.body).toBe(200);
    const result = suggested.json<MissionRouteSuggestionResponse>();
    expect(ajv.compile(MissionRouteSuggestionResponseSchema)(result)).toBe(true);
    expect(result).toMatchObject({
      status: 'unchanged',
      mission: request.expectedMission,
      contextDigest: request.expectedContextDigest,
      proposedRoute: raw.route,
      timeFit: { status: 'fits' },
    });
    expect((await call(other, 'POST', path, request)).statusCode).toBe(404);
    expect((await call(f, 'POST', path, { ...request, expectedContextDigest: '0'.repeat(64) })).statusCode).toBe(409);
    const revised = { ...structuredClone(raw), sourceRevision: 2 };
    revised.route.geometry.coordinates.splice(1, 0, [-87.648, 41.884]);
    const revision = await call(f, 'POST', '/v1/inputs', await input(f, flightId, revised), 'sourceA');
    expect(revision.statusCode, revision.body).toBe(201);
    expect((await call(f, 'POST', path, request)).statusCode).toBe(409);
    await drain(f);
    const current = await mission(f, flightId);
    expect(current.projectedHead!.sourceRevision).toBe(2);
    expect(current.acceptedHead!.record.routePlanning).toEqual(raw.routePlanning);
  });

  it('retains authorized immutable plans, fences projection, preserves revision heads and verifies ordinary exports', async () => {
    const f = await fixture('lifecycle');
    const other = await fixture('foreign');
    const flightId = await flight(f, 'one');
    const secondFlight = await flight(f, 'two');
    const before = await timeline(f, flightId);
    expect((await mission(f, flightId)).binding).toBeNull();
    const raw = source(3);
    const initial = await input(f, flightId, raw);
    expect((await call(f, 'POST', '/v1/inputs', initial, 'sourceA')).statusCode).toBe(403);
    expect((await call(f, 'POST', '/v1/inputs', initial, 'ordinary')).statusCode).toBe(403);
    await grant(f, 'sourceA', [f.sourceId]);
    await grant(f, 'sourceB', [f.sourceId]);
    const copy = await input(f, flightId, raw, 'sourceB');
    const keys = [randomUUID(), randomUUID()];
    const results = await Promise.all([
      call(f, 'POST', '/v1/inputs', initial, 'sourceA', keys[0]),
      call(f, 'POST', '/v1/inputs', copy, 'sourceB', keys[1]),
    ]);
    for (const result of results) expect(result.statusCode, result.body).toBe(201);
    const receipt = results[0].json().receipt as Receipt;
    expect(results[1].json().receipt.id).toBe(receipt.id);
    let current = await mission(f, flightId);
    const firstRecord = current.acceptedHead!.record;
    expect(firstRecord.missionId).not.toBe(raw.sourceMissionId);
    expect(firstRecord.missionId).not.toBe(flightId);
    expect(current.projectedHead).toBeNull();
    expect(current.acceptedHead!.processing.status).toBe('pending');
    expect(firstRecord.sourceRevision).toBe(3);
    expect(firstRecord.route).toEqual(raw.route);
    expect(firstRecord.authority).toMatchObject({
      version: 'ledger.mission-authority.1',
      requiredCapabilities: ['input:write', 'mission:write'],
      sourceId: f.sourceId,
      grantedSources: [f.sourceId],
    });
    expect((await timeline(f, flightId)).flight.basisRevision).toBe(before.flight.basisRevision + 1);
    expect((await call(f, 'POST', '/v1/commands', decision(before))).statusCode).toBe(409);
    const reviewed = await call(f, 'POST', '/v1/commands', decision(await timeline(f, flightId)));
    expect(reviewed.statusCode, reviewed.body).toBe(201);
    expect((await call(other, 'GET', `/v1/flights/${flightId}/mission`)).statusCode).toBe(404);
    expect((await call(other, 'GET', `/v1/flights/${flightId}/mission/revisions/3`)).statusCode).toBe(404);
    const hidden = await withScope(pool, { id: other.principals.operator, tenantId: other.tenantId }, (client) =>
      client.query('SELECT id FROM mission_revisions WHERE id=$1', [firstRecord.id]),
    );
    expect(hidden.rowCount).toBe(0);
    const work = (await lease(f, receipt.eventId, 2))!;
    await expect(
      processLease(workerPool, work, {
        objectStore: store,
        beforeCommit: () => leaseExpired(admin, 'work_items', work.id),
      }),
    ).rejects.toMatchObject({ code: 'worker_lease_expired' });
    expect((await mission(f, flightId)).projectedHead).toBeNull();
    const reclaimed = (await lease(f, receipt.eventId))!;
    expect(await processLease(workerPool, work, { objectStore: store })).toBe(false);
    expect(await processLease(workerPool, reclaimed, { objectStore: store })).toBe(true);
    await drain(f);
    current = await mission(f, flightId);
    expect(current.projectedHead).toEqual(firstRecord);
    const exact = await call(f, 'GET', `/v1/flights/${flightId}/mission/revisions/3`);
    expect(validRevision(exact.json()), JSON.stringify(validRevision.errors)).toBe(true);
    expect(exact.json<FlightMissionRevisionResponse>().mission).toEqual(firstRecord);
    expect((await call(f, 'GET', `/v1/flights/${flightId}/mission/revisions/99`)).statusCode).toBe(404);
    const late = await call(f, 'POST', '/v1/inputs', await input(f, flightId, source(2)), 'sourceA');
    expect(late.statusCode, late.body).toBe(201);
    await drain(f);
    expect((await mission(f, flightId)).acceptedHead!.record).toEqual(firstRecord);
    expect((await mission(f, flightId)).projectedHead).toEqual(firstRecord);
    const fourth = await call(f, 'POST', '/v1/inputs', await input(f, flightId, source(4), 'sourceB'), 'sourceB');
    const fifth = await call(f, 'POST', '/v1/inputs', await input(f, flightId, source(5)), 'sourceA');
    expect(fourth.statusCode, fourth.body).toBe(201);
    expect(fifth.statusCode, fifth.body).toBe(201);
    await withScope(workerPool, f.worker, (client) =>
      client.query("UPDATE work_items SET state='failed',error='Fixture projection failure' WHERE event_id=$1", [
        fifth.json().receipt.eventId,
      ]),
    );
    current = await mission(f, flightId);
    expect(current.acceptedHead!.record.sourceRevision).toBe(5);
    expect(current.acceptedHead!.processing.status).toBe('failed');
    expect(current.projectedHead).toEqual(firstRecord);
    await withScope(workerPool, f.worker, (client) =>
      client.query("UPDATE work_items SET state='pending',error=NULL WHERE event_id=$1", [
        fifth.json().receipt.eventId,
      ]),
    );
    const highWork = (await lease(f, fifth.json().receipt.eventId))!;
    expect(await processLease(workerPool, highWork, { objectStore: store })).toBe(true);
    current = await mission(f, flightId);
    expect(current.acceptedHead!.record.sourceRevision).toBe(5);
    expect(current.projectedHead!.sourceRevision).toBe(5);
    expect(current.meta.outstandingWork).toBeGreaterThan(0);
    await drain(f);
    expect((await mission(f, flightId)).projectedHead!.sourceRevision).toBe(5);
    const conflicting = { ...raw, lateralToleranceMeters: 99 };
    expect((await call(f, 'POST', '/v1/inputs', await input(f, flightId, conflicting), 'sourceA')).statusCode).toBe(
      409,
    );
    const whitespace = await input(f, flightId, raw, 'sourceA', Buffer.from(JSON.stringify(raw, null, 2)));
    expect((await call(f, 'POST', '/v1/inputs', whitespace, 'sourceA')).statusCode).toBe(409);
    expect(
      (await call(f, 'POST', '/v1/inputs', { ...initial, subject: { flightId: secondFlight } }, 'sourceA')).statusCode,
    ).toBe(409);
    expect(
      (
        await call(
          f,
          'POST',
          '/v1/inputs',
          await input(f, flightId, { ...source(6), aircraftId: 'different-aircraft' }),
          'sourceA',
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (await call(f, 'POST', '/v1/inputs', await input(f, flightId, source(1, 'different-mission')), 'sourceA'))
        .statusCode,
    ).toBe(409);
    const mismapped = await input(f, flightId, source(6));
    mismapped.payload.altitude.maximum = 61;
    expect((await call(f, 'POST', '/v1/inputs', mismapped, 'sourceA')).statusCode).toBe(400);
    const shown = await timeline(f, flightId);
    const after = shown.flight;
    expect({
      activity: after.activity,
      aircraft: after.aircraft,
      start: after.scheduledStart,
      end: after.scheduledEnd,
      position: after.picture?.lastPosition,
    }).toEqual({
      activity: before.flight.activity,
      aircraft: before.flight.aircraft,
      start: before.flight.scheduledStart,
      end: before.flight.scheduledEnd,
      position: before.flight.picture?.lastPosition,
    });
    expect(shown.items.find((item) => item.id === receipt.eventId)?.lane).toBe('plan');
    const fixed = await call(f, 'POST', '/v1/commands', {
      kind: 'identity.link',
      flightId: secondFlight,
      receiptId: receipt.id,
      expectedRevision: (await timeline(f, secondFlight)).flight.revision,
    });
    expect(fixed.statusCode).toBe(409);
    expect(fixed.json().error.code).toBe('mission_scope_fixed');
    const correction = await call(f, 'POST', '/v1/commands', {
      ...decision(shown),
      kind: 'evidence.correct',
      decision: undefined,
      correctionOf: receipt.eventId,
      occurredAt: raw.occurredAt,
      note: 'Attempt a generic geometry replacement.',
      payload: { route: raw.route },
    });
    expect(correction.statusCode, correction.body).toBe(409);
    expect(correction.json().error.code).toBe('mission_revision_required');
    const issuer: 'sourceA' | 'sourceB' =
      firstRecord.authority.principalId === f.principals.sourceA ? 'sourceA' : 'sourceB';
    const issuerIndex = issuer === 'sourceA' ? 0 : 1;
    const issuerInput = issuer === 'sourceA' ? initial : copy;
    await grant(f, issuer, []);
    expect((await call(f, 'POST', '/v1/inputs', issuerInput, issuer, keys[issuerIndex])).json().receipt.id).toBe(
      receipt.id,
    );
    expect((await call(f, 'POST', '/v1/inputs', issuerInput, issuer)).statusCode).toBe(403);
    expect(
      (await call(f, 'GET', `/v1/flights/${flightId}/mission/revisions/3`)).json<FlightMissionRevisionResponse>()
        .mission,
    ).toEqual(firstRecord);
    await expect(
      admin.query('UPDATE mission_revisions SET record=record WHERE tenant_id=$1 AND id=$2', [
        f.tenantId,
        firstRecord.id,
      ]),
    ).rejects.toThrow(/append-only/);
    await grant(f, 'sourceA', [f.sourceId]);
    const unrelated = await call(
      f,
      'POST',
      '/v1/inputs',
      await input(f, secondFlight, source(1, 'unrelated-mission')),
      'sourceA',
    );
    expect(unrelated.statusCode, unrelated.body).toBe(201);
    const coverage = (await call(f, 'GET', '/v1/organization/coverage')).json<OrganizationCoverageResponse>();
    const adopted = await call(
      f,
      'POST',
      '/v1/commands',
      adoptShownPack(
        coverage,
        getRulePackVersion('ledger.demo-procedures', 1)!,
        { start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z' },
        'Fictional operator procedure review.',
        'active',
      ),
    );
    expect(adopted.statusCode, adopted.body).toBe(201);
    await drain(f);
    const decisions = (await call(f, 'GET', '/v1/organization/decisions')).json<OrganizationDecisionsResponse>();
    const adoption = (await call(f, 'GET', '/v1/organization/coverage'))
      .json<OrganizationCoverageResponse>()
      .adoptions.find((item) => item.id === adopted.json().command.id)!;
    const review = await call(
      f,
      'POST',
      '/v1/commands',
      reviewShownAdoption(decisions, adoption, 'Review the retained exact adoption.'),
    );
    expect(review.statusCode, review.body).toBe(201);
    await drain(f);
    for (const target of [
      {
        path: '/v1/exports',
        request: { flightId, decisionId: reviewed.json().command.id, scope: 'whole_tenant_prefixes' },
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
      const record = issued.json().record;
      const content = await call(f, 'GET', `${target.path}/${record.id}/content`);
      expect(content.statusCode, content.body.slice(0, 300)).toBe(200);
      const bundle = content.json();
      expect(verifyBundle(bundle, { expectedManifestDigest: record.manifestDigest }).status).toBe('verified');
      expect(bundle.receipts.some((item: { id: string }) => item.id === unrelated.json().receipt.id)).toBe(true);
      expect(bundle.decision.id).toBe(target.request.decisionId);
    }
  });
});
