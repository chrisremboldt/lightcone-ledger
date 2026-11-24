import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import { setUpCredential } from '../../apps/api/src/credential-setup.js';
import { parseOrganizationSetup, setUpOrganization } from '../../apps/api/src/organization-setup.js';
import {
  revisionCommand,
  type OrganizationCoverageResponse,
  type PackAdoptionRecord,
} from '../../packages/contracts/src/index.js';
import { adoptionInstant, runCli } from '../../packages/cli/src/index.js';
import { buildPackFolder } from '../../packages/standard-packs/src/index.js';
import { createPool, MemoryObjectStore } from '../../packages/persistence/src/index.js';
import { settleOwnedWork } from './worker-queue.js';

// A pack file corrected after it was adopted, as an operator's agent does it from the command line: adopt version 1,
// build version 2, adopt it in its place, then revise its dates. Every step goes through the client's own code.
const example = join(import.meta.dirname, '..', '..', 'examples', 'first-operator', 'waiver');
const run = randomUUID().slice(0, 8);
const tenantId = `tenant-pack-replacement-${run}`;
const waiverPack = 'example-ridge.waiver-107w-ex-2026-00417';
const DAY = 86_400_000;
const day = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

describe.runIf(process.env.LEDGER_ENV !== 'staging')('Replacing an adopted pack from the command line', () => {
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const packs = mkdtempSync(join(tmpdir(), 'ledger-pack-replacement-'));
  const work = mkdtempSync(join(tmpdir(), 'ledger-pack-replacement-folder-'));
  let app: Awaited<ReturnType<typeof createApp>>;
  let token: string;
  let service: string;

  /** fetch, answered by the API in this process. */
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const response = await app.inject({
      method: (init.method ?? 'GET') as 'GET',
      url: url.pathname + url.search,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      ...(typeof init.body === 'string' ? { payload: init.body } : {}),
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
      folders: [work],
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      fetcher,
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  /** The adoption as a person sends it, after the service's credential is refused the same adoption. */
  async function adopt(...argv: string[]) {
    const refused = await ledger(service, 'packs', 'adopt', waiverPack, ...argv, '--reason', 'Not a person');
    expect(refused.code, refused.out).toBe(1);
    expect(refused.err).toContain("Not sent. An adoption is a person's decision");
    const sent = await ledger(token, 'packs', 'adopt', waiverPack, ...argv, '--json');
    expect(sent.code, sent.err).toBe(0);
    await settleOwnedWork([tenantId]);
    return JSON.parse(sent.out) as { adoptionId: string; action: string; command: Record<string, unknown> };
  }

  async function coverage(): Promise<OrganizationCoverageResponse> {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/organization/coverage',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }

  /** pnpm pack:build <folder> --out <packs>. */
  function build(folder: string): void {
    const built = buildPackFolder(folder);
    writeFileSync(
      join(packs, `${built.file.packId}-v${built.file.version}.pack.json`),
      `${JSON.stringify(built.file, null, 2)}\n`,
    );
  }

  beforeAll(async () => {
    // Both versions are built before Ledger starts: a process registers a pack's versions once, when it starts, so
    // a version built later is loaded by restarting Ledger, which a test in one process cannot do.
    build(example);
    const corrected = join(work, 'waiver');
    cpSync(example, corrected, { recursive: true });
    const description = readFileSync(join(corrected, 'pack.yaml'), 'utf8');
    // The corrected waiver: provision 2's height, mistyped in version 1.
    writeFileSync(
      join(corrected, 'pack.yaml'),
      description
        .replace('  version: 1\n', '  version: 2\n')
        .replace('maxFeetAboveGround: 200', 'maxFeetAboveGround: 250'),
    );
    build(corrected);
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
        `pack-replacement-${run}`,
      ]),
      'local',
      [],
    );
    if (!created.created || !created.developmentToken) throw new Error('The organization should be new');
    token = created.developmentToken;
    const issued = await setUpCredential(admin, {
      tenantId,
      principal: 'Records agent',
      label: 'Coding agent on the office computer',
      add: { kind: 'service', capabilities: ['pack:adopt', 'flight:read', 'evidence:read'], observationGrants: [] },
    });
    service = issued.credential.secret;
  });
  afterAll(async () => {
    await settleOwnedWork([tenantId]);
    await app?.close();
    await pool.end();
    await admin.end();
    rmSync(packs, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });

  it('adopts version 1, replaces it with version 2 and revises the dates; the coverage reads version 2', async () => {
    const first = await adopt(
      '--version',
      '1',
      '--mode',
      'active',
      '--from',
      day(-30),
      '--until',
      day(400),
      '--reason',
      'Adopted as issued.',
    );
    expect(first.action).toBe('adopt');

    const preview = await ledger(token, 'packs', 'adopt', waiverPack);
    expect(preview.code, preview.err).toBe(0);
    expect(preview.out).toContain(`Replaces: adoption ${first.adoptionId} of ${waiverPack} version 1 (active, from `);
    expect(preview.out).toMatch(
      /Version 1 stays in effect until \d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})? America\/Denver and ends there/,
    );
    expect(preview.out).toContain('Not sent.');

    const second = await adopt('--reason', 'Avery Example corrects the height in provision 2.');
    expect(second.action).toBe('succeed');
    expect(second.command).toMatchObject({ succeeds: first.adoptionId, pack: { version: 2 }, mode: 'active' });

    const revised = await adopt('--until', day(500), '--reason', 'The waiver was renewed for longer.');
    expect(revised.action).toBe('revise');
    expect(revised.command).toMatchObject({ revises: second.adoptionId, pack: { version: 2 } });

    const shown = (await coverage()).adoptions;
    const byId = (id: string) => shown.find((item) => item.id === id)!;
    expect(byId(first.adoptionId)).toMatchObject({ state: 'succeeded', succeededBy: { id: second.adoptionId } });
    expect(byId(second.adoptionId)).toMatchObject({ state: 'revised', revisedBy: revised.adoptionId });
    expect(byId(revised.adoptionId)).toMatchObject({ state: 'effective', pack: { version: 2 } });
    expect(byId(revised.adoptionId).effectiveInterval).toEqual({
      start: byId(second.adoptionId).effectiveInterval.start,
      end: adoptionInstant(day(500), 'America/Denver', 'until').instant,
    });

    const read = await ledger(token, 'coverage', '--pack', waiverPack, '--json');
    expect(read.code, read.err).toBe(0);
    const adoptions = JSON.parse(read.out).adoptions as {
      adoption: PackAdoptionRecord;
      coverage: { version: number };
    }[];
    expect(adoptions).toHaveLength(1);
    expect(adoptions[0]!.adoption.id).toBe(revised.adoptionId);
    expect(adoptions[0]!.coverage.version).toBe(2);
    const text = await ledger(token, 'coverage', '--pack', waiverPack);
    expect(text.out).toContain(`(${waiverPack} version 2), active, effective`);

    // Nothing left to change: the client says so and sends nothing.
    const unchanged = await ledger(token, 'packs', 'adopt', waiverPack, '--reason', 'Again');
    expect(unchanged.code).toBe(2);
    expect(unchanged.err).toContain('Nothing would change');
  }, 240_000);

  it('refuses a revision that moves the start of an adoption succeeding an earlier version', async () => {
    const shown = await coverage();
    const standing = shown.adoptions.find((item) => item.pack.packId === waiverPack && !item.revisedBy)!;
    const moved = revisionCommand(shown, standing, {
      note: 'Moves the start',
      effectiveInterval: { start: new Date(Date.now() + DAY).toISOString(), end: standing.effectiveInterval.end },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/commands',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
      payload: moved,
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().error).toMatchObject({ code: 'invalid_adoption_revision' });
    expect(response.json().error.message).toContain('a revision keeps that start');
  });
});
