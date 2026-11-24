import 'dotenv/config';
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
  Capability,
  ControlIndicatorResultResponse,
  ControlWindow,
  ControlWindowIndicatorResponse,
  IndicatorDefinition,
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
import { getRulePackVersion, registerIndicatorDefinition } from '../../domain/src/index.js';
import { sha256 } from '../../integrity/src/index.js';
import {
  BATTERY_AT_LANDING_LEAF_ID,
  BATTERY_FOR_FLIGHT_LEAF_ID,
  BATTERY_RESERVE_LEAF_ID,
  EXAMPLE_OPERATIONS_PACK_ID,
  lowReserveLandingsPer100FlightsV1,
  reserveExceedancesPerFlightHourV1,
} from '../../pack-example-operations/src/index.js';
import { createPool, MemoryObjectStore, type AuthContext } from '../../persistence/src/index.js';
import { type TranslationContext, type VendorMessage, translateAndSubmit } from '../src/adapter-contract.js';
import { djiOsdBatteryAdapter } from '../src/dji-osd-battery.js';
import type { DjiOsdBinding } from '../src/dji-osd-position.js';
import { HttpObservationSink } from '../src/http-observation-sink.js';
import { databaseNow, runOwnedWork, settleOwnedWork } from '../../../tests/integration/worker-queue.js';

// Four scripted flights through the emulator's battery fault scripts, the shipped battery adapter and the public API,
// evaluated by the worker's generic evaluator under version 3 of the example operations pack. A hazard opened from a
// low-reserve landing is controlled with an operating limit on the battery, and a window over that control
// calculates the pack's two battery indicators. Nothing in core code names the rules or the indicators.
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

// Two short sags of the reported battery under load in the air, each back above the reserve within twenty seconds.
const sagsTwice: DjiFaultScript = {
  ...djiFaultScripts['battery-sag-on-approach']!,
  name: 'battery-sags-under-load-twice',
  description: 'The reported battery sags below 25 percent twice in the air and recovers each time.',
  battery: { ...djiFaultScripts['battery-sag-on-approach']!.battery, percent: 60, declinePercentPerMinute: 3 },
  steps: [
    { atSeconds: 60, action: 'battery', percent: 22 },
    { atSeconds: 80, action: 'battery', percent: 55 },
    { atSeconds: 140, action: 'battery', percent: 23 },
    { atSeconds: 160, action: 'battery', percent: 50 },
  ],
};

describe.runIf(process.env.LEDGER_ENV !== 'staging')('Battery reserve indicators from scripted flights', () => {
  const prefix = `battery-indicator-${randomUUID()}`;
  const tenantId = `${prefix}:org`;
  const sourceId = `${prefix}-telemetry`;
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const workerPool = createPool(process.env.WORKER_DATABASE_URL);
  const who = {} as Record<Role, AuthContext>;
  const reserve = 25;
  const start = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 2 * 3_600_000);
  const at = (minutes: number, seconds = 0) => new Date(start.getTime() + minutes * 60_000 + seconds * 1000);
  // Airborne 210, 100, 200 and 210 seconds: 720 seconds, a fifth of an hour, in all.
  const flights = {
    approach: { script: djiFaultScripts['battery-sag-on-approach']!, offset: 0, takeoff: 10, landing: 220 },
    forced: { script: djiFaultScripts['below-forced-landing']!, offset: 15, takeoff: 10, landing: 110 },
    // Reported every five seconds rather than two, so the flight's messages fit one test's time.
    normal: {
      script: { ...djiFaultScripts['normal-flight']!, periodSeconds: 5 },
      offset: 30,
      takeoff: 50,
      landing: 250,
    },
    sags: { script: sagsTwice, offset: 45, takeoff: 10, landing: 220 },
  };
  type Flight = keyof typeof flights;
  const landingIndicator = lowReserveLandingsPer100FlightsV1();
  const exceedanceIndicator = reserveExceedancesPerFlightHourV1();
  let app: Awaited<ReturnType<typeof createApp>>;
  let address: string;
  let artifactId: string;

  const flightOf = (name: Flight): SubjectReference => ({
    scope: 'source',
    kind: 'flight',
    id: `${prefix}-flight-${name}`,
    sourceId,
  });
  const aircraftOf = (name: Flight) => `${prefix}-aircraft-${name}`;

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

  async function createOrganization(): Promise<void> {
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
      observationGrants: ['battery.state', 'flight.report'].map((observationType) => ({ sourceId, observationType })),
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

  async function report(name: Flight, activity: 'active' | 'landed', takeoffAt: string, landingAt: string) {
    const occurredAt = activity === 'active' ? takeoffAt : landingAt;
    const response = await call(who.source, 'POST', '/v1/inputs', {
      sourceId,
      kind: 'observation',
      occurredAt,
      payload: {
        type: 'flight.report',
        version: 1,
        subject: { kind: 'flight', id: flightOf(name).id, scope: 'source' },
        secondarySubject: { kind: 'aircraft', id: aircraftOf(name), scope: 'source' },
        occurredAt,
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

  /**
   * Sends the script's messages through the battery adapter and the sink in order, with the crew's flight report at
   * takeoff and at landing between them, letting the worker finish after each.
   */
  async function fly(name: Flight): Promise<void> {
    const flight = flights[name];
    const binding = { deviceId: aircraftOf(name), gatewayId: `${prefix}-dock-${name}` };
    const plan = planScriptedFlight(flight.script, {
      start: at(flight.offset).toISOString(),
      ...binding,
      runId: prefix,
    });
    const takeoffAt = at(flight.offset, flight.takeoff).toISOString();
    const landingAt = at(flight.offset, flight.landing).toISOString();
    const context: TranslationContext<DjiOsdBinding> = { subjects: { scope: 'source' }, binding };
    const sink = new HttpObservationSink({
      ledger: new LedgerClient(address, `ledger-dev-${who.source.id}`),
      sourceId,
    });
    const reported = { active: false, landed: false };
    for (const message of plan.messages) {
      if (!reported.active && message.occurredAt > takeoffAt) {
        await report(name, 'active', takeoffAt, landingAt);
        reported.active = true;
      }
      if (!reported.landed && message.occurredAt > landingAt) {
        await report(name, 'landed', takeoffAt, landingAt);
        reported.landed = true;
      }
      const vendor: VendorMessage = {
        bytes: message.bytes,
        contentType: 'application/json',
        transport: { topic: message.topic },
        capturedAt: new Date(Date.parse(message.occurredAt) + 250).toISOString(),
      };
      const outcome = await translateAndSubmit(djiOsdBatteryAdapter, vendor, context, sink);
      expect(outcome.rejections).toEqual([]);
      await settle();
    }
    expect(reported).toEqual({ active: true, landed: true });
  }

  const subjectQuery = (subject: SubjectReference) =>
    new URLSearchParams({
      subjectKind: subject.kind,
      subjectId: subject.id,
      subjectScope: 'source',
      sourceId,
      limit: '100',
    }).toString();
  async function latest(name: Flight, ruleId: string): Promise<RuleEvaluationRecord> {
    const response = await call(who.safety, 'GET', `/v1/evaluations?${subjectQuery(flightOf(name))}`);
    expect(response.statusCode, response.body).toBe(200);
    return (response.json().evaluations as RuleEvaluationRecord[]).find(
      (evaluation) => evaluation.rule.id === ruleId && evaluation.applicability === 'applicable',
    )!;
  }
  async function findings(name: Flight): Promise<SubjectFindingRecord[]> {
    const response = await call(who.safety, 'GET', `/v1/findings?${subjectQuery(flightOf(name))}`);
    expect(response.statusCode, response.body).toBe(200);
    return (response.json().findings as SubjectFindingRecord[]).filter(
      (finding) => finding.ruleId === BATTERY_AT_LANDING_LEAF_ID,
    );
  }

  /** Opens a hazard from the finding and accepts it with an operating limit on the battery; returns the control. */
  async function acceptOperatingLimit(finding: SubjectFindingRecord) {
    const promotion = await call(who.safety, 'GET', `/v1/sms/findings/${encodeURIComponent(finding.id)}/promotion`);
    expect(promotion.statusCode, promotion.body).toBe(200);
    const shown = promotion.json() as SmsFindingPromotionResponse;
    const hazardId = (
      await command(who.safety, {
        kind: 'sms.record.open',
        record: {
          kind: 'hazard',
          schema: 'sms.hazard.1',
          title: 'Landing with the battery below the adopted reserve',
          ownerId: who.safety.id,
          body: {
            description: `Raised from: ${shown.evaluation.summary}`,
            consequence: 'Forced landing of the fictional survey aircraft short of its pad.',
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
    const controlId = (
      await command(who.safety, {
        kind: 'sms.record.open',
        record: {
          kind: 'control',
          schema: 'sms.control.1',
          title: 'Battery reserve of 25 percent',
          ownerId: who.safety.id,
          body: {
            hazardId,
            controlType: { id: listed.id, version: listed.version, digest: listed.digest },
            parameters: {
              observationType: 'battery.state',
              observationVersion: 1,
              field: 'values.totalRemainingPercent',
              comparison: 'at_least',
              limit: reserve,
              unit: 'percent',
              scope: 'subject_kind',
              subjectKind: 'aircraft',
            },
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
        note: 'Assessed against the finding shown, with the reserve limit in place.',
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
        note: 'Residual risk accepted with the battery reserve limit in place.',
        assessmentId: assessment.id,
        signature: { intent: signing.intent!, contentDigest: signing.contentDigest!, reviewed: true },
      }),
      { 'x-ledger-reauthentication': grant.json().grant as string },
    );
    const accepted = await detail(hazardId);
    expect(accepted.controls![0]).toMatchObject({ id: controlId, accepted: true });
    await settle();
    return {
      kind: 'control_record' as const,
      hazardId,
      recordId: controlId,
      versionNumber: 1,
      bodyDigest: accepted.controls![0]!.bodyDigest,
      acceptanceId: accepted.decisions.find((decision) => decision.kind === 'risk.accept')!.id,
    };
  }

  beforeAll(async () => {
    registerIndicatorDefinition(landingIndicator);
    registerIndicatorDefinition(exceedanceIndicator);
    app = await createApp({ pool, env: 'test', objectStore: new MemoryObjectStore() });
    address = await app.listen({ host: '127.0.0.1', port: 0 });
    await createOrganization();
    artifactId = await upload();
    const drafter = { id: who.safety.id, token: `ledger-dev-${who.safety.id}` };
    const adopter = { token: `ledger-dev-${who.executive.id}` };
    expect(await adoptExampleRiskMatrix(app, { drafter, adopter, note: 'Adopting the fictional matrix.' })).toBe(true);
    const shown = await call(who.safety, 'GET', '/v1/organization/coverage');
    expect(shown.statusCode, shown.body).toBe(200);
    const now = Date.now();
    await command(who.safety, {
      ...adoptShownPack(
        shown.json() as OrganizationCoverageResponse,
        getRulePackVersion(EXAMPLE_OPERATIONS_PACK_ID, 3)!,
        { start: new Date(now - 60_000).toISOString(), end: new Date(now + 3_600_000).toISOString() },
        'Adopt the example operating procedures with our battery reserve.',
        'active',
      ),
      parameters: {
        [BATTERY_RESERVE_LEAF_ID]: { limit: reserve },
        [BATTERY_AT_LANDING_LEAF_ID]: { limit: reserve },
        [BATTERY_FOR_FLIGHT_LEAF_ID]: { limit: reserve },
      },
    });
    await settle();
  });
  afterAll(async () => {
    await settleOwnedWork([prefix]);
    if (app) await app.close();
    await pool.end();
    await admin.end();
    await workerPool.end();
  });

  it('lands below the reserve after a sag on the approach: one stretch, one landing finding', async () => {
    await fly('approach');
    expect(await latest('approach', BATTERY_AT_LANDING_LEAF_ID)).toMatchObject({ outcome: 'attention' });
    expect(await latest('approach', BATTERY_FOR_FLIGHT_LEAF_ID)).toMatchObject({
      outcome: 'attention',
      details: { windowClosed: true, runCount: 1 },
    });
    expect(await findings('approach')).toHaveLength(1);
  });

  it('lands below the reserve when the whole flight was below it: one stretch, one landing finding', async () => {
    await fly('forced');
    expect(await latest('forced', BATTERY_AT_LANDING_LEAF_ID)).toMatchObject({ outcome: 'attention' });
    expect(await latest('forced', BATTERY_FOR_FLIGHT_LEAF_ID)).toMatchObject({
      outcome: 'attention',
      details: { windowClosed: true, runCount: 1 },
    });
    expect(await findings('forced')).toHaveLength(1);
  });

  it('stays above the reserve on an ordinary flight', async () => {
    await fly('normal');
    expect(await latest('normal', BATTERY_AT_LANDING_LEAF_ID)).toMatchObject({ outcome: 'pass' });
    expect(await latest('normal', BATTERY_FOR_FLIGHT_LEAF_ID)).toMatchObject({ outcome: 'pass', issues: [] });
    expect(await findings('normal')).toEqual([]);
  });

  it('dips below the reserve twice in the air and lands above it: two stretches, no landing finding', async () => {
    await fly('sags');
    expect(await latest('sags', BATTERY_AT_LANDING_LEAF_ID)).toMatchObject({ outcome: 'pass' });
    const whole = await latest('sags', BATTERY_FOR_FLIGHT_LEAF_ID);
    expect(whole).toMatchObject({ outcome: 'attention', details: { windowClosed: true, runCount: 2 } });
    expect(whole.issues).toHaveLength(2);
    expect(await findings('sags')).toEqual([]);
  });

  it('measures an accepted battery-reserve control over a window with the pack’s indicators', async () => {
    const [finding] = await findings('approach');
    const control = await acceptOperatingLimit(finding!);
    // A finding is placed by when it opened, so the period runs from before the first takeoff to now.
    // The window ends now by the database's clock, which recorded when each finding opened and records the window's
    // evidence cut when it opens; this machine's clock need not match it.
    const period = { start: at(-1).toISOString(), end: await databaseNow(admin) };
    const opened = await call(who.safety, 'POST', '/v1/control-windows', {
      control,
      period,
      subjectKind: 'flight',
      subjects: (Object.keys(flights) as Flight[]).map(flightOf),
      complete: true,
      expectedObservations: [
        { type: 'battery.state', versions: [1] },
        { type: 'flight.report', versions: [1] },
      ],
      indicators: [landingIndicator, exceedanceIndicator].map(({ id, version, digest }) => ({ id, version, digest })),
      note: 'Every survey flight flown this morning.',
    });
    expect(opened.statusCode, opened.body).toBe(201);
    const window = opened.json().window as ControlWindow;
    const calculate = async (definition: IndicatorDefinition) => {
      const response = await call(
        who.safety,
        'GET',
        `/v1/control-windows/${window.id}/indicators/${encodeURIComponent(definition.id)}/versions/1`,
      );
      expect(response.statusCode, response.body).toBe(200);
      return response.json() as ControlWindowIndicatorResponse;
    };

    // Two of the four flights landed below the reserve: 50 per 100 flights.
    const landings = await calculate(landingIndicator);
    expect(landings.result).toMatchObject({
      status: 'supported',
      control: { id: control.recordId, version: 1 },
      eventCount: 2,
      exposure: { value: { numerator: '4', denominator: '1' }, unit: 'flight', gaps: [], conflicts: [] },
      rate: { value: { numerator: '50', denominator: '1' }, decimal: '50.00', label: 'per 100 flights' },
      population: { subjectCount: 4, complete: true },
      reasons: [],
    });
    expect(landings.wording).toMatchObject({
      title: 'Low-reserve landings per 100 flights',
      rate: '50 per 100 flights',
      events: '2 findings',
      exposure: '4 flights',
      population: '4 flights, declared complete by Fictional safety',
    });

    // One stretch, one stretch, none and two, over a fifth of a flight hour: 20 per flight hour.
    const exceedances = await calculate(exceedanceIndicator);
    expect(exceedances.result).toMatchObject({
      status: 'supported',
      eventCount: 4,
      exposure: { value: { numerator: '1', denominator: '5' }, unit: 'flight_hour', gaps: [], conflicts: [] },
      rate: { value: { numerator: '20', denominator: '1' }, decimal: '20.00', label: 'per flight hour' },
      eventsPlacedBy: ['issue'],
      reasons: [],
    });
    expect(exceedances.wording).toMatchObject({ exposure: '0.2 flight hours', events: '4 issues' });

    // The landing indicator is recorded through the window, as a person would before reviewing it.
    const recorded = await call(who.safety, 'POST', `/v1/control-windows/${window.id}/indicator-results`, {
      definition: { id: landingIndicator.id, version: 1, digest: landingIndicator.digest },
      expectedRevision: { number: window.revision.number, digest: window.revision.digest },
    });
    expect(recorded.statusCode, recorded.body).toBe(201);
    const result = recorded.json() as ControlIndicatorResultResponse;
    expect(result).toMatchObject({
      record: { windowId: window.id, result: { status: 'supported', rate: { decimal: '50.00' } } },
      currentness: { status: 'current', inputDigest: landings.result.inputDigest },
      wording: { title: 'Low-reserve landings per 100 flights' },
    });
  });
});
