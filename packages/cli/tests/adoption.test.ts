import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { PackAdoptionRecord, RulePackVersion } from '@ledger/contracts';
import { planAdoption, runCli } from '../src/index.js';

const folder = mkdtempSync(join(tmpdir(), 'ledger-cli-adoption-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

const me = {
  principal: { id: 'p-1', name: 'Avery Example', kind: 'human', capabilities: ['pack:adopt'], revision: 1 },
  organization: { id: 'tenant-example', name: 'Example Ridge Survey', timeZone: 'America/Denver' },
};

const leaf = {
  id: 'example-ridge.procedures.visibility',
  version: 1,
  digest: 'a'.repeat(64),
  title: 'Visibility at least 3 statute miles',
  coverage: 'automated',
  adoptionParameters: [{ name: 'limit', title: 'Limit', valueType: 'number' }],
};
function pack(version: number): RulePackVersion {
  return {
    packId: 'example-ridge.procedures',
    version,
    title: 'Example Ridge procedures',
    digest: String(version).repeat(64),
    leaves: [leaf],
    bindings: [],
  } as unknown as RulePackVersion;
}

function adoption(id: string, version: number, extra: Partial<PackAdoptionRecord> = {}): PackAdoptionRecord {
  return {
    id,
    pack: pack(version),
    mode: 'active',
    state: 'effective',
    effectiveInterval: { start: '2026-06-01T06:00:00.000Z', end: '2027-06-01T06:00:00.000Z' },
    parameters: { [leaf.id]: { limit: 4828.03 } },
    actor: { name: 'Avery Example' },
    processing: { status: 'projected' },
    ...extra,
  } as unknown as PackAdoptionRecord;
}

const shown = (adoptions: PackAdoptionRecord[]) => ({
  organization: { id: 'organization:tenant-example', label: 'Example Ridge Survey', revision: 7, projectedRevision: 7 },
  asOf: '2026-11-23T12:00:00.000Z',
  adoptions,
  packOrigins: [],
  meta: { inputCut: { streams: [], principalRevision: 1 }, dependencyBasis: 'b'.repeat(64) },
});

/** An API in this process: the routes it answers, and every command posted to it. */
function api(adoptions: PackAdoptionRecord[], commandAnswers: { status: number; body: unknown }[] = []) {
  const posted: Record<string, unknown>[] = [];
  const answers = [...commandAnswers];
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const path = new URL(String(input)).pathname;
    const reply = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/v1/me') return reply(200, me);
    if (path === '/v1/rule-packs')
      return reply(200, { packs: [1, 2].map((version) => ({ packId: pack(version).packId, version })) });
    const version = /^\/v1\/rule-packs\/[^/]+\/versions\/(\d+)$/.exec(path)?.[1];
    if (version) return reply(200, { pack: pack(Number(version)) });
    if (path === '/v1/organization/coverage') return reply(200, shown(adoptions));
    if (path === '/v1/commands' && init.method === 'POST') {
      posted.push(JSON.parse(String(init.body)));
      const answer = answers.shift() ?? { status: 201, body: { command: { id: `adoption-${posted.length}` } } };
      return reply(answer.status, answer.body);
    }
    return reply(404, { error: { code: 'not_found', message: 'No such route' } });
  }) as typeof fetch;
  return { fetcher, posted };
}

async function cli(argv: string[], fetcher: typeof fetch, pause?: (milliseconds: number) => Promise<void>) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    env: { LEDGER_TOKEN: 'ledger-dev-test', LEDGER_API_URL: 'http://ledger.invalid' },
    folders: [folder],
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    fetcher,
    ...(pause ? { pause } : {}),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const reason = ['--reason', 'Avery Example corrects the visibility limit.'];

describe('Adopting a pack the organization has adopted already, from the command line', () => {
  it('replaces an earlier version from the start given, saying when each version is in effect in the zone', async () => {
    const { fetcher, posted } = api([adoption('adoption-v1', 1)]);
    const printed = await cli(['packs', 'adopt', 'example-ridge.procedures', '--from', '2026-12-01'], fetcher);
    expect(printed.code, printed.err).toBe(0);
    expect(printed.out).toContain(
      'Replaces: adoption adoption-v1 of example-ridge.procedures version 1 (active, from 2026-06-01 00:00 America/Denver until 2027-06-01 00:00 America/Denver, adopted by Avery Example).',
    );
    expect(printed.out).toContain(
      'Version 1 stays in effect until 2026-12-01 00:00 America/Denver and ends there; what was recorded under it keeps it.',
    );
    expect(printed.out).toContain(
      'Version 2 is in effect from 2026-12-01 00:00 America/Denver until 2027-06-01 00:00 America/Denver, where version 1 was to end.',
    );
    expect(printed.out).toContain('= 4828.03, from adoption adoption-v1');
    expect(printed.out).toContain('Not sent.');
    expect(posted).toEqual([]);

    const sent = await cli(['packs', 'adopt', 'example-ridge.procedures', '--from', '2026-12-01', ...reason], fetcher);
    expect(sent.code, sent.err).toBe(0);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      kind: 'rule-pack.adopt',
      succeeds: 'adoption-v1',
      mode: 'active',
      expectedRevision: 7,
      pack: { packId: 'example-ridge.procedures', version: 2 },
      effectiveInterval: { start: '2026-12-01T07:00:00.000Z', end: '2027-06-01T06:00:00.000Z' },
      parameters: { [leaf.id]: { limit: 4828.03 } },
      note: 'Avery Example corrects the visibility limit.',
    });
    expect(sent.out).toMatch(/^Adopted; it replaces the earlier version from its start\. Adoption adoption-1\./m);

    const json = await cli(
      ['packs', 'adopt', 'example-ridge.procedures', '--from', '2026-12-01', ...reason, '--json'],
      fetcher,
    );
    expect(JSON.parse(json.out)).toMatchObject({ sent: true, action: 'succeed', command: posted[1] });
  });

  it('replaces the earlier version for its whole period from its start or earlier', async () => {
    const { fetcher, posted } = api([adoption('adoption-v1', 1)]);
    const whole = await cli(['packs', 'adopt', 'example-ridge.procedures', '--from', '2026-06-01', ...reason], fetcher);
    expect(whole.code, whole.err).toBe(0);
    expect(whole.out).toContain(
      'Version 1 is replaced for its whole period: it is in effect at no time, and version 2 covers every day it covered.',
    );
    expect(whole.out).toContain(
      'A finding opened under version 1 stays open, and the evaluation under version 2 of the same rule becomes its latest.',
    );
    expect(whole.out).toContain(
      'Version 2 is in effect from 2026-06-01 00:00 America/Denver until 2027-06-01 00:00 America/Denver, where version 1 was to end.',
    );
    expect(posted[0]).toMatchObject({
      succeeds: 'adoption-v1',
      effectiveInterval: { start: '2026-06-01T06:00:00.000Z', end: '2027-06-01T06:00:00.000Z' },
    });

    const earlier = await cli(['packs', 'adopt', 'example-ridge.procedures', '--from', '2026-05-20'], fetcher);
    expect(earlier.code, earlier.err).toBe(0);
    expect(earlier.out).toContain('Version 1 is replaced for its whole period');

    const short = await cli(
      ['packs', 'adopt', 'example-ridge.procedures', '--from', '2026-06-01', '--until', '2027-01-01'],
      fetcher,
    );
    expect(short.code).toBe(2);
    expect(short.err).toContain(
      'version 2 replaces it for its whole period, so it is in effect at least until 2027-06-01 00:00 America/Denver',
    );

    const late = await cli(['packs', 'adopt', 'example-ridge.procedures', '--from', '2027-07-01'], fetcher);
    expect(late.code).toBe(2);
    expect(late.err).toContain(
      'or 2026-06-01 00:00 America/Denver or earlier to replace version 1 for its whole period',
    );
  });

  it('starts the new version now when no start is given', () => {
    const now = Date.parse('2026-11-23T18:30:15.250Z');
    const plan = planAdoption(pack(2), [adoption('adoption-v1', 1)], { packId: 'p', set: [], setAll: [] }, 'UTC', now);
    expect(plan.action.kind).toBe('succeed');
    expect(plan.interval).toEqual({ start: '2026-11-23T18:30:15.000Z', end: '2027-06-01T06:00:00.000Z' });
    expect(plan.lines.at(-1)).toContain('from 2026-11-23 18:30:15 UTC, now until');
  });

  it('revises the same version with new dates, keeping mode and values, and refuses a revision that changes nothing', async () => {
    const { fetcher, posted } = api([adoption('adoption-v2', 2)]);
    const revised = await cli(
      ['packs', 'adopt', 'example-ridge.procedures', '--until', '2027-12-31', ...reason],
      fetcher,
    );
    expect(revised.code, revised.err).toBe(0);
    expect(revised.out).toContain('Revises: adoption adoption-v2 of example-ridge.procedures version 2');
    expect(revised.out).toContain(
      'Until: 2027-06-01 00:00 America/Denver becomes the end of 2027-12-31 in America/Denver (2028-01-01T07:00:00.000Z).',
    );
    expect(revised.out).toMatch(/^Revised\. Adoption adoption-1\./m);
    expect(posted[0]).toMatchObject({
      revises: 'adoption-v2',
      mode: 'active',
      effectiveInterval: { start: '2026-06-01T06:00:00.000Z', end: '2028-01-01T07:00:00.000Z' },
      parameters: { [leaf.id]: { limit: 4828.03 } },
    });
    expect(posted[0]).not.toHaveProperty('succeeds');

    const unchanged = await cli(['packs', 'adopt', 'example-ridge.procedures', '--mode', 'active'], fetcher);
    expect(unchanged.code).toBe(2);
    expect(unchanged.err).toContain('Nothing would change');
    const values = await cli(['packs', 'adopt', 'example-ridge.procedures', '--set-all', 'limit=8046.72'], fetcher);
    expect(values.code, values.err).toBe(0);
    expect(values.out).toContain('Values: as listed below.');
  });

  it('keeps the start of a revision of a successor, where the earlier version ends', async () => {
    const successor = adoption('adoption-v2', 2, {
      succeeds: 'adoption-v1',
      effectiveInterval: { start: '2026-12-01T07:00:00.000Z', end: '2027-06-01T06:00:00.000Z' },
    });
    const earlier = adoption('adoption-v1', 1, {
      state: 'succeeded',
      succeededBy: { id: 'adoption-v2', version: 2, start: '2026-12-01T07:00:00.000Z' },
    });
    const { fetcher } = api([successor, earlier]);
    const moved = await cli(['packs', 'adopt', 'example-ridge.procedures', '--from', '2026-12-15'], fetcher);
    expect(moved.code).toBe(2);
    expect(moved.err).toContain('A revision keeps that start');
  });

  it('sends again on a fresh basis after a concurrent change, waiting longer each time, and says it is safe to send again', async () => {
    const busy = { status: 409, body: { error: { code: 'concurrent_change', message: 'Relevant records changed' } } };
    const waits: number[] = [];
    const pause = async (milliseconds: number) => void waits.push(milliseconds);
    const once = api([], [busy]);
    const dates = ['--mode', 'shadow', '--from', '2026-06-01', '--until', '2027-05-31', '--set-all', 'limit=1'];
    const sent = await cli(['packs', 'adopt', 'example-ridge.procedures', ...dates, ...reason], once.fetcher, pause);
    expect(sent.code, sent.err).toBe(0);
    expect(sent.out).toContain('Sending it again on a fresh basis in 0.5 s (attempt 2 of 6).');
    expect(sent.out).toContain('Sent after 1 concurrent change, on a fresh basis.');
    expect(once.posted).toHaveLength(2);

    waits.length = 0;
    const always = api(
      [],
      Array.from({ length: 6 }, () => busy),
    );
    const refused = await cli(
      ['packs', 'adopt', 'example-ridge.procedures', ...dates, ...reason],
      always.fetcher,
      pause,
    );
    expect(refused.code).toBe(1);
    expect(always.posted).toHaveLength(6);
    // Backing off, bounded: the whole wait stays under 20 seconds.
    expect(waits).toEqual([500, 1000, 2000, 4000, 8000]);
    expect(waits.reduce((sum, wait) => sum + wait, 0)).toBeLessThan(20_000);
    expect(refused.out).toContain(
      'Nothing was recorded by this command, so it is safe to send again as it is, in a minute or so.',
    );
    expect(refused.err).toContain('409 concurrent_change');

    const stale = api([], [{ status: 409, body: { error: { code: 'stale_basis', message: 'Changed' } } }]);
    const notRetried = await cli(['packs', 'adopt', 'example-ridge.procedures', ...dates, ...reason], stale.fetcher);
    expect(notRetried.code).toBe(1);
    expect(stale.posted).toHaveLength(1);
  });
});

describe('Showing an organization’s own pack', () => {
  it('prints the fields each rule reads, as the pack file was built, for a pack from its own file only', async () => {
    const checked = {
      id: 'example-ridge.procedures.visibility',
      version: 1,
      digest: 'a'.repeat(64),
      title: 'Visibility at least 3 statute miles',
      coverage: 'automated',
      adoptionParameters: [],
      reads: [
        {
          name: 'quantity',
          where: [{ field: 'values.recordType', oneOf: ['flight.preflight-assessment'] }],
        },
      ],
      check: { kind: 'value.within-limit', version: 2, params: { field: 'values.record.visibilityMeters' } },
    };
    const shownPack = { ...pack(1), leaves: [checked] };
    const answer = (origin: object) =>
      (async (input: string | URL | Request) => {
        const path = new URL(String(input)).pathname;
        const body =
          path === '/v1/rule-packs'
            ? { packs: [{ packId: shownPack.packId, version: 1, origin }] }
            : { pack: shownPack };
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;
    const own = await cli(
      ['packs', 'show', 'example-ridge.procedures'],
      answer({ kind: 'organization_file', file: 'example-ridge.procedures-v1.pack.json' }),
    );
    expect(own.code, own.err).toBe(0);
    expect(own.out).toContain('Fields each rule reads, as the pack file was built:');
    expect(own.out).toContain(
      '  visibility: values.recordType (read quantity, condition); values.record.visibilityMeters (check parameter field)',
    );
    const builtIn = await cli(['packs', 'show', 'example-ridge.procedures'], answer({ kind: 'built_in' }));
    expect(builtIn.out).not.toContain('Fields each rule reads');
  });
});
