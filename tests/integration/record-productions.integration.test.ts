import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import { createRecordProduction } from '../../packages/evidence/src/index.js';
import { createPool, MemoryObjectStore, withScope } from '../../packages/persistence/src/index.js';
import { readZip, verifyRecordProduction } from '../../tools/verifier/record-production.mjs';
import { settleOwnedWork } from './worker-queue.js';

const fixtures = join(import.meta.dirname, 'fixtures', 'ridge-records');

describe.runIf(process.env.LEDGER_ENV !== 'staging')('Records by subject, and producing them on request', () => {
  const pool = createPool();
  const store = new MemoryObjectStore();
  const run = randomUUID().slice(0, 8);
  const id = (own: string) => `${run}-${own}`;
  let app: Awaited<ReturnType<typeof createApp>>;

  const headers = (tenant: string) => ({
    authorization: `Bearer ledger-dev-${tenant}-operator`,
    'idempotency-key': `record-productions:${randomUUID()}`,
  });
  async function call(tenant: string, method: 'GET' | 'POST', url: string, body?: unknown) {
    return app.inject({
      method,
      url,
      headers: headers(tenant),
      ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    });
  }
  async function get(tenant: string, url: string) {
    const response = await call(tenant, 'GET', url);
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }
  async function upload(tenant: string, bytes: Buffer, filename: string): Promise<string> {
    const created = await call(tenant, 'POST', '/v1/uploads', {
      contentType: 'text/csv',
      byteLength: bytes.byteLength,
      filename,
    });
    expect(created.statusCode, created.body).toBe(201);
    const uploadId = created.json().upload.id as string;
    const stored = await app.inject({
      method: 'PUT',
      url: `/v1/uploads/${uploadId}/content`,
      headers: { ...headers(tenant), 'content-type': 'application/octet-stream' },
      payload: bytes,
    });
    expect(stored.statusCode, stored.body).toBe(200);
    const finalized = await call(tenant, 'POST', `/v1/uploads/${uploadId}/finalize`);
    expect(finalized.statusCode, finalized.body).toBe(201);
    return finalized.json().artifact.id as string;
  }
  async function importFile(tenant: string, recordType: string, bytes: Buffer, filename: string) {
    const artifactId = await upload(tenant, bytes, filename);
    const committed = await call(tenant, 'POST', '/v1/operator-records/imports', {
      artifactId,
      recordType,
      recordVersion: 1,
    });
    expect(committed.statusCode, committed.body).toBe(201);
    return committed.json();
  }
  /** What a record is, apart from where and when it was recorded: its type, subjects, body and whether it was replaced. */
  const content = (record: any) => ({
    recordType: record.recordType,
    subject: { kind: record.subject.kind, id: record.subject.id },
    secondarySubject: record.secondarySubject
      ? { kind: record.secondarySubject.kind, id: record.secondarySubject.id }
      : null,
    record: record.record,
    replaced: Boolean(record.replacedBy),
    correction: Boolean(record.replaces),
  });
  const sorted = (records: any[]) =>
    records.map(content).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

  const window = { from: '2026-10-01T00:00:00Z', to: '2026-11-16T00:00:00Z' };
  let maintenanceId: string;

  beforeAll(async () => {
    app = await createApp({ pool, env: 'test', objectStore: store });
    await app.ready();
    for (const file of readdirSync(fixtures).sort()) {
      const bytes = Buffer.from(readFileSync(join(fixtures, file), 'utf8').replaceAll('RIDGE-', `${run}-RIDGE-`));
      const result = await importFile('alpha', file.replace(/\.csv$/, ''), bytes, file);
      expect(result.summary.refused, JSON.stringify(result.rows)).toBe(0);
    }
    // One correction, so the selection holds a replaced record and the record that replaced it.
    const listed = await get(
      'alpha',
      `/v1/operator-records?${new URLSearchParams({ recordType: 'maintenance.action', subjectId: id('RIDGE-AC-1') })}`,
    );
    maintenanceId = listed.records.find((record: any) => record.record.performedAt === '2026-11-05T17:00:00Z')
      .observationId as string;
    const correction = await importFile(
      'alpha',
      'maintenance.action',
      Buffer.from(
        `subjectId,subjectKind,actionDescription,performedAt,performedByName,returnedToService,returnToServiceByName,replaces\r\n${id('RIDGE-AC-1')},aircraft,Rear left motor replaced after a vibration warning,2026-11-05T17:00:00Z,Morgan Example,true,Morgan Example,${maintenanceId}\r\n`,
      ),
      'maintenance correction.csv',
    );
    expect(correction.summary.recorded).toBe(1);
  });
  afterAll(async () => {
    await settleOwnedWork(['tenant-alpha', 'tenant-beta'], { objectStore: store });
    if (app) await app.close();
    await pool.end();
  });

  it('lists the fleet and the pilots with the names their records give them', async () => {
    const aircraft = await get('alpha', `/v1/operator-records/subjects?kind=aircraft&search=${run}`);
    expect(aircraft.subjects.map((item: any) => [item.subject.id, item.subject.name, item.named])).toEqual([
      [id('RIDGE-AC-1'), `Example Survey Quad X8, ${id('RIDGE-REG-1')}`, true],
      [id('RIDGE-AC-2'), `Example Mapper M2, ${id('RIDGE-REG-2')}`, true],
    ]);
    // AC-1: identity, inspection, three maintenance records (one replaced) and two flight plans naming it.
    expect(aircraft.subjects[0].records).toEqual({ about: 7, current: 6 });
    const people = await get('alpha', `/v1/operator-records/subjects?kind=person&search=avery`);
    const avery = people.subjects.find((item: any) => item.subject.id === id('RIDGE-P-01'));
    expect(avery).toMatchObject({ subject: { name: 'Avery Example', scope: 'source' }, records: { about: 4 } });
    const flights = await get('alpha', `/v1/operator-records/subjects?kind=flight&search=${id('RIDGE-FLT-1')}`);
    expect(flights.subjects[0].subject.name).toMatch(
      /^2026-11-10 \d\d:00 to \d\d:00 \(.+\), Ridge line segment 4, towers 3 to 22$/,
    );
  });

  it('opens a pilot’s file: every record about them by type, including those that name them', async () => {
    const file = await get('alpha', `/v1/operator-records/subjects/person/${id('RIDGE-P-01')}`);
    expect(file.subject).toMatchObject({ id: id('RIDGE-P-01'), name: 'Avery Example' });
    expect(
      file.groups.map((group: any) => [group.recordType, group.records.map((record: any) => record.about)]),
    ).toEqual([
      ['person.standing', ['subject']],
      ['operation.role-assignment', ['reference', 'reference']],
      ['person.training', ['subject']],
    ]);
    expect(file.records).toEqual({ shown: 4, truncated: false });
    expect(file.findings).toEqual([]);
  });

  it('reads records by subject and dates, newest first a page at a time, with replaced records marked', async () => {
    const query = { subjectId: id('RIDGE-AC-1'), ...window };
    const first = await get('alpha', `/v1/operator-records?${new URLSearchParams({ ...query, limit: '3' })}`);
    expect(first.page).toMatchObject({ limit: 3, returned: 3, hasMore: true });
    const second = await get(
      'alpha',
      `/v1/operator-records?${new URLSearchParams({ ...query, limit: '3', cursor: first.page.nextCursor })}`,
    );
    const all = [...first.records, ...second.records];
    expect(second.page.hasMore).toBe(false);
    // Inspection (its interval reaches the window), three maintenance records, and the flight plan in the window.
    expect(all.map((record: any) => record.recordType).sort()).toEqual([
      'aircraft.inspection',
      'flight.plan',
      'maintenance.action',
      'maintenance.action',
      'maintenance.action',
    ]);
    expect(all.find((record: any) => record.observationId === maintenanceId).replacedBy).toBeTruthy();
    expect(all.find((record: any) => record.recordType === 'flight.plan').about).toBe('related_subject');
  });

  it('produces one aircraft’s records for a date range, verifies offline and imports into another organization as the same records', async () => {
    const produced = await call('alpha', 'POST', '/v1/record-productions', {
      subjects: [{ kind: 'aircraft', id: id('RIDGE-AC-1') }],
      ...window,
      includeOriginals: true,
      reason: 'Maintenance records asked for at an inspection',
      requestedBy: 'Inspector, regional office',
    });
    expect(produced.statusCode, produced.body).toBe(201);
    const record = produced.json().record;
    expect(record).toMatchObject({
      format: 'ledger.record-production.1',
      reason: 'Maintenance records asked for at an inspection',
      requestedBy: 'Inspector, regional office',
      selection: { subjects: [{ kind: 'aircraft', id: id('RIDGE-AC-1') }], includeOriginals: true, ...window },
      counts: { records: 5, recordTypes: 3, replaced: 1 },
    });
    const listed = await get('alpha', '/v1/record-productions?limit=5');
    expect(listed.records[0]).toMatchObject({ id: record.id, producedBy: { id: 'principal-alpha-operator' } });
    const event = await withScope(pool, { id: 'principal-alpha-operator', tenantId: 'tenant-alpha' }, (client) =>
      client.query('SELECT event_type FROM journal_events WHERE id=$1', [record.eventId]),
    );
    expect(event.rows[0].event_type).toBe('record-production.produce');

    const download = await call('alpha', 'GET', `/v1/record-productions/${record.id}/content`);
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toContain('application/zip');
    expect(download.headers['x-manifest-sha256']).toBe(record.manifestSha256);
    const bytes = download.rawPayload;
    const verified = verifyRecordProduction(bytes, { expectedManifestDigest: record.manifestSha256 });
    expect(verified).toMatchObject({ status: 'verified', counts: { records: 5 } });
    expect(verified.originals.included).toBe(verified.originals.listed);

    const entries = readZip(bytes, { list: [], add() {}, check: (condition: unknown) => Boolean(condition) });
    const manifest = JSON.parse(entries.get('manifest.json')!.toString('utf8'));
    expect(manifest.journal.length).toBeGreaterThan(0);
    for (const file of manifest.files.filter((item: any) => item.role === 'records')) {
      const result = await importFile('beta', file.recordType, entries.get(file.path)!, file.path.split('/').pop());
      expect(result.summary.refused, JSON.stringify(result.rows)).toBe(0);
    }
    const query = `/v1/operator-records?${new URLSearchParams({ subjectId: id('RIDGE-AC-1'), ...window })}`;
    const original = (await get('alpha', query)).records;
    const imported = (await get('beta', query)).records;
    expect(imported).toHaveLength(5);
    expect(sorted(imported)).toEqual(sorted(original));
  });

  it('lists a pilot’s flights, includes their records when asked, and says what the original files hold besides', async () => {
    const produce = async (withFlights: boolean) => {
      const produced = await call('alpha', 'POST', '/v1/record-productions', {
        subjects: [{ kind: 'person', id: id('RIDGE-P-01') }],
        includeOriginals: true,
        withFlights,
        reason: 'Pilot records asked for at an inspection',
        requestedBy: 'Inspector, regional office',
      });
      expect(produced.statusCode, produced.body).toBe(201);
      const record = produced.json().record;
      const download = await call('alpha', 'GET', `/v1/record-productions/${record.id}/content`);
      const entries = readZip(download.rawPayload, {
        list: [],
        add() {},
        check: (condition: unknown) => Boolean(condition),
      });
      return { record, manifest: JSON.parse(entries.get('manifest.json')!.toString('utf8')) };
    };
    const listed = await produce(false);
    expect(listed.record.counts).toMatchObject({ records: 4, flights: 2 });
    expect(listed.manifest.flights.map((flight: any) => flight.person)).toEqual([id('RIDGE-P-01'), id('RIDGE-P-01')]);
    expect(listed.manifest.flights.every((flight: any) => flight.flight.startsWith(id('RIDGE-FLT-')))).toBe(true);
    // The pilots' and assignments' files hold rows about other people too.
    expect(listed.record.counts.originalsWithOtherRecords).toBeGreaterThan(0);
    const otherRows = listed.manifest.originals.reduce((total: number, item: any) => total + item.otherRecords, 0);
    expect(listed.record.counts.otherRecords).toBe(otherRows);
    const withFlights = await produce(true);
    expect(withFlights.record.counts.records).toBeGreaterThan(listed.record.counts.records);
    expect(withFlights.record.selection.withFlights).toBe(true);
  });

  it('refuses a selection above the bound and produces one at it', async () => {
    const principal = { id: 'principal-alpha-operator', tenantId: 'tenant-alpha' };
    const input = {
      subjects: [{ kind: 'aircraft' as const, id: id('RIDGE-AC-1') }],
      ...window,
      reason: 'Bound check',
      requestedBy: 'Avery Example',
    };
    const limits = { maxRecords: 5, maxSubjects: 50, maxOriginalBytes: 1024 * 1024, maxArchiveBytes: 4 * 1024 * 1024 };
    const atBound = await withScope(pool, principal, (client, who) =>
      createRecordProduction(client, who, input, store, `bound-${run}-a`, limits),
    );
    expect(atBound.counts.records).toBe(5);
    await expect(
      withScope(pool, principal, (client, who) =>
        createRecordProduction(client, who, input, store, `bound-${run}-b`, { ...limits, maxRecords: 4 }),
      ),
    ).rejects.toMatchObject({ status: 413, code: 'production_too_large' });
  });

  it('needs evidence:read to produce, and keeps each organization’s productions apart', async () => {
    const produced = await get('alpha', '/v1/record-productions?limit=1');
    const foreign = await call('beta', 'GET', `/v1/record-productions/${produced.records[0].id}`);
    expect(foreign.statusCode).toBe(404);
    const unnamed = await call('alpha', 'POST', '/v1/record-productions', { reason: ' ', requestedBy: 'x' });
    expect(unnamed.statusCode).toBe(400);
  });
});
