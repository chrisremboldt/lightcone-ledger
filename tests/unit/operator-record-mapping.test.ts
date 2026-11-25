import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyRecordMapping,
  findOperatorRecordDefinition,
  interpretRecordRow,
  loadRecordMapping,
  mappingLimitation,
  parseRecordFile,
  standardObservationRegistry,
  type OperatorRecordDefinition,
  type RecordMapping,
} from '../../packages/contracts/src/index.js';
import { readRecordMappingFile } from '../../packages/contracts/src/operator-record-mapping-file.js';
import { mappingStart } from '../../packages/cli/src/record-mapping.js';
import { listOperatorRecordTypes } from '../../packages/domain/src/operator-record-import.js';

const records = join(import.meta.dirname, '..', '..', 'examples', 'first-operator', 'records');
const example = (name: string) => readFileSync(join(records, name), 'utf8');
const type = (recordType: string): OperatorRecordDefinition =>
  findOperatorRecordDefinition(standardObservationRegistry, recordType, 1)!;
const flightRecord = type('flight.record');
const flightPlan = type('flight.plan');
const csv = (text: string) => parseRecordFile(new TextEncoder().encode(text), 'csv');
const denver = { timeZone: 'America/Denver' };

function load(definition: OperatorRecordDefinition, yaml: string): RecordMapping {
  const read = readRecordMappingFile(definition, yaml);
  if (!('mapping' in read)) throw new Error(read.problems.join('\n'));
  return read.mapping;
}
const problems = (definition: OperatorRecordDefinition, yaml: string) =>
  'mapping' in readRecordMappingFile(definition, yaml) ? [] : readRecordMappingFile(definition, yaml).problems;

describe('the worked example: a flight log export read through its mapping', () => {
  const mapping = load(flightRecord, example('flight-log.mapping.yaml'));
  const read = applyRecordMapping(flightRecord, mapping, csv(example('flight-log.export.csv')), denver);

  it('reads every flown row, leaves the cancelled one out and lists the columns it did not read', () => {
    expect(read.problems).toEqual([]);
    expect(read.rows.map((row) => [row.row, row.reading.subject?.id, row.reading.problems])).toEqual([
      [1, 'FLT-2026-1101', []],
      [2, 'FLT-2026-1102', []],
      [3, 'FLT-2026-1103', []],
    ]);
    expect(read.leftOut).toEqual([{ row: 4, reason: 'Status is "Cancelled".' }]);
    expect(read.unread).toEqual(['PIC', 'Remarks']);
    expect(read.columns.find((column) => column.source === 'Max Alt (ft AGL)')?.becomes).toBe(
      'maxHeightFlownAboveGroundMeters (Maximum height flown above ground), in ft',
    );
  });

  it('reads US-style local times in the organization’s zone and keeps them as the export wrote them', () => {
    const first = read.rows[0]!;
    expect(first.cells).toMatchObject({
      'takeoffAt [local]': '2026-11-10 09:05',
      'maxHeightFlownAboveGround [ft]': '148',
      secondarySubjectId: 'RIDGE-AC-1',
    });
    expect(first.reading.record).toMatchObject({
      takeoffAt: '2026-11-10T16:05:00Z',
      landingAt: '2026-11-10T16:47:00Z',
      maxHeightFlownAboveGroundMeters: 45.1104,
      windAtTakeoffMetersPerSecond: 6.173333,
      batteryAtLandingPercent: 41,
    });
    expect(first.reading.timeConversions[0]).toEqual({
      field: 'takeoffAt',
      entered: '11/10/2026 9:05 AM',
      timeZone: 'America/Denver',
      stored: '2026-11-10T16:05:00Z',
    });
    expect(first.reading.conversions.map((conversion) => conversion.entered)).toEqual([
      { value: 148, unit: 'ft' },
      { value: 12, unit: 'kts' },
      { value: 10, unit: 'sm' },
    ]);
  });

  it('gives the same output for the same inputs', () => {
    expect(applyRecordMapping(flightRecord, mapping, csv(example('flight-log.export.csv')), denver)).toEqual(read);
  });

  it('refuses the same export, row by row, when the mapping does not give the date style', () => {
    const plain = load(flightRecord, example('flight-log.mapping.yaml').replace('  style: MM/DD/YYYY h:mm A\n', ''));
    const refused = applyRecordMapping(flightRecord, plain, csv(example('flight-log.export.csv')), denver);
    expect(refused.rows[0]!.reading.problems[0]).toBe(
      'Takeoff at (takeoffAt): "11/10/2026 9:05 AM" is not written as 2026-11-10 09:05, Ledger’s own form, and the mapping gives no style for column "Date/Time Up"; nor is it a date alone written as YYYY-MM-DD.',
    );
  });

  it('leaves the unfixed flight plan file refused without a mapping, with the same reasons', () => {
    const unfixed = csv(example('flight.plan.unfixed.csv'));
    const reasons = unfixed.rows.map((row) => interpretRecordRow(flightPlan, row.cells, denver).problems);
    expect(reasons[0]).toContain(
      'Window starts (windowStartsAt): "11/10/2026 9:00 AM" is not a time Ledger can read. Write it in UTC as 2026-11-10T15:00:00Z, with its offset as 2026-11-10T09:00-06:00, or in the organization’s time zone under a heading ending in [local] as 2026-11-10 09:00.',
    );
    expect(reasons[0]).toContain(
      'Visual line of sight (visualMode): "BVLOS" is not one of visual_line_of_sight, beyond_visual_line_of_sight.',
    );
    expect(reasons[1]!.length).toBeGreaterThan(0);
  });
});

describe('a mapping with words, constants and UTC times', () => {
  const yaml = `recordType: flight.plan
recordVersion: 1
times:
  zone: utc
  style: DD.MM.YYYY HH:mm
subject: { column: Job }
relatedSubject: { column: Drone }
columns:
  Start: windowStartsAt
  End: { field: windowEndsAt, zone: organization, style: MM/DD/YYYY h:mm A }
  Kind: { field: operationKind, words: { "Line inspection": inspection } }
  Sight: { field: visualMode, words: { BVLOS: beyond_visual_line_of_sight, VLOS: visual_line_of_sight } }
  From: plannedOriginDescription
  To: plannedDestinationDescription
  Route: routeSummary
  Ceiling: { field: plannedMaxHeightAboveGroundMeters, unit: ft }
constants:
  operatingAuthorityReference: 107W-EX-2026-00417
  pilotInOperatingArea: "yes"
leaveOut:
  - column: Kind
    is: [Training, Test]
`;
  const mapping = load(flightPlan, yaml);
  const file = csv(`Job,Drone,Start,End,Kind,Sight,From,To,Route,Ceiling
FLT-X-1,RIDGE-AC-1,10.11.2026 16:00,11/10/2026 10:00 AM,line inspection,bvlos,Pad,Pad,Line 14,150
FLT-X-2,RIDGE-AC-1,10.11.2026 16:00,11/10/2026 10:00 AM,Training,VLOS,Pad,Pad,Line 14,150
FLT-X-3,RIDGE-AC-1,31.11.2026 16:00,2026-11-10T17:00:00Z,Patrol,BVLOS,Pad,Pad,Line 14,150 ft AGL
`);
  const read = applyRecordMapping(flightPlan, mapping, file, denver);

  it('translates the export’s words into options, states the constants and reads UTC times', () => {
    const row = read.rows[0]!;
    expect(row.reading.problems).toEqual([]);
    expect(row.reading.record).toMatchObject({
      windowStartsAt: '2026-11-10T16:00:00Z',
      windowEndsAt: '2026-11-10T17:00:00Z',
      operationKind: 'inspection',
      visualMode: 'beyond_visual_line_of_sight',
      operatingAuthorityReference: '107W-EX-2026-00417',
      pilotInOperatingArea: 'yes',
    });
    expect(row.reading.timeConversions).toEqual([
      { field: 'windowStartsAt', entered: '10.11.2026 16:00', timeZone: 'UTC', stored: '2026-11-10T16:00:00Z' },
      {
        field: 'windowEndsAt',
        entered: '11/10/2026 10:00 AM',
        timeZone: 'America/Denver',
        stored: '2026-11-10T17:00:00Z',
      },
    ]);
    expect(read.leftOut).toEqual([{ row: 2, reason: 'Kind is "Training".' }]);
    expect(read.constants).toHaveLength(2);
  });

  it('refuses what it cannot read in the import’s own words, and reads a time that states its own zone', () => {
    const row = read.rows[1]!;
    expect(row.row).toBe(3);
    expect(row.reading.problems).toEqual([
      'Window starts (windowStartsAt): "31.11.2026 16:00" is not a real date and time.',
      'Kind of operation (operationKind): "Patrol" is not one of aerial_survey, inspection, package_delivery, agricultural, training, test, other.',
      'Planned maximum height above ground (plannedMaxHeightAboveGroundMeters): "150 ft AGL" has "AGL" after the unit. Remove "AGL" and keep the number and its unit, such as 150 ft.',
    ]);
    expect(row.reading.record.windowEndsAt).toBe('2026-11-10T17:00:00Z');
  });

  it('names the mapping and the constants in a sentence kept with each record', () => {
    expect(mappingLimitation('artifact-1', mapping.constants)).toBe(
      'Read from its original file through the column mapping retained as file artifact-1. The mapping states operatingAuthorityReference, pilotInOperatingArea for every row; the original does not hold them.',
    );
  });

  it('refuses an export that lacks a column the mapping reads', () => {
    const short = applyRecordMapping(flightPlan, mapping, csv('Job,Drone\nFLT-X-1,RIDGE-AC-1\n'), denver);
    expect(short.rows).toEqual([]);
    expect(short.problems[0]).toBe(
      'The mapping reads column "Start", which the export does not have. Its columns: Job, Drone.',
    );
  });
});

describe('loading a mapping', () => {
  const head = 'recordType: flight.plan\nrecordVersion: 1\ntimes: { zone: organization }\nsubject: { column: Job }\n';

  it('refuses a field the record type does not have, or an option it does not offer, with the line', () => {
    expect(problems(flightPlan, `${head}columns:\n  Start: windowStartsAt\n  Alt: heightFeet\n`)).toEqual([
      expect.stringMatching(
        /^Line 7: column "Alt": flight.plan has no field "heightFeet"\. Its fields: windowStartsAt, /,
      ),
    ]);
    expect(
      problems(flightPlan, `${head}columns:\n  Sight:\n    field: visualMode\n    words:\n      BVLOS: bvlos\n`),
    ).toEqual([
      'Line 9: column "Sight": "bvlos" is not an option of visualMode; its options are visual_line_of_sight, beyond_visual_line_of_sight.',
    ]);
    expect(problems(flightPlan, `${head}constants:\n  operationKind: survey\n`)).toEqual([
      'Line 6: "survey" is not an option of operationKind; its options are aerial_survey, inspection, package_delivery, agricultural, training, test, other.',
    ]);
  });

  it('never guesses a unit or a zone', () => {
    expect(problems(flightPlan, `${head}columns:\n  Alt: plannedMaxHeightAboveGroundMeters\n`)).toEqual([
      'Line 6: column "Alt": plannedMaxHeightAboveGroundMeters is a number; say the unit the export writes it in with unit: (m, ft, mi, sm, nm). A cell that carries its own unit still wins.',
    ]);
    const noZone =
      'recordType: flight.plan\nrecordVersion: 1\nsubject: { column: Job }\ncolumns:\n  Start: windowStartsAt\n';
    expect(problems(flightPlan, noZone)).toEqual([
      'Line 5: column "Start" holds times: say whether they are in the organization’s time zone or in UTC, with zone: organization or zone: utc (under times for every column).',
    ]);
    expect(problems(flightPlan, `${head}constants:\n  plannedMaxHeightAboveGroundMeters: 120\n`)).toEqual([
      'Line 6: the constant for plannedMaxHeightAboveGroundMeters: write the number with its unit (m, ft, mi, sm, nm), such as 120 ft.',
    ]);
  });

  it('refuses keys, styles and record types it does not know, and holds no expression', () => {
    expect(problems(flightPlan, `${head}formula: windowStartsAt + 1\n`)).toEqual([
      'Line 5: "formula" is not part of a mapping. A mapping has recordType, recordVersion, times, subject, relatedSubject, columns, constants, leaveOut.',
    ]);
    expect(
      problems(flightPlan, `${head.replace('{ zone: organization }', '{ zone: local, style: DD/MM/YY }')}`),
    ).toEqual([
      'Line 3: zone is organization (the organization’s time zone) or utc, not "local".',
      expect.stringContaining('style "DD/MM/YY" has "Y"'),
    ]);
    expect(problems(flightRecord, head)[0]).toBe(
      'Line 1: The mapping is for flight.plan version 1, not flight.record version 1.',
    );
    expect(problems(flightPlan, 'recordType: flight.plan\nrecordVersion: 1\nrecordVersion: 2\n')[0]).toMatch(
      /^Line 3: the mapping is not valid YAML: Map keys must be unique/,
    );
  });

  it('refuses a mapping that names no subject column for a record type about a subject', () => {
    expect(loadRecordMapping(flightPlan, { recordType: 'flight.plan', recordVersion: 1 }).problems).toEqual([
      'flight.plan records are about a flight: give the column that holds your own id for it, with subject: column:.',
    ]);
  });
});

describe('starting a mapping from an export', () => {
  const summary = listOperatorRecordTypes().find((item) => item.recordType === 'flight.record')!;
  const headings = csv(example('flight-log.export.csv')).columns!;
  const start = mappingStart(summary, 'flight-log.export.csv', headings);

  it('lists every column of the export unassigned and every field as a comment, guessing nothing', () => {
    for (const heading of headings) expect(start).toContain(`  ${JSON.stringify(heading)}: ~\n`);
    expect(start).toContain(
      '#   maxHeightFlownAboveGroundMeters: Maximum height flown above ground (number; required; stored in m; unit: m, ft, mi, sm, nm)',
    );
    expect(start).toContain('#   takeoffAt: Takeoff at (a time; places the record; takes a date alone)');
    const loaded = readRecordMappingFile(flightRecord, start);
    expect('mapping' in loaded).toBe(false);
    expect(loaded.problems).toEqual([
      'Line 17: flight.record records are about a flight: give the column that holds your own id for it, with subject: column:.',
    ]);
  });
});
