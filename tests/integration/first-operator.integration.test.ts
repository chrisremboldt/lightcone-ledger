import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import { setUpCredential } from '../../apps/api/src/credential-setup.js';
import { parseOrganizationSetup, setUpOrganization } from '../../apps/api/src/organization-setup.js';
import { runCli } from '../../packages/cli/src/index.js';
import { buildPackFolder } from '../../packages/standard-packs/src/index.js';
import { createPool, MemoryObjectStore } from '../../packages/persistence/src/index.js';
import { settleOwnedWork } from './worker-queue.js';

// The worked example in examples/first-operator, run as its README and docs/guides/set-up-with-a-coding-agent.md
// say: from the organization pnpm org:create makes, through the command-line client's own code, to coverage. If the
// guide and this test ever disagree, this test is right.
const example = join(import.meta.dirname, '..', '..', 'examples', 'first-operator');
const run = randomUUID().slice(0, 8);
const tenantId = `tenant-first-operator-${run}`;
const waiverPack = 'example-ridge.waiver-107w-ex-2026-00417';

/** The order the README imports in: what flights name is on file before the flights. */
const importOrder = [
  'aircraft.identity',
  'aircraft.inspection',
  'aircraft.time-in-service',
  'aircraft.detect-and-avoid',
  'maintenance.action',
  'person.standing',
  'person.certificate',
  'person.training',
  'organization.procedure',
  'organization.operating-area',
  'flight.plan',
  'operation.role-assignment',
  'operation.notification',
  'flight.preflight-assessment',
  'flight.record',
  'occurrence.emergency-deviation',
] as const;

describe.runIf(process.env.LEDGER_ENV !== 'staging')('The first operator, set up from the command line', () => {
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const packs = mkdtempSync(join(tmpdir(), 'ledger-first-operator-'));
  let app: Awaited<ReturnType<typeof createApp>>;
  let token: string;

  /** fetch, answered by the API in this process. */
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = init.body;
    const response = await app.inject({
      method: (init.method ?? 'GET') as 'GET',
      url: url.pathname + url.search,
      headers,
      ...(body === undefined || body === null
        ? {}
        : { payload: typeof body === 'string' ? body : Buffer.from(body as Uint8Array) }),
    });
    return new Response(response.rawPayload.byteLength ? response.rawPayload : null, {
      status: response.statusCode,
      headers: response.headers as Record<string, string>,
    });
  }) as typeof fetch;

  async function ledger(credential: string, ...argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(argv, {
      env: { LEDGER_API_URL: 'http://ledger.invalid', LEDGER_TOKEN: credential },
      folders: [example],
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      fetcher,
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }
  const json = async (credential: string, ...argv: string[]) => {
    const result = await ledger(credential, ...argv, '--json');
    expect(result.code, result.err).toBe(0);
    return JSON.parse(result.out);
  };

  beforeAll(async () => {
    // pnpm pack:build examples/first-operator/waiver --out <packs>, then Ledger started with LEDGER_PACKS_DIR=<packs>.
    const built = buildPackFolder(join(example, 'waiver'));
    mkdirSync(packs, { recursive: true });
    writeFileSync(
      join(packs, `${built.file.packId}-v${built.file.version}.pack.json`),
      `${JSON.stringify(built.file, null, 2)}\n`,
    );
    app = await createApp({ pool, env: 'test', objectStore: new MemoryObjectStore(), packsDir: packs });
    await app.ready();
    // pnpm org:create --name "Example Ridge Survey" --time-zone America/Denver --admin "Avery Example"
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
        `first-operator-${run}`,
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
    rmSync(packs, { recursive: true, force: true });
  });

  it('runs the worked example from its waiver and its spreadsheets to coverage', async () => {
    const me = await ledger(token, 'me');
    expect(me.code, me.err).toBe(0);
    expect(me.out).toContain('Signed in as Avery Example');
    expect(me.out).toContain('Example Ridge Survey');
    expect(me.out).toContain('time zone America/Denver');

    // A spreadsheet saved as it was kept: the check says what to fix, row by row, and records nothing.
    const unfixed = await ledger(token, 'records', 'check', 'flight.plan', 'records/flight.plan.unfixed.csv');
    expect(unfixed.code).toBe(1);
    expect(unfixed.out).toContain('2 rows: 0 can be recorded');
    expect(unfixed.out).toMatch(/Row 1 \(FLT-BAD-1\): refused\. .+/);
    expect(unfixed.out).toMatch(/Row 2 \(FLT-BAD-2\): refused\. .+/);

    // The flight log as the log service exports it, read through its column mapping: checked, it records nothing.
    const exported = await ledger(
      token,
      'records',
      'check',
      'flight.record',
      'records/flight-log.export.csv',
      '--mapping',
      'records/flight-log.mapping.yaml',
    );
    expect(exported.code, `${exported.out}\n${exported.err}`).toBe(0);
    expect(exported.out).toContain('Checking flight-log.export.csv with the mapping flight-log.mapping.yaml');
    expect(exported.out).toContain('3 rows: 3 can be recorded (0 of them incomplete), 0 already recorded, 0 refused.');
    expect(exported.out).toContain(
      '  Max Alt (ft AGL): maxHeightFlownAboveGroundMeters (Maximum height flown above ground), in ft',
    );
    expect(exported.out).toContain('Not read: PIC, Remarks.');
    expect(exported.out).toContain('  Row 4: left out by the mapping; Status is "Cancelled".');
    expect(exported.out).toContain(
      '  Row 1 (FLT-2026-1101): takeoffAt 11/10/2026 9:05 AM in America/Denver kept as 2026-11-10T16:05:00Z.',
    );

    for (const type of importOrder) {
      const checked = await ledger(token, 'records', 'check', type, `records/${type}.csv`);
      expect(checked.code, `${type}: ${checked.out}\n${checked.err}`).toBe(0);
      const imported = await ledger(token, 'records', 'import', type, `records/${type}.csv`);
      expect(imported.code, `${type}: ${imported.out}\n${imported.err}`).toBe(0);
      expect(imported.out).toContain('recorded as Avery Example');
      expect(imported.out).toMatch(/0 refused\.$/m);
    }
    const plans = await json(token, 'records', 'list', 'flight.plan');
    expect(plans.records.map((record: { subject: { id: string } }) => record.subject.id).sort()).toEqual([
      'FLT-2026-1101',
      'FLT-2026-1102',
      'FLT-2026-1103',
      'FLT-2026-1201',
    ]);

    const offered = await ledger(token, 'packs', 'list');
    expect(offered.out).toContain(`${waiverPack}`);
    expect(offered.out).toMatch(/your file example-ridge\.waiver-107w-ex-2026-00417-v1\.pack\.json/);

    // Without a reason the client prints what it would record, and sends nothing.
    const planned = await ledger(
      token,
      'packs',
      'adopt',
      'ledger.part107',
      '--mode',
      'active',
      '--from',
      '2026-06-01',
      '--until',
      '2028-05-31',
    );
    expect(planned.code, planned.err).toBe(0);
    expect(planned.out).toContain('Mode: active: its findings count.');
    expect(planned.out).toContain('From: the start of 2026-06-01 in America/Denver (2026-06-01T06:00:00.000Z)');
    expect(planned.out).toContain('Until: the end of 2028-05-31 in America/Denver (2028-06-01T06:00:00.000Z)');
    expect(planned.out).toContain("= America/Denver, from your organization's time zone");
    expect(planned.out).toContain('Recorded as Avery Example');
    expect(planned.out).toContain('Not sent.');
    expect((await json(token, 'coverage')).adoptions).toEqual([]);

    const reason = ['--reason', 'Avery Example adopts the rules the operation works under, as the waiver states them.'];
    const dates = ['--from', '2026-06-01', '--until', '2028-05-31'];
    for (const [pack, mode, extra] of [
      ['ledger.part107', 'active', []],
      ['ledger.part108-nprm', 'shadow', ['--set-all', 'weekStartsOn=1']],
      [waiverPack, 'active', []],
    ] as const) {
      const adopted = await ledger(token, 'packs', 'adopt', pack, '--mode', mode, ...dates, ...extra, ...reason);
      expect(adopted.code, `${pack}: ${adopted.out}\n${adopted.err}`).toBe(0);
      expect(adopted.out).toMatch(/^Adopted\. Adoption .+/m);
    }
    await settleOwnedWork([tenantId]);

    const shown = await ledger(token, 'coverage', '--pack', waiverPack);
    expect(shown.code, shown.err).toBe(0);
    expect(shown.out).toContain('Waiver 107W-EX-2026-00417');
    expect(shown.out).toContain('Checked automatically');
    expect(shown.out).toContain('A person reviews it');
    const read = await json(token, 'coverage', '--pack', waiverPack);
    const rules = read.adoptions[0].coverage.rules as { leafId: string; counts: Record<string, number> | null }[];
    const counts = (rule: string) => rules.find((item) => item.leafId === `${waiverPack}.${rule}`)!.counts;
    // The waiver's conditions cover the three flights whose plan cites it; the ordinary flight is not checked.
    expect(counts('provision-3')).toMatchObject({ supported: 3, attention: 0, not_applicable: 1 });
    expect(counts('provision-4')).toMatchObject({ supported: 2, attention: 1, not_applicable: 1 });
    expect(counts('provision-8')).toMatchObject({ supported: 1 });
    expect(counts('provision-11')).toMatchObject({ supported: 3, attention: 0, not_applicable: 1 });
    // From the flight log alone: the wind at takeoff and the battery at landing FLT-2026-1102's log states are beyond
    // the waiver's limits; the planned FLT-2026-1201 has not flown. RIDGE-AC-2's inspection was due by a date before
    // FLT-2026-1102, and RIDGE-AC-1's next is due at 120 h, which it has passed since FLT-2026-1101.
    expect(counts('provision-17')).toMatchObject({ supported: 1, attention: 1, not_applicable: 2 });
    expect(counts('provision-18')).toMatchObject({ supported: 1, attention: 1, not_applicable: 2 });
    expect(counts('provision-19')).toMatchObject({ supported: 1, attention: 2, not_applicable: 1 });
    const height = await ledger(
      token,
      'coverage',
      '--pack',
      waiverPack,
      '--rule',
      'provision-4',
      '--result',
      'attention',
    );
    expect(height.code, height.err).toBe(0);
    expect(height.out).toMatch(/FLT-2026-1102[^\n]*: .*200 feet/);
    const attention = async (provision: string) => {
      const listed = await ledger(
        token,
        'coverage',
        '--pack',
        waiverPack,
        '--rule',
        provision,
        '--result',
        'attention',
      );
      expect(listed.code, listed.err).toBe(0);
      return listed.out.replace(/\s+/g, ' ');
    };
    expect(await attention('provision-17')).toContain(
      'Read the wind at takeoff in the operator’s flight record: 12.35 m/s, outside the limit, at most 10 m/s.',
    );
    expect(await attention('provision-18')).toContain(
      'Read the battery remaining at landing in the operator’s flight record: 18 %, outside the limit, at least 25 %.',
    );
    // Before the planned start the hours are those flown so far; after it, those at the start.
    expect(await attention('provision-19')).toMatch(
      /RIDGE-AC-1 had 120\.2 h in service (now, before the planned start|at the planned start), 2026-12-01 09:00 America\/Denver; the inspection recorded on 2026-09-01 was due at 120 h\./,
    );
    // The notice for FLT-2026-1201 states only the day it was filed: read as filed at the end of that day.
    expect(await attention('provision-9')).toContain(
      'was made on 2026-11-30; only the date is on record, so it is read as made at the end of that day',
    );

    const ordinary = await ledger(
      token,
      'coverage',
      '--pack',
      waiverPack,
      '--rule',
      'provision-2',
      '--result',
      'not_applicable',
    );
    expect(ordinary.code, ordinary.err).toBe(0);
    expect(ordinary.out).toMatch(/FLT-2026-1103[^\n]*: /);
    expect(ordinary.out).not.toContain('FLT-2026-1101');

    // The proposed Part 108, read section by section: the operating areas on file and the aircraft flown after
    // maintenance with no return to service recorded.
    const proposed = await ledger(token, 'coverage', '--pack', 'ledger.part108-nprm');
    expect(proposed.code, proposed.err).toBe(0);
    expect(proposed.out).toContain(
      '§ 108.165 Area of operations. 6 rules: 5 checked automatically, 1 a person reviews',
    );
    // The paragraph, then the rule's title with its id after it, the counts beside them; long titles wrap.
    expect(proposed.out).toMatch(
      /§ 108\.165\(c\)\s+Each current operating area describes[\s\S]*?\[ledger\.nprm\.108\.165\.c\]/,
    );
    expect(Math.max(...proposed.out.split('\n').map((line) => line.length))).toBeLessThanOrEqual(140);
    const part108 = (await json(token, 'coverage', '--pack', 'ledger.part108-nprm')).adoptions[0].coverage;
    expect(part108.sections[0]).toMatchObject({ id: '108.40' });
    const nprm = (rule: string) =>
      (part108.rules as { leafId: string; counts: Record<string, number> | null }[]).find(
        (item) => item.leafId === `ledger.nprm.${rule}`,
      )!.counts;
    expect(nprm('108.165.a')).toMatchObject({ supported: 1 });
    expect(nprm('108.165.c')).toMatchObject({ attention: 1 });
    expect(nprm('108.630.a.flight')).toMatchObject({ supported: 2, attention: 1, not_applicable: 1 });
    expect(nprm('108.555.a')).toMatchObject({ attention: 1 });
    expect(nprm('108.150.c')).toMatchObject({ no_record: 1 });

    const findings = await ledger(token, 'findings', 'list', '--all');
    expect(findings.code, findings.err).toBe(0);
    expect(findings.out).toContain('FLT-2026-1102');

    // The list ends, for each adopted pack, with the results that say a record is not on file: they open no finding,
    // and the command it names lists each of them with its rule, subject and sentence.
    const grouped = await ledger(token, 'findings', 'list');
    expect(grouped.code, grouped.err).toBe(0);
    expect(grouped.out).toContain('Not on file is not a finding');
    const notOnFile = [
      ...grouped.out.matchAll(
        /: (\d+) results? under \d+ rules? says? a record is not on file\. [^:]+: (pnpm ledger .+)$/gm,
      ),
    ];
    expect(notOnFile.length).toBeGreaterThan(0);
    for (const [, count, command] of notOnFile) {
      const listed = await ledger(token, ...command!.split(' ').slice(2));
      expect(listed.code, listed.err).toBe(0);
      expect(listed.out.split('\n').filter((line) => /^ {4}\S/.test(line))).toHaveLength(Number(count));
    }
  }, 180_000);

  it('imports and reads with a credential issued to a service, and leaves adoption to a person', async () => {
    // pnpm credential:issue --organization <id> --for "Records agent" --label "Coding agent on the office computer"
    //   --add service --capability input:write --capability evidence:read --capability flight:read
    //   --grant operator-records:operator.record
    const issued = await setUpCredential(admin, {
      tenantId,
      principal: 'Records agent',
      label: 'Coding agent on the office computer',
      add: {
        kind: 'service',
        capabilities: ['input:write', 'evidence:read', 'flight:read'],
        observationGrants: [{ sourceId: 'operator-records', observationType: 'operator.record' }],
      },
    });
    const service = issued.credential.secret;

    const me = await ledger(service, 'me');
    expect(me.out).toContain('Signed in as Records agent');
    expect(me.out).toContain('a service');

    const imported = await ledger(
      service,
      'records',
      'import',
      'operation.notification',
      'records/operation.notification.csv',
    );
    expect(imported.code, imported.err).toBe(0);
    expect(imported.out).toContain('recorded as Records agent');
    const types = await ledger(service, 'records', 'types');
    expect(types.code, types.err).toBe(0);
    const listed = await json(service, 'records', 'list', 'aircraft.identity');
    expect(listed.records).toHaveLength(3);
    const coverage = await ledger(service, 'coverage');
    expect(coverage.code, coverage.err).toBe(0);
    expect(coverage.out).toContain('Waiver 107W-EX-2026-00417');
    expect((await ledger(service, 'findings', 'list')).code).toBe(0);

    const adopt = await ledger(
      service,
      'packs',
      'adopt',
      'ledger.part107',
      '--mode',
      'shadow',
      '--from',
      '2026-06-01',
      '--until',
      '2028-05-31',
      '--reason',
      'Not a person',
    );
    expect(adopt.code).toBe(1);
    expect(adopt.err).toContain("Not sent. An adoption is a person's decision");
    expect(readdirSync(packs)).toHaveLength(1);
  });
});
