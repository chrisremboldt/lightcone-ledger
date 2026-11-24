import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../apps/api/src/index.js';
import { djiFaultScripts, planScriptedFlight } from '../../../apps/emulators/src/dji-fault-script.js';
import { LedgerClient } from '../../contracts/src/client.js';
import type {
  AcceptedObservation,
  OrganizationCoverageResponse,
  RuleEvaluationRecord,
  SubjectFindingRecord,
} from '../../contracts/src/index.js';
import { adoptShownPack } from '../../contracts/fixtures/demo/v1/ready.js';
import { evaluateAdoptedRule, getRulePackVersion } from '../../domain/src/index.js';
import { sha256 } from '../../integrity/src/index.js';
import {
  BATTERY_AT_LANDING_LEAF_ID,
  BATTERY_FOR_FLIGHT_LEAF_ID,
  BATTERY_RESERVE_LEAF_ID,
  EXAMPLE_OPERATIONS_PACK_ID,
} from '../../pack-example-operations/src/index.js';
import { createPool, MemoryObjectStore, withScope, type AuthContext } from '../../persistence/src/index.js';
import { type TranslationContext, type VendorMessage, translateAndSubmit } from '../src/adapter-contract.js';
import { djiOsdBatteryAdapter } from '../src/dji-osd-battery.js';
import type { DjiOsdBinding } from '../src/dji-osd-position.js';
import { HttpObservationSink } from '../src/http-observation-sink.js';
import { runOwnedWork, settleOwnedWork } from '../../../tests/integration/worker-queue.js';

// The example battery-reserve rule, fed by the emulator's low-battery script through the battery adapter and the
// public API, evaluated by the worker's generic evaluator. Nothing here is registered by hand: the pack ships with
// the standard packs and the adapter is the shipped one.
describe.runIf(process.env.LEDGER_ENV !== 'staging')('Battery reserve rule from a scripted flight', () => {
  const prefix = `battery-reserve-${randomUUID()}`;
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const workerPool = createPool(process.env.WORKER_DATABASE_URL);
  const sourceId = `${prefix}-telemetry`;
  const binding = { deviceId: `${prefix}-aircraft`, gatewayId: `${prefix}-dock` };
  const context: TranslationContext<DjiOsdBinding> = { subjects: { scope: 'source' }, binding };
  const plan = planScriptedFlight(djiFaultScripts['battery-sag-on-approach']!, {
    start: '2026-10-05T09:00:00.000Z',
    ...binding,
    runId: prefix,
  });
  const messages: VendorMessage[] = plan.messages.map((message) => ({
    bytes: message.bytes,
    contentType: 'application/json',
    transport: { topic: message.topic },
    capturedAt: new Date(Date.parse(message.occurredAt) + 250).toISOString(),
  }));
  const reserve = 25;
  const pack = getRulePackVersion(EXAMPLE_OPERATIONS_PACK_ID, 1)!;
  let app: Awaited<ReturnType<typeof createApp>>;
  let address: string;

  interface Organization {
    actor: AuthContext;
    worker: AuthContext;
    source: AuthContext;
  }
  const organizations = {} as Record<'adopting' | 'other' | 'flights', Organization>;

  function call(principal: AuthContext, method: 'GET' | 'POST', url: string, payload?: unknown) {
    return app.inject({
      method,
      url,
      headers: { authorization: `Bearer ledger-dev-${principal.id}`, 'idempotency-key': randomUUID() },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  }

  async function organization(name: string, observationTypes = ['battery.state']): Promise<Organization> {
    const tenantId = `${prefix}:${name}`;
    const base = { tenantId, revision: 1, kind: 'human', name: `Fictional ${name} owner` };
    const actor: AuthContext = {
      ...base,
      id: `${tenantId}:actor`,
      capabilities: ['flight:read', 'evidence:read', 'authority:write', 'pack:adopt'],
    };
    const worker: AuthContext = {
      ...base,
      id: `${tenantId}:worker`,
      kind: 'worker',
      capabilities: ['flight:read', 'evidence:read', 'input:write'],
    };
    const source: AuthContext = {
      ...base,
      id: `${tenantId}:source`,
      kind: 'source',
      capabilities: ['input:write', 'flight:read', 'evidence:read'],
    };
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, `Fictional ${name} operator`]);
    for (const principal of [actor, worker, source]) {
      await admin.query('INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,$4,$5)', [
        principal.id,
        tenantId,
        principal.name,
        principal.kind,
        principal.capabilities,
      ]);
      await admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [
        sha256(`ledger-dev-${principal.id}`),
        principal.id,
      ]);
    }
    const current = await call(actor, 'GET', `/v1/authority/principals/${encodeURIComponent(source.id)}`);
    expect(current.statusCode, current.body).toBe(200);
    const granted = await call(actor, 'POST', '/v1/commands', {
      kind: 'authority.update',
      principalId: source.id,
      expectedRevision: current.json().principal.revision,
      capabilities: current.json().principal.capabilities,
      observationGrants: observationTypes.map((observationType) => ({ sourceId, observationType })),
    });
    expect(granted.statusCode, granted.body).toBe(201);
    return { actor, worker, source };
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

  const sink = (org: Organization) =>
    new HttpObservationSink({ ledger: new LedgerClient(address, `ledger-dev-${org.source.id}`), sourceId });

  /** Sends each scripted message through the adapter and the sink, letting the worker finish after each one. */
  async function fly(org: Organization) {
    const target = sink(org);
    const receipts: string[] = [];
    for (const message of messages) {
      const outcome = await translateAndSubmit(djiOsdBatteryAdapter, message, context, target);
      expect(outcome.rejections).toEqual([]);
      receipts.push(outcome.submitted[0]!.receiptId);
      await settle();
    }
    return receipts;
  }

  const subjectQuery = (aircraftId = binding.deviceId) =>
    new URLSearchParams({
      subjectKind: 'aircraft',
      subjectId: aircraftId,
      subjectScope: 'source',
      sourceId,
      limit: '100',
    }).toString();

  async function evaluations(org: Organization, aircraftId?: string): Promise<RuleEvaluationRecord[]> {
    const response = await call(org.actor, 'GET', `/v1/evaluations?${subjectQuery(aircraftId)}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json().evaluations;
  }
  async function findings(org: Organization, aircraftId?: string): Promise<SubjectFindingRecord[]> {
    const response = await call(org.actor, 'GET', `/v1/findings?${subjectQuery(aircraftId)}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json().findings;
  }
  async function observations(org: Organization): Promise<AcceptedObservation[]> {
    const query = new URLSearchParams({
      type: 'battery.state',
      subjectKind: 'aircraft',
      subjectId: binding.deviceId,
      subjectScope: 'source',
      sourceId,
      from: '2026-10-05T08:00:00Z',
      to: '2026-10-05T10:00:00Z',
      limit: '500',
    });
    const response = await call(org.source, 'GET', `/v1/observations?${query}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json().observations;
  }

  beforeAll(async () => {
    app = await createApp({ pool, env: 'test', objectStore: new MemoryObjectStore() });
    address = await app.listen({ host: '127.0.0.1', port: 0 });
    organizations.adopting = await organization('adopting');
    organizations.other = await organization('other');
    organizations.flights = await organization('flights', ['battery.state', 'flight.report']);
  });
  afterAll(async () => {
    await settleOwnedWork([prefix]);
    if (app) await app.close();
    await pool.end();
    await admin.end();
    await workerPool.end();
  });

  it('is adopted only with a reserve the organization sets within range', async () => {
    const { actor } = organizations.adopting;
    const shown = await call(actor, 'GET', '/v1/organization/coverage');
    expect(shown.statusCode, shown.body).toBe(200);
    const now = Date.now();
    const command = adoptShownPack(
      shown.json() as OrganizationCoverageResponse,
      pack,
      { start: new Date(now - 60_000).toISOString(), end: new Date(now + 3_600_000).toISOString() },
      'Adopt the example operating procedures with our battery reserve.',
      'active',
    );
    for (const parameters of [undefined, { [BATTERY_RESERVE_LEAF_ID]: { limit: 150 } }]) {
      const refused = await call(actor, 'POST', '/v1/commands', { ...command, ...(parameters ? { parameters } : {}) });
      expect(refused.statusCode, refused.body).toBe(400);
      expect(refused.json().error.code).toBe('invalid_adoption_parameters');
    }
    const adopted = await call(actor, 'POST', '/v1/commands', {
      ...command,
      parameters: { [BATTERY_RESERVE_LEAF_ID]: { limit: reserve } },
    });
    expect(adopted.statusCode, adopted.body).toBe(201);
    await settle();
  });

  it('passes while the battery is above the reserve and opens a finding naming the observation that fell below', async () => {
    const org = organizations.adopting;
    const receipts = await fly(org);
    const accepted = await observations(org);
    expect(accepted).toHaveLength(messages.length);
    const percentOf = new Map(
      accepted.map((item) => [
        item.id,
        (item.observation.values as { totalRemainingPercent: number }).totalRemainingPercent,
      ]),
    );
    const firstBelow = accepted.find((item) => percentOf.get(item.id)! < reserve)!;
    const firstBelowIndex = accepted.indexOf(firstBelow);
    expect(firstBelowIndex).toBeGreaterThan(0);
    expect(accepted.slice(0, firstBelowIndex).every((item) => percentOf.get(item.id)! >= reserve)).toBe(true);

    // One evaluation per accepted observation, oldest first, each naming the latest battery report it read.
    const recorded = (await evaluations(org)).reverse();
    expect(recorded).toHaveLength(messages.length);
    for (const [index, evaluation] of recorded.entries()) {
      const observation = accepted[index]!;
      const below = index >= firstBelowIndex;
      expect(evaluation).toMatchObject({
        subject: { scope: 'source', kind: 'aircraft', id: binding.deviceId, sourceId },
        pack: { id: EXAMPLE_OPERATIONS_PACK_ID, version: 1, digest: pack.digest },
        rule: { id: BATTERY_RESERVE_LEAF_ID, title: 'Battery below adopted reserve' },
        check: { kind: 'value.within-limit', version: 1 },
        parameters: { field: 'values.totalRemainingPercent', comparison: 'at_least', limit: reserve },
        evidenceState: 'supported',
        outcome: below ? 'attention' : 'pass',
        reasonCode: below ? 'value_outside_limit' : 'value_within_limit',
        trigger: { kind: 'observation', eventId: observation.eventId },
        evidence: [
          {
            observationId: observation.id,
            eventId: observation.eventId,
            receiptId: receipts[index],
            sourceId,
            type: 'battery.state',
          },
        ],
      });
    }

    const [finding, ...others] = await findings(org);
    expect(others).toEqual([]);
    expect(finding).toMatchObject({
      subject: { scope: 'source', kind: 'aircraft', id: binding.deviceId, sourceId },
      packId: EXAMPLE_OPERATIONS_PACK_ID,
      ruleId: BATTERY_RESERVE_LEAF_ID,
      status: 'open',
      initialEvaluation: {
        id: recorded[firstBelowIndex]!.id,
        outcome: 'attention',
        trigger: { kind: 'observation', eventId: firstBelow.eventId },
        evidence: [{ observationId: firstBelow.id, eventId: firstBelow.eventId, receiptId: receipts[firstBelowIndex] }],
      },
      latestEvaluation: { id: recorded.at(-1)!.id, outcome: 'attention' },
    });
    expect(finding!.initialEvaluation.summary).toBe(
      `The latest reported value for the battery state’s Battery remaining (%) is ${percentOf.get(firstBelow.id)}; the limit is at least ${reserve}.`,
    );
  });

  it('records nothing new when the same messages are replayed', async () => {
    const org = organizations.adopting;
    const [before, openBefore] = [await evaluations(org), await findings(org)];
    const first = await fly(org);
    const again = await fly(org);
    expect(again).toEqual(first);
    expect(await evaluations(org)).toEqual(before);
    expect(await findings(org)).toEqual(openBefore);
  });

  it('records insufficient evidence, not a pass, for an aircraft with no battery report', async () => {
    const org = organizations.adopting;
    const silent = `${prefix}-silent-aircraft`;
    const [trigger] = await observations(org);
    const evaluation = await withScope(workerPool, org.worker, (client, principal) =>
      evaluateAdoptedRule(client, principal, {
        subject: { scope: 'source', kind: 'aircraft', id: silent, sourceId },
        packId: EXAMPLE_OPERATIONS_PACK_ID,
        leafId: BATTERY_RESERVE_LEAF_ID,
        trigger: { kind: 'observation', eventId: trigger!.eventId },
      }),
    );
    expect(evaluation).toMatchObject({
      subject: { id: silent },
      applicability: 'applicable',
      evidenceState: 'insufficient',
      outcome: 'pending',
      reasonCode: 'required_input_missing',
      evidence: [],
      inputs: [{ name: 'subject', type: 'battery.state', observationIds: [] }],
    });
    expect((await evaluations(org, silent)).map((item) => item.id)).toEqual([evaluation!.id]);
    expect(await findings(org, silent)).toEqual([]);
  });

  it('evaluates nothing for an organization that did not adopt the pack', async () => {
    const org = organizations.other;
    await fly(org);
    expect(await observations(org)).toHaveLength(messages.length);
    expect(await evaluations(org)).toEqual([]);
    expect(await findings(org)).toEqual([]);
    const work = await withScope(workerPool, org.worker, async (client) => ({
      evaluations: (await client.query('SELECT id FROM rule_evaluations')).rowCount,
      queued: (await client.query('SELECT id FROM rule_evaluation_work')).rowCount,
    }));
    expect(work).toEqual({ evaluations: 0, queued: 0 });
  });
  // Version 3, adopted by a third organization: per flight, every battery report of the aircraft its flight report
  // names, from the takeoff to the landing.
  const flightId = `${prefix}-flight`;
  const takeoffAt = new Date(Date.parse(plan.start) + 10_000).toISOString();
  const landingAt = new Date(Date.parse(plan.start) + 220_000).toISOString();

  async function report(org: Organization, activity: 'active' | 'landed', artifactId: string) {
    const occurredAt = activity === 'active' ? takeoffAt : landingAt;
    const response = await call(org.source, 'POST', '/v1/inputs', {
      sourceId,
      kind: 'observation',
      occurredAt,
      payload: {
        type: 'flight.report',
        version: 1,
        subject: { kind: 'flight', id: flightId, scope: 'source' },
        secondarySubject: { kind: 'aircraft', id: binding.deviceId, scope: 'source' },
        occurredAt,
        sourceEventId: `${flightId}-${activity}`,
        values: { activity, takeoffAt, ...(activity === 'landed' ? { landingAt } : {}) },
        fidelity: 'synthetic_contract',
        limitations: ['Synthetic test data.'],
        originalArtifactId: artifactId,
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    await settle();
  }

  it('is adopted as version 3 with a reserve for each rule', async () => {
    const { actor } = organizations.flights;
    const shown = await call(actor, 'GET', '/v1/organization/coverage');
    expect(shown.statusCode, shown.body).toBe(200);
    const now = Date.now();
    const adopted = await call(actor, 'POST', '/v1/commands', {
      ...adoptShownPack(
        shown.json() as OrganizationCoverageResponse,
        getRulePackVersion(EXAMPLE_OPERATIONS_PACK_ID, 3)!,
        { start: new Date(now - 60_000).toISOString(), end: new Date(now + 3_600_000).toISOString() },
        'Adopt the example operating procedures for the whole flight.',
        'active',
      ),
      parameters: {
        [BATTERY_RESERVE_LEAF_ID]: { limit: reserve },
        [BATTERY_AT_LANDING_LEAF_ID]: { limit: reserve },
        [BATTERY_FOR_FLIGHT_LEAF_ID]: { limit: reserve },
      },
    });
    expect(adopted.statusCode, adopted.body).toBe(201);
    await settle();
  });

  it('checks every battery report from takeoff to landing, with the same result after landing as during the flight', async () => {
    const org = organizations.flights;
    const target = sink(org);
    const reported = { active: false, landed: false };
    for (const [index, message] of messages.entries()) {
      const occurredAt = plan.messages[index]!.occurredAt;
      if (!reported.active && occurredAt > takeoffAt) {
        await report(org, 'active', (await observations(org))[0]!.artifactId);
        reported.active = true;
      }
      if (!reported.landed && occurredAt > landingAt) {
        await report(org, 'landed', (await observations(org))[0]!.artifactId);
        reported.landed = true;
      }
      const outcome = await translateAndSubmit(djiOsdBatteryAdapter, message, context, target);
      expect(outcome.rejections).toEqual([]);
      await settle();
    }
    const query = new URLSearchParams({
      subjectKind: 'flight',
      subjectId: flightId,
      subjectScope: 'source',
      sourceId,
      limit: '100',
    });
    const response = await call(org.actor, 'GET', `/v1/evaluations?${query}`);
    expect(response.statusCode, response.body).toBe(200);
    const results = (response.json().evaluations as RuleEvaluationRecord[])
      .filter((item) => item.rule.id === BATTERY_FOR_FLIGHT_LEAF_ID && item.applicability === 'applicable')
      .reverse();
    const lastDuring = results.filter((item) => item.details?.windowClosed === false).at(-1)!;
    const after = results.filter((item) => item.details?.windowClosed === true);
    expect(lastDuring).toMatchObject({ outcome: 'attention', pack: { version: 3 }, details: { runCount: 1 } });
    expect(after.length).toBeGreaterThan(0);
    // Battery reports after the landing, lower still, are not read: every result after the landing is the same.
    for (const result of after) {
      expect(result).toMatchObject({
        outcome: 'attention',
        evidenceState: 'supported',
        reasonCode: 'values_outside_limit',
        details: { windowEnd: landingAt, runCount: 1 },
      });
      expect(result.issues).toEqual(lastDuring.issues);
      expect(result.summary).toBe(after[0]!.summary);
    }
    expect(after[0]!.issueTimes![0]!.end).toBeDefined();
    expect(after[0]!.summary).toMatch(new RegExp(`^The battery was below the ${reserve}% reserve during the flight`));
  });
});
