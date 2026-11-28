import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OperatorRecordListResponse, OperatorRecordPreviewResponse } from '../../packages/contracts/src/index.js';
import { flightRecordCsv, readDjiFramesCsv } from '../../packages/flight-logs/src/index.js';
import { djiLastRowWithIds } from '../../packages/flight-logs/tests/encoders.js';
import { sha256 } from '../../packages/integrity/src/index.js';
import { coverageTenant, type CoverageTenant } from './coverage-tenant.js';
import { settleOwnedWork } from './worker-queue.js';

// examples/dji-flight-record, imported as its page says, through the public API: the invented CSV of frames read by
// the reader and imported as rows with the CSV as their original, and its last row read through the column mapping.
// If this test and that page disagree, this test is right.
const example = new URL('../../examples/dji-flight-record/', import.meta.url);
const file = (name: string) => readFileSync(new URL(name, example));

describe('The DJI flight record example, imported both ways', () => {
  let byReader: CoverageTenant;
  let byMapping: CoverageTenant;

  beforeAll(async () => {
    byReader = await coverageTenant('dji-frames-reader');
    byMapping = await coverageTenant('dji-frames-mapping');
  });
  afterAll(async () => {
    await settleOwnedWork([byReader?.prefix, byMapping?.prefix].filter(Boolean) as string[]);
    await byReader?.close();
    await byMapping?.close();
  });

  const records = async (tenant: CoverageTenant) => {
    const listed = await tenant.call(tenant.operator, 'GET', '/v1/operator-records?recordType=flight.record');
    expect(listed.statusCode, listed.body).toBe(200);
    return (listed.json() as OperatorRecordListResponse).records;
  };

  it('imports the flight the reader reads from the CSV of frames, with that CSV kept as the original', async () => {
    const frames = file('frames.csv');
    const reading = await readDjiFramesCsv([frames]);
    const read = flightRecordCsv(reading, { name: 'frames.csv', sha256: sha256(frames) });
    // What the CSV does not hold, a person writes: the flight's and the aircraft's own ids. The height above the
    // ground is left for a person too, so the record is kept incomplete.
    const rows = read.replace('\r\n,,2026-', '\r\nFLT-2026-1105,RIDGE-AC-1,2026-');
    expect(rows).not.toBe(read);
    const originalArtifactId = await byReader.upload(frames, 'text/csv');
    const artifactId = await byReader.upload(Buffer.from(rows), 'text/csv');
    const body = { artifactId, originalArtifactId, recordType: 'flight.record', recordVersion: 1 };

    const preview = await byReader.call(byReader.operator, 'POST', '/v1/operator-records/imports/preview', body);
    expect(preview.statusCode, preview.body).toBe(200);
    expect((preview.json() as OperatorRecordPreviewResponse).summary).toMatchObject({
      rows: 1,
      refused: 0,
      incomplete: 1,
    });
    const committed = await byReader.call(byReader.operator, 'POST', '/v1/operator-records/imports', body);
    expect(committed.statusCode, committed.body).toBe(201);
    expect(committed.json().summary).toMatchObject({ rows: 1, incomplete: 1, alreadyRecorded: 0, refused: 0 });

    const [record] = await records(byReader);
    expect(record!.subject).toMatchObject({ kind: 'flight', id: 'FLT-2026-1105' });
    expect(record!.record).toMatchObject({
      takeoffAt: '2026-11-10T16:05:06Z',
      landingAt: '2026-11-10T16:05:37Z',
      takeoffLocation: '39.5012345, -105.2034567',
      landingLocations: '39.5141000, -105.1873000',
      heightNotes:
        'Greatest height 44.8 m above the takeoff point, the reference the app records height from. The log does not hold the height above the ground.',
    });
    expect(record!.record).not.toHaveProperty('maxHeightFlownAboveGroundMeters');
    expect(record!.origin).toMatchObject({ artifactId: originalArtifactId });
  });

  it('imports the same file’s last row through the column mapping, with its two times and nothing else', async () => {
    const oneRow = djiLastRowWithIds(file('frames.csv').toString('utf8'), 'FLT-2026-1105', 'RIDGE-AC-1');
    const artifactId = await byMapping.upload(Buffer.from(oneRow), 'text/csv');
    const mappingArtifactId = await byMapping.upload(file('dji-log-frames.mapping.yaml'), 'application/yaml');
    const body = { artifactId, mappingArtifactId, recordType: 'flight.record', recordVersion: 1 };

    const preview = await byMapping.call(byMapping.operator, 'POST', '/v1/operator-records/imports/preview', body);
    expect(preview.statusCode, preview.body).toBe(200);
    const checked = preview.json() as OperatorRecordPreviewResponse;
    expect(checked.summary).toMatchObject({ rows: 1, refused: 0, incomplete: 1 });
    expect(checked.mapping).toMatchObject({ artifactId: mappingArtifactId, constants: [], leftOut: [] });
    expect(checked.mapping?.unread).toContain('OSD.heightMax');

    const committed = await byMapping.call(byMapping.operator, 'POST', '/v1/operator-records/imports', body);
    expect(committed.statusCode, committed.body).toBe(201);
    expect(committed.json().summary).toMatchObject({ rows: 1, incomplete: 1, alreadyRecorded: 0, refused: 0 });

    const [record] = await records(byMapping);
    // The start of the log and the time of its last frame: earlier and later than the takeoff and the landing.
    expect(record!.record).toMatchObject({
      takeoffAt: '2026-11-10T16:04:58.000Z',
      landingAt: '2026-11-10T16:05:39.000Z',
    });
    expect(record!.record).not.toHaveProperty('takeoffLocation');
    expect(record!.origin).toMatchObject({ artifactId, contentType: 'text/csv' });
    expect(record!.limitations[0]).toBe(
      `Read from its original file through the column mapping retained as file ${mappingArtifactId}.`,
    );
  });
});
