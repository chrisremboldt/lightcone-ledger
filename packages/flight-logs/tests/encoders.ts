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
