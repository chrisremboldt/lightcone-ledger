import { ByteReader, text, view } from './byte-reader.js';
import { FlightTracker, gpsWeekToUtc, type LogReading, type PositionSource } from './flights.js';

/**
 * ArduPilot's DataFlash log (.bin), read from its published description (ardupilot.org, "Downloading and Analyzing
 * Data Logs", and libraries/AP_Logger/LogStructure.h): every message is two head bytes (0xA3 0x95), a message type and
 * a body. FMT messages (type 128) give each type its name, its length and the format characters of its columns. Only
 * the messages a flight record needs are decoded; every other message is skipped by its length.
 */

export const DATAFLASH_HEAD = [0xa3, 0x95] as const;
const FORMAT_TYPE = 128;
const FORMAT_LENGTH = 89;

/** Bytes each format character takes, from LogStructure.h; 'g' (half-precision float) is in later releases. */
const characterSizes: Record<string, number> = {
  a: 64,
  b: 1,
  B: 1,
  M: 1,
  h: 2,
  H: 2,
  c: 2,
  C: 2,
  g: 2,
  i: 4,
  I: 4,
  e: 4,
  E: 4,
  L: 4,
  f: 4,
  n: 4,
  d: 8,
  q: 8,
  Q: 8,
  N: 16,
  Z: 64,
};

/** ArduPilot's LogEvent ids (AP_Logger.h) for the moments a flight record needs. */
const EVENT = { armed: 10, disarmed: 11, autoArmed: 15, landComplete: 18, notLanded: 28 } as const;
/** GPS Status for a 3D fix (AP_GPS_FixType). */
const FIX_3D = 3;

interface Column {
  character: string;
  offset: number;
}

interface MessageType {
  name: string;
  length: number;
  columns: Map<string, Column>;
}

function columnsOf(format: string, names: string): Map<string, Column> | undefined {
  const labels = names.split(',');
  const columns = new Map<string, Column>();
  let offset = 0;
  for (const [index, character] of [...format].entries()) {
    const size = characterSizes[character];
    if (size === undefined) return undefined;
    if (labels[index]) columns.set(labels[index]!, { character, offset });
    offset += size;
  }
  return columns;
}

function value(body: DataView, type: MessageType, name: string): number | undefined {
  const column = type.columns.get(name);
  if (!column) return undefined;
  const at = column.offset;
  if (at + characterSizes[column.character]! > body.byteLength) return undefined;
  switch (column.character) {
    case 'b':
      return body.getInt8(at);
    case 'B':
    case 'M':
      return body.getUint8(at);
    case 'h':
      return body.getInt16(at, true);
    case 'H':
      return body.getUint16(at, true);
    case 'c':
      return body.getInt16(at, true) / 100;
    case 'C':
      return body.getUint16(at, true) / 100;
    case 'g':
      return halfFloat(body.getUint16(at, true));
    case 'i':
      return body.getInt32(at, true);
    case 'I':
      return body.getUint32(at, true);
    case 'e':
      return body.getInt32(at, true) / 100;
    case 'E':
      return body.getUint32(at, true) / 100;
    case 'L':
      return body.getInt32(at, true) / 1e7;
    case 'f':
      return body.getFloat32(at, true);
    case 'd':
      return body.getFloat64(at, true);
    case 'q':
      return Number(body.getBigInt64(at, true));
    case 'Q':
      return Number(body.getBigUint64(at, true));
    default:
      return undefined;
  }
}

/** An IEEE 754 half-precision float. */
function halfFloat(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 0x1f) return fraction ? Number.NaN : sign * Infinity;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

/** The message's time on the log's clock, in microseconds: TimeUS, or TimeMS in older logs. */
function timeOf(body: DataView, type: MessageType): number | undefined {
  const micros = value(body, type, 'TimeUS');
  if (micros !== undefined) return micros;
  const millis = value(body, type, 'TimeMS');
  return millis === undefined ? undefined : millis * 1000;
}

const estimatedPosition: PositionSource = {
  name: 'POS',
  rank: 0,
  heightReference: 'above home, as the log states it (POS.RelHomeAlt)',
  altitudeReference: 'above mean sea level, POS.Alt (the estimator)',
};
const receiverPosition: PositionSource = {
  name: 'GPS',
  rank: 1,
  altitudeReference: 'above mean sea level, GPS.Alt (the GPS receiver)',
};

const messages: Record<string, (tracker: FlightTracker, body: DataView, type: MessageType) => void> = {
  EV(tracker, body, type) {
    const at = timeOf(body, type);
    const id = value(body, type, 'Id');
    if (at === undefined || id === undefined) return;
    if (id === EVENT.armed || id === EVENT.autoArmed) tracker.armedState(at, true);
    else if (id === EVENT.disarmed) tracker.armedState(at, false);
    else if (id === EVENT.landComplete) tracker.landedState(at, true);
    else if (id === EVENT.notLanded) tracker.landedState(at, false);
  },
  ARM(tracker, body, type) {
    const at = timeOf(body, type);
    const state = value(body, type, 'ArmState');
    if (at !== undefined && state !== undefined) tracker.armedState(at, state !== 0);
  },
  GPS(tracker, body, type) {
    const at = timeOf(body, type);
    if (at === undefined || (value(body, type, 'I') ?? 0) !== 0) return;
    const status = value(body, type, 'Status');
    const week = value(body, type, 'GWk');
    const millis = value(body, type, 'GMS');
    if (status !== undefined && status >= FIX_3D && week && millis !== undefined) {
      const utc = gpsWeekToUtc(week, millis);
      if (utc !== undefined)
        tracker.utc(at, utc * 1000, "GPS.GWk and GPS.GMS, the GPS receiver's time, less leap seconds");
    }
    const latitude = value(body, type, 'Lat');
    const longitude = value(body, type, 'Lng');
    if (status === undefined || status < FIX_3D || latitude === undefined || longitude === undefined) return;
    const altitude = value(body, type, 'Alt');
    tracker.position(at, receiverPosition, { latitude, longitude }, altitude === undefined ? {} : { altitude });
  },
  POS(tracker, body, type) {
    const at = timeOf(body, type);
    const latitude = value(body, type, 'Lat');
    const longitude = value(body, type, 'Lng');
    if (at === undefined || latitude === undefined || longitude === undefined) return;
    const altitude = value(body, type, 'Alt');
    const height = value(body, type, 'RelHomeAlt');
    tracker.position(
      at,
      estimatedPosition,
      { latitude, longitude },
      {
        ...(altitude === undefined ? {} : { altitude }),
        ...(height === undefined ? {} : { height }),
      },
    );
  },
};

export function isDataflash(head: Uint8Array): boolean {
  return head[0] === DATAFLASH_HEAD[0] && head[1] === DATAFLASH_HEAD[1] && head[2] === FORMAT_TYPE;
}

/** Reads a DataFlash stream to its end, or to the first message it cannot read. */
export async function readDataflash(source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<LogReading> {
  const input = new ByteReader(source);
  const tracker = new FlightTracker();
  const types = new Map<number, MessageType>();
  const done = (stopped?: LogReading['stopped']) =>
    tracker.finish('dataflash', 'ArduPilot DataFlash', input.offset, stopped);
  if (!(await input.has(3)) || !isDataflash(input.peek(3)))
    return done({ offset: 0, reason: 'The file does not begin with a DataFlash format message.' });
  while (true) {
    const start = input.offset;
    if (await input.atEnd()) return done();
    if (!(await input.has(3)))
      return done({ offset: start, reason: `The log ends part-way through a message at byte ${start}.` });
    const head = input.peek(3);
    if (head[0] !== DATAFLASH_HEAD[0] || head[1] !== DATAFLASH_HEAD[1])
      return done({
        offset: start,
        reason: `Byte ${start} does not begin a DataFlash message; the log is damaged there.`,
      });
    const id = head[2]!;
    const length = id === FORMAT_TYPE ? FORMAT_LENGTH : types.get(id)?.length;
    if (length === undefined)
      return done({
        offset: start,
        reason: `The message at byte ${start} is of a type (${id}) no format message has described; the log is damaged there.`,
      });
    if (!(await input.has(length)))
      return done({ offset: start, reason: `The log ends part-way through a message at byte ${start}.` });
    const bytes = input.take(length);
    tracker.messageStart = start;
    tracker.messageEnd = input.offset;
    const body = view(bytes.subarray(3));
    if (id === FORMAT_TYPE) {
      const described = bytes[3]!;
      const describedLength = bytes[4]!;
      const name = text(bytes.subarray(5, 9));
      const columns = columnsOf(text(bytes.subarray(9, 25)), text(bytes.subarray(25, 89)));
      if (described === FORMAT_TYPE) continue;
      if (!columns || describedLength < 3)
        return done({ offset: start, reason: `The format message at byte ${start} cannot be read.` });
      types.set(described, { name, length: describedLength, columns });
      continue;
    }
    const type = types.get(id)!;
    messages[type.name]?.(tracker, body, type);
  }
}
