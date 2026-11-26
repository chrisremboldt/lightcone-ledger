import { ByteReader, view } from './byte-reader.js';
import { FlightTracker, type LogReading, type PositionSource } from './flights.js';

/**
 * A MAVLink telemetry log (.tlog), as ground stations write one: each MAVLink packet as received, after an 8-byte
 * big-endian time in microseconds since 1970 on the ground station's clock. Packets are read from the MAVLink
 * serialization description (mavlink.io, "Packet Serialization") and the common message set: version 1 packets begin
 * 0xFE, version 2 packets 0xFD. Only the messages a flight record needs are decoded and checked by their checksum;
 * every other packet is skipped by its length.
 */

const STAMP_BYTES = 8;
const V1 = 0xfe;
const V2 = 0xfd;
const V1_OVERHEAD = 8;
const V2_OVERHEAD = 12;
const SIGNATURE_BYTES = 13;
const SIGNED = 0x01;
/** HEARTBEAT.base_mode bit set while the vehicle is armed (MAV_MODE_FLAG_SAFETY_ARMED). */
const SAFETY_ARMED = 0x80;
/** HEARTBEAT.type of a ground station and HEARTBEAT.autopilot of a component that is not an autopilot. */
const MAV_TYPE_GCS = 6;
const MAV_AUTOPILOT_INVALID = 8;
/** EXTENDED_SYS_STATE.landed_state: 0 undefined, 1 on the ground, 2 in the air, 3 taking off, 4 landing. */
const LANDED_STATE = { undefined: 0, onGround: 1 } as const;

interface Message {
  /** The checksum seed MAVLink derives from the message's definition. */
  crcExtra: number;
  /** The payload length the message has without extension fields; a shorter version 2 payload is zero-filled. */
  length: number;
  read: (tracker: FlightTracker, at: number, payload: DataView, reading: TlogState) => void;
}

interface TlogState {
  vehicle?: number;
  sawHeartbeat: boolean;
}

const globalPosition: PositionSource = {
  name: 'GLOBAL_POSITION_INT',
  rank: 0,
  heightReference: 'above home, as the vehicle sent it (GLOBAL_POSITION_INT.relative_alt)',
  altitudeReference: 'above mean sea level, GLOBAL_POSITION_INT.alt',
};

const messages = new Map<number, Message>([
  [
    0,
    {
      crcExtra: 50,
      length: 9,
      read(tracker, at, payload, state) {
        const type = payload.getUint8(4);
        const autopilot = payload.getUint8(5);
        if (type === MAV_TYPE_GCS || autopilot === MAV_AUTOPILOT_INVALID) return;
        state.sawHeartbeat = true;
        tracker.armedState(at, (payload.getUint8(6) & SAFETY_ARMED) !== 0);
      },
    },
  ],
  [
    33,
    {
      crcExtra: 104,
      length: 28,
      read(tracker, at, payload) {
        tracker.position(
          at,
          globalPosition,
          { latitude: payload.getInt32(4, true) / 1e7, longitude: payload.getInt32(8, true) / 1e7 },
          { altitude: payload.getInt32(12, true) / 1000, height: payload.getInt32(16, true) / 1000 },
        );
      },
    },
  ],
  [
    245,
    {
      crcExtra: 130,
      length: 2,
      read(tracker, at, payload) {
        const state = payload.getUint8(1);
        if (state !== LANDED_STATE.undefined) tracker.landedState(at, state === LANDED_STATE.onGround);
      },
    },
  ],
  [
    148,
    {
      crcExtra: 178,
      length: 60,
      read(tracker, _at, payload) {
        const uid = payload.getBigUint64(8, true);
        if (uid !== 0n && !tracker.vehicle)
          tracker.vehicle = {
            identifier: uid.toString(16).padStart(16, '0'),
            from: 'AUTOPILOT_VERSION.uid, the identifier the autopilot sent',
          };
      },
    },
  ],
]);

/** CRC-16/MCRF4XX, the checksum MAVLink uses, over `bytes` then the message's seed. */
function checksum(bytes: Uint8Array, crcExtra: number): number {
  let crc = 0xffff;
  const add = (byte: number) => {
    let tmp = byte ^ (crc & 0xff);
    tmp = (tmp ^ (tmp << 4)) & 0xff;
    crc = ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff;
  };
  for (const byte of bytes) add(byte);
  add(crcExtra);
  return crc;
}

const plausibleStamp = (micros: bigint) =>
  micros > BigInt(Date.UTC(2000, 0, 1)) * 1000n && micros < BigInt(Date.UTC(2100, 0, 1)) * 1000n;

export function isTlog(head: Uint8Array): boolean {
  if (head.byteLength < STAMP_BYTES + 1) return false;
  const marker = head[STAMP_BYTES];
  return (marker === V1 || marker === V2) && plausibleStamp(view(head).getBigUint64(0, false));
}

/** Reads a telemetry log to its end, or to the first packet it cannot read. */
export async function readTlog(source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<LogReading> {
  const input = new ByteReader(source);
  const tracker = new FlightTracker();
  const state: TlogState = { sawHeartbeat: false };
  const done = (stopped?: LogReading['stopped']) => {
    if (!state.sawHeartbeat) tracker.note('The log holds no heartbeat from an autopilot, so no arming was read.');
    return tracker.finish('tlog', 'MAVLink telemetry log', input.offset, stopped);
  };
  if (!(await input.has(STAMP_BYTES + 1)) || !isTlog(input.peek(STAMP_BYTES + 1)))
    return done({ offset: 0, reason: 'The file does not begin with a timed MAVLink packet.' });
  tracker.clockIsUtc("the ground station's clock as it received each message");
  while (true) {
    const start = input.offset;
    if (await input.atEnd()) return done();
    const cut = { offset: start, reason: `The log ends part-way through a packet at byte ${start}.` };
    if (!(await input.has(STAMP_BYTES + 3))) return done(cut);
    const head = input.peek(STAMP_BYTES + 3);
    const stamp = view(head).getBigUint64(0, false);
    const marker = head[STAMP_BYTES]!;
    const payloadLength = head[STAMP_BYTES + 1]!;
    if ((marker !== V1 && marker !== V2) || !plausibleStamp(stamp))
      return done({
        offset: start,
        reason: `Byte ${start} does not begin a timed MAVLink packet; the log is damaged there.`,
      });
    const signed = marker === V2 && (head[STAMP_BYTES + 2]! & SIGNED) !== 0;
    const packetLength = payloadLength + (marker === V1 ? V1_OVERHEAD : V2_OVERHEAD) + (signed ? SIGNATURE_BYTES : 0);
    if (!(await input.has(STAMP_BYTES + packetLength))) return done(cut);
    const packet = input.take(STAMP_BYTES + packetLength).subarray(STAMP_BYTES);
    tracker.messageStart = start;
    tracker.messageEnd = input.offset;
    const headerLength = marker === V1 ? 6 : 10;
    const system = packet[marker === V1 ? 3 : 5]!;
    const id = marker === V1 ? packet[5]! : packet[7]! | (packet[8]! << 8) | (packet[9]! << 16);
    const message = messages.get(id);
    if (!message) continue;
    const crcAt = headerLength + payloadLength;
    const sent = packet[crcAt]! | (packet[crcAt + 1]! << 8);
    if (checksum(packet.subarray(1, crcAt), message.crcExtra) !== sent)
      return done({
        offset: start,
        reason: `The packet at byte ${start} fails its checksum; the log is damaged there.`,
      });
    // Only the first autopilot heard is followed; a second vehicle or a camera on the same link is not this flight.
    if (id === 0 && state.vehicle === undefined) {
      const payload = view(packet.subarray(headerLength, crcAt));
      if (payload.getUint8(4) !== MAV_TYPE_GCS && payload.getUint8(5) !== MAV_AUTOPILOT_INVALID) state.vehicle = system;
    }
    if (state.vehicle === undefined || system !== state.vehicle) continue;
    const payload = new Uint8Array(Math.max(message.length, payloadLength));
    payload.set(packet.subarray(headerLength, crcAt));
    message.read(tracker, Number(stamp), view(payload), state);
  }
}
