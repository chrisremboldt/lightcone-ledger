import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../apps/api/src/index.js';
import { adoptShownPack } from '../../contracts/fixtures/demo/v1/ready.js';
import type {
  OrganizationCoverageResponse,
  PackAdoptionCommand,
  RuleEvaluationRecord,
  RulePackVersion,
} from '../../contracts/src/index.js';
import { getRulePackVersion } from '../../domain/src/rule-pack-registry.js';
import { sha256 } from '../../integrity/src/index.js';
import { createPool, MemoryObjectStore, type AuthContext } from '../../persistence/src/index.js';
import { PART107_PACK_ID } from '../../pack-part107/src/index.js';
import { EXAMPLE_WAIVER_PACK_ID, exampleWaiverRulePack } from '../src/index.js';
import { runOwnedWork, settleOwnedWork } from '../../../tests/integration/worker-queue.js';

// The fictional Alpha Dispatch adopts the Part 107 pack and the example waiver in active mode, then imports sample
// records through the public API. The worker's generic evaluator runs each checked provision; each evaluation quotes
// the provision it comes from and cites the record it read.
describe.runIf(process.env.LEDGER_ENV !== 'staging')('Example waiver in active mode beside Part 107', () => {
  const prefix = `waiver-${randomUUID()}`;
  const tenantId = `${prefix}:operator`;
  const sourceId = 'operator-records';
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const workerPool = createPool(process.env.WORKER_DATABASE_URL);
  const part107 = getRulePackVersion(PART107_PACK_ID, 1)!;
  const waiver = getRulePackVersion(EXAMPLE_WAIVER_PACK_ID, 1)!;
  // The pilot's subject id is the source identifier the waiver lists; the tenant is new for each run.
  const subjects = { flight: `${prefix}-FLT-1`, pilot: 'PER-0202', aircraft: `${prefix}-AC-1` };
  const base = { tenantId, revision: 1, kind: 'human', name: 'Alpha Dispatch' };
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
  const adoptions = new Map<string, string>();

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

  async function draft(pack: RulePackVersion, mode: PackAdoptionCommand['mode']) {
    const shown = await call(actor, 'GET', '/v1/organization/coverage');
    expect(shown.statusCode, shown.body).toBe(200);
    return adoptShownPack(
      shown.json() as OrganizationCoverageResponse,
      pack,
      interval,
      `Fictional review of ${pack.title}.`,
      mode,
    );
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
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, 'Alpha Dispatch']);
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

  it('is adopted in active mode beside the Part 107 pack', async () => {
    for (const pack of [part107, waiver]) {
      const adopted = await call(actor, 'POST', '/v1/commands', await draft(pack, 'active'));
      expect(adopted.statusCode, adopted.body).toBe(201);
      adoptions.set(pack.packId, adopted.json().command.id as string);
      await settle();
    }
  });

  it('evaluates each checked provision on the imported records, quoting the provision and citing the record', async () => {
    const { flight, pilot, aircraft } = subjects;
    const crew = (personId: string, role: string) => ({
      subjectId: flight,
      subjectKind: 'flight',
      personId,
      role,
      startsAt: hoursAgo(3.5),
      endsAt: hoursAgo(1.5),
    });
    await importRecords('flight.plan', [
      {
        subjectId: flight,
        secondarySubjectId: aircraft,
        windowStartsAt: hoursAgo(3),
        windowEndsAt: hoursAgo(2),
        operationKind: 'package_delivery',
        plannedOriginDescription: 'Canal District depot',
        plannedDestinationDescription: 'Canal District pier',
        routeSummary: 'Night parcel delivery along the canal',
        visualMode: 'visual_line_of_sight',
        pilotInOperatingArea: 'yes',
        plannedMaxHeightAboveGroundMeters: 80,
        plannedMaxGroundSpeedMetersPerSecond: 10,
        plannedMaxDistanceFromControlStationMeters: 1200,
      },
    ]);
    await importRecords('operation.role-assignment', [
      crew(pilot, 'pilot_in_command'),
      crew('PER-0201', 'visual_observer'),
    ]);
    await importRecords('flight.preflight-assessment', [
      {
        subjectId: flight,
        assessedAt: hoursAgo(4),
        weatherDetermination: 'Wind 3 m/s, no precipitation',
        airspaceDetermination: 'Class G, no flight restrictions',
        groundHazardsDetermination: 'Pier closed to the public during the flight',
        participantsBriefing: 'Pilot and observer briefed on the night route and lighting',
        linkEnergyLoadDetermination: 'Link checked, batteries full, parcel secured',
      },
    ]);
    await importRecords('operation.notification', [
      {
        subjectId: flight,
        subjectKind: 'flight',
        notifiedAt: hoursAgo(28),
        recipient: 'Canal District harbor office',
        means: 'telephone',
      },
    ]);
    await importRecords('aircraft.payload', [
      { subjectId: flight, subjectKind: 'flight', hazardousMaterial: 'not_hazardous', payloadDescription: 'Parcel' },
    ]);
    await importRecords('person.training', [
      {
        subjectId: pilot,
        trainingKind: 'role_specific',
        courseTitle: 'Night delivery operations',
        completedOn: new Date(started - 40 * 86_400_000).toISOString().slice(0, 10),
        evidenceReference: 'NDO-0202',
      },
    ]);
    await importRecords('aircraft.identity', [
      {
        subjectId: aircraft,
        aircraftMakeModel: 'Fictional Quad 4',
        serialNumber: 'SN-0101',
        registrationNumber: 'FICT-0101',
        remoteIdentificationMethod: 'standard_broadcast',
      },
    ]);
    await settle();

    const subjectOf: Record<string, [string, string]> = {
      flight: ['flight', flight],
      person: ['person', pilot],
      aircraft: ['aircraft', aircraft],
    };
    const cited: Record<string, string[]> = {
      '1': ['operation.role-assignment'],
      '2': ['aircraft.identity'],
      '4': ['flight.plan'],
      '5': ['flight.plan'],
      '6': ['flight.plan'],
      '7': ['flight.plan', 'operation.role-assignment'],
      '8': ['flight.plan', 'operation.notification'],
      '9': ['aircraft.payload'],
      '10': ['person.training'],
      '11': ['aircraft.identity'],
      '12': ['flight.preflight-assessment'],
    };
    const checked = exampleWaiverRulePack().provisions.filter((provision) => provision.ruleId);
    expect(checked.map(({ number }) => number)).toEqual(Object.keys(cited));

    for (const provision of checked) {
      const leaf = waiver.leaves.find(({ id }) => id === provision.ruleId)!;
      if (!('target' in leaf)) throw new Error(`${leaf.id} is not a checked rule`);
      const [kind, subjectId] = subjectOf[leaf.target.subjectKind]!;
      const latest = (await evaluations(kind, subjectId)).find((evaluation) => evaluation.rule.id === leaf.id);
      expect(latest, leaf.id).toBeDefined();
      expect(latest, leaf.id).toMatchObject({
        adoption: { id: adoptions.get(EXAMPLE_WAIVER_PACK_ID), mode: 'active' },
        pack: { id: EXAMPLE_WAIVER_PACK_ID, version: 1, digest: waiver.digest },
        rule: {
          source: {
            kind: 'waiver_or_exemption',
            reference: expect.stringContaining(`special provision ${provision.number}: ${provision.title}`),
            text: leaf.source.text,
          },
        },
        evidenceState: 'supported',
        outcome: 'pass',
      });
      const evidence = latest!.evidence.map((item) => item.observationId);
      for (const recordType of cited[provision.number]!)
        expect(
          evidence.some((id) => recorded.get(recordType)!.includes(id)),
          `${leaf.id} cites a ${recordType} record`,
        ).toBe(true);
    }

    // The Part 107 adoption evaluates the same records alongside.
    const height = (await evaluations('flight', flight)).find(
      (evaluation) => evaluation.rule.id === 'ledger.part107.107.51.b',
    );
    expect(height).toMatchObject({
      adoption: { id: adoptions.get(PART107_PACK_ID), mode: 'active' },
      pack: { id: PART107_PACK_ID, digest: part107.digest },
      outcome: 'pass',
    });
  });
});
