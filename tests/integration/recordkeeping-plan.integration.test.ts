import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import { parseOrganizationSetup, setUpOrganization } from '../../apps/api/src/organization-setup.js';
import type {
  AdoptionRuleCoverageResponse,
  DocumentBodyV2,
  RequiredRecordsResponse,
  RuleCoverageSubjectsResponse,
  SmsRecordDetailResponse,
} from '../../packages/contracts/src/index.js';
import { runCli } from '../../packages/cli/src/index.js';
import { buildPackFolder } from '../../packages/standard-packs/src/index.js';
import { createPool, MemoryObjectStore } from '../../packages/persistence/src/index.js';
import { settleOwnedWork } from './worker-queue.js';

// A new organization with records on file adopts the proposed Part 108 rules in shadow, reads the records they
// require, starts a recordkeeping plan from them, fills its blanks, has it signed and issues it; the rule on the
// recordkeeping plan then names it (docs/design/required-records.md). Its own procedure lists the inspections of its
// dock, whose next due time is a schedule and never a time a record was made.
const example = join(import.meta.dirname, '..', '..', 'examples', 'first-operator');
const run = randomUUID().slice(0, 8);
const tenantId = `tenant-recordkeeping-plan-${run}`;
const PLAN_RULE = 'ledger.nprm.108.505.b.7';
const importOrder = [
  'aircraft.identity',
  'aircraft.inspection',
  'maintenance.action',
  'person.standing',
  'person.certificate',
  'person.training',
  'flight.plan',
  'operation.role-assignment',
  'flight.record',
] as const;
const EQUIPMENT_PACK = 'example-ridge.ground-equipment';

/** The organization's own procedure, listing one record of its own: the dock's inspections. */
function equipmentProcedure(folder: string): void {
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, 'source.txt'),
    'Ground equipment procedure (invented)\n1. The operations lead keeps a record of each inspection of the dock.\n2. The dock is inspected before the first flight of each week.\n',
  );
  writeFileSync(
    join(folder, 'pack.yaml'),
    [
      'pack:',
      `  id: ${EQUIPMENT_PACK}`,
      '  version: 1',
      '  title: Ground equipment procedure (invented)',
      'source:',
      '  file: source.txt',
      '  kind: procedure',
      '  reference: Ground equipment procedure (invented)',
      'provisions:',
      '  - number: 2',
      '    title: Weekly dock inspection',
      '    quote: The dock is inspected before the first flight of each week.',
      '    coverage: manual',
      '    waitingFor: Confirm that the dock was inspected before the first flight of the week.',
      'records:',
      '  - id: dock-inspections',
      '    title: Record of each inspection of the dock',
      '    quote: The operations lead keeps a record of each inspection of the dock.',
      '    keptBy: The operations lead',
      '    heldBy: [component.inspection]',
      '',
    ].join('\n'),
  );
}

describe.runIf(process.env.LEDGER_ENV !== 'staging')('A recordkeeping plan drafted from the required records', () => {
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  let app: Awaited<ReturnType<typeof createApp>>;
  let token: string;
  let adoptionId: string;
  const scratch = mkdtempSync(join(tmpdir(), 'ledger-recordkeeping-plan-'));
  const packs = join(scratch, 'packs');
  const own = join(scratch, 'own');

  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const body = init.body;
    const response = await app.inject({
      method: (init.method ?? 'GET') as 'GET',
      url: url.pathname + url.search,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      ...(body === undefined || body === null
        ? {}
        : { payload: typeof body === 'string' ? body : Buffer.from(body as Uint8Array) }),
    });
    return new Response(response.rawPayload.byteLength ? response.rawPayload : null, {
      status: response.statusCode,
      headers: response.headers as Record<string, string>,
    });
  }) as typeof fetch;

  async function ledger(...argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(argv, {
      env: { LEDGER_API_URL: 'http://ledger.invalid', LEDGER_TOKEN: token },
      folders: [example],
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      fetcher,
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  const call = (method: 'GET' | 'POST', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID(), ...headers },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  async function read<T>(url: string): Promise<T> {
    const response = await call('GET', url);
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as T;
  }
  const detail = (id: string) => read<SmsRecordDetailResponse>(`/v1/sms/records/${id}`);
  async function decide(id: string, decision: unknown, headers: Record<string, string> = {}) {
    const shown = await detail(id);
    return call(
      'POST',
      '/v1/commands',
      {
        kind: 'decision.record',
        subject: { kind: 'sms', id },
        expectedRevision: shown.basis.revision,
        expectedDependencyBasis: shown.basis.dependencyBasis,
        decision,
      },
      headers,
    );
  }
  async function planRule(result: string) {
    return read<RuleCoverageSubjectsResponse>(
      `/v1/organization/coverage/adoptions/${adoptionId}/rules/${PLAN_RULE}/subjects?result=${result}`,
    );
  }

  beforeAll(async () => {
    mkdirSync(packs, { recursive: true });
    equipmentProcedure(join(scratch, 'procedure'));
    const built = buildPackFolder(join(scratch, 'procedure'));
    writeFileSync(join(packs, `${EQUIPMENT_PACK}-v1.pack.json`), `${JSON.stringify(built.file, null, 2)}\n`);
    // Duty periods are recorded as their own observation type, and a dock inspection's interval ends at its next
    // due time, a year after the inspection.
    mkdirSync(join(own, 'records'), { recursive: true });
    writeFileSync(
      join(own, 'records', 'crew.duty-period.csv'),
      [
        'subjectId,periodId,period,startsAt,endsAt,role',
        'RIDGE-P-01,RIDGE-DUTY-1,duty,2026-11-09T14:00:00Z,2026-11-09T22:00:00Z,remote_pilot',
        'RIDGE-P-01,RIDGE-DUTY-2,duty,2026-11-10T14:00:00Z,2026-11-10T22:00:00Z,remote_pilot',
        'RIDGE-P-02,RIDGE-DUTY-3,duty,2026-11-10T15:00:00Z,2026-11-10T23:00:00Z,remote_pilot',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(own, 'records', 'component.inspection.csv'),
      [
        'subjectId,inspectionKind,inspectedAt,nextDueAt,recordedResult',
        'RIDGE-DOCK-1,scheduled,2026-11-02T15:00:00Z,2027-11-02T15:00:00Z,serviceable',
        'RIDGE-DOCK-1,scheduled,2026-11-09T15:00:00Z,2027-11-09T15:00:00Z,serviceable',
        '',
      ].join('\n'),
    );
    app = await createApp({ pool, env: 'test', objectStore: new MemoryObjectStore(), packsDir: packs });
    await app.ready();
    const created = await setUpOrganization(
      admin,
      parseOrganizationSetup([
        '--name',
        'Example Ridge Survey',
        '--time-zone',
        'America/Denver',
        '--admin',
        'Avery Example',
        '--id',
        `recordkeeping-plan-${run}`,
      ]),
      'local',
      [],
    );
    if (!created.created || !created.developmentToken) throw new Error('The organization should be new');
    token = created.developmentToken;
  });
  afterAll(async () => {
    await settleOwnedWork([tenantId]);
    await app?.close();
    await pool.end();
    await admin.end();
    rmSync(scratch, { recursive: true, force: true });
  });

  it('lists what the adopted rules require, starts a plan from it, and the rule names the issued plan', async () => {
    for (const type of importOrder) {
      const imported = await ledger('records', 'import', type, `records/${type}.csv`);
      expect(imported.code, `${type}: ${imported.out}\n${imported.err}`).toBe(0);
    }
    for (const type of ['crew.duty-period', 'component.inspection']) {
      const imported = await ledger('records', 'import', type, join(own, 'records', `${type}.csv`));
      expect(imported.code, `${type}: ${imported.out}\n${imported.err}`).toBe(0);
    }
    const procedure = await ledger(
      'packs',
      'adopt',
      EQUIPMENT_PACK,
      '--mode',
      'active',
      '--from',
      '2026-06-01',
      '--until',
      '2028-05-31',
      '--reason',
      'Avery Example adopts the ground equipment procedure.',
    );
    expect(procedure.code, `${procedure.out}\n${procedure.err}`).toBe(0);
    const adopted = await ledger(
      'packs',
      'adopt',
      'ledger.part108-nprm',
      '--mode',
      'shadow',
      '--from',
      '2026-06-01',
      '--until',
      '2028-05-31',
      '--set-all',
      'weekStartsOn=1',
      '--reason',
      'Avery Example adopts the proposed rules in shadow to see what they would ask of the operation.',
    );
    expect(adopted.code, `${adopted.out}\n${adopted.err}`).toBe(0);
    adoptionId = /^Adopted\. Adoption (\S+)\./m.exec(adopted.out)![1]!;
    await settleOwnedWork([tenantId]);
    expect((await planRule('no_record')).subjects).toHaveLength(1);

    // What the adopted rules require, with what is on file: counted, never judged.
    const required = await read<RequiredRecordsResponse>('/v1/organization/required-records');
    expect(required.organization).toEqual({ name: 'Example Ridge Survey', timeZone: 'America/Denver' });
    expect(required.records.map((record) => record.id)).toContain('part108-nprm.records.flights');
    const flights = required.records.find((record) => record.id === 'part108-nprm.records.flights')!;
    expect(flights).toMatchObject({
      keptBy: 'Each operator',
      declaredBy: [{ packId: 'ledger.part108-nprm', version: 3 }],
      retention: {
        reference: 'Proposed 14 CFR 108.40(f)(1)',
        text: expect.stringMatching(/^Data required under paragraph \(a\)\(3\) of this section must be\s+maintained/),
      },
    });
    expect(
      flights.heldBy.find((holder) => holder.kind === 'operator_record' && holder.recordType === 'flight.record'),
    ).toMatchObject({
      title: expect.any(String),
      onFile: { current: 3, replaced: 0, earliest: '2026-11-10T16:05:00.000Z' },
    });
    // Duty periods, recorded as their own observation type, are counted with the rest.
    const duty = required.records.find((record) => record.id === 'part108-nprm.records.duty-and-rest')!;
    expect(
      duty.heldBy.find((holder) => holder.kind === 'operator_record' && holder.recordType === 'crew.duty-period'),
    ).toMatchObject({
      onFile: { current: 3, replaced: 0, earliest: '2026-11-09T14:00:00.000Z', latest: '2026-11-10T15:00:00.000Z' },
    });
    // An inspection's next due time is a schedule: the range is when the inspections were made.
    const dock = required.records.find((record) => record.id === `${EQUIPMENT_PACK}.dock-inspections`)!;
    expect(dock.onFile).toEqual({
      current: 2,
      replaced: 0,
      earliest: '2026-11-02T15:00:00.000Z',
      latest: '2026-11-09T15:00:00.000Z',
    });
    expect(JSON.stringify(required)).not.toMatch(/complian|satisf|adequate/i);

    // Starting the plan opens a draft controlled document of its own type, with its blanks visible.
    const started = await ledger('plan', 'draft', '--open');
    expect(started.code, `${started.out}\n${started.err}`).toBe(0);
    const planId = /document (\S+), owned by Avery Example\./.exec(started.out)![1]!;
    const opened = await detail(planId);
    const body = opened.versions.find((version) => version.versionNumber === opened.record.versionNumber)!
      .body as DocumentBodyV2;
    expect(body.documentType).toBe('recordkeeping_plan');
    expect(body.text).toContain('3.1 Record of each inspection of the dock');
    expect(body.text).toContain(
      'Dock, ground station or component inspection: 2 on file, about 2026-11-02 to 2026-11-09',
    );
    expect(body.text).toContain('3.4 Record of each flight');
    expect(body.text).toContain('Flight record (flight.record)');
    expect(body.text).toMatch(/Flight record: 3 on file, about 2026-11-10 to 2026-11-1\d/);
    expect(body.text).toContain('Duty or rest period: 3 on file, about 2026-11-09 to 2026-11-10');

    // Reviewing with a blank is refused with a sentence naming it.
    const blank = await decide(planId, {
      kind: 'document.review',
      versionNumber: opened.record.versionNumber,
      attachmentIds: [],
      note: 'Reviewed the draft.',
    });
    expect(blank.statusCode, blank.body).toBe(409);
    expect(blank.json().error).toMatchObject({ code: 'plan_blank_unfilled' });
    expect(blank.json().error.message).toContain(
      'the first for the person or role responsible for keeping these records and producing them on request',
    );

    // The person fills each blank in a new revision, then it is reviewed, signed and issued.
    const filled: DocumentBodyV2 = {
      ...body,
      revisionLabel: '1',
      changeReason: 'Filled in who is responsible and where the deployment and its backups are.',
      text: body.text!.replace(/\[To be filled in: [^\]]+\]/g, 'Avery Example, operations lead (fictional).'),
    };
    const revised = await call('POST', '/v1/commands', {
      kind: 'sms.record.revise',
      recordId: planId,
      expectedRevision: opened.basis.revision,
      record: {
        kind: 'document',
        schema: 'sms.document.2',
        title: 'Recordkeeping plan',
        ownerId: (await read<{ principal: { id: string } }>('/v1/me')).principal.id,
        body: filled,
      },
    });
    expect(revised.statusCode, revised.body).toBe(201);
    const reviewed = await decide(planId, {
      kind: 'document.review',
      versionNumber: (await detail(planId)).record.versionNumber,
      attachmentIds: [],
      note: 'Reviewed the filled plan.',
    });
    expect(reviewed.statusCode, reviewed.body).toBe(201);
    const preview = await read<{ basis: never; intent: string; contentDigest: string; available: boolean }>(
      `/v1/sms/records/${planId}/signing?meaning=document.adopt`,
    );
    expect(preview.available).toBe(true);
    const grant = await call('POST', '/v1/local/reauthentications', { credential: token });
    expect(grant.statusCode, grant.body).toBe(201);
    const signed = await decide(
      planId,
      {
        kind: 'document.adopt',
        versionNumber: (await detail(planId)).record.versionNumber,
        note: 'Adopted as the recordkeeping plan.',
        signature: { intent: preview.intent, contentDigest: preview.contentDigest, reviewed: true },
      },
      { 'x-ledger-reauthentication': grant.json().grant },
    );
    expect(signed.statusCode, signed.body).toBe(201);
    const issued = await decide(planId, {
      kind: 'document.issue',
      versionNumber: (await detail(planId)).record.versionNumber,
      adoptionId: signed.json().command.id,
      recipientIds: [],
      note: 'Issued.',
    });
    expect(issued.statusCode, issued.body).toBe(201);
    await settleOwnedWork([tenantId]);

    // Records the plan says are produced on request are produced from the command line and verify offline.
    const zip = join(scratch, 'flights.zip');
    const produced = await ledger(
      'records',
      'produce',
      '--type',
      'flight.record',
      '--reason',
      'Copies of the flight records, as the plan describes.',
      '--requested-by',
      'An inspector (fictional)',
      '--out',
      zip,
    );
    expect(produced.code, `${produced.out}\n${produced.err}`).toBe(0);
    expect(produced.out).toContain('Produced 3 records of 1 record type');
    const digest = /^Manifest SHA-256: ([a-f0-9]{64})$/m.exec(produced.out)![1]!;
    const verified = JSON.parse(
      execFileSync(
        process.execPath,
        [
          join(import.meta.dirname, '..', '..', 'tools', 'verifier', 'record-production-cli.mjs'),
          zip,
          '--expected-manifest-sha256',
          digest,
        ],
        { encoding: 'utf8' },
      ),
    );
    expect(verified.status).toBe('verified');

    // In force, it serves the recordkeeping-plan purpose by its type, and the rule names it.
    const coverage = await read<AdoptionRuleCoverageResponse>(`/v1/organization/coverage/adoptions/${adoptionId}`);
    expect(coverage.rules.find((rule) => rule.leafId === PLAN_RULE)!.counts).toMatchObject({
      supported: 1,
      no_record: 0,
    });
    const named = (await planRule('supported')).subjects[0]!;
    expect(named.evaluation!.summary).toMatch(
      /^In force: “Recordkeeping plan”, revision 1, since \d{4}-\d{2}-\d{2}, serving it by its type\./,
    );
  }, 240_000);
});
