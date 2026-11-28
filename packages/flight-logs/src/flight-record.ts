import { csvCell, flightRecordV1, recordImportColumns } from '@ledger/contracts';
import { flightRuleWords, type LogReading, type Place, type ReadFlight } from './flights.js';

/**
 * A reading as rows of Ledger's own flight record (flight.record version 1), in the columns of its import template.
 * Only what the log holds is written. The flight's own id, the aircraft's id and everything else a log does not hold
 * are left empty for a person to write. So is the height above the ground, unless the log itself says that the height
 * it states is above the ground.
 */

const placeWords = (place: Place) => `${place.latitude.toFixed(7)}, ${place.longitude.toFixed(7)}`;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

function heightNotes(flight: ReadFlight): string {
  return [
    flight.greatestHeight
      ? `Greatest height ${flight.greatestHeight.meters} m ${flight.greatestHeight.reference}.`
      : '',
    flight.greatestAltitude
      ? `Greatest altitude ${flight.greatestAltitude.meters} m ${flight.greatestAltitude.reference}.`
      : '',
    (flight.greatestHeight || flight.greatestAltitude) && !flight.greatestHeight?.aboveGround
      ? 'The log does not hold the height above the ground.'
      : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** One flight's values by column; a column the log holds nothing for is absent. */
export function flightRecordRow(flight: ReadFlight, log: { name: string; sha256: string }): Record<string, string> {
  const last = flight.landingPlaces.length;
  return Object.fromEntries(
    Object.entries({
      takeoffAt: flight.takeoffAt ?? '',
      landingAt: flight.landingAt ?? '',
      takeoffLocation: flight.takeoffPlace ? placeWords(flight.takeoffPlace) : '',
      landingLocations: flight.landingPlaces.map(placeWords).join('; '),
      maxHeightFlownAboveGroundMeters: flight.greatestHeight?.aboveGround ? String(flight.greatestHeight.meters) : '',
      heightNotes: heightNotes(flight),
      flightPathReference: `${log.name} (sha256 ${log.sha256}), flight ${flight.number}, bytes ${flight.bytes.offset} to ${flight.bytes.offset + flight.bytes.length}${last > 1 ? `; touched down ${last} times, the last place is where it landed` : ''}`,
    }).filter(([, value]) => value !== ''),
  );
}

/** A CSV in the import template's columns, one row per whole flight. */
export function flightRecordCsv(reading: LogReading, log: { name: string; sha256: string }): string {
  const keys = recordImportColumns(flightRecordV1).map((column) => column.key);
  const rows = reading.flights.map((flight) => {
    const row = flightRecordRow(flight, log);
    return keys.map((key) => csvCell(row[key] ?? '')).join(',');
  });
  return [keys.map(csvCell).join(','), ...rows].map((line) => `${line}\r\n`).join('');
}

const durationWords = (seconds: number) => {
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round((seconds - minutes * 60) * 10) / 10;
  return minutes ? `${minutes} min ${rest} s` : `${rest} s`;
};

/** What the reader read and what it could not, the log first and then each flight. */
export function readingLines(reading: LogReading, name: string): string[] {
  const lines = [
    `${name}: ${reading.formatName}, ${reading.bytesRead} bytes read. ${reading.flights.length ? `${plural(reading.flights.length, 'whole flight')}.` : 'No whole flight.'}`,
    reading.absoluteTime ? `Times are UTC, from ${reading.absoluteTime}.` : '',
    reading.vehicle
      ? `The log names the vehicle ${reading.vehicle.identifier} (${reading.vehicle.from}); it is not your own id for the aircraft.`
      : 'The log holds no identifier for the vehicle that this reader reads.',
    ...reading.notes,
    reading.stopped ? `The reader stopped at byte ${reading.stopped.offset}: ${reading.stopped.reason}` : '',
    reading.unfinished
      ? `A flight that began ${reading.unfinished.startedSecondsIntoLog} s into the log is not whole: ${reading.unfinished.reason}. It is not written.`
      : '',
  ].filter(Boolean);
  for (const flight of reading.flights) {
    lines.push(
      `Flight ${flight.number}, ${flightRuleWords[flight.rule]}:`,
      `  ${flight.takeoffAt ? `${flight.takeoffAt} to ${flight.landingAt}, ` : 'no time of day, '}${durationWords(flight.durationSeconds)}.`,
      `  Took off at ${flight.takeoffPlace ? placeWords(flight.takeoffPlace) : '(not in the log)'}; landed at ${flight.landingPlaces.length ? placeWords(flight.landingPlaces.at(-1)!) : '(not in the log)'}${flight.landingPlaces.length > 1 ? ` after touching down ${flight.landingPlaces.length} times` : ''}.`,
      ...(heightNotes(flight) ? [`  ${heightNotes(flight)}`] : []),
      ...flight.notRead.map((sentence) => `  ${sentence}`),
    );
  }
  return lines;
}
