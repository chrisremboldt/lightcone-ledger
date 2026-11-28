import { describe, expect, it } from 'vitest';
import {
  decimalHours,
  findOperatorRecordDefinition,
  flightTimeCsv,
  occurrenceRecordTypesV1,
  occurrencesCsv,
  recordImportColumns,
  standardObservationRegistry,
  zonedMinute,
  type FlightTimeByAircraft,
  type OccurrencesByMonth,
  type OperatorRecordDefinition,
} from '../../packages/contracts/src/index.js';
import {
  flightTimeByAircraft,
  monthOccurrence,
  occurrenceTypes,
  recordFieldText,
} from '../../packages/domain/src/month-reports.js';
import { filledDraft, type RecordTypeSummary } from '../../apps/web/src/operator-records.js';

const ZONE = 'America/Chicago';
const period = {
  month: '2025-03',
  from: '2025-03-01',
  until: '2025-03-31',
  timeZone: ZONE,
  start: '2025-03-01T06:00:00.000Z',
  end: '2025-04-01T05:00:00.000Z',
  ended: true,
};
const definition = (recordType: string) => findOperatorRecordDefinition(standardObservationRegistry, recordType, 1)!;

describe('flight time by aircraft', () => {
  const identity = { registrationNumber: 'RIDGE-REG-1', serialNumber: 'XSQ8-0001', recordedAfterMonth: false };

  it('lists aircraft by id with whole seconds, the flights naming none last, and adds them up', () => {
    const shaped = flightTimeByAircraft(
      [
        { aircraft_id: null, flights: '1', seconds: '600.000', without: '0' },
        { aircraft_id: 'RIDGE-AC-2', flights: '2', seconds: '1230.400', without: '1' },
        { aircraft_id: 'RIDGE-AC-1', flights: '2', seconds: '6300.700', without: '0' },
      ],
      new Map([['RIDGE-AC-1', identity]]),
    );
    expect(shaped.aircraft).toEqual([
      { aircraftId: 'RIDGE-AC-1', identity, flights: 2, flightSeconds: 6300, withoutTime: 0 },
      { aircraftId: 'RIDGE-AC-2', identity: null, flights: 2, flightSeconds: 1230, withoutTime: 1 },
      { aircraftId: null, identity: null, flights: 1, flightSeconds: 600, withoutTime: 0 },
    ]);
    // The total is the whole seconds of all the time, as the summary of a period counts it: 8131.1 seconds.
    expect(shaped.total).toEqual({ aircraft: 2, flights: 5, flightSeconds: 8131, withoutTime: 1 });
  });

  it('writes decimal hours to one place', () => {
    expect([0, 179, 180, 5400, 6300, 45_300].map(decimalHours)).toEqual(['0.0', '0.0', '0.1', '1.5', '1.8', '12.6']);
  });

  it('says in the CSV what is not on file, and quotes a cell that holds a comma', () => {
    const flights: Extract<FlightTimeByAircraft['flights'], { readable: true }> = {
      readable: true,
      aircraft: [
        { aircraftId: 'RIDGE-AC-1', identity, flights: 2, flightSeconds: 6300, withoutTime: 0 },
        {
          aircraftId: 'RIDGE-AC-2',
          identity: { registrationNumber: null, serialNumber: 'S,2', recordedAfterMonth: true },
          flights: 1,
          flightSeconds: 0,
          withoutTime: 1,
        },
        { aircraftId: 'RIDGE-AC-3', identity: null, flights: 1, flightSeconds: 60, withoutTime: 0 },
      ],
      withoutTime: [
        {
          aircraftId: 'RIDGE-AC-2',
          flightId: 'RIDGE-FLT-9',
          takeoffAt: '2025-03-15T15:00:00.000Z',
          reason: 'landing_not_after_takeoff',
        },
      ],
      withoutTimeTruncated: false,
      total: { aircraft: 3, flights: 4, flightSeconds: 6360, withoutTime: 1 },
    };
    expect(flightTimeCsv(period, flights).split('\r\n')).toEqual([
      'month,timeZone,aircraftId,registrationNumber,serialNumber,flights,flightHours,flightSeconds,flightsWithoutTime,notes',
      `2025-03,${ZONE},RIDGE-AC-1,RIDGE-REG-1,XSQ8-0001,2,1.8,6300,0,`,
      `2025-03,${ZONE},RIDGE-AC-2,,"S,2",1,0.0,0,1,Identity record recorded after the month ended. Flight RIDGE-FLT-9: landing recorded no later than takeoff.`,
      `2025-03,${ZONE},RIDGE-AC-3,,,1,0.0,60,0,Aircraft: no identity record on file.`,
      '',
    ]);
  });
});

describe('occurrences by month', () => {
  const anomaly = definition('occurrence.operation-anomaly');

  it('reads a field as a person reads it: a choice by its label, a time on the organization’s clocks', () => {
    const field = (name: string) => anomaly.fields.find((candidate) => candidate.name === name)!;
    expect(recordFieldText(field('interruptionKind'), 'none', ZONE)).toBe('Neither');
    expect(recordFieldText(field('interruptionKind'), 'a value no longer offered', ZONE)).toBe(
      'a value no longer offered',
    );
    expect(recordFieldText(field('notReportable'), false, ZONE)).toBe('No');
    expect(recordFieldText(field('notReportableDecidedById'), { id: 'RIDGE-P-01', scope: 'source' }, ZONE)).toBe(
      'RIDGE-P-01',
    );
    expect(recordFieldText(field('reportedToAuthorityAt'), '2025-04-01T04:50:00Z', ZONE)).toBe('2025-03-31 23:50');
    expect(recordFieldText(field('reportedToAuthorityAt'), '2025-04-01T05:00:00Z', ZONE, '2025-04-01')).toBe(
      '2025-04-01',
    );
    expect(recordFieldText(field('summary'), '  ', ZONE)).toBeNull();
    expect(recordFieldText(field('summary'), undefined, ZONE)).toBeNull();
    expect(zonedMinute('2025-03-10T15:30:15Z', ZONE)).toBe('2025-03-10 10:30:15');
  });

  const row = (values: Record<string, unknown>, more: Record<string, unknown> = {}) => ({
    id: 'observation-1',
    subject_kind: 'flight',
    subject_id: 'RIDGE-FLT-2',
    secondary_subject_kind: 'aircraft',
    secondary_subject_id: 'RIDGE-AC-1',
    span_start: new Date('2025-04-01T04:50:00Z'),
    observation: { values },
    observation_type: 'operator.record',
    observation_version: 1,
    ...more,
  });

  it('lists an occurrence with its day in the organization’s time zone and the fields its record holds', () => {
    const listed = monthOccurrence(
      row({
        recordType: 'occurrence.operation-anomaly',
        recordVersion: 1,
        record: {
          occurredAt: '2025-04-01T04:50:00Z',
          summary: 'Held over the ridge for a passing helicopter',
          interruptionKind: 'landing_away',
        },
      }),
      anomaly,
      ZONE,
    );
    expect(listed).toEqual({
      recordId: 'observation-1',
      occurredAt: '2025-04-01T04:50:00.000Z',
      occurredOn: '2025-03-31',
      dateOnly: false,
      flightId: 'RIDGE-FLT-2',
      aircraftId: 'RIDGE-AC-1',
      about: [],
      fields: [
        { name: 'summary', label: 'What happened', value: 'Held over the ridge for a passing helicopter' },
        {
          name: 'interruptionKind',
          label: 'Interruption',
          value: 'Unplanned or precautionary landing away from the normal landing location',
        },
      ],
    });
  });

  it('shows a day given alone as that day, names a site beside the aircraft, and never the organization', () => {
    const listed = monthOccurrence(
      row(
        {
          recordType: 'occurrence.operation-anomaly',
          recordVersion: 1,
          record: { occurredAt: '2025-03-12T05:00:00Z', summary: 'A fictional anomaly' },
          dayOnly: { occurredAt: { day: '2025-03-12', timeZone: ZONE, nextDayAt: '2025-03-13T05:00:00Z' } },
        },
        {
          subject_kind: 'site',
          subject_id: 'RIDGE-NORTH-PAD',
          secondary_subject_kind: null,
          secondary_subject_id: null,
          span_start: new Date('2025-03-12T05:00:00Z'),
        },
      ),
      anomaly,
      ZONE,
    );
    expect(listed).toMatchObject({
      occurredOn: '2025-03-12',
      dateOnly: true,
      flightId: null,
      aircraftId: null,
      about: [{ kind: 'site', id: 'RIDGE-NORTH-PAD' }],
    });
    const own = monthOccurrence(
      row(
        { recordType: 'occurrence.security', recordVersion: 1, record: { occurredAt: '2025-03-12T15:00:00Z' } },
        { subject_kind: 'organization', subject_id: 'organization:fictional' },
      ),
      definition('occurrence.security'),
      ZONE,
    );
    expect(own).toMatchObject({ aircraftId: 'RIDGE-AC-1', flightId: null, about: [], fields: [] });
  });

  it('keeps the fields of a record whose type is no longer defined, under their own names', () => {
    const listed = monthOccurrence(
      row({
        recordType: 'occurrence.example-declared',
        recordVersion: 3,
        record: { what: 'A fictional occurrence', count: 2 },
      }),
      undefined,
      ZONE,
    );
    expect(listed.fields).toEqual([
      { name: 'what', label: 'what', value: 'A fictional occurrence' },
      { name: 'count', label: 'count', value: '2' },
    ]);
  });

  it('lists every occurrence type by title, a zero for one with none, and an older version only with its records', () => {
    const declared = {
      ...anomaly,
      recordType: 'occurrence.example-declared',
      title: 'Bird strike',
    } as OperatorRecordDefinition;
    const types = occurrenceTypes(
      [
        ...occurrenceRecordTypesV1,
        { ...declared, recordVersion: 1 },
        { ...declared, recordVersion: 2 },
        definition('flight.record'),
      ],
      [
        { record_type: 'occurrence.operation-anomaly', record_version: 1, count: '2' },
        { record_type: 'occurrence.example-declared', record_version: 1, count: '1' },
        { record_type: 'occurrence.withdrawn-type', record_version: 1, count: '4' },
      ],
      (recordType, version) =>
        [...occurrenceRecordTypesV1, declared].find((type) => type.recordType === recordType)?.title ??
        `${recordType} version ${version}`,
    );
    expect(types.map((type) => [type.title, type.recordVersion, type.count])).toEqual([
      ['Accident', 1, 0],
      ['Bird strike', 1, 1],
      ['Bird strike', 2, 0],
      ['Emergency deviation', 1, 0],
      ['Mechanical irregularity', 1, 0],
      ['occurrence.withdrawn-type version 1', 1, 4],
      ['Operation anomaly', 1, 2],
      ['Property or unauthorized-area event', 1, 0],
      ['Security occurrence', 1, 0],
    ]);
    expect(types.every((type) => type.occurrences.length === 0)).toBe(true);
  });

  it('writes one CSV row for each occurrence, with a column for every field any of them has', () => {
    const occurrences: Extract<OccurrencesByMonth['occurrences'], { readable: true }> = {
      readable: true,
      total: 2,
      truncated: false,
      types: [
        { recordType: 'occurrence.accident', recordVersion: 1, title: 'Accident', count: 0, occurrences: [] },
        {
          recordType: 'occurrence.operation-anomaly',
          recordVersion: 1,
          title: 'Operation anomaly',
          count: 2,
          occurrences: [
            {
              recordId: 'observation-1',
              occurredAt: '2025-03-10T15:30:00.000Z',
              occurredOn: '2025-03-10',
              dateOnly: false,
              flightId: 'RIDGE-FLT-1',
              aircraftId: 'RIDGE-AC-1',
              about: [],
              fields: [{ name: 'summary', label: 'What happened', value: 'Landed at the north pad, then "held"' }],
            },
            {
              recordId: 'observation-2',
              occurredAt: '2025-03-12T05:00:00.000Z',
              occurredOn: '2025-03-12',
              dateOnly: true,
              flightId: null,
              aircraftId: null,
              about: [{ kind: 'site', id: 'RIDGE-NORTH-PAD' }],
              fields: [{ name: 'interruptionKind', label: 'Interruption', value: 'Neither' }],
            },
          ],
        },
      ],
    };
    expect(occurrencesCsv(period, occurrences).split('\r\n')).toEqual([
      'month,timeZone,recordType,recordVersion,type,occurredOn,occurredAtLocal,flightId,aircraftId,alsoAbout,summary,interruptionKind,recordId',
      `2025-03,${ZONE},occurrence.operation-anomaly,1,Operation anomaly,2025-03-10,2025-03-10 10:30,RIDGE-FLT-1,RIDGE-AC-1,,"Landed at the north pad, then ""held""",,observation-1`,
      `2025-03,${ZONE},occurrence.operation-anomaly,1,Operation anomaly,2025-03-12,,,,site RIDGE-NORTH-PAD,,Neither,observation-2`,
      '',
    ]);
  });
});

describe('an entry form that starts from its address', () => {
  const report = definition('organization.report');
  const type = {
    recordType: report.recordType,
    recordVersion: report.recordVersion,
    title: report.title,
    subjectKinds: report.subjectKinds,
    secondarySubjectKinds: report.secondarySubjectKinds,
    fields: report.fields,
    columns: recordImportColumns(report),
  } as unknown as RecordTypeSummary;

  it('fills the fields the type has, each only with a value its kind takes', () => {
    const { draft, filled } = filledDraft(type, {
      periodStartsOn: '2026-10-01',
      periodEndsOn: '2026-10-31',
      reportKind: 'flight_hours',
      providedAt: '2026-11-05T09:00',
      somethingElse: 'ignored',
    });
    expect(draft.values).toEqual({
      reportKind: 'flight_hours',
      providedAt: '2026-11-05T09:00',
      periodStartsOn: '2026-10-01',
      periodEndsOn: '2026-10-31',
    });
    expect(filled.map((field) => field.label)).toEqual([
      'Kind of report',
      'Provided at',
      'First day covered',
      'Last day covered',
    ]);
    expect(draft.subjectId).toBe('');
  });

  it('leaves out a choice the type does not offer, a day that is not one, and anything for prose', () => {
    const anomaly = definition('occurrence.operation-anomaly');
    const occurrence = { ...type, fields: anomaly.fields, columns: recordImportColumns(anomaly) } as RecordTypeSummary;
    expect(filledDraft(type, { reportKind: 'not_a_kind', periodStartsOn: '2026-02-30' }).filled).toEqual([]);
    expect(
      filledDraft(occurrence, { summary: 'typed', interruptionKind: 'none', notReportable: 'yes' }).draft.values,
    ).toEqual({ interruptionKind: 'none', notReportable: 'yes' });
  });
});
