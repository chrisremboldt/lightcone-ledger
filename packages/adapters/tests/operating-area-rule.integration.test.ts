import 'dotenv/config';
import { localizeInstants } from '../../contracts/src/index.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../apps/api/src/index.js';
import { adoptExampleRiskMatrix } from '../../../apps/api/src/seed-risk-matrix.js';
import {
  djiFaultScripts,
  planScriptedFlight,
  type DjiFaultScript,
} from '../../../apps/emulators/src/dji-fault-script.js';
import { LedgerClient } from '../../contracts/src/client.js';
import type {
  AcceptedObservation,
  Capability,
  OrganizationCoverageResponse,
  RuleEvaluationRecord,
  SmsDecisionInput,
  SmsFindingPromotionResponse,
  SmsRecordDetailResponse,
  SmsSigningPreviewResponse,
  SubjectFindingRecord,
  SubjectReference,
} from '../../contracts/src/index.js';
import { adoptShownPack } from '../../contracts/fixtures/demo/v1/ready.js';
import { avoidanceAreaControlType } from '../../domain/src/control-type-library.js';
import {
  calculateIndicator,
  gatherIndicatorInputs,
  getRulePackVersion,
  registerIndicatorDefinition,
} from '../../domain/src/index.js';
import { sha256 } from '../../integrity/src/index.js';
import {
  EXAMPLE_AIRSPACE_PACK_ID,
  OPERATING_AREA_LEAF_ID,
  OPERATING_AREA_PER_FLIGHT_LEAF_ID,
  excursionsPerFlightHourV1,
  excursionsPerFlightHourV2,
} from '../../pack-example-airspace/src/index.js';
import { createPool, MemoryObjectStore, withScope, type AuthContext } from '../../persistence/src/index.js';
import { type TranslationContext, type VendorMessage, translateAndSubmit } from '../src/adapter-contract.js';
import { djiOsdPositionAdapter, type DjiOsdBinding } from '../src/dji-osd-position.js';
import { HttpObservationSink } from '../src/http-observation-sink.js';
import { databaseNow, runOwnedWork, settleOwnedWork } from '../../../tests/integration/worker-queue.js';

// The example operating-area rule, fed by the emulator's drift script through the shipped position adapter and the
// public API, evaluated by the worker's generic evaluator. A hazard opened from the finding is controlled with an
// avoidance area, and the pack's indicator counts excursions per flight hour. Nothing in core code names the rule.
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

describe.runIf(process.env.LEDGER_ENV !== 'staging')('Operating area rule from a scripted drift', () => {
  const prefix = `operating-area-${randomUUID()}`;
  const organizationId = `${prefix}:org`;
  const sourceId = `${prefix}-telemetry`;
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const workerPool = createPool(process.env.WORKER_DATABASE_URL);
  const who = {} as Record<Role, AuthContext>;
  // The leg's middle, with a radius and margin that hold the leg and leave the drift outside.
  const area = { centerLatitude: 41.87995, centerLongitude: -87.6274, radiusMeters: 400, marginMeters: 50 };
  const pack = getRulePackVersion(EXAMPLE_AIRSPACE_PACK_ID, 1)!;
  const indicator = excursionsPerFlightHourV1();
  const start = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 2 * 3_600_000);
  const drift = djiFaultScripts['drift-outside-area']!;
  const steady: DjiFaultScript = {
    ...drift,
    name: 'steady-leg',
    description: 'The same leg, on its route.',
    steps: [],
  };
  const driftTwice: DjiFaultScript = {
    ...drift,
    name: 'drift-outside-area-twice',
    description: 'The same leg, drifting outside the area twice.',
    steps: [
      ...drift.steps,
      { atSeconds: 180, action: 'offset', eastMeters: 650, northMeters: 0 },
      { atSeconds: 200, action: 'offset', eastMeters: 0, northMeters: 0 },
    ],
  };
  const flights = {
    drift: { script: drift, aircraftId: `${prefix}-aircraft-drift`, offsetMinutes: 0 },
    steady: { script: steady, aircraftId: `${prefix}-aircraft-steady`, offsetMinutes: 20 },
    // Flown for the organization that adopts version 2.
    twice: { script: driftTwice, aircraftId: `${prefix}-aircraft-twice`, offsetMinutes: 40 },
  };
  type Flight = keyof typeof flights;
  let app: Awaited<ReturnType<typeof createApp>>;
  let address: string;
  let artifactId: string;

  const at = (minutes: number, seconds = 0) => new Date(start.getTime() + minutes * 60_000 + seconds * 1000);
  const tail = (id: string): SubjectReference => ({ scope: 'source', kind: 'aircraft', id, sourceId });

  function call(principal: AuthContext, method: 'GET' | 'POST', url: string, payload?: unknown, headers = {}) {
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

  async function createOrganization(tenantId = organizationId): Promise<void> {
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, 'Fictional survey operator']);
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
      observationGrants: ['position.fix', 'flight.report'].map((observationType) => ({ sourceId, observationType })),
    });
  }

  async function upload(): Promise<string> {
    const bytes = Buffer.from(JSON.stringify({ entered: 'fictional flight log' }));
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

  /** Sends each scripted message through the position adapter and the sink, letting the worker finish after each. */
  async function fly(name: Flight): Promise<void> {
    const flight = flights[name];
    const binding = { deviceId: flight.aircraftId, gatewayId: `${flight.aircraftId}-dock` };
    const context: TranslationContext<DjiOsdBinding> = { subjects: { scope: 'source' }, binding };
    const plan = planScriptedFlight(flight.script, {
      start: at(flight.offsetMinutes).toISOString(),
      ...binding,
      runId: prefix,
    });
    const sink = new HttpObservationSink({
      ledger: new LedgerClient(address, `ledger-dev-${who.source.id}`),
      sourceId,
    });
    for (const message of plan.messages) {
      const vendor: VendorMessage = {
        bytes: message.bytes,
        contentType: 'application/json',
        transport: { topic: message.topic },
        capturedAt: new Date(Date.parse(message.occurredAt) + 250).toISOString(),
      };
      const outcome = await translateAndSubmit(djiOsdPositionAdapter, vendor, context, sink);
      expect(outcome.rejections).toEqual([]);
      await settle();
    }
    const takeoff = at(flight.offsetMinutes).toISOString();
    const landing = at(flight.offsetMinutes, flight.script.durationSeconds).toISOString();
    const reported = await call(who.source, 'POST', '/v1/inputs', {
      sourceId,
      kind: 'observation',
      occurredAt: landing,
      payload: {
        type: 'flight.report',
        version: 1,
        subject: { kind: 'flight', id: `${flight.aircraftId}-flight`, scope: 'source' },
        secondarySubject: { kind: 'aircraft', id: flight.aircraftId, scope: 'source' },
        occurredAt: landing,
        sourceEventId: `${flight.aircraftId}-report`,
        values: { activity: 'landed', takeoffAt: takeoff, landingAt: landing },
        fidelity: 'synthetic_contract',
        limitations: ['Synthetic test data.'],
        originalArtifactId: artifactId,
      },
    });
    expect(reported.statusCode, reported.body).toBe(201);
    await settle();
  }

  const subjectQuery = (aircraftId: string) =>
    new URLSearchParams({
      subjectKind: 'aircraft',
      subjectId: aircraftId,
      subjectScope: 'source',
      sourceId,
      limit: '100',
    }).toString();
  async function evaluations(aircraftId: string): Promise<RuleEvaluationRecord[]> {
    const response = await call(who.safety, 'GET', `/v1/evaluations?${subjectQuery(aircraftId)}`);
    expect(response.statusCode, response.body).toBe(200);
    return (response.json().evaluations as RuleEvaluationRecord[]).reverse();
  }
  async function findings(aircraftId: string): Promise<SubjectFindingRecord[]> {
    const response = await call(who.safety, 'GET', `/v1/findings?${subjectQuery(aircraftId)}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json().findings;
  }
  async function positions(aircraftId: string): Promise<AcceptedObservation[]> {
    const query = new URLSearchParams({
      type: 'position.fix',
      subjectKind: 'aircraft',
      subjectId: aircraftId,
      subjectScope: 'source',
      sourceId,
      from: at(-10).toISOString(),
      to: at(60).toISOString(),
      limit: '500',
    });
    const response = await call(who.source, 'GET', `/v1/observations?${query}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json().observations;
  }

  beforeAll(async () => {
    registerIndicatorDefinition(indicator);
    registerIndicatorDefinition(excursionsPerFlightHourV2());
    app = await createApp({ pool, env: 'test', objectStore: new MemoryObjectStore() });
    address = await app.listen({ host: '127.0.0.1', port: 0 });
    await createOrganization();
    artifactId = await upload();
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

  it('is adopted in active mode only with an area and margin the organization sets', async () => {
    const shown = await call(who.safety, 'GET', '/v1/organization/coverage');
    expect(shown.statusCode, shown.body).toBe(200);
    const now = Date.now();
    const adoption = adoptShownPack(
      shown.json() as OrganizationCoverageResponse,
      pack,
      { start: new Date(now - 60_000).toISOString(), end: new Date(now + 3_600_000).toISOString() },
      'Adopt the example operating area procedure with our survey area.',
      'active',
    );
    for (const parameters of [undefined, { [OPERATING_AREA_LEAF_ID]: { ...area, radiusMeters: 50_000 } }]) {
      const refused = await call(who.safety, 'POST', '/v1/commands', {
        ...adoption,
        ...(parameters ? { parameters } : {}),
      });
      expect(refused.statusCode, refused.body).toBe(400);
      expect(refused.json().error.code).toBe('invalid_adoption_parameters');
    }
    await command(who.safety, { ...adoption, parameters: { [OPERATING_AREA_LEAF_ID]: area } });
    await settle();
  });

  it('passes inside, needs attention outside and opens one finding naming the first position outside', async () => {
    await fly('drift');
    const { aircraftId } = flights.drift;
    const accepted = (await positions(aircraftId)).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    expect(accepted).toHaveLength(49);
    const recorded = await evaluations(aircraftId);
    expect(recorded).toHaveLength(accepted.length);
    const outcomes = recorded.map((evaluation) => evaluation.outcome);
    // One position outside is not yet an excursion; the second makes one; back on the route it passes again.
    const firstOutside = outcomes.indexOf('pending');
    expect(firstOutside).toBeGreaterThan(0);
    const back = outcomes.lastIndexOf('attention') + 1;
    expect(outcomes).toEqual([
      ...Array(firstOutside).fill('pass'),
      'pending',
      ...Array(back - firstOutside - 1).fill('attention'),
      ...Array(accepted.length - back).fill('pass'),
    ]);
    expect(back - firstOutside).toBeGreaterThanOrEqual(4);
    for (const [index, evaluation] of recorded.entries())
      expect(evaluation).toMatchObject({
        subject: { scope: 'source', kind: 'aircraft', id: aircraftId, sourceId },
        pack: { id: EXAMPLE_AIRSPACE_PACK_ID, version: 1, digest: pack.digest },
        rule: { id: OPERATING_AREA_LEAF_ID },
        check: { kind: 'position.in-area', version: 1 },
        parameters: { ...area, expect: 'inside', minPositions: 2 },
        trigger: { kind: 'observation', eventId: accepted[index]!.eventId },
      });

    const [finding, ...others] = await findings(aircraftId);
    expect(others).toEqual([]);
    const outside = accepted[firstOutside]!;
    expect(finding).toMatchObject({
      packId: EXAMPLE_AIRSPACE_PACK_ID,
      ruleId: OPERATING_AREA_LEAF_ID,
      // A later reading inside the limit does not answer the finding: what it reported still happened.
      status: 'open',
      initialEvaluation: {
        id: recorded[firstOutside + 1]!.id,
        outcome: 'attention',
        evidenceState: 'supported',
        evidence: [{ observationId: outside.id }, { observationId: accepted[firstOutside + 1]!.id }],
      },
      latestEvaluation: { id: recorded.at(-1)!.id, outcome: 'pass' },
    });
    expect(finding!.closure).toBeUndefined();
    expect(finding!.initialEvaluation.summary).toMatch(
      new RegExp(`^Outside the operating area and margin from ${localizeInstants(outside.occurredAt, 'UTC')} to `),
    );
  });

  it('passes every position of a flight that keeps to its route, with no finding', async () => {
    await fly('steady');
    const { aircraftId } = flights.steady;
    const recorded = await evaluations(aircraftId);
    expect(recorded).toHaveLength(49);
    expect(new Set(recorded.map((evaluation) => evaluation.outcome))).toEqual(new Set(['pass']));
    expect(await findings(aircraftId)).toEqual([]);
  });

  it('opens a hazard from the excursion and accepts an avoidance area as its control', async () => {
    const [finding] = await findings(flights.drift.aircraftId);
    const promotion = await call(who.safety, 'GET', `/v1/sms/findings/${encodeURIComponent(finding!.id)}/promotion`);
    expect(promotion.statusCode, promotion.body).toBe(200);
    const shown = promotion.json() as SmsFindingPromotionResponse;
    const hazardId = (
      await command(who.safety, {
        kind: 'sms.record.open',
        record: {
          kind: 'hazard',
          schema: 'sms.hazard.1',
          title: 'Survey aircraft drifted outside its operating area',
          ownerId: who.safety.id,
          body: {
            description: `Raised from: ${shown.evaluation.summary}`,
            consequence: 'The fictional aircraft flies over the yard east of the survey area.',
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
    const listed = (await detail(hazardId)).controlTypes!.find((type) => type.id === avoidanceAreaControlType.id)!;
    const parameters = {
      center: { latitude: 41.8805, longitude: -87.6195 },
      radiusMeters: 250,
      site: 'Fictional east yard',
    };
    const controlId = (
      await command(who.safety, {
        kind: 'sms.record.open',
        record: {
          kind: 'control',
          schema: 'sms.control.1',
          title: 'Keep survey routes clear of the east yard',
          ownerId: who.safety.id,
          body: {
            hazardId,
            controlType: { id: listed.id, version: listed.version, digest: listed.digest },
            parameters,
            effectiveFrom: start.toISOString(),
          },
        },
      })
    ).subject.id;
    const current = await detail(hazardId);
    await command(
      who.safety,
      decide(hazardId, current.basis, {
        kind: 'risk.assess',
        note: 'Assessed against the excursion shown, with routes kept clear of the yard.',
        matrix: { recordId: current.matrix!.record.id, versionNumber: current.matrix!.version.versionNumber },
        initial: { severity: 'major', likelihood: 'remote' },
        controls: [{ recordId: controlId, versionNumber: 1 }],
        residual: { severity: 'minor', likelihood: 'remote' },
        newHazardCheck: { answer: 'none_identified' },
        evidence: { evaluationId: shown.origin.evaluationId },
      }),
    );
    const assessment = (await detail(hazardId)).decisions.find((decision) => decision.kind === 'risk.assess')!;
    const preview = await call(who.executive, 'GET', `/v1/sms/records/${hazardId}/signing?meaning=risk.accept`);
    expect(preview.statusCode, preview.body).toBe(200);
    const signing = preview.json() as SmsSigningPreviewResponse;
    const grant = await call(who.executive, 'POST', '/v1/local/reauthentications', {
      credential: `ledger-dev-${who.executive.id}`,
    });
    expect(grant.statusCode, grant.body).toBe(201);
    await command(
      who.executive,
      decide(hazardId, signing.basis, {
        kind: 'risk.accept',
        note: 'Residual risk accepted with the east yard kept clear.',
        assessmentId: assessment.id,
        signature: { intent: signing.intent!, contentDigest: signing.contentDigest!, reviewed: true },
      }),
      { 'x-ledger-reauthentication': grant.json().grant as string },
    );
    const accepted = await detail(hazardId);
    expect(accepted.controls![0]).toMatchObject({ id: controlId, accepted: true });
    // The acceptance records the hazard on file for the organization; project it before reading an indicator.
    await settle();
    const control = (await detail(controlId)).current as { body: Record<string, unknown> };
    expect(control.body).toMatchObject({ controlType: { id: 'control.avoidance-area', version: 1 }, parameters });
  });

  it('calculates excursions per flight hour over the scripted flights', async () => {
    // The cut is the database's clock now, the clock that recorded the evaluations it reads.
    const recordedThrough = await databaseNow(admin);
    const request = {
      definition: { id: indicator.id, version: 1 },
      window: { start: at(-1).toISOString(), end: recordedThrough },
      recordedThrough,
      control: null,
      population: {
        subjects: [tail(flights.drift.aircraftId), tail(flights.steady.aircraftId)],
        complete: true,
        declaredBy: { kind: 'person' as const, id: who.safety.id },
      },
    };
    const gathered = await withScope(pool, who.safety, (client, principal) =>
      gatherIndicatorInputs(client, principal, request),
    );
    expect(gathered.outcome).toBe('complete');
    expect(gathered.definition.digest).toBe(indicator.digest);
    // One excursion over two four-minute flights: 1 / (8 / 60) = 7.5 per flight hour.
    expect(calculateIndicator(gathered.definition, gathered.input)).toMatchObject({
      status: 'supported',
      eventCount: 1,
      exposure: { value: { numerator: '2', denominator: '15' }, unit: 'flight_hour', gaps: [] },
      rate: { value: { numerator: '15', denominator: '2' }, decimal: '7.500', label: 'per flight hour' },
      reasons: [],
    });
  });
  // Version 2, adopted by a second organization: the rule per flight reads the aircraft its flight report names
  // between takeoff and landing, and names each excursion.
  const flightOf = (name: Flight): SubjectReference => ({
    scope: 'source',
    kind: 'flight',
    id: `${flights[name].aircraftId}-flight`,
    sourceId,
  });

  async function report(name: Flight, activity: 'active' | 'landed', takeoffAt: string, landingAt: string) {
    const flight = flights[name];
    const response = await call(who.source, 'POST', '/v1/inputs', {
      sourceId,
      kind: 'observation',
      occurredAt: activity === 'active' ? takeoffAt : landingAt,
      payload: {
        type: 'flight.report',
        version: 1,
        subject: { kind: 'flight', id: flightOf(name).id, scope: 'source' },
        secondarySubject: { kind: 'aircraft', id: flight.aircraftId, scope: 'source' },
        occurredAt: activity === 'active' ? takeoffAt : landingAt,
        sourceEventId: `${flightOf(name).id}-${activity}`,
        values: { activity, takeoffAt, ...(activity === 'landed' ? { landingAt } : {}) },
        fidelity: 'synthetic_contract',
        limitations: ['Synthetic test data.'],
        originalArtifactId: artifactId,
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    await settle();
  }

  /** Reports the takeoff, sends the positions, and reports the landing ten seconds before the last of them. */
  async function flyReported(name: Flight): Promise<{ takeoffAt: string; landingAt: string }> {
    const flight = flights[name];
    const binding = { deviceId: flight.aircraftId, gatewayId: `${flight.aircraftId}-dock` };
    const context: TranslationContext<DjiOsdBinding> = { subjects: { scope: 'source' }, binding };
    const plan = planScriptedFlight(flight.script, {
      start: at(flight.offsetMinutes).toISOString(),
      ...binding,
      runId: prefix,
    });
    const sink = new HttpObservationSink({
      ledger: new LedgerClient(address, `ledger-dev-${who.source.id}`),
      sourceId,
    });
    const takeoffAt = at(flight.offsetMinutes, 10).toISOString();
    const landingAt = at(flight.offsetMinutes, flight.script.durationSeconds - 10).toISOString();
    await report(name, 'active', takeoffAt, landingAt);
    let landed = false;
    for (const message of plan.messages) {
      if (!landed && message.occurredAt > landingAt) {
        await report(name, 'landed', takeoffAt, landingAt);
        landed = true;
      }
      const vendor: VendorMessage = {
        bytes: message.bytes,
        contentType: 'application/json',
        transport: { topic: message.topic },
        capturedAt: new Date(Date.parse(message.occurredAt) + 250).toISOString(),
      };
      const outcome = await translateAndSubmit(djiOsdPositionAdapter, vendor, context, sink);
      expect(outcome.rejections).toEqual([]);
      await settle();
    }
    return { takeoffAt, landingAt };
  }

  async function flightEvaluations(name: Flight): Promise<RuleEvaluationRecord[]> {
    const query = new URLSearchParams({
      subjectKind: 'flight',
      subjectId: flightOf(name).id,
      subjectScope: 'source',
      sourceId,
      limit: '100',
    });
    const response = await call(who.safety, 'GET', `/v1/evaluations?${query}`);
    expect(response.statusCode, response.body).toBe(200);
    return (response.json().evaluations as RuleEvaluationRecord[])
      .filter((evaluation) => evaluation.rule.id === OPERATING_AREA_PER_FLIGHT_LEAF_ID)
      .reverse();
  }

  it('adopts version 2 in a second organization with an area and margin', async () => {
    await createOrganization(`${prefix}:org-v2`);
    artifactId = await upload();
    const shown = await call(who.safety, 'GET', '/v1/organization/coverage');
    expect(shown.statusCode, shown.body).toBe(200);
    const now = Date.now();
    await command(who.safety, {
      ...adoptShownPack(
        shown.json() as OrganizationCoverageResponse,
        getRulePackVersion(EXAMPLE_AIRSPACE_PACK_ID, 2)!,
        { start: new Date(now - 60_000).toISOString(), end: new Date(now + 3_600_000).toISOString() },
        'Adopt the example operating area procedure per flight with our area.',
        'active',
      ),
      parameters: { [OPERATING_AREA_PER_FLIGHT_LEAF_ID]: area },
    });
    await settle();
  });

  it('names each excursion between takeoff and landing, with the same result after landing as during the flight', async () => {
    const { landingAt } = await flyReported('twice');
    const results = (await flightEvaluations('twice')).filter((item) => item.applicability === 'applicable');
    expect(results.every((item) => item.pack.version === 2)).toBe(true);
    const lastDuring = results.filter((item) => item.details?.windowClosed === false).at(-1)!;
    const after = results.filter((item) => item.details?.windowClosed === true);
    expect(lastDuring).toMatchObject({ outcome: 'attention', details: { excursionCount: 2 } });
    expect(after.length).toBeGreaterThan(0);
    // Positions after the landing are not read, so every result after the landing is the same.
    for (const result of after) {
      expect(result).toMatchObject({
        outcome: 'attention',
        evidenceState: 'supported',
        reasonCode: 'excursion',
        details: { excursionCount: 2, windowEnd: landingAt },
      });
      expect(result.issues).toEqual(lastDuring.issues);
      expect(result.summary).toBe(after[0]!.summary);
    }
    expect(after[0]!.summary).toMatch(/^2 excursion\(s\) outside the operating area and margin during the flight/);
    expect(after[0]!.inputs.find((input) => input.name === 'positions')).toMatchObject({
      about: { related: 'aircraft' },
      subject: tail(flights.twice.aircraftId),
    });
  });

  it('counts two excursions on one flight as two, per flight hour (indicator version 2)', async () => {
    const definition = excursionsPerFlightHourV2();
    // The cut is the database's clock now, the clock that recorded the evaluations it reads.
    const recordedThrough = await databaseNow(admin);
    const gathered = await withScope(pool, who.safety, (client, principal) =>
      gatherIndicatorInputs(client, principal, {
        definition: { id: definition.id, version: 2 },
        window: { start: at(-1).toISOString(), end: recordedThrough },
        recordedThrough,
        population: {
          subjects: [flightOf('twice')],
          complete: true,
          declaredBy: { kind: 'person', id: who.safety.id },
        },
      }),
    );
    // Two excursions over one flight of 220 seconds: 2 / (220 / 3600) = 360 / 11 per flight hour.
    expect(calculateIndicator(gathered.definition, gathered.input)).toMatchObject({
      status: 'supported',
      eventCount: 2,
      exposure: { value: { numerator: '11', denominator: '180' }, unit: 'flight_hour', gaps: [] },
      rate: { value: { numerator: '360', denominator: '11' }, label: 'per flight hour' },
      reasons: [],
    });
  });
});
