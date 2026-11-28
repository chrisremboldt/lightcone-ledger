import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyRecordMapping,
  findOperatorRecordDefinition,
  missingRequiredFields,
  parseRecordFile,
  standardObservationRegistry,
} from '../../packages/contracts/src/index.js';
import { readRecordMappingFile } from '../../packages/contracts/src/operator-record-mapping-file.js';
import { djiLastRowWithIds } from '../../packages/flight-logs/tests/encoders.js';

// The second way in of docs/design/manufacturer-flight-logs.md: the last row of an open tool's CSV for a DJI flight
// record, read as a flight.record through a column mapping. The export is invented; its column names are the tool's
// own, read from its source.
const folder = join(import.meta.dirname, '..', '..', 'examples', 'dji-flight-record');
const file = (name: string) => readFileSync(join(folder, name), 'utf8');
const flightRecord = findOperatorRecordDefinition(standardObservationRegistry, 'flight.record', 1)!;
const oneRow = djiLastRowWithIds(file('frames.csv'), 'FLT-2026-1105', 'RIDGE-AC-1');
const exported = () => parseRecordFile(new TextEncoder().encode(oneRow), 'csv');
const denver = { timeZone: 'America/Denver' };

describe('the worked example: the last row of the dji-log tool’s CSV read through its mapping', () => {
  const loaded = readRecordMappingFile(flightRecord, file('dji-log-frames.mapping.yaml'));
  if (!('mapping' in loaded)) throw new Error(loaded.problems.join('\n'));
  const read = applyRecordMapping(flightRecord, loaded.mapping, exported(), denver);

  it('reads the flight under the ids put in front, with the start of the log and the last frame’s time in UTC', () => {
    expect(read.problems).toEqual([]);
    expect(read.leftOut).toEqual([]);
    expect(
      read.rows.map((row) => [row.reading.subject?.id, row.reading.secondarySubject?.id, row.reading.record]),
    ).toEqual([
      ['FLT-2026-1105', 'RIDGE-AC-1', { takeoffAt: '2026-11-10T16:04:58.000Z', landingAt: '2026-11-10T16:05:39.000Z' }],
    ]);
    for (const row of read.rows) expect(row.reading.problems).toEqual([]);
  });

  it('reads no place and no height: a person writes them, and until then the record is incomplete', () => {
    expect(read.columns.map((column) => column.source)).toEqual([
      'Flight id',
      'Aircraft id',
      'DETAILS.startTime',
      'CUSTOM.dateTime',
    ]);
    expect(read.unread).toEqual([
      'OSD.flyTime',
      'OSD.latitude',
      'OSD.longitude',
      'OSD.height',
      'OSD.heightMax',
      'OSD.altitude',
      'OSD.isOnGround',
      'OSD.isMotorOn',
      'HOME.latitude',
      'HOME.longitude',
      'HOME.altitude',
      'DETAILS.totalTime',
      'DETAILS.maxHeight',
      'DETAILS.aircraftName',
      'DETAILS.aircraftSerial',
    ]);
    for (const row of read.rows)
      expect(missingRequiredFields(flightRecord, row.reading.record)).toEqual([
        'takeoffLocation',
        'landingLocations',
        'maxHeightFlownAboveGroundMeters',
      ]);
  });

  it('names every column of the export, so that none is left unread by oversight', () => {
    const mapping = file('dji-log-frames.mapping.yaml');
    for (const heading of exported().columns!) expect(mapping, heading).toContain(`  '${heading}': `);
  });

  it('says on its page and in the mapping that it was built from documentation and tried against nothing real', () => {
    expect(file('README.md')).toContain('Built from documentation, and run against nothing real.');
    expect(file('dji-log-frames.mapping.yaml')).toContain('has been tried against no CSV the tool wrote');
  });
});
