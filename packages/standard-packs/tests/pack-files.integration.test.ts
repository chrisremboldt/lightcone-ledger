import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../apps/api/src/index.js';
import { adoptShownPack } from '../../contracts/fixtures/demo/v1/ready.js';
import { isPackFileCheckedRule } from '../../contracts/src/index.js';
import type {
  OrganizationCoverageResponse,
  PackFile,
  RuleEvaluationRecord,
  RulePackListResponse,
  RulePackVersionResponse,
} from '../../contracts/src/index.js';
import { getRulePackVersion } from '../../domain/src/rule-pack-registry.js';
import { sha256 } from '../../integrity/src/index.js';
import { createPool, MemoryObjectStore, type AuthContext } from '../../persistence/src/index.js';
import { databaseNow, runOwnedWork, settleOwnedWork } from '../../../tests/integration/worker-queue.js';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const example = fileURLToPath(new URL('../examples/invented-waiver/', import.meta.url));

// An operator's own waiver, from its text to a recorded evaluation, with no TypeScript written and nothing rebuilt:
// the authoring command builds a pack file from the invented waiver's folder, the API loads it from the pack folder at
// startup, a person adopts it, records arrive, and each evaluation quotes the provision it checks.
describe.runIf(process.env.LEDGER_ENV !== 'staging')('An organization pack file, built and loaded at startup', () => {
  const prefix = `pack-file-${randomUUID()}`;
  const tenantId = `${prefix}:operator`;
  const sourceId = 'operator-records';
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const workerPool = createPool(process.env.WORKER_DATABASE_URL);
  const subjects = { flight: `${prefix}-FLT-1`, pilot: `${prefix}-PILOT-1`, aircraft: `${prefix}-AC-1` };
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
  const recorded = new Map<string, string[]>();
  const packsDir = mkdtempSync(join(tmpdir(), 'ledger-packs-'));
  let app: Awaited<ReturnType<typeof createApp>>;
  let file: PackFile;
  let fileName: string;
  let adoptionId: string;

  /** The database clock when the test started: every instant compared with a recorded row is taken from it. */
  let started: number;
  const hoursAgo = (hours: number) => new Date(started - hours * 3_600_000).toISOString().slice(0, 19) + 'Z';

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
    started = Date.parse(await databaseNow(admin));
    // The operator's one command: build the pack file from the folder holding the waiver text and its description.
    execFileSync(
      process.execPath,
      ['--import', 'tsx', 'packages/standard-packs/src/pack-cli.ts', 'build', example, '--out', packsDir],
      { cwd: repository, stdio: 'pipe' },
    );
    fileName = readdirSync(packsDir).find((name) => name.endsWith('.pack.json'))!;
    file = JSON.parse(readFileSync(join(packsDir, fileName), 'utf8'));
    // The restart: the API reads every pack file in its pack folder at startup.
    app = await createApp({ pool, env: 'test', objectStore: new MemoryObjectStore(), packsDir });
    await app.ready();
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, 'Alpha Dispatch']);
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
      observationGrants: ['operator.record', 'position.fix'].map((observationType) => ({ sourceId, observationType })),
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

  it('is offered for adoption, labelled as the organization’s own file', async () => {
    expect(fileName).toBe('alpha-dispatch.waiver-exw-0042-v1.pack.json');
    expect(getRulePackVersion(file.packId, file.version)!.digest).toBe(file.digest);
    const catalogue = await call(actor, 'GET', '/v1/rule-packs');
    expect(catalogue.statusCode, catalogue.body).toBe(200);
    const packs = (catalogue.json() as RulePackListResponse).packs;
    expect(packs.find((pack) => pack.packId === file.packId)).toEqual({
      packId: file.packId,
      version: 1,
      title: file.title,
      digest: file.digest,
      origin: { kind: 'organization_file', file: fileName },
    });
    expect(packs.find((pack) => pack.packId === 'ledger.part107')!.origin).toEqual({ kind: 'built_in' });
    // An organization of its own is not offered the invented example packs.
    expect(packs.find((pack) => pack.packId === 'ledger.example-waiver')).toBeUndefined();
    // Every provision is in the pack, including the one a person checks, with what that person confirms.
    const version = await call(actor, 'GET', `/v1/rule-packs/${encodeURIComponent(file.packId)}/versions/1`);
    expect(version.statusCode, version.body).toBe(200);
    const leaves = (version.json() as RulePackVersionResponse).pack.leaves;
    expect(leaves.map((leaf) => [leaf.id.slice(file.packId.length + 1), leaf.coverage])).toEqual([
      ['provision-1', 'automated'],
      ['provision-2', 'automated'],
      ['provision-3', 'automated'],
      ['provision-5', 'manual'],
      ['provision-4', 'automated'],
    ]);
    expect(leaves[3]).toMatchObject({
      title: 'Certificate available at the control station',
      source: {
        kind: 'waiver_or_exemption',
        reference: 'Certificate of Waiver EXW-0042 (invented), provision 5: Certificate at hand',
        text: 'A copy of this certificate is kept at the control\nstation during operations.',
      },
      waitingFor: 'Confirm that a copy of this certificate was at the control station throughout the operation.',
    });
  });

  it('is adopted with the value its rule by check kind asks for, and the coverage read says where it came from', async () => {
    const pack = getRulePackVersion(file.packId, file.version)!;
    const shown = await call(actor, 'GET', '/v1/organization/coverage');
    expect(shown.statusCode, shown.body).toBe(200);
    const command = {
      ...adoptShownPack(
        shown.json() as OrganizationCoverageResponse,
        pack,
        { start: new Date(started - 60_000).toISOString(), end: new Date(started + 3_600_000).toISOString() },
        'Fictional review of the invented waiver.',
        'active',
      ),
      parameters: { [`${file.packId}.provision-4`]: { limit: 15 } },
    };
    const adopted = await call(actor, 'POST', '/v1/commands', command);
    expect(adopted.statusCode, adopted.body).toBe(201);
    adoptionId = adopted.json().command.id as string;
    await settle();
    const coverage = (await call(actor, 'GET', '/v1/organization/coverage')).json() as OrganizationCoverageResponse;
    const adoption = coverage.adoptions.find((item) => item.id === adoptionId)!;
    expect(adoption.coverage).toContainEqual({
      leafId: `${file.packId}.provision-5`,
      coverage: 'manual',
      evidenceState: 'manual_review_required',
    });
    expect(adoption.coverage.filter((item) => item.coverage === 'automated')).toHaveLength(4);
    expect(coverage.packOrigins).toContainEqual({
      packId: file.packId,
      version: 1,
      origin: { kind: 'organization_file', file: fileName },
    });
  });

  it('evaluates the records it reads, and each evaluation quotes the provision it checks', async () => {
    const { flight, pilot, aircraft } = subjects;
    await importRecords('aircraft.identity', [
      {
        subjectId: aircraft,
        aircraftMakeModel: 'Fictional Quad 4',
        serialNumber: 'SN-0301',
        registrationNumber: 'FICT-0301',
        remoteIdentificationMethod: 'standard_broadcast',
      },
    ]);
    await importRecords('flight.plan', [
      {
        subjectId: flight,
        secondarySubjectId: aircraft,
        windowStartsAt: hoursAgo(3),
        windowEndsAt: hoursAgo(2),
        operationKind: 'inspection',
        plannedOriginDescription: 'Canal District depot',
        plannedDestinationDescription: 'Canal District footbridge 3',
        routeSummary: 'Inspection of the footbridge underside',
        visualMode: 'visual_line_of_sight',
        pilotInOperatingArea: 'yes',
        plannedMaxHeightAboveGroundMeters: 60,
        plannedMaxGroundSpeedMetersPerSecond: 12,
        plannedMaxDistanceFromControlStationMeters: 400,
      },
    ]);
    await importRecords('operation.role-assignment', [
      {
        subjectId: flight,
        subjectKind: 'flight',
        personId: pilot,
        role: 'pilot_in_command',
        startsAt: hoursAgo(3),
        endsAt: hoursAgo(2),
      },
    ]);
    await importRecords('person.training', [
      {
        subjectId: pilot,
        trainingKind: 'role_specific',
        courseTitle: 'Bridge inspection operations',
        completedOn: new Date(started - 40 * 86_400_000).toISOString().slice(0, 10),
        evidenceReference: 'BIO-0301',
      },
    ]);
    await settle();

    const source = Buffer.from(file.sources[0]!.text, 'utf8');
    const subjectOf = { flight: ['flight', flight], person: ['person', pilot], aircraft: ['aircraft', aircraft] };
    const cited: Record<string, string> = {
      'provision-1': 'aircraft.identity',
      'provision-2': 'flight.plan',
      'provision-3': 'person.training',
      'provision-4': 'flight.plan',
    };
    for (const rule of file.rules.filter(isPackFileCheckedRule)) {
      const [kind, subjectId] = subjectOf[rule.target.subjectKind as keyof typeof subjectOf];
      const latest = (await evaluations(kind!, subjectId!)).find((evaluation) => evaluation.rule.id === rule.id);
      expect(latest, rule.id).toMatchObject({
        adoption: { id: adoptionId, mode: 'active' },
        pack: { id: file.packId, version: 1, digest: file.digest },
        rule: {
          source: {
            kind: 'waiver_or_exemption',
            reference: rule.quote.reference,
            text: source.subarray(rule.quote.start, rule.quote.end).toString('utf8'),
          },
        },
        evidenceState: 'supported',
        outcome: 'pass',
      });
      expect(latest!.rule.source.reference).toMatch(/^Certificate of Waiver EXW-0042 \(invented\), provision \d/);
      const record = cited[rule.id.slice(file.packId.length + 1)]!;
      expect(
        latest!.evidence.some((item) => recorded.get(record)!.includes(item.observationId)),
        `${rule.id} cites a ${record} record`,
      ).toBe(true);
    }
    // The provision a person checks is never evaluated: it waits for that person.
    const certificate = `${file.packId}.provision-5`;
    const flightEvaluations = await evaluations('flight', flight);
    expect(flightEvaluations.some((evaluation) => evaluation.rule.id === certificate)).toBe(false);
    const training = file.rules.find((rule) => rule.id.endsWith('provision-3'))!;
    expect(source.subarray(training.quote.start, training.quote.end).toString('utf8')).toBe(
      'Each remote pilot completes the Bridge inspection operations\ncourse within the 12 calendar months before the operation.',
    );
  });

  it('reads the height the aircraft reported in place of the planned one, and says which it read', async () => {
    const { flight, aircraft } = subjects;
    const height = `${file.packId}.provision-2`;
    const planned = (await evaluations('flight', flight)).find((evaluation) => evaluation.rule.id === height)!;
    expect(planned).toMatchObject({ outcome: 'pass', details: { basis: 'planned' } });
    const occurredAt = hoursAgo(2.5);
    const response = await call(operator, 'POST', '/v1/inputs', {
      sourceId,
      kind: 'observation',
      occurredAt,
      payload: {
        type: 'position.fix',
        version: 1,
        subject: { kind: 'aircraft', id: aircraft, scope: 'source' },
        occurredAt,
        position: { latitudeDegrees: 41.88, longitudeDegrees: -87.63, altitude: { meters: 90, datum: 'ground_level' } },
        values: { fix: 'three_dimensional' },
        fidelity: 'synthetic_contract',
        limitations: ['Fictional position.'],
        originalArtifactId: await upload(Buffer.from(JSON.stringify({ entered: 'fictional position' }))),
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    await settle();
    const flown = (await evaluations('flight', flight)).find((evaluation) => evaluation.rule.id === height)!;
    // The plan's 60 m was within the 250 feet the provision states; the reported 90 m above ground is not.
    expect(flown).toMatchObject({
      outcome: 'attention',
      reasonCode: 'flown_beyond_limit',
      details: { basis: 'flown', measured: 'flown height above ground level', value: 90, plannedValue: 60 },
    });
    expect(flown.summary).toMatch(
      /^Read the flown height above ground level: .* 295\.28 ft \(90 m\) at .*, beyond the limit \(at most 250 feet above ground level, 76\.2 m\)\./,
    );
  });
});
