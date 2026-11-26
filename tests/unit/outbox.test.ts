import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LedgerClient } from '../../packages/contracts/src/client.js';
import { describeWrittenAt, parseRecordFile } from '../../packages/contracts/src/index.js';
import { listOperatorRecordTypes } from '../../packages/domain/src/operator-record-import.js';
import { emptyDraft, entryDocument } from '../../apps/web/src/operator-records.js';
import {
  deliver,
  memoryStore,
  newEntry,
  readEntry,
  revisedEntry,
  sendWaiting,
  shownTo,
  toSend,
  type EntryContent,
  type EntryOwner,
  type OutboxEntry,
} from '../../apps/web/src/outbox.js';

// The outbox of entries kept on a device until Ledger acknowledges them (docs/design/offline-entry.md), against a
// stand-in for the API that answers as the real one does, keyed by the idempotency key.

const avery: EntryOwner = { principalId: 'principal-ridge-avery', tenantId: 'tenant-ridge', name: 'Avery Example' };
const quinn: EntryOwner = { principalId: 'principal-ridge-quinn', tenantId: 'tenant-ridge', name: 'Quinn Example' };
const flightRecord = listOperatorRecordTypes().find((type) => type.recordType === 'flight.record')!;
const narrative = 'Loose prop guard on RIDGE-AC-1 before the morning flight';

function recordContent(subjectId: string, writtenAt: string): EntryContent {
  const draft = { ...emptyDraft(flightRecord), subjectId, values: { takeoffAt: '2026-11-25T09:30' } };
  return {
    kind: 'record',
    title: flightRecord.title,
    subject: subjectId,
    recordType: flightRecord.recordType,
    recordVersion: flightRecord.recordVersion,
    sourceId: 'operator-records',
    document: JSON.stringify(entryDocument(flightRecord, draft, undefined, writtenAt), null, 2),
    draft,
  };
}
function reportContent(writtenAt: string): EntryContent {
  const draft = { whatWasSeen: narrative, occurredAt: '', where: 'Ridge pad 2', contact: '', named: false };
  return { kind: 'report', report: { whatWasSeen: narrative, where: 'Ridge pad 2', named: false, writtenAt }, draft };
}

type Answer = 'offline' | 'ok' | { status: number; body: unknown };

/** The API as the outbox meets it: uploads, a commit and a report, each answering its key the same way twice. */
function api() {
  const keys = new Map<string, string>();
  const uploads = new Map<
    string,
    { byteLength: number; contentType: string; sha256?: string; status: string; artifactId?: string }
  >();
  const committed = new Map<string, string>();
  const reports = new Map<string, string>();
  const sent: { method: string; path: string; key: string | null; body: unknown }[] = [];
  const next: Answer[] = [];
  const state = { answer: 'ok' as Answer, recordRefusal: null as string[] | null };
  const json = (status: number, body: unknown) => Response.json(body, { status });
  const fetcher = (async (input: string, init: RequestInit = {}) => {
    const path = new URL(input).pathname;
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    const key = headers.get('idempotency-key');
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    sent.push({ method, path, key, body });
    const answer = next.shift() ?? state.answer;
    if (answer === 'offline') throw new TypeError('Failed to fetch');
    if (answer !== 'ok') return json(answer.status, answer.body);
    if (!headers.get('authorization')) return json(401, { error: { code: 'unauthenticated', message: 'Sign in' } });
    const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const once = (endpoint: string, content: unknown) => {
      const seen = keys.get(`${endpoint}|${key}`);
      if (seen !== undefined && seen !== digest(content)) return false;
      keys.set(`${endpoint}|${key}`, digest(content));
      return true;
    };
    if (method === 'POST' && path === '/v1/uploads') {
      if (!once(path, body)) return json(409, { error: { code: 'idempotency_conflict', message: 'Different' } });
      const id = `upload-${key}`;
      if (!uploads.has(id))
        uploads.set(id, { ...(body as { byteLength: number; contentType: string }), status: 'pending' });
      return json(201, { upload: { id, ...uploads.get(id) } });
    }
    const [, , , encoded, step] = path.split('/');
    const id = decodeURIComponent(encoded ?? '');
    if (method === 'PUT' && step === 'content') {
      const bytes = new Uint8Array(init.body as Uint8Array);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const upload = uploads.get(id)!;
      if (upload.sha256 && upload.sha256 !== sha256)
        return json(409, {
          error: { code: 'immutable_object_conflict', message: 'Upload already contains different bytes' },
        });
      Object.assign(upload, { sha256, status: 'stored' });
      return json(200, { upload: { id, ...upload } });
    }
    if (method === 'POST' && step === 'finalize') {
      const upload = uploads.get(id)!;
      Object.assign(upload, { status: 'finalized', artifactId: `artifact-${id}` });
      const { sha256, byteLength, contentType } = upload;
      return json(201, { artifact: { id: `artifact-${id}`, uploadId: id, sha256, byteLength, contentType } });
    }
    if (method === 'POST' && path === '/v1/operator-records/imports') {
      const artifactId = (body as { artifactId: string }).artifactId;
      if (state.recordRefusal)
        return json(200, { rows: [{ row: 1, status: 'refused', reasons: state.recordRefusal }], summary: {} });
      const known = committed.get(artifactId);
      if (!known) committed.set(artifactId, `record-${committed.size + 1}`);
      return json(known ? 200 : 201, {
        rows: [
          {
            row: 1,
            status: known ? 'already_recorded' : 'recorded',
            observationId: committed.get(artifactId),
            reasons: [],
          },
        ],
      });
    }
    if (method === 'POST' && path === '/v1/safety-reports') {
      if (!once(path, body)) return json(409, { error: { code: 'idempotency_conflict', message: 'Different' } });
      if (reports.has(key!))
        return json(409, { error: { code: 'safety_report_already_received', message: 'Already received' } });
      reports.set(key!, 'RK7Q-2MXD-9PJA-4TZC-H8WN');
      return json(201, { receipt: { code: reports.get(key!) } });
    }
    return json(404, { error: { code: 'not_found', message: 'Not found' } });
  }) as unknown as typeof fetch;
  const client = (token: string | null = 'ledger-dev-ridge-avery') =>
    new LedgerClient('http://ledger.test', token, fetcher);
  return { client, sent, state, next, committed, reports };
}

const at = (minute: number) => `2026-11-25T14:${String(minute).padStart(2, '0')}:00.000Z`;

describe('entries kept on a device until Ledger has them', () => {
  it('keeps an entry while Ledger cannot be reached, and deletes its content the moment Ledger acknowledges it', async () => {
    const store = memoryStore();
    const ledger = api();
    const entry = newEntry(avery, reportContent(at(3)), at(3));
    await store.put(entry);
    ledger.state.answer = 'offline';
    expect(await sendWaiting(store, ledger.client(), avery)).toEqual({ sent: 0, refused: 0, waiting: 1 });
    expect(readEntry((await store.entries())[0])).toMatchObject({ id: entry.id, state: { status: 'waiting' } });

    ledger.state.answer = 'ok';
    expect(await sendWaiting(store, ledger.client(), avery)).toEqual({ sent: 1, refused: 0, waiting: 0 });
    expect(await store.entries()).toEqual([]);
    const [receipt] = await store.receipts();
    expect(receipt).toMatchObject({
      id: entry.id,
      kind: 'report',
      title: 'Safety report',
      reference: 'RK7Q-2MXD-9PJA-4TZC-H8WN',
      writtenAt: at(3),
      owner: avery,
    });
    // Only the receipt remains: nothing the reporter wrote.
    expect(JSON.stringify([...store.stored.values(), ...store.kept.values()])).not.toContain('prop guard');
    expect(JSON.stringify([...store.kept.values()])).not.toContain('Ridge pad 2');
  });

  it('sends the same bytes under the same key every time, so a repeat is the same record', async () => {
    const store = memoryStore();
    const ledger = api();
    const entry = newEntry(avery, recordContent('RIDGE-FLIGHT-07', at(5)), at(5));
    await store.put(entry);
    // The first attempt reaches Ledger and the answer to the commit is lost.
    ledger.next.push('ok', 'ok', 'ok', 'offline');
    expect((await deliver(store, ledger.client(), entry)).kind).toBe('waiting');
    expect(ledger.committed.size).toBe(0);
    ledger.next.push('ok', 'ok', 'ok', 'ok');
    const first = await deliver(store, ledger.client(), entry);
    expect(first).toMatchObject({ kind: 'acknowledged', receipt: { reference: 'record-1' } });
    // Sent once more, as a second tab or a retry would: the same upload, the same file, one record.
    const again = await deliver(store, ledger.client(), entry);
    expect(again).toMatchObject({ kind: 'acknowledged', receipt: { reference: 'record-1' } });
    expect(ledger.committed.size).toBe(1);
    const uploadKeys = ledger.sent.filter((request) => request.path === '/v1/uploads').map((request) => request.key);
    expect(new Set(uploadKeys)).toEqual(new Set([`${entry.key}:create`]));
    const putBodies = ledger.sent
      .filter((request) => request.method === 'PUT')
      .map((request) => Buffer.from(request.body as Uint8Array).toString());
    expect(new Set(putBodies)).toEqual(new Set([(entry.content as { document: string }).document]));
  });

  it('sends an entry only under the sign-in of the person who wrote it, and shows anyone else only a count', async () => {
    const store = memoryStore();
    const ledger = api();
    await store.put(newEntry(avery, reportContent(at(7)), at(7)));
    await store.put(newEntry(avery, recordContent('RIDGE-FLIGHT-08', at(8)), at(8)));
    const entries = (await store.entries()).map(readEntry);
    expect(toSend(entries, quinn)).toEqual([]);
    expect(await sendWaiting(store, ledger.client('ledger-dev-ridge-quinn'), quinn)).toEqual({
      sent: 0,
      refused: 0,
      waiting: 0,
    });
    expect(ledger.sent).toEqual([]);
    const toQuinn = shownTo({ entries, receipts: [] }, quinn);
    expect(toQuinn).toEqual({ own: [], receipts: [], others: 2, unread: 0 });
    // Signed out: no one's entries are shown or sent.
    expect(shownTo({ entries, receipts: [] }, null)).toMatchObject({ own: [], others: 2 });
    expect(shownTo({ entries, receipts: [] }, avery).own.map((entry) => entry.writtenAt)).toEqual([at(7), at(8)]);
    // The same person in another organization is someone else.
    expect(toSend(entries, { ...avery, tenantId: 'tenant-other' })).toEqual([]);
  });

  it('keeps a refused entry with Ledger’s own words, and sends a correction under a new key', async () => {
    const store = memoryStore();
    const ledger = api();
    const entry = newEntry(avery, recordContent('RIDGE-FLIGHT-09', at(10)), at(10));
    await store.put(entry);
    ledger.state.recordRefusal = ['Flight id RIDGE-FLIGHT-09 is already recorded (record 41).'];
    expect(await sendWaiting(store, ledger.client(), avery)).toEqual({ sent: 0, refused: 1, waiting: 0 });
    const refused = readEntry((await store.entries())[0]) as OutboxEntry;
    expect(refused.state).toEqual({
      status: 'refused',
      reasons: ['Flight id RIDGE-FLIGHT-09 is already recorded (record 41).'],
    });
    // A refused entry is not sent again as it is.
    expect(await sendWaiting(store, ledger.client(), avery)).toEqual({ sent: 0, refused: 0, waiting: 0 });

    const corrected = revisedEntry(refused, recordContent('RIDGE-FLIGHT-10', at(12)), at(12));
    expect(corrected).toMatchObject({ id: entry.id, writtenAt: at(12), state: { status: 'waiting' } });
    expect(corrected.key).not.toBe(entry.key);
    await store.put(corrected);
    ledger.state.recordRefusal = null;
    expect(await sendWaiting(store, ledger.client(), avery)).toMatchObject({ sent: 1 });
    expect(await store.entries()).toEqual([]);
  });

  it('leaves an entry waiting when Ledger says nothing about it, and refuses it only on Ledger’s answer about it', async () => {
    const ledger = api();
    const entry = newEntry(avery, reportContent(at(14)), at(14));
    for (const answer of [
      'offline' as const,
      { status: 503, body: { error: { code: 'database_unavailable', message: 'Try again' } } },
      { status: 429, body: { error: { code: 'safety_reports_busy', message: 'Busy' } } },
    ]) {
      const store = memoryStore();
      await store.put(entry);
      ledger.next.push(answer);
      expect((await deliver(store, ledger.client(), entry)).kind).toBe('waiting');
      expect(await store.entries()).toHaveLength(1);
    }
    // The sign-in ended: the entry waits for the same person to sign in again.
    const signedOut = memoryStore();
    await signedOut.put(entry);
    expect(await deliver(signedOut, ledger.client(null), entry)).toMatchObject({ kind: 'waiting' });
    const refused = memoryStore();
    await refused.put(entry);
    ledger.next.push({ status: 400, body: { error: { code: 'validation_failed', message: 'whatWasSeen is empty' } } });
    expect(await deliver(refused, ledger.client(), entry)).toEqual({
      kind: 'refused',
      reasons: ['whatWasSeen is empty'],
    });
    expect(readEntry((await refused.entries())[0])).toMatchObject({ state: { status: 'refused' } });
  });

  it('sends again under a new key when an unfinished upload expired, since nothing was recorded under the old one', async () => {
    const store = memoryStore();
    const ledger = api();
    const entry = newEntry(avery, recordContent('RIDGE-FLIGHT-11', at(16)), at(16));
    await store.put(entry);
    ledger.next.push('ok', {
      status: 410,
      body: { error: { code: 'upload_expired', message: 'Upload session expired' } },
    });
    expect(await deliver(store, ledger.client(), entry)).toMatchObject({ kind: 'acknowledged' });
    const keys = ledger.sent.filter((request) => request.path === '/v1/uploads').map((request) => request.key);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(`${entry.key}:create`);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('keeps the receipt code when the same entry is sent twice at once and the later answer has none', async () => {
    const store = memoryStore();
    const ledger = api();
    const entry = newEntry(avery, reportContent(at(19)), at(19));
    await store.put(entry);
    // Two tabs of the same person send it at the same moment.
    await Promise.all([deliver(store, ledger.client(), entry), deliver(store, ledger.client(), entry)]);
    expect(ledger.reports.size).toBe(1);
    expect(await store.entries()).toEqual([]);
    const [receipt] = await store.receipts();
    expect(receipt).toMatchObject({ reference: 'RK7Q-2MXD-9PJA-4TZC-H8WN' });
    // An entry sent meanwhile is not sent again.
    await store.put(newEntry(avery, reportContent(at(20)), at(20)));
    const [waiting] = (await store.entries()).map(readEntry) as OutboxEntry[];
    const sending = sendWaiting(store, ledger.client(), avery);
    await deliver(store, ledger.client(), waiting!);
    await sending;
    expect(ledger.reports.size).toBe(2);
    expect((await store.receipts()).every((kept) => (kept as { reference?: string }).reference)).toBe(true);
  });

  it('takes a report Ledger already has as received, with no receipt code to show', async () => {
    const store = memoryStore();
    const ledger = api();
    const entry = newEntry(avery, reportContent(at(18)), at(18));
    await store.put(entry);
    await deliver(memoryStore(), ledger.client(), entry);
    // The first answer was lost; the device sends it again under the same key.
    expect(await deliver(store, ledger.client(), entry)).toMatchObject({ kind: 'acknowledged' });
    const [receipt] = await store.receipts();
    expect(receipt).toMatchObject({ kind: 'report', title: 'Safety report' });
    expect((receipt as { reference?: string }).reference).toBeUndefined();
    expect(ledger.reports.size).toBe(1);
  });

  it('states when it was written by the device’s clock; Ledger adds when it received it', async () => {
    const content = recordContent('RIDGE-FLIGHT-12', at(20)) as Extract<EntryContent, { kind: 'record' }>;
    const parsed = parseRecordFile(new TextEncoder().encode(content.document), 'json');
    expect(parsed).toMatchObject({ problems: [], writtenAt: at(20), recordType: 'flight.record' });
    expect(describeWrittenAt(parsed.writtenAt!)).toBe(
      `Written at ${at(20)} by the clock of the device it was entered on; Ledger does not check that clock.`,
    );
    const offset = parseRecordFile(
      new TextEncoder().encode(
        JSON.stringify({ ...JSON.parse(content.document), writtenAt: '2026-11-25T08:20:00-06:00' }),
      ),
      'json',
    );
    expect(offset.writtenAt).toBe(at(20));
    for (const writtenAt of ['2026-11-25T14:20:00', 'yesterday', 7])
      expect(
        parseRecordFile(
          new TextEncoder().encode(JSON.stringify({ ...JSON.parse(content.document), writtenAt })),
          'json',
        ).problems,
      ).toEqual(['writtenAt must be a time with its offset, such as 2026-11-25T14:03:00Z.']);
    expect((reportContent(at(21)) as Extract<EntryContent, { kind: 'report' }>).report.writtenAt).toBe(at(21));
  });

  it('reads an entry an earlier build of this format stored, and keeps one of a format it cannot read', async () => {
    // As a format 1 entry is stored; a field this version does not know is ignored, a missing key is the id.
    const stored = {
      format: 1,
      id: 'entry-1',
      owner: avery,
      writtenAt: at(25),
      content: reportContent(at(25)),
      addedByALaterVersion: { anything: true },
    };
    expect(readEntry(stored)).toMatchObject({
      format: 1,
      id: 'entry-1',
      key: 'entry-1',
      state: { status: 'waiting' },
      owner: avery,
    });
    const later = { format: 2, id: 'entry-2', owner: avery, anything: 'else' };
    expect(readEntry(later)).toEqual({ unread: true, value: later });

    const store = memoryStore();
    store.stored.set('entry-1', stored);
    store.stored.set('entry-2', later);
    const ledger = api();
    const shown = shownTo({ entries: (await store.entries()).map(readEntry), receipts: [] }, avery);
    expect(shown).toMatchObject({ others: 0, unread: 1 });
    expect(shown.own.map((entry) => entry.id)).toEqual(['entry-1']);
    expect(await sendWaiting(store, ledger.client(), avery)).toMatchObject({ sent: 1 });
    // The one this version cannot read is never sent and never dropped.
    expect([...store.stored.keys()]).toEqual(['entry-2']);
    expect(ledger.sent.filter((request) => request.path === '/v1/safety-reports')).toHaveLength(1);
  });
});
