import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  aboutOwnOrganization,
  convertToStoredUnit,
  describeTimeConversion,
  findOperatorRecordDefinition,
  interpretRecordRow,
  operatorRecordTime,
  operatorRecordTypesV1,
  parseRecordFile,
  recordCsvTemplate,
  recordFileFormat,
  recordImportColumns,
  recordImportSubjectColumns,
  recordJsonTemplate,
  recordIntervalProblem,
  recordTimeDisagreement,
  standardObservationRegistry,
  type OperatorRecordDefinition,
} from '../../packages/contracts/src/index.js';
import { validateObservation } from '../../packages/domain/src/observation-registry.js';

const fixtures = join(import.meta.dirname, '..', '..', 'packages', 'contracts', 'fixtures', 'operator-records');
const fixture = (name: string) => new Uint8Array(readFileSync(join(fixtures, name)));
const type = (recordType: string): OperatorRecordDefinition =>
  findOperatorRecordDefinition(standardObservationRegistry, recordType, 1)!;
const training = type('person.training');
const timeInService = type('aircraft.time-in-service');
const flightPlan = type('flight.plan');
const roleAssignment = type('operation.role-assignment');
const procedure = type('organization.procedure');
const bytes = (text: string) => new TextEncoder().encode(text);

describe('import templates generated from field metadata', () => {
  it('gives every record type a column per field, in field order, after its subject columns', () => {
    for (const definition of operatorRecordTypesV1) {
      const columns = recordImportColumns(definition);
      const fieldColumns = columns.filter((column) => column.field);
      expect(fieldColumns.map((column) => column.key)).toEqual(definition.fields.map((field) => field.name));
      // A record about the operator's own organization asks for no subject.
      if (aboutOwnOrganization(definition)) expect(columns.some((column) => column.key === 'subjectId')).toBe(false);
      else expect(columns[0]!.key).toBe('subjectId');
      expect(columns.at(-1)!.key).toBe('replaces');
      // Subject and replacement columns never collide with a field name.
      for (const key of Object.values(recordImportSubjectColumns))
        expect(definition.fields.some((field) => field.name === key)).toBe(false);
    }
  });

  it('puts units in number columns and lists accepted entry units', () => {
    const height = recordImportColumns(flightPlan).find(
      (column) => column.key === 'plannedMaxHeightAboveGroundMeters',
    )!;
    expect(height.units).toMatchObject({ stored: 'm', stem: 'plannedMaxHeightAboveGround' });
    expect(height.units!.accepted.map((unit) => unit.unit)).toEqual(['m', 'ft', 'mi', 'nm']);
    const speed = recordImportColumns(flightPlan).find(
      (column) => column.key === 'plannedMaxGroundSpeedMetersPerSecond',
    )!;
    expect(speed.units!.accepted.map((unit) => unit.unit)).toEqual(['m/s', 'kn', 'mph']);
  });

  it('asks for a subject kind only when the type allows more than one', () => {
    expect(recordImportColumns(training).some((column) => column.key === 'subjectKind')).toBe(false);
    expect(recordImportColumns(roleAssignment).some((column) => column.key === 'subjectKind')).toBe(true);
  });

  it('writes a CSV header row and a JSON document that parse back to an empty record', () => {
    const csv = recordCsvTemplate(timeInService);
    expect(csv).toBe(
      'subjectId,entryKind,totalTimeHours,coveredThroughAt,sourceReference,coverage,coverageNotes,flightCount,replaces\r\n',
    );
    expect(parseRecordFile(bytes(csv), 'csv')).toMatchObject({ rows: [], problems: [] });
    const json = JSON.parse(recordJsonTemplate(training));
    expect(json).toMatchObject({ recordType: 'person.training', recordVersion: 1 });
    expect(Object.keys(json.records[0])).toEqual(recordImportColumns(training).map((column) => column.key));
  });
});

describe('unit conversion', () => {
  it('converts feet, statute miles and knots to stored units, rounded repeatably', () => {
    expect(convertToStoredUnit(400, 'Meters', 'ft')).toBe(121.92);
    expect(convertToStoredUnit(1, 'Meters', 'mi')).toBe(1609.344);
    expect(convertToStoredUnit(10, 'MetersPerSecond', 'kn')).toBe(5.144444);
    expect(convertToStoredUnit(3, 'Hours', 'h')).toBe(3);
    expect(convertToStoredUnit(3, 'Hours', 'min')).toBeUndefined();
  });

  it('reads a unit in a column name and states the conversion', () => {
    const reading = interpretRecordRow(flightPlan, {
      subjectId: 'FLIGHT-1',
      'plannedMaxHeightAboveGround [ft]': '400',
      'plannedMaxGroundSpeedMetersPerSecond [kn]': 20,
    });
    expect(reading.problems).toEqual([]);
    expect(reading.record).toEqual({
      plannedMaxHeightAboveGroundMeters: 121.92,
      plannedMaxGroundSpeedMetersPerSecond: 10.288889,
    });
    expect(reading.conversions).toEqual([
      {
        field: 'plannedMaxHeightAboveGroundMeters',
        entered: { value: 400, unit: 'ft' },
        stored: { value: 121.92, unit: 'm' },
      },
      {
        field: 'plannedMaxGroundSpeedMetersPerSecond',
        entered: { value: 20, unit: 'kn' },
        stored: { value: 10.288889, unit: 'm/s' },
      },
    ]);
  });

  it('refuses an unknown unit, a unit on a field without one and a field given twice', () => {
    const reading = interpretRecordRow(flightPlan, {
      subjectId: 'FLIGHT-1',
      'plannedMaxHeightAboveGround [yd]': '10',
      'routeSummary [m]': 'along the line',
      plannedMaxDistanceFromControlStationMeters: '100',
      'plannedMaxDistanceFromControlStation [ft]': '300',
    });
    expect(reading.problems).toEqual([
      'Column "plannedMaxHeightAboveGround [yd]": unit "yd" is not accepted for Planned maximum height above ground; use m, ft, mi, sm, nm.',
      'Column "routeSummary [m]": Route does not take a unit.',
      expect.stringContaining('is given in more than one column'),
    ]);
  });
});

describe('units a pilot writes', () => {
  it('accepts kt, kts, nm, sm, ft and mph, in any case, and keeps the unit as written in the conversion', () => {
    const reading = interpretRecordRow(flightPlan, {
      subjectId: 'FLIGHT-1',
      'plannedMaxHeightAboveGround [FT]': '400',
      'plannedMaxDistanceFromControlStation [sm]': '2',
      'plannedMaxGroundSpeed [kt]': '25',
    });
    expect(reading.problems).toEqual([]);
    expect(reading.record).toEqual({
      plannedMaxHeightAboveGroundMeters: 121.92,
      plannedMaxDistanceFromControlStationMeters: 3218.688,
      plannedMaxGroundSpeedMetersPerSecond: 12.861111,
    });
    expect(reading.conversions.map((conversion) => conversion.entered.unit)).toEqual(['FT', 'sm', 'kt']);
    expect(convertToStoredUnit(1, 'Meters', 'nm')).toBe(1852);
    expect(convertToStoredUnit(10, 'MetersPerSecond', 'kts')).toBe(5.144444);
    expect(convertToStoredUnit(10, 'MetersPerSecond', 'mph')).toBe(4.4704);
    expect(convertToStoredUnit(1, 'Meters', 'yd')).toBeUndefined();
  });

  it('reads an option ignoring case and surrounding spaces, and guesses nothing else', () => {
    expect(interpretRecordRow(flightPlan, { subjectId: 'F', operationKind: '  Inspection ' }).record).toEqual({
      operationKind: 'inspection',
    });
    expect(interpretRecordRow(flightPlan, { subjectId: 'F', visualMode: 'BVLOS' }).problems[0]).toMatch(
      /"BVLOS" is not one of/,
    );
  });
});

describe('times in the organization’s zone', () => {
  const chicago = { timeZone: 'America/Chicago' };
  it('reads a [local] column in the organization’s zone and keeps what was entered and the zone', () => {
    const reading = interpretRecordRow(
      flightPlan,
      { subjectId: 'F', 'windowStartsAt [local]': '2026-11-10 09:00', 'windowEndsAt [local]': '2026-11-10T10:30:15' },
      chicago,
    );
    expect(reading.problems).toEqual([]);
    expect(reading.record).toEqual({ windowStartsAt: '2026-11-10T15:00:00Z', windowEndsAt: '2026-11-10T16:30:15Z' });
    expect(reading.timeConversions).toEqual([
      {
        field: 'windowStartsAt',
        entered: '2026-11-10 09:00',
        timeZone: 'America/Chicago',
        stored: '2026-11-10T15:00:00Z',
      },
      {
        field: 'windowEndsAt',
        entered: '2026-11-10T10:30:15',
        timeZone: 'America/Chicago',
        stored: '2026-11-10T16:30:15Z',
      },
    ]);
    expect(describeTimeConversion(flightPlan, reading.timeConversions[0]!)).toBe(
      'Window starts was entered as 2026-11-10 09:00 in America/Chicago and recorded as 2026-11-10T15:00:00Z.',
    );
  });

  it('accepts a time with an explicit offset under either heading, and UTC as before', () => {
    for (const key of ['windowStartsAt', 'windowStartsAt [local]']) {
      const reading = interpretRecordRow(flightPlan, { subjectId: 'F', [key]: '2026-07-01T09:00-05:00' }, chicago);
      expect(reading.problems).toEqual([]);
      expect(reading.record.windowStartsAt).toBe('2026-07-01T14:00:00Z');
      expect(reading.timeConversions).toEqual([
        { field: 'windowStartsAt', entered: '2026-07-01T09:00-05:00', stored: '2026-07-01T14:00:00Z' },
      ]);
    }
    const utc = interpretRecordRow(flightPlan, { subjectId: 'F', windowStartsAt: '2026-07-01T14:00:00Z' }, chicago);
    expect(utc.record.windowStartsAt).toBe('2026-07-01T14:00:00Z');
    expect(utc.timeConversions).toEqual([]);
  });

  it('refuses a time the zone skips or repeats, saying why and how to write it', () => {
    const gap = interpretRecordRow(
      flightPlan,
      { subjectId: 'F', 'windowStartsAt [local]': '2026-03-08 02:30' },
      chicago,
    );
    expect(gap.problems).toEqual([
      'Window starts (windowStartsAt): "2026-03-08 02:30" does not happen in America/Chicago; the clocks moved forward past it that day. Give the time with its offset.',
    ]);
    const repeat = interpretRecordRow(
      flightPlan,
      { subjectId: 'F', 'windowStartsAt [local]': '2026-11-01 01:30' },
      chicago,
    );
    expect(repeat.problems).toEqual([
      'Window starts (windowStartsAt): "2026-11-01 01:30" happens twice in America/Chicago, because the clocks moved back that day. Give it with its offset: 2026-11-01T01:30-05:00 for the first, 2026-11-01T01:30-06:00 for the second.',
    ]);
  });

  it('refuses US-style dates with a sentence showing the accepted forms, and a local time with no zone known', () => {
    const us = interpretRecordRow(
      flightPlan,
      { subjectId: 'F', 'windowStartsAt [local]': '11/10/2026 9:00 AM' },
      chicago,
    );
    expect(us.problems[0]).toBe(
      'Window starts (windowStartsAt): "11/10/2026 9:00 AM" is not a time Ledger can read. Write it in UTC as 2026-11-10T15:00:00Z, with its offset as 2026-11-10T09:00-06:00, or in the organization’s time zone under a heading ending in [local] as 2026-11-10 09:00.',
    );
    expect(
      interpretRecordRow(flightPlan, { subjectId: 'F', 'windowStartsAt [local]': '2026-11-10 09:00' }).problems[0],
    ).toMatch(/time zone is not known/);
    expect(
      interpretRecordRow(flightPlan, { subjectId: 'F', 'windowStartsAt [utc]': '2026-11-10 09:00' }).problems[0],
    ).toMatch(/write windowStartsAt \[local\]/);
  });
});

describe('a date without a time', () => {
  const denver = { timeZone: 'America/Denver' };
  const notification = type('operation.notification');
  const inspection = type('aircraft.inspection');

  it('places a record by a date alone, as that day in the organization’s zone, and keeps the day', () => {
    for (const key of ['notifiedAt', 'notifiedAt [local]']) {
      const reading = interpretRecordRow(
        notification,
        {
          subjectId: 'FLT-1',
          subjectKind: 'flight',
          [key]: '2026-11-30',
          recipient: 'Flight Service',
          means: 'online_form',
        },
        denver,
      );
      expect(reading.problems).toEqual([]);
      expect(reading.record.notifiedAt).toBe('2026-11-30T07:00:00Z');
      expect(reading.dayOnly).toEqual({
        notifiedAt: { day: '2026-11-30', timeZone: 'America/Denver', nextDayAt: '2026-12-01T07:00:00Z' },
      });
      expect(reading.timeConversions).toEqual([
        {
          field: 'notifiedAt',
          entered: '2026-11-30',
          timeZone: 'America/Denver',
          stored: '2026-11-30T07:00:00Z',
          precision: 'day',
        },
      ]);
      expect(describeTimeConversion(notification, reading.timeConversions[0]!)).toBe(
        'Notified at was entered as 2026-11-30, a date with no time; it is recorded as that day in America/Denver, from 2026-11-30T07:00:00Z to the end of the day.',
      );
    }
  });

  it('takes a date alone for the start and the end of an interval, a day of 23 hours included', () => {
    const reading = interpretRecordRow(
      inspection,
      { subjectId: 'AC-1', inspectedAt: '2026-03-08', nextDueAt: '2026-11-01' },
      denver,
    );
    expect(reading.problems).toEqual([]);
    // The end of the interval, a date alone, is the end of that day (a day of 25 hours here), as an adoption's --until.
    expect(reading.record).toMatchObject({ inspectedAt: '2026-03-08T07:00:00Z', nextDueAt: '2026-11-02T07:00:00Z' });
    expect(reading.dayOnly.inspectedAt).toEqual({
      day: '2026-03-08',
      timeZone: 'America/Denver',
      nextDayAt: '2026-03-09T06:00:00Z',
    });
    expect(reading.dayOnly.nextDueAt).toEqual({
      day: '2026-11-01',
      timeZone: 'America/Denver',
      nextDayAt: '2026-11-02T07:00:00Z',
    });
    expect(describeTimeConversion(inspection, reading.timeConversions[1]!)).toBe(
      'Next inspection due was entered as 2026-11-01, a date with no time; it ends the record, so it is recorded as the end of that day in America/Denver, 2026-11-02T07:00:00Z.',
    );
  });

  it('takes the same date alone as the start and the end of a flight plan window: the whole of that day', () => {
    const plan = type('flight.plan');
    const reading = interpretRecordRow(
      plan,
      { subjectId: 'RIDGE-F-1', windowStartsAt: '2026-11-10', windowEndsAt: '2026-11-10' },
      denver,
    );
    expect(reading.problems).toEqual([]);
    expect(reading.record).toMatchObject({
      windowStartsAt: '2026-11-10T07:00:00Z',
      windowEndsAt: '2026-11-11T07:00:00Z',
    });
    expect(recordIntervalProblem(plan, reading.record)).toBeUndefined();
    // A time in the start and a date alone in the end: the window runs to the end of that day.
    const timed = interpretRecordRow(
      plan,
      { subjectId: 'RIDGE-F-1', 'windowStartsAt [local]': '2026-11-10 09:00', windowEndsAt: '2026-11-10' },
      denver,
    );
    expect(timed.problems).toEqual([]);
    expect(timed.record.windowEndsAt).toBe('2026-11-11T07:00:00Z');
  });

  it('takes a date alone where a report or notice was made, as the day it was made in the organization’s zone', () => {
    const deviation = type('occurrence.emergency-deviation');
    const reading = interpretRecordRow(
      deviation,
      { subjectId: 'F', subjectKind: 'flight', occurredAt: '2026-08-14', reportedToAuthorityAt: '2026-08-17' },
      denver,
    );
    expect(reading.problems).toEqual([]);
    expect(reading.record.reportedToAuthorityAt).toBe('2026-08-17T06:00:00Z');
    expect(reading.dayOnly.reportedToAuthorityAt).toEqual({
      day: '2026-08-17',
      timeZone: 'America/Denver',
      nextDayAt: '2026-08-18T06:00:00Z',
    });
    const reportTimes = (recordType: string) =>
      recordImportColumns(type(recordType))
        .filter((column) => column.takesDate && !column.placesRecord)
        .map((column) => column.key);
    expect(reportTimes('occurrence.mechanical-irregularity')).toEqual([
      'reportedToManufacturerAt',
      'reportedToServiceProviderAt',
      'reportedToAuthorityAt',
    ]);
    expect(reportTimes('occurrence.operation-anomaly')).toEqual(['includedInSummaryAt', 'reportedToAuthorityAt']);
    expect(reportTimes('operation.role-assignment')).toEqual(['authorityNotifiedAt']);
  });

  it('refuses a date alone in a column that takes a time, and an impossible or zoneless date', () => {
    const detectAndAvoid = type('aircraft.detect-and-avoid');
    expect(
      interpretRecordRow(
        detectAndAvoid,
        {
          subjectId: 'RIDGE-AC-1',
          checkedAt: '2026-10-06',
          equipmentReference: 'Unit 1',
          equipmentState: 'inoperative',
          hazardDeterminedAt: '2026-10-07',
        },
        denver,
      ).problems,
    ).toEqual([
      'Determined not to be a hazard at (hazardDeterminedAt): "2026-10-07" is a date with no time. This column takes a time: a date alone is taken only in the column that places the record and in a column that says when a report or notice was made; write a time here in UTC as 2026-11-10T15:00:00Z, with its offset as 2026-11-10T09:00-06:00, or in the organization’s time zone under a heading ending in [local] as 2026-11-10 09:00.',
    ]);
    expect(
      interpretRecordRow(notification, { subjectId: 'F', subjectKind: 'flight', notifiedAt: '2026-02-30' }, denver)
        .problems[0],
    ).toBe('Notified at (notifiedAt): "2026-02-30" is not a real date.');
    expect(
      interpretRecordRow(notification, { subjectId: 'F', subjectKind: 'flight', notifiedAt: '2026-11-30' }).problems[0],
    ).toMatch(/time zone is not known, so the date "2026-11-30" cannot be placed/);
  });

  it('takes a time, not a date alone, for a record type recorded as its own observation type', () => {
    const duty = type('crew.duty-period');
    const reading = interpretRecordRow(duty, { subjectId: 'P-1', startsAt: '2026-10-05' }, denver);
    expect(reading.problems[0]).toMatch(/is a date with no time\. This column takes a time/);
    expect(recordImportColumns(duty).some((column) => column.takesDate)).toBe(false);
  });

  it('says which column places a record, and which takes a date alone', () => {
    const columns = recordImportColumns(inspection);
    expect(columns.filter((column) => column.placesRecord).map((column) => column.key)).toEqual([
      'inspectedAt',
      'nextDueAt',
    ]);
    expect(columns.find((column) => column.key === 'nextDueAt')).toMatchObject({
      required: false,
      requiredUnless: 'nextDueTimeInServiceHours',
      takesDate: true,
    });
  });
});

describe('a check made for a flight', () => {
  const denver = { timeZone: 'America/Denver' };

  it('names the flight a check before flight was made for, as its related subject', () => {
    const reading = interpretRecordRow(
      type('aircraft.detect-and-avoid'),
      {
        subjectId: 'RIDGE-AC-1',
        secondarySubjectId: 'RIDGE-F-12',
        checkedAt: '2026-11-12',
        equipmentReference: 'Unit 1',
        equipmentState: 'serviceable',
      },
      denver,
    );
    expect(reading.problems).toEqual([]);
    expect(reading.secondarySubject).toEqual({ kind: 'flight', id: 'RIDGE-F-12', scope: 'source' });
    expect(reading.dayOnly.checkedAt?.day).toBe('2026-11-12');
    for (const recordType of ['aircraft.detect-and-avoid', 'aircraft.inspection', 'component.inspection'])
      expect(type(recordType).secondarySubjectKinds, recordType).toContain('flight');
    // An aircraft inspection's related subject is a component or a flight, so the row says which.
    const inspection = type('aircraft.inspection');
    const row = {
      subjectId: 'RIDGE-AC-1',
      secondarySubjectId: 'RIDGE-F-12',
      inspectionKind: 'scheduled',
      inspectedAt: '2026-11-12',
      nextDueAt: '2026-12-12',
      recordedResult: 'serviceable',
      inspectorName: 'Sam Example',
    };
    expect(interpretRecordRow(inspection, row, denver).problems).toEqual([
      'secondarySubjectKind is needed: the related subject may be component, flight.',
    ]);
    expect(interpretRecordRow(inspection, { ...row, secondarySubjectKind: 'flight' }, denver).secondarySubject).toEqual(
      { kind: 'flight', id: 'RIDGE-F-12', scope: 'source' },
    );
  });
});

describe('a unit written in the cell', () => {
  const flightRecord = type('flight.record');
  it('reads 300ft, 104 m and 35% and keeps what was entered; the cell’s unit wins over the heading’s', () => {
    const reading = interpretRecordRow(flightRecord, {
      subjectId: 'FLT-1',
      'maxHeightFlownAboveGround [ft]': '104 m',
      'windAtTakeoff [kt]': '14kt',
      gustAtTakeoffMetersPerSecond: '20 kts',
      batteryAtLandingPercent: '35%',
      visibilityAtTakeoffMeters: '10 sm',
    });
    expect(reading.problems).toEqual([]);
    expect(reading.record).toEqual({
      maxHeightFlownAboveGroundMeters: 104,
      windAtTakeoffMetersPerSecond: 7.202222,
      gustAtTakeoffMetersPerSecond: 10.288889,
      batteryAtLandingPercent: 35,
      visibilityAtTakeoffMeters: 16093.44,
    });
    expect(reading.conversions.map((conversion) => [conversion.field, conversion.entered])).toEqual([
      ['windAtTakeoffMetersPerSecond', { value: 14, unit: 'kt' }],
      ['gustAtTakeoffMetersPerSecond', { value: 20, unit: 'kts' }],
      ['visibilityAtTakeoffMeters', { value: 10, unit: 'sm' }],
    ]);
    expect(
      interpretRecordRow(flightRecord, { subjectId: 'F', maxHeightFlownAboveGroundMeters: '300ft' }).record,
    ).toEqual({ maxHeightFlownAboveGroundMeters: 91.44 });
  });

  it('refuses words after the unit, or anything that is not a unit, saying what to remove', () => {
    expect(
      interpretRecordRow(flightRecord, { subjectId: 'F', 'maxHeightFlownAboveGround [ft]': '380 ft AGL' }).problems,
    ).toEqual([
      'Maximum height flown above ground (maxHeightFlownAboveGroundMeters): "380 ft AGL" has "AGL" after the unit. Remove "AGL" and keep the number and its unit, such as 380 ft.',
    ]);
    expect(interpretRecordRow(flightRecord, { subjectId: 'F', 'windAtTakeoff [kt]': '26G33' }).problems).toEqual([
      'Wind at takeoff (windAtTakeoffMetersPerSecond): "26G33" has "G33" after the number, which is not a unit Ledger reads for Wind at takeoff. Remove it, or write the number with one of m/s, kn, kt, kts, mph.',
    ]);
  });
});

describe('parsing files', () => {
  it('reads quoted CSV cells and locates each row by byte range in the original', () => {
    const text =
      'subjectId,courseTitle,providerAddress\r\nP-1,"Night, recurrent","1 Way\nTown"\r\nP-2,Café course,\r\n';
    const original = bytes(text);
    const parsed = parseRecordFile(original, 'csv');
    expect(parsed.problems).toEqual([]);
    expect(parsed.rows.map((row) => row.cells)).toEqual([
      { subjectId: 'P-1', courseTitle: 'Night, recurrent', providerAddress: '1 Way\nTown' },
      { subjectId: 'P-2', courseTitle: 'Café course', providerAddress: '' },
    ]);
    const decoder = new TextDecoder();
    const slice = (row: number) => {
      const locator = parsed.rows[row]!.locator;
      if (locator.kind !== 'byte_range') throw new Error('expected a byte range');
      return decoder.decode(
        original.subarray(locator.value.offsetBytes, locator.value.offsetBytes + locator.value.lengthBytes),
      );
    };
    expect(slice(0)).toBe('P-1,"Night, recurrent","1 Way\nTown"');
    expect(slice(1)).toBe('P-2,Café course,');
  });

  it('keeps byte ranges right after a byte order mark', () => {
    const original = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes('subjectId,courseTitle\nP-1,Course\n')]);
    const locator = parseRecordFile(original, 'csv').rows[0]!.locator;
    expect(locator).toEqual({ kind: 'byte_range', value: { offsetBytes: 25, lengthBytes: 10 } });
  });

  it('reports file problems instead of rows: duplicate header, unterminated quote, invalid JSON, not UTF-8', () => {
    expect(parseRecordFile(bytes('subjectId,subjectId\nA,B\n'), 'csv').problems).toEqual([
      'The header names column "subjectId" twice.',
    ]);
    expect(parseRecordFile(bytes('subjectId\n"open\n'), 'csv').problems[0]).toMatch(/closing double quote/);
    expect(parseRecordFile(bytes('{"records": 3}'), 'json').problems[0]).toMatch(/records array/);
    expect(parseRecordFile(bytes('{'), 'json').problems).toEqual(['The file is not valid JSON.']);
    expect(parseRecordFile(new Uint8Array([0xff, 0xfe]), 'csv').problems).toEqual(['The file is not UTF-8 text.']);
  });

  it('flags a CSV row with more values than columns and a JSON record that is not an object', () => {
    expect(parseRecordFile(bytes('subjectId\nA,B\n'), 'csv').rows[0]!.problem).toMatch(/2 values/);
    const json = parseRecordFile(bytes('{"recordType":"person.training","recordVersion":1,"records":[1]}'), 'json');
    expect(json.rows[0]).toMatchObject({ locator: { kind: 'json_pointer', value: '/records/0' } });
    expect(json.rows[0]!.problem).toMatch(/not a JSON object/);
  });

  it('chooses the format from the content type, then from the first character', () => {
    expect(recordFileFormat('text/csv', bytes('{'))).toBe('csv');
    expect(recordFileFormat('application/json', bytes('a'))).toBe('json');
    expect(recordFileFormat('application/octet-stream', bytes('  {"records":[]}'))).toBe('json');
    expect(recordFileFormat('application/octet-stream', bytes('subjectId'))).toBe('csv');
  });
});

describe('row validation', () => {
  it('reads each kind of field, with option labels and yes or no', () => {
    const reading = interpretRecordRow(type('person.employment'), {
      subjectId: 'P-1',
      employmentStatus: 'Employed',
      functionStartedOn: '2026-01-05',
      separationForCause: 'No',
    });
    expect(reading.problems).toEqual([]);
    expect(reading.record).toEqual({
      employmentStatus: 'employed',
      functionStartedOn: '2026-01-05',
      separationForCause: 'no',
    });
    expect(reading.subject).toEqual({ kind: 'person', id: 'P-1', scope: 'source' });
    const maintenance = type('maintenance.action');
    const answers = ['yes', 'No', 'TRUE', true].map(
      (answer) =>
        interpretRecordRow(maintenance, { subjectId: 'AC', subjectKind: 'aircraft', returnedToService: answer }).record,
    );
    expect(answers.map((record) => record.returnedToService)).toEqual([true, false, true, true]);
    expect(
      interpretRecordRow(maintenance, { subjectId: 'AC', subjectKind: 'aircraft', returnedToService: 'maybe' })
        .problems,
    ).toEqual(['Returned to service (returnedToService): "maybe" is not yes or no (true or false).']);
  });

  it('reads a reference as the operator’s own id', () => {
    const reading = interpretRecordRow(roleAssignment, {
      subjectId: 'FLIGHT-9',
      subjectKind: 'flight',
      personId: 'PILOT-4',
      role: 'pilot_in_command',
      startsAt: '2026-05-01T12:00:00Z',
    });
    expect(reading.problems).toEqual([]);
    expect(reading.record.personId).toEqual({ id: 'PILOT-4', scope: 'source' });
  });

  it('refuses malformed values and unknown columns in plain words', () => {
    const reading = interpretRecordRow(timeInService, {
      subjectId: 'AC-1',
      totalTimeHours: 'ninety',
      coveredThroughAt: '2026-06-30 18:00',
      coverage: 'most',
      tailNumber: 'N1',
    });
    expect(reading.problems).toEqual([
      'Total time in service through the cutoff (totalTimeHours): "ninety" is not a number.',
      'Covers time through (coveredThroughAt): "2026-06-30 18:00" does not say which time zone it is in. Name the column with [local] after it to read it in the organization’s time zone, or write it in UTC as 2026-11-10T15:00:00Z, with its offset as 2026-11-10T09:00-06:00, or in the organization’s time zone under a heading ending in [local] as 2026-11-10 09:00.',
      'Coverage (coverage): "most" is not one of complete, partial.',
      'Column "tailNumber" is not a field of Aircraft time in service.',
    ]);
    expect(interpretRecordRow(training, { subjectId: 'P', completedOn: '2026-02-30' }).problems).toEqual([
      'Completed on (completedOn): "2026-02-30" is not a date written as YYYY-MM-DD.',
    ]);
  });

  it('needs a subject id, and a subject kind where the type allows several', () => {
    expect(interpretRecordRow(training, { courseTitle: 'Course' }).problems).toEqual(['subjectId is needed.']);
    expect(interpretRecordRow(roleAssignment, { subjectId: 'F', role: 'other' }).problems[0]).toMatch(
      /subjectKind is needed/,
    );
    expect(
      interpretRecordRow(training, { subjectId: 'P', subjectKind: 'aircraft', courseTitle: 'C' }).problems,
    ).toEqual(['subjectKind "aircraft" is not one of person.']);
  });

  it('asks no subject id for a record about the operator’s own organization, and says a given one is not used', () => {
    expect(recordImportColumns(procedure).some((column) => column.key.startsWith('subject'))).toBe(false);
    expect(recordCsvTemplate(procedure).startsWith('procedureKind,')).toBe(true);
    const entered = interpretRecordRow(procedure, { procedureKind: 'lost_link', title: 'Lost link' });
    expect(entered).toMatchObject({ ownOrganization: true, problems: [], notes: [] });
    expect(entered.subject).toBeUndefined();
    const named = interpretRecordRow(procedure, { subjectId: 'OPS-1', procedureKind: 'lost_link' });
    expect(named).toMatchObject({ ownOrganization: true, problems: [] });
    expect(named.notes).toEqual([
      'A procedure on file record is about your own organization; the subjectId column is not used for this record type.',
    ]);
    // A type about a flight or the organization asks for a subject id only for a flight.
    const subjectId = recordImportColumns(roleAssignment).find((column) => column.key === 'subjectId')!;
    expect(subjectId.required).toBe(false);
    expect(interpretRecordRow(roleAssignment, { subjectKind: 'organization', role: 'other' })).toMatchObject({
      ownOrganization: true,
      problems: [],
    });
    expect(interpretRecordRow(roleAssignment, { role: 'other' }).problems).toEqual([
      'subjectId is needed, or subjectKind organization for a record about your own organization.',
    ]);
  });

  it('keeps an incomplete row: blank cells are absent fields, not refusals', () => {
    const reading = interpretRecordRow(training, { subjectId: 'P', courseTitle: 'Course', evidenceReference: '  ' });
    expect(reading.problems).toEqual([]);
    expect(reading.record).toEqual({ courseTitle: 'Course' });
  });

  it('reads every sample file without a file problem', () => {
    for (const name of readdirSync(fixtures)) {
      const original = fixture(name);
      const parsed = parseRecordFile(
        original,
        recordFileFormat(name.endsWith('.json') ? 'application/json' : 'text/csv', original),
      );
      expect(parsed.problems, name).toEqual([]);
      expect(parsed.rows.length, name).toBeGreaterThan(1);
    }
  });

  it('accepts the good rows of a sample file and refuses the malformed one with a reason', () => {
    const parsed = parseRecordFile(fixture('alpha-aircraft-time.csv'), 'csv');
    const readings = parsed.rows.map((row) => interpretRecordRow(timeInService, row.cells));
    expect(readings.map((reading) => reading.problems.length > 0)).toEqual([false, false, false, true]);
    expect(readings[3]!.problems.join(' ')).toMatch(/"ninety" is not a number/);
  });
});

describe('record time', () => {
  const observation = (record: Record<string, unknown>, time: Record<string, unknown>) => ({
    type: 'operator.record',
    version: 1,
    subject: { kind: 'aircraft', id: 'AC-1', scope: 'source' },
    fidelity: 'documented_schema_conformant',
    limitations: [],
    originalArtifactId: 'artifact-1',
    values: { recordType: 'aircraft.time-in-service', recordVersion: 1, record },
    ...time,
  });

  it('derives occurredAt from an at field and the interval from start and end fields', () => {
    expect(operatorRecordTime(timeInService, { coveredThroughAt: '2026-06-30T23:59:59Z' })).toEqual({
      occurredAt: '2026-06-30T23:59:59Z',
    });
    expect(operatorRecordTime(timeInService, {})).toEqual({ missingTimeField: 'coveredThroughAt' });
    expect(operatorRecordTime(training, { courseTitle: 'C' })).toEqual({});
    expect(
      operatorRecordTime(type('aircraft.inspection'), {
        inspectedAt: '2026-01-01T00:00:00Z',
        nextDueAt: '2026-07-01T00:00:00Z',
      }),
    ).toEqual({ interval: { start: '2026-01-01T00:00:00Z', end: '2026-07-01T00:00:00Z' } });
  });

  it('names an end that does not come after its start, in the type’s own labels', () => {
    const flight = type('flight.record');
    const times = (takeoffAt: string, landingAt: string) => ({ takeoffAt, landingAt });
    expect(recordIntervalProblem(flight, times('2026-10-15T14:02:00Z', '2026-10-15T14:31:00Z'))).toBeUndefined();
    expect(recordIntervalProblem(flight, { takeoffAt: '2026-10-15T14:02:00Z' })).toBeUndefined();
    expect(recordIntervalProblem(flight, times('2026-10-15T14:02:00Z', '2026-10-15T13:31:00Z'))).toBe(
      'Landing at (landingAt), 2026-10-15T13:31:00Z, is before Takeoff at (takeoffAt), 2026-10-15T14:02:00Z; it must be after it.',
    );
    expect(recordIntervalProblem(flight, times('2026-10-15T14:02:00Z', '2026-10-15T14:02:00Z'))).toMatch(
      /is the same time as Takeoff at/,
    );
    expect(recordIntervalProblem(timeInService, { coveredThroughAt: '2026-06-30T23:59:59Z' })).toBeUndefined();
  });

  it('names a disagreement between the envelope and the body', () => {
    const record = { coveredThroughAt: '2026-06-30T23:59:59Z' };
    expect(recordTimeDisagreement(timeInService, record, { occurredAt: '2026-06-30T23:59:59.000Z' })).toBeUndefined();
    expect(recordTimeDisagreement(timeInService, record, { occurredAt: '2026-07-01T00:00:00Z' })).toBe(
      'occurredAt must equal coveredThroughAt',
    );
    const inspection = type('aircraft.inspection');
    const body = { inspectedAt: '2026-01-01T00:00:00Z' };
    expect(recordTimeDisagreement(inspection, body, { interval: { start: '2026-01-01T00:00:00Z' } })).toBeUndefined();
    expect(
      recordTimeDisagreement(inspection, body, {
        interval: { start: '2026-01-01T00:00:00Z', end: '2026-02-01T00:00:00Z' },
      }),
    ).toBe('interval.end is given but nextDueAt is not');
  });

  it('is enforced by intake for any carried record', () => {
    const record = { totalTimeHours: 10, coveredThroughAt: '2026-06-30T23:59:59Z' };
    expect(
      validateObservation(standardObservationRegistry, observation(record, { occurredAt: '2026-06-30T23:59:59Z' }))
        .observation,
    ).toBeTruthy();
    let code: string | undefined;
    try {
      validateObservation(standardObservationRegistry, observation(record, { occurredAt: '2026-07-02T00:00:00Z' }));
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe('record_time_disagreement');
  });
});
