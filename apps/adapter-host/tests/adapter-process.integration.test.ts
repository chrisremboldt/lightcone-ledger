import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../api/src/index.js';
import { djiFaultScripts, planScriptedFlight, type DjiFaultScript } from '../../emulators/src/dji-fault-script.js';
import { DjiOsdEmulator } from '../../emulators/src/dji.js';
import { createEmulator, emulatorConfig } from '../../emulators/src/server.js';
import { adoptShownPack } from '../../../packages/contracts/fixtures/demo/v1/ready.js';
import { LedgerClient } from '../../../packages/contracts/src/client.js';
import type { OrganizationCoverageResponse, RuleEvaluationRecord } from '../../../packages/contracts/src/index.js';
import { getRulePackVersion } from '../../../packages/domain/src/rule-pack-registry.js';
import { sha256 } from '../../../packages/integrity/src/index.js';
import { PART107_PACK_ID } from '../../../packages/pack-part107/src/index.js';
import { createPool, MemoryObjectStore, type AuthContext } from '../../../packages/persistence/src/index.js';
import { djiOsdPositionAdapter } from '../../../packages/adapters/src/dji-osd-position.js';
import { HttpObservationSink } from '../../../packages/adapters/src/http-observation-sink.js';
import { PkceClient } from '../../../packages/adapters/src/index.js';
import { SourceLoop } from '../../../packages/adapters/src/source-loop.js';
import { runOwnedWork, settleOwnedWork } from '../../../tests/integration/worker-queue.js';
import { runAdapterHost } from '../src/host.js';

// The adapter process, as an operator starts it, connects the emulated airspace service and aircraft to the real
// API: it polls the service for the operation's authorizations, and its loop submits the aircraft's positions. The
// adopted Part 107 rules then read the flown values and the authorization. A second case runs the process against
// the local message broker (LEDGER_TEST_BROKER_URL, by default Alpha's listener of infra/compose.yaml), and is skipped,
// with its reason, when nothing listens there or the broker refuses the seeded account that `pnpm broker:files:dev`
// writes.
const SPEED = 'ledger.part107.107.51.a';
const AIRSPACE = 'ledger.part107.107.41';
const MINUTE = 60_000;
const BROKER = {
  url: process.env.LEDGER_TEST_BROKER_URL || 'mqtt://127.0.0.1:1883',
  username: 'principal-alpha-source',
};

/** Whether something listens where the local broker would; the case connects with its account itself. */
async function brokerReachable(): Promise<boolean> {
  const { hostname, port } = new URL(BROKER.url);
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host: hostname, port: Number(port), timeout: 2000 });
    const done = (reachable: boolean) => {
      socket.destroy();
      resolve(reachable);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

describe.runIf(process.env.LEDGER_ENV !== 'staging')('The adapter process connects a source', () => {
  const prefix = `adapter-process-${randomUUID()}`;
  const tenantId = `${prefix}:org`;
  const sourceId = `${prefix}-source`;
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

  /** A flight on the aircraft with its plan: the window and the planned maximum height and speed. */
  async function plannedFlight(name: string, aircraft: string, startsAt: string, endsAt: string): Promise<string> {
    const created = await call(who.actor, 'POST', '/v1/flights', {
      originationKey: `${prefix}:${name}`,
      aircraft,
      scheduledStart: startsAt,
      scheduledEnd: endsAt,
    });
    expect(created.statusCode, created.body).toBe(201);
    const flightId = created.json().flight.id as string;
    const planned = await call(who.source, 'POST', '/v1/inputs', {
      sourceId,
      kind: 'observation',
      occurredAt: startsAt,
      payload: {
        type: 'operator.record',
        version: 1,
        subject: { kind: 'flight', id: flightId, scope: 'ledger' },
        secondarySubject: { kind: 'aircraft', id: aircraft, scope: 'source' },
        occurredAt: startsAt,
        interval: { start: startsAt, end: endsAt },
        sourceEventId: randomUUID(),
        fidelity: 'synthetic_contract',
        limitations: ['Fictional records.'],
        originalArtifactId: artifactId,
        values: {
          recordType: 'flight.plan',
          recordVersion: 1,
          record: {
            windowStartsAt: startsAt,
            windowEndsAt: endsAt,
            operationKind: 'inspection',
            plannedOriginDescription: 'Fictional yard',
            plannedDestinationDescription: 'Fictional yard',
            routeSummary: 'Inspection along the river and back',
            plannedMaxHeightAboveGroundMeters: 80,
            plannedMaxGroundSpeedMetersPerSecond: 15,
          },
        },
      },
    });
    expect(planned.statusCode, planned.body).toBe(201);
    await settle();
    return flightId;
  }

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

  /**
   * A fast leg, so the flown ground speed is beyond the limit the plan was within. Each case gives its own run id:
   * the messages' ids come from it, and a message id already on record is refused as a conflict.
   */
  function fastLeg(aircraft: string, startsAt: string, runId: string) {
    const script: DjiFaultScript = {
      ...djiFaultScripts['normal-flight']!,
      name: 'fast-leg',
      description: 'A short leg flown faster than the limit.',
      durationSeconds: 120,
      periodSeconds: 10,
      route: { ...djiFaultScripts['normal-flight']!.route, horizontalSpeedMetersPerSecond: 50 },
    };
    return planScriptedFlight(script, {
      start: startsAt,
      deviceId: aircraft,
      gatewayId: `${aircraft}-dock`,
      runId,
    });
  }

  const hostEnv = () => ({
    LEDGER_API_URL: address,
    LEDGER_API_CREDENTIAL: `ledger-dev-${who.source.id}`,
    LEDGER_CREDENTIAL_LABEL: 'Fictional adapter on the hangar host',
  });

  /** Runs the process until a log line satisfies `done`, then stops it as a signal would. */
  async function runUntil(
    argv: string[],
    env: Record<string, string>,
    done: (event: { event: string; submittedMessages?: number }) => boolean,
  ) {
    const stop = new AbortController();
    const lines: string[] = [];
    const running = runAdapterHost(argv, env, {
      out: (line) => {
        lines.push(line);
        if (done(JSON.parse(line) as { event: string })) stop.abort();
      },
      stop: stop.signal,
      // Counts often enough that a case can stop once everything it sent was submitted.
      summaryMs: 200,
    });
    const timer = setTimeout(() => stop.abort(), 45_000);
    const code = await running;
    clearTimeout(timer);
    return { code, events: lines.map((line) => JSON.parse(line) as { event: string; message: string }) };
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
    const shown = await call(who.actor, 'GET', '/v1/organization/coverage');
    const adoption = adoptShownPack(
      shown.json<OrganizationCoverageResponse>(),
      getRulePackVersion(PART107_PACK_ID, 2)!,
      {
        start: new Date(start - 24 * 60 * MINUTE).toISOString(),
        end: new Date(start + 14 * 24 * 60 * MINUTE).toISOString(),
      },
      'Fictional active adoption.',
      'active',
    );
    const adopted = await call(who.actor, 'POST', '/v1/commands', {
      ...adoption,
      parameters: { 'ledger.part107.107.9.timing': { timeZone: 'UTC' } },
    });
    expect(adopted.statusCode, adopted.body).toBe(201);
    await settle();
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

  it('submits an authorization it polled and positions its loop received, and the adopted rules read them', async () => {
    const aircraft = `${prefix}-aircraft`;
    const flightId = await plannedFlight('polled', aircraft, at(0), at(60));
    expect(await latest(flightId, AIRSPACE)).toMatchObject({ reasonCode: 'record_not_on_file' });

    // The emulated service issues the authorization by its own clock; the pilot signs in through its user grant.
    const clock = await fetch(`${emulatorBase}/_simulation/clock`, {
      method: 'POST',
      headers: { 'x-emulator-admin': emulatorSettings.adminKey, 'content-type': 'application/json' },
      body: JSON.stringify({ now: at(-30) }),
    });
    expect(clock.status).toBe(200);
    const pkce = new PkceClient({
      authorizationUrl: `${emulatorBase}/oauth/authorize`,
      tokenUrl: `${emulatorBase}/oauth/token`,
      clientId: emulatorSettings.userClientId,
      redirectUri: emulatorSettings.userRedirectUris[0]!,
      scopes: ['operation:create', 'laanc:create', 'laanc:read'],
    });
    const grant = pkce.authorize('p'.repeat(43), 'fixed-state');
    const redirect = await fetch(grant.url, { redirect: 'manual' });
    const token = await pkce.exchange(
      new URL(redirect.headers.get('location')!).searchParams.get('code')!,
      grant.verifier,
    );
    const emulated = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${emulatorBase}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(response.status, path).toBe(200);
      return response.json();
    };
    const operation = (await emulated('POST', '/v1/operations', {
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
      aircraftId: aircraft,
      timezone: 'America/Chicago',
      altitudeUnit: 'ALTITUDE_UNIT_FEET',
      altitudeReference: 'ALTITUDE_REFERENCE_AGL',
      flightType: 'FLIGHT_TYPE_COMMERCIAL',
    })) as { id: string };
    const laanc = (await emulated('POST', `/v1/operations/${operation.id}/laanc`, {
      license: 'LICENSE_PART_107',
      fixedAltitude: false,
      pointOfContact: {
        firstName: 'Synthetic',
        lastName: 'Pilot',
        phoneNumber: '+15555550123',
        emailAddress: 'pilot@example.invalid',
      },
    })) as { operation: { candidates: { hashCode: string }[] } };
    await emulated(
      'POST',
      `/v1/operations/${operation.id}/laanc/authorizations/${laanc.operation.candidates[0]!.hashCode}`,
      {
        justification: 'Fictional inspection',
      },
    );

    const polled = await runUntil(
      [
        'airspace-link-laanc-authorization',
        '--service-url',
        emulatorBase,
        '--operation',
        operation.id,
        '--flight',
        flightId,
        '--poll-seconds',
        '5',
      ],
      { ...hostEnv(), ADAPTER_SERVICE_TOKEN: token },
      (event) => event.event === 'first_submitted',
    );
    expect(polled.code, JSON.stringify(polled.events)).toBe(0);
    expect(polled.events[0]).toMatchObject({ event: 'starting', fidelity: 'synthetic_contract' });
    expect(polled.events.at(-1)).toMatchObject({ event: 'stopped', unsubmitted: 0, observations: 1 });
    expect(JSON.stringify(polled.events)).not.toContain(token);
    await settle();
    expect(await latest(flightId, AIRSPACE)).toMatchObject({
      outcome: 'pass',
      reasonCode: 'authorization_covers',
      details: { basis: 'planned', authorizationStatus: 'approved' },
    });

    // The aircraft's positions, from the emulator's own message generator, through the process's loop.
    const flight = fastLeg(aircraft, at(5), `${prefix}-loop`);
    const loop = new SourceLoop({
      adapter: djiOsdPositionAdapter,
      context: { subjects: { scope: 'source' }, binding: { deviceId: aircraft, gatewayId: `${aircraft}-dock` } },
      sink: new HttpObservationSink({ ledger: new LedgerClient(address, `ledger-dev-${who.source.id}`), sourceId }),
      delivery: 'latest',
    });
    const running = loop.start();
    for (const scripted of flight.messages)
      await loop.offer({
        bytes: scripted.bytes,
        contentType: 'application/json',
        transport: { topic: scripted.topic },
        capturedAt: new Date(Date.parse(scripted.occurredAt) + 250).toISOString(),
      });
    expect(await loop.stop(30_000)).toBe(0);
    await running;
    expect(loop.stats).toMatchObject({ submittedMessages: flight.messages.length, rejected: 0, refused: 0 });
    await settle();
    expect(await latest(flightId, SPEED)).toMatchObject({
      outcome: 'attention',
      reasonCode: 'flown_beyond_limit',
      details: { basis: 'flown', value: 50, plannedValue: 15 },
    });
    expect(await latest(flightId, AIRSPACE)).toMatchObject({
      outcome: 'pass',
      details: { basis: 'flown', positionsOutside: 0 },
    });
  });

  it('receives positions over the local message broker', async (context) => {
    if (!(await brokerReachable())) return context.skip(`No broker listens at ${BROKER.url}`);
    const aircraft = `${prefix.slice(0, 40)}-broker`.replace(/[^A-Za-z0-9_-]/g, '-');
    const device = new DjiOsdEmulator({
      mqttUrl: BROKER.url,
      username: BROKER.username,
      password: `${BROKER.username}-password`,
      deviceId: aircraft,
      gatewayId: `${aircraft}-dock`,
    });
    try {
      await device.start();
    } catch {
      return context.skip(
        `The broker at ${BROKER.url} refused the account ${BROKER.username}: run pnpm broker:files:dev and restart the broker`,
      );
    }
    const flightId = await plannedFlight('broker', aircraft, at(0), at(60));
    const flight = fastLeg(aircraft, at(5), `${prefix}-broker`);
    let published = false;
    const received = await runUntil(
      [
        'dji-cloud-api-osd-position',
        '--broker-url',
        BROKER.url,
        '--broker-username',
        BROKER.username,
        '--device',
        aircraft,
        '--gateway',
        `${aircraft}-dock`,
      ],
      { ...hostEnv(), ADAPTER_BROKER_PASSWORD: `${BROKER.username}-password` },
      (event) => {
        if (event.event === 'broker_subscribed' && !published) {
          published = true;
          void (async () => {
            for (const scripted of flight.messages) await device.publishBytes(scripted.bytes);
          })();
        }
        return event.event === 'summary' && event.submittedMessages === flight.messages.length;
      },
    );
    await device.stop();
    expect(received.code, JSON.stringify(received.events)).toBe(0);
    await settle();
    expect(await latest(flightId, SPEED)).toMatchObject({ details: { basis: 'flown' } });
  });
});
