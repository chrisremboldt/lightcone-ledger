/**
 * Small writers for each log format, from the same published descriptions the readers follow, so that tests build
 * their own logs. Every coordinate is invented, near the repository's fictional sites; no real log is committed.
 */

export const RIDGE = { latitude: 39.5012345, longitude: -105.2034567 };
export const QUARRY = { latitude: 39.5141, longitude: -105.1873 };

/** A little-endian field writer. */
class Bytes {
  private readonly parts: number[] = [];
  u8(value: number) {
    this.parts.push(value & 0xff);
    return this;
  }
  u16(value: number) {
    return this.u8(value).u8(value >> 8);
  }
  i16(value: number) {
    return this.u16(value & 0xffff);
  }
  u32(value: number) {
    const view = new DataView(new ArrayBuffer(4));
    view.setUint32(0, value >>> 0, true);
    return this.raw(new Uint8Array(view.buffer));
  }
  i32(value: number) {
    const view = new DataView(new ArrayBuffer(4));
    view.setInt32(0, value, true);
    return this.raw(new Uint8Array(view.buffer));
  }
  u64(value: number | bigint, littleEndian = true) {
    const view = new DataView(new ArrayBuffer(8));
    view.setBigUint64(0, BigInt(value), littleEndian);
    return this.raw(new Uint8Array(view.buffer));
  }
  f32(value: number) {
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, value, true);
    return this.raw(new Uint8Array(view.buffer));
  }
  f64(value: number) {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value, true);
    return this.raw(new Uint8Array(view.buffer));
  }
  text(value: string, length?: number) {
    const bytes = new TextEncoder().encode(value);
    this.raw(length === undefined ? bytes : bytes.subarray(0, length));
    for (let index = bytes.byteLength; length !== undefined && index < length; index += 1) this.u8(0);
    return this;
  }
  raw(bytes: Uint8Array) {
    for (const byte of bytes) this.parts.push(byte);
    return this;
  }
  get length() {
    return this.parts.length;
  }
  done(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

export const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
};

/** Splits bytes into chunks of `size`, as a file stream would deliver them. */
export function* chunks(bytes: Uint8Array, size = 7): Generator<Uint8Array> {
  for (let at = 0; at < bytes.byteLength; at += size) yield bytes.subarray(at, at + size);
}

// ULog ---------------------------------------------------------------------------------------------------------------

export class UlogWriter {
  private readonly out = new Bytes();
  private readonly ids = new Map<string, number>();

  constructor(startMicros = 1_000_000) {
    this.out.raw(Uint8Array.from([0x55, 0x4c, 0x6f, 0x67, 0x01, 0x12, 0x35, 0x01])).u64(startMicros);
  }

  message(type: string, body: Uint8Array) {
    this.out.u16(body.byteLength).u8(type.charCodeAt(0)).raw(body);
    return this;
  }

  flags(incompatible: number[] = [], appendedOffset = 0) {
    const body = new Bytes();
    for (let index = 0; index < 8; index += 1) body.u8(0);
    for (let index = 0; index < 8; index += 1) body.u8(incompatible[index] ?? 0);
    body.u64(appendedOffset).u64(0).u64(0);
    return this.message('B', body.done());
  }

  format(definition: string) {
    return this.message('F', new Bytes().text(definition).done());
  }

  info(key: string, value: string) {
    return this.message('I', new Bytes().u8(key.length).text(key).text(value).done());
  }

  subscribe(topic: string, multiId = 0) {
    const id = this.ids.size;
    this.ids.set(`${topic}/${multiId}`, id);
    return this.message('A', new Bytes().u8(multiId).u16(id).text(topic).done());
  }

  data(topic: string, fill: (bytes: Bytes) => void, multiId = 0) {
    const body = new Bytes().u16(this.ids.get(`${topic}/${multiId}`)!);
    fill(body);
    return this.message('D', body.done());
  }

  logged(text: string) {
    return this.message('L', new Bytes().u8(6).u64(0).text(text).done());
  }

  get length() {
    return this.out.length;
  }

  done() {
    return this.out.done();
  }
}

/** The formats of the topics the reader reads, with a nested type and padding as PX4 writes them. */
export function px4Definitions(log: UlogWriter, gpsInDegrees = true) {
  log
    .flags()
    .format('vehicle_status:uint64_t timestamp;uint8_t nav_state;uint8_t arming_state;uint8_t[6] _padding0;')
    .format('vehicle_land_detected:uint64_t timestamp;bool freefall;bool landed;uint8_t[6] _padding0;')
    .format('position_offsets:float north;float east;')
    .format(
      'vehicle_global_position:uint64_t timestamp;position_offsets offsets;double lat;double lon;float alt;uint8_t[4] _padding0;',
    )
    .format(
      gpsInDegrees
        ? 'sensor_gps:uint64_t timestamp;uint64_t time_utc_usec;double latitude_deg;double longitude_deg;double altitude_msl_m;uint8_t fix_type;uint8_t[7] _padding0;'
        : 'vehicle_gps_position:uint64_t timestamp;uint64_t time_utc_usec;int32_t lat;int32_t lon;int32_t alt;uint8_t fix_type;uint8_t[3] _padding0;',
    )
    .info('char[4] sys_name', 'PX4')
    .info('char[24] sys_uuid', 'EXAMPLE-RIDGE-0001')
    .subscribe('vehicle_status')
    .subscribe('vehicle_land_detected')
    .subscribe('vehicle_global_position')
    .subscribe(gpsInDegrees ? 'sensor_gps' : 'vehicle_gps_position');
  return log;
}

export const px4 = {
  status: (log: UlogWriter, at: number, armed: boolean) =>
    log.data('vehicle_status', (bytes) =>
      bytes
        .u64(at)
        .u8(4)
        .u8(armed ? 2 : 1)
        .raw(new Uint8Array(6)),
    ),
  landed: (log: UlogWriter, at: number, landed: boolean) =>
    log.data('vehicle_land_detected', (bytes) =>
      bytes
        .u64(at)
        .u8(0)
        .u8(landed ? 1 : 0),
    ),
  global: (log: UlogWriter, at: number, place: { latitude: number; longitude: number }, altitude: number) =>
    log.data('vehicle_global_position', (bytes) =>
      bytes.u64(at).f32(0).f32(0).f64(place.latitude).f64(place.longitude).f32(altitude),
    ),
  gps: (log: UlogWriter, at: number, utcMicros: number, place: { latitude: number; longitude: number }, fix = 3) =>
    log.data('sensor_gps', (bytes) =>
      bytes.u64(at).u64(utcMicros).f64(place.latitude).f64(place.longitude).f64(1850).u8(fix),
    ),
  oldGps: (log: UlogWriter, at: number, utcMicros: number, place: { latitude: number; longitude: number }) =>
    log.data('vehicle_gps_position', (bytes) =>
      bytes
        .u64(at)
        .u64(utcMicros)
        .i32(Math.round(place.latitude * 1e7))
        .i32(Math.round(place.longitude * 1e7))
        .i32(1_850_000)
        .u8(3),
    ),
};

// DataFlash ----------------------------------------------------------------------------------------------------------

const characterSizes: Record<string, number> = {
  B: 1,
  b: 1,
  M: 1,
  h: 2,
  H: 2,
  c: 2,
  C: 2,
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

export class DataflashWriter {
  private readonly out = new Bytes();
  private readonly types = new Map<string, number>();

  constructor() {
    this.describe(128, 'FMT', 'BBnNZ', 'Type,Length,Name,Format,Columns', 89);
  }

  describe(type: number, name: string, format: string, columns: string, length?: number) {
    this.types.set(name, type);
    const size = length ?? 3 + [...format].reduce((sum, character) => sum + characterSizes[character]!, 0);
    this.out.u8(0xa3).u8(0x95).u8(128).u8(type).u8(size).text(name, 4).text(format, 16).text(columns, 64);
    return this;
  }

  message(name: string, fill: (bytes: Bytes) => void) {
    this.out.u8(0xa3).u8(0x95).u8(this.types.get(name)!);
    fill(this.out);
    return this;
  }

  raw(bytes: Uint8Array) {
    this.out.raw(bytes);
    return this;
  }

  get length() {
    return this.out.length;
  }

  done() {
    return this.out.done();
  }
}

/** The formats of the messages the reader reads, as LogStructure.h gives them. */
export function arduPilotDefinitions(log: DataflashWriter) {
  return log
    .describe(129, 'PARM', 'QNff', 'TimeUS,Name,Value,Default')
    .describe(130, 'EV', 'QB', 'TimeUS,Id')
    .describe(131, 'ARM', 'QBIBB', 'TimeUS,ArmState,ArmChecks,Forced,Method')
    .describe(132, 'GPS', 'QBBIHBcLLeffffB', 'TimeUS,I,Status,GMS,GWk,NSats,HDop,Lat,Lng,Alt,Spd,GCrs,VZ,Yaw,U')
    .describe(133, 'POS', 'QLLfff', 'TimeUS,Lat,Lng,Alt,RelHomeAlt,RelOriginAlt');
}

export const arduPilot = {
  event: (log: DataflashWriter, at: number, id: number) => log.message('EV', (bytes) => bytes.u64(at).u8(id)),
  arm: (log: DataflashWriter, at: number, armed: boolean) =>
    log.message('ARM', (bytes) =>
      bytes
        .u64(at)
        .u8(armed ? 1 : 0)
        .u32(0)
        .u8(0)
        .u8(0),
    ),
  parameter: (log: DataflashWriter, at: number) =>
    log.message('PARM', (bytes) => bytes.u64(at).text('SYSID_THISMAV', 16).f32(1).f32(1)),
  /** A GPS sample; `gpsTime` as a GPS week and milliseconds into it. */
  gps: (
    log: DataflashWriter,
    at: number,
    gpsTime: { week: number; milliseconds: number },
    place: { latitude: number; longitude: number },
    status = 3,
  ) =>
    log.message('GPS', (bytes) =>
      bytes
        .u64(at)
        .u8(0)
        .u8(status)
        .u32(gpsTime.milliseconds)
        .u16(gpsTime.week)
        .u8(12)
        .i16(80)
        .i32(Math.round(place.latitude * 1e7))
        .i32(Math.round(place.longitude * 1e7))
        .i32(185_000)
        .f32(0)
        .f32(0)
        .f32(0)
        .f32(0)
        .u8(1),
    ),
  position: (
    log: DataflashWriter,
    at: number,
    place: { latitude: number; longitude: number },
    altitude: number,
    aboveHome: number,
  ) =>
    log.message('POS', (bytes) =>
      bytes
        .u64(at)
        .i32(Math.round(place.latitude * 1e7))
        .i32(Math.round(place.longitude * 1e7))
        .f32(altitude)
        .f32(aboveHome)
        .f32(aboveHome),
    ),
};

/** The GPS week and milliseconds into it for a UTC instant, with the 18 leap seconds in force since 2017. */
export function gpsTimeOf(utcMilliseconds: number): { week: number; milliseconds: number } {
  const gps = utcMilliseconds + 18_000 - Date.UTC(1980, 0, 6);
  return { week: Math.floor(gps / 604_800_000), milliseconds: gps % 604_800_000 };
}

// MAVLink telemetry log ----------------------------------------------------------------------------------------------

const crcExtra: Record<number, number> = { 0: 50, 33: 104, 245: 130, 148: 178 };

function checksum(bytes: Uint8Array, extra: number): number {
  let crc = 0xffff;
  for (const byte of [...bytes, extra]) {
    let tmp = byte ^ (crc & 0xff);
    tmp = (tmp ^ (tmp << 4)) & 0xff;
    crc = ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff;
  }
  return crc;
}

export class TlogWriter {
  private readonly out = new Bytes();
  private sequence = 0;

  /** One packet at `utcMicros`; version 2 trims trailing zero bytes of the payload, as the serialization does. */
  packet(
    utcMicros: number,
    id: number,
    payload: Uint8Array,
    options: { version?: 1 | 2; system?: number; badCrc?: boolean } = {},
  ) {
    const version = options.version ?? 2;
    const system = options.system ?? 1;
    let body = payload;
    if (version === 2) {
      let end = body.byteLength;
      while (end > 1 && body[end - 1] === 0) end -= 1;
      body = body.subarray(0, end);
    }
    const header =
      version === 1
        ? Uint8Array.from([0xfe, body.byteLength, this.sequence, system, 1, id])
        : Uint8Array.from([
            0xfd,
            body.byteLength,
            0,
            0,
            this.sequence,
            system,
            1,
            id & 0xff,
            (id >> 8) & 0xff,
            id >> 16,
          ]);
    this.sequence = (this.sequence + 1) & 0xff;
    const signed = concat(header, body);
    const crc = checksum(signed.subarray(1), crcExtra[id] ?? 0) ^ (options.badCrc ? 0xffff : 0);
    this.out.u64(utcMicros, false).raw(signed).u16(crc);
    return this;
  }

  heartbeat(utcMicros: number, armed: boolean, options: { type?: number; autopilot?: number; system?: number } = {}) {
    const payload = new Bytes()
      .u32(0)
      .u8(options.type ?? 2)
      .u8(options.autopilot ?? 3)
      .u8(armed ? 0x80 | 0x01 : 0x01)
      .u8(armed ? 4 : 3)
      .u8(3)
      .done();
    return this.packet(utcMicros, 0, payload, { system: options.system ?? 1 });
  }

  position(
    utcMicros: number,
    place: { latitude: number; longitude: number },
    altitude: number,
    aboveHome: number,
    version: 1 | 2 = 2,
  ) {
    const payload = new Bytes()
      .u32(utcMicros / 1000)
      .i32(Math.round(place.latitude * 1e7))
      .i32(Math.round(place.longitude * 1e7))
      .i32(Math.round(altitude * 1000))
      .i32(Math.round(aboveHome * 1000))
      .i16(0)
      .i16(0)
      .i16(0)
      .u16(0)
      .done();
    return this.packet(utcMicros, 33, payload, { version });
  }

  landedState(utcMicros: number, state: number) {
    return this.packet(utcMicros, 245, Uint8Array.from([0, state]));
  }

  autopilotVersion(utcMicros: number, uid: bigint) {
    const payload = new Bytes()
      .u64(0)
      .u64(uid)
      .u32(0)
      .u32(0)
      .u32(0)
      .u32(0)
      .u16(0)
      .u16(0)
      .raw(new Uint8Array(24))
      .done();
    return this.packet(utcMicros, 148, payload);
  }

  /** A packet of a message the reader does not decode, such as ATTITUDE (30). */
  other(utcMicros: number) {
    return this.packet(utcMicros, 30, new Uint8Array(28).fill(7));
  }

  get length() {
    return this.out.length;
  }

  done() {
    return this.out.done();
  }
}

const GUTMA_KEYS = ['timestamp', 'gps_lon', 'gps_lat', 'gps_altitude', 'speed', 'battery_voltage'];
/** One sample row in the order of the keys above. */
export const gutmaSample = (seconds: number, place: { latitude: number; longitude: number }, altitude: number) => [
  seconds,
  place.longitude,
  place.latitude,
  altitude,
  4,
  15.2,
];
export const gutmaEvent = (info: string, seconds: number | string) => ({
  event_type: 'CONTROLER_EVENT',
  event_info: info,
  event_timestamp: seconds,
});

/**
 * A GUTMA flight logging message as its published description lays one out: one flight from the ridge pad to the
 * quarry gate. `logging` replaces keys of its flight_logging section and `rest` keys of the message.
 */
export function gutmaMessage(logging: Record<string, unknown> = {}, rest: Record<string, unknown> = {}) {
  return {
    exchange: {
      exchange_type: 'flight_logging',
      message: {
        flight_data: {
          aircraft: {
            manufacturer: 'Example Aero',
            model: 'EX-4',
            name: 'Ridge survey one',
            serial_number: 'EXAMPLE-RIDGE-0001',
            firmware_version: '2.01b',
            hardware_version: '1.00B',
          },
          gcs: { manufacturer: 'Example Aero', model: 'Ground', version: '1.1' },
          payload: [{ model: 'Example camera', serial_number: 'EXAMPLE-CAM-7' }],
          project: 'Ridge survey',
        },
        flight_logging: {
          flight_logging_items: [
            gutmaSample(0.5, RIDGE, 1850),
            gutmaSample(12, RIDGE, 1850.2),
            gutmaSample(40, RIDGE, 1890.44),
            gutmaSample(90, QUARRY, 1871),
            gutmaSample(118, QUARRY, 1830),
            gutmaSample(125, QUARRY, 1830),
          ],
          flight_logging_keys: GUTMA_KEYS,
          event: [gutmaEvent('TAKE_OFF', '12'), gutmaEvent('GPS_LOST', '50'), gutmaEvent('LANDING', 118)],
          altitude_system: 'MSL',
          logging_start_dtg: '2026-11-10T16:05:00.250Z',
          tick_increment_modulo: '1',
          tick_increment_seconds: '1',
          uom_system: 'Metric',
          ...logging,
        },
        file: {
          logging_type: 'GUTMA_DX_JSON',
          filename: 'EXAMPLE-RIDGE-0001_0069',
          creation_dtg: '2026-11-10T17:00:00.000Z',
          version: '1.0.0',
        },
        message_type: 'flight_logging_submission',
        ...rest,
      },
    },
  };
}

// DJI flight record ---------------------------------------------------------------------------------------------------

type DjiPlace = { latitude: number; longitude: number };

/**
 * The key a record's content is scrambled with from version 7, computed bit by bit from the layout's description
 * and not with the reader's own table, so that the two check each other.
 */
function djiKey(seed: number, type: number): Uint8Array {
  const data = new Bytes().u64((0x123456789abcdef0n * BigInt(seed)) & ((1n << 64n) - 1n)).done();
  let crc = BigInt((seed + type) & 0xff);
  for (const byte of data) {
    crc ^= BigInt(byte);
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1n ? (crc >> 1n) ^ 0x95ac9329ac4bc9b5n : crc >> 1n;
  }
  return new Bytes().u64(crc).done();
}

/** One record as a file of `version` stores it: plainly up to version 6, scrambled from version 7. */
export function djiRecord(version: number, type: number, data: Uint8Array, seed = 0x5a): Uint8Array {
  if (version < 7) return new Bytes().u8(type).u8(data.byteLength).raw(data).u8(0xff).done();
  const key = djiKey(seed, type);
  const length = data.byteLength + 2;
  const out = new Bytes().u8(type).u8(length).u8(seed);
  data.forEach((byte, index) => out.u8(byte ^ key[index % 8]!));
  out.u8(((seed + type) & 0xff) ^ key[(length - 2) % 8]!);
  // A content of 256 bytes or more wraps its length byte and is followed by an arbitrary byte, not the end byte.
  return out.u8(length > 255 ? 0x00 : 0xff).done();
}

/** The content of a type 1 record: the position in radians, the height in tenths of a metre, the state bits. */
export function djiState(
  place: DjiPlace,
  height: number,
  state: { inAir: boolean; motorsOn?: boolean; bits?: number },
): Uint8Array {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const out = new Bytes()
    .f64(radians(place.longitude))
    .f64(radians(place.latitude))
    .i16(Math.round(height * 10));
  while (out.length < 32) out.u8(0);
  out.u8(state.bits ?? (state.inAir ? 0x04 : 0x00) | ((state.motorsOn ?? true) ? 0x08 : 0x00) | 0x01);
  while (out.length < 53) out.u8(0);
  return out.done();
}

/** The content of a type 5 record: the app's time, in seconds up to version 2 and milliseconds after. */
export const djiTime = (utcMilliseconds: number, version: number) =>
  new Bytes()
    .u8(0)
    .u8(0)
    .f32(3.2)
    .f32(120)
    .u64(version <= 2 ? Math.round(utcMilliseconds / 1000) : utcMilliseconds)
    .done();

export const DJI_START = Date.UTC(2026, 10, 10, 16, 5, 0);

/** One sample: a state record, a record of a type no reader here reads, and the app's time. */
export const djiFrame = (
  version: number,
  seconds: number,
  place: DjiPlace,
  height: number,
  state: { inAir: boolean; motorsOn?: boolean; bits?: number },
) => [
  djiRecord(version, 1, djiState(place, height, state), 0x5a + (seconds & 0x3f)),
  djiRecord(version, 3, new Uint8Array(24).fill(7), 0x11),
  djiRecord(version, 5, djiTime(DJI_START + seconds * 1000, version), 0xc3),
];

/** One flight from the ridge pad to the quarry gate, which lies lower. */
export const djiFlight = (version: number) => [
  ...djiFrame(version, 0, RIDGE, 0, { inAir: false, motorsOn: false }),
  ...djiFrame(version, 5, RIDGE, 0, { inAir: false }),
  ...djiFrame(version, 12, RIDGE, 1.2, { inAir: true }),
  ...djiFrame(version, 40, RIDGE, 44.8, { inAir: true }),
  ...djiFrame(version, 90, QUARRY, 21, { inAir: true }),
  ...djiFrame(version, 118, QUARRY, -19.6, { inAir: false }),
  ...djiFrame(version, 125, QUARRY, -19.6, { inAir: false, motorsOn: false }),
];

export interface DjiHeader {
  name: string;
  serial: string;
  startUtc: number;
  place: DjiPlace;
  totalSeconds: number;
  greatestHeight: number;
}

const DJI_HEADER: DjiHeader = {
  name: 'Ridge survey one',
  serial: 'EXAMPLE001',
  startUtc: DJI_START - 2000,
  place: RIDGE,
  totalSeconds: 125,
  greatestHeight: 44.8,
};

/** The header as the layout places its fields: the aircraft's name and serial number move after version 5. */
export function djiHeader(version: number, header: Partial<DjiHeader> = {}): Uint8Array {
  const stated = { ...DJI_HEADER, ...header };
  const out = new Bytes().text('', 20).text('Ridge road', 20).text('Example Ridge', 20).text('', 20);
  out.u8(0).u8(1).u8(0).i32(1250).i32(0).u64(stated.startUtc);
  out.f64(stated.place.longitude).f64(stated.place.latitude);
  out
    .f32(1480)
    .i32(Math.round(stated.totalSeconds * 1000))
    .f32(stated.greatestHeight)
    .f32(8.1)
    .f32(3)
    .i32(4);
  while (out.length < 267) out.u8(0);
  if (version <= 5) out.text(stated.serial, 10).u8(13).text(stated.name, 24);
  else {
    out.f32(18500).u8(13).u64(0).text(stated.name, 32).text(stated.serial, 16);
    out.text('EXAMPLECAM01', 16).text('EXAMPLERC01', 16).text('EXAMPLEBAT01', 16).u8(2).u8(1).u8(4).u8(0);
  }
  while (out.length < (version === 12 ? 436 : 400)) out.u8(0);
  return out.done();
}

/**
 * A whole file of `version` as the layout's documentation lays one out: the first bytes, then the records and the
 * header in the order that version keeps them. From version 13 the header is in a scrambled block and `records`
 * stands for content this project cannot read.
 */
export function djiFile(version: number, records: Uint8Array[], header: Partial<DjiHeader> = {}): Uint8Array {
  const body = concat(...records);
  const details = djiHeader(version, header);
  const prefix = (offset: number) => {
    const out = new Bytes().u64(offset).u16(details.byteLength).u8(version).u8(0);
    while (version >= 6 && out.length < 100) out.u8(0);
    return out.done();
  };
  if (version < 12) return concat(prefix((version < 6 ? 12 : 100) + body.byteLength), body, details);
  if (version === 12) return concat(prefix(536 + body.byteLength), details, body);
  const inner = new Bytes().u8(1).u16(details.byteLength).raw(details).u16(0).done();
  const seed = 0x31;
  const key = djiKey(seed, 0);
  const block = new Bytes()
    .u8(0)
    .u16(inner.byteLength + 1)
    .u8(seed);
  inner.forEach((byte, index) => block.u8(byte ^ key[index % 8]!));
  const versionBlock = new Bytes().u8(1).u16(3).u16(2).u8(3).done();
  return concat(prefix(100 + block.length + versionBlock.byteLength), block.done(), versionBlock, body);
}

// The CSV of frames the dji-log tool writes from a DJI flight record ------------------------------------------------

/** Some of the tool's columns, under its own names and in its own order; a real export has more than two hundred. */
export const DJI_FRAME_COLUMNS = [
  'CUSTOM.dateTime',
  'OSD.flyTime',
  'OSD.latitude',
  'OSD.longitude',
  'OSD.height',
  'OSD.heightMax',
  'OSD.altitude',
  'OSD.isOnGround',
  'OSD.isMotorOn',
  'HOME.latitude',
  'HOME.longitude',
  'HOME.altitude',
  'DETAILS.totalTime',
  'DETAILS.maxHeight',
  'DETAILS.aircraftName',
  'DETAILS.aircraftSerial',
  'DETAILS.startTime',
];

export interface DjiCsvFrame {
  seconds: number;
  place: DjiPlace;
  height: number;
  inAir: boolean;
  motorsOn?: boolean;
}

/** The flight of `djiFlight`, frame for frame. */
export const DJI_FRAMES: DjiCsvFrame[] = [
  { seconds: 0, place: RIDGE, height: 0, inAir: false, motorsOn: false },
  { seconds: 5, place: RIDGE, height: 0, inAir: false },
  { seconds: 12, place: RIDGE, height: 1.2, inAir: true },
  { seconds: 40, place: RIDGE, height: 44.8, inAir: true },
  { seconds: 90, place: QUARRY, height: 21, inAir: true },
  { seconds: 118, place: QUARRY, height: -19.6, inAir: false },
  { seconds: 125, place: QUARRY, height: -19.6, inAir: false, motorsOn: false },
];

/** A short flight a second at a time: on the ground at the ridge pad, up, along to the quarry gate, down. */
export function djiExampleFrames(): DjiCsvFrame[] {
  const between = (from: number, to: number, part: number) => Math.round((from + (to - from) * part) * 1e7) / 1e7;
  const tenth = (value: number) => Math.round(value * 10) / 10;
  return Array.from({ length: 40 }, (_, seconds): DjiCsvFrame => {
    if (seconds < 6) return { seconds, place: RIDGE, height: 0, inAir: false, motorsOn: seconds >= 2 };
    if (seconds <= 15) return { seconds, place: RIDGE, height: tenth((seconds - 5) * 4.48), inAir: true };
    if (seconds <= 30) {
      const part = (seconds - 15) / 15;
      const place = {
        latitude: between(RIDGE.latitude, QUARRY.latitude, part),
        longitude: between(RIDGE.longitude, QUARRY.longitude, part),
      };
      return { seconds, place, height: tenth(44.8 - 23.8 * part), inAir: true };
    }
    if (seconds <= 36) return { seconds, place: QUARRY, height: tenth(21 - (40.6 * (seconds - 30)) / 7), inAir: true };
    return { seconds, place: QUARRY, height: -19.6, inAir: false, motorsOn: seconds === 37 };
  });
}

const csvText = (cell: string) => (/[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell);

/**
 * The tool's CSV for these frames: one row a frame, the summary repeated on every row. `columns` chooses and orders
 * the columns; `cell` replaces what a column holds.
 */
export function djiFramesCsv(
  frames: DjiCsvFrame[],
  options: {
    columns?: string[];
    cell?: (column: string, frame: DjiCsvFrame, value: string) => string;
    name?: string;
    lineEnd?: string;
  } = {},
): string {
  const columns = options.columns ?? DJI_FRAME_COLUMNS;
  const time = (seconds: number) => new Date(DJI_START + seconds * 1000).toISOString();
  const greatest = Math.max(...frames.map((frame) => frame.height));
  let greatestSoFar = -Infinity;
  const rows = frames.map((frame) => {
    greatestSoFar = Math.max(greatestSoFar, frame.height);
    const values: Record<string, string> = {
      'CUSTOM.dateTime': time(frame.seconds),
      'OSD.flyTime': String(frame.seconds),
      'OSD.latitude': String(frame.place.latitude),
      'OSD.longitude': String(frame.place.longitude),
      'OSD.height': String(frame.height),
      'OSD.heightMax': String(greatestSoFar),
      'OSD.altitude': String(Math.round((1850 + frame.height) * 10) / 10),
      'OSD.isOnGround': String(!frame.inAir),
      'OSD.isMotorOn': String(frame.motorsOn ?? true),
      'HOME.latitude': String(RIDGE.latitude),
      'HOME.longitude': String(RIDGE.longitude),
      'HOME.altitude': '1850',
      'DETAILS.totalTime': String(frames.at(-1)!.seconds),
      'DETAILS.maxHeight': String(greatest),
      'DETAILS.aircraftName': options.name ?? DJI_HEADER.name,
      'DETAILS.aircraftSerial': DJI_HEADER.serial,
      'DETAILS.startTime': time(-2),
    };
    return columns
      .map((column) => csvText(options.cell?.(column, frame, values[column] ?? '') ?? values[column] ?? ''))
      .join(',');
  });
  const lineEnd = options.lineEnd ?? '\n';
  return [columns.map(csvText).join(','), ...rows].map((line) => `${line}${lineEnd}`).join('');
}

/** The file the example's page tells a person to make: the tool's header row and last row, with two ids in front. */
export function djiLastRowWithIds(frames: string, flightId: string, aircraftId: string): string {
  const lines = frames.trimEnd().split('\n');
  return `Flight id,Aircraft id,${lines[0]}\n${flightId},${aircraftId},${lines.at(-1)}\n`;
}
