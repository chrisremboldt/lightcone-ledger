import { csvCell } from './operator-record-import.js';
import type { FlightTimeByAircraft, FlightWithoutTimeReason, OccurrencesByMonth } from './reports.js';
import { zonedWallTime } from './zoned-time.js';

/**
 * The reports of a month as CSV, one table each, for the web page's download and the command-line client alike. The
 * numbers are the ones the API counted; nothing is counted here.
 */

type Readable<Part> = Extract<Part, { readable: true }>;

const csv = (rows: readonly (readonly string[])[]) =>
  `${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;

/** What a flight that adds no time lacks, in the words every reader of the report sees. */
export const flightWithoutTimeWords: Record<FlightWithoutTimeReason, string> = {
  no_landing_time: 'no landing time on file',
  landing_not_after_takeoff: 'landing recorded no later than takeoff',
};

/** What stands where an aircraft has no identity record. */
export const NO_IDENTITY_RECORD = 'no identity record on file';

/** Recorded seconds as decimal hours to one place, as in "12.6". */
export function decimalHours(seconds: number): string {
  return (Math.round(seconds / 360) / 10).toFixed(1);
}

/** An instant as the organization's clocks read it, "2026-10-31 23:40", with seconds only when it has any. */
export function zonedMinute(instant: string, timeZone: string): string {
  const wall = zonedWallTime(instant, timeZone);
  if (!wall) return instant;
  return (wall.endsWith(':00') ? wall.slice(0, 16) : wall).replace('T', ' ');
}

/**
 * Flight time by aircraft: one row per aircraft, its hours to one decimal place with the exact seconds beside them,
 * and in the notes what is not on file.
 */
export function flightTimeCsv(
  period: FlightTimeByAircraft['period'],
  flights: Readable<FlightTimeByAircraft['flights']>,
): string {
  const header = [
    'month',
    'timeZone',
    'aircraftId',
    'registrationNumber',
    'serialNumber',
    'flights',
    'flightHours',
    'flightSeconds',
    'flightsWithoutTime',
    'notes',
  ];
  const rows = flights.aircraft.map((aircraft) => {
    const without = flights.withoutTime
      .filter((flight) => flight.aircraftId === aircraft.aircraftId)
      .map((flight) => `Flight ${flight.flightId}: ${flightWithoutTimeWords[flight.reason]}.`);
    const notes = [
      ...(aircraft.aircraftId === null ? ['Flight records that name no aircraft.'] : []),
      ...(aircraft.aircraftId !== null && !aircraft.identity ? [`Aircraft: ${NO_IDENTITY_RECORD}.`] : []),
      ...(aircraft.identity?.recordedAfterMonth ? ['Identity record recorded after the month ended.'] : []),
      ...without,
    ];
    return [
      period.month,
      period.timeZone,
      aircraft.aircraftId ?? '',
      aircraft.identity?.registrationNumber ?? '',
      aircraft.identity?.serialNumber ?? '',
      String(aircraft.flights),
      decimalHours(aircraft.flightSeconds),
      String(aircraft.flightSeconds),
      String(aircraft.withoutTime),
      notes.join(' '),
    ];
  });
  return csv([header, ...rows]);
}

/**
 * The occurrences of a month: one row each, with a column for every field any of them has, named as the record
 * types name their fields.
 */
export function occurrencesCsv(
  period: OccurrencesByMonth['period'],
  occurrences: Readable<OccurrencesByMonth['occurrences']>,
): string {
  const fieldNames = [
    ...new Set(
      occurrences.types.flatMap((type) => type.occurrences.flatMap((item) => item.fields.map((field) => field.name))),
    ),
  ];
  const header = [
    'month',
    'timeZone',
    'recordType',
    'recordVersion',
    'type',
    'occurredOn',
    'occurredAtLocal',
    'flightId',
    'aircraftId',
    'alsoAbout',
    ...fieldNames,
    'recordId',
  ];
  const rows = occurrences.types.flatMap((type) =>
    type.occurrences.map((item) => {
      const values = new Map(item.fields.map((field) => [field.name, field.value]));
      return [
        period.month,
        period.timeZone,
        type.recordType,
        String(type.recordVersion),
        type.title,
        item.occurredOn,
        item.dateOnly ? '' : zonedMinute(item.occurredAt, period.timeZone),
        item.flightId ?? '',
        item.aircraftId ?? '',
        item.about.map((subject) => `${subject.kind} ${subject.id}`).join('; '),
        ...fieldNames.map((name) => values.get(name) ?? ''),
        item.recordId,
      ];
    }),
  );
  return csv([header, ...rows]);
}
