import { wholeFile } from './byte-reader.js';
import { validPlace, type LogReading, type Place, type ReadFlight, type StatedHeight } from './flights.js';

/**
 * A GUTMA flight log: the Flight Logging Protocol the Global UTM Association publishes, a JSON document. Read from the
 * published description only, `Flight_logging_protocol.md` in github.com/gutma-org/flight-logging-protocol (approved
 * for release on 2018-03-12; its example message gives the protocol version as 1.0.0), and checked against no
 * product's export.
 *
 * The message is `exchange.message`, with `flight_data` (the devices, optional), `flight_logging` (the samples,
 * mandatory) and `file` (about the file, optional). The samples are rows of `flight_logging_items`, each a list of
 * numbers in the order `flight_logging_keys` names them.
 *
 * Keys read, and no other:
 * - `exchange.exchange_type` and `exchange.message.message_type`, to refuse a different message.
 * - `flight_logging.flight_logging_keys` and `flight_logging_items`; of the sample keys, `timestamp` (seconds since
 *   the start of logging), `gps_lon` and `gps_lat` (decimal degrees, WGS84, found by name whatever their order) and
 *   `gps_altitude` (metres). A time of more than 30 days is not read as seconds since the start of logging: the
 *   description documents no other clock, so such a row or event is skipped and counted. The description also asks
 *   for geospatial data as GeoJSON geometry objects but lays out no key of the message that holds one; none is read.
 * - `flight_logging.logging_start_dtg`: ISO-8601 with `Z` or an offset. The description calls a time with no zone an
 *   error, so one is not read.
 * - `flight_logging.altitude_system`: "AGL", "MSL" or "WGS84", the three the description allows. With any other, or
 *   none, `gps_altitude` is not read: a height is never written without its reference.
 * - `flight_logging.uom_system`: absent or "Metric". The description gives every distance in metres and shows no
 *   other value, so with any other `gps_altitude` is not read.
 * - `flight_logging.event[]`: `event_info` and `event_timestamp` (seconds since the start of logging; the example
 *   writes it as text, so a number or a number as text is read).
 * - `flight_data.aircraft`: `manufacturer`, `model`, `name`, `serial_number`, `firmware_version`,
 *   `hardware_version`, printed for a person and written into no id column.
 * - `file.version`, to refuse a later version of the protocol.
 * Every other key is listed in the reading as not read.
 *
 * Flights. The description names one event, a take-off (`event_info` "TAKE_OFF"), and says events "can be take off,
 * gps lost, obstacle detection etc."; it names no landing event. This reader takes TAKE_OFF or TAKEOFF as a take-off
 * and, by analogy, LANDING, LANDED or LAND as a landing; every other event is listed by name as not read. Each
 * take-off event followed by a landing event is one flight, so a log may hold more than one.
 *
 * Where an event is missing, the description itself is the rule, and the samples are never searched for a takeoff
 * or a landing: `logging_start_dtg` "describes the beginning of the flight" and "the last timestamp will be equal to
 * the duration flight". So with no take-off event the flight begins at the start of logging, and with no landing
 * event anywhere in the log it ends at the last sample; each flight says which, for a person to check. A log that
 * does record landings as events and has none after its last take-off holds an unfinished flight, which is not
 * written.
 *
 * A JSON document has no messages to point at, so each flight's bytes are the whole file.
 */

/** The most this reader parses at once: the size Ledger keeps as an original. */
export const GUTMA_MAX_BYTES = 10 * 1024 * 1024;
const FORMAT_NAME = 'GUTMA flight log';
/** Said in every reading until someone has read a product's real export with this reader and compared. */
const UNCHECKED =
  'This reader was built from the published description and has been checked against no product’s real export: compare the times and places below with what the product shows before you rely on them.';
const PROTOCOL_MAJOR = '1';
const LISTED = 40;
const SHOWN_CHARACTERS = 80;
/** A time further than this from the start of logging is not seconds since it, whatever else it may be. */
const MAX_SECONDS = 30 * 24 * 60 * 60;

const SAMPLE_KEYS_READ = ['timestamp', 'gps_lon', 'gps_lat', 'gps_altitude'];
const AIRCRAFT_KEYS: readonly [string, string][] = [
  ['manufacturer', 'manufacturer'],
  ['model', 'model'],
  ['name', 'name'],
  ['serial_number', 'serial number'],
  ['firmware_version', 'firmware'],
  ['hardware_version', 'hardware'],
];
const KEYS_READ = {
  root: ['exchange'],
  exchange: ['exchange_type', 'message'],
  message: ['flight_data', 'flight_logging', 'file', 'message_type'],
  flight_data: ['aircraft'],
  aircraft: AIRCRAFT_KEYS.map(([key]) => key),
  flight_logging: [
    'flight_logging_items',
    'flight_logging_keys',
    'event',
    'altitude_system',
    'logging_start_dtg',
    'uom_system',
  ],
  event: ['event_info', 'event_timestamp'],
  file: ['version'],
};

const TAKE_OFF = new Set(['TAKE_OFF', 'TAKEOFF']);
const LANDING = new Set(['LANDING', 'LANDED', 'LAND']);
const ALTITUDE_SYSTEMS: Record<string, { words: string; aboveGround: boolean }> = {
  AGL: { words: ' (above ground level)', aboveGround: true },
  MSL: { words: ' (above mean sea level)', aboveGround: false },
  WGS84: { words: '', aboveGround: false },
};

type Json = Record<string, unknown>;

interface Sample {
  /** Seconds since the start of logging. */
  at: number;
  place?: Place;
  altitude?: number;
}

interface FlightEvent {
  at: number;
  kind: 'takeoff' | 'landing';
}

interface Span {
  start: number;
  end: number;
  rule: ReadFlight['rule'];
  notRead: string[];
}

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isSeconds = (value: unknown): value is number => isNumber(value) && value >= 0 && value <= MAX_SECONDS;
const round1 = (value: number) => Math.round(value * 10) / 10;
const round7 = (value: number) => Math.round(value * 1e7) / 1e7;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** A value of the log as a person reads it: one line, no control characters, not longer than a name is. */
function shown(value: unknown): string {
  const text = (typeof value === 'string' ? value : (JSON.stringify(value) ?? ''))
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim();
  return text.length > SHOWN_CHARACTERS ? `${text.slice(0, SHOWN_CHARACTERS)}…` : text;
}

function listed(names: string[]): string {
  const unique = [...new Set(names)];
  const more = unique.length - LISTED;
  return `${unique.slice(0, LISTED).join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
}

/** True when the file begins as a JSON object whose first key is "exchange", as a flight logging message does. */
export function isGutma(head: Uint8Array): boolean {
  const text = new TextDecoder('utf-8').decode(head);
  return /^\s*\{\s*"exchange"\s*:/.test(text);
}

function parsed(bytes: Uint8Array): { document: unknown } | undefined {
  try {
    return { document: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
  } catch {
    return undefined;
  }
}

/** UTC milliseconds of a date and time as the description writes one, or why it was not read. */
function startOfLogging(value: unknown): { utc: number } | { why: string } | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const pattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})?$/;
  const match = typeof value === 'string' ? pattern.exec(value.trim()) : null;
  const notADate = {
    why: `The log's start of logging (logging_start_dtg, “${shown(value)}”) is not a date and time as the format's description writes one (YYYY-MM-DDTHH:mm:ss.sssZ), so no takeoff or landing time is written.`,
  };
  if (!match) return notADate;
  const [, year, month, day, hour, minute, second, fraction = '', zone] = match;
  if (!zone)
    return {
      why: `The log's start of logging (logging_start_dtg, “${shown(value)}”) names no time zone. The format's description requires UTC or an offset and calls a time without one an error, so no takeoff or landing time is written.`,
    };
  const local = Date.UTC(+year!, +month! - 1, +day!, +hour!, +minute!, +second!, +fraction.padEnd(3, '0').slice(0, 3));
  const written = new Date(local);
  const real =
    written.getUTCMonth() === +month! - 1 &&
    written.getUTCDate() === +day! &&
    written.getUTCHours() === +hour! &&
    written.getUTCMinutes() === +minute! &&
    written.getUTCSeconds() === +second!;
  if (!real) return notADate;
  if (zone === 'Z') return { utc: local };
  const digits = zone.replace(':', '');
  const offsetMinutes = +digits.slice(1, 3) * 60 + +digits.slice(3, 5);
  return { utc: local - (digits[0] === '-' ? -1 : 1) * offsetMinutes * 60_000 };
}

/** The rows that can be read, in order of time, and how many could not. */
function samplesOf(keys: string[], items: unknown[]): { samples: Sample[]; skipped: number; reordered: boolean } {
  const column = (key: string) => keys.indexOf(key);
  const [time, longitude, latitude, altitude] = SAMPLE_KEYS_READ.map(column) as [number, number, number, number];
  const samples: Sample[] = [];
  let skipped = 0;
  let reordered = false;
  for (const row of items) {
    if (!Array.isArray(row) || row.length !== keys.length || !isSeconds(row[time])) {
      skipped += 1;
      continue;
    }
    const sample: Sample = { at: row[time] };
    const place = { latitude: row[latitude] as number, longitude: row[longitude] as number };
    if (isNumber(place.latitude) && isNumber(place.longitude) && validPlace(place)) sample.place = place;
    if (isNumber(row[altitude])) sample.altitude = row[altitude];
    if (samples.length && sample.at < samples.at(-1)!.at) reordered = true;
    samples.push(sample);
  }
  if (reordered) samples.sort((a, b) => a.at - b.at);
  return { samples, skipped, reordered };
}

function secondsOf(value: unknown): number | undefined {
  const seconds = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return isSeconds(seconds) ? seconds : undefined;
}

/** The take-off and landing events in order of time, and what was said of the others. */
function eventsOf(list: unknown, notes: string[]): { events: FlightEvent[]; otherKeys: Set<string> } {
  const events: FlightEvent[] = [];
  const otherKeys = new Set<string>();
  if (list === undefined) return { events, otherKeys };
  if (!Array.isArray(list)) {
    notes.push('The log’s event key is not a list, so no event was read.');
    return { events, otherKeys };
  }
  const notRead = new Map<string, number>();
  let untimed = 0;
  for (const entry of list) {
    if (!isObject(entry)) {
      notRead.set('(not an event)', (notRead.get('(not an event)') ?? 0) + 1);
      continue;
    }
    for (const key of Object.keys(entry)) if (!KEYS_READ.event.includes(key)) otherKeys.add(`event.${key}`);
    const name = typeof entry.event_info === 'string' ? entry.event_info.trim().toUpperCase() : '';
    const normal = name.replace(/[\s-]+/g, '_');
    const kind = TAKE_OFF.has(normal) ? 'takeoff' : LANDING.has(normal) ? 'landing' : undefined;
    if (!kind) {
      const label = shown(entry.event_info ?? '(no event_info)');
      notRead.set(label, (notRead.get(label) ?? 0) + 1);
      continue;
    }
    const at = secondsOf(entry.event_timestamp);
    if (at === undefined) untimed += 1;
    else events.push({ at, kind });
  }
  if (notRead.size)
    notes.push(
      `Events not read: ${listed([...notRead].map(([name, count]) => `${name} (${count})`))}. This reader reads take-off events (TAKE_OFF, TAKEOFF) and landing events (LANDING, LANDED, LAND) only.`,
    );
  if (untimed)
    notes.push(
      `${plural(untimed, 'take-off or landing event')} had no event_timestamp of 0 to 30 days in seconds since the start of logging and ${untimed === 1 ? 'was' : 'were'} not read.`,
    );
  events.sort((a, b) => a.at - b.at);
  return { events, otherKeys };
}

const NO_TAKEOFF_EVENT =
  'The log records no take-off event for this flight: the takeoff time is the start of logging and the takeoff place is the first position the log holds. Check both against what happened.';
const NO_LANDING_EVENT =
  'The log records no landing event: the landing time and place are the last sample’s, which the format’s description says ends the flight. Check both against what happened.';

/** Cuts the log into flights by its events, and by the description's own rule where an event is missing. */
function spansOf(
  events: FlightEvent[],
  lastAt: number | undefined,
  notes: string[],
): { spans: Span[]; unfinished?: LogReading['unfinished'] } {
  const spans: Span[] = [];
  const landingsRecorded = events.some((event) => event.kind === 'landing');
  let open: { start: number; notRead: string[] } | undefined;
  for (const event of events) {
    if (event.kind === 'takeoff') {
      if (open)
        open.notRead.push(
          `The log records another take-off ${event.at} s into the log with no landing before it; it was read as part of this flight.`,
        );
      else open = { start: event.at, notRead: [] };
    } else if (open) {
      spans.push({ start: open.start, end: event.at, rule: 'takeoff_event_to_landing_event', notRead: open.notRead });
      open = undefined;
    } else if (!spans.length && event.at > 0)
      spans.push({ start: 0, end: event.at, rule: 'logging_start_to_landing_event', notRead: [NO_TAKEOFF_EVENT] });
    else
      notes.push(
        `The log records a landing ${event.at} s into the log with no take-off since the landing before it; that is not read as a flight.`,
      );
  }
  if (open) {
    if (landingsRecorded)
      return {
        spans,
        unfinished: {
          startedSecondsIntoLog: round1(open.start),
          reason: 'the log records landings as events and records none after this take-off',
        },
      };
    if (lastAt === undefined || lastAt <= open.start)
      return {
        spans,
        unfinished: {
          startedSecondsIntoLog: round1(open.start),
          reason: 'the log records no landing event and holds no sample after this take-off',
        },
      };
    spans.push({
      start: open.start,
      end: lastAt,
      rule: 'takeoff_event_to_last_sample',
      notRead: [...open.notRead, NO_LANDING_EVENT],
    });
  } else if (!events.length && lastAt !== undefined && lastAt > 0)
    spans.push({
      start: 0,
      end: lastAt,
      rule: 'logging_start_to_last_sample',
      notRead: [NO_TAKEOFF_EVENT, NO_LANDING_EVENT],
    });
  return { spans };
}

interface Altitude {
  /** The altitude system as the log names it. */
  named: string;
  aboveGround: boolean;
  reference: string;
}

/** What `gps_altitude` is measured from, when the log says so in a way the description documents. */
function altitudeOf(logging: Json, hasAltitude: boolean, notes: string[]): Altitude | undefined {
  if (!hasAltitude) {
    notes.push('The log’s samples have no gps_altitude key, so no height or altitude is written.');
    return undefined;
  }
  const units = logging.uom_system;
  if (units !== undefined && !(typeof units === 'string' && units.trim().toUpperCase() === 'METRIC')) {
    notes.push(
      `The log states its units as “${shown(units)}” (uom_system). The format's description documents only Metric, with distances in metres, so gps_altitude was not read and no height or altitude is written.`,
    );
    return undefined;
  }
  const system = logging.altitude_system;
  if (system === undefined || system === null || system === '') {
    notes.push(
      'The log names no altitude system (altitude_system), so gps_altitude was not read: a height is not written without what it is measured from.',
    );
    return undefined;
  }
  const known = typeof system === 'string' ? ALTITUDE_SYSTEMS[system.trim().toUpperCase()] : undefined;
  if (!known) {
    notes.push(
      `The log names its altitude system “${shown(system)}”. The format's description documents AGL, MSL and WGS84 only, so gps_altitude was not read and no height or altitude is written.`,
    );
    return undefined;
  }
  const named = (system as string).trim();
  return {
    named,
    aboveGround: known.aboveGround,
    reference: `${named}${known.words}, the altitude system the log names for gps_altitude`,
  };
}

function utcWords(utc: number): string {
  return new Date(Math.round(utc / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

function flightOf(
  span: Span,
  number: number,
  samples: Sample[],
  log: { startUtc?: number; altitude?: Altitude; bytes: number },
): ReadFlight {
  const placed = samples.filter((sample) => sample.place);
  const during = (sample: Sample) => sample.at >= span.start && sample.at <= span.end;
  const takeoff = placed.findLast((sample) => sample.at <= span.start) ?? placed.find(during);
  const landing = placed.findLast(during);
  const altitudes = samples.filter(during).flatMap((sample) => (sample.altitude === undefined ? [] : sample.altitude));
  const notRead = [...span.notRead];
  if (!landing) notRead.push('The log holds no position during this flight: no takeoff or landing place.');
  if (log.altitude && !altitudes.length) notRead.push('The log holds no altitude during this flight.');
  const greatest: StatedHeight | undefined =
    log.altitude && altitudes.length
      ? {
          meters: round1(Math.max(...altitudes)),
          reference: log.altitude.reference,
          ...(log.altitude.aboveGround ? { aboveGround: true } : {}),
        }
      : undefined;
  const place = (sample: Sample): Place => ({
    latitude: round7(sample.place!.latitude),
    longitude: round7(sample.place!.longitude),
  });
  return {
    number,
    rule: span.rule,
    ...(log.startUtc !== undefined
      ? {
          takeoffAt: utcWords(log.startUtc + span.start * 1000),
          landingAt: utcWords(log.startUtc + span.end * 1000),
        }
      : {}),
    durationSeconds: round1(span.end - span.start),
    ...(landing && takeoff ? { takeoffPlace: place(takeoff) } : {}),
    landingPlaces: landing ? [place(landing)] : [],
    ...(greatest && log.altitude!.aboveGround ? { greatestHeight: greatest } : {}),
    ...(greatest && !log.altitude!.aboveGround ? { greatestAltitude: greatest } : {}),
    bytes: { offset: 0, length: log.bytes },
    notRead,
  };
}

/** The keys of the documented objects that this reader does not read, by their path. */
function keysNotRead(document: Json, exchange: Json, message: Json, logging: Json): string[] {
  const others = (object: unknown, read: string[], prefix: string) =>
    isObject(object)
      ? Object.keys(object)
          .filter((key) => !read.includes(key))
          .map((key) => `${prefix}${key}`)
      : [];
  const flightData = message.flight_data;
  return [
    ...others(document, KEYS_READ.root, ''),
    ...others(exchange, KEYS_READ.exchange, 'exchange.'),
    ...others(message, KEYS_READ.message, 'message.'),
    ...others(flightData, KEYS_READ.flight_data, 'flight_data.'),
    ...others(isObject(flightData) ? flightData.aircraft : undefined, KEYS_READ.aircraft, 'flight_data.aircraft.'),
    ...others(logging, KEYS_READ.flight_logging, 'flight_logging.'),
    ...others(message.file, KEYS_READ.file, 'file.'),
  ];
}

/** What the log says about the aircraft, for a person to read. */
function aircraftOf(message: Json, notes: string[]): LogReading['vehicle'] {
  const aircraft = isObject(message.flight_data) ? message.flight_data.aircraft : undefined;
  if (!isObject(aircraft)) return undefined;
  const said = AIRCRAFT_KEYS.flatMap(([key, words]) => {
    const value = aircraft[key];
    const text = typeof value === 'string' || typeof value === 'number' ? shown(value) : '';
    return text ? [`${words} ${text}`] : [];
  });
  if (said.length)
    notes.push(
      `The log describes the aircraft (flight_data.aircraft): ${said.join(', ')}. This is printed for you to read; no id column is filled from it.`,
    );
  const serial = aircraft.serial_number;
  const identifier = typeof serial === 'string' || typeof serial === 'number' ? shown(serial) : '';
  return identifier ? { identifier, from: 'flight_data.aircraft.serial_number' } : undefined;
}

/** Why the document is not a flight logging message this reader reads, or its parts. */
function messageOf(document: unknown): { why: string } | { exchange: Json; message: Json; logging: Json } {
  const exchange = isObject(document) ? document.exchange : undefined;
  if (!isObject(exchange))
    return {
      why: 'The file is JSON but not a flight logging message: it has no “exchange” object. It was not read.',
    };
  if (exchange.exchange_type !== undefined && exchange.exchange_type !== 'flight_logging')
    return {
      why: `The file is a different kind of message: its exchange_type is “${shown(exchange.exchange_type)}”, not “flight_logging”. It was not read.`,
    };
  const message = exchange.message;
  if (!isObject(message))
    return {
      why: 'The file is not a flight logging message: its exchange holds no “message” object. It was not read.',
    };
  if (message.message_type !== undefined && message.message_type !== 'flight_logging_submission')
    return {
      why: `The file holds a different message type: its message_type is “${shown(message.message_type)}”, not “flight_logging_submission”. It was not read.`,
    };
  const version = isObject(message.file) ? message.file.version : undefined;
  if (version !== undefined && !(typeof version === 'string' && version.trim().split('.')[0] === PROTOCOL_MAJOR))
    return {
      why: `The file says it follows version “${shown(version)}” of the protocol (file.version). This reader was built from version 1.0.0, so it was not read.`,
    };
  const logging = message.flight_logging;
  if (!isObject(logging))
    return {
      why: 'The message holds no flight_logging section, which the format’s description requires, so there is nothing to read.',
    };
  return { exchange, message, logging };
}

/** Reads a GUTMA flight log whole: it is one JSON document, parsed at once up to the bound. */
export async function readGutma(source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<LogReading> {
  const refused = (reason: string): LogReading => ({
    format: 'gutma',
    formatName: FORMAT_NAME,
    bytesRead: 0,
    flights: [],
    stopped: { offset: 0, reason },
    notes: [],
  });
  const megabytes = GUTMA_MAX_BYTES / 1024 / 1024;
  const bytes = await wholeFile(source, GUTMA_MAX_BYTES);
  if (!bytes)
    return refused(
      `The file is larger than ${megabytes} MB, the most this reader reads at once and the most Ledger keeps as an original, so it was not read.`,
    );
  const json = parsed(bytes);
  if (!json) return refused('The file is not valid JSON, so it was not read.');
  const parts = messageOf(json.document);
  if ('why' in parts) return refused(parts.why);
  const { exchange, message, logging } = parts;

  const keys = logging.flight_logging_keys;
  if (!Array.isArray(keys) || !keys.every((key): key is string => typeof key === 'string'))
    return refused('The log’s flight_logging_keys is not a list of names, so its samples cannot be read.');
  if (!keys.includes('timestamp'))
    return refused(
      'The log’s samples have no timestamp key, which the format’s description requires, so no flight can be told.',
    );
  const items = logging.flight_logging_items;
  if (!Array.isArray(items))
    return refused('The log’s flight_logging_items is not a list of rows, so its samples cannot be read.');

  const notes: string[] = [];
  if (exchange.exchange_type === undefined || message.message_type === undefined)
    notes.push(
      'The file does not name its exchange_type or its message_type; it was read as a flight logging message because it holds a flight_logging section.',
    );
  const vehicle = aircraftOf(message, notes);
  const start = startOfLogging(logging.logging_start_dtg);
  if (!start)
    notes.push(
      'The log states no start of logging (logging_start_dtg), so no takeoff or landing time is written; durations are from the samples’ seconds.',
    );
  else if ('why' in start) notes.push(start.why);
  const startUtc = start && 'utc' in start ? start.utc : undefined;

  const { samples, skipped, reordered } = samplesOf(keys, items);
  if (!keys.includes('gps_lon') || !keys.includes('gps_lat'))
    notes.push('The log’s samples have no gps_lon and gps_lat keys, so no takeoff or landing place is written.');
  if (skipped)
    notes.push(
      `${plural(skipped, 'sample row')} of ${items.length} could not be read (not a list as long as the keys, or no timestamp of 0 to 30 days in seconds since the start of logging) and ${skipped === 1 ? 'was' : 'were'} skipped.`,
    );
  if (reordered) notes.push('The samples are not in order of time in the file; they were read in order of time.');
  const altitude = altitudeOf(logging, keys.includes('gps_altitude'), notes);

  for (const key of ['tick_increment_seconds', 'tick_increment_modulo'])
    if (logging[key] !== undefined && Number(logging[key]) !== 1)
      notes.push(
        `The log holds ${key} “${shown(logging[key])}”, which the format's description shows and does not explain; sample times were read as seconds from the start of logging, as the description defines them.`,
      );

  const { events, otherKeys } = eventsOf(logging.event, notes);
  const { spans, unfinished } = spansOf(events, samples.at(-1)?.at, notes);
  if (!samples.length) notes.push('The log holds no sample that could be read.');
  if (!spans.length && !unfinished)
    notes.push(
      events.length
        ? 'No flight could be told from the log’s take-off and landing events.'
        : 'The log records no take-off or landing event and holds no sample after its start, so it holds no flight.',
    );

  const unreadSampleKeys = keys.filter((key) => !SAMPLE_KEYS_READ.includes(key));
  if (unreadSampleKeys.length) notes.push(`Sample keys not read: ${listed(unreadSampleKeys)}.`);
  const unreadKeys = [...keysNotRead(json.document as Json, exchange, message, logging), ...otherKeys];
  if (unreadKeys.length) notes.push(`Other keys not read: ${listed(unreadKeys)}.`);
  if (spans.length > 1) notes.push('A GUTMA log is one JSON document, so each flight’s bytes are the whole file.');
  notes.push(UNCHECKED);

  return {
    format: 'gutma',
    formatName: FORMAT_NAME,
    bytesRead: bytes.byteLength,
    ...(startUtc !== undefined
      ? {
          absoluteTime:
            'logging_start_dtg, the start of logging the log states, and each sample’s or event’s seconds from it',
        }
      : {}),
    ...(vehicle ? { vehicle } : {}),
    flights: spans.map((span, index) =>
      flightOf(span, index + 1, samples, { startUtc, altitude, bytes: bytes.byteLength }),
    ),
    ...(unfinished ? { unfinished } : {}),
    notes,
  };
}
