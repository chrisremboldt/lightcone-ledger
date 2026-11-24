import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import { parseOrganizationSetup, setUpOrganization } from '../../apps/api/src/organization-setup.js';
import { runCli } from '../../packages/cli/src/index.js';
import { buildPackFolder } from '../../packages/standard-packs/src/index.js';
import { createPool, MemoryObjectStore } from '../../packages/persistence/src/index.js';
import { settleOwnedWork } from './worker-queue.js';

// The worked duty and rest rule of docs/guides/write-a-rule-pack.md, built from the guide as written, adopted and run
// on imported role assignments and duty or rest periods: it reads the periods the import stored, and each flight's
// pilot in command gets the result the guide says.
const repository = join(import.meta.dirname, '..', '..');
const run = randomUUID().slice(0, 8);
const tenantId = `tenant-guide-duty-rule-${run}`;
const packId = 'example-ridge.operations-manual';
const leafId = `${packId}.duty-and-rest`;
const DAY = 86_400_000;
const day = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

/** The guide's duty rule and the source text before it. */
function guideDutyRule(): { description: string; source: string } {
  const guide = readFileSync(join(repository, 'docs', 'guides', 'write-a-rule-pack.md'), 'utf8');
  const blocks = [...guide.matchAll(/```(\w+)\n([\s\S]*?)```/gu)].map((match) => ({
    language: match[1]!,
    text: match[2]!,
  }));
  const index = blocks.findIndex(
    (block) => block.language === 'yaml' && block.text.includes('kind: duty.within-limits'),
  );
  const source = blocks
    .slice(0, index)
    .reverse()
    .find((block) => block.language === 'text' && !block.text.includes(' version '))!;
  return { description: blocks[index]!.text, source: source.text };
}

describe.runIf(process.env.LEDGER_ENV !== 'staging')('The guide’s duty and rest rule on imported periods', () => {
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const packs = mkdtempSync(join(tmpdir(), 'ledger-guide-duty-packs-'));
  const work = mkdtempSync(join(tmpdir(), 'ledger-guide-duty-'));
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

  beforeAll(async () => {
    const { description, source } = guideDutyRule();
    mkdirSync(join(work, 'manual'));
    writeFileSync(join(work, 'manual', 'pack.yaml'), description);
    writeFileSync(join(work, 'manual', 'source.txt'), source);
    const built = buildPackFolder(join(work, 'manual'));
    writeFileSync(join(packs, `${packId}-v1.pack.json`), `${JSON.stringify(built.file, null, 2)}\n`);
    // Three flights: one within the limits, one whose pilot's duty period lasts 13 hours, and one whose pilot has
    // periods on file but none overlapping the flight.
    mkdirSync(join(work, 'records'));
    const records: Record<string, string[]> = {
      'operation.role-assignment': [
        'subjectId,subjectKind,personId,role,startsAt,endsAt',
        'FLT-2026-1110,flight,RIDGE-P-01,pilot_in_command,2026-11-10T16:00:00Z,2026-11-10T17:00:00Z',
        'FLT-2026-1111,flight,RIDGE-P-02,pilot_in_command,2026-11-11T16:00:00Z,2026-11-11T17:00:00Z',
        'FLT-2026-1112,flight,RIDGE-P-03,pilot_in_command,2026-11-12T16:00:00Z,2026-11-12T17:00:00Z',
      ],
      'crew.duty-period': [
        'subjectId,periodId,period,startsAt,endsAt',
        'RIDGE-P-01,P01-REST-1,rest,2026-11-09T20:00:00Z,2026-11-10T08:00:00Z',
        'RIDGE-P-01,P01-DUTY-1,duty,2026-11-10T08:00:00Z,2026-11-10T18:00:00Z',
        'RIDGE-P-02,P02-REST-1,rest,2026-11-10T19:00:00Z,2026-11-11T07:00:00Z',
        'RIDGE-P-02,P02-DUTY-1,duty,2026-11-11T07:00:00Z,2026-11-11T20:00:00Z',
        'RIDGE-P-03,P03-REST-1,rest,2026-11-11T20:00:00Z,2026-11-12T06:00:00Z',
        'RIDGE-P-03,P03-DUTY-1,duty,2026-11-12T06:00:00Z,2026-11-12T10:00:00Z',
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
        'America/Denver',
        '--admin',
        'Avery Example',
        '--id',
        `guide-duty-rule-${run}`,
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

  it('reads the imported duty periods and gives each flight’s pilot in command the guide’s result', async () => {
    const adopted = await ledger(
      'packs',
      'adopt',
      packId,
      '--mode',
      'active',
      '--from',
      '2026-11-01',
      '--until',
      day(400),
      '--reason',
      'Adopted as written in the manual.',
    );
    expect(adopted.code, adopted.err).toBe(0);
    for (const type of ['operation.role-assignment', 'crew.duty-period']) {
      const imported = await ledger('records', 'import', type, `records/${type}.csv`);
      expect(imported.code, `${type}: ${imported.out}\n${imported.err}`).toBe(0);
      expect(imported.out).toMatch(/0 refused\.$/mu);
    }
    await settleOwnedWork([tenantId]);
    const latest = (
      await admin.query<{ subject_id: string; outcome: string; summary: string }>(
        `SELECT DISTINCT ON(subject_id) subject_id,outcome,record->>'summary' AS summary FROM rule_evaluations
         WHERE tenant_id=$1 AND leaf_id=$2 ORDER BY subject_id,recorded_at DESC,id DESC`,
        [tenantId, leafId],
      )
    ).rows;
    const of = (flight: string) => latest.find((row) => row.subject_id === flight);
    expect(of('FLT-2026-1110')).toMatchObject({ outcome: 'pass' });
    expect(of('FLT-2026-1111')).toMatchObject({ outcome: 'attention' });
    expect(of('FLT-2026-1111')!.summary).toContain('The duty period lasts 13 h against at most 12 h');
    expect(of('FLT-2026-1112')).toMatchObject({ outcome: 'attention' });
    expect(of('FLT-2026-1112')!.summary).toContain('No recorded duty period overlaps the window.');
  }, 240_000);
});
