import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../apps/api/src/index.js';
import { adoptExampleRiskMatrix } from '../../../apps/api/src/seed-risk-matrix.js';
import { LedgerClient } from '../../contracts/src/client.js';
import type {
  AcceptedObservation,
  Capability,
  OrganizationCoverageResponse,
  RuleEvaluationRecord,
} from '../../contracts/src/index.js';
import { adoptShownPack } from '../../contracts/fixtures/demo/v1/ready.js';
import { getRulePackVersion } from '../../domain/src/index.js';
import { sha256 } from '../../integrity/src/index.js';
import { EXAMPLE_WEATHER_PACK_ID } from '../../pack-example-weather/src/index.js';
import { WIND_AT_TAKEOFF_LEAF_ID, WIND_FOR_FLIGHT_LEAF_ID } from '../../pack-example-weather/src/example-weather-v2.js';
import { createPool, MemoryObjectStore, type AuthContext } from '../../persistence/src/index.js';
import { translateAndSubmit } from '../src/adapter-contract.js';
import type { GoldenFile } from '../src/conformance.js';
import { HttpObservationSink } from '../src/http-observation-sink.js';
import { publishedMetarAdapter, type MetarBinding } from '../src/published-metar.js';
import { runOwnedWork, settleOwnedWork } from '../../../tests/integration/worker-queue.js';

// The example weather pack's wind rule, fed one published report fetched from the live service, through the shipped
// METAR adapter and the public API, evaluated by the worker's generic evaluator. The flight's plan names the site; the
// station is configured to report for it. Nothing in core code names the rule or the source.
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
  worker: { kind: 'worker', capabilities: ['flight:read', 'evidence:read', 'input:write'] },
};
const golden = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '../src/golden/published-metar-observations/01-gusting-wind-in-knots.json'),
    'utf8',
  ),
) as GoldenFile;

describe.runIf(process.env.LEDGER_ENV !== 'staging')('The example wind rule reading a published weather report', () => {
  const prefix = `metar-wind-${randomUUID()}`;
  const organizationId = `${prefix}:org`;
  const sourceId = `${prefix}-operations`;
  const site = `${prefix}-site`;
  const flight = `${prefix}-flight`;
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const workerPool = createPool(process.env.WORKER_DATABASE_URL);
  const who = {} as Record<Role, AuthContext>;
  const limit = 8;
  const pack = getRulePackVersion(EXAMPLE_WEATHER_PACK_ID, 2)!;
  let app: Awaited<ReturnType<typeof createApp>>;
  let address: string;
  let artifactId: string;

  function call(principal: AuthContext, method: 'GET' | 'POST', url: string, payload?: unknown) {
    return app.inject({
      method,
      url,
      headers: { authorization: `Bearer ledger-dev-${principal.id}`, 'idempotency-key': randomUUID() },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  }

  async function settle(): Promise<void> {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (await runOwnedWork(admin, workerPool, [prefix])) continue;
      const pending = await admin.query(
        `SELECT (SELECT COUNT(*) FROM work_items w WHERE w.tenant_id LIKE $1 AND w.state IN ('pending','leased'))
         +(SELECT COUNT(*) FROM rule_evaluation_work r WHERE r.tenant_id LIKE $1 AND r.state IN ('pending','leased')
           AND r.due_at<=clock_timestamp()) AS count`,
        [`${prefix}%`],
      );
      if (Number(pending.rows[0].count) === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Worker did not settle');
  }

  async function submit(observation: Record<string, unknown>, interval?: { start: string; end: string }) {
    const response = await call(who.source, 'POST', '/v1/inputs', {
      sourceId,
      kind: 'observation',
      occurredAt: observation.occurredAt,
      payload: {
        ...observation,
        ...(interval ? { interval } : {}),
        fidelity: 'synthetic_contract',
        limitations: ['Synthetic test data.'],
        originalArtifactId: artifactId,
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    await settle();
  }

  beforeAll(async () => {
    app = await createApp({ pool, env: 'test', objectStore: new MemoryObjectStore() });
    address = await app.listen({ host: '127.0.0.1', port: 0 });
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [organizationId, 'Fictional survey operator']);
    for (const [role, person] of Object.entries(people) as [Role, (typeof people)[Role]][]) {
      who[role] = {
        id: `${organizationId}:${role}`,
        tenantId: organizationId,
        name: `Fictional ${role}`,
        kind: person.kind,
        revision: 1,
        capabilities: person.capabilities,
      };
      await admin.query('INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,$4,$5)', [
        who[role].id,
        organizationId,
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
    const granted = await call(who.safety, 'POST', '/v1/commands', {
      kind: 'authority.update',
      principalId: who.source.id,
      expectedRevision: current.json().principal.revision,
      capabilities: current.json().principal.capabilities,
      observationGrants: ['weather.wind', 'weather.visibility', 'flight.report', 'operator.record'].map(
        (observationType) => ({ sourceId, observationType }),
      ),
    });
    expect(granted.statusCode, granted.body).toBe(201);
    const bytes = Buffer.from(JSON.stringify({ entered: 'fictional flight log' }));
    const created = await call(who.source, 'POST', '/v1/uploads', {
      contentType: 'application/json',
      byteLength: bytes.byteLength,
    });
    const id = created.json().upload.id as string;
    await app.inject({
      method: 'PUT',
      url: `/v1/uploads/${id}/content`,
      headers: {
        authorization: `Bearer ledger-dev-${who.source.id}`,
        'idempotency-key': randomUUID(),
        'content-type': 'application/octet-stream',
      },
      payload: bytes,
    });
    artifactId = (await call(who.source, 'POST', `/v1/uploads/${id}/finalize`)).json().artifact.id as string;
    const drafter = { id: who.safety.id, token: `ledger-dev-${who.safety.id}` };
    const adopter = { token: `ledger-dev-${who.executive.id}` };
    expect(await adoptExampleRiskMatrix(app, { drafter, adopter, note: 'Adopting the fictional matrix.' })).toBe(true);
    const shown = await call(who.safety, 'GET', '/v1/organization/coverage');
    const now = Date.now();
    const adoption = adoptShownPack(
      shown.json() as OrganizationCoverageResponse,
      pack,
      { start: new Date(now - 60_000).toISOString(), end: new Date(now + 3_600_000).toISOString() },
      'Adopt the example wind procedure with our limit.',
      'active',
    );
    const adopted = await call(who.safety, 'POST', '/v1/commands', {
      ...adoption,
      parameters: { [WIND_AT_TAKEOFF_LEAF_ID]: { limit }, [WIND_FOR_FLIGHT_LEAF_ID]: { limit } },
    });
    expect(adopted.statusCode, adopted.body).toBe(201);
    await settle();
  });
  afterAll(async () => {
    await settleOwnedWork([prefix]);
    if (app) await app.close();
    await pool.end();
    await admin.end();
    await workerPool.end();
  });

  it('reads the station’s measured wind at the planned site at takeoff, and says which station reported it', async () => {
    // The report states 251851Z: 18:51 UTC on the day it was fetched, 18 knots gusting 25.
    const [windowStart, takeoffAt, landingAt, windowEnd] = [
      '2026-11-25T18:40:00.000Z',
      '2026-11-25T18:55:00.000Z',
      '2026-11-25T19:10:00.000Z',
      '2026-11-25T19:40:00.000Z',
    ];
    const subject = { kind: 'flight', id: flight, scope: 'source' };
    const later = { kind: 'flight', id: `${flight}-later`, scope: 'source' };
    const plan = (flightSubject: typeof subject, start: string, end: string) =>
      submit(
        {
          type: 'operator.record',
          version: 1,
          subject: flightSubject,
          occurredAt: start,
          sourceEventId: `${flightSubject.id}-plan`,
          values: {
            recordType: 'flight.plan',
            recordVersion: 1,
            record: {
              windowStartsAt: start,
              windowEndsAt: end,
              operationKind: 'inspection',
              plannedOriginDescription: 'Fictional survey pad',
              plannedDestinationDescription: 'Fictional survey pad',
              routeSummary: 'Out and back along the fictional ridge line.',
              siteId: { id: site, scope: 'source' },
            },
          },
        },
        { start, end },
      );
    // A second flight from the same site takes off two hours after the report: past the 90 minutes a station's
    // report is read for.
    await plan(later, '2026-11-25T20:40:00.000Z', '2026-11-25T21:40:00.000Z');
    await submit(
      {
        type: 'operator.record',
        version: 1,
        subject,
        occurredAt: windowStart,
        sourceEventId: `${flight}-plan`,
        values: {
          recordType: 'flight.plan',
          recordVersion: 1,
          record: {
            windowStartsAt: windowStart,
            windowEndsAt: windowEnd,
            operationKind: 'inspection',
            plannedOriginDescription: 'Fictional survey pad',
            plannedDestinationDescription: 'Fictional survey pad',
            routeSummary: 'Out and back along the fictional ridge line.',
            siteId: { id: site, scope: 'source' },
          },
        },
      },
      { start: windowStart, end: windowEnd },
    );
    const binding: MetarBinding = { stations: { KORD: [{ siteId: site, distanceMeters: 14_200 }] } };
    const sink = new HttpObservationSink({
      ledger: new LedgerClient(address, `ledger-dev-${who.source.id}`),
      sourceId,
    });
    const message = golden.message;
    const outcome = await translateAndSubmit(
      publishedMetarAdapter,
      {
        bytes: new TextEncoder().encode(message.bodyText!),
        contentType: message.contentType,
        transport: message.transport,
        capturedAt: message.capturedAt,
      },
      { subjects: { scope: 'source' }, binding },
      sink,
    );
    expect(outcome.rejections).toEqual([]);
    expect(outcome.submitted.map((entry) => entry.observation.type)).toEqual(['weather.wind', 'weather.visibility']);
    await settle();
    await submit({
      type: 'flight.report',
      version: 1,
      subject,
      occurredAt: landingAt,
      sourceEventId: `${flight}-landed`,
      values: { activity: 'landed', takeoffAt, landingAt },
    });
    await submit({
      type: 'flight.report',
      version: 1,
      subject: later,
      occurredAt: '2026-11-25T21:10:00.000Z',
      sourceEventId: `${later.id}-landed`,
      values: { activity: 'landed', takeoffAt: '2026-11-25T20:55:00.000Z', landingAt: '2026-11-25T21:10:00.000Z' },
    });

    const query = new URLSearchParams({
      type: 'weather.wind',
      subjectKind: 'site',
      subjectId: site,
      subjectScope: 'source',
      sourceId,
      from: windowStart,
      to: windowEnd,
      limit: '10',
    });
    const winds = await call(who.source, 'GET', `/v1/observations?${query}`);
    expect(winds.statusCode, winds.body).toBe(200);
    const [wind] = winds.json().observations as AcceptedObservation[];
    expect(wind!.observation).toMatchObject({
      occurredAt: '2026-11-25T18:51:00.000Z',
      fidelity: 'captured_source_replay',
      values: { method: 'measured', directionFromDegrees: 60 },
    });
    expect(wind!.observation.limitations).toContain(
      `Reported by station KORD for the site ${site}, 14.2 km from the site as configured.`,
    );

    expect(wind!.observation.values).toMatchObject({ stationId: 'KORD', stationDistanceMeters: 14_200 });

    const takeoffEvaluations = async (subjectId: string) => {
      const evaluations = await call(
        who.safety,
        'GET',
        `/v1/evaluations?${new URLSearchParams({ subjectKind: 'flight', subjectId, subjectScope: 'source', sourceId, limit: '100' })}`,
      );
      expect(evaluations.statusCode, evaluations.body).toBe(200);
      return (evaluations.json().evaluations as RuleEvaluationRecord[]).filter(
        (evaluation) => evaluation.rule.id === WIND_AT_TAKEOFF_LEAF_ID,
      );
    };
    const [atTakeoff] = await takeoffEvaluations(flight);
    expect(atTakeoff).toMatchObject({
      pack: { id: EXAMPLE_WEATHER_PACK_ID, version: 2, digest: pack.digest },
      outcome: 'attention',
    });
    expect(atTakeoff!.evidence.map((item) => item.observationId)).toContain(wind!.id);
    expect(atTakeoff!.summary).toContain(
      `At takeoff the measured wind was ${(18 * 1852) / 3600} m/s, above the ${limit} m/s limit. Reported by station KORD.`,
    );
    // The later flight's latest report at or before its takeoff is the same one, 2 h 4 min old: it is not read.
    const [tooOld] = await takeoffEvaluations(later.id);
    expect(tooOld).toMatchObject({ evidenceState: 'insufficient', outcome: 'attention' });
    expect(tooOld!.evidence.map((item) => item.observationId)).toContain(wind!.id);
    expect(tooOld!.summary).toContain(
      'The latest value of the wind reading’s Wind speed (m/s) before the start was reported at 2026-11-25 18:51 UTC by station KORD, 2 h 4 min before it, older than the greatest age of 1 h 30 min: it is not read, and none within that age is on file.',
    );
  });
});
