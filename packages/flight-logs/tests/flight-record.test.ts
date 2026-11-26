import {
  flightRecordV1,
  interpretRecordRow,
  missingRequiredFields,
  parseRecordFile,
  recordCsvTemplate,
} from '@ledger/contracts';
import { describe, expect, it } from 'vitest';
import { flightRecordCsv, readingLines, readUlog } from '../src/index.js';
import { px4, px4Definitions, QUARRY, RIDGE, UlogWriter } from './encoders.js';

const S = 1_000_000;
const UTC = Date.UTC(2026, 10, 10, 16, 5, 0) * 1000;
const LOG = { name: 'RIDGE-AC-1-2026-11-10.ulg', sha256: 'a'.repeat(64) };

async function reading(withTime: boolean) {
  const log = px4Definitions(new UlogWriter());
  if (withTime) px4.gps(log, 5 * S, UTC + 5 * S, RIDGE);
  px4.landed(log, 6 * S, true);
  px4.status(log, 10 * S, true);
  px4.global(log, 11 * S, RIDGE, 1850);
  px4.landed(log, 12 * S, false);
  px4.global(log, 30 * S, RIDGE, 1895);
  px4.landed(log, 40 * S, true);
  px4.landed(log, 45 * S, false);
  px4.global(log, 60 * S, QUARRY, 1870);
  px4.landed(log, 70 * S, true);
  px4.status(log, 72 * S, false);
  return readUlog([log.done()]);
}

describe('flight records from a log', () => {
  it('writes the import template’s columns and fills only what the log holds', async () => {
    const csv = flightRecordCsv(await reading(true), LOG);
    expect(csv.split('\r\n')[0]).toBe(recordCsvTemplate(flightRecordV1).trimEnd());
    const parsed = parseRecordFile(new TextEncoder().encode(csv), 'csv');
    expect(parsed.problems).toEqual([]);
    const row = parsed.rows[0]!;
    expect(row.cells).toMatchObject({
      subjectId: '',
      secondarySubjectId: '',
      takeoffAt: '2026-11-10T16:05:12Z',
      landingAt: '2026-11-10T16:06:10Z',
      takeoffLocation: '39.5012345, -105.2034567',
      landingLocations: '39.5012345, -105.2034567; 39.5141000, -105.1873000',
      maxHeightFlownAboveGroundMeters: '',
      windAtTakeoffMetersPerSecond: '',
    });
    expect(row.cells.heightNotes).toMatch(/^Greatest height 45 m above the takeoff point/);
    expect(row.cells.heightNotes).toMatch(/does not hold the height above the ground/);
    expect(row.cells.flightPathReference).toMatch(
      /^RIDGE-AC-1-2026-11-10\.ulg \(sha256 a{64}\), flight 1, bytes \d+ to \d+; touched down 2 times/,
    );
    const read = interpretRecordRow(flightRecordV1, row.cells, { timeZone: 'America/Denver' });
    // The flight's own id and the height above the ground are for a person to write.
    expect(read.problems).toEqual(['subjectId is needed.']);
    expect(missingRequiredFields(flightRecordV1, read.record)).toEqual(['maxHeightFlownAboveGroundMeters']);
  });

  it('leaves the times empty when the log holds no absolute time', async () => {
    const parsed = parseRecordFile(new TextEncoder().encode(flightRecordCsv(await reading(false), LOG)), 'csv');
    expect(parsed.rows[0]!.cells).toMatchObject({ takeoffAt: '', landingAt: '' });
  });

  it('says what it read and what it could not', async () => {
    const lines = readingLines(await reading(false), LOG.name).join('\n');
    expect(lines).toMatch(/1 whole flight\./);
    expect(lines).toMatch(/no absolute time/);
    expect(lines).toMatch(/no time of day, 58 s\./);
    expect(lines).toMatch(/EXAMPLE-RIDGE-0001 \(the ULog information field sys_uuid\); it is not your own id/);
  });
});
