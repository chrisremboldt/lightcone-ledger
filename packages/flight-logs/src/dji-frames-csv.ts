import { COMPARE_FIRST, OneFlight, plural, shown } from './dji-flight.js';
import { KEPT_ORIGINAL_MAX_BYTES, validPlace, type LogReading } from './flights.js';

/**
 * The CSV that the open-source tool `dji-log` writes from a DJI flight record with `--csv`: one row for each frame
 * of the flight. It is the tool's file, not the maker's: an operator makes it on their own computer, with their own
 * developer key for a version the maker encrypts, and Ledger never runs the tool or calls the maker's service.
 * Built from the tool's source and run against no CSV the tool wrote; every reading says so. Test it against your
 * own, comparing its times, places and height with what the app shows, before any operational use.
 * docs/design/manufacturer-flight-logs.md has the decisions.
 *
 * Where the column names come from: the dji-log-parser project (github.com/lvauvillier/dji-log-parser, MIT licence),
 * version 0.6.0 of 2026-11-28. The tool's page says only that `--csv` writes "a CSV file of frames"; the names are
 * the header strings in `dji-log-cli/src/exporters/csv.rs`, each with a comment saying what the column is, and the
 * frame fields behind them are documented on docs.rs. Columns read, and no other:
 * - `CUSTOM.dateTime`, "Custom date and time of the frame". The source types it as a date and time in UTC and does
 *   not say how it is written, so a cell is read as a time of day only when it states its own zone (a `Z`, `UTC` or
 *   an offset, as RFC 3339 writes one). A cell with a date and time and no zone gives durations and no time of day.
 * - `OSD.latitude` and `OSD.longitude`, "Latitude in degrees" and "Longitude in degrees".
 * - `OSD.height`, which the tool calls "Height above ground level in meters" and defines, with `OSD.altitude`
 *   ("the height plus the altitude of the home point"), as the height from the home point: it is written as above
 *   the takeoff point, as the reader of the file itself writes it, and never as a height above the ground.
 * - `OSD.isOnGround`, "Indicates if the drone is on the ground". The source does not say how a yes or no is
 *   written; this reader takes `true` and `false`, and stops at a cell that is neither rather than guess.
 * - `OSD.isMotorOn`, "Indicates if the motor is running", only to say when the motors ran and nothing flew.
 * - `DETAILS.aircraftName`, `DETAILS.aircraftSerial`, `DETAILS.startTime`, `DETAILS.totalTime` and
 *   `DETAILS.maxHeight`, the flight's summary repeated on every row: printed from the first row for a person, and
 *   written to no column.
 *
 * The first five are needed; a file without one of them is refused with their names. The file is recognised by its
 * header row beginning with `CUSTOM.dateTime`, the tool's first column, and naming `OSD.latitude`.
 *
 * Flights are cut by the rule of the reader of the file itself, with the same tracker (dji-flight.ts). The file is
 * read as a stream, a row at a time (RFC 4180: a cell in double quotes may hold commas, quotes and line breaks), so
 * memory does not grow with the flight.
 */

const FORMAT_NAME = 'CSV of frames written by the dji-log tool from a DJI flight record';
const UNCHECKED = `This reader was built from the source of the open-source dji-log tool, which gives the names of the CSV’s columns and not how their values are written, and has been run against no CSV the tool wrote. ${COMPARE_FIRST}`;

const TIME = 'CUSTOM.dateTime';
const LATITUDE = 'OSD.latitude';
const LONGITUDE = 'OSD.longitude';
const HEIGHT = 'OSD.height';
const ON_GROUND = 'OSD.isOnGround';
const MOTOR_ON = 'OSD.isMotorOn';
const NAME = 'DETAILS.aircraftName';
const SERIAL = 'DETAILS.aircraftSerial';
const START = 'DETAILS.startTime';
const TOTAL = 'DETAILS.totalTime';
const GREATEST = 'DETAILS.maxHeight';
const NEEDED = [TIME, LATITUDE, LONGITUDE, HEIGHT, ON_GROUND];
const ALSO_READ = [MOTOR_ON, NAME, SERIAL, START, TOTAL, GREATEST];

/** A row longer than this is no row of frames: a quote was never closed, or the file is something else. */
const MAX_ROW_BYTES = 1024 * 1024;
const EARLIEST_TIME = Date.UTC(2011, 0, 1);
const LATEST_TIME = Date.UTC(2100, 0, 1);
const QUOTE = 0x22;
const LINE_FEED = 0x0a;

/** Without the byte order mark a spreadsheet may write before the first column's name. */
const withoutMark = (text: string) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
const list = (names: string[]) =>
  names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? '');

// Rows ----------------------------------------------------------------------------------------------------------------

interface Row {
  cells: string[];
  /** Where the row begins and ends in the file, its line break included. */
  offset: number;
  end: number;
}

/** The cells of one row, RFC 4180: a quoted cell may hold commas and line breaks, and a quote written twice. */
function cellsOf(line: string): string[] {
  if (!line.includes('"')) return line.split(',');
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (quoted) {
      if (character !== '"') cell += character;
      else if (line[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else quoted = false;
    } else if (character === '"' && cell === '') quoted = true;
    else if (character === ',') {
      cells.push(cell);
      cell = '';
    } else cell += character;
  }
  cells.push(cell);
  return cells;
}

/**
 * The file's rows in order, holding only the row being read. A row ends at a line feed outside quotes; a quote
 * written twice inside a quoted cell opens and closes again, so counting quotes is enough to find the row's end.
 */
async function* rowsOf(
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): AsyncGenerator<Row | { problem: string; offset: number }> {
  const decoder = new TextDecoder('utf-8');
  let held: Uint8Array[] = [];
  let heldBytes = 0;
  let quoted = false;
  let rowStart = 0;
  const row = (last: Uint8Array, end: number): Row => {
    const bytes = new Uint8Array(heldBytes + last.byteLength);
    let at = 0;
    for (const part of [...held, last]) {
      bytes.set(part, at);
      at += part.byteLength;
    }
    held = [];
    heldBytes = 0;
    const offset = rowStart;
    rowStart = end;
    return { cells: cellsOf(decoder.decode(bytes).replace(/\r?\n?$/, '')), offset, end };
  };
  let position = 0;
  for await (const chunk of source) {
    let from = 0;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      const byte = chunk[index];
      if (byte === QUOTE) quoted = !quoted;
      else if (byte === LINE_FEED && !quoted) {
        yield row(chunk.subarray(from, index + 1), position + index + 1);
        from = index + 1;
      }
    }
    if (from < chunk.byteLength) {
      held.push(chunk.subarray(from));
      heldBytes += chunk.byteLength - from;
    }
    position += chunk.byteLength;
    if (heldBytes > MAX_ROW_BYTES) {
      yield {
        problem: `the row that begins at this byte is longer than ${MAX_ROW_BYTES / 1024 / 1024} MB, as when a double quote is never closed; no CSV of frames has such a row, so nothing after it was read.`,
        offset: rowStart,
      };
      return;
    }
  }
  if (!heldBytes) return;
  if (quoted)
    yield {
      problem: 'the file ends inside a quoted value that begins in the row at this byte: it is cut short.',
      offset: rowStart,
    };
  else yield row(new Uint8Array(0), position);
}

// Cells ---------------------------------------------------------------------------------------------------------------

const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?\s*(Z|UTC|[+-]\d{2}:?\d{2})?$/i;

/** A date and time in milliseconds, and whether the cell states its own zone; undefined when it is neither. */
function timeOf(cell: string): { at: number; zoned: boolean } | undefined {
  const match = DATE_TIME.exec(cell.trim());
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second, fraction = '', zone] = match;
  const written = Date.UTC(
    +year!,
    +month! - 1,
    +day!,
    +hour!,
    +minute!,
    +second!,
    +fraction.padEnd(3, '0').slice(0, 3),
  );
  const real = new Date(written);
  if (real.getUTCMonth() !== +month! - 1 || real.getUTCDate() !== +day! || real.getUTCHours() !== +hour!)
    return undefined;
  const digits = zone && /^[+-]/.test(zone) ? zone.replace(':', '') : undefined;
  const offsetMinutes = digits ? (digits[0] === '-' ? -1 : 1) * (+digits.slice(1, 3) * 60 + +digits.slice(3, 5)) : 0;
  const at = written - offsetMinutes * 60_000;
  return at >= EARLIEST_TIME && at < LATEST_TIME ? { at, zoned: Boolean(zone) } : undefined;
}

const numberOf = (cell: string | undefined): number | undefined =>
  cell === undefined || cell.trim() === '' || !Number.isFinite(Number(cell)) ? undefined : Number(cell);

const yesOrNo = (cell: string | undefined): boolean | undefined =>
  /^\s*true\s*$/i.test(cell ?? '') ? true : /^\s*false\s*$/i.test(cell ?? '') ? false : undefined;

/** What the summary columns of the first row say, for a person to read. */
function summaryNotes(cell: (name: string) => string): string[] {
  const names = [
    cell(NAME) ? `the aircraft’s name “${cell(NAME)}” (${NAME})` : '',
    cell(SERIAL) ? `its serial number “${cell(SERIAL)}” (${SERIAL})` : '',
  ].filter(Boolean);
  const stated = [
    cell(START) ? `the start of the log as ${cell(START)} (${START})` : '',
    cell(TOTAL) ? `a total time of ${cell(TOTAL)} s (${TOTAL})` : '',
    cell(GREATEST) ? `a greatest height of ${cell(GREATEST)} m (${GREATEST})` : '',
  ].filter(Boolean);
  return [
    names.length
      ? `The file’s first row gives ${names.join(' and ')}, as the app recorded ${names.length === 1 ? 'it' : 'them'}.`
      : '',
    stated.length
      ? `It states ${list(stated)}. That is the app’s own summary, printed for you to compare; it is written to no row.`
      : '',
  ].filter(Boolean);
}

// The reading ---------------------------------------------------------------------------------------------------------

/** True when the file's first row begins with the tool's first column and names its latitude. */
export function isDjiFramesCsv(head: Uint8Array): boolean {
  const text = withoutMark(new TextDecoder('utf-8').decode(head));
  const cells = cellsOf(text.split(/\r?\n/, 1)[0] ?? '').map((cell) => cell.trim());
  return cells[0] === TIME && cells.includes(LATITUDE);
}

function reading(part: Omit<LogReading, 'format' | 'formatName'>): LogReading {
  return { format: 'dji-frames-csv', formatName: FORMAT_NAME, ...part, notes: [...part.notes, UNCHECKED] };
}

interface Counts {
  rows: number;
  short: number;
  untimed: number;
  zoneless: number;
  exampleZoneless?: string;
}

function rowNotes(counts: Counts, flight: OneFlight, otherColumns: number, read: string[]): string[] {
  const were = (count: number) => (count === 1 ? 'was' : 'were');
  return [
    `Read ${plural(counts.rows, 'row')} of frames; ${plural(flight.samples, 'row')} had a date and time and said on the ground or not, ${flight.positions} of them with a position.`,
    `Columns read: ${list(read)}. The file’s other ${plural(otherColumns, 'column')} ${were(otherColumns)} not read.`,
    `${HEIGHT} is written as a height above the takeoff point. The tool’s own words for it are “height above ground level”, but it gives OSD.altitude as this height plus the altitude of the home point: it is counted from where the aircraft took off, not from the ground under it.`,
    counts.short
      ? `${plural(counts.short, 'row')} had fewer cells than the columns this reader reads and ${were(counts.short)} left out.`
      : '',
    counts.untimed
      ? `${plural(counts.untimed, 'row')} held no date and time between 2011 and 2100 in ${TIME} and ${were(counts.untimed)} left out.`
      : '',
    counts.zoneless
      ? `${TIME} is written with no time zone in ${plural(counts.zoneless, 'row')} (as “${counts.exampleZoneless}”). The tool’s source types the column as UTC but does not say how it is written, and a cell that does not state its zone is not taken for UTC: no takeoff or landing time is written, and the duration is from the same column.`
      : '',
    flight.backwards
      ? `The time in ${TIME} went backwards ${flight.backwards === 1 ? 'once' : `${flight.backwards} times`} in the file; the takeoff and landing times are as the file states them.`
      : '',
  ].filter(Boolean);
}

function noFlightNote(flight: OneFlight): string {
  if (!flight.samples) return 'The file holds no row of frames this reader could read, so it holds no flight.';
  return flight.motorsRan
    ? `No row says the aircraft was in the air (${ON_GROUND} is true in every row), though some say the motors were on. That is no flight by this reader’s rule; if the aircraft did fly, the tool writes the column differently from what this reader expects.`
    : `No row says the aircraft was in the air (${ON_GROUND} is true in every row), so the file holds no flight.`;
}

function sizeNote(bytes: number): string[] {
  const megabytes = (count: number) => (count / 1024 / 1024).toFixed(1).replace(/\.0$/, '');
  return bytes > KEPT_ORIGINAL_MAX_BYTES
    ? [
        `This file is ${megabytes(bytes)} MB. Ledger keeps a file of at most ${megabytes(KEPT_ORIGINAL_MAX_BYTES)} MB as the original of the records read from it, so this one cannot be given as their original: the rows written from it can still be checked and imported without it, and you keep the file, and the flight record it was made from, yourself.`,
      ]
    : [];
}

/** Reads the dji-log tool's CSV of frames as a stream of rows. */
export async function readDjiFramesCsv(source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<LogReading> {
  const rows = rowsOf(source);
  const first = await rows.next();
  const top = first.done ? undefined : first.value;
  if (!top || 'problem' in top)
    return reading({
      bytesRead: 0,
      flights: [],
      stopped: {
        offset: 0,
        reason: top ? `The file has no header row: ${top.problem}` : 'The file is empty, so it was not read.',
      },
      notes: [],
    });
  const header = top.cells.map((cell) => withoutMark(cell).trim());
  const missing = NEEDED.filter((name) => !header.includes(name));
  if (missing.length)
    return reading({
      bytesRead: top.end,
      flights: [],
      stopped: {
        offset: 0,
        reason: `The file’s header row does not name ${list(missing)}. This reader looks for ${list(NEEDED)}, the names the dji-log tool gives those columns in its CSV of frames, so the file was not read.`,
      },
      notes: [],
    });
  const column = Object.fromEntries([...NEEDED, ...ALSO_READ].map((name) => [name, header.indexOf(name)]));
  const needs = Math.max(...NEEDED.map((name) => column[name]!));
  const read = [...NEEDED, ...ALSO_READ].filter((name) => column[name]! >= 0);

  const flight = new OneFlight('row');
  const counts: Counts = { rows: 0, short: 0, untimed: 0, zoneless: 0 };
  let summary: string[] | undefined;
  let serial = '';
  let bytesRead = top.end;
  let stopped: LogReading['stopped'];
  for await (const row of rows) {
    if ('problem' in row) {
      stopped = { offset: row.offset, reason: row.problem };
      break;
    }
    bytesRead = row.end;
    if (row.cells.every((cell) => cell.trim() === '')) continue;
    counts.rows += 1;
    const cell = (name: string) => row.cells[column[name]!];
    if (!summary) {
      summary = summaryNotes((name) => shown(cell(name) ?? ''));
      serial = shown(cell(SERIAL) ?? '');
    }
    if (row.cells.length <= needs) {
      counts.short += 1;
      continue;
    }
    const onGround = yesOrNo(cell(ON_GROUND));
    if (onGround === undefined) {
      stopped = {
        offset: row.offset,
        reason: `row ${counts.rows + 1} of the file holds “${shown(cell(ON_GROUND)!)}” in ${ON_GROUND}, where this reader expects true or false. The tool’s source does not say how it writes the column, so nothing from this row on was read.`,
      };
      bytesRead = row.offset;
      break;
    }
    const time = timeOf(cell(TIME)!);
    if (!time) {
      counts.untimed += 1;
      continue;
    }
    if (!time.zoned) {
      counts.zoneless += 1;
      counts.exampleZoneless ??= shown(cell(TIME)!);
    }
    const place = { latitude: numberOf(cell(LATITUDE)) ?? NaN, longitude: numberOf(cell(LONGITUDE)) ?? NaN };
    const height = numberOf(cell(HEIGHT));
    flight.add({
      at: time.at,
      inAir: !onGround,
      motorsOn: yesOrNo(cell(MOTOR_ON)) === true,
      ...(validPlace(place) ? { place } : {}),
      ...(height !== undefined ? { height } : {}),
      offset: row.offset,
      end: row.end,
    });
  }

  const timeOfDay = flight.samples > 0 && counts.zoneless === 0;
  const { flight: flown, unfinished } = flight.end(Boolean(stopped), timeOfDay);
  return reading({
    bytesRead,
    ...(timeOfDay
      ? {
          absoluteTime: `${TIME}, the column the dji-log tool gives as the date and time of the frame; its source types it as UTC, and every cell read states its own zone`,
        }
      : {}),
    ...(serial
      ? { vehicle: { identifier: serial, from: `${SERIAL}, the aircraft’s serial number as the app recorded it` } }
      : {}),
    flights: flown ? [flown] : [],
    ...(unfinished ? { unfinished } : {}),
    ...(stopped ? { stopped } : {}),
    notes: [
      'The file is the CSV the open-source dji-log tool writes from a DJI flight record, one row for each frame. It is the tool’s decoding, not the maker’s own file: keep the flight record it was made from as well.',
      ...(summary ?? []),
      ...rowNotes(counts, flight, header.filter((name) => name !== '' && !read.includes(name)).length, read),
      ...sizeNote(bytesRead),
      ...(flown || unfinished ? [] : [noFlightNote(flight)]),
    ],
  });
}
