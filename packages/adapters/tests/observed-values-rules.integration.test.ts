import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../apps/api/src/index.js';
import {
  djiFaultScripts,
  planScriptedFlight,
  type DjiFaultScript,
} from '../../../apps/emulators/src/dji-fault-script.js';
import { createEmulator, emulatorConfig } from '../../../apps/emulators/src/server.js';
import { adoptShownPack } from '../../contracts/fixtures/demo/v1/ready.js';
import { LedgerClient } from '../../contracts/src/client.js';
import type { OrganizationCoverageResponse, RuleEvaluationRecord } from '../../contracts/src/index.js';
import { getRulePackVersion } from '../../domain/src/rule-pack-registry.js';
import { sha256 } from '../../integrity/src/index.js';
import { EXAMPLE_WAIVER_PACK_ID } from '../../pack-example-waiver/src/index.js';
import { PART107_PACK_ID } from '../../pack-part107/src/index.js';
import { createPool, MemoryObjectStore, type AuthContext } from '../../persistence/src/index.js';
import { translateAndSubmit, type VendorMessage } from '../src/adapter-contract.js';
import { PkceClient } from '../src/index.js';
import { airspaceAuthorizationAdapter } from '../src/airspace-authorization.js';
import { djiOsdPositionAdapter } from '../src/dji-osd-position.js';
import { HttpObservationSink } from '../src/http-observation-sink.js';
import { runOwnedWork, settleOwnedWork } from '../../../tests/integration/worker-queue.js';

// Part 107 version 2 and the example waiver, adopted in active mode, read what the emulated aircraft and airspace
// service reported through the shipped adapters: a planned flight is checked on its plan as soon as the plan is
// recorded; once the airspace service reports an authorization and the aircraft reports positions, the same rules
// are evaluated again and say what they read. Nothing in core code names a rule, a source or a vendor.
const HEIGHT = 'ledger.part107.107.51.b';
const SPEED = 'ledger.part107.107.51.a';
const AIRSPACE = 'ledger.part107.107.41';
const WAIVER_HEIGHT = `${EXAMPLE_WAIVER_PACK_ID}.provision-4`;
const MINUTE = 60_000;

describe.runIf(process.env.LEDGER_ENV !== 'staging')('Regulatory rules read what was reported', () => {
  const prefix = `observed-${randomUUID()}`;
  const tenantId = `${prefix}:org`;
  const sourceId = `${prefix}-source`;
  const deviceId = `${prefix}-aircraft`;
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const workerPool = createPool(process.env.WORKER_DATABASE_URL);
  const emulatorSettings = { ...emulatorConfig({}), port: 0 };
  const emulator = createEmulator(emulatorSettings);
  let emulatorBase = '';
  let app: Awaited<ReturnType<typeof createApp>>;
  let address = '';
  let artifactId = '';
  const who = {} as Record<'actor' | 'source' | 'worker', AuthContext>;
  const start = Math.floor(Date.now() / MINUTE) * MINUTE - 2 * 60 * MINUTE;
  const at = (minutes: number) => new Date(start + minutes * MINUTE).toISOString();
  const flights = { past: '', future: '' };

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
    for (let attempt = 0; attempt < 600; attempt++) {
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
    throw new Error('Worker did not settle');
  }

  async function submit(type: string, subject: object, occurredAt: string, content: Record<string, unknown>) {
    const response = await call(who.source, 'POST', '/v1/inputs', {
      sourceId,
      kind: 'observation',
      occurredAt,
      payload: {
        type,
        version: 1,
        subject,
        occurredAt,
        sourceEventId: randomUUID(),
        fidelity: 'synthetic_contract',
        limitations: ['Fictional records.'],
        originalArtifactId: artifactId,
        ...content,
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    await settle();
  }

  async function createFlight(name: string, scheduledStart: string, scheduledEnd: string): Promise<string> {
    const created = await call(who.actor, 'POST', '/v1/flights', {
      originationKey: `${prefix}:${name}`,
      aircraft: deviceId,
      scheduledStart,
      scheduledEnd,
    });
    expect(created.statusCode, created.body).toBe(201);
    await settle();
    return created.json().flight.id as string;
  }

  /** A plan for the flight on the aircraft, with the window and the planned maximum height and speed. */
  async function plan(flightId: string, windowStartsAt: string, windowEndsAt: string): Promise<void> {
    await submit('operator.record', { kind: 'flight', id: flightId, scope: 'ledger' }, windowStartsAt, {
      secondarySubject: { kind: 'aircraft', id: deviceId, scope: 'source' },
      interval: { start: windowStartsAt, end: windowEndsAt },
      values: {
        recordType: 'flight.plan',
        recordVersion: 1,
        record: {
          windowStartsAt,
          windowEndsAt,
          operationKind: 'inspection',
          plannedOriginDescription: 'Fictional yard',
          plannedDestinationDescription: 'Fictional yard',
          routeSummary: 'Inspection along the river and back',
          plannedMaxHeightAboveGroundMeters: 80,
          plannedMaxGroundSpeedMetersPerSecond: 15,
        },
      },
    });
  }

  /** The latest evaluation of one rule about the flight, paging newest first. */
  async function latest(flightId: string, ruleId: string): Promise<RuleEvaluationRecord> {
    let cursor: string | undefined;
    for (;;) {
      const query = new URLSearchParams({
        subjectKind: 'flight',
        subjectId: flightId,
        limit: '100',
        ...(cursor ? { cursor } : {}),
      });
      const response = await call(who.actor, 'GET', `/v1/evaluations?${query}`);
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json();
      const found = (body.evaluations as RuleEvaluationRecord[]).find((item) => item.rule.id === ruleId);
      if (found) return found;
      expect(body.page.hasMore, ruleId).toBe(true);
      cursor = body.page.nextCursor as string;
    }
  }

  async function adopt(packId: string, version: number, parameters?: Record<string, Record<string, unknown>>) {
    const shown = await call(who.actor, 'GET', '/v1/organization/coverage');
    expect(shown.statusCode, shown.body).toBe(200);
    const adoption = adoptShownPack(
      shown.json<OrganizationCoverageResponse>(),
      getRulePackVersion(packId, version)!,
      {
        start: new Date(start - 24 * 60 * MINUTE).toISOString(),
        end: new Date(start + 14 * 24 * 60 * MINUTE).toISOString(),
      },
      'Fictional active adoption.',
      'active',
    );
    const adopted = await call(who.actor, 'POST', '/v1/commands', {
      ...adoption,
      ...(parameters ? { parameters } : {}),
    });
    expect(adopted.statusCode, adopted.body).toBe(201);
    await settle();
  }

  async function emulated(method: string, path: string, token: string, body?: unknown): Promise<Response> {
    const response = await fetch(`${emulatorBase}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'x-api-key': emulatorSettings.apiKey,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(response.status, path).toBe(200);
    return response;
  }

  beforeAll(async () => {
    await new Promise<void>((resolve) => emulator.server.listen(0, '127.0.0.1', resolve));
    emulatorBase = `http://127.0.0.1:${(emulator.server.address() as AddressInfo).port}`;
    app = await createApp({ pool, env: 'test', objectStore: new MemoryObjectStore() });
    address = await app.listen({ host: '127.0.0.1', port: 0 });
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, 'Fictional inspection operator']);
    const people = {
      actor: {
        kind: 'human',
        capabilities: ['flight:create', 'flight:read', 'evidence:read', 'authority:write', 'pack:adopt'],
      },
      source: { kind: 'source', capabilities: ['input:write', 'flight:read', 'evidence:read'] },
      // The worker leases this organization's work only while it has an active worker principal.
      worker: { kind: 'worker', capabilities: ['flight:read', 'evidence:read'] },
    } as const;
    for (const [role, person] of Object.entries(people) as [
      keyof typeof people,
      (typeof people)[keyof typeof people],
    ][]) {
      who[role] = {
        id: `${tenantId}:${role}`,
        tenantId,
        name: `Fictional ${role}`,
        kind: person.kind,
        revision: 1,
        capabilities: [...person.capabilities],
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
    const current = await call(who.actor, 'GET', `/v1/authority/principals/${encodeURIComponent(who.source.id)}`);
    expect(current.statusCode, current.body).toBe(200);
    const granted = await call(who.actor, 'POST', '/v1/commands', {
      kind: 'authority.update',
      principalId: who.source.id,
      expectedRevision: current.json().principal.revision,
      capabilities: current.json().principal.capabilities,
      observationGrants: ['operator.record', 'position.fix', 'airspace.authorization'].map((observationType) => ({
        sourceId,
        observationType,
      })),
    });
    expect(granted.statusCode, granted.body).toBe(201);
    const bytes = Buffer.from(JSON.stringify({ entered: 'fictional flight plans' }));
    const created = await call(who.source, 'POST', '/v1/uploads', {
      contentType: 'application/json',
      byteLength: bytes.byteLength,
    });
    const id = created.json().upload.id as string;
    expect((await call(who.source, 'PUT', `/v1/uploads/${id}/content`, bytes)).statusCode).toBe(200);
    artifactId = (await call(who.source, 'POST', `/v1/uploads/${id}/finalize`)).json().artifact.id as string;
    await adopt(PART107_PACK_ID, 2, { 'ledger.part107.107.9.timing': { timeZone: 'UTC' } });
    await adopt(EXAMPLE_WAIVER_PACK_ID, 1);
  });

  afterAll(async () => {
    await settleOwnedWork([prefix]);
    if (app) await app.close();
    emulator.server.closeAllConnections();
    await new Promise<void>((resolve) => emulator.server.close(() => resolve()));
    await pool.end();
    await admin.end();
    await workerPool.end();
  });

  it('checks a flight planned three days ahead on its plan as soon as the plan is recorded', async () => {
    const windowStartsAt = new Date(Date.now() + 3 * 24 * 60 * MINUTE).toISOString();
    const windowEndsAt = new Date(Date.parse(windowStartsAt) + 60 * MINUTE).toISOString();
    flights.future = await createFlight('future', windowStartsAt, windowEndsAt);
    await plan(flights.future, windowStartsAt, windowEndsAt);
    for (const ruleId of [HEIGHT, WAIVER_HEIGHT, SPEED]) {
      const result = await latest(flights.future, ruleId);
      expect(result, ruleId).toMatchObject({
        outcome: 'pass',
        evidenceState: 'supported',
        reasonCode: 'planned_within_limit',
        details: { basis: 'planned' },
        readAsPlans: { from: windowStartsAt },
      });
      expect(result.summary, ruleId).toMatch(
        /^No flown (height|ground speed) is reported for this flight; the result rests on the plan\./,
      );
      expect(result.summary, ruleId).not.toMatch(/on file/);
    }
    expect(await latest(flights.future, AIRSPACE)).toMatchObject({
      reasonCode: 'record_not_on_file',
      summary: 'No airspace authorization on file.',
    });
  });

  it('reads an authorization the airspace service reported, through its adapter', async () => {
    flights.past = await createFlight('past', at(0), at(60));
    await plan(flights.past, at(0), at(60));
    expect(await latest(flights.past, HEIGHT)).toMatchObject({ outcome: 'pass', details: { basis: 'planned' } });
    expect(await latest(flights.past, AIRSPACE)).toMatchObject({ reasonCode: 'record_not_on_file' });

    // The emulated service issues the authorization half an hour before the planned window, by its own clock.
    const clock = await fetch(`${emulatorBase}/_simulation/clock`, {
      method: 'POST',
      headers: { 'x-emulator-admin': emulatorSettings.adminKey, 'content-type': 'application/json' },
      body: JSON.stringify({ now: at(-30) }),
    });
    expect(clock.status).toBe(200);
    // LAANC requests need a person's grant: the pilot signs in through the emulated user grant.
    const pkce = new PkceClient({
      authorizationUrl: `${emulatorBase}/oauth/authorize`,
      tokenUrl: `${emulatorBase}/oauth/token`,
      clientId: emulatorSettings.userClientId,
      redirectUri: emulatorSettings.userRedirectUris[0]!,
      scopes: ['operation:create', 'laanc:create', 'laanc:read'],
    });
    const grant = pkce.authorize('s'.repeat(43), 'fixed-state');
    const redirect = await fetch(grant.url, { redirect: 'manual' });
    const code = new URL(redirect.headers.get('location')!).searchParams.get('code')!;
    const token = await pkce.exchange(code, grant.verifier);
    const operation = (await (
      await emulated('POST', '/v1/operations', token, {
        name: 'Fictional river inspection',
        pilotId: 'fictional-pilot',
        boundary: {
          type: 'Polygon',
          coordinates: [
            [
              [-87.64, 41.87],
              [-87.64, 41.9],
              [-87.6, 41.9],
              [-87.6, 41.87],
              [-87.64, 41.87],
            ],
          ],
        },
        minAltitude: 0,
        maxAltitude: 400,
        startTime: at(-10),
        endTime: at(70),
        aircraftId: deviceId,
        timezone: 'America/Chicago',
        altitudeUnit: 'ALTITUDE_UNIT_FEET',
        altitudeReference: 'ALTITUDE_REFERENCE_AGL',
        flightType: 'FLIGHT_TYPE_COMMERCIAL',
      })
    ).json()) as { id: string };
    const path = `/v1/operations/${operation.id}/laanc`;
    const laanc = (await (
      await emulated('POST', path, token, {
        license: 'LICENSE_PART_107',
        fixedAltitude: false,
        pointOfContact: {
          firstName: 'Synthetic',
          lastName: 'Pilot',
          phoneNumber: '+15555550123',
          emailAddress: 'pilot@example.invalid',
        },
      })
    ).json()) as { operation: { candidates: { hashCode: string }[] } };
    await emulated('POST', `${path}/authorizations/${laanc.operation.candidates[0]!.hashCode}`, token, {
      justification: 'Fictional inspection',
    });
    const read = new Uint8Array(await (await emulated('GET', path, token)).arrayBuffer());
    const message: VendorMessage = {
      bytes: read,
      contentType: 'application/json',
      transport: { method: 'GET', path },
      capturedAt: new Date().toISOString(),
    };
    const sink = new HttpObservationSink({
      ledger: new LedgerClient(address, `ledger-dev-${who.source.id}`),
      sourceId,
    });
    const outcome = await translateAndSubmit(
      airspaceAuthorizationAdapter,
      message,
      {
        subjects: { scope: 'ledger', ids: { flight: { [`${prefix}:past`]: flights.past } } },
        binding: { flightId: `${prefix}:past` },
      },
      sink,
    );
    expect(outcome.rejections).toEqual([]);
    expect(outcome.submitted).toHaveLength(1);
    await settle();
    const covered = await latest(flights.past, AIRSPACE);
    expect(covered).toMatchObject({
      outcome: 'pass',
      reasonCode: 'authorization_covers',
      details: { basis: 'planned', authorizationStatus: 'approved', ceilingMeters: 121.92, heightRead: 80 },
    });
    expect(covered.summary).toMatch(
      /^Authorization SIM[0-9A-F]+, reported approved at .*, covers the flight’s planned window/,
    );
  });

  it('reads the flown values once the aircraft reported them, and says what it read', async () => {
    const fast: DjiFaultScript = {
      ...djiFaultScripts['normal-flight']!,
      name: 'fast-leg',
      description: 'A short leg flown faster than the limit.',
      durationSeconds: 120,
      periodSeconds: 10,
      route: { ...djiFaultScripts['normal-flight']!.route, horizontalSpeedMetersPerSecond: 50 },
    };
    const binding = { deviceId, gatewayId: `${deviceId}-dock` };
    const flight = planScriptedFlight(fast, { start: at(5), ...binding, runId: prefix });
    const sink = new HttpObservationSink({
      ledger: new LedgerClient(address, `ledger-dev-${who.source.id}`),
      sourceId,
    });
    for (const scripted of flight.messages) {
      const outcome = await translateAndSubmit(
        djiOsdPositionAdapter,
        {
          bytes: scripted.bytes,
          contentType: 'application/json',
          transport: { topic: scripted.topic },
          capturedAt: new Date(Date.parse(scripted.occurredAt) + 250).toISOString(),
        },
        { subjects: { scope: 'source' }, binding },
        sink,
      );
      expect(outcome.rejections).toEqual([]);
    }
    await settle();
    // The plan's 15 m/s was within the limit; the reported 50 m/s is not.
    const speed = await latest(flights.past, SPEED);
    expect(speed).toMatchObject({
      outcome: 'attention',
      reasonCode: 'flown_beyond_limit',
      details: { basis: 'flown', measured: 'flown ground speed the aircraft reported', value: 50, plannedValue: 15 },
    });
    expect(speed.summary).toMatch(/The planned maximum ground speed is 29\.16 kn \(15 m\/s\), within the limit\./);
    // The aircraft reports height above the ellipsoid, which is never read as height above ground.
    const height = await latest(flights.past, HEIGHT);
    expect(height).toMatchObject({
      outcome: 'pass',
      details: { basis: 'planned', flownNotCompared: flight.messages.length },
    });
    expect(height.summary).toMatch(/they state height above the WGS84 ellipsoid, which this rule does not compare/);
    expect(await latest(flights.past, AIRSPACE)).toMatchObject({
      outcome: 'pass',
      details: { basis: 'flown', positionsOutside: 0, heightMeasured: 'planned maximum height above ground level' },
    });
  });

  it('needs attention once a flown height above the takeoff point beyond the limits arrives', async () => {
    await submit('position.fix', { kind: 'aircraft', id: deviceId, scope: 'source' }, at(8), {
      position: {
        latitudeDegrees: 41.885,
        longitudeDegrees: -87.62,
        altitude: { meters: 140, datum: 'takeoff_point' },
      },
      values: { fix: 'three_dimensional' },
    });
    const height = await latest(flights.past, HEIGHT);
    expect(height).toMatchObject({
      outcome: 'attention',
      reasonCode: 'flown_beyond_limit',
      details: { basis: 'flown', measured: 'flown height above the takeoff point', value: 140, plannedValue: 80 },
    });
    expect(await latest(flights.past, WAIVER_HEIGHT)).toMatchObject({
      outcome: 'attention',
      details: { basis: 'flown', value: 140 },
    });
    expect(await latest(flights.past, AIRSPACE)).toMatchObject({
      outcome: 'attention',
      reasonCode: 'authorization_not_covering',
      details: { problem: 'ceiling_below', heightRead: 140 },
    });
  });
});
