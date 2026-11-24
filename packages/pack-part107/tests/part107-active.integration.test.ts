import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../apps/api/src/index.js';
import { adoptShownPack } from '../../contracts/fixtures/demo/v1/ready.js';
import type {
  OrganizationCoverageResponse,
  PackAdoptionCommand,
  RuleEvaluationRecord,
} from '../../contracts/src/index.js';
import { getRulePackVersion } from '../../domain/src/rule-pack-registry.js';
import { sha256 } from '../../integrity/src/index.js';
import { createPool, MemoryObjectStore, type AuthContext } from '../../persistence/src/index.js';
import { PART107_PACK_ID } from '../src/index.js';
import { checkedEntries } from '../src/part107-v1.js';
import { runOwnedWork, settleOwnedWork } from '../../../tests/integration/worker-queue.js';

// Version 1 of the Part 107 pack, adopted in active mode by a fictional organization that imports sample records
// through the public API. The worker's generic evaluator runs every automated rule; each evaluation cites what it
// read. The same adoption revised to shadow stamps later evaluations as shadow.
describe.runIf(process.env.LEDGER_ENV !== 'staging')('Part 107 checks in active mode on sample records', () => {
  const prefix = `part107-${randomUUID()}`;
  const tenantId = `${prefix}:operator`;
  const sourceId = 'operator-records';
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const workerPool = createPool(process.env.WORKER_DATABASE_URL);
  const pack = getRulePackVersion(PART107_PACK_ID, 1)!;
  const subjects = { flight: `${prefix}-FLT-1`, pilot: `${prefix}-PER-1`, aircraft: `${prefix}-AC-1` };
  const base = { tenantId, revision: 1, kind: 'human', name: 'Fictional Part 107 operator' };
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
  let activeId: string;

  /** A UTC time this many hours before the test started, in the form record files use. */
  const started = Date.now();
  const hoursAgo = (hours: number) => new Date(started - hours * 3_600_000).toISOString().slice(0, 19) + 'Z';
  const interval = {
    start: new Date(started - 60_000).toISOString(),
    end: new Date(started + 3_600_000).toISOString(),
  };

  function call(principal: AuthContext, method: 'GET' | 'POST', url: string, payload?: unknown) {
    return app.inject({
      method,
      url,
      headers: { authorization: `Bearer ledger-dev-${principal.id}`, 'idempotency-key': randomUUID() },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  }

  async function draft(mode: PackAdoptionCommand['mode'], extra: Partial<PackAdoptionCommand> = {}) {
    const shown = await call(actor, 'GET', '/v1/organization/coverage');
    expect(shown.statusCode, shown.body).toBe(200);
    const command = adoptShownPack(
      shown.json() as OrganizationCoverageResponse,
      pack,
      interval,
      'Fictional review of the Part 107 checks.',
      mode,
    );
    return { ...command, ...extra };
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
    recorded.set(recordType, [
      ...(recorded.get(recordType) ?? []),
      ...committed.json().rows.map((row: { observationId: string }) => row.observationId),
    ]);
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
    const query = new URLSearchParams({ subjectKind: kind, subjectId, subjectScope: 'source', sourceId, limit: '100' });
    const response = await call(actor, 'GET', `/v1/evaluations?${query}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json().evaluations;
  }

  beforeAll(async () => {
    app = await createApp({ pool, env: 'test', objectStore: new MemoryObjectStore() });
    await app.ready();
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, 'Fictional Part 107 operator']);
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
      observationGrants: [{ sourceId, observationType: 'operator.record' }],
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

  it('is adopted in active mode', async () => {
    const adopted = await call(actor, 'POST', '/v1/commands', await draft('active'));
    expect(adopted.statusCode, adopted.body).toBe(201);
    activeId = adopted.json().command.id as string;
    await settle();
  });

  it('runs every automated rule on the imported records, each citing the record it read', async () => {
    const { flight, pilot, aircraft } = subjects;
    await importRecords('flight.plan', [
      {
        subjectId: flight,
        windowStartsAt: hoursAgo(3),
        windowEndsAt: hoursAgo(2),
        operationKind: 'inspection',
        plannedOriginDescription: 'East pad',
        plannedDestinationDescription: 'East pad',
        routeSummary: 'Roof inspection of the fictional depot',
        visualMode: 'visual_line_of_sight',
        plannedMaxHeightAboveGroundMeters: 60,
        plannedMaxGroundSpeedMetersPerSecond: 10,
      },
    ]);
    await importRecords('operation.role-assignment', [
      {
        subjectId: flight,
        subjectKind: 'flight',
        personId: pilot,
        role: 'pilot_in_command',
        startsAt: hoursAgo(3.5),
        endsAt: hoursAgo(1.5),
      },
    ]);
    await importRecords('flight.preflight-assessment', [
      {
        subjectId: flight,
        assessedAt: hoursAgo(4),
        weatherDetermination: 'Wind 3 m/s, no precipitation',
        airspaceDetermination: 'Class G, no flight restrictions',
        groundHazardsDetermination: 'Loading bay closed during the flight',
        participantsBriefing: 'Observer briefed on roles, contingencies and hazards',
        linkEnergyLoadDetermination: 'Link checked, batteries full, camera secured',
        visibilityMeters: 9000,
        cloudVerticalClearanceMeters: 600,
        cloudHorizontalClearanceMeters: 3000,
      },
    ]);
    await importRecords('aircraft.payload', [
      { subjectId: flight, subjectKind: 'flight', hazardousMaterial: 'not_hazardous', payloadDescription: 'Camera' },
    ]);
    await importRecords('occurrence.accident', [
      {
        subjectId: flight,
        subjectKind: 'flight',
        occurredAt: hoursAgo(2.2),
        accidentKind: 'serious_injury',
        summary: 'Fictional fall from a ladder near the pad',
        reportedToAuthorityAt: hoursAgo(1),
      },
    ]);
    await importRecords('person.certificate', [
      {
        subjectId: pilot,
        credentialKind: 'remote_pilot_certificate',
        credentialNumber: 'RP-0000001',
        recordedStatus: 'held',
      },
    ]);
    await importRecords('person.training', [
      {
        subjectId: pilot,
        trainingKind: 'recurrent',
        courseTitle: 'Recurrent small UAS course',
        completedOn: new Date(started - 40 * 86_400_000).toISOString().slice(0, 10),
        program: 'remote_pilot_certificate',
        evidenceReference: 'CERT-0107',
      },
    ]);
    await importRecords('person.readiness-declaration', [
      {
        subjectId: pilot,
        declaredAt: hoursAgo(5),
        medicalStatement: 'no_known_condition',
        substanceStatement: 'no_known_disqualification',
      },
    ]);
    await importRecords('aircraft.identity', [
      {
        subjectId: aircraft,
        aircraftMakeModel: 'Fictional Quad 4',
        serialNumber: 'SN-0107',
        registrationNumber: 'FA0000107',
      },
    ]);
    await importRecords('aircraft.condition', [
      { subjectId: aircraft, determinedAt: hoursAgo(4), recordedCondition: 'no_unsafe_condition_known' },
    ]);
    await settle();

    const subjectOf: Record<string, [string, string]> = {
      flight: ['flight', flight],
      person: ['person', pilot],
      aircraft: ['aircraft', aircraft],
    };
    const cited: Record<string, string[]> = {
      'ledger.part107.107.12.b': ['person.certificate'],
      'ledger.part107.107.65': ['person.training'],
      'ledger.part107.107.19.a': ['flight.plan', 'operation.role-assignment'],
      'ledger.part107.107.13': ['aircraft.identity'],
      'ledger.part107.107.15.a': ['aircraft.condition'],
      'ledger.part107.107.17': ['person.readiness-declaration'],
      'ledger.part107.107.27': ['person.readiness-declaration'],
      'ledger.part107.107.31.a': ['flight.plan'],
      'ledger.part107.107.36': ['aircraft.payload'],
      'ledger.part107.107.49.a': ['flight.preflight-assessment'],
      'ledger.part107.107.49.b': ['flight.preflight-assessment'],
      'ledger.part107.107.49.c-e': ['flight.preflight-assessment'],
      'ledger.part107.107.51.a': ['flight.plan'],
      'ledger.part107.107.51.b': ['flight.plan'],
      'ledger.part107.107.51.c': ['flight.preflight-assessment'],
      'ledger.part107.107.51.d.1': ['flight.preflight-assessment'],
      'ledger.part107.107.51.d.2': ['flight.preflight-assessment'],
      'ledger.part107.107.9.a': ['occurrence.accident'],
    };
    expect(Object.keys(cited).sort()).toEqual(checkedEntries.map(({ id }) => id).sort());

    for (const entry of checkedEntries) {
      const [kind, subjectId] = subjectOf[entry.check.target.subjectKind]!;
      const latest = (await evaluations(kind, subjectId)).find((evaluation) => evaluation.rule.id === entry.id);
      expect(latest, entry.id).toBeDefined();
      expect(latest, entry.id).toMatchObject({
        adoption: { id: activeId, mode: 'active' },
        pack: { id: PART107_PACK_ID, version: 1, digest: pack.digest },
        rule: { source: { kind: 'regulation' } },
        evidenceState: 'supported',
        outcome: 'pass',
      });
      const evidence = latest!.evidence.map((item) => item.observationId);
      for (const recordType of cited[entry.id]!)
        expect(
          evidence.some((id) => recorded.get(recordType)!.includes(id)),
          `${entry.id} cites a ${recordType} record`,
        ).toBe(true);
    }
  });

  it('stamps evaluations as shadow once the adoption is revised to shadow', async () => {
    const revised = await call(actor, 'POST', '/v1/commands', await draft('shadow', { revises: activeId }));
    expect(revised.statusCode, revised.body).toBe(201);
    const shadowId = revised.json().command.id as string;
    await settle();
    await importRecords('aircraft.condition', [
      { subjectId: subjects.aircraft, determinedAt: hoursAgo(0.5), recordedCondition: 'unsafe_condition_known' },
    ]);
    await settle();
    const [latest] = (await evaluations('aircraft', subjects.aircraft)).filter(
      (evaluation) => evaluation.rule.id === 'ledger.part107.107.15.a',
    );
    expect(latest).toMatchObject({
      adoption: { id: shadowId, mode: 'shadow' },
      pack: { id: PART107_PACK_ID, version: 1, digest: pack.digest },
      outcome: 'attention',
    });
    expect(latest!.evidence.map((item) => item.observationId)).toContain(recorded.get('aircraft.condition')!.at(-1));
  });
});
