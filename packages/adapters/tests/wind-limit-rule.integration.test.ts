import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../apps/api/src/index.js';
import { adoptExampleRiskMatrix } from '../../../apps/api/src/seed-risk-matrix.js';
import {
  djiDockWindScripts,
  planDockWind,
  type DjiDockWindScript,
} from '../../../apps/emulators/src/dji-dock-wind-script.js';
import { LedgerClient } from '../../contracts/src/client.js';
import type {
  AcceptedObservation,
  Capability,
  ControlWindow,
  ControlWindowIndicatorResponse,
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
import { operatingLimitControlType } from '../../domain/src/control-type-library.js';
import {
  calculateIndicator,
  gatherIndicatorInputs,
  getRulePackVersion,
  registerIndicatorDefinition,
} from '../../domain/src/index.js';
import { sha256 } from '../../integrity/src/index.js';
import {
  EXAMPLE_WEATHER_PACK_ID,
  WIND_AT_DEPARTURE_LEAF_ID,
  WIND_AT_TAKEOFF_LEAF_ID,
  WIND_FOR_FLIGHT_LEAF_ID,
  WIND_IN_FLIGHT_LEAF_ID,
  flightsWithWindAboveLimitInFlightV1,
  flightsWithWindAboveLimitV1,
  windExceedancesPer100FlightsV1,
} from '../../pack-example-weather/src/index.js';
import { createPool, MemoryObjectStore, withScope, type AuthContext } from '../../persistence/src/index.js';
import { type TranslationContext, type VendorMessage, translateAndSubmit } from '../src/adapter-contract.js';
import { djiDockWindAdapter, type DjiDockBinding } from '../src/dji-dock-wind.js';
import { HttpObservationSink } from '../src/http-observation-sink.js';
import { databaseNow, runOwnedWork, settleOwnedWork } from '../../../tests/integration/worker-queue.js';

// The example wind rules, fed by the emulator's dock wind script through the shipped dock wind adapter and the public
// API, evaluated by the worker's generic evaluator. Each flight's site is the one its flight plan names, and the wind
// is read about that site. A hazard opened from the in-flight finding is controlled with an operating limit on the
// wind, and a window over that control calculates the pack's indicator. Nothing in core code names the rules.
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
      'monitoring:write',
    ],
  },
  executive: {
    kind: 'human',
    capabilities: ['sms:read', 'sms:adopt', 'decision:write', 'evidence:read', 'risk:accept:high'],
  },
  source: { kind: 'source', capabilities: ['input:write', 'flight:read', 'evidence:read'] },
  worker: { kind: 'worker', capabilities: ['flight:read', 'evidence:read', 'input:write'] },
};

describe.runIf(process.env.LEDGER_ENV !== 'staging')('Wind limit rules from a scripted dock', () => {
  const prefix = `wind-limit-${randomUUID()}`;
  const organizationId = `${prefix}:org`;
  // One source sends the dock's messages and the operator's flight records, so the site the plan names and the site
  // the wind is about are the same source identity.
  const sourceId = `${prefix}-operations`;
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const workerPool = createPool(process.env.WORKER_DATABASE_URL);
  const who = {} as Record<Role, AuthContext>;
  const limit = 10;
  const pack = getRulePackVersion(EXAMPLE_WEATHER_PACK_ID, 1)!;
  const indicator = flightsWithWindAboveLimitInFlightV1();
  const start = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 2 * 3_600_000);
  const gust = djiDockWindScripts['dock-wind-rises-in-flight']!;
  const steady: DjiDockWindScript = { ...gust, name: 'dock-wind-steady', description: 'The same, calm.', steps: [] };
  // Taking off just after a reading above the limit, then above it twice in the air.
  const gustsTwice: DjiDockWindScript = {
    ...gust,
    name: 'dock-wind-gusts-twice',
    description: 'Above the limit just before takeoff and twice in the air.',
    flight: { takeoffSeconds: 125, landingSeconds: 480 },
    wind: { speedMetersPerSecond: 11.5, direction: 6 },
    steps: [
      { atSeconds: 130, action: 'wind', speedMetersPerSecond: 4.5 },
      ...gust.steps,
      { atSeconds: 420, action: 'wind', speedMetersPerSecond: 12.6 },
      { atSeconds: 450, action: 'wind', speedMetersPerSecond: 6.2 },
    ],
  };
  const flights = {
    gusty: { script: gust, site: `${prefix}-site-north`, dock: `${prefix}-dock-north`, offsetMinutes: 0 },
    calm: { script: steady, site: `${prefix}-site-south`, dock: `${prefix}-dock-south`, offsetMinutes: 20 },
    // Flown for the organization that adopts version 2.
    twice: { script: gustsTwice, site: `${prefix}-site-east`, dock: `${prefix}-dock-east`, offsetMinutes: 40 },
    still: { script: steady, site: `${prefix}-site-west`, dock: `${prefix}-dock-west`, offsetMinutes: 60 },
  };
  type Flight = keyof typeof flights;
  let app: Awaited<ReturnType<typeof createApp>>;
  let address: string;
  let artifactId: string;

  const at = (minutes: number, seconds = 0) => new Date(start.getTime() + minutes * 60_000 + seconds * 1000);
  const flightOf = (name: Flight): SubjectReference => ({
    scope: 'source',
    kind: 'flight',
    id: `${prefix}-flight-${name}`,
    sourceId,
  });

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
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, 'Fictional inspection operator']);
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
      observationGrants: ['weather.wind', 'flight.report', 'operator.record'].map((observationType) => ({
        sourceId,
        observationType,
      })),
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

  const report = (name: Flight, activity: 'active' | 'landed', takeoffAt: string, landingAt: string) =>
    submit({
      type: 'flight.report',
      version: 1,
      subject: { kind: 'flight', id: flightOf(name).id, scope: 'source' },
      occurredAt: activity === 'active' ? takeoffAt : landingAt,
      sourceEventId: `${flightOf(name).id}-${activity}`,
      values: { activity, takeoffAt, ...(activity === 'landed' ? { landingAt } : {}) },
    });

  /**
   * Plans the flight at its site, then sends the dock's messages through the adapter and the sink in order, with the
   * crew's flight report at takeoff and at landing between them, letting the worker finish after each.
   */
  async function fly(name: Flight): Promise<{ takeoffAt: string; landingAt: string }> {
    const flight = flights[name];
    const plan = planDockWind(flight.script, {
      start: at(flight.offsetMinutes).toISOString(),
      dockId: flight.dock,
      runId: prefix,
    });
    const binding: DjiDockBinding = { dockId: flight.dock, siteId: flight.site, dockModel: 'dock2' };
    const context: TranslationContext<DjiDockBinding> = { subjects: { scope: 'source' }, binding };
    const sink = new HttpObservationSink({
      ledger: new LedgerClient(address, `ledger-dev-${who.source.id}`),
      sourceId,
    });
    await submit(
      {
        type: 'operator.record',
        version: 1,
        subject: { kind: 'flight', id: flightOf(name).id, scope: 'source' },
        occurredAt: plan.start,
        sourceEventId: `${flightOf(name).id}-plan`,
        values: {
          recordType: 'flight.plan',
          recordVersion: 1,
          record: {
            windowStartsAt: plan.start,
            windowEndsAt: new Date(Date.parse(plan.start) + plan.durationSeconds * 1000).toISOString(),
            operationKind: 'inspection',
            plannedOriginDescription: 'Fictional dock pad',
            plannedDestinationDescription: 'Fictional dock pad',
            routeSummary: 'Out and back along the fictional fence line.',
            siteId: { id: flight.site, scope: 'source' },
          },
        },
      },
      { start: plan.start, end: new Date(Date.parse(plan.start) + plan.durationSeconds * 1000).toISOString() },
    );
    const reported = { active: false, landed: false };
    for (const message of plan.messages) {
      if (!reported.active && message.occurredAt > plan.takeoffAt) {
        await report(name, 'active', plan.takeoffAt, plan.landingAt);
        reported.active = true;
      }
      if (!reported.landed && message.occurredAt > plan.landingAt) {
        await report(name, 'landed', plan.takeoffAt, plan.landingAt);
        reported.landed = true;
      }
      const vendor: VendorMessage = {
        bytes: message.bytes,
        contentType: 'application/json',
        transport: { topic: message.topic },
        capturedAt: new Date(Date.parse(message.occurredAt) + 250).toISOString(),
      };
      const outcome = await translateAndSubmit(djiDockWindAdapter, vendor, context, sink);
      expect(outcome.rejections).toEqual([]);
      await settle();
    }
    return { takeoffAt: plan.takeoffAt, landingAt: plan.landingAt };
  }

  const subjectQuery = (subject: SubjectReference) =>
    new URLSearchParams({
      subjectKind: subject.kind,
      subjectId: subject.id,
      subjectScope: 'source',
      sourceId,
      limit: '100',
    }).toString();
  async function evaluations(name: Flight, ruleId: string): Promise<RuleEvaluationRecord[]> {
    const response = await call(who.safety, 'GET', `/v1/evaluations?${subjectQuery(flightOf(name))}`);
    expect(response.statusCode, response.body).toBe(200);
    return (response.json().evaluations as RuleEvaluationRecord[])
      .filter((evaluation) => evaluation.rule.id === ruleId)
      .reverse();
  }
  async function findings(name: Flight): Promise<SubjectFindingRecord[]> {
    const response = await call(who.safety, 'GET', `/v1/findings?${subjectQuery(flightOf(name))}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json().findings;
  }
  async function winds(name: Flight): Promise<AcceptedObservation[]> {
    const query = new URLSearchParams({
      type: 'weather.wind',
      subjectKind: 'site',
      subjectId: flights[name].site,
      subjectScope: 'source',
      sourceId,
      from: at(-10).toISOString(),
      to: at(60).toISOString(),
      limit: '500',
    });
    const response = await call(who.source, 'GET', `/v1/observations?${query}`);
    expect(response.statusCode, response.body).toBe(200);
    return (response.json().observations as AcceptedObservation[]).sort((a, b) =>
      a.occurredAt.localeCompare(b.occurredAt),
    );
  }

  beforeAll(async () => {
    registerIndicatorDefinition(indicator);
    registerIndicatorDefinition(windExceedancesPer100FlightsV1());
    registerIndicatorDefinition(flightsWithWindAboveLimitV1());
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

  it('is adopted in active mode only with a wind limit the organization sets', async () => {
    const shown = await call(who.safety, 'GET', '/v1/organization/coverage');
    expect(shown.statusCode, shown.body).toBe(200);
    const now = Date.now();
    const adoption = adoptShownPack(
      shown.json() as OrganizationCoverageResponse,
      pack,
      { start: new Date(now - 60_000).toISOString(), end: new Date(now + 3_600_000).toISOString() },
      'Adopt the example wind procedure with our limit.',
      'active',
    );
    const parameters = { [WIND_AT_DEPARTURE_LEAF_ID]: { limit }, [WIND_IN_FLIGHT_LEAF_ID]: { limit } };
    for (const refused of [undefined, { ...parameters, [WIND_IN_FLIGHT_LEAF_ID]: { limit: 90 } }]) {
      const response = await call(who.safety, 'POST', '/v1/commands', {
        ...adoption,
        ...(refused ? { parameters: refused } : {}),
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().error.code).toBe('invalid_adoption_parameters');
    }
    await command(who.safety, { ...adoption, parameters });
    await settle();
  });

  it('passes at departure, needs attention in flight while the wind is above the limit, and opens one finding', async () => {
    const { takeoffAt, landingAt } = await fly('gusty');
    const accepted = await winds('gusty');
    expect(accepted).toHaveLength(41);
    const speed = (observation: AcceptedObservation) =>
      (observation.observation.values as { speedMetersPerSecond: number }).speedMetersPerSecond;
    const firstAbove = accepted.find((observation) => speed(observation) > limit)!;
    expect(firstAbove.occurredAt).toBe(at(0, 270).toISOString());

    const departure = await evaluations('gusty', WIND_AT_DEPARTURE_LEAF_ID);
    const atTakeoff = accepted.filter((observation) => observation.occurredAt <= takeoffAt).at(-1)!;
    expect(departure.at(-1)).toMatchObject({
      pack: { id: EXAMPLE_WEATHER_PACK_ID, version: 1, digest: pack.digest },
      check: { kind: 'value.within-limit', version: 1 },
      parameters: { field: 'values.speedMetersPerSecond', comparison: 'at_most', limit },
      outcome: 'pass',
      evidence: [{ observationId: atTakeoff.id }],
      summary: `The latest reported value for the wind reading’s Wind speed (m/s) is 4.5; the limit is at most ${limit}.`,
    });
    expect(departure.some((evaluation) => evaluation.outcome === 'attention')).toBe(false);

    // In the air from the report at takeoff to the report at landing: one result per wind report in between.
    const inFlight = await evaluations('gusty', WIND_IN_FLIGHT_LEAF_ID);
    const flown = inFlight.filter((evaluation) => evaluation.applicability === 'applicable');
    const outcomes = flown.map((evaluation) => evaluation.outcome);
    const first = outcomes.indexOf('attention');
    expect(first).toBeGreaterThan(0);
    expect(outcomes).toEqual([
      ...Array(first).fill('pass'),
      ...Array(5).fill('attention'),
      ...Array(outcomes.length - first - 5).fill('pass'),
    ]);
    const during = accepted.filter((item) => item.occurredAt > takeoffAt && item.occurredAt <= landingAt);
    expect(outcomes).toHaveLength(during.length + 1);
    expect(inFlight.at(-1)).toMatchObject({ outcome: 'not_applicable', reasonCode: 'condition_not_met' });

    const [finding, ...others] = await findings('gusty');
    expect(others).toEqual([]);
    expect(finding).toMatchObject({
      packId: EXAMPLE_WEATHER_PACK_ID,
      ruleId: WIND_IN_FLIGHT_LEAF_ID,
      // A later reading inside the limit does not answer the finding: what it reported still happened.
      status: 'open',
      initialEvaluation: {
        id: flown[first]!.id,
        outcome: 'attention',
        evidenceState: 'supported',
        trigger: { kind: 'observation', eventId: firstAbove.eventId },
        evidence: [{ observationId: firstAbove.id, type: 'weather.wind' }],
      },
    });
    expect(finding!.closure).toBeUndefined();
    expect(finding!.initialEvaluation.summary).toBe(
      `The latest reported value for the wind reading’s Wind speed (m/s) is 13.4; the limit is at most ${limit}.`,
    );
  });

  it('passes both rules for a flight in steady wind, with no finding', async () => {
    await fly('calm');
    for (const rule of [WIND_AT_DEPARTURE_LEAF_ID, WIND_IN_FLIGHT_LEAF_ID]) {
      const outcomes = new Set((await evaluations('calm', rule)).map((evaluation) => evaluation.outcome));
      expect(outcomes.has('pass')).toBe(true);
      expect(outcomes.has('attention')).toBe(false);
    }
    expect(await findings('calm')).toEqual([]);
  });

  it('controls the hazard with an operating limit on the wind and measures it over a control window', async () => {
    const [finding] = await findings('gusty');
    const promotion = await call(who.safety, 'GET', `/v1/sms/findings/${encodeURIComponent(finding!.id)}/promotion`);
    expect(promotion.statusCode, promotion.body).toBe(200);
    const shown = promotion.json() as SmsFindingPromotionResponse;
    const hazardId = (
      await command(who.safety, {
        kind: 'sms.record.open',
        record: {
          kind: 'hazard',
          schema: 'sms.hazard.1',
          title: 'Wind above the limit during an inspection flight',
          ownerId: who.safety.id,
          body: {
            description: `Raised from: ${shown.evaluation.summary}`,
            consequence: 'The fictional aircraft is pushed off its line along the fence.',
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
    const listed = (await detail(hazardId)).controlTypes!.find((type) => type.id === operatingLimitControlType.id)!;
    const parameters = {
      observationType: 'weather.wind',
      observationVersion: 1,
      field: 'values.speedMetersPerSecond',
      comparison: 'at_most',
      limit,
      unit: 'm/s',
      scope: 'subject_kind',
      subjectKind: 'site',
    };
    const controlId = (
      await command(who.safety, {
        kind: 'sms.record.open',
        record: {
          kind: 'control',
          schema: 'sms.control.1',
          title: 'Hold flights while the dock measures wind above 10 m/s',
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
        note: 'Assessed against the finding shown, with the wind limit in place.',
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
        note: 'Residual risk accepted with the wind limit in place.',
        assessmentId: assessment.id,
        signature: { intent: signing.intent!, contentDigest: signing.contentDigest!, reviewed: true },
      }),
      { 'x-ledger-reauthentication': grant.json().grant as string },
    );
    const accepted = await detail(hazardId);
    expect(accepted.controls![0]).toMatchObject({ id: controlId, accepted: true });
    // The acceptance records the hazard on file for the organization; project it before reading an indicator.
    await settle();
    const control = {
      kind: 'control_record' as const,
      hazardId,
      recordId: controlId,
      versionNumber: 1,
      bodyDigest: accepted.controls![0]!.bodyDigest,
      acceptanceId: accepted.decisions.find((decision) => decision.kind === 'risk.accept')!.id,
    };

    // A finding is placed by when it opened, so the period runs from before the first takeoff to after the findings.
    // The window ends now by the database's clock, which recorded when each finding opened and records the window's
    // evidence cut when it opens; this machine's clock need not match it.
    const period = { start: at(-1).toISOString(), end: await databaseNow(admin) };
    const opened = await call(who.safety, 'POST', '/v1/control-windows', {
      control,
      period,
      subjectKind: 'flight',
      subjects: [flightOf('gusty'), flightOf('calm')],
      complete: true,
      expectedObservations: [
        { type: 'flight.report', versions: [1] },
        { type: 'weather.wind', versions: [1] },
      ],
      indicators: [{ id: indicator.id, version: 1, digest: indicator.digest }],
      note: 'Both flights flown from the docks this morning.',
    });
    expect(opened.statusCode, opened.body).toBe(201);
    const window = opened.json().window as ControlWindow;
    const calculated = await call(
      who.safety,
      'GET',
      `/v1/control-windows/${window.id}/indicators/${encodeURIComponent(indicator.id)}/versions/1`,
    );
    expect(calculated.statusCode, calculated.body).toBe(200);
    // One flight with wind above the limit in flight out of two flights: 50 per 100 flights.
    expect((calculated.json() as ControlWindowIndicatorResponse).result).toMatchObject({
      status: 'supported',
      control: { id: controlId, version: 1 },
      eventCount: 1,
      exposure: { value: { numerator: '2', denominator: '1' }, unit: 'flight', gaps: [] },
      rate: { value: { numerator: '50', denominator: '1' }, decimal: '50.00', label: 'per 100 flights' },
      population: { subjectCount: 2, complete: true },
      reasons: [],
    });
  });
  // Version 2, adopted by a second organization: the takeoff and whole-flight rules name each stretch above the
  // limit, and the pack's indicators count stretches and flights across both rules.
  it('adopts version 2 in a second organization with a wind limit for each rule', async () => {
    await createOrganization(`${prefix}:org-v2`);
    artifactId = await upload();
    const shown = await call(who.safety, 'GET', '/v1/organization/coverage');
    expect(shown.statusCode, shown.body).toBe(200);
    const now = Date.now();
    const versionTwo = getRulePackVersion(EXAMPLE_WEATHER_PACK_ID, 2)!;
    await command(who.safety, {
      ...adoptShownPack(
        shown.json() as OrganizationCoverageResponse,
        versionTwo,
        { start: new Date(now - 60_000).toISOString(), end: new Date(now + 3_600_000).toISOString() },
        'Adopt the example wind procedure for the whole flight with our limit.',
        'active',
      ),
      parameters: { [WIND_AT_TAKEOFF_LEAF_ID]: { limit }, [WIND_FOR_FLIGHT_LEAF_ID]: { limit } },
    });
    await settle();
  });

  it('gives the same whole-flight result after landing as during the flight, naming each stretch', async () => {
    const { landingAt } = await fly('twice');
    const results = (await evaluations('twice', WIND_FOR_FLIGHT_LEAF_ID)).filter(
      (evaluation) => evaluation.applicability === 'applicable',
    );
    expect(results.every((evaluation) => evaluation.pack.version === 2)).toBe(true);
    const during = results.filter((evaluation) => evaluation.details?.windowClosed === false);
    const after = results.filter((evaluation) => evaluation.details?.windowClosed === true);
    const lastDuring = during.at(-1)!;
    expect(lastDuring).toMatchObject({ outcome: 'attention', evidenceState: 'supported', details: { runCount: 2 } });
    expect(after.length).toBeGreaterThan(0);
    // Wind the dock reports after the landing is not read, so every result after the landing is the same.
    for (const result of after) {
      expect(result).toMatchObject({
        outcome: 'attention',
        evidenceState: 'supported',
        reasonCode: 'values_outside_limit',
        details: { windowEnd: landingAt, runCount: 2, worstValue: 14.2 },
      });
      expect(result.issues).toEqual(lastDuring.issues);
      expect(result.summary).toBe(after[0]!.summary);
      expect(result.inputs.find((input) => input.name === 'values')!.observationIds).toEqual(
        after[0]!.inputs.find((input) => input.name === 'values')!.observationIds,
      );
    }
    expect(after.at(-1)!.issueTimes!.every((time) => time.end !== undefined)).toBe(true);
    const [takeoff] = (await evaluations('twice', WIND_AT_TAKEOFF_LEAF_ID)).slice(-1);
    expect(takeoff).toMatchObject({ outcome: 'attention', details: { worstValue: 11.5 } });
    expect(takeoff!.issues).toHaveLength(1);
    await fly('still');
    const still = (await evaluations('still', WIND_FOR_FLIGHT_LEAF_ID)).at(-1)!;
    expect(still).toMatchObject({ outcome: 'pass', issues: [], details: { windowClosed: true } });
  });

  it('counts two stretches on one flight as two, and a flight with stretches under both rules once', async () => {
    const population = {
      subjects: [flightOf('twice'), flightOf('still')],
      complete: true,
      declaredBy: { kind: 'person' as const, id: who.safety.id },
    };
    // The window and its cut end at the database's clock now, the clock that recorded the evaluations they read.
    const end = await databaseNow(admin);
    const calculate = (definition: ReturnType<typeof windExceedancesPer100FlightsV1>) =>
      withScope(pool, who.safety, async (client, principal) => {
        const gathered = await gatherIndicatorInputs(client, principal, {
          definition: { id: definition.id, version: definition.version },
          window: { start: at(-1).toISOString(), end },
          recordedThrough: end,
          population,
        });
        return calculateIndicator(gathered.definition, gathered.input);
      });
    // Above the limit at takeoff, and twice in the air: three exceedances over two flights.
    expect(await calculate(windExceedancesPer100FlightsV1())).toMatchObject({
      status: 'supported',
      eventCount: 3,
      exposure: { value: { numerator: '2', denominator: '1' }, unit: 'flight' },
      rate: { decimal: '150.00', label: 'per 100 flights' },
      reasons: [],
    });
    // The same flight under both rules is one flight.
    expect(await calculate(flightsWithWindAboveLimitV1())).toMatchObject({
      status: 'supported',
      eventCount: 1,
      rate: { decimal: '50.00' },
      reasons: [],
    });
  });
});
