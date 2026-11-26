import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import { sha256 } from '../../packages/integrity/src/index.js';
import { createPool, MemoryObjectStore, withScope } from '../../packages/persistence/src/index.js';
import { flightRecordCsv, readUlog } from '../../packages/flight-logs/src/index.js';
import { px4, px4Definitions, RIDGE, UlogWriter } from '../../packages/flight-logs/tests/encoders.js';
import { lockWaitStarted, settleOwnedWork } from './worker-queue.js';
import { LedgerClient } from '../../packages/contracts/src/client.js';
import { describeWrittenAt } from '../../packages/contracts/src/index.js';
import { sendEntry, type OutboxEntry } from '../../apps/web/src/outbox.js';

const fixtures = join(import.meta.dirname, '..', '..', 'packages', 'contracts', 'fixtures', 'operator-records');

describe.runIf(process.env.LEDGER_ENV !== 'staging')('Operator record import and entry', () => {
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const store = new MemoryObjectStore();
  const run = randomUUID().slice(0, 8);
  const lockTenant = `operator-lock-${run}`;
  let app: Awaited<ReturnType<typeof createApp>>;

  const headers = (tenant: string, role: string) => ({
    authorization: `Bearer ledger-dev-${tenant}-${role}`,
    'idempotency-key': `operator-records:${randomUUID()}`,
  });
  async function call(tenant: string, role: string, method: 'GET' | 'POST', url: string, body?: unknown) {
    return app.inject({
      method,
      url,
      headers: headers(tenant, role),
      ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    });
  }
  /** A sample file with this run's own subject ids, so repeated runs on one database stay apart. */
  function sample(name: string): Buffer {
    return Buffer.from(
      readFileSync(join(fixtures, name), 'utf8').replace(/\b(ALPHA|BETA|UTIL)-/g, (prefix) => `${run}-${prefix}`),
    );
  }
  async function upload(tenant: string, role: string, bytes: Buffer, contentType: string): Promise<string> {
    const created = await call(tenant, role, 'POST', '/v1/uploads', { contentType, byteLength: bytes.byteLength });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().upload.id as string;
    const stored = await app.inject({
      method: 'PUT',
      url: `/v1/uploads/${id}/content`,
      headers: { ...headers(tenant, role), 'content-type': 'application/octet-stream' },
      payload: bytes,
    });
    expect(stored.statusCode, stored.body).toBe(200);
    const finalized = await call(tenant, role, 'POST', `/v1/uploads/${id}/finalize`);
    expect(finalized.statusCode, finalized.body).toBe(201);
    return finalized.json().artifact.id as string;
  }
  const preview = (tenant: string, role: string, body: Record<string, unknown>) =>
    call(tenant, role, 'POST', '/v1/operator-records/imports/preview', body);
  const commit = (tenant: string, role: string, body: Record<string, unknown>) =>
    call(tenant, role, 'POST', '/v1/operator-records/imports', body);
  async function records(tenant: string, query: Record<string, string>) {
    const response = await call(tenant, 'operator', 'GET', `/v1/operator-records?${new URLSearchParams(query)}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json().records as any[];
  }
  async function storedRecordCount(tenantId: string): Promise<number> {
    const result = await withScope(pool, { id: `principal-${tenantId.slice(7)}-operator`, tenantId }, (client) =>
      client.query(
        `SELECT count(*)::int AS count FROM observations WHERE tenant_id=$1 AND observation_type='operator.record'`,
        [tenantId],
      ),
    );
    return result.rows[0].count;
  }
  const time = { recordType: 'aircraft.time-in-service', recordVersion: 1 };
  const training = { recordType: 'person.training', recordVersion: 1 };
  let aircraftFile: string;
  let trainingFile: string;

  beforeAll(async () => {
    app = await createApp({ pool, env: 'test', objectStore: store });
    await app.ready();
    aircraftFile = await upload('alpha', 'operator', sample('alpha-aircraft-time.csv'), 'text/csv');
    trainingFile = await upload('alpha', 'operator', sample('alpha-training-records.csv'), 'text/csv');
  });
  afterAll(async () => {
    await settleOwnedWork(['tenant-alpha', 'tenant-beta', lockTenant], { objectStore: store });
    if (app) await app.close();
    await pool.end();
    await admin.end();
  });

  it('lists record types with generated columns and serves a template per type', async () => {
    const types = await call('alpha', 'operator', 'GET', '/v1/operator-records/types');
    expect(types.statusCode, types.body).toBe(200);
    const summary = types.json().types.find((item: any) => item.recordType === 'aircraft.time-in-service');
    expect(summary.columns.map((column: any) => column.key)).toContain('totalTimeHours');
    expect(types.json().sourceId).toBe('operator-records');
    const template = await call(
      'alpha',
      'operator',
      'GET',
      '/v1/operator-records/types/aircraft.time-in-service/versions/1/template',
    );
    expect(template.statusCode).toBe(200);
    expect(template.headers['content-type']).toContain('text/csv');
    expect(template.body.split('\r\n')[0]).toBe(
      'subjectId,entryKind,totalTimeHours,coveredThroughAt,sourceReference,coverage,coverageNotes,flightCount,replaces',
    );
    const json = await call(
      'alpha',
      'operator',
      'GET',
      '/v1/operator-records/types/person.training/versions/1/template?format=json',
    );
    expect(JSON.parse(json.body)).toMatchObject({ recordType: 'person.training', recordVersion: 1 });
    const missing = await call(
      'alpha',
      'operator',
      'GET',
      '/v1/operator-records/types/person.unknown/versions/1/template',
    );
    expect(missing.statusCode).toBe(404);
  });

  it('previews every row, refusing the malformed one with a reason, and writes nothing', async () => {
    const before = await storedRecordCount('tenant-alpha');
    const response = await preview('alpha', 'operator', { artifactId: aircraftFile, ...time });
    expect(response.statusCode, response.body).toBe(200);
    const result = response.json();
    expect(result).toMatchObject({
      format: 'csv',
      sourceId: 'operator-records',
      granted: true,
      problems: [],
      summary: { rows: 4, acceptable: 3, incomplete: 0, alreadyRecorded: 0, refused: 1 },
    });
    expect(result.rows[0]).toMatchObject({
      row: 1,
      status: 'acceptable',
      subject: { kind: 'aircraft', id: `${run}-ALPHA-AC-101`, scope: 'source' },
      record: { totalTimeHours: 412.6, coveredThroughAt: '2026-06-30T23:59:59Z' },
      occurredAt: '2026-06-30T23:59:59Z',
      complete: true,
    });
    expect(result.rows[3].status).toBe('refused');
    expect(result.rows[3].reasons).toEqual([
      'Total time in service through the cutoff (totalTimeHours): "ninety" is not a number.',
      'Covers time through (coveredThroughAt): "2026-06-30 18:00" does not say which time zone it is in. Name the column with [local] after it to read it in the organization’s time zone (America/Chicago), or write it in UTC as 2026-11-10T15:00:00Z, with its offset as 2026-11-10T09:00-06:00, or in the organization’s time zone under a heading ending in [local] as 2026-11-10 09:00.',
    ]);
    expect(await storedRecordCount('tenant-alpha')).toBe(before);
  });

  it('commits acceptable rows citing the file and row, and a second commit records nothing new', async () => {
    const first = await commit('alpha', 'operator', { artifactId: aircraftFile, ...time });
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json().summary).toEqual({ rows: 4, recorded: 3, incomplete: 0, alreadyRecorded: 0, refused: 1 });
    // Nothing new is recorded, so the answer is 200 with the same body, not 201.
    const again = await commit('alpha', 'operator', { artifactId: aircraftFile, ...time });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().summary).toEqual({ rows: 4, recorded: 0, incomplete: 0, alreadyRecorded: 3, refused: 1 });
    expect(again.json().rows[0].observationId).toBe(first.json().rows[0].observationId);
    const shownAgain = await preview('alpha', 'operator', { artifactId: aircraftFile, ...time });
    expect(shownAgain.json().summary).toMatchObject({ acceptable: 0, alreadyRecorded: 3 });

    const [record] = await records('alpha', { ...{ recordType: time.recordType }, subjectId: `${run}-ALPHA-AC-101` });
    expect(record).toMatchObject({
      observationId: first.json().rows[0].observationId,
      sourceId: 'operator-records',
      subject: { kind: 'aircraft', id: `${run}-ALPHA-AC-101`, scope: 'source', resolution: 'unresolved' },
      occurredAt: '2026-06-30T23:59:59.000Z',
      complete: true,
      origin: { artifactId: aircraftFile, contentType: 'text/csv', recordedBy: { id: 'principal-alpha-operator' } },
    });
    const bytes = await call('alpha', 'operator', 'GET', `/v1/artifacts/${aircraftFile}/content`);
    const { offsetBytes, lengthBytes } = record.origin.locator.value;
    expect(bytes.rawPayload.subarray(offsetBytes, offsetBytes + lengthBytes).toString()).toBe(
      `${run}-ALPHA-AC-101,opening_balance,412.6,2026-06-30T23:59:59Z,Aircraft log book 101 volume 2,complete,Totals carried from the paper log book since delivery.,1288`,
    );
    // The record went through generic intake: a receipt for the operator-records source.
    const receipt = await call('alpha', 'operator', 'GET', `/v1/receipts/${record.receiptId}`);
    expect(receipt.json().receipt).toMatchObject({ kind: 'observation', sourceId: 'operator-records' });
  });

  it('reads [local] times in the organization’s zone and pilots’ units, keeping what was entered', async () => {
    const subjectId = `${run}-ALPHA-FLIGHT-LOCAL`;
    const file = await upload(
      'alpha',
      'operator',
      Buffer.from(
        [
          'subjectId,windowStartsAt [local],windowEndsAt,operationKind,plannedMaxHeightAboveGround [ft],plannedMaxGroundSpeed [kt]',
          `${subjectId},2026-11-10 09:00,2026-11-10T10:30-06:00, Inspection ,400,25`,
        ].join('\n'),
      ),
      'text/csv',
    );
    const committed = await commit('alpha', 'operator', {
      artifactId: file,
      recordType: 'flight.plan',
      recordVersion: 1,
    });
    expect(committed.statusCode, committed.body).toBe(201);
    const [row] = committed.json().rows;
    expect(row).toMatchObject({
      status: 'recorded',
      record: {
        windowStartsAt: '2026-11-10T15:00:00Z',
        windowEndsAt: '2026-11-10T16:30:00Z',
        operationKind: 'inspection',
        plannedMaxHeightAboveGroundMeters: 121.92,
        plannedMaxGroundSpeedMetersPerSecond: 12.861111,
      },
      interval: { start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:30:00Z' },
      timeConversions: [
        {
          field: 'windowStartsAt',
          entered: '2026-11-10 09:00',
          timeZone: 'America/Chicago',
          stored: '2026-11-10T15:00:00Z',
        },
        { field: 'windowEndsAt', entered: '2026-11-10T10:30-06:00', stored: '2026-11-10T16:30:00Z' },
      ],
    });
    const [record] = await records('alpha', { recordType: 'flight.plan', subjectId });
    expect(record.limitations).toEqual([
      'Window starts was entered as 2026-11-10 09:00 in America/Chicago and recorded as 2026-11-10T15:00:00Z.',
      'Window ends was entered as 2026-11-10T10:30-06:00 and recorded as 2026-11-10T16:30:00Z.',
      'Planned maximum height above ground was entered as 400 ft and recorded as 121.92 m.',
      'Planned maximum ground speed was entered as 25 kt and recorded as 12.861111 m/s.',
    ]);
  });

  it('reads an export in its own columns through a column mapping, keeping the export and the mapping', async () => {
    const flight = `${run}-ALPHA-FLIGHT-MAPPED`;
    const exportText = [
      'Flight,Up,Down,Drone,Launch,Land,Alt (ft),Status,Pilot',
      `${flight}-1,11/10/2026 9:05 AM,11/10/2026 9:47 AM,${run}-ALPHA-AC-101,Pad A,Pad A,148,Flown,Robin`,
      `${flight}-2,,,${run}-ALPHA-AC-101,Pad A,,,Cancelled,Robin`,
      `${flight}-3,2026-11-12 09:10,11/12/2026 10:02 AM,${run}-ALPHA-AC-101,Pad B,Pad B,236,Flown,Robin`,
    ].join('\n');
    const mappingText = `recordType: flight.record
recordVersion: 1
times:
  zone: organization
  style: MM/DD/YYYY h:mm A
subject: { column: Flight }
relatedSubject: { column: Drone }
columns:
  Up: takeoffAt
  Down: landingAt
  Launch: takeoffLocation
  Land: landingLocations
  "Alt (ft)": { field: maxHeightFlownAboveGroundMeters, unit: ft }
  Pilot: ~
leaveOut:
  - { column: Status, is: [Cancelled] }
`;
    const exported = await upload('alpha', 'operator', Buffer.from(exportText), 'text/csv');
    const mapping = await upload('alpha', 'operator', Buffer.from(mappingText), 'application/yaml');
    const body = { artifactId: exported, mappingArtifactId: mapping, recordType: 'flight.record', recordVersion: 1 };

    const shown = await preview('alpha', 'operator', body);
    expect(shown.statusCode, shown.body).toBe(200);
    expect(shown.json().mapping).toMatchObject({
      artifactId: mapping,
      unread: ['Pilot'],
      constants: [],
      leftOut: [{ row: 2, reason: 'Status is "Cancelled".' }],
    });
    expect(shown.json().summary).toMatchObject({ rows: 2, acceptable: 1, refused: 1 });
    expect(shown.json().rows[1]).toMatchObject({ row: 3, status: 'refused' });
    expect(shown.json().rows[1].reasons[0]).toBe(
      'Takeoff at (takeoffAt): "2026-11-12 09:10" is not written as MM/DD/YYYY h:mm A, the style the mapping gives for column "Up"; nor is it a date alone written as YYYY-MM-DD.',
    );

    const committed = await commit('alpha', 'operator', body);
    expect(committed.statusCode, committed.body).toBe(201);
    expect(committed.json().summary).toEqual({ rows: 2, recorded: 1, incomplete: 0, alreadyRecorded: 0, refused: 1 });
    const [record] = await records('alpha', { recordType: 'flight.record', subjectId: `${flight}-1` });
    expect(record).toMatchObject({
      record: { takeoffAt: '2026-11-10T15:05:00Z', maxHeightFlownAboveGroundMeters: 45.1104 },
      origin: { artifactId: exported, contentType: 'text/csv' },
    });
    expect(record.limitations).toEqual([
      `Read from its original file through the column mapping retained as file ${mapping}.`,
      'Takeoff at was entered as 11/10/2026 9:05 AM in America/Chicago and recorded as 2026-11-10T15:05:00Z.',
      'Landing at was entered as 11/10/2026 9:47 AM in America/Chicago and recorded as 2026-11-10T15:47:00Z.',
      'Maximum height flown above ground was entered as 148 ft and recorded as 45.1104 m.',
    ]);
    // The record cites the export's own row, as it was received, and the mapping is retained beside it.
    const bytes = await call('alpha', 'operator', 'GET', `/v1/artifacts/${exported}/content`);
    const { offsetBytes, lengthBytes } = record.origin.locator.value;
    expect(bytes.rawPayload.subarray(offsetBytes, offsetBytes + lengthBytes).toString()).toBe(
      exportText.split('\n')[1],
    );
    const kept = await call('alpha', 'operator', 'GET', `/v1/artifacts/${mapping}/content`);
    expect(kept.body).toBe(mappingText);
    const again = await commit('alpha', 'operator', body);
    expect(again.json().summary).toMatchObject({ recorded: 0, alreadyRecorded: 1 });

    // A mapping that names a field the record type does not have is refused when it is loaded, with its line.
    const wrong = await upload(
      'alpha',
      'operator',
      Buffer.from(mappingText.replace('Land: landingLocations', 'Land: landingSite')),
      'application/yaml',
    );
    const refusedMapping = await preview('alpha', 'operator', { ...body, mappingArtifactId: wrong });
    expect(refusedMapping.json().rows).toEqual([]);
    expect(refusedMapping.json().problems[0]).toMatch(
      /^The mapping: Line 12: column "Land": flight.record has no field "landingSite"\./,
    );
    const refusedCommit = await commit('alpha', 'operator', { ...body, mappingArtifactId: wrong });
    expect(refusedCommit.statusCode).toBe(400);
    expect(refusedCommit.json().error.code).toBe('import_file_invalid');
  });

  it('keeps an aircraft’s log as the original of the records read from it', async () => {
    const S = 1_000_000;
    const log = px4Definitions(new UlogWriter());
    px4.gps(log, 5 * S, Date.UTC(2026, 10, 10, 16, 5, 0) * 1000 + 5 * S, RIDGE);
    px4.status(log, 10 * S, true);
    px4.landed(log, 12 * S, false);
    px4.global(log, 13 * S, RIDGE, 1850);
    px4.landed(log, 70 * S, true);
    px4.status(log, 72 * S, false);
    const logBytes = Buffer.from(log.done());
    const flight = `${run}-ALPHA-FLIGHT-LOGGED`;
    const read = flightRecordCsv(await readUlog([logBytes]), { name: 'flight.ulg', sha256: sha256(logBytes) });
    // What the log does not hold, a person writes: the flight's own id and the height above the ground.
    const csv = read.replace(/\r\n,,(2026-[^,]+,[^,]+,"[^"]+","[^"]+"),,/, `\r\n${flight},,$1,30,`);
    const original = await upload('alpha', 'operator', logBytes, 'application/octet-stream');
    const file = await upload('alpha', 'operator', Buffer.from(csv), 'text/csv');
    const body = { artifactId: file, originalArtifactId: original, recordType: 'flight.record', recordVersion: 1 };

    const shown = await preview('alpha', 'operator', body);
    expect(shown.statusCode, shown.body).toBe(200);
    expect(shown.json().summary).toMatchObject({ rows: 1, acceptable: 1, refused: 0 });
    const committed = await commit('alpha', 'operator', body);
    expect(committed.statusCode, committed.body).toBe(201);
    const [record] = await records('alpha', { recordType: 'flight.record', subjectId: flight });
    expect(record).toMatchObject({
      record: { takeoffAt: '2026-11-10T16:05:12Z', landingAt: '2026-11-10T16:06:10Z' },
      origin: { artifactId: original, contentType: 'application/octet-stream' },
    });
    expect(record.origin).not.toHaveProperty('locator');
    expect(record.limitations[0]).toBe(
      `Read from its original file, retained as file ${original}, through row 1 of file ${file}, which holds what was read from the original in Ledger’s own columns. A value in that file the original does not hold was added to it, not read from the original.`,
    );
    expect((await commit('alpha', 'operator', body)).json().summary).toMatchObject({ alreadyRecorded: 1 });

    // Another organization's file is not found, and a mapping is not given with an original.
    const beta = await upload('beta', 'operator', Buffer.from(csv), 'text/csv');
    const elsewhere = await preview('beta', 'operator', { ...body, artifactId: beta });
    expect(elsewhere.statusCode).toBe(404);
    const both = await preview('alpha', 'operator', { ...body, mappingArtifactId: original });
    expect(both.json().problems).toEqual([
      'A file read from another file is already in Ledger’s own columns: give a column mapping or the original file, not both.',
    ]);
  });

  it('answers 200 with the same body when every row of a file is refused', async () => {
    const file = await upload(
      'alpha',
      'operator',
      Buffer.from(`subjectId,windowStartsAt [local]\n${run}-ALPHA-FLIGHT-US,11/10/2026 9:00 AM\n`),
      'text/csv',
    );
    const committed = await commit('alpha', 'operator', {
      artifactId: file,
      recordType: 'flight.plan',
      recordVersion: 1,
    });
    expect(committed.statusCode, committed.body).toBe(200);
    expect(committed.json().summary).toEqual({ rows: 1, recorded: 0, incomplete: 0, alreadyRecorded: 0, refused: 1 });
    expect(committed.json().rows[0].reasons[0]).toMatch(/is not a time Ledger can read/);
  });

  it('records an incomplete row and names the missing required fields', async () => {
    const committed = await commit('alpha', 'operator', { artifactId: trainingFile, ...training });
    expect(committed.statusCode, committed.body).toBe(201);
    expect(committed.json().summary).toEqual({ rows: 5, recorded: 4, incomplete: 1, alreadyRecorded: 0, refused: 1 });
    expect(committed.json().rows[4].reasons).toEqual([
      'Completed on (completedOn): "2026-02-30" is not a date written as YYYY-MM-DD.',
    ]);
    const shown = await records('alpha', { recordType: training.recordType, subjectId: `${run}-ALPHA-PILOT-02` });
    expect(shown).toHaveLength(2);
    const incomplete = shown.find((item) => item.record.trainingKind === 'aircraft_specific');
    expect(incomplete).toMatchObject({
      complete: false,
      missingRequired: [{ name: 'evidenceReference', label: 'Completion evidence reference' }],
    });
    const pilot1 = await records('alpha', { recordType: training.recordType, subjectId: `${run}-ALPHA-PILOT-01` });
    expect(pilot1.map((item) => item.record.courseTitle).sort()).toEqual([
      'Delivery operations initial course',
      'Recurrent emergency procedures',
    ]);
  });

  it('records a hand entry with its payload as the original, and a correction that names what it replaces', async () => {
    const subjectId = `${run}-ALPHA-PILOT-04`;
    const entry = (record: Record<string, unknown>) =>
      Buffer.from(JSON.stringify({ ...training, records: [{ subjectId, ...record }] }));
    const original = await upload(
      'alpha',
      'operator',
      entry({ trainingKind: 'recurrent', courseTitle: 'Recurent course', completedOn: '2026-09-01' }),
      'application/json',
    );
    const first = await commit('alpha', 'operator', { artifactId: original, ...training });
    expect(first.json().summary).toMatchObject({ recorded: 1, incomplete: 1 });
    const replacedId = first.json().rows[0].observationId as string;

    const corrected = await upload(
      'alpha',
      'operator',
      entry({
        replaces: replacedId,
        trainingKind: 'recurrent',
        courseTitle: 'Recurrent course',
        completedOn: '2026-09-01',
        evidenceReference: 'TRN-2026-0300',
      }),
      'application/json',
    );
    const second = await commit('alpha', 'operator', { artifactId: corrected, ...training });
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json().rows[0]).toMatchObject({ status: 'recorded', replaces: replacedId, complete: true });
    const shown = await records('alpha', { recordType: training.recordType, subjectId });
    const byId = Object.fromEntries(shown.map((item) => [item.observationId, item]));
    expect(byId[replacedId]).toMatchObject({ replacedBy: second.json().rows[0].observationId, complete: false });
    expect(byId[second.json().rows[0].observationId]).toMatchObject({
      replaces: replacedId,
      origin: { artifactId: corrected, contentType: 'application/json', locator: { value: '/records/0' } },
    });

    // The replaced record is not replaced twice; a correction must name the same subject.
    const twice = await upload(
      'alpha',
      'operator',
      entry({ replaces: replacedId, courseTitle: 'Another correction' }),
      'application/json',
    );
    const refused = await commit('alpha', 'operator', { artifactId: twice, ...training });
    expect(refused.json().rows[0].reasons[0]).toMatch(/already replaced by record/);
    const otherSubject = await upload(
      'alpha',
      'operator',
      Buffer.from(
        JSON.stringify({
          ...training,
          records: [
            { subjectId: `${run}-ALPHA-PILOT-05`, replaces: second.json().rows[0].observationId, courseTitle: 'C' },
          ],
        }),
      ),
      'application/json',
    );
    const wrong = await preview('alpha', 'operator', { artifactId: otherSubject, ...training });
    expect(wrong.json().rows[0].reasons[0]).toMatch(/is about person/);
  });

  it('records an entry a device sends twice under its key once, refuses other bytes under it, and says when it was written', async () => {
    // The device's own sending path, against this API.
    const fetcher = (async (input: string, init: RequestInit = {}) => {
      const url = new URL(input);
      const body = init.body instanceof Uint8Array ? Buffer.from(init.body) : (init.body as string | undefined);
      const response = await app.inject({
        method: (init.method ?? 'GET') as 'GET',
        url: `${url.pathname}${url.search}`,
        headers: Object.fromEntries(new Headers(init.headers).entries()),
        ...(body === undefined ? {} : { payload: body }),
      });
      return new Response(response.rawPayload, {
        status: response.statusCode,
        headers: { 'content-type': String(response.headers['content-type'] ?? '') },
      });
    }) as unknown as typeof fetch;
    const client = new LedgerClient('http://ledger.test', 'ledger-dev-alpha-operator', fetcher);
    const subjectId = `${run}-ALPHA-PILOT-09`;
    const writtenAt = '2026-11-25T14:03:00.000Z';
    const document = (courseTitle: string) =>
      JSON.stringify(
        {
          ...training,
          writtenAt,
          records: [{ subjectId, trainingKind: 'recurrent', courseTitle, completedOn: '2026-09-01' }],
        },
        null,
        2,
      );
    const key = `device-entry-${randomUUID()}`;
    const entry: OutboxEntry = {
      format: 1,
      id: key,
      key,
      owner: { principalId: 'principal-alpha-operator', tenantId: 'tenant-alpha', name: 'Dana Ortiz' },
      writtenAt,
      state: { status: 'waiting' },
      content: {
        kind: 'record',
        title: 'Training',
        subject: subjectId,
        ...training,
        sourceId: 'operator-records',
        document: document('Recurrent course A'),
        draft: {
          subjectId,
          subjectKind: 'person',
          secondarySubjectId: '',
          secondarySubjectKind: '',
          values: {},
          units: {},
        },
      },
    };
    const before = await storedRecordCount('tenant-alpha');
    const first = await sendEntry(client, entry);
    expect(first).toMatchObject({ kind: 'acknowledged', recorded: { rows: [{ status: 'recorded' }] } });
    const second = await sendEntry(client, entry);
    expect(second).toMatchObject({ kind: 'acknowledged', recorded: { rows: [{ status: 'already_recorded' }] } });
    const reference = (outcome: typeof first) => (outcome.kind === 'acknowledged' ? outcome.receipt.reference : '');
    expect(reference(second)).toBe(reference(first));
    expect(await storedRecordCount('tenant-alpha')).toBe(before + 1);

    // Other bytes under the same key, of the same length and of another: refused, nothing recorded.
    for (const title of ['Recurrent course B', 'Recurrent course, second sitting']) {
      const other = await sendEntry(client, {
        ...entry,
        content: { ...entry.content, document: document(title) } as typeof entry.content,
      });
      expect(other.kind).toBe('refused');
    }
    expect(await storedRecordCount('tenant-alpha')).toBe(before + 1);

    const [shown] = await records('alpha', { recordType: training.recordType, subjectId });
    expect(shown.observationId).toBe(reference(first));
    expect(shown.limitations).toContain(describeWrittenAt(writtenAt));
    expect(Date.parse(shown.receivedAt)).toBeGreaterThan(Date.parse(writtenAt));
  });

  it('refuses a JSON file of another record type, and reports a refused record without dropping the rest', async () => {
    const beta = sample('beta-training-records.json');
    const mismatch = await upload('alpha', 'operator', beta, 'application/json');
    const shown = await preview('alpha', 'operator', { artifactId: mismatch, ...time });
    expect(shown.json().problems[0]).toMatch(/states record type person.training/);
    const refused = await commit('alpha', 'operator', { artifactId: mismatch, ...time });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe('import_file_invalid');

    const betaFile = await upload('beta', 'operator', beta, 'application/json');
    const committed = await commit('beta', 'operator', { artifactId: betaFile, ...training });
    expect(committed.statusCode, committed.body).toBe(201);
    expect(committed.json().summary).toEqual({ rows: 3, recorded: 2, incomplete: 0, alreadyRecorded: 0, refused: 1 });
    expect(committed.json().rows[2].reasons[0]).toMatch(/"night_flying" is not one of/);
  });

  it('keeps records, files and grants inside their tenant', async () => {
    const foreign = await preview('beta', 'operator', { artifactId: aircraftFile, ...time });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().error.code).toBe('artifact_not_found');
    const foreignCommit = await commit('beta', 'operator', { artifactId: aircraftFile, ...time });
    expect(foreignCommit.statusCode).toBe(404);
    expect(await records('beta', { recordType: time.recordType, subjectId: `${run}-ALPHA-AC-101` })).toEqual([]);
    expect((await records('beta', { recordType: training.recordType, subjectId: `${run}-BETA-PILOT-12` })).length).toBe(
      1,
    );
    expect(await records('alpha', { recordType: training.recordType, subjectId: `${run}-BETA-PILOT-12` })).toEqual([]);
  });

  it('needs input:write and a grant for the source to commit', async () => {
    const file = await upload('alpha', 'actor', sample('alpha-aircraft-time.csv'), 'text/csv');
    const shown = await preview('alpha', 'actor', { artifactId: file, ...time });
    expect(shown.json().granted).toBe(false);
    const refused = await commit('alpha', 'actor', { artifactId: file, ...time });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('observation_grant_required');
    const otherSource = await commit('alpha', 'operator', { artifactId: aircraftFile, ...time, sourceId: 'other' });
    expect(otherSource.statusCode).toBe(403);
  });

  it('commits rows about two flights in file order while an intake holds the lower flight, in one lock order', async () => {
    // A fictional tenant of its own, whose operator names two flights by codes aliased to them.
    const principalId = `${lockTenant}:operator`;
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [lockTenant, 'Fictional import lock tenant']);
    await admin.query('INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,$4,$5)', [
      principalId,
      lockTenant,
      'Fictional import operator',
      'human',
      ['input:write', 'flight:create', 'flight:read', 'evidence:read'],
    ]);
    await admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [
      sha256(`ledger-dev-${lockTenant}-operator`),
      principalId,
    ]);
    await admin.query(
      'INSERT INTO observation_grants(tenant_id,principal_id,source_id,observation_type) VALUES($1,$2,$3,$4)',
      [lockTenant, principalId, 'operator-records', 'operator.record'],
    );
    const flights: string[] = [];
    for (const name of ['first', 'second']) {
      const created = await call(lockTenant, 'operator', 'POST', '/v1/flights', { originationKey: `${run}:${name}` });
      expect(created.statusCode, created.body).toBe(201);
      flights.push(created.json().flight.id as string);
    }
    const [low, high] = flights.sort();
    for (const [code, flightId] of [
      ['LOW', low],
      ['HIGH', high],
    ]) {
      const aliased = await call(lockTenant, 'operator', 'POST', '/v1/commands', {
        kind: 'subject.alias',
        sourceId: 'operator-records',
        subjectKind: 'flight',
        externalId: `${run}-FLT-${code}`,
        ledgerSubjectId: flightId,
        reason: 'The fictional crew file names flights by their own codes.',
      });
      expect(aliased.statusCode, aliased.body).toBe(201);
    }
    const file = await upload(
      lockTenant,
      'operator',
      Buffer.from(
        [
          'subjectId,subjectKind,personId,role,startsAt,endsAt',
          `${run}-FLT-HIGH,flight,${run}-PILOT-01,pilot_in_command,2026-10-06T09:00:00Z,2026-10-06T10:00:00Z`,
          `${run}-FLT-LOW,flight,${run}-PILOT-02,pilot_in_command,2026-10-08T10:00:00Z,2026-10-08T11:00:00Z`,
        ].join('\n'),
      ),
      'text/csv',
    );
    // An intake about both flights takes the lower one first; the file, whose first row names the higher one, is
    // committed while the lower one is held.
    let committed: ReturnType<typeof commit> | undefined;
    await withScope(pool, { id: principalId, tenantId: lockTenant }, async (client) => {
      await client.query('SELECT id FROM flight_views WHERE id=$1 FOR UPDATE', [low]);
      committed = commit(lockTenant, 'operator', {
        artifactId: file,
        recordType: 'operation.role-assignment',
        recordVersion: 1,
      });
      committed.catch(() => undefined);
      await lockWaitStarted(admin);
      await client.query('SELECT id FROM flight_views WHERE id=$1 FOR UPDATE', [high]);
    });
    const response = await committed!;
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().summary).toMatchObject({ rows: 2, recorded: 2 });
    expect(response.json().rows.map((row: { subject: { id: string } }) => row.subject.id)).toEqual([
      `${run}-FLT-HIGH`,
      `${run}-FLT-LOW`,
    ]);
  });

  it('imports duty and rest periods as the duty-period observations the duty rules read, under the operator’s ids', async () => {
    const person = `${run}-ALPHA-PILOT-DUTY`;
    const periodsType = { recordType: 'crew.duty-period', recordVersion: 1 };
    const periodsFile = await upload(
      'alpha',
      'operator',
      Buffer.from(
        [
          'subjectId,periodId,period,startsAt [local],endsAt [local],role',
          `${person},${run}-REST-1,rest,2026-11-09 18:00,2026-11-10 05:00,`,
          `${person},${run}-DUTY-1,Flight duty,2026-11-10 06:00,2026-11-10 16:30,remote_pilot`,
          `${person},${run}-DUTY-1,duty,2026-11-11 06:00,2026-11-11 10:00,`,
        ].join('\n'),
      ),
      'text/csv',
    );
    const committed = await commit('alpha', 'operator', { artifactId: periodsFile, ...periodsType });
    expect(committed.statusCode, committed.body).toBe(201);
    expect(committed.json().summary).toMatchObject({ recorded: 2, refused: 1 });
    expect(committed.json().rows[2].reasons).toEqual([`Row 2 of this file already gives periodId ${run}-DUTY-1.`]);
    const dutyId = committed.json().rows[1].observationId as string;

    // The periods are crew.duty-period observations about the person, keyed by the operator's own ids.
    const read = await call(
      'alpha',
      'operator',
      'GET',
      `/v1/observations?${new URLSearchParams({
        subjectKind: 'person',
        subjectId: person,
        subjectScope: 'source',
        sourceId: 'operator-records',
        type: 'crew.duty-period',
        from: '2026-11-01T00:00:00Z',
        to: '2026-12-01T00:00:00Z',
      })}`,
    );
    expect(read.statusCode, read.body).toBe(200);
    const observations = read.json().observations as any[];
    expect(observations.map((item) => item.observation.sourceEventId).sort()).toEqual([
      `${run}-DUTY-1`,
      `${run}-REST-1`,
    ]);
    expect(observations.find((item) => item.id === dutyId).observation).toMatchObject({
      interval: { start: '2026-11-10T12:00:00Z', end: '2026-11-10T22:30:00Z' },
      values: { period: 'flight_duty', role: 'remote_pilot' },
    });

    // The Records screen reads them like any record, with the period id and times as entered fields.
    const [shown] = await records('alpha', {
      recordType: 'crew.duty-period',
      subjectId: person,
      from: '2026-11-10T11:00:00Z',
      to: '2026-11-10T13:00:00Z',
    });
    expect(shown).toMatchObject({
      observationId: dutyId,
      recordType: 'crew.duty-period',
      record: {
        periodId: `${run}-DUTY-1`,
        period: 'flight_duty',
        startsAt: '2026-11-10T12:00:00Z',
        endsAt: '2026-11-10T22:30:00Z',
        role: 'remote_pilot',
      },
      complete: true,
    });

    // The same id from another file is refused unless the row corrects the record that holds it.
    const again = await upload(
      'alpha',
      'operator',
      Buffer.from(
        `subjectId,periodId,period,startsAt,endsAt,replaces\n${person},${run}-DUTY-1,duty,2026-11-10T12:00:00Z,2026-11-10T21:00:00Z,\n`,
      ),
      'text/csv',
    );
    const duplicate = await commit('alpha', 'operator', { artifactId: again, ...periodsType });
    expect(duplicate.statusCode, duplicate.body).toBe(200);
    expect(duplicate.json().rows[0].reasons).toEqual([
      `Period id ${run}-DUTY-1 is already recorded (record ${dutyId}); to correct that record, give ${dutyId} in replaces.`,
    ]);
    const correction = await upload(
      'alpha',
      'operator',
      Buffer.from(
        `subjectId,periodId,period,startsAt,endsAt,replaces\n${person},${run}-DUTY-1,duty,2026-11-10T12:00:00Z,2026-11-10T21:00:00Z,${dutyId}\n`,
      ),
      'text/csv',
    );
    const corrected = await commit('alpha', 'operator', { artifactId: correction, ...periodsType });
    expect(corrected.statusCode, corrected.body).toBe(201);
    expect(corrected.json().rows[0]).toMatchObject({ status: 'recorded', replaces: dutyId });

    // A duty and rest assessment names the periods by the operator's ids.
    const assessment = await upload(
      'alpha',
      'operator',
      Buffer.from(
        `subjectId,assessedAt [local],dutyPeriodId,restPeriodId,weeklyRestPeriodId,calendarDayDutyHours,weekStartsAt [local],weekDutyHours,timeZone,scheduleReference\n${person},2026-11-10 05:45,${run}-DUTY-1,${run}-REST-1,${run}-REST-1,10.5,2026-11-09 00:00,10.5,America/Chicago,Roster week 46\n`,
      ),
      'text/csv',
    );
    const assessed = await commit('alpha', 'operator', {
      artifactId: assessment,
      recordType: 'person.rest-assessment',
      recordVersion: 1,
    });
    expect(assessed.statusCode, assessed.body).toBe(201);
    expect(assessed.json().rows[0]).toMatchObject({
      status: 'recorded',
      complete: true,
      record: { dutyPeriodId: { id: `${run}-DUTY-1`, scope: 'source' } },
    });
  });

  it('refuses through generic intake an envelope time that disagrees with the record body', async () => {
    const artifactId = await upload('alpha', 'operator', Buffer.from('{"entered":true}'), 'application/json');
    const observation = {
      type: 'operator.record',
      version: 1,
      subject: { kind: 'aircraft', id: `${run}-ALPHA-AC-109`, scope: 'source' },
      occurredAt: '2026-07-01T00:00:00Z',
      fidelity: 'documented_schema_conformant',
      limitations: [],
      originalArtifactId: artifactId,
      values: {
        recordType: 'aircraft.time-in-service',
        recordVersion: 1,
        record: { totalTimeHours: 5, coveredThroughAt: '2026-06-30T00:00:00Z' },
      },
    };
    const input = (payload: typeof observation) => ({
      sourceId: 'operator-records',
      kind: 'observation',
      occurredAt: payload.occurredAt,
      payload,
    });
    const refused = await call('alpha', 'operator', 'POST', '/v1/inputs', input(observation));
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.json().error.code).toBe('record_time_disagreement');
    const agreed = await call(
      'alpha',
      'operator',
      'POST',
      '/v1/inputs',
      input({ ...observation, occurredAt: '2026-06-30T00:00:00Z' }),
    );
    expect(agreed.statusCode, agreed.body).toBe(201);
  });
});
