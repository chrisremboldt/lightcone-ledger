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
import { describedMeasureControlType } from '../../domain/src/control-type-library.js';
import { getRulePackVersion, registerIndicatorDefinition } from '../../domain/src/index.js';
import { sha256 } from '../../integrity/src/index.js';
import {
  ASSIGNED_CREW_LEAF_ID,
  DUTY_PERIOD_LEAF_ID,
  EXAMPLE_CREW_PACK_ID,
  REST_BEFORE_DUTY_LEAF_ID,
  ROLLING_DUTY_LEAF_ID,
  assignmentsOutsideLimitsV1,
} from '../../pack-example-crew/src/index.js';
import { createPool, MemoryObjectStore, type AuthContext } from '../../persistence/src/index.js';
import { type VendorMessage, translateAndSubmit } from '../src/adapter-contract.js';
import { crewRosterDutyAdapter } from '../src/crew-roster-duty.js';
import { HttpObservationSink } from '../src/http-observation-sink.js';
import { databaseNow, runOwnedWork, settleOwnedWork } from '../../../tests/integration/worker-queue.js';

// The example crew pack over the sample roster (through the roster adapter and generic intake) and the sample role
// assignments (through the operator record import), evaluated by the worker's generic evaluator. A correction to one
// duty period clears that person's results, a hazard opened from a per-flight finding is controlled with a described
// measure, and the pack's indicator is calculated for a control window. Nothing in core code names the rules.
type Role = 'safety' | 'executive' | 'dispatcher' | 'worker';
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
  dispatcher: { kind: 'human', capabilities: ['input:write', 'evidence:read', 'flight:read'] },
  worker: { kind: 'worker', capabilities: ['flight:read', 'evidence:read', 'input:write'] },
};
const samples = join(import.meta.dirname, '../../contracts/fixtures/operator-records');
const sourceId = 'operator-records';
const DAY = 86_400_000;
const crew = ['ALPHA-OBSERVER-01', 'ALPHA-PILOT-01', 'ALPHA-PILOT-02'];
const flights = ['1001', '1002', '1003', '1004', '1005', '1006'].map((number) => `ALPHA-FLT-${number}`);

describe.runIf(process.env.LEDGER_ENV !== 'staging')('Crew duty and rest rules from an imported roster', () => {
  const prefix = `crew-duty-${randomUUID()}`;
  const tenantId = `${prefix}:org`;
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const workerPool = createPool(process.env.WORKER_DATABASE_URL);
  const who = {} as Record<Role, AuthContext>;
  const limits = { maxDutyHours: 10, minRestHours: 10, maxRollingDutyHours: 50, dutyRecordComplete: false };
  const parameters = {
    [DUTY_PERIOD_LEAF_ID]: { maxDutyHours: limits.maxDutyHours },
    [REST_BEFORE_DUTY_LEAF_ID]: { minRestHours: limits.minRestHours, dutyRecordComplete: false },
    [ROLLING_DUTY_LEAF_ID]: { maxRollingDutyHours: limits.maxRollingDutyHours },
    [ASSIGNED_CREW_LEAF_ID]: limits,
  };
  const pack = getRulePackVersion(EXAMPLE_CREW_PACK_ID, 1)!;
  const indicator = assignmentsOutsideLimitsV1();
  // The sample fortnight ends at 2026-10-19T00:00Z; it is moved by whole days so that it ends at today's midnight.
  const offset = Math.floor(Date.now() / DAY) * DAY - Date.parse('2026-10-19T00:00:00Z');
  const stored = (time: string) => new Date(Date.parse(time) + offset).toISOString();
  const shifted = (time: string) => stored(time).replace('.000Z', 'Z');
  let app: Awaited<ReturnType<typeof createApp>>;
  let address: string;

  function sample(name: string): Buffer {
    const text = readFileSync(join(samples, name), 'utf8');
    return Buffer.from(text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g, shifted));
  }
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
    for (let attempt = 0; attempt < 200; attempt++) {
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

  async function createOrganization(): Promise<void> {
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, 'Fictional crew operator']);
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
    const id = encodeURIComponent(who.dispatcher.id);
    const current = await call(who.safety, 'GET', `/v1/authority/principals/${id}`);
    expect(current.statusCode, current.body).toBe(200);
    await command(who.safety, {
      kind: 'authority.update',
      principalId: who.dispatcher.id,
      expectedRevision: current.json().principal.revision,
      capabilities: current.json().principal.capabilities,
      observationGrants: ['operator.record', 'crew.duty-period'].map((observationType) => ({
        sourceId,
        observationType,
      })),
    });
  }

  async function upload(bytes: Buffer, contentType: string): Promise<string> {
    const created = await call(who.dispatcher, 'POST', '/v1/uploads', { contentType, byteLength: bytes.byteLength });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().upload.id as string;
    const stored = await app.inject({
      method: 'PUT',
      url: `/v1/uploads/${id}/content`,
      headers: {
        authorization: `Bearer ledger-dev-${who.dispatcher.id}`,
        'idempotency-key': randomUUID(),
        'content-type': 'application/octet-stream',
      },
      payload: bytes,
    });
    expect(stored.statusCode, stored.body).toBe(200);
    const finalized = await call(who.dispatcher, 'POST', `/v1/uploads/${id}/finalize`);
    expect(finalized.statusCode, finalized.body).toBe(201);
    return finalized.json().artifact.id as string;
  }
  function roster(bytes: Buffer): VendorMessage {
    return {
      bytes,
      contentType: 'application/json',
      transport: { path: '/imports/roster' },
      capturedAt: new Date().toISOString(),
    };
  }

  const subject = (kind: 'person' | 'flight', id: string): SubjectReference => ({
    scope: 'source',
    kind,
    id,
    sourceId,
  });
  const personKey = (id: string) => `source/${sourceId}/person/${id}`;
  const subjectQuery = (kind: 'person' | 'flight', id: string) =>
    new URLSearchParams({ subjectKind: kind, subjectId: id, subjectScope: 'source', sourceId, limit: '100' });
  async function evaluations(kind: 'person' | 'flight', id: string, ruleId: string): Promise<RuleEvaluationRecord[]> {
    const response = await call(who.safety, 'GET', `/v1/evaluations?${subjectQuery(kind, id)}`);
    expect(response.statusCode, response.body).toBe(200);
    return (response.json().evaluations as RuleEvaluationRecord[]).filter((item) => item.rule.id === ruleId);
  }
  async function latest(kind: 'person' | 'flight', id: string, ruleId: string): Promise<RuleEvaluationRecord> {
    return (await evaluations(kind, id, ruleId))[0]!;
  }
  /** The latest per-flight result for each person the flight's assignments name. */
  async function latestByPerson(flight: string): Promise<Map<string, RuleEvaluationRecord>> {
    const results = new Map<string, RuleEvaluationRecord>();
    for (const item of await evaluations('flight', flight, ASSIGNED_CREW_LEAF_ID)) {
      const key = item.related?.subjectKey ?? '';
      if (!results.has(key)) results.set(key, item);
    }
    return results;
  }
  async function findings(kind: 'person' | 'flight', id: string): Promise<SubjectFindingRecord[]> {
    const response = await call(who.safety, 'GET', `/v1/findings?${subjectQuery(kind, id)}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json().findings;
  }
  async function dutyPeriods(person: string): Promise<AcceptedObservation[]> {
    const query = new URLSearchParams({
      type: 'crew.duty-period',
      subjectKind: 'person',
      subjectId: person,
      subjectScope: 'source',
      sourceId,
      from: shifted('2026-10-01T00:00:00Z'),
      to: new Date().toISOString(),
      limit: '500',
    });
    const response = await call(who.dispatcher, 'GET', `/v1/observations?${query}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json().observations;
  }

  let assignmentIds: Map<string, string>;
  let longDuty: AcceptedObservation;

  beforeAll(async () => {
    registerIndicatorDefinition(indicator);
    app = await createApp({ pool, env: 'test', objectStore: new MemoryObjectStore() });
    address = await app.listen({ host: '127.0.0.1', port: 0 });
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

  it('is adopted in active mode only with the limits the organization sets', async () => {
    const shown = await call(who.safety, 'GET', '/v1/organization/coverage');
    expect(shown.statusCode, shown.body).toBe(200);
    const now = Date.now();
    const adoption = adoptShownPack(
      shown.json() as OrganizationCoverageResponse,
      pack,
      { start: new Date(now - 60_000).toISOString(), end: new Date(now + 3_600_000).toISOString() },
      'Adopt the example crew duty and rest procedure with our own limits.',
      'active',
    );
    const tooLong = { ...parameters, [DUTY_PERIOD_LEAF_ID]: { maxDutyHours: 30 } };
    for (const refusedParameters of [undefined, tooLong]) {
      const refused = await call(who.safety, 'POST', '/v1/commands', {
        ...adoption,
        ...(refusedParameters ? { parameters: refusedParameters } : {}),
      });
      expect(refused.statusCode, refused.body).toBe(400);
      expect(refused.json().error.code).toBe('invalid_adoption_parameters');
    }
    await command(who.safety, { ...adoption, parameters });
    await settle();
  });

  it('records the roster through the adapter and finds the long duty period and the short rest per person', async () => {
    const sink = new HttpObservationSink({
      ledger: new LedgerClient(address, `ledger-dev-${who.dispatcher.id}`),
      sourceId,
    });
    const outcome = await translateAndSubmit(
      crewRosterDutyAdapter,
      roster(sample('../crew-roster/alpha-crew-roster.json')),
      {
        subjects: { scope: 'source' },
        binding: undefined,
      },
      sink,
    );
    expect(outcome.rejections).toEqual([]);
    expect(outcome.submitted).toHaveLength(63);
    await settle();

    const periods = new Map(
      await Promise.all(crew.map(async (person) => [person, await dutyPeriods(person)] as const)),
    );
    for (const person of crew) expect(periods.get(person), person).toHaveLength(21);
    longDuty = periods.get('ALPHA-PILOT-02')!.find((period) => period.sourceEventId === 'R-0059@1')!;
    expect(longDuty.interval).toEqual({ start: stored('2026-10-16T06:00:00Z'), end: stored('2026-10-16T18:30:00Z') });

    const expected: Record<string, Record<string, string>> = {
      [DUTY_PERIOD_LEAF_ID]: { 'ALPHA-PILOT-02': 'attention' },
      [REST_BEFORE_DUTY_LEAF_ID]: { 'ALPHA-OBSERVER-01': 'attention' },
      [ROLLING_DUTY_LEAF_ID]: {},
    };
    for (const [ruleId, attention] of Object.entries(expected))
      for (const person of crew) {
        const result = await latest('person', person, ruleId);
        expect(result, `${ruleId} ${person}`).toMatchObject({
          subject: subject('person', person),
          pack: { id: EXAMPLE_CREW_PACK_ID, version: 1, digest: pack.digest },
          check: { kind: 'duty.within-limits', version: 1 },
          outcome: attention[person] ?? 'pass',
        });
        // Each result reads all of the person's periods and cites the ones it used.
        const read = result.inputs.find((input) => input.name === 'periods')!;
        expect(new Set(read.observationIds)).toEqual(new Set(periods.get(person)!.map((period) => period.id)));
        expect(result.evidence.length).toBeGreaterThan(0);
        for (const cited of result.evidence) expect(read.observationIds).toContain(cited.observationId);
      }
    const duty = await latest('person', 'ALPHA-PILOT-02', DUTY_PERIOD_LEAF_ID);
    expect(duty).toMatchObject({
      reasonCode: 'duty_limit_exceeded',
      summary: 'The duty period lasts 12.5 h against at most 10 h.',
      evidence: [{ observationId: longDuty.id }],
    });
    const rest = await latest('person', 'ALPHA-OBSERVER-01', REST_BEFORE_DUTY_LEAF_ID);
    expect(rest.summary).toBe(
      'The longest continuous recorded rest in the 24 h before the duty period is 8 h against at least 10 h.',
    );
    expect((await findings('person', 'ALPHA-PILOT-02')).map((item) => item.ruleId)).toEqual([DUTY_PERIOD_LEAF_ID]);
    expect((await findings('person', 'ALPHA-OBSERVER-01')).map((item) => item.ruleId)).toEqual([
      REST_BEFORE_DUTY_LEAF_ID,
    ]);
    expect(await findings('person', 'ALPHA-PILOT-01')).toEqual([]);
  });

  it('imports the role assignments and needs attention for each person assigned while outside a limit', async () => {
    const artifactId = await upload(sample('alpha-crew-assignments.csv'), 'text/csv');
    const committed = await call(who.dispatcher, 'POST', '/v1/operator-records/imports', {
      artifactId,
      recordType: 'operation.role-assignment',
      recordVersion: 1,
    });
    expect(committed.statusCode, committed.body).toBe(201);
    const rows = committed.json().rows as { row: number; status: string; observationId: string }[];
    expect(rows.map((row) => row.status)).toEqual(Array(12).fill('recorded'));
    const csv = sample('alpha-crew-assignments.csv').toString('utf8').trim().split('\n').slice(1);
    assignmentIds = new Map(
      rows.map((row) => {
        const [flight, , person] = csv[row.row - 1]!.split(',');
        return [`${flight} ${person}`, row.observationId];
      }),
    );
    await settle();

    const attention = [
      'ALPHA-FLT-1005 ALPHA-PILOT-02',
      'ALPHA-FLT-1005 ALPHA-OBSERVER-01',
      'ALPHA-FLT-1006 ALPHA-PILOT-02',
    ];
    for (const flight of flights) {
      const results = await latestByPerson(flight);
      const named = [...assignmentIds.keys()].filter((key) => key.startsWith(`${flight} `));
      // One result per named person; with no problem in the fan-out itself there is no flight-level record.
      expect([...results.keys()].sort(), flight).toEqual(named.map((key) => personKey(key.split(' ')[1]!)).sort());
      for (const key of named) {
        const person = key.split(' ')[1]!;
        const result = results.get(personKey(person))!;
        expect(result, key).toMatchObject({
          subject: subject('flight', flight),
          outcome: attention.includes(key) ? 'attention' : 'pass',
          related: { name: 'person', subject: subject('person', person) },
        });
        // The window is the assignment that named the person; the periods are that person's.
        const window = result.inputs.find((input) => input.name === 'window')!;
        expect(window.observationIds).toEqual([assignmentIds.get(key)]);
        expect(result.evidence[0]!.observationId).toBe(assignmentIds.get(key));
        expect(result.inputs.find((input) => input.name === 'periods')).toMatchObject({
          about: { related: 'person' },
          subject: subject('person', person),
        });
      }
    }
    const late = (await latestByPerson('ALPHA-FLT-1006')).get(personKey('ALPHA-PILOT-02'))!;
    expect(late.evidence.map((item) => item.observationId)).toContain(longDuty.id);

    const flightFindings = (await Promise.all(flights.map((flight) => findings('flight', flight)))).flat();
    expect(flightFindings.map((item) => `${item.subject.id} ${item.related!.subject.id}`).sort()).toEqual(
      [...attention].sort(),
    );
    for (const finding of flightFindings)
      expect(finding).toMatchObject({ ruleId: ASSIGNED_CREW_LEAF_ID, status: 'open' });
  });

  it('clears the person’s results after a correction and re-evaluates only the flights naming them', async () => {
    const before = new Map(
      await Promise.all(
        flights.map(
          async (flight) => [flight, (await evaluations('flight', flight, ASSIGNED_CREW_LEAF_ID)).length] as const,
        ),
      ),
    );
    // The roster entry is amended: the long duty period ended at 15:30, not 18:30.
    const corrected = Buffer.from(
      JSON.stringify({
        format: 'crew-roster-export',
        formatVersion: 1,
        entries: [
          {
            entryId: 'R-0059',
            revision: 2,
            employeeId: 'ALPHA-PILOT-02',
            position: 'PILOT',
            kind: 'DUTY',
            start: shifted('2026-10-16T06:00:00Z'),
            end: shifted('2026-10-16T15:30:00Z'),
          },
        ],
      }),
    );
    const [draft] = crewRosterDutyAdapter.translate(roster(corrected), {
      subjects: { scope: 'source' },
      binding: undefined,
    }).drafts;
    const artifactId = await upload(corrected, 'application/json');
    const replaced = await call(who.dispatcher, 'POST', '/v1/inputs', {
      sourceId,
      kind: 'observation',
      occurredAt: draft!.occurredAt,
      replaces: longDuty.id,
      payload: {
        ...draft,
        fidelity: crewRosterDutyAdapter.descriptor.fidelity,
        limitations: crewRosterDutyAdapter.descriptor.limitations,
        originalArtifactId: artifactId,
      },
    });
    expect(replaced.statusCode, replaced.body).toBe(201);
    const eventId = replaced.json().receipt.eventId as string;
    await settle();

    const queued = await admin.query(
      `SELECT DISTINCT subject_key,leaf_id FROM rule_evaluation_work WHERE tenant_id=$1 AND trigger_event_id=$2
       ORDER BY subject_key,leaf_id`,
      [tenantId, eventId],
    );
    const flightKey = (flight: string) => `source/${sourceId}/flight/${flight}`;
    expect(queued.rows).toEqual(
      [
        ...['ALPHA-FLT-1002', 'ALPHA-FLT-1005', 'ALPHA-FLT-1006'].map((flight) => ({
          subject_key: flightKey(flight),
          leaf_id: ASSIGNED_CREW_LEAF_ID,
        })),
        ...[DUTY_PERIOD_LEAF_ID, REST_BEFORE_DUTY_LEAF_ID, ROLLING_DUTY_LEAF_ID].map((leaf_id) => ({
          subject_key: personKey('ALPHA-PILOT-02'),
          leaf_id,
        })),
      ].sort((a, b) => a.subject_key.localeCompare(b.subject_key) || a.leaf_id.localeCompare(b.leaf_id)),
    );

    const duty = await latest('person', 'ALPHA-PILOT-02', DUTY_PERIOD_LEAF_ID);
    expect(duty).toMatchObject({ outcome: 'pass', trigger: { kind: 'observation', eventId } });
    expect(duty.evidence[0]!.observationId).not.toBe(longDuty.id);
    expect(await findings('person', 'ALPHA-PILOT-02')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: DUTY_PERIOD_LEAF_ID,
          // The corrected duty period resolves the finding: it closes by itself.
          status: 'resolved',
          closure: expect.objectContaining({ by: 'record' }),
          latestEvaluation: expect.objectContaining({ outcome: 'pass' }),
        }),
      ]),
    );
    for (const flight of ['ALPHA-FLT-1005', 'ALPHA-FLT-1006'])
      expect((await latestByPerson(flight)).get(personKey('ALPHA-PILOT-02')), flight).toMatchObject({
        outcome: 'pass',
        trigger: { eventId },
      });
    expect((await latestByPerson('ALPHA-FLT-1005')).get(personKey('ALPHA-OBSERVER-01'))).toMatchObject({
      outcome: 'attention',
    });
    for (const flight of ['ALPHA-FLT-1001', 'ALPHA-FLT-1003', 'ALPHA-FLT-1004'])
      expect((await evaluations('flight', flight, ASSIGNED_CREW_LEAF_ID)).length, flight).toBe(before.get(flight));
  });

  let control: Extract<ControlWindow['control'], { kind: 'control_record' }>;

  it('opens a hazard from the short-rest finding and accepts a described measure as its control', async () => {
    const [finding] = (await findings('flight', 'ALPHA-FLT-1005')).filter(
      (item) => item.related?.subject.id === 'ALPHA-OBSERVER-01',
    );
    const promotion = await call(who.safety, 'GET', `/v1/sms/findings/${encodeURIComponent(finding!.id)}/promotion`);
    expect(promotion.statusCode, promotion.body).toBe(200);
    const shown = promotion.json() as SmsFindingPromotionResponse;
    expect(shown.origin).toMatchObject({ findingId: finding!.id, related: finding!.related });
    const hazardId = (
      await command(who.safety, {
        kind: 'sms.record.open',
        record: {
          kind: 'hazard',
          schema: 'sms.hazard.1',
          title: 'Observer assigned to an early flight after a short rest',
          ownerId: who.safety.id,
          body: {
            description: `Raised from: ${shown.evaluation.summary}`,
            consequence: 'A tired fictional observer misses traffic near the delivery route.',
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
    const listed = (await detail(hazardId)).controlTypes!.find((type) => type.id === describedMeasureControlType.id)!;
    const measure = {
      measure:
        'Dispatch checks the roster before assigning crew to a flight and does not assign anyone with less than 10 hours of continuous rest in the 24 hours before their duty starts.',
    };
    const controlId = (
      await command(who.safety, {
        kind: 'sms.record.open',
        record: {
          kind: 'control',
          schema: 'sms.control.1',
          title: 'Roster check before crew assignment',
          ownerId: who.safety.id,
          body: {
            hazardId,
            controlType: { id: listed.id, version: listed.version, digest: listed.digest },
            parameters: measure,
            effectiveFrom: shifted('2026-10-05T00:00:00Z'),
          },
        },
      })
    ).subject.id;
    const current = await detail(hazardId);
    await command(
      who.safety,
      decide(hazardId, current.basis, {
        kind: 'risk.assess',
        note: 'Assessed against the short rest shown, with the roster check in place.',
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
        note: 'Residual risk accepted with the roster check in place.',
        assessmentId: assessment.id,
        signature: { intent: signing.intent!, contentDigest: signing.contentDigest!, reviewed: true },
      }),
      { 'x-ledger-reauthentication': grant.json().grant as string },
    );
    const accepted = await detail(hazardId);
    expect(accepted.controls![0]).toMatchObject({ id: controlId, accepted: true });
    // The acceptance records the hazard on file for the organization; project it before reading an indicator.
    await settle();
    control = {
      kind: 'control_record',
      hazardId,
      recordId: controlId,
      versionNumber: 1,
      bodyDigest: accepted.controls![0]!.bodyDigest,
      acceptanceId: accepted.decisions.find((decision) => decision.kind === 'risk.accept')!.id,
    };
  });

  it('opens a control window for the crew and calculates assignments outside limits per 100 duty periods', async () => {
    // The window ends now by the database's clock, which recorded when each finding opened and records the window's
    // evidence cut when it opens; this machine's clock need not match it.
    const period = { start: shifted('2026-10-05T00:00:00Z'), end: await databaseNow(admin) };
    const opened = await call(who.safety, 'POST', '/v1/control-windows', {
      control,
      period,
      subjectKind: 'person',
      subjects: crew.map((person) => subject('person', person)),
      complete: true,
      expectedObservations: [{ type: 'crew.duty-period', versions: [1] }],
      indicators: [{ id: indicator.id, version: 1, digest: indicator.digest }],
      note: 'Every crew member on the roster this fortnight is listed.',
    });
    expect(opened.statusCode, opened.body).toBe(201);
    const window = opened.json().window as ControlWindow;
    const response = await call(
      who.safety,
      'GET',
      `/v1/control-windows/${window.id}/indicators/${encodeURIComponent(indicator.id)}/versions/1`,
    );
    expect(response.statusCode, response.body).toBe(200);
    const calculated = response.json() as ControlWindowIndicatorResponse;
    // Three assignments outside a limit over thirty duty periods. The corrected finding stays open, so it counts.
    expect(calculated).toMatchObject({ windowId: window.id, selection: 'complete' });
    expect(calculated.result).toMatchObject({
      status: 'supported',
      definition: { id: indicator.id, version: 1, digest: indicator.digest },
      control: { id: control.recordId, version: 1 },
      eventCount: 3,
      exposure: { value: { numerator: '30', denominator: '1' }, unit: 'duty_period', gaps: [] },
      rate: { value: { numerator: '10', denominator: '1' }, decimal: '10.00', label: 'per 100 duty periods' },
      population: { subjectCount: 3, complete: true },
      reasons: [],
    });
  });
});
