import { text, view, wholeFile } from './byte-reader.js';
import {
  COMPARE_FIRST,
  durationWords,
  OneFlight,
  plural,
  round1,
  rounded,
  type Sample,
  shown,
  utcWords,
} from './dji-flight.js';
import { validPlace, type LogReading, type Place } from './flights.js';

/**
 * A DJI flight record: the file a DJI app or controller writes for each flight (`DJIFlightRecord_….txt`, which is
 * binary). Built from documentation and run against no real file. The maker publishes no description of the format;
 * this reader follows the layout the open-source project dji-log-parser documents (github.com/lvauvillier/
 * dji-log-parser, MIT licence, version 0.6.0 of 2026-11-28): its documentation on docs.rs for the shape of the file
 * in each version and for which versions are encrypted, and its source as docs.rs shows it for the byte offsets,
 * which the documentation does not give. No code of that project is used. Nobody on this project had a flight
 * record to read, so every reading ends by saying it is unchecked; test it against your own files, comparing its
 * times, places and heights with what the app shows, before any operational use.
 * docs/design/manufacturer-flight-logs.md has the decisions.
 *
 * The file, little-endian throughout:
 * - First bytes: a u64 offset, a u16, the version (u8 at byte 10). Versions 1 to 5 use 12 bytes of them, later ones
 *   100.
 * - Header (the project's "details"): at the u64 offset in versions 1 to 11, after the records; at byte 100 in
 *   version 12, with the records from byte 536; in versions 13 and 14 inside a block at byte 100 (tag 0, a u16
 *   size, then scrambled: a u8, a u16 length, the header). Read from it: the start of the log (i64 milliseconds
 *   since 1970 at 91), longitude and latitude (f64 degrees at 99 and 107), the total time (i32 milliseconds at 119),
 *   the greatest height (f32 metres at 123), the aircraft's name and serial number (32 bytes at 280 and 16 at 312
 *   from version 6; 24 at 278 and 10 at 267 before). Nothing else of the header is read.
 * - Records, versions 1 to 12: a type byte, a length byte, the content, the end byte 0xFF. From version 7 the content
 *   is a seed byte, the data XORed with an 8-byte key, and a checksum byte; the key is the CRC-64 (Jones polynomial)
 *   of the 8 little-endian bytes of 0x123456789ABCDEF0 times the seed, started from the seed plus the type, and the
 *   checksum is the seed plus the type under the same XOR. Nothing outside the file is needed. A content of 256
 *   bytes or more wraps its length byte and has no end byte; its true length is found by the checksum.
 * - From version 13 the records are also encrypted with AES, with keys only the maker's service gives out. This
 *   reader never calls it: it reads the header, stops and says why.
 *
 * Records read, and no other: type 1, the aircraft's state (longitude and latitude as f64 radians at 0 and 8, the
 * height as i16 tenths of a metre at 16, and the byte at 32, whose bits 1 and 2 are 0 or 1 on the ground and 2 or 3
 * in the air and whose bit 3 is motors on), and type 5, the app's own record (its time, i64 at 10: milliseconds
 * since 1970, seconds in versions 1 and 2). A sample is a type 1 record with the latest time written before the next
 * type 1 record. Every other record type is counted in the reading as not read.
 *
 * Flights. One file is one flight: from the first sample in the air to the last return to the ground. Each return
 * to the ground is a landing place. A file whose last sample is still in the air holds an unfinished flight, which
 * is not written. The height is from the takeoff point, as the app records it, and is never written as a height
 * above the ground.
 *
 * At a record without its end byte, or one that runs past the end of the records, the reader stops and says the
 * byte; it never searches forward for the next record.
 */

/** The most this reader holds at once. A flight record is one flight long; a larger file is not read. */
export const DJI_MAX_BYTES = 128 * 1024 * 1024;
const FORMAT_NAME = 'DJI flight record';
/** Said in every reading until someone has read their own flight records with this reader and compared. */
const UNCHECKED = `This reader was built from an open-source project’s documentation of the format, which the maker does not publish, and has been run against no real flight record. ${COMPARE_FIRST}`;

const OLD_PREFIX_BYTES = 12;
const PREFIX_BYTES = 100;
const VERSION_AT = 10;
/** Where the records begin in version 12, after the header that follows the first 100 bytes. */
const VERSION_12_RECORDS_AT = 536;
const FIRST_VERSION_WITH_WIDE_PREFIX = 6;
const FIRST_SCRAMBLED_VERSION = 7;
const FIRST_VERSION_WITH_HEADER_FIRST = 12;
const FIRST_VERSION_NEEDING_A_KEY = 13;
const LAST_VERSION_DESCRIBED = 14;
/** A version byte up to this is taken for a flight record's when telling the format from a file's first bytes. */
const LAST_VERSION_RECOGNISED = 31;

const END_BYTE = 0xff;
const STATE_RECORD = 1;
const TIME_RECORD = 5;
const STATE_BYTES_READ = 33;
const TIME_BYTES_READ = 18;
/** The lengths a wrapped length byte may stand for, as the layout's documentation tries them. */
const WRAPS = [0, 256, 512, 768];
/** Written before an image embedded between records; it also appears alone. */
const IMAGE_MARKER = [0x39, 0x30, 0x00, 0x00];
const LISTED = 40;

const EARLIEST_TIME = Date.UTC(2011, 0, 1);
const LATEST_TIME = Date.UTC(2100, 0, 1);

// The scrambling of versions 7 and later ------------------------------------------------------------------------------

const U64 = (1n << 64n) - 1n;
const SCRAMBLE_MULTIPLIER = 0x123456789abcdef0n;
/** The Jones polynomial, 0xad93d23594c935a9, with its bits reversed, as a checksum fed lowest bit first uses it. */
const JONES_REVERSED = (() => {
  let reversed = 0n;
  for (let bit = 0n; bit < 64n; bit += 1n) if ((0xad93d23594c935a9n >> bit) & 1n) reversed |= 1n << (63n - bit);
  return reversed;
})();
const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let crc = BigInt(index);
  for (let bit = 0; bit < 8; bit += 1) crc = crc & 1n ? (crc >> 1n) ^ JONES_REVERSED : crc >> 1n;
  return crc;
});

/** CRC-64 with the Jones polynomial, continued from `crc`; from 0, the text "123456789" gives 0xe9c6d914c4b8d9ca. */
export function crc64Jones(crc: bigint, data: Uint8Array): bigint {
  let running = crc & U64;
  for (const byte of data) running = CRC_TABLE[Number((running ^ BigInt(byte)) & 0xffn)]! ^ (running >> 8n);
  return running;
}

const keys = new Map<number, Uint8Array>();

/** The 8-byte key a record's content is XORed with, from the content's first byte and the record's type. */
function scrambleKey(seed: number, type: number): Uint8Array {
  const cached = keys.get((seed << 8) | type);
  if (cached) return cached;
  const data = new Uint8Array(8);
  view(data).setBigUint64(0, (SCRAMBLE_MULTIPLIER * BigInt(seed)) & U64, true);
  const key = new Uint8Array(8);
  view(key).setBigUint64(0, crc64Jones(BigInt((seed + type) & 0xff), data), true);
  keys.set((seed << 8) | type, key);
  return key;
}

/** `count` bytes after the seed byte at `seedAt`, unscrambled. */
function unscrambled(bytes: Uint8Array, seedAt: number, count: number, type: number): Uint8Array {
  const key = scrambleKey(bytes[seedAt]!, type);
  const data = new Uint8Array(count);
  for (let index = 0; index < count; index += 1) data[index] = bytes[seedAt + 1 + index]! ^ key[index % 8]!;
  return data;
}

// The header ----------------------------------------------------------------------------------------------------------

interface Header {
  startUtc?: number;
  place?: Place;
  totalSeconds?: number;
  greatestHeight?: number;
  name: string;
  serial: string;
}

/** What this reader reads of a header whose first byte is `details[0]`; a field the bytes do not reach is absent. */
function headerOf(details: Uint8Array, version: number): Header {
  const data = view(details);
  const holds = (offset: number, length: number) => offset + length <= details.byteLength;
  const words = (offset: number, length: number) =>
    holds(offset, length) ? shown(text(details.subarray(offset, offset + length))) : '';
  const start = holds(91, 8) ? Number(data.getBigInt64(91, true)) : 0;
  const place = holds(99, 16)
    ? { longitude: data.getFloat64(99, true), latitude: data.getFloat64(107, true) }
    : undefined;
  const total = holds(119, 4) ? data.getInt32(119, true) : 0;
  const height = holds(123, 4) ? data.getFloat32(123, true) : Number.NaN;
  const old = version < FIRST_VERSION_WITH_WIDE_PREFIX;
  return {
    ...(start >= EARLIEST_TIME && start < LATEST_TIME ? { startUtc: start } : {}),
    ...(place && validPlace(place) ? { place: rounded(place) } : {}),
    ...(total > 0 ? { totalSeconds: total / 1000 } : {}),
    ...(Number.isFinite(height) && Math.abs(height) < 100_000 && height !== 0
      ? { greatestHeight: round1(height) }
      : {}),
    name: old ? words(278, 24) : words(280, 32),
    serial: old ? words(267, 10) : words(312, 16),
  };
}

/** The header of a version 13 or 14 file, from the scrambled block at byte 100; undefined when it is not there. */
function headerInBlock(bytes: Uint8Array, version: number): Header | undefined {
  const seedAt = PREFIX_BYTES + 3;
  if (bytes.byteLength < seedAt + 4 || bytes[PREFIX_BYTES] !== 0) return undefined;
  const lengthOf = unscrambled(bytes, seedAt, 3, 0);
  const length = lengthOf[1]! | (lengthOf[2]! << 8);
  if (length === 0 || seedAt + 4 + length > bytes.byteLength) return undefined;
  return headerOf(unscrambled(bytes, seedAt, 3 + length, 0).subarray(3), version);
}

function headerNotes(header: Header): string[] {
  const names = [
    header.name ? `the aircraft’s name “${header.name}”` : '',
    header.serial ? `its serial number “${header.serial}”` : '',
  ].filter(Boolean);
  const recorded = names.length
    ? `${names.join(' and ')}, as the app recorded ${names.length === 1 ? 'it' : 'them'}`
    : '';
  const start = header.startUtc !== undefined ? `the start of the log, ${utcWords(header.startUtc)}` : '';
  const said = recorded && start ? `${recorded}, and ${start}` : recorded || start;
  const summary = [
    header.totalSeconds !== undefined ? `a total time of ${durationWords(header.totalSeconds)}` : '',
    header.greatestHeight !== undefined ? `a greatest height of ${header.greatestHeight} m` : '',
    header.place ? `the place ${header.place.latitude.toFixed(7)}, ${header.place.longitude.toFixed(7)}` : '',
  ].filter(Boolean);
  const list = (parts: string[]) =>
    parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : (parts[0] ?? '');
  return [
    said
      ? `The file’s header gives ${said}.`
      : 'The file’s header gives no aircraft name, no serial number and no start of the log.',
    summary.length
      ? `The header also states ${list(summary)}. That is the app’s own summary, printed for you to compare; it is written to no row.`
      : '',
  ].filter(Boolean);
}

// The records ---------------------------------------------------------------------------------------------------------

interface Walk {
  flight: OneFlight;
  /** Where the walk ended: the end of the records, or the byte it stopped at. */
  at: number;
  stopped?: string;
  stateRecords: number;
  timeRecords: number;
  untimed: number;
  short: number;
  badTimes: number;
  images: number;
  /** How many records of each type were not read. */
  others: Map<number, number>;
}

const startsWith = (bytes: Uint8Array, at: number, end: number, expected: number[]) =>
  at + expected.length <= end && expected.every((byte, index) => bytes[at + index] === byte);

/** Where the image that begins at `at` ends, 'cut' when it does not end as a JPEG does, undefined when none begins. */
function imageEnd(bytes: Uint8Array, at: number, end: number): number | 'cut' | undefined {
  let position = startsWith(bytes, at, end, IMAGE_MARKER) ? at + IMAGE_MARKER.length : at;
  if (!startsWith(bytes, position, end, [0xff, 0xd8])) return undefined;
  position += 2;
  while (position < end) {
    if (bytes[position] !== 0xff) return 'cut';
    while (position < end && bytes[position] === 0xff) position += 1;
    if (position >= end) return 'cut';
    const marker = bytes[position]!;
    position += 1;
    if (marker === 0xd9) return position;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (position + 2 > end) return 'cut';
    position += Math.max(2, (bytes[position]! << 8) | bytes[position + 1]!);
    if (marker !== 0xda) continue;
    // After a start of scan, the picture's data runs to the next marker that is neither a stuffed 0xFF nor a restart.
    while (position < end) {
      if (bytes[position] !== 0xff) position += 1;
      else if (position + 1 < end && (bytes[position + 1] === 0x00 || (bytes[position + 1]! & 0xf8) === 0xd0))
        position += 2;
      else break;
    }
  }
  return 'cut';
}

function walkRecords(bytes: Uint8Array, version: number, from: number, end: number): Walk {
  const scrambled = version >= FIRST_SCRAMBLED_VERSION;
  const walk: Walk = {
    flight: new OneFlight('record'),
    at: from,
    stateRecords: 0,
    timeRecords: 0,
    untimed: 0,
    short: 0,
    badTimes: 0,
    images: 0,
    others: new Map(),
  };
  let clock: number | undefined;
  let open: Omit<Sample, 'at'> | undefined;
  const close = () => {
    if (!open) return;
    if (clock === undefined) walk.untimed += 1;
    else walk.flight.add({ ...open, at: clock });
    open = undefined;
  };

  const checksumHolds = (type: number, start: number, length: number) => {
    if (length < 2 || start + length > end) return false;
    const key = scrambleKey(bytes[start]!, type);
    return (bytes[start + length - 1]! ^ key[(length - 2) % 8]!) === ((bytes[start]! + type) & 0xff);
  };
  const recordStartsAt = (at: number): boolean => {
    if (at >= end) return true;
    if (startsWith(bytes, at, end, [IMAGE_MARKER[0]!, IMAGE_MARKER[1]!]) || startsWith(bytes, at, end, [0xff, 0xd8]))
      return true;
    if (at + 2 > end) return false;
    const start = at + 2;
    const written = bytes[at + 1]!;
    return (
      bytes[start + written] === END_BYTE && WRAPS.some((wrap) => checksumHolds(bytes[at]!, start, written + wrap))
    );
  };
  /** The content's true length when its checksum shows one: the written length, or one its byte wrapped from. */
  const lengthOf = (type: number, start: number, written: number): number => {
    const holding = WRAPS.map((wrap) => written + wrap).filter((length) => checksumHolds(type, start, length));
    return holding.find((length) => recordStartsAt(start + length + 1)) ?? holding[0] ?? written;
  };

  for (;;) {
    while (startsWith(bytes, walk.at, end, IMAGE_MARKER) && !startsWith(bytes, walk.at + 4, end, [0xff, 0xd8]))
      walk.at += IMAGE_MARKER.length;
    if (walk.at >= end) break;
    const image = imageEnd(bytes, walk.at, end);
    if (image === 'cut') {
      walk.stopped =
        'the image embedded at this byte does not end as a JPEG image does. The file is damaged or cut short here, or it is laid out differently from the description this reader was built from.';
      break;
    }
    if (image !== undefined) {
      walk.images += 1;
      walk.at = image;
      continue;
    }
    if (walk.at + 2 > end) {
      walk.stopped = 'the file’s records end in the middle of a record: the file is cut short here.';
      break;
    }
    const type = bytes[walk.at]!;
    const written = bytes[walk.at + 1]!;
    const start = walk.at + 2;
    const length = scrambled ? lengthOf(type, start, written) : written;
    if (start + length + 1 > end) {
      walk.stopped = `the record that begins at this byte (type ${type}, ${length} bytes) runs past the end of the file’s records: the file is cut short here, or it is laid out differently from the description this reader was built from.`;
      break;
    }
    if (length === written && bytes[start + length] !== END_BYTE) {
      walk.stopped = `the record that begins at this byte (type ${type}, ${length} bytes) is not followed by the end mark the layout describes. The file is damaged here, or it is laid out differently from the description this reader was built from.`;
      break;
    }
    const next = start + length + 1;
    if (type !== STATE_RECORD && type !== TIME_RECORD) walk.others.set(type, (walk.others.get(type) ?? 0) + 1);
    else {
      const data = scrambled
        ? unscrambled(bytes, start, Math.max(0, length - 2), type)
        : bytes.subarray(start, start + length);
      if (type === STATE_RECORD) {
        close();
        if (data.byteLength < STATE_BYTES_READ) walk.short += 1;
        else {
          walk.stateRecords += 1;
          open = { ...stateOf(data), offset: walk.at, end: next };
        }
      } else if (data.byteLength < TIME_BYTES_READ) walk.short += 1;
      else {
        const time = timeOf(data, version);
        if (time === undefined) walk.badTimes += 1;
        else {
          walk.timeRecords += 1;
          clock = time;
        }
      }
    }
    walk.at = next;
  }
  close();
  return walk;
}

/** A type 1 record's position, height and whether it says in the air. */
function stateOf(data: Uint8Array): Omit<Sample, 'at' | 'offset' | 'end'> {
  const fields = view(data);
  const degrees = (radians: number) => (radians * 180) / Math.PI;
  const place = { longitude: degrees(fields.getFloat64(0, true)), latitude: degrees(fields.getFloat64(8, true)) };
  const flags = data[32]!;
  return {
    inAir: (flags & 0x06) >> 1 >= 2,
    motorsOn: (flags & 0x08) !== 0,
    ...(validPlace(place) ? { place } : {}),
    height: fields.getInt16(16, true) / 10,
  };
}

/** A type 5 record's time in UTC milliseconds, or undefined when it is no time of this century. */
function timeOf(data: Uint8Array, version: number): number | undefined {
  const stated = Number(view(data).getBigInt64(10, true));
  const milliseconds = version <= 2 ? stated * 1000 : stated;
  return milliseconds >= EARLIEST_TIME && milliseconds < LATEST_TIME ? milliseconds : undefined;
}

// The reading ---------------------------------------------------------------------------------------------------------

/**
 * True when the file begins as a flight record does: a small offset in its first 8 bytes and a version in its
 * eleventh. The format has no signature, so this is asked only after every format that has one.
 */
export function isDji(head: Uint8Array): boolean {
  if (head.byteLength < OLD_PREFIX_BYTES) return false;
  const fields = view(head);
  const version = head[VERSION_AT]!;
  if (version < 1 || version > LAST_VERSION_RECOGNISED || fields.getUint32(4, true) !== 0) return false;
  const offset = fields.getUint32(0, true);
  const least = version < FIRST_VERSION_WITH_WIDE_PREFIX ? OLD_PREFIX_BYTES : PREFIX_BYTES;
  return offset >= least || (offset === 0 && version >= FIRST_VERSION_WITH_HEADER_FIRST);
}

function refused(reason: string, bytesRead = 0): LogReading {
  return {
    format: 'dji',
    formatName: FORMAT_NAME,
    bytesRead,
    flights: [],
    stopped: { offset: bytesRead, reason },
    notes: [UNCHECKED],
  };
}

const NEEDS_A_KEY = (version: number) =>
  `This file is version ${version} of the DJI flight record format. From version ${FIRST_VERSION_NEEDING_A_KEY} on its records are encrypted, and reading them needs a key from the maker’s service, which Ledger does not call; only the header was read. The open-source tool dji-log-parser fetches that key with a developer key of your own and writes the flight as a CSV, which records read-log reads by the same rule; examples/dji-flight-record shows the steps.`;

/** A version 13 or 14 file: its header, and the sentence that says why nothing else was read. */
function keyed(bytes: Uint8Array, version: number, storedOffset: number): LogReading {
  const header = headerInBlock(bytes, version);
  const recordsAt = storedOffset > PREFIX_BYTES && storedOffset <= bytes.byteLength ? storedOffset : PREFIX_BYTES;
  return {
    format: 'dji',
    formatName: FORMAT_NAME,
    bytesRead: recordsAt,
    ...(header?.serial ? { vehicle: { identifier: header.serial, from: VEHICLE_FROM } } : {}),
    flights: [],
    stopped: { offset: recordsAt, reason: NEEDS_A_KEY(version) },
    notes: [
      ...(header
        ? headerNotes(header)
        : ['The header block the layout describes at byte 100 was not found, so no header was read.']),
      UNCHECKED,
    ],
  };
}

const VEHICLE_FROM = 'the aircraft’s serial number in the file’s header, as the app recorded it';

function listed(names: string[]): string {
  const more = names.length - LISTED;
  return `${names.slice(0, LISTED).join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
}

function walkNotes(walk: Walk): string[] {
  const { flight } = walk;
  const others = [...walk.others].sort(([a], [b]) => a - b).map(([type, count]) => `${type} (${count})`);
  return [
    `Read ${plural(walk.stateRecords, 'record')} of the aircraft’s state (type 1) and ${plural(walk.timeRecords, 'record')} of the app’s time (type 5); ${plural(flight.samples, 'sample')} had both, ${flight.positions} of them with a position.`,
    others.length ? `Record types not read, with how many of each: ${listed(others)}.` : '',
    walk.images ? `${plural(walk.images, 'embedded image')} stepped over.` : '',
    walk.untimed
      ? `${plural(walk.untimed, 'state record')} came before any time of the app’s (type 5) and ${walk.untimed === 1 ? 'was' : 'were'} left out.`
      : '',
    walk.short
      ? `${plural(walk.short, 'state or time record')} ${walk.short === 1 ? 'was' : 'were'} shorter than the fields this reader reads and ${walk.short === 1 ? 'was' : 'were'} left out.`
      : '',
    walk.badTimes
      ? `${plural(walk.badTimes, 'time record')} held no time between 2011 and 2100 and ${walk.badTimes === 1 ? 'was' : 'were'} left out.`
      : '',
    flight.backwards
      ? `The app’s time went backwards ${flight.backwards === 1 ? 'once' : `${flight.backwards} times`} in the file; the takeoff and landing times are as the app wrote them.`
      : '',
  ].filter(Boolean);
}

function noFlightNote(walk: Walk): string {
  if (!walk.flight.samples)
    return walk.stateRecords
      ? 'The file holds no time of the app’s (type 5) before its state records, so no sample could be timed and no flight was read.'
      : 'The file holds no record of the aircraft’s state (type 1), so it holds no flight this reader can tell.';
  return walk.flight.motorsRan
    ? 'No record says the aircraft was in the air, though some say the motors were on. That is no flight by this reader’s rule; if the aircraft did fly, the file is laid out differently from the description this reader was built from.'
    : 'No record says the aircraft was in the air, so the file holds no flight.';
}

/** Reads a DJI flight record whole: its header lies after its records in most versions, so it is not streamed. */
export async function readDji(source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<LogReading> {
  const bytes = await wholeFile(source, DJI_MAX_BYTES);
  if (!bytes)
    return refused(
      `The file is larger than ${DJI_MAX_BYTES / 1024 / 1024} MB, the most this reader reads at once, so it was not read.`,
    );
  if (bytes.byteLength < OLD_PREFIX_BYTES)
    return refused('The file is shorter than the 12 bytes a DJI flight record begins with, so it was not read.');
  const version = bytes[VERSION_AT]!;
  const fields = view(bytes);
  if (version === 0 || fields.getUint32(4, true) !== 0)
    return refused(
      'The file does not begin as a DJI flight record does (a small offset in its first 8 bytes and a version from 1 up in its eleventh), so it was not read.',
    );
  if (version > LAST_VERSION_DESCRIBED)
    return refused(
      `This file says it is version ${version} of the DJI flight record format. The layout this reader was built from describes versions 1 to ${LAST_VERSION_DESCRIBED}, so nothing of it was read.`,
      OLD_PREFIX_BYTES,
    );
  const storedOffset = fields.getUint32(0, true);
  if (version >= FIRST_VERSION_NEEDING_A_KEY) return keyed(bytes, version, storedOffset);

  const headerFirst = version >= FIRST_VERSION_WITH_HEADER_FIRST;
  const recordsAt = headerFirst
    ? VERSION_12_RECORDS_AT
    : version < FIRST_VERSION_WITH_WIDE_PREFIX
      ? OLD_PREFIX_BYTES
      : PREFIX_BYTES;
  if (bytes.byteLength < recordsAt)
    return refused(
      `The file is version ${version} of the DJI flight record format and ends before byte ${recordsAt}, where its records would begin: it is cut short.`,
      bytes.byteLength,
    );
  const headerAt = headerFirst ? PREFIX_BYTES : storedOffset;
  const headerHeld = headerAt >= (headerFirst ? PREFIX_BYTES : recordsAt) && headerAt < bytes.byteLength;
  const recordsEnd = headerFirst || !headerHeld ? bytes.byteLength : headerAt;
  const header = headerHeld
    ? headerOf(bytes.subarray(headerAt, headerFirst ? recordsAt : bytes.byteLength), version)
    : undefined;

  const walk = walkRecords(bytes, version, recordsAt, recordsEnd);
  const cutBeforeHeader = !headerHeld && storedOffset >= bytes.byteLength;
  const stopped: LogReading['stopped'] = walk.stopped
    ? { offset: walk.at, reason: walk.stopped }
    : cutBeforeHeader
      ? {
          offset: bytes.byteLength,
          reason: `the file ends before its header, which its first bytes place at byte ${storedOffset}: the file is cut short.`,
        }
      : undefined;
  const { flight, unfinished } = walk.flight.end(Boolean(stopped));
  const notes = [
    `The file is version ${version} of the DJI flight record format, whose records are ${version >= FIRST_SCRAMBLED_VERSION ? 'scrambled with a key that is in the file itself; no key from outside is needed' : 'stored plainly'}.`,
    ...(header
      ? headerNotes(header)
      : [
          cutBeforeHeader
            ? 'The file’s header was not read: the file ends before it.'
            : `The file’s header was not read: the file’s first bytes place it at byte ${storedOffset}, where no header can be, as when the app did not finish the file. The records were read to the end of the file.`,
        ]),
    ...walkNotes(walk),
    ...(flight || unfinished ? [] : [noFlightNote(walk)]),
    UNCHECKED,
  ];
  return {
    format: 'dji',
    formatName: FORMAT_NAME,
    bytesRead: stopped ? stopped.offset : bytes.byteLength,
    ...(walk.timeRecords
      ? {
          absoluteTime:
            'the time the app wrote in its own records (type 5); the layout’s documentation does not say which clock it is',
        }
      : {}),
    ...(header?.serial ? { vehicle: { identifier: header.serial, from: VEHICLE_FROM } } : {}),
    flights: flight ? [flight] : [],
    ...(unfinished ? { unfinished } : {}),
    ...(stopped ? { stopped } : {}),
    notes,
  };
}
