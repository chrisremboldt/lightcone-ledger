import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import * as screen from '../../../apps/web/src/rule-coverage.js';
import {
  adoptionInstant,
  chooseValues,
  importRowLines,
  mappingLines,
  readConnection,
  runCli,
  usage,
} from '../src/index.js';
import { listOperatorRecordTypes } from '../../domain/src/operator-record-import.js';
import * as words from '../src/words.js';
import type { RulePackVersion } from '@ledger/contracts';
import { px4, px4Definitions, RIDGE, UlogWriter } from '../../flight-logs/tests/encoders.js';

const folder = mkdtempSync(join(tmpdir(), 'ledger-cli-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

/** A fetch that answers from a table of paths, and keeps what it was sent. */
function fakeApi(answers: Record<string, { status?: number; body: unknown }>) {
  const sent: { method: string; path: string; authorization: string | null; body?: unknown }[] = [];
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    sent.push({
      method: init.method ?? 'GET',
      path: url.pathname + url.search,
      authorization: new Headers(init.headers).get('authorization'),
      ...(typeof init.body === 'string' ? { body: JSON.parse(init.body) } : {}),
    });
    const answer = answers[`${init.method ?? 'GET'} ${url.pathname}`];
    if (!answer)
      return new Response(JSON.stringify({ error: { code: 'not_found', message: 'No such route' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    return new Response(JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetcher, sent };
}

async function cli(
  argv: string[],
  fetcher: typeof fetch,
  env: NodeJS.ProcessEnv = { LEDGER_TOKEN: 'ledger-dev-test' },
) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    env,
    folders: [folder],
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    fetcher,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const me = {
  principal: {
    id: 'p-1',
    tenantId: 'tenant-example',
    name: 'Avery Example',
    kind: 'human',
    capabilities: ['evidence:read', 'pack:adopt'],
    revision: 1,
    commandLinkSources: [],
    missionSources: [],
    monitoringSources: [],
  },
  organization: { id: 'tenant-example', name: 'Example Ridge Survey', timeZone: 'America/Denver' },
};

describe('The command line', () => {
  it('prints who the credential is, sending it as a bearer token, and the same as JSON on request', async () => {
    const api = fakeApi({ 'GET /v1/me': { body: me } });
    const text = await cli(['me'], api.fetcher);
    expect(text.code).toBe(0);
    expect(text.out).toBe(
      [
        'Signed in as Avery Example (p-1), a person.',
        'Organization: Example Ridge Survey (tenant-example), time zone America/Denver.',
        'May: evidence:read, pack:adopt.',
        'May record: no observation grants.',
      ].join('\n'),
    );
    expect(api.sent[0]).toEqual({ method: 'GET', path: '/v1/me', authorization: 'Bearer ledger-dev-test' });
    const json = await cli(['me', '--json'], api.fetcher);
    expect(JSON.parse(json.out)).toEqual(me);
  });

  it('exits non-zero with the API’s own sentence when the API refuses', async () => {
    const api = fakeApi({
      'GET /v1/me': {
        status: 403,
        body: { error: { code: 'capability_required', message: 'Capability evidence:read is required' } },
      },
    });
    const refused = await cli(['me'], api.fetcher);
    expect(refused.code).toBe(1);
    expect(refused.err).toBe('Ledger refused this (403 capability_required): Capability evidence:read is required');
  });

  it('never takes a credential as an argument, and says how to give one', async () => {
    const api = fakeApi({});
    expect((await cli(['me', '--token', 'secret'], api.fetcher)).code).toBe(2);
    const none = await cli(['me'], api.fetcher, {});
    expect(none.code).toBe(2);
    expect(none.err).toContain('Set LEDGER_TOKEN');
    expect(api.sent).toEqual([]);
  });

  it('reads the API address and credential from a git-ignored file when the environment has none', () => {
    const operator = join(folder, 'operator', 'records');
    mkdirSync(join(folder, 'operator', '.ledger'), { recursive: true });
    mkdirSync(operator, { recursive: true });
    writeFileSync(
      join(folder, 'operator', '.ledger', 'credentials'),
      '# local\nLEDGER_API_URL=http://127.0.0.1:4000/\nLEDGER_TOKEN="ledger-service-abc"\n',
    );
    expect(readConnection({}, [operator])).toMatchObject({
      apiUrl: 'http://127.0.0.1:4000',
      token: 'ledger-service-abc',
    });
    expect(readConnection({ LEDGER_TOKEN: 'from-env' }, [operator]).token).toBe('from-env');
  });

  it('prints its usage and refuses an unknown command', async () => {
    const api = fakeApi({});
    expect((await cli(['--help'], api.fetcher)).out).toBe(usage);
    const unknown = await cli(['flights', 'fly'], api.fetcher);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toBe('Unknown command: flights fly');
  });

  it('lists the latest version of each pack, and every version with --all', async () => {
    const summary = (packId: string, version: number) => ({
      packId,
      version,
      title: `${packId} title`,
      origin: { kind: 'built_in' },
    });
    const api = fakeApi({
      'GET /v1/rule-packs': {
        body: { packs: [summary('p.one', 1), summary('p.one', 3), summary('p.one', 2), summary('p.two', 1)] },
      },
    });
    const latest = await cli(['packs', 'list'], api.fetcher);
    expect(latest.code, latest.err).toBe(0);
    const rows = latest.out.split('\n').filter((line) => line.startsWith('p.'));
    expect(rows.map((line) => line.split(/\s+/).slice(0, 2).join(' '))).toEqual(['p.one 3', 'p.two 1']);
    expect(latest.out).toContain('2 earlier versions also offered: --all lists them.');
    const json = await cli(['packs', 'list', '--json'], api.fetcher);
    expect(JSON.parse(json.out).packs.map((pack: { version: number }) => pack.version)).toEqual([3, 1]);
    const all = await cli(['packs', 'list', '--all'], api.fetcher);
    expect(all.out.split('\n').filter((line) => line.startsWith('p.')).length).toBe(4);
    expect(all.out).not.toContain('--all lists them');
  });

  it('names the kinds a subject column holds with the right article', async () => {
    const column = (key: string, subjectKinds: string[]) => ({
      key,
      label: key,
      kind: 'subject_id',
      required: false,
      replayOnly: false,
      subjectKinds,
    });
    const api = fakeApi({
      'GET /v1/operator-records/types': {
        body: {
          types: [
            {
              recordType: 'example.record',
              recordVersion: 1,
              title: 'Example',
              description: 'An example.',
              subjectKinds: ['aircraft'],
              columns: [
                column('subjectId', ['aircraft']),
                column('relatedSubjectId', ['organization', 'flight']),
                column('pilot', ['person']),
              ],
            },
          ],
        },
      },
    });
    const shown = await cli(['records', 'columns', 'example.record'], api.fetcher);
    expect(shown.code, shown.err).toBe(0);
    expect(shown.out).toContain('an aircraft id');
    expect(shown.out).toContain('an organization or flight id');
    expect(shown.out).toContain('a person id');
    expect(shown.out).not.toMatch(/\ba [aeiou]/);
  });

  it('refuses an option a command does not read, naming it, and sends nothing', async () => {
    const api = fakeApi({ 'GET /v1/me': { body: me } });
    const refused = await cli(['records', 'list', 'flight.plan', '--until', '2026-11-30'], api.fetcher);
    expect(refused.code).toBe(2);
    expect(refused.err).toContain('records list does not read --until, so nothing was done.');
    expect(refused.err).toContain('It reads --subject, --limit');
    const none = await cli(['me', '--pack', 'p'], api.fetcher);
    expect(none.code).toBe(2);
    expect(none.err).toContain('me does not read --pack');
    expect(api.sent).toEqual([]);
  });

  it('prints coverage section by section, with the paragraph each rule reads', async () => {
    const counts = {
      supported: 1,
      attention: 0,
      no_record: 1,
      pending: 0,
      not_applicable: 0,
      relieved: 0,
      other: 0,
      not_evaluated: 0,
    };
    const rule = (leafId: string, title: string, section: string, paragraph: string) => ({
      leafId,
      title,
      checkedBy: 'automatic',
      section,
      paragraph,
      subjectKind: 'organization',
      population: { of: 'on_record' },
      populationSize: 2,
      counts,
      complete: true,
    });
    const api = fakeApi({
      'GET /v1/organization/coverage': {
        body: {
          asOf: '2026-11-22T12:00:00.000Z',
          adoptions: [
            {
              id: 'adoption-1',
              state: 'effective',
              pack: { packId: 'ledger.part108-nprm', version: 3 },
              effectiveInterval: { start: '2026-11-01T00:00:00.000Z', end: '2027-11-01T00:00:00.000Z' },
            },
          ],
        },
      },
      'GET /v1/organization/coverage/adoptions/adoption-1': {
        body: {
          adoptionId: 'adoption-1',
          packId: 'ledger.part108-nprm',
          version: 3,
          title: 'Part 108 NPRM checks (shadow only)',
          mode: 'shadow',
          asOf: '2026-11-22T12:00:00.000Z',
          populationLimit: 2000,
          sections: [
            {
              id: '108.150',
              title: '§ 108.150 Operating location',
              leafIds: ['ledger.nprm.108.150.c'],
              checkedBy: { automatic: 1, person: 0, not_supported: 0 },
              needingAttention: 0,
              withNoRecord: 1,
            },
            {
              id: '108.165',
              title: '§ 108.165 Area of operations',
              leafIds: ['ledger.nprm.108.165.a'],
              checkedBy: { automatic: 1, person: 0, not_supported: 0 },
              needingAttention: 0,
              withNoRecord: 1,
            },
          ],
          rules: [
            rule('ledger.nprm.108.150.c', 'Physical security policies on file', '108.150', '§ 108.150(c)'),
            rule('ledger.nprm.108.165.a', 'Approval named for each operating area', '108.165', '§ 108.165(a)'),
          ],
        },
      },
    });
    const text = await cli(['coverage'], api.fetcher);
    expect(text.code).toBe(0);
    const lines = text.out.split('\n');
    const first = lines.indexOf(
      '§ 108.150 Operating location. 1 rule: 1 checked automatically; 1 with a record not on file.',
    );
    const second = lines.indexOf(
      '§ 108.165 Area of operations. 1 rule: 1 checked automatically; 1 with a record not on file.',
    );
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    expect(lines.slice(first, second).join('\n')).toContain('§ 108.150(c)  Physical security policies on file');
    expect(lines.slice(second).join('\n')).toContain('§ 108.165(a)  Approval named for each operating area');
  });

  it('keeps the coverage table within 140 columns, with long titles and counts wrapped', async () => {
    const long = {
      leafId: 'ledger.nprm.108.40.a.3.ii',
      title:
        'Records of each flight coordinator’s supervised experience in each make and model kept for the period the text states',
      checkedBy: 'automatic',
      section: '108.40',
      paragraph: '§ 108.40(a)(3)(ii)',
      subjectKind: 'person',
      population: { of: 'in_adoption_dates' },
      populationSize: 1234,
      counts: {
        supported: 400,
        attention: 300,
        no_record: 200,
        pending: 100,
        not_applicable: 50,
        relieved: 0,
        other: 0,
        not_evaluated: 184,
      },
      complete: true,
    };
    const api = fakeApi({
      'GET /v1/organization/coverage': {
        body: {
          asOf: '2026-11-22T12:00:00.000Z',
          adoptions: [
            {
              id: 'adoption-2',
              state: 'effective',
              pack: { packId: 'ledger.part108-nprm', version: 3 },
              effectiveInterval: { start: '2026-11-01T00:00:00.000Z', end: '2027-11-01T00:00:00.000Z' },
            },
          ],
        },
      },
      'GET /v1/organization/coverage/adoptions/adoption-2': {
        body: {
          adoptionId: 'adoption-2',
          packId: 'ledger.part108-nprm',
          version: 3,
          title: 'Part 108',
          mode: 'shadow',
          asOf: '2026-11-22T12:00:00.000Z',
          populationLimit: 2000,
          sections: [
            {
              id: '108.40',
              title: '§ 108.40 Recordkeeping',
              leafIds: [long.leafId],
              checkedBy: { automatic: 1, person: 0, not_supported: 0 },
              needingAttention: 1,
              withNoRecord: 1,
            },
          ],
          rules: [long],
        },
      },
    });
    const text = await cli(['coverage'], api.fetcher);
    expect(text.code, text.err).toBe(0);
    const table = text.out.split('\n').filter((line) => line.startsWith('  '));
    expect(Math.max(...table.map((line) => line.length))).toBeLessThanOrEqual(140);
    const first = table.find((line) => line.includes('§ 108.40(a)(3)(ii)'))!;
    expect(first).toMatch(/§ 108\.40\(a\)\(3\)\(ii\)\s+Records of each.*\s{2}300 · Needs attention/);
    expect(text.out.replace(/\s+/g, ' ')).toContain('[ledger.nprm.108.40.a.3.ii]');
    expect(JSON.parse((await cli(['coverage', '--json'], api.fetcher)).out).adoptions[0].coverage.rules[0]).toEqual(
      long,
    );
  });

  it('takes for --result the words coverage prints, their first word, or the value', () => {
    expect(words.parseCoverageResult('waiting')).toBe('pending');
    expect(words.parseCoverageResult('Waiting for a record or a time')).toBe('pending');
    expect(words.parseCoverageResult('pending')).toBe('pending');
    expect(words.parseCoverageResult('no-record')).toBe('no_record');
    expect(words.parseCoverageResult('No record')).toBe('no_record');
    expect(words.parseCoverageResult('needs attention')).toBe('attention');
    expect(words.parseCoverageResult('relieved')).toBe('relieved');
    // "no" starts only "No record on file", never "Not yet evaluated".
    expect(words.parseCoverageResult('no')).toBe('no_record');
    expect(words.parseCoverageResult('wait')).toBeUndefined();
    expect(words.coverageResultChoices()).toContain('pending (Waiting for a record or a time)');
  });

  it('speaks the Rules screen’s words', () => {
    expect(words.coverageResultLabels).toEqual(screen.coverageResultLabels);
    expect(words.coverageResultOrder).toEqual(screen.coverageResultOrder);
    expect(words.checkedByLabels).toEqual(screen.checkedByLabels);
    const section = {
      id: '108.40',
      title: '§ 108.40 Operator recordkeeping requirements',
      leafIds: ['a', 'b', 'c'],
      checkedBy: { automatic: 2, person: 1, not_supported: 0 },
      needingAttention: 1,
      withNoRecord: 2,
    };
    expect(words.sectionWords(section)).toBe(screen.sectionWords(section));
    expect(words.sectionWords(section)).toBe(
      '3 rules: 2 checked automatically, 1 a person reviews; 1 with a subject needing attention, 2 with a record not on file.',
    );
    const rule = {
      leafId: 'x',
      title: 'x',
      checkedBy: 'automatic',
      populationSize: 0,
      counts: null,
      complete: true,
    } as const;
    for (const population of [undefined, { of: 'on_record' }, { of: 'in_adoption_dates' }] as const)
      for (const subjectKind of ['person', 'aircraft', 'flight'] as const) {
        const item = { ...rule, subjectKind, ...(population ? { population } : {}) } as never;
        expect(words.populationWords(item)).toBe(screen.populationWords(item));
      }
    expect(words.missingWords(['training record'])).toBe(screen.missingWords(['training record']));
  });
});

describe('Column mappings from the command line', () => {
  const flightRecord = listOperatorRecordTypes().find((type) => type.recordType === 'flight.record')!;
  const types = { 'GET /v1/operator-records/types': { body: { types: [flightRecord], sourceId: 'operator-records' } } };

  it('starts a mapping from an export: every column listed and unassigned, and never over a file already there', async () => {
    writeFileSync(join(folder, 'log-export.csv'), 'Flight No.,Takeoff,"Max Alt, ft"\nFLT-1,11/10/2026 9:05 AM,148\n');
    const api = fakeApi(types);
    const printed = await cli(['records', 'mapping', 'flight.record', 'log-export.csv'], api.fetcher);
    expect(printed.code, printed.err).toBe(0);
    expect(printed.out).toContain('columns:\n  "Flight No.": ~\n  "Takeoff": ~\n  "Max Alt, ft": ~\n');
    const written = await cli(
      ['records', 'mapping', 'flight.record', 'log-export.csv', '--out', 'log.mapping.yaml'],
      api.fetcher,
    );
    expect(written.code, written.err).toBe(0);
    expect(written.out).toContain('Wrote');
    expect(readFileSync(join(folder, 'log.mapping.yaml'), 'utf8')).toBe(`${printed.out}\n`);
    const again = await cli(
      ['records', 'mapping', 'flight.record', 'log-export.csv', '--out', 'log.mapping.yaml'],
      api.fetcher,
    );
    expect(again.code).toBe(2);
    expect(again.err).toContain('already exists; nothing was written');
    expect(api.sent.every((request) => request.method === 'GET')).toBe(true);
  });

  it('reads --mapping only on check and import, and refuses a mapping file it cannot read before sending', async () => {
    const api = fakeApi({ ...types, 'GET /v1/me': { body: me } });
    const unread = await cli(['records', 'list', 'flight.record', '--mapping', 'log.mapping.yaml'], api.fetcher);
    expect(unread.code).toBe(2);
    expect(unread.err).toContain('records list does not read --mapping');
    const missing = await cli(
      ['records', 'check', 'flight.record', 'log-export.csv', '--mapping', 'no-such.yaml'],
      api.fetcher,
    );
    expect(missing.code).toBe(2);
    expect(missing.err).toBe(`Cannot read ${join(folder, 'no-such.yaml')}.`);
    expect(api.sent.some((request) => request.method === 'POST')).toBe(false);
  });

  it('prints what each column became, what was not read, the constants and the rows left out', () => {
    expect(
      mappingLines({
        artifactId: 'artifact-9',
        columns: [{ source: 'Takeoff', becomes: 'takeoffAt (Takeoff at), times in UTC written MM/DD/YYYY h:mm A' }],
        unread: ['PIC', 'Remarks'],
        constants: [{ field: 'heightNotes', value: 'none' }],
        leftOut: [{ row: 4, reason: 'Status is "Cancelled".' }],
      }),
    ).toEqual([
      'The mapping (file artifact-9) read the export’s columns as:',
      '  Takeoff: takeoffAt (Takeoff at), times in UTC written MM/DD/YYYY h:mm A',
      'Not read: PIC, Remarks.',
      'Stated by the mapping for every row, not held by the export: heightNotes = none.',
      '  Row 4: left out by the mapping; Status is "Cancelled".',
    ]);
  });
});

describe('Reading an aircraft’s log from the command line', () => {
  const S = 1_000_000;
  const UTC = Date.UTC(2026, 10, 10, 16, 5, 0) * 1000;
  function writeLog(name: string, landing = true) {
    const log = px4Definitions(new UlogWriter());
    px4.gps(log, 5 * S, UTC + 5 * S, RIDGE);
    px4.landed(log, 6 * S, true);
    px4.status(log, 10 * S, true);
    px4.global(log, 11 * S, RIDGE, 1850);
    px4.landed(log, 12 * S, false);
    px4.global(log, 30 * S, RIDGE, 1890);
    if (landing) {
      px4.landed(log, 70 * S, true);
      px4.status(log, 72 * S, false);
    }
    writeFileSync(join(folder, name), log.done());
  }
  const noApi = (async () => {
    throw new Error('read-log sent a request');
  }) as unknown as typeof fetch;

  it('reads a log offline into a flight.record CSV beside it, and never over a file already there', async () => {
    writeLog('RIDGE-AC-1.ulg');
    const read = await cli(['records', 'read-log', 'RIDGE-AC-1.ulg'], noApi, {});
    expect(read.code, read.err).toBe(0);
    expect(read.out).toContain('RIDGE-AC-1.ulg: PX4 ULog');
    expect(read.out).toContain('2026-11-10T16:05:12Z to 2026-11-10T16:06:10Z, 58 s.');
    expect(read.out).toContain(
      'Then: pnpm ledger records check flight.record RIDGE-AC-1.flight.record.csv --original RIDGE-AC-1.ulg',
    );
    const csv = readFileSync(join(folder, 'RIDGE-AC-1.flight.record.csv'), 'utf8');
    const digest = createHash('sha256')
      .update(readFileSync(join(folder, 'RIDGE-AC-1.ulg')))
      .digest('hex');
    expect(csv).toContain(`,,2026-11-10T16:05:12Z,2026-11-10T16:06:10Z,"39.5012345, -105.2034567"`);
    expect(csv).toContain(`RIDGE-AC-1.ulg (sha256 ${digest}), flight 1`);
    const again = await cli(['records', 'read-log', 'RIDGE-AC-1.ulg'], noApi, {});
    expect(again.code).toBe(2);
    expect(again.err).toContain('already exists; nothing was written');
  });

  it('says when a flight is not whole, and refuses a file that is no log it reads', async () => {
    writeLog('cut.ulg', false);
    const cut = await cli(['records', 'read-log', 'cut.ulg', '--out', 'cut.csv'], noApi, {});
    expect(cut.code).toBe(1);
    expect(cut.out).toContain('No whole flight was read, so no file was written.');
    expect(cut.out).toContain('the log ends while the aircraft is armed');
    expect(existsSync(join(folder, 'cut.csv'))).toBe(false);
    writeFileSync(join(folder, 'notes.txt'), 'not a log');
    const other = await cli(['records', 'read-log', 'notes.txt'], noApi, {});
    expect(other.code).toBe(2);
    expect(other.err).toContain('does not begin as a PX4 ULog');
    const format = await cli(['records', 'read-log', 'cut.ulg', '--format', 'kml'], noApi, {});
    expect(format.err).toBe('--format is one of ulog, dataflash, tlog: kml');
  });

  it('takes --original on check and import, not with --mapping, and never a file larger than Ledger keeps', async () => {
    const api = fakeApi({
      'GET /v1/operator-records/types': {
        body: {
          types: [listOperatorRecordTypes().find((type) => type.recordType === 'flight.record')!],
          sourceId: 'operator-records',
        },
      },
      'GET /v1/me': { body: me },
    });
    writeFileSync(join(folder, 'big.ulg'), new Uint8Array(10 * 1024 * 1024 + 1));
    writeFileSync(join(folder, 'rows.csv'), 'subjectId\n');
    const both = await cli(
      ['records', 'check', 'flight.record', 'rows.csv', '--original', 'big.ulg', '--mapping', 'm.yaml'],
      api.fetcher,
    );
    expect(both.err).toContain('Give --mapping or --original, not both');
    const big = await cli(['records', 'import', 'flight.record', 'rows.csv', '--original', 'big.ulg'], api.fetcher);
    expect(big.code).toBe(2);
    expect(big.err).toContain('big.ulg is 10.0 MB; Ledger keeps a file of at most 10 MB');
    expect(api.sent.some((request) => request.method === 'POST')).toBe(false);
  });
});

describe('Adoption as the command line assembles it', () => {
  it('reads a day in the organization’s zone, from its start until its end', () => {
    expect(adoptionInstant('2026-06-01', 'America/Denver', 'from').instant).toBe('2026-06-01T06:00:00.000Z');
    expect(adoptionInstant('2028-05-31', 'America/Denver', 'until').instant).toBe('2028-06-01T06:00:00.000Z');
    expect(adoptionInstant('2026-01-15', 'America/Denver', 'from').instant).toBe('2026-01-15T07:00:00.000Z');
    expect(adoptionInstant('2026-06-01T00:00:00Z', 'America/Denver', 'from').instant).toBe('2026-06-01T00:00:00.000Z');
    expect(() => adoptionInstant('06/01/2026', 'America/Denver', 'from')).toThrow('--from is a date');
    expect(() => adoptionInstant('2026-02-30', 'UTC', 'from')).toThrow('is not a date');
  });

  it('takes each value a pack asks for from --set, then --set-all, then the zone, and names what is missing', () => {
    const leaf = (id: string, parameters: object[]) => ({
      id: `p.${id}`,
      title: id,
      coverage: 'automated',
      adoptionParameters: parameters,
    });
    const pack = {
      packId: 'p',
      leaves: [
        leaf('report', [{ name: 'timeZone', title: 'Zone', valueType: 'string' }]),
        leaf('height', [{ name: 'limit', title: 'Limit', valueType: 'number' }]),
        leaf('week', [
          { name: 'limit', title: 'Limit', valueType: 'number' },
          { name: 'weekStartsOn', title: 'Week start', valueType: 'integer' },
        ]),
      ],
    } as unknown as RulePackVersion;
    const chosen = chooseValues(pack, ['height.limit=120'], ['limit=50', 'weekStartsOn=1'], 'America/Denver');
    expect(chosen.map((item) => [item.leafId, item.parameter.name, item.value, item.from])).toEqual([
      ['p.report', 'timeZone', 'America/Denver', "your organization's time zone"],
      ['p.height', 'limit', 120, '--set'],
      ['p.week', 'limit', 50, '--set-all'],
      ['p.week', 'weekStartsOn', 1, '--set-all'],
    ]);
    expect(() => chooseValues(pack, [], [], 'UTC')).toThrow(/height\.limit \(Limit\)[\s\S]*week\.weekStartsOn/);
    expect(() => chooseValues(pack, ['week.weekStartsOn=Monday'], ['limit=1'], 'UTC')).toThrow('a whole number');
    expect(() => chooseValues(pack, ['nowhere.limit=1'], [], 'UTC')).toThrow('No rule of p asks for nowhere.limit');
  });
});

describe('Adopting a waiver pack from the command line', () => {
  const waiverPack = {
    packId: 'example.waiver',
    version: 1,
    title: 'Example waiver',
    digest: 'd'.repeat(64),
    leaves: [{ id: 'example.waiver.visibility', title: 'Visibility', coverage: 'automated' }],
    bindings: [],
    waiver: {
      certificateNumber: '107W-2026-00001',
      conditionsCover: 'flights_citing_certificate',
      effective: { from: '2026-06-01', through: '2028-05-31' },
    },
  };
  const api = () =>
    fakeApi({
      'GET /v1/me': { body: me },
      'GET /v1/rule-packs': {
        body: {
          packs: [{ packId: 'example.waiver', version: 1, title: 'Example waiver', origin: { kind: 'built_in' } }],
        },
      },
      'GET /v1/rule-packs/example.waiver/versions/1': { body: { pack: waiverPack } },
      'GET /v1/organization/coverage': { body: { adoptions: [] } },
    });

  it('prints the certificate’s stated dates and adopts over them when no dates are given, saying so', async () => {
    const printed = await cli(['packs', 'adopt', 'example.waiver', '--mode', 'active'], api().fetcher);
    expect(printed.code, printed.err).toBe(0);
    expect(printed.out).toContain(
      'Waiver: certificate 107W-2026-00001 states it is effective from 2026-06-01 through 2028-05-31.',
    );
    expect(printed.out).toContain(
      'From: the start of 2026-06-01 in America/Denver (2026-06-01T06:00:00.000Z), the first date the certificate states',
    );
    expect(printed.out).toContain(
      'Until: the end of 2028-05-31 in America/Denver (2028-06-01T06:00:00.000Z), the last date the certificate states',
    );
  });

  it('takes the dates given over the stated ones', async () => {
    const printed = await cli(
      ['packs', 'adopt', 'example.waiver', '--mode', 'shadow', '--from', '2026-07-01', '--until', '2026-12-31'],
      api().fetcher,
    );
    expect(printed.code, printed.err).toBe(0);
    expect(printed.out).toContain('From: the start of 2026-07-01 in America/Denver (2026-07-01T06:00:00.000Z)\n');
    expect(printed.out).not.toContain('date the certificate states');
    expect(printed.out).toContain('states it is effective from 2026-06-01 through 2028-05-31');
  });
});

describe('Producing records and drafting a recordkeeping plan from the command line', () => {
  const zip = JSON.stringify('fictional zip bytes');
  const production = {
    id: 'production-1',
    byteLength: Buffer.byteLength(zip),
    archiveSha256: createHash('sha256').update(zip).digest('hex'),
    manifestSha256: 'a'.repeat(64),
    counts: {
      records: 12,
      recordTypes: 2,
      replaced: 1,
      originals: 3,
      originalsIncluded: 0,
      originalBytes: 0,
      originalsWithOtherRecords: 0,
      otherRecords: 0,
      flights: 0,
    },
  };
  const produceArgs = ['records', 'produce', '--reason', 'Inspection request', '--requested-by', 'An inspector'];

  it('asks for a pilot’s flights’ records with --with-flights, and says what the originals hold besides', async () => {
    const api = fakeApi({
      'GET /v1/me': { body: me },
      'POST /v1/record-productions': {
        status: 201,
        body: {
          record: {
            ...production,
            counts: {
              ...production.counts,
              originalsIncluded: 3,
              originalsWithOtherRecords: 2,
              otherRecords: 37,
              flights: 4,
            },
          },
        },
      },
      'GET /v1/record-productions/production-1/content': { body: 'fictional zip bytes' },
    });
    const produced = await cli(
      [...produceArgs, '--subject', 'person:RIDGE-P-1', '--originals', '--with-flights', '--out', 'pilot.zip'],
      api.fetcher,
    );
    expect(produced.code, produced.err).toBe(0);
    expect(api.sent.find((item) => item.method === 'POST')!.body).toMatchObject({
      includeOriginals: true,
      withFlights: true,
    });
    expect(produced.out).toContain(
      'The records name 4 flights the person was assigned to, listed in the file with their records.',
    );
    expect(produced.out).toContain(
      '2 original files also hold 37 records this file does not, such as rows about other subjects; the originals are included whole, so those rows go with them.',
    );
  });

  it('refuses a production without its reason, who asked or where to write it, and sends nothing', async () => {
    const api = fakeApi({ 'GET /v1/me': { body: me } });
    for (const argv of [
      ['records', 'produce', '--requested-by', 'x', '--out', 'r.zip'],
      ['records', 'produce', '--reason', 'x', '--out', 'r.zip'],
      ['records', 'produce', '--reason', 'x', '--requested-by', 'y'],
      [...produceArgs, '--out', 'r.zip', '--subject', 'pilot:PIL-1'],
    ]) {
      const refused = await cli(argv, api.fetcher);
      expect(refused.code, argv.join(' ')).toBe(2);
    }
    expect(api.sent.filter((item) => item.method === 'POST')).toEqual([]);
  });

  it('produces the chosen records in the organization’s days, saves the file checked against its digest, and says what to keep apart', async () => {
    const api = fakeApi({
      'GET /v1/me': { body: me },
      'POST /v1/record-productions': { status: 201, body: { record: production } },
      'GET /v1/record-productions/production-1/content': { body: 'fictional zip bytes' },
    });
    const produced = await cli(
      [
        ...produceArgs,
        '--subject',
        'aircraft:RIDGE-AC-1',
        '--subject',
        'organization',
        '--type',
        'flight.record',
        '--from',
        '2026-11-01',
        '--until',
        '2026-11-30',
        '--out',
        'ridge.zip',
      ],
      api.fetcher,
    );
    expect(produced.code, produced.err).toBe(0);
    expect(api.sent.find((item) => item.method === 'POST')!.body).toEqual({
      subjects: [{ kind: 'aircraft', id: 'RIDGE-AC-1' }, { kind: 'organization' }],
      recordTypes: ['flight.record'],
      from: '2026-11-01T06:00:00.000Z',
      to: '2026-12-01T07:00:00.000Z',
      includeOriginals: false,
      reason: 'Inspection request',
      requestedBy: 'An inspector',
    });
    expect(readFileSync(join(folder, 'ridge.zip'), 'utf8')).toBe(zip);
    expect(produced.out).toContain('Produced 12 records of 2 record types');
    expect(produced.out).toContain('until the end of 2026-11-30');
    const sentBefore = api.sent.length;
    const withTo = await cli(
      [...produceArgs, '--from', '2026-11-01', '--to', '2026-11-30', '--out', 'ridge-to.zip'],
      api.fetcher,
    );
    expect(withTo.code, withTo.err).toBe(0);
    expect(api.sent.slice(sentBefore).find((item) => item.method === 'POST')!.body).toMatchObject({
      to: '2026-12-01T07:00:00.000Z',
    });
    const both = await cli(
      [...produceArgs, '--until', '2026-11-30', '--to', '2026-11-30', '--out', 'x.zip'],
      api.fetcher,
    );
    expect(both.code).toBe(2);
    expect(produced.out).toContain(`Manifest SHA-256: ${'a'.repeat(64)}`);
    expect(produced.out).toContain(
      `node tools/verifier/record-production-cli.mjs ${join(folder, 'ridge.zip')} --expected-manifest-sha256 ${'a'.repeat(64)}`,
    );

    const altered = fakeApi({
      'GET /v1/me': { body: me },
      'POST /v1/record-productions': {
        status: 201,
        body: { record: { ...production, archiveSha256: 'b'.repeat(64) } },
      },
      'GET /v1/record-productions/production-1/content': { body: 'fictional zip bytes' },
    });
    const mismatch = await cli([...produceArgs, '--out', 'altered.zip'], altered.fetcher);
    expect(mismatch.code).toBe(1);
    expect(mismatch.err).toContain('does not match its recorded length and SHA-256; nothing was written');
    expect(existsSync(join(folder, 'altered.zip'))).toBe(false);
  });

  const draft = {
    asOf: '2026-11-22T17:00:00.000Z',
    title: 'Recordkeeping plan',
    body: {
      origin: 'authored',
      documentType: 'recordkeeping_plan',
      revisionLabel: '1',
      summary: 'How Example Ridge Survey keeps and produces the 1 records its adopted rule packs list.',
      text: 'Recordkeeping plan of Example Ridge Survey\n2. Who is responsible\n[To be filled in: who is responsible]',
      changeReason: 'Drafted in Ledger.',
    },
    blanks: ['who is responsible'],
    requiredRecords: 1,
  };

  it('prints a drafted plan with its blanks and opens nothing unless asked', async () => {
    const api = fakeApi({ 'GET /v1/organization/recordkeeping-plan/draft': { body: draft } });
    const shown = await cli(['plan', 'draft'], api.fetcher);
    expect(shown.code, shown.err).toBe(0);
    expect(shown.out).toContain('[To be filled in: who is responsible]');
    expect(shown.out).toContain('1 blank only your organization can fill');
    expect(shown.out).toContain('Not opened.');
    const written = await cli(['plan', 'draft', '--out', 'plan.txt'], api.fetcher);
    expect(readFileSync(join(folder, 'plan.txt'), 'utf8')).toBe(`${draft.body.text}\n`);
    expect(written.out).not.toContain('Recordkeeping plan of');
    expect(api.sent.every((item) => item.method === 'GET')).toBe(true);
  });

  it('opens the draft as a document owned by the person, and refuses to with a service’s credential', async () => {
    const api = fakeApi({
      'GET /v1/organization/recordkeeping-plan/draft': { body: draft },
      'GET /v1/me': { body: me },
      'POST /v1/commands': { status: 201, body: { command: { id: 'c-1', subject: { id: 'doc-1' } } } },
    });
    const opened = await cli(['plan', 'draft', '--open'], api.fetcher);
    expect(opened.code, opened.err).toBe(0);
    expect(opened.out).toContain('Opened a draft recordkeeping plan, document doc-1, owned by Avery Example.');
    expect(api.sent.find((item) => item.method === 'POST')!.body).toEqual({
      kind: 'sms.record.open',
      record: {
        kind: 'document',
        schema: 'sms.document.2',
        title: 'Recordkeeping plan',
        ownerId: 'p-1',
        body: draft.body,
      },
    });

    const service = fakeApi({
      'GET /v1/organization/recordkeeping-plan/draft': { body: draft },
      'GET /v1/me': { body: { ...me, principal: { ...me.principal, kind: 'service', name: 'Records agent' } } },
    });
    const refused = await cli(['plan', 'draft', '--open'], service.fetcher);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('owned by a person');
    expect(service.sent.some((item) => item.method === 'POST')).toBe(false);
  });
});

describe('Open findings from the command line', () => {
  const counts = { counted: 63, proposed: 4, relieved: 2 };
  const group = (ruleId: string, open: number, owned = 0) => ({
    packId: 'ledger.part107',
    packTitle: 'Part 107',
    ruleId,
    ruleTitle: ruleId.endsWith('preflight') ? 'Preflight assessment on record' : 'Remote pilot certificate',
    paragraph: ruleId.endsWith('preflight') ? '§ 107.49' : '§ 107.12(b)',
    open,
    subjects: open,
    owned,
    cleared: 0,
    oldestOpenedAt: '2026-11-20T17:00:00.000Z',
    aboutFrom: '2026-09-02T16:00:00.000Z',
    aboutUntil: '2026-10-30T16:00:00.000Z',
  });
  const groups = (owned = 0) => ({
    shown: 'counted',
    order: 'fewest',
    groups: [group('ledger.part107.107.12.b', 3), group('ledger.part107.preflight', 60, owned)],
    total: { findings: 63, rules: 2 },
    counts,
    attention: { unowned: 63 - owned, overdue: 0 },
    filters: { subjectKinds: ['flight', 'person'], packs: [], owners: [] },
    truncated: false,
    computedAt: '2026-11-23T17:00:00.000Z',
  });
  const finding = (index: number, owner: { id: string; name: string } | null = null) => ({
    id: `finding-${index}`,
    subject: {
      scope: 'source',
      kind: 'flight',
      id: `RIDGE-F-${index}`,
      sourceId: 'operator-records',
      name: `RIDGE-F-${index}`,
    },
    packId: 'ledger.part107',
    packTitle: 'Part 107',
    ruleId: 'ledger.part107.preflight',
    ruleTitle: 'Preflight assessment on record',
    paragraph: '§ 107.49',
    summary: 'No preflight assessment is recorded for the flight.',
    evaluationId: `evaluation-${index}`,
    aboutAt: '2026-09-02T16:00:00.000Z',
    cleared: false,
    mode: 'active',
    status: owner ? 'acknowledged' : 'open',
    owner,
    openedAt: '2026-11-20T17:00:00.000Z',
    ageDays: 3,
  });
  const list = (count: number, owner: { id: string; name: string } | null = null, matching = count) => ({
    shown: 'counted',
    findings: Array.from({ length: count }, (_, index) => finding(index + 1, owner)),
    matching,
    page: { limit: 200, hasMore: false, nextCursor: null },
    counts,
    attention: { unowned: 63, overdue: 0 },
    filters: { subjectKinds: ['flight'], packs: [], owners: [] },
    truncated: false,
    computedAt: '2026-11-23T17:00:00.000Z',
  });
  const recorded = {
    command: { id: 'decision-1', kind: 'finding.treat-many', actorId: 'p-1', recordedAt: '', payload: {} },
  };

  const adoption = (id: string, packId: string, mode: string) => ({
    id,
    pack: { packId, version: 2 },
    mode,
    state: 'effective',
    effectiveInterval: { start: '2026-06-01T06:00:00.000Z', end: '2028-06-01T06:00:00.000Z' },
  });
  const ruleCoverage = (adoptionId: string, packId: string, title: string, noRecord: number[]) => ({
    adoptionId,
    packId,
    version: 2,
    title,
    rules: noRecord.map((count, index) => ({
      leafId: `${packId}.rule-${index}`,
      counts: count === -1 ? null : { no_record: count, attention: 1, supported: 4 },
    })),
  });
  const coverageReads = {
    'GET /v1/organization/coverage': {
      body: {
        adoptions: [
          adoption('adoption-1', 'ledger.part107', 'active'),
          adoption('adoption-2', 'example-ridge.waiver', 'active'),
          adoption('adoption-3', 'ledger.part108-nprm', 'shadow'),
        ],
      },
    },
    'GET /v1/organization/coverage/adoptions/adoption-1': {
      body: ruleCoverage('adoption-1', 'ledger.part107', 'Part 107', [0, -1, 0]),
    },
    'GET /v1/organization/coverage/adoptions/adoption-2': {
      body: ruleCoverage('adoption-2', 'example-ridge.waiver', 'Example waiver', [1, 0, 2]),
    },
  };

  it('prints the groups first, the rules with the fewest findings leading, in the organization’s days', async () => {
    const api = fakeApi({
      'GET /v1/me': { body: me },
      'GET /v1/organization/open-findings/groups': { body: groups() },
      ...coverageReads,
    });
    const text = await cli(['findings', 'list'], api.fetcher);
    expect(text.code, text.err).toBe(0);
    const lines = text.out.split('\n');
    expect(lines[0]).toBe(
      '63 open findings under 2 rules, the rules with the fewest first. 63 counted with no owner, 0 with an action overdue. Also on file: 4 from proposed rules (--proposed), 2 relieved by a waiver.',
    );
    expect(lines[1]).toMatch(/^Open {2}Subjects {2}Owned {2}About/);
    expect(lines[3]).toMatch(
      /^3 +3 +0 +2026-09-02 to 2026-10-30 +107\.12\.b +§ 107\.12\(b\) +Remote pilot certificate \(Part 107\)$/,
    );
    expect(lines[4]).toMatch(/^60 +60 +0 +2026-09-02 to 2026-10-30 +preflight /);
    expect(api.sent.some((request) => request.path === '/v1/organization/open-findings/groups?shown=counted')).toBe(
      true,
    );
    // It ends with what opens no finding: per adopted pack, the results that say a record is not on file.
    expect(lines.slice(-3)).toEqual([
      'Not on file is not a finding: a rule that finds no record of what it reads says so in coverage and opens no finding. Read these as well:',
      '  Part 107 (ledger.part107 version 2): no result says a record is not on file.',
      '  Example waiver (example-ridge.waiver version 2): 3 results under 2 rules say a record is not on file. Each, with its rule, subject and sentence: pnpm ledger coverage --pack example-ridge.waiver --result no_record',
    ]);
    // The shadow adoption's results go with the proposed findings, and nothing else is read.
    expect(api.sent.some((request) => request.path.includes('adoption-3'))).toBe(false);
  });

  it('still lists the findings for a credential that may not read coverage, and says where the rest is', async () => {
    const api = fakeApi({
      'GET /v1/me': { body: me },
      'GET /v1/organization/open-findings/groups': { body: groups() },
      'GET /v1/organization/coverage': {
        status: 403,
        body: { error: { code: 'capability_required', message: 'Capability flight:read is required' } },
      },
    });
    const text = await cli(['findings', 'list'], api.fetcher);
    expect(text.code, text.err).toBe(0);
    expect(text.out.split('\n').at(-1)).toBe(
      'Not on file is not a finding: a rule that finds no record of what it reads says so in coverage and opens no finding. This credential may not read coverage, so how many there are is not shown; a credential with flight:read lists them with pnpm ledger coverage --result no_record.',
    );
  });

  it('lists one rule’s findings with --rule, and refuses --rule with --all', async () => {
    const api = fakeApi({
      'GET /v1/me': { body: me },
      'GET /v1/organization/open-findings/groups': { body: groups() },
      'GET /v1/organization/open-findings': { body: list(2) },
    });
    const text = await cli(['findings', 'list', '--rule', 'preflight'], api.fetcher);
    expect(text.code, text.err).toBe(0);
    expect(text.out.split('\n')[0]).toBe(
      '2 open findings of Preflight assessment on record (preflight, § 107.49, Part 107), about 60 subjects, oldest first. 0 owned.',
    );
    expect(text.out).toContain('RIDGE-F-2  2026-09-02');
    expect(api.sent.at(-1)!.path).toContain('ruleId=ledger.part107.preflight');
    expect((await cli(['findings', 'list', '--rule', 'preflight', '--all'], api.fetcher)).code).toBe(2);
  });

  it('prints the set a person would take and sends nothing without a reason', async () => {
    const api = fakeApi({
      'GET /v1/me': { body: me },
      'GET /v1/organization/open-findings/groups': { body: groups() },
      'GET /v1/organization/open-findings': { body: list(3) },
    });
    const text = await cli(['findings', 'take', '--rule', 'preflight', '--until', '2026-10-31'], api.fetcher);
    expect(text.code, text.err).toBe(0);
    const lines = text.out.split('\n');
    expect(lines[0]).toBe('Rule: Preflight assessment on record (preflight, § 107.49, Part 107)');
    expect(lines[1]).toBe(
      'Findings: 3 open findings about 2026-10-31 or earlier, about 3 subjects, about 2026-09-02 to 2026-10-30 (America/Denver).',
    );
    expect(text.out).toContain(
      'One decision: take responsibility for all 3; you become the owner of each, and each stays open.',
    );
    expect(lines.at(-1)).toMatch(/^Not sent\. A person records it by running this again with --reason/);
    expect(api.sent.every((request) => request.method === 'GET')).toBe(true);
    expect(api.sent.at(-1)!.path).toContain('aboutUntil=2026-10-31');
  });

  it('takes the set as one decision naming each finding and how many were shown', async () => {
    const api = fakeApi({
      'GET /v1/me': { body: me },
      'GET /v1/organization/open-findings/groups': { body: groups() },
      'GET /v1/organization/open-findings': { body: list(3) },
      'POST /v1/commands': { status: 201, body: recorded },
    });
    const text = await cli(
      ['findings', 'take', '--rule', 'preflight', '--subject-kind', 'flight', '--reason', 'I review the old log'],
      api.fetcher,
    );
    expect(text.code, text.err).toBe(0);
    expect(text.out.split('\n').at(-1)).toBe(
      'Taken: 3 findings of Preflight assessment on record (preflight, § 107.49, Part 107), as one decision, decision-1. Each finding shows it.',
    );
    expect(api.sent.at(-1)).toMatchObject({
      method: 'POST',
      path: '/v1/commands',
      body: {
        kind: 'finding.treat-many',
        selection: { packId: 'ledger.part107', ruleId: 'ledger.part107.preflight', subjectKind: 'flight' },
        action: 'acknowledge',
        findings: [1, 2, 3].map((index) => ({ findingId: `finding-${index}`, evaluationId: `evaluation-${index}` })),
        shownCount: 3,
        note: 'I review the old log',
      },
    });
  });

  it('closes only findings the person owns, with why they are closed', async () => {
    const mine = { id: 'p-1', name: 'Avery Example' };
    const api = fakeApi({
      'GET /v1/me': { body: me },
      'GET /v1/organization/open-findings/groups': { body: groups() },
      'GET /v1/organization/open-findings': { body: list(3) },
    });
    const noWhy = await cli(['findings', 'close', '--rule', 'preflight', '--reason', 'Old log'], api.fetcher);
    expect(noWhy.code).toBe(2);
    expect(noWhy.err).toContain('accepted (accepted, with the reason stated)');
    const notMine = await cli(
      ['findings', 'close', '--rule', 'preflight', '--as', 'accepted', '--reason', 'Old log'],
      api.fetcher,
    );
    expect(notMine.code).toBe(1);
    expect(notMine.out).toContain('Not sent. You own 0 of these 3 findings');
    expect(api.sent.every((request) => request.method === 'GET')).toBe(true);
    const owned = fakeApi({
      'GET /v1/me': { body: me },
      'GET /v1/organization/open-findings/groups': { body: groups(3) },
      'GET /v1/organization/open-findings': { body: list(3, mine) },
      'POST /v1/commands': { status: 201, body: recorded },
    });
    const closed = await cli(
      [
        'findings',
        'close',
        '--rule',
        'preflight',
        '--as',
        'accepted',
        '--reason',
        'Our log did not record it before November',
      ],
      owned.fetcher,
    );
    expect(closed.code, closed.err).toBe(0);
    expect(closed.out).toContain('One decision: close all 3 as accepted, with the reason stated.');
    expect(owned.sent.at(-1)!.body).toMatchObject({ action: 'close', reason: 'accepted', shownCount: 3 });
  });

  it('refuses a set above the bound, and a service’s credential, sending nothing', async () => {
    const large = fakeApi({
      'GET /v1/me': { body: me },
      'GET /v1/organization/open-findings/groups': { body: groups() },
      'GET /v1/organization/open-findings': { body: list(200, null, 612) },
    });
    const refused = await cli(['findings', 'take', '--rule', 'preflight', '--reason', 'Old log'], large.fetcher);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('612 open findings of Preflight assessment on record');
    expect(refused.err).toContain('one decision covers at most 500. Narrow them by the days they are about');
    const agent = { ...me, principal: { ...me.principal, name: 'Records agent', kind: 'service' } };
    const service = fakeApi({
      'GET /v1/me': { body: agent },
      'GET /v1/organization/open-findings/groups': { body: groups() },
      'GET /v1/organization/open-findings': { body: list(3) },
    });
    const byService = await cli(['findings', 'take', '--rule', 'preflight', '--reason', 'Old log'], service.fetcher);
    expect(byService.code).toBe(1);
    expect(byService.err).toContain("Not sent. Taking and closing findings are a person's decisions");
    expect([...large.sent, ...service.sent].every((request) => request.method === 'GET')).toBe(true);
  });
});

describe('Checking a file of records from the command line', () => {
  it('says a heading that is not a field once, then each row with only its own reasons', () => {
    const unknown = 'Column "Flt #" is not a field of Flight record.';
    const row = (number: number, reasons: string[]) => ({
      row: number,
      locator: { kind: 'json_pointer' as const, value: `/records/${number - 1}` },
      status: 'refused' as const,
      missingRequired: [],
      conversions: [],
      timeConversions: [],
      reasons,
    });
    const lines = importRowLines({
      rows: [row(1, ['subjectId is needed.', unknown]), row(2, [unknown]), row(3, [unknown])],
    } as Parameters<typeof importRowLines>[0]);
    expect(lines).toEqual([
      'The columns:',
      `  ${unknown}`,
      '  Row 1: refused. subjectId is needed.',
      '  Row 2: refused. Only the columns above.',
      '  Row 3: refused. Only the columns above.',
    ]);
  });
});
