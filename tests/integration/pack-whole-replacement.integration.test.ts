import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import { parseOrganizationSetup, setUpOrganization } from '../../apps/api/src/organization-setup.js';
import {
  successorCommand,
  type OpenFindingsResponse,
  type OrganizationCoverageResponse,
} from '../../packages/contracts/src/index.js';
import { adoptionInstant, runCli } from '../../packages/cli/src/index.js';
import { buildPackFolder } from '../../packages/standard-packs/src/index.js';
import { createPool, MemoryObjectStore } from '../../packages/persistence/src/index.js';
import { settleOwnedWork } from './worker-queue.js';

// A corrected waiver that replaces the adopted version from its first day, as an operator's agent does it from the
// command line: version 1 opens a finding on a flight, version 2 replaces it for its whole period, and the flight is
// evaluated again under version 2, whose evaluation becomes the finding's latest; only version 2 is then adopted.
const example = join(import.meta.dirname, '..', '..', 'examples', 'first-operator', 'waiver');
const run = randomUUID().slice(0, 8);
const tenantId = `tenant-pack-whole-replacement-${run}`;
const waiverPack = 'example-ridge.waiver-107w-ex-2026-00417';
const zone = 'America/Denver';
const DAY = 86_400_000;
const day = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);
const FIRST_DAY = '2026-11-01';
const heightRule = `${waiverPack}.provision-4`;

describe.runIf(process.env.LEDGER_ENV !== 'staging')('Replacing an adopted pack from its first day', () => {
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const packs = mkdtempSync(join(tmpdir(), 'ledger-pack-whole-replacement-'));
  const work = mkdtempSync(join(tmpdir(), 'ledger-pack-whole-replacement-folder-'));
  let app: Awaited<ReturnType<typeof createApp>>;
  let token: string;

  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const response = await app.inject({
      method: (init.method ?? 'GET') as 'GET',
      url: url.pathname + url.search,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      ...(init.body === undefined || init.body === null
        ? {}
        : { payload: typeof init.body === 'string' ? init.body : Buffer.from(init.body as Uint8Array) }),
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
      folders: [work],
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      fetcher,
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  async function adopt(...argv: string[]) {
    const sent = await ledger('packs', 'adopt', waiverPack, ...argv, '--json');
    expect(sent.code, sent.err).toBe(0);
    await settleOwnedWork([tenantId]);
    return JSON.parse(sent.out) as { adoptionId: string; action: string; command: Record<string, unknown> };
  }

  async function read<T>(url: string): Promise<T> {
    const response = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }

  /** The open finding of the height provision about the flight, and the adoption and version its latest names. */
  async function heightFinding() {
    const open = await read<OpenFindingsResponse>(`/v1/organization/open-findings?ruleId=${heightRule}`);
    const finding = open.findings.find((item) => item.subject.id === 'FLT-2026-1102');
    if (!finding) return undefined;
    const evaluation = (
      await admin.query<{ adoption_id: string; pack_version: number; outcome: string }>(
        'SELECT adoption_id,pack_version,outcome FROM rule_evaluations WHERE tenant_id=$1 AND id=$2',
        [tenantId, finding.evaluationId],
      )
    ).rows[0]!;
    return { finding, evaluation };
  }

  function build(folder: string): void {
    const built = buildPackFolder(folder);
    writeFileSync(
      join(packs, `${built.file.packId}-v${built.file.version}.pack.json`),
      `${JSON.stringify(built.file, null, 2)}\n`,
    );
  }

  beforeAll(async () => {
    // Both versions list one record the waiver says is kept, so the recordkeeping plan names the version adopted.
    const issued = join(work, 'waiver-issued');
    cpSync(example, issued, { recursive: true });
    writeFileSync(
      join(issued, 'pack.yaml'),
      `${readFileSync(join(issued, 'pack.yaml'), 'utf8')}
records:
  - id: maintenance-records
    title: Record of maintenance, firmware changes and malfunctions
    quote: all maintenance, firmware changes and malfunctions must be documented
    keptBy: The holder
    heldBy: [maintenance.action]
`,
    );
    build(issued);
    const corrected = join(work, 'waiver');
    cpSync(issued, corrected, { recursive: true });
    const description = readFileSync(join(corrected, 'pack.yaml'), 'utf8');
    // The corrected waiver: provision 4's height, mistyped in version 1.
    writeFileSync(
      join(corrected, 'pack.yaml'),
      description
        .replace('  version: 1\n', '  version: 2\n')
        .replace('maxFeetAboveGround: 200', 'maxFeetAboveGround: 250'),
    );
    build(corrected);
    // One flight that cites the certificate, flown at 236 ft: above version 1's 200 ft, within version 2's 250 ft.
    mkdirSync(join(work, 'records'));
    const records: Record<string, string[]> = {
      'flight.plan': [
        'subjectId,secondarySubjectId,windowStartsAt,windowEndsAt,operationKind,visualMode,operatingAuthorityReference,plannedMaxHeightAboveGround [ft]',
        'FLT-2026-1102,RIDGE-AC-2,2026-11-12T16:00:00Z,2026-11-12T17:30:00Z,inspection,beyond_visual_line_of_sight,107W-EX-2026-00417,250',
      ],
      'flight.record': [
        'subjectId,secondarySubjectId,takeoffAt [local],landingAt [local],maxHeightFlownAboveGround [ft]',
        'FLT-2026-1102,RIDGE-AC-2,2026-11-12 09:10,2026-11-12 10:02,236',
      ],
    };
    for (const [type, lines] of Object.entries(records))
      writeFileSync(join(work, 'records', `${type}.csv`), `${lines.join('\n')}\n`);
    app = await createApp({ pool, env: 'test', objectStore: new MemoryObjectStore(), packsDir: packs });
    await app.ready();
    const created = await setUpOrganization(
      admin,
      parseOrganizationSetup([
        '--name',
        'Example Ridge Survey',
        '--time-zone',
        zone,
        '--admin',
        'Avery Example',
        '--id',
        `pack-whole-replacement-${run}`,
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
    rmSync(work, { recursive: true, force: true });
  });

  it('replaces version 1 for its whole period; the flight is evaluated under version 2 and its finding clears', async () => {
    const until = day(400);
    const first = await adopt(
      '--version',
      '1',
      '--mode',
      'active',
      '--from',
      FIRST_DAY,
      '--until',
      until,
      '--reason',
      'Adopted as issued.',
    );
    for (const type of ['flight.plan', 'flight.record']) {
      const imported = await ledger('records', 'import', type, `records/${type}.csv`);
      expect(imported.code, `${type}: ${imported.out}\n${imported.err}`).toBe(0);
    }
    await settleOwnedWork([tenantId]);
    const before = await heightFinding();
    expect(before, 'version 1 opens a finding on the flight flown at 236 ft').toBeDefined();
    expect(before!.finding.cleared).toBe(false);
    expect(before!.evaluation).toMatchObject({ adoption_id: first.adoptionId, pack_version: 1 });

    // Through the API: a successor from version 1's start that ends before version 1's end is refused, since it
    // would leave days under neither version.
    const shown1 = await read<OrganizationCoverageResponse>('/v1/organization/coverage');
    const standing = shown1.adoptions.find((item) => item.id === first.adoptionId)!;
    const version2 = (
      await read<{ pack: Parameters<typeof successorCommand>[2] }>(`/v1/rule-packs/${waiverPack}/versions/2`)
    ).pack;
    const short = await app.inject({
      method: 'POST',
      url: '/v1/commands',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
      payload: successorCommand(shown1, standing, version2, {
        mode: 'active',
        start: standing.effectiveInterval.start,
        end: new Date(Date.parse(standing.effectiveInterval.start) + DAY).toISOString(),
        note: 'Too short',
      }),
    });
    expect(short.statusCode, short.body).toBe(400);
    expect(short.json().error).toMatchObject({ code: 'invalid_adoption_successor' });
    expect(short.json().error.message).toContain('replaces it for its whole period');

    const preview = await ledger('packs', 'adopt', waiverPack, '--from', FIRST_DAY, '--until', until);
    expect(preview.code, preview.err).toBe(0);
    expect(preview.out).toContain('Version 1 is replaced for its whole period');

    const second = await adopt(
      '--from',
      FIRST_DAY,
      '--until',
      until,
      '--reason',
      'Avery Example corrects the height in provision 4 from the first day.',
    );
    expect(second.action).toBe('succeed');
    const start = adoptionInstant(FIRST_DAY, zone, 'from').instant;
    expect(second.command).toMatchObject({
      succeeds: first.adoptionId,
      pack: { version: 2 },
      effectiveInterval: { start },
    });

    const shown = (await read<OrganizationCoverageResponse>('/v1/organization/coverage')).adoptions;
    const byId = (id: string) => shown.find((item) => item.id === id)!;
    expect(byId(first.adoptionId)).toMatchObject({
      state: 'succeeded',
      succeededBy: { id: second.adoptionId, version: 2, start },
    });
    expect(byId(second.adoptionId)).toMatchObject({ state: 'effective', pack: { version: 2 } });
    expect(byId(second.adoptionId).effectiveInterval.start).toBe(byId(first.adoptionId).effectiveInterval.start);

    // The finding version 1 opened stays open; version 2's evaluation of the same rule is its latest, and supported.
    const after = await heightFinding();
    expect(after?.finding.id).toBe(before!.finding.id);
    expect(after!.evaluation).toMatchObject({ adoption_id: second.adoptionId, pack_version: 2, outcome: 'pass' });
    expect(after!.finding.cleared).toBe(true);

    const text = await ledger('coverage', '--pack', waiverPack);
    expect(text.code, text.err).toBe(0);
    expect(text.out).toContain(`(${waiverPack} version 2), active, effective`);

    // The recordkeeping plan names the version that stands, never the one replaced from its first day.
    const plan = await ledger('plan', 'draft');
    expect(plan.code, plan.err).toBe(0);
    expect(plan.out).toContain(`(${waiverPack} version 2)`);
    expect(plan.out).not.toContain(`(${waiverPack} version 1)`);
  }, 240_000);
});
