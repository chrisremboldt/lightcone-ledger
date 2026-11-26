import { ByteReader, text, view } from './byte-reader.js';
import { FlightTracker, type LogReading, type PositionSource } from './flights.js';

/**
 * PX4's ULog (.ulg), read from its published description (docs.px4.io, "ULog File Format"): a 16-byte header, then
 * messages of a 3-byte header (uint16 size, uint8 type) and a body. Formats ('F') say how each topic's data is laid
 * out; a subscription ('A') gives a topic a message id; data ('D') carries one sample. Only the topics a flight record
 * needs are decoded; every other message is skipped by its size.
 */

export const ULOG_MAGIC = [0x55, 0x4c, 0x6f, 0x67, 0x01, 0x12, 0x35] as const;
const HEADER_BYTES = 16;
const MESSAGE_HEADER_BYTES = 3;
/** Bit 0 of the first incompatible-flags byte: data appended after the end of the log, such as a crash dump. */
const DATA_APPENDED = 1;
/** vehicle_status.arming_state while armed, in every PX4 release that logs it. */
const ARMING_STATE_ARMED = 2;
/** sensor_gps.fix_type for a 3D fix. */
const FIX_3D = 3;

const basicSizes: Record<string, number> = {
  int8_t: 1,
  uint8_t: 1,
  bool: 1,
  char: 1,
  int16_t: 2,
  uint16_t: 2,
  int32_t: 4,
  uint32_t: 4,
  float: 4,
  int64_t: 8,
  uint64_t: 8,
  double: 8,
};

interface Field {
  type: string;
  count: number;
  offset: number;
}

type Layout = Map<string, Field>;

/** The fields of a format string such as "vehicle_status:uint64_t timestamp;uint8_t arming_state;". */
function fieldsOf(definition: string): { type: string; count: number; name: string }[] {
  const body = definition.slice(definition.indexOf(':') + 1);
  return body
    .split(';')
    .map((field) => field.trim())
    .filter(Boolean)
    .map((field) => {
      const [declared = '', name = ''] = field.split(/\s+/);
      const array = /^(.+)\[(\d+)\]$/.exec(declared);
      return { type: array ? array[1]! : declared, count: array ? Number(array[2]) : 1, name };
    });
}

class Formats {
  private readonly definitions = new Map<string, string>();
  private readonly sizes = new Map<string, number>();

  add(definition: string): void {
    const name = definition.slice(0, definition.indexOf(':'));
    if (name) this.definitions.set(name, definition);
  }

  has(name: string): boolean {
    return this.definitions.has(name);
  }

  private size(type: string, depth = 0): number {
    const basic = basicSizes[type];
    if (basic !== undefined) return basic;
    const known = this.sizes.get(type);
    if (known !== undefined) return known;
    const definition = this.definitions.get(type);
    if (!definition || depth > 32) return Number.NaN;
    const total = fieldsOf(definition).reduce((sum, field) => sum + this.size(field.type, depth + 1) * field.count, 0);
    this.sizes.set(type, total);
    return total;
  }

  /** Each top-level field's offset in a sample of the topic. */
  layout(name: string): Layout | undefined {
    const definition = this.definitions.get(name);
    if (!definition) return undefined;
    const layout: Layout = new Map();
    let offset = 0;
    for (const field of fieldsOf(definition)) {
      layout.set(field.name, { type: field.type, count: field.count, offset });
      offset += this.size(field.type) * field.count;
    }
    return Number.isNaN(offset) ? undefined : layout;
  }
}

/** One field's value in a sample, or undefined when the sample is too short or the field is not a number. */
function read(data: DataView, layout: Layout, name: string): number | undefined {
  const field = layout.get(name);
  if (!field || field.count !== 1) return undefined;
  const size = basicSizes[field.type];
  if (size === undefined || field.offset + size > data.byteLength) return undefined;
  const at = field.offset;
  switch (field.type) {
    case 'int8_t':
      return data.getInt8(at);
    case 'uint8_t':
    case 'bool':
      return data.getUint8(at);
    case 'int16_t':
      return data.getInt16(at, true);
    case 'uint16_t':
      return data.getUint16(at, true);
    case 'int32_t':
      return data.getInt32(at, true);
    case 'uint32_t':
      return data.getUint32(at, true);
    case 'float':
      return data.getFloat32(at, true);
    case 'double':
      return data.getFloat64(at, true);
    case 'int64_t':
      return Number(data.getBigInt64(at, true));
    case 'uint64_t':
      return Number(data.getBigUint64(at, true));
    default:
      return undefined;
  }
}

const globalPosition: PositionSource = {
  name: 'vehicle_global_position',
  rank: 0,
  altitudeReference: 'above mean sea level, vehicle_global_position.alt (the estimator)',
};
const gpsPosition = (topic: string): PositionSource => ({
  name: topic,
  rank: 1,
  altitudeReference: `above mean sea level, ${topic} (the GPS receiver)`,
});

/** The topics read, and what each sample of them says. */
const topics: Record<string, (tracker: FlightTracker, sample: DataView, layout: Layout, topic: string) => void> = {
  vehicle_status(tracker, sample, layout) {
    const at = read(sample, layout, 'timestamp');
    const state = read(sample, layout, 'arming_state');
    if (at !== undefined && state !== undefined) tracker.armedState(at, state === ARMING_STATE_ARMED);
  },
  vehicle_land_detected(tracker, sample, layout) {
    const at = read(sample, layout, 'timestamp');
    const landed = read(sample, layout, 'landed');
    if (at !== undefined && landed !== undefined) tracker.landedState(at, landed !== 0);
  },
  vehicle_global_position(tracker, sample, layout) {
    const at = read(sample, layout, 'timestamp');
    const latitude = read(sample, layout, 'lat');
    const longitude = read(sample, layout, 'lon');
    if (at === undefined || latitude === undefined || longitude === undefined) return;
    const altitude = read(sample, layout, 'alt');
    tracker.position(at, globalPosition, { latitude, longitude }, altitude === undefined ? {} : { altitude });
  },
  sensor_gps: gps,
  vehicle_gps_position: gps,
};

/** A GPS sample: its UTC time and, with a 3D fix, a position. Newer releases log degrees, older ones 1e-7 degrees. */
function gps(tracker: FlightTracker, sample: DataView, layout: Layout, topic: string): void {
  const at = read(sample, layout, 'timestamp');
  if (at === undefined) return;
  const utc = read(sample, layout, 'time_utc_usec');
  if (utc) tracker.utc(at, utc, `${topic}.time_utc_usec, the GPS receiver's UTC time`);
  if (read(sample, layout, 'fix_type') !== undefined && read(sample, layout, 'fix_type')! < FIX_3D) return;
  const degrees = layout.has('latitude_deg');
  const latitude = degrees ? read(sample, layout, 'latitude_deg') : scaled(read(sample, layout, 'lat'), 1e-7);
  const longitude = degrees ? read(sample, layout, 'longitude_deg') : scaled(read(sample, layout, 'lon'), 1e-7);
  const altitude = layout.has('altitude_msl_m')
    ? read(sample, layout, 'altitude_msl_m')
    : scaled(read(sample, layout, 'alt'), 1e-3);
  if (latitude === undefined || longitude === undefined) return;
  tracker.position(at, gpsPosition(topic), { latitude, longitude }, altitude === undefined ? {} : { altitude });
}

const scaled = (value: number | undefined, factor: number) => (value === undefined ? undefined : value * factor);

export function isUlog(head: Uint8Array): boolean {
  return ULOG_MAGIC.every((byte, index) => head[index] === byte);
}

/** Reads a ULog stream to its end, or to the first message it cannot read. */
export async function readUlog(source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<LogReading> {
  const input = new ByteReader(source);
  const tracker = new FlightTracker();
  const done = (stopped?: LogReading['stopped']) => tracker.finish('ulog', 'PX4 ULog', input.offset, stopped);
  if (!(await input.has(HEADER_BYTES)) || !isUlog(input.peek(HEADER_BYTES)))
    return done({ offset: 0, reason: 'The file does not begin with a ULog header.' });
  input.take(HEADER_BYTES);

  const formats = new Formats();
  const subscriptions = new Map<number, { topic: string; layout: Layout }>();
  let appendedAt = 0;
  while (true) {
    const start = input.offset;
    if (!(await input.has(MESSAGE_HEADER_BYTES))) {
      if (await input.atEnd()) return done();
      return done({ offset: start, reason: `The log ends part-way through a message at byte ${start}.` });
    }
    const header = view(input.peek(MESSAGE_HEADER_BYTES));
    const size = header.getUint16(0, true);
    const type = String.fromCharCode(header.getUint8(2));
    if (appendedAt && start < appendedAt && start + MESSAGE_HEADER_BYTES + size > appendedAt) {
      // A message cut off where appended data begins: the spec says to discard it and read on from the appended data.
      await input.skip(appendedAt - start);
      continue;
    }
    if (!/^[A-Za-z]$/.test(type))
      return done({ offset: start, reason: `Byte ${start} does not begin a ULog message; the log is damaged there.` });
    if (!(await input.has(MESSAGE_HEADER_BYTES + size)))
      return done({ offset: start, reason: `The log ends part-way through a message at byte ${start}.` });
    input.take(MESSAGE_HEADER_BYTES);
    const body = input.take(size);
    tracker.messageStart = start;
    tracker.messageEnd = input.offset;
    const data = view(body);
    switch (type) {
      case 'B': {
        const incompatible = body.subarray(8, 16);
        if ((incompatible[0]! & ~DATA_APPENDED) !== 0 || incompatible.subarray(1).some((byte) => byte !== 0))
          return done({
            offset: start,
            reason: 'The log uses a feature of a later ULog version this reader does not know, so it was not read.',
          });
        if (incompatible[0]! & DATA_APPENDED && size >= 24) {
          appendedAt = Number(data.getBigUint64(16, true));
          tracker.note('The log has data appended after it, such as a crash record; it was read as part of the log.');
        }
        break;
      }
      case 'F':
        formats.add(text(body));
        break;
      case 'I': {
        const keyLength = body[0]!;
        const key = text(body.subarray(1, 1 + keyLength));
        if (/^char\[\d+\] sys_uuid$/.test(key)) {
          const identifier = text(body.subarray(1 + keyLength)).trim();
          if (identifier) tracker.vehicle = { identifier, from: 'the ULog information field sys_uuid' };
        }
        break;
      }
      case 'A': {
        const multiId = body[0]!;
        const id = data.getUint16(1, true);
        const topic = text(body.subarray(3));
        const layout = topic in topics && multiId === 0 ? formats.layout(topic) : undefined;
        if (layout) subscriptions.set(id, { topic, layout });
        break;
      }
      case 'D': {
        if (size < 2) return done({ offset: start, reason: `A data message at byte ${start} is too short to read.` });
        const subscription = subscriptions.get(data.getUint16(0, true));
        if (subscription)
          topics[subscription.topic]!(tracker, view(body.subarray(2)), subscription.layout, subscription.topic);
        break;
      }
      default:
        // Parameters, logged text, synchronization, dropouts, unsubscriptions and later message kinds say nothing a
        // flight record holds; the spec says a reader skips what it does not use.
        break;
    }
  }
}
