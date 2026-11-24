import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../apps/api/src/index.js';
import { adoptShownPack } from '../../contracts/fixtures/demo/v1/ready.js';
import type { OrganizationCoverageResponse, RuleEvaluationRecord } from '../../contracts/src/index.js';
import { getRulePackVersion } from '../../domain/src/rule-pack-registry.js';
import { sha256 } from '../../integrity/src/index.js';
import { createPool, MemoryObjectStore, type AuthContext } from '../../persistence/src/index.js';
import { PART108_NPRM_PACK_ID } from '../src/index.js';
import { checkedEntries } from '../src/part108-nprm-v2.js';
import { runOwnedWork, settleOwnedWork } from '../../../tests/integration/worker-queue.js';

// Version 2 of the Part 108 NPRM pack, adopted in shadow by a fictional organization that imports sample records
// through the public API. The worker's generic evaluator runs every automated rule; each evaluation cites what it read.
describe.runIf(process.env.LEDGER_ENV !== 'staging')('Part 108 NPRM checks in shadow on sample records', () => {
  const prefix = `part108-nprm-${randomUUID()}`;
  const tenantId = `${prefix}:operator`;
  const sourceId = 'operator-records';
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const workerPool = createPool(process.env.WORKER_DATABASE_URL);
  const pack = getRulePackVersion(PART108_NPRM_PACK_ID, 2)!;
  const subjects = {
    flight: `${prefix}-FLT-1`,
    coordinator: `${prefix}-PER-1`,
    separated: `${prefix}-PER-2`,
    relief: `${prefix}-PER-3`,
    aircraft: `${prefix}-AC-1`,
    organization: `${prefix}-ORG-1`,
  };
  const base = { tenantId, revision: 1, kind: 'human', name: 'Fictional Part 108 operator' };
  const actor: AuthContext = {
    ...base,
    id: `${tenantId}:actor`,
    capabilities: ['flight:read', 'evidence:read', 'authority:write', 'pack:adopt'],
  };
  const operator: AuthContext = {
    ...base,
    id: `${tenantId}:records`,
    capabilities: ['input:write', 'flight:read', 'evidence:read'],
  };
  /** Ledger's id of each imported record, by record type. */
  const recorded = new Map<string, string[]>();
  let app: Awaited<ReturnType<typeof createApp>>;

  /** A UTC time this many hours before the test started, in the form record files use. */
  const started = Date.now();
  const hoursAgo = (hours: number) => new Date(started - hours * 3_600_000).toISOString().slice(0, 19) + 'Z';
  const reference = (id: string) => ({ id, scope: 'source' });

  function call(principal: AuthContext, method: 'GET' | 'POST', url: string, payload?: unknown) {
    return app.inject({
      method,
      url,
      headers: { authorization: `Bearer ledger-dev-${principal.id}`, 'idempotency-key': randomUUID() },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  }

  async function upload(bytes: Buffer): Promise<string> {
    const created = await call(operator, 'POST', '/v1/uploads', {
      contentType: 'application/json',
      byteLength: bytes.byteLength,
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().upload.id as string;
    const stored = await app.inject({
      method: 'PUT',
      url: `/v1/uploads/${id}/content`,
      headers: {
        authorization: `Bearer ledger-dev-${operator.id}`,
        'idempotency-key': randomUUID(),
        'content-type': 'application/octet-stream',
      },
      payload: bytes,
    });
    expect(stored.statusCode, stored.body).toBe(200);
    const finalized = await call(operator, 'POST', `/v1/uploads/${id}/finalize`);
    expect(finalized.statusCode, finalized.body).toBe(201);
    return finalized.json().artifact.id as string;
  }

  /** Imports one JSON file of one record type and keeps the Ledger id of each record. */
  async function importRecords(recordType: string, records: Record<string, unknown>[]) {
    const artifactId = await upload(Buffer.from(JSON.stringify({ recordType, recordVersion: 1, records })));
    const committed = await call(operator, 'POST', '/v1/operator-records/imports', {
      artifactId,
      recordType,
      recordVersion: 1,
    });
    expect(committed.statusCode, committed.body).toBe(201);
    expect(committed.json().summary, recordType).toMatchObject({ recorded: records.length, incomplete: 0, refused: 0 });
    recorded.set(
      recordType,
      committed.json().rows.map((row: { observationId: string }) => row.observationId),
    );
  }

  async function submitDutyPeriod(period: 'duty' | 'rest', start: string, end: string) {
    const artifactId = await upload(Buffer.from(JSON.stringify({ schedule: 'Fictional roster', period, start, end })));
    const observation = {
      type: 'crew.duty-period',
      version: 1,
      subject: { kind: 'person', id: subjects.coordinator, scope: 'source' },
      occurredAt: start,
      interval: { start, end },
      fidelity: 'documented_schema_conformant',
      limitations: [],
      originalArtifactId: artifactId,
      values: { period },
    };
    const response = await call(operator, 'POST', '/v1/inputs', {
      sourceId,
      kind: 'observation',
      occurredAt: start,
      payload: observation,
    });
    expect(response.statusCode, response.body).toBe(201);
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

  async function evaluations(kind: string, subjectId: string): Promise<RuleEvaluationRecord[]> {
    // A record about the organization is about the Ledger organization itself, whatever id the file gave.
    const query =
      kind === 'organization'
        ? new URLSearchParams({ subjectKind: kind, subjectId: `organization:${tenantId}`, limit: '100' })
        : new URLSearchParams({ subjectKind: kind, subjectId, subjectScope: 'source', sourceId, limit: '100' });
    const response = await call(actor, 'GET', `/v1/evaluations?${query}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json().evaluations;
  }

  beforeAll(async () => {
    app = await createApp({ pool, env: 'test', objectStore: new MemoryObjectStore() });
    await app.ready();
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, 'Fictional Part 108 operator']);
    // The worker leases this tenant's work as its worker principal.
    const worker = {
      ...base,
      id: `${tenantId}:worker`,
      kind: 'worker',
      capabilities: ['flight:read', 'evidence:read', 'input:write'],
    };
    for (const principal of [actor, operator, worker]) {
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
    const current = await call(actor, 'GET', `/v1/authority/principals/${encodeURIComponent(operator.id)}`);
    expect(current.statusCode, current.body).toBe(200);
    const granted = await call(actor, 'POST', '/v1/commands', {
      kind: 'authority.update',
      principalId: operator.id,
      expectedRevision: current.json().principal.revision,
      capabilities: current.json().principal.capabilities,
      observationGrants: [
        { sourceId, observationType: 'operator.record' },
        { sourceId, observationType: 'crew.duty-period' },
      ],
    });
    expect(granted.statusCode, granted.body).toBe(201);
  });
  afterAll(async () => {
    await settleOwnedWork([prefix]);
    if (app) await app.close();
    await pool.end();
    await admin.end();
    await workerPool.end();
  });

  it('is refused as an active adoption and adopted in shadow', async () => {
    const shown = await call(actor, 'GET', '/v1/organization/coverage');
    expect(shown.statusCode, shown.body).toBe(200);
    const interval = {
      start: new Date(started - 60_000).toISOString(),
      end: new Date(started + 3_600_000).toISOString(),
    };
    const draft = (mode: 'active' | 'shadow') =>
      adoptShownPack(
        shown.json() as OrganizationCoverageResponse,
        pack,
        interval,
        'Fictional review of the proposed Part 108 checks.',
        mode,
      );
    const refused = await call(actor, 'POST', '/v1/commands', draft('active'));
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.json().error.code).toBe('adoption_mode_refused');
    const adopted = await call(actor, 'POST', '/v1/commands', draft('shadow'));
    expect(adopted.statusCode, adopted.body).toBe(201);
    await settle();
  });

  it('runs every automated rule on the imported records, each citing the record it read', async () => {
    const { flight, coordinator, separated, relief, aircraft, organization } = subjects;
    await importRecords('flight.plan', [
      {
        subjectId: flight,
        windowStartsAt: hoursAgo(3),
        windowEndsAt: hoursAgo(2),
        operationKind: 'aerial_survey',
        plannedOriginDescription: 'North pad',
        plannedDestinationDescription: 'North pad',
        routeSummary: 'Survey grid over the fictional quarry',
      },
    ]);
    await importRecords('flight.record', [
      {
        subjectId: flight,
        takeoffAt: hoursAgo(2.8),
        landingAt: hoursAgo(2.3),
        takeoffLocation: 'North pad',
        landingLocations: 'North pad',
        maxHeightFlownAboveGroundMeters: 90,
        flightPathReference: 'PATH-0001',
      },
    ]);
    await importRecords('flight.preflight-assessment', [
      {
        subjectId: flight,
        assessedAt: hoursAgo(4),
        weatherDetermination: 'Wind 4 m/s, no precipitation',
        airspaceDetermination: 'No restrictions on the route',
        groundHazardsDetermination: 'Mast at the north edge, avoided',
        participantsBriefing: 'Crew briefed at the pad',
        linkEnergyLoadDetermination: 'Link checked, batteries full, no payload',
      },
    ]);
    await importRecords('operation.multiple-aircraft', [
      {
        subjectId: flight,
        subjectKind: 'flight',
        simultaneousAircraftCount: 1,
        manufacturerLimitCount: 2,
        methodLimitCount: 1,
        methodReference: 'Operations manual 5.2',
      },
    ]);
    await importRecords('organization.coordinator-requirement', [
      { subjectId: flight, subjectKind: 'flight', coordinatorRequired: true, basis: 'manufacturer_instructions' },
    ]);
    await importRecords('operation.role-assignment', [
      {
        subjectId: organization,
        subjectKind: 'organization',
        personId: coordinator,
        role: 'operations_supervisor',
        startsAt: hoursAgo(1000),
      },
      {
        subjectId: flight,
        subjectKind: 'flight',
        personId: coordinator,
        role: 'flight_coordinator',
        startsAt: hoursAgo(3.5),
        endsAt: hoursAgo(2.5),
      },
      {
        subjectId: flight,
        subjectKind: 'flight',
        personId: relief,
        role: 'flight_coordinator',
        startsAt: hoursAgo(2.6),
        endsAt: hoursAgo(1.5),
        handoverFromPersonId: coordinator,
        handoverProcedureReference: 'Operations manual 4.7',
      },
    ]);
    await importRecords('person.standing', [
      {
        subjectId: coordinator,
        fullName: 'Fictional Coordinator One',
        qualificationSummary: 'Coordinator course and supervised hours',
        duties: 'Flight coordinator',
      },
    ]);
    await importRecords('person.employment', [
      {
        subjectId: separated,
        employmentStatus: 'separated',
        functionStartedOn: '2024-01-02',
        separatedOn: '2026-05-01',
        separationForCause: 'yes',
        separationDetails: 'Recorded in personnel file 12.',
      },
    ]);
    await importRecords('person.training', [
      {
        subjectId: coordinator,
        trainingKind: 'recurrent',
        courseTitle: 'Recurrent coordinator course',
        completedOn: '2026-09-01',
        evidenceReference: 'CERT-0042',
        materialsReference: 'Course book revision 3',
        providerName: 'Fictional Training Provider',
        providerAddress: '1 Example Road, Exampletown',
      },
    ]);
    await importRecords('person.rest-assessment', [
      {
        subjectId: coordinator,
        assessedAt: hoursAgo(5),
        dutyPeriodId: reference('DUTY-1'),
        restPeriodId: reference('REST-1'),
        weeklyRestPeriodId: reference('REST-0'),
        calendarDayDutyHours: 12,
        weekStartsAt: hoursAgo(72),
        weekDutyHours: 36,
        timeZone: 'America/Denver',
        scheduleReference: 'Roster week 42',
      },
    ]);
    await submitDutyPeriod('rest', hoursAgo(30), hoursAgo(19));
    await submitDutyPeriod('duty', hoursAgo(18), hoursAgo(6));
    await importRecords('aircraft.condition', [
      { subjectId: aircraft, determinedAt: hoursAgo(4), recordedCondition: 'no_unsafe_condition_known' },
    ]);
    await importRecords('occurrence.mechanical-irregularity', [
      {
        subjectId: aircraft,
        subjectKind: 'aircraft',
        occurredAt: hoursAgo(50),
        irregularityDescription: 'Gimbal drift after takeoff',
        correctiveAction: 'Gimbal recalibrated and logged',
      },
    ]);
    await importRecords('maintenance.action', [
      {
        subjectId: aircraft,
        subjectKind: 'aircraft',
        actionDescription: 'Replaced gimbal motor',
        performedAt: hoursAgo(48),
        performedByName: 'Fictional Technician',
        returnedToService: true,
        returnToServiceByName: 'Fictional Inspector',
        returnToServiceBasis: 'Post-maintenance check card 3',
      },
    ]);
    await settle();

    const subjectOf: Record<string, [string, string]> = {
      flight: ['flight', flight],
      person: ['person', coordinator],
      aircraft: ['aircraft', aircraft],
      organization: ['organization', organization],
    };
    const cited: Record<string, string[]> = {
      'ledger.nprm.108.40.a.3.iv': ['flight.record'],
      'ledger.nprm.108.40.b.1-3': ['person.standing'],
      'ledger.nprm.108.40.b.4': ['person.employment'],
      'ledger.nprm.108.40.b.5': ['person.rest-assessment'],
      'ledger.nprm.108.40.c': ['occurrence.mechanical-irregularity'],
      'ledger.nprm.108.40.d.1': ['maintenance.action'],
      'ledger.nprm.108.40.e.1': ['person.training'],
      'ledger.nprm.108.120.a': ['aircraft.condition'],
      'ledger.nprm.108.170.a': ['flight.preflight-assessment'],
      'ledger.nprm.108.170.b': ['flight.preflight-assessment'],
      'ledger.nprm.108.170.d': ['flight.preflight-assessment'],
      'ledger.nprm.108.170.h': ['flight.preflight-assessment'],
      'ledger.nprm.108.210.b': ['operation.multiple-aircraft'],
      'ledger.nprm.108.210.c': ['operation.multiple-aircraft'],
      'ledger.nprm.108.305.a': ['operation.role-assignment'],
      'ledger.nprm.108.310.a': ['flight.plan', 'operation.role-assignment'],
      'ledger.nprm.108.310.c': ['operation.role-assignment'],
      'ledger.nprm.108.330.a.duty-week': ['person.rest-assessment'],
      'ledger.nprm.108.630.a': ['maintenance.action'],
    };
    const dutyRules = ['ledger.nprm.108.330.a.duty-period', 'ledger.nprm.108.330.b'];
    expect([...Object.keys(cited), ...dutyRules].sort()).toEqual(checkedEntries.map(({ id }) => id).sort());

    for (const entry of checkedEntries) {
      const [kind, subjectId] =
        entry.id === 'ledger.nprm.108.40.b.4' ? ['person', separated] : subjectOf[entry.check.target.subjectKind]!;
      const latest = (await evaluations(kind, subjectId)).find((evaluation) => evaluation.rule.id === entry.id);
      expect(latest, entry.id).toBeDefined();
      expect(latest, entry.id).toMatchObject({
        adoption: { mode: 'shadow' },
        pack: { id: PART108_NPRM_PACK_ID, version: 2, digest: pack.digest },
        rule: { source: { kind: 'proposed_regulation' } },
        evidenceState: 'supported',
        outcome: 'pass',
      });
      const evidence = latest!.evidence.map((item) => item.observationId);
      if (dutyRules.includes(entry.id)) {
        expect(latest!.evidence.length, entry.id).toBeGreaterThan(0);
        expect(new Set(latest!.evidence.map((item) => item.type)), entry.id).toEqual(new Set(['crew.duty-period']));
        continue;
      }
      for (const recordType of cited[entry.id]!)
        expect(
          evidence.some((id) => recorded.get(recordType)!.includes(id)),
          `${entry.id} cites a ${recordType} record`,
        ).toBe(true);
    }
  });
});
