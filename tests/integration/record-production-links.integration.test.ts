import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import type { RecordLink, RecordLinkCreated, SharedRecords } from '../../packages/contracts/src/index.js';
import { readZip } from '../../packages/evidence/src/zip.js';
import { createPool, MemoryObjectStore } from '../../packages/persistence/src/index.js';
import { caller, dispatcher } from './reader-fixtures.js';
import { settleOwnedWork } from './worker-queue.js';

/**
 * A link to one produced set: made by whoever may produce records, opened without signing in, each opening kept,
 * revoked at once. Unknown, expired and revoked links answer alike, and a link opens its own set and nothing else.
 */
describe.runIf(process.env.LEDGER_ENV !== 'staging')('A link to one produced set of records', () => {
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const store = new MemoryObjectStore();
  const run = randomUUID().slice(0, 8);
  let app: Awaited<ReturnType<typeof createApp>>;
  const { call, read, importRecords, produce, addReader } = caller(() => app);
  const alpha = dispatcher('alpha');
  const beta = dispatcher('beta');
  let first: any;
  let second: any;
  let other: any;

  beforeAll(async () => {
    app = await createApp({ pool, env: 'test', objectStore: store });
    await app.ready();
    await importRecords(alpha, 'aircraft.identity', run);
    await importRecords(beta, 'aircraft.identity', `${run}-beta`);
    first = await produce(alpha, `${run}-RIDGE-AC-1`);
    second = await produce(alpha, `${run}-RIDGE-AC-2`);
    other = await produce(beta, `${run}-beta-RIDGE-AC-1`);
  });
  afterAll(async () => {
    await settleOwnedWork(['tenant-alpha', 'tenant-beta'], { objectStore: store });
    await app?.close();
    await pool.end();
    await admin.end();
  });

  /** A request the page of a link makes: no sign-in, the secret in the body. */
  const opened = (url: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url, payload, headers: { 'content-type': 'application/json' } });
  async function makeLink(production: any, note: string, token = alpha, expiresInDays?: number) {
    const response = await call(token, 'POST', `/v1/record-productions/${production.id}/links`, {
      note,
      ...(expiresInDays ? { expiresInDays } : {}),
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as RecordLinkCreated;
  }
  const links = async (production: any, token = alpha) =>
    (await read<{ links: RecordLink[] }>(token, `/v1/record-productions/${production.id}/links`)).links;
  const plain = (response: { statusCode: number; json: () => any }) => {
    const { requestId: _requestId, ...rest } = response.json();
    return { status: response.statusCode, ...rest };
  };
  const expectPrivate = (headers: Record<string, unknown>) =>
    expect(headers).toMatchObject({
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex',
    });

  it('opens one set to someone who does not sign in, and keeps each opening without who opened it', async () => {
    const made = await makeLink(first, 'For the inspector from the regional office');
    expect(made.secret).toMatch(/^ledger-records-[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(made.secret.slice('ledger-records-'.length), 'base64url')).toHaveLength(32);
    const days = (Date.parse(made.link.expiresAt) - Date.parse(made.link.createdAt)) / 86_400_000;
    expect(days).toBe(7);
    expect(made.link).toMatchObject({ state: 'open', note: 'For the inspector from the regional office' });
    expect(made.link.createdBy.id).toBe('principal-alpha-operator');

    // Only the SHA-256 of the secret is kept.
    const kept = await admin.query('SELECT secret_sha256 FROM record_production_links WHERE id=$1', [made.link.id]);
    expect(kept.rows[0].secret_sha256).toBe(createHash('sha256').update(made.secret).digest('hex'));
    const stored = JSON.stringify(
      (
        await admin.query(
          'SELECT * FROM journal_events WHERE id IN (SELECT create_event_id FROM record_production_links WHERE id=$1)',
          [made.link.id],
        )
      ).rows,
    );
    expect(stored).not.toContain(made.secret);

    const page = await opened('/v1/shared-records', { secret: made.secret });
    expect(page.statusCode, page.body).toBe(200);
    expectPrivate(page.headers);
    const shown = page.json() as SharedRecords;
    expect(shown.organization.name).toBeTruthy();
    expect(shown.set).toMatchObject({
      reason: 'Aircraft records asked for at an inspection',
      archiveSha256: first.archiveSha256,
      manifestSha256: first.manifestSha256,
    });
    const records = shown.files.find((file) => file.role === 'records')!;
    const file = await opened('/v1/shared-records/file', { secret: made.secret, path: records.path });
    expect(file.statusCode, file.body).toBe(200);
    expectPrivate(file.headers);
    expect(createHash('sha256').update(file.rawPayload).digest('hex')).toBe(records.sha256);
    expect(file.body).toContain(`${run}-RIDGE-AC-1`);
    expect(file.body).not.toContain(`${run}-RIDGE-AC-2`);
    const manifest = await opened('/v1/shared-records/file', { secret: made.secret, path: 'manifest.json' });
    expect(createHash('sha256').update(manifest.rawPayload).digest('hex')).toBe(first.manifestSha256);
    const archive = await opened('/v1/shared-records/archive', { secret: made.secret });
    expect(archive.statusCode).toBe(200);
    expectPrivate(archive.headers);
    expect(archive.headers['content-type']).toContain('application/zip');
    expect(createHash('sha256').update(archive.rawPayload).digest('hex')).toBe(first.archiveSha256);
    expect(readZip(archive.rawPayload).has('manifest.json')).toBe(true);

    const [listed] = await links(first);
    expect(listed!.openings.map((opening) => [opening.opened, opening.path])).toEqual([
      ['archive', null],
      ['file', 'manifest.json'],
      ['file', records.path],
      ['page', null],
    ]);
    const columns = await admin.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name='record_production_link_openings'",
    );
    expect(columns.rows.map((row) => row.column_name).sort()).toEqual(
      ['id', 'link_id', 'opened', 'opened_at', 'path', 'tenant_id'].sort(),
    );
  });

  it('opens only its own set: no other set’s file, and nothing of another organization', async () => {
    const made = await makeLink(first, 'For the auditor');
    const shownSecond = (
      await opened('/v1/shared-records', { secret: (await makeLink(second, 'Second set')).secret })
    ).json() as SharedRecords;
    const secondOnly = shownSecond.files.find((file) => file.role === 'records')!;
    // Both sets name their records file alike; through the first set's link it is the first set's file.
    const file = await opened('/v1/shared-records/file', { secret: made.secret, path: secondOnly.path });
    expect(file.body).toContain(`${run}-RIDGE-AC-1`);
    expect(file.body).not.toContain(`${run}-RIDGE-AC-2`);
    const otherShown = (
      await opened('/v1/shared-records', { secret: (await makeLink(other, 'Beta set', beta)).secret })
    ).json() as SharedRecords;
    for (const otherFile of otherShown.files.filter(
      (item) => !shownSecond.files.some((mine) => mine.path === item.path),
    )) {
      const refused = await opened('/v1/shared-records/file', { secret: made.secret, path: otherFile.path });
      expect(refused.statusCode).toBe(404);
      expect(refused.json().error.code).toBe('shared_file_not_found');
    }
    for (const path of ['../manifest.json', '/manifest.json', 'records/', 'index.html/../manifest.json'])
      expect((await opened('/v1/shared-records/file', { secret: made.secret, path })).statusCode).toBe(404);
    // A link of another organization's set is not listed, and cannot be revoked, from this one.
    const betaLink = (await links(other, beta))[0]!;
    expect((await call(alpha, 'GET', `/v1/record-productions/${other.id}/links`)).statusCode).toBe(404);
    const crossRevoke = await call(alpha, 'POST', `/v1/record-production-links/${betaLink.id}/revoke`, {
      reason: 'Not ours',
    });
    expect(crossRevoke.statusCode).toBe(404);
  });

  it('answers unknown, expired and revoked links alike, and a revoked link at once', async () => {
    const made = await makeLink(first, 'For the inspector, revoked after the visit', alpha, 3);
    expect((await opened('/v1/shared-records', { secret: made.secret })).statusCode).toBe(200);
    const revoked = await call(alpha, 'POST', `/v1/record-production-links/${made.link.id}/revoke`, {
      reason: 'The inspection is over',
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(revoked.json().link).toMatchObject({
      state: 'revoked',
      revokeReason: 'The inspection is over',
      revokedBy: { id: 'principal-alpha-operator' },
    });
    const again = await call(alpha, 'POST', `/v1/record-production-links/${made.link.id}/revoke`, { reason: 'Twice' });
    expect(again.statusCode).toBe(409);

    // An expired link, kept as a link made ten days ago for three days would be.
    const expiredSecret = `ledger-records-${randomBytes(32).toString('base64url')}`;
    await admin.query(
      `INSERT INTO record_production_links(id,tenant_id,production_id,note,secret_sha256,create_event_id,created_by,
         created_at,expires_at)
       SELECT $1,tenant_id,production_id,'Expired',$2,create_event_id,created_by,now()-interval '10 days',
         now()-interval '7 days' FROM record_production_links WHERE id=$3`,
      [`record-link-${randomUUID()}`, createHash('sha256').update(expiredSecret).digest('hex'), made.link.id],
    );
    const unknown = `ledger-records-${randomBytes(32).toString('base64url')}`;
    const answers = [];
    for (const secret of [made.secret, expiredSecret, unknown, 'not a link at all']) {
      answers.push(plain(await opened('/v1/shared-records', { secret })));
      answers.push(plain(await opened('/v1/shared-records/archive', { secret })));
      const file = await opened('/v1/shared-records/file', { secret, path: 'manifest.json' });
      answers.push(plain(file));
      expectPrivate(file.headers);
    }
    expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1);
    expect(answers[0]).toEqual({
      status: 404,
      error: {
        code: 'record_link_not_in_use',
        message: 'This link does not open any records. It may have expired or been revoked.',
      },
    });
    const states = (await links(first)).map((link) => [link.note, link.state]);
    expect(states).toContainEqual(['For the inspector, revoked after the visit', 'revoked']);
    expect(states).toContainEqual(['Expired', 'expired']);
    const openingsAfter = (await links(first)).find((link) => link.id === made.link.id)!.openings;
    expect(openingsAfter.map((opening) => opening.opened)).toEqual(['page']);
  });

  it('is made only by someone who may produce records, for at most ninety days', async () => {
    const reader = await addReader(alpha, `Morgan Example ${run}`);
    const refused = await call(reader.token, 'POST', `/v1/record-productions/${first.id}/links`, { note: 'Mine' });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('reads_only');
    // A reader sees the links of a set they may read, never a secret.
    const seen = await call(reader.token, 'GET', `/v1/record-productions/${first.id}/links`);
    expect(seen.statusCode).toBe(200);
    expect(seen.body).not.toContain('ledger-records-');
    const tooLong = await call(alpha, 'POST', `/v1/record-productions/${first.id}/links`, {
      note: 'A year',
      expiresInDays: 91,
    });
    expect(tooLong.statusCode).toBe(400);
    const longest = await makeLink(first, 'The whole audit', alpha, 90);
    expect((Date.parse(longest.link.expiresAt) - Date.parse(longest.link.createdAt)) / 86_400_000).toBe(90);
    const unknownSet = await call(alpha, 'POST', '/v1/record-productions/no-such-set/links', { note: 'None' });
    expect(unknownSet.statusCode).toBe(404);
  });
});
