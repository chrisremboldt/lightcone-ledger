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
import { newlyCheckedEntries } from '../src/part107-v2.js';
import { runOwnedWork, settleOwnedWork } from '../../../tests/integration/worker-queue.js';

// Version 2 of the Part 107 pack, adopted in active mode by a fictional organization. The rules version 2 adds fan
// out over the people a flight's role assignments name, or compare two recorded times; each evaluation cites what it
// read, including the records about the person it was evaluated for.
describe.runIf(process.env.LEDGER_ENV !== 'staging')('Part 107 version 2 in active mode on sample records', () => {
  const prefix = `part107-v2-${randomUUID()}`;
  const tenantId = `${prefix}:operator`;
  const sourceId = 'operator-records';
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const workerPool = createPool(process.env.WORKER_DATABASE_URL);
  const pack = getRulePackVersion(PART107_PACK_ID, 2)!;
  const subjects = { flight: `${prefix}-FLT-1`, pilot: `${prefix}-PER-1`, relief: `${prefix}-PER-2` };
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
    return { ...command, parameters: { 'ledger.part107.107.9.timing': { timeZone: 'UTC' } }, ...extra };
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

  it('is adopted in active mode with the time zone the organization counts days in', async () => {
    const unset = await call(actor, 'POST', '/v1/commands', await draft('active', { parameters: undefined }));
    expect(unset.statusCode, unset.body).toBe(400);
    const adopted = await call(actor, 'POST', '/v1/commands', await draft('active'));
    expect(adopted.statusCode, adopted.body).toBe(201);
    activeId = adopted.json().command.id as string;
    await settle();
  });

  it('runs each rule version 2 adds, each citing the records it read', async () => {
    const { flight, pilot, relief } = subjects;
    await importRecords('flight.plan', [
      {
        subjectId: flight,
        windowStartsAt: hoursAgo(3),
        windowEndsAt: hoursAgo(2),
        operationKind: 'inspection',
        plannedOriginDescription: 'East pad',
        plannedDestinationDescription: 'East pad',
        routeSummary: 'Roof inspection of the fictional depot',
      },
    ]);
    // Two people are remote pilot in command in turn; each gets a result for the flight.
    await importRecords('operation.role-assignment', [
      {
        subjectId: flight,
        subjectKind: 'flight',
        personId: pilot,
        role: 'pilot_in_command',
        startsAt: hoursAgo(3.5),
        endsAt: hoursAgo(2.5),
      },
      {
        subjectId: flight,
        subjectKind: 'flight',
        personId: relief,
        role: 'pilot_in_command',
        startsAt: hoursAgo(2.5),
        endsAt: hoursAgo(1.5),
        handoverFromPersonId: pilot,
      },
    ]);
    await importRecords('person.certificate', [
      {
        subjectId: pilot,
        credentialKind: 'remote_pilot_certificate',
        credentialNumber: 'RP-0000001',
        recordedStatus: 'held',
      },
      {
        subjectId: relief,
        credentialKind: 'remote_pilot_certificate',
        credentialNumber: 'RP-0000002',
        recordedStatus: 'suspended',
      },
    ]);
    // A past accident, so the count does not depend on when the test runs.
    await importRecords('occurrence.accident', [
      {
        subjectId: flight,
        subjectKind: 'flight',
        occurredAt: '2026-03-07T15:00:00Z',
        accidentKind: 'serious_injury',
        summary: 'Fictional fall from a ladder near the pad',
        reportedToAuthorityAt: '2026-03-16T09:00:00Z',
      },
    ]);
    await settle();

    const flightEvaluations = await evaluations('flight', flight);
    const latest = (id: string, personId?: string) =>
      flightEvaluations.find(
        (evaluation) =>
          evaluation.rule.id === id && (personId ? evaluation.related?.subject.id === personId : !evaluation.related),
      );
    const common = {
      adoption: { id: activeId, mode: 'active' },
      pack: { id: PART107_PACK_ID, version: 2, digest: pack.digest },
      rule: { version: 2, source: { kind: 'regulation' } },
    };
    const cites = (evaluation: RuleEvaluationRecord | undefined, recordType: string, index?: number) => {
      const ids = recorded.get(recordType)!;
      const evidence = evaluation!.evidence.map((item) => item.observationId);
      return index === undefined ? evidence.some((id) => ids.includes(id)) : evidence.includes(ids[index]!);
    };
    expect(newlyCheckedEntries.map(({ id }) => id).sort()).toEqual([
      'ledger.part107.107.12.b.assigned',
      'ledger.part107.107.9.timing',
    ]);

    const certificateId = 'ledger.part107.107.12.b.assigned';
    const held = latest(certificateId, pilot);
    expect(held, certificateId).toMatchObject({
      ...common,
      evidenceState: 'supported',
      outcome: 'pass',
      related: {
        name: 'pilot',
        subject: { scope: 'source', kind: 'person', id: pilot, sourceId },
        namedBy: [{ observationId: recorded.get('operation.role-assignment')![0], field: 'values.record.personId' }],
      },
    });
    expect(cites(held, 'person.certificate', 0)).toBe(true);
    expect(held!.inputs.find((input) => input.name === 'subject')).toMatchObject({
      about: { related: 'pilot' },
      subject: { id: pilot },
    });
    const suspended = latest(certificateId, relief);
    expect(suspended, certificateId).toMatchObject({ ...common, outcome: 'attention', reasonCode: 'value_unexpected' });
    expect(cites(suspended, 'person.certificate', 1)).toBe(true);

    const timingId = 'ledger.part107.107.9.timing';
    const timed = latest(timingId);
    expect(timed, timingId).toMatchObject({ ...common, evidenceState: 'supported', outcome: 'pass' });
    expect(timed!.summary).toMatch(/by the end of 2026-03-17 in UTC/);
    expect(cites(timed, 'occurrence.accident')).toBe(true);
  });
});
