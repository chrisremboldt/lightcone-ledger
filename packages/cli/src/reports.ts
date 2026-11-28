import {
  decimalHours,
  flightTimeCsv,
  flightWithoutTimeWords,
  NO_IDENTITY_RECORD,
  occurrencesCsv,
  zonedMinute,
  type ReportMonthPeriod,
} from '@ledger/contracts';
import { RefusalError, UsageError, type Context, type Output } from './commands.js';
import { plural, table } from './format.js';

/**
 * Two reports of a calendar month, to prepare what an operator sends: flight time by aircraft, and the occurrences
 * recorded. The API counts; this prints what it counted, as a person reads it or as one CSV table. Nothing is sent
 * to anyone.
 */

export interface MonthReportOptions {
  /** A calendar month, YYYY-MM; the last whole month in the organization's time zone when left out. */
  month?: string;
  /** Print one CSV table instead of the lines a person reads. */
  csv?: boolean;
}

function monthQuery(options: MonthReportOptions) {
  if (options.month !== undefined && !/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(options.month))
    throw new UsageError(`--month is a calendar month such as 2026-10: ${options.month}`);
  return options.month ? { month: options.month } : {};
}

/** Recorded seconds as hours and whole minutes, rounded down, as the web page shows them. */
const hoursAndMinutes = (seconds: number) =>
  `${Math.floor(seconds / 3600)} h ${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')} min`;

const monthWords = (period: ReportMonthPeriod) =>
  `${period.month} (${period.from} to ${period.until}, ${period.timeZone})`;
const notEnded = (period: ReportMonthPeriod) =>
  period.ended ? [] : ['The month has not ended: this counts what is on file so far.'];
const notReadable = (part: string, capability: string) =>
  `${part}: not this credential's to read. Reading them needs ${capability}.`;
const csvLines = (csv: string) => csv.trimEnd().split('\r\n');
const sent = (period: ReportMonthPeriod) => [
  'Ledger sends nothing to anyone. When you have sent a report made from this, record that it was provided:',
  `an organization.report record with periodStartsOn ${period.from} and periodEndsOn ${period.until}.`,
];

export async function flightTimeReport(context: Context, options: MonthReportOptions): Promise<Output> {
  const read = await context.client.flightTimeByAircraft(monthQuery(options));
  const { period, flights } = read;
  if (!flights.readable) {
    const words = notReadable('Flights and flight time', flights.capability);
    if (options.csv) throw new RefusalError(words);
    return { data: read, lines: [`Flight time by aircraft, ${monthWords(period)}.`, words] };
  }
  if (options.csv) return { data: read, lines: csvLines(flightTimeCsv(period, flights)) };
  const identity = (value: string | null | undefined, on: boolean) =>
    on ? (value ?? 'not in the identity record') : NO_IDENTITY_RECORD;
  const rows = flights.aircraft.map((aircraft) => [
    aircraft.aircraftId ?? '(no aircraft named)',
    aircraft.aircraftId === null ? '' : identity(aircraft.identity?.registrationNumber, Boolean(aircraft.identity)),
    aircraft.aircraftId === null || !aircraft.identity ? '' : identity(aircraft.identity.serialNumber, true),
    String(aircraft.flights),
    hoursAndMinutes(aircraft.flightSeconds),
    decimalHours(aircraft.flightSeconds),
    String(aircraft.flightSeconds),
  ]);
  const late = flights.aircraft.filter((aircraft) => aircraft.identity?.recordedAfterMonth);
  return {
    data: read,
    lines: [
      `Flight time by aircraft, ${monthWords(period)}, from the flight records on file. A flight belongs to the month of its takeoff.`,
      ...notEnded(period),
      '',
      ...(flights.aircraft.length
        ? table(
            ['Aircraft', 'Registration', 'Serial number', 'Flights', 'Flight time', 'Hours', 'Seconds'],
            [
              ...rows,
              [
                `Every aircraft: ${flights.total.aircraft}`,
                '',
                '',
                String(flights.total.flights),
                hoursAndMinutes(flights.total.flightSeconds),
                decimalHours(flights.total.flightSeconds),
                String(flights.total.flightSeconds),
              ],
            ],
          )
        : ['No flight record with a takeoff in this month is on file.']),
      ...(flights.withoutTime.length
        ? [
            '',
            `${plural(flights.total.withoutTime, 'flight')} counted above ${flights.total.withoutTime === 1 ? 'adds' : 'add'} no time:`,
            ...flights.withoutTime.map(
              (flight) =>
                `  ${flight.flightId} (${flight.aircraftId ?? 'no aircraft named'}), took off ${zonedMinute(flight.takeoffAt, period.timeZone)}: ${flightWithoutTimeWords[flight.reason]}.`,
            ),
            ...(flights.withoutTimeTruncated ? ['  The first of them are listed; all are counted.'] : []),
          ]
        : []),
      ...(late.length
        ? [
            '',
            `Identity record recorded after the month ended: ${late.map((aircraft) => aircraft.aircraftId).join(', ')}.`,
          ]
        : []),
      '',
      'A flight known only from a source’s report or a plan, with no flight record, is not counted.',
      ...sent(period),
    ],
  };
}

export async function occurrencesReport(context: Context, options: MonthReportOptions): Promise<Output> {
  const read = await context.client.occurrencesByMonth(monthQuery(options));
  const { period, occurrences } = read;
  if (!occurrences.readable) {
    const words = notReadable('Occurrences', occurrences.capability);
    if (options.csv) throw new RefusalError(words);
    return { data: read, lines: [`Occurrences recorded, ${monthWords(period)}.`, words] };
  }
  if (options.csv) return { data: read, lines: csvLines(occurrencesCsv(period, occurrences)) };
  const lines = [
    `Occurrences recorded, ${monthWords(period)}, from the occurrence records on file. An occurrence belongs to the month it occurred in.`,
    ...notEnded(period),
    '',
    ...table(
      ['Record type', 'Id', 'On file for the month'],
      [
        ...occurrences.types.map((type) => [type.title, type.recordType, String(type.count)]),
        ['Every type', '', String(occurrences.total)],
      ],
    ),
  ];
  for (const type of occurrences.types.filter((item) => item.occurrences.length)) {
    lines.push('', type.title);
    for (const item of type.occurrences) {
      const about = [
        item.flightId ? `flight ${item.flightId}` : '',
        item.aircraftId ? `aircraft ${item.aircraftId}` : '',
        ...item.about.map((subject) => `${subject.kind} ${subject.id}`),
      ].filter(Boolean);
      lines.push(
        `  ${item.dateOnly ? `${item.occurredOn} (date only)` : zonedMinute(item.occurredAt, period.timeZone)}${about.length ? `, ${about.join(', ')}` : ''}`,
        ...item.fields.map((field) => `    ${field.label}: ${field.value}`),
      );
    }
  }
  if (occurrences.truncated) lines.push('', 'The first occurrences of the month are listed; all are counted.');
  lines.push(
    '',
    'A type with none on file says only that none was recorded. No safety report is read.',
    ...sent(period),
  );
  return { data: read, lines };
}
