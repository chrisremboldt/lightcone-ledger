import { describe, expect, it } from 'vitest';
import { formatOf, readTlog } from '../src/index.js';
import { chunks, QUARRY, RIDGE, TlogWriter } from './encoders.js';

const S = 1_000_000;
const UTC = Date.UTC(2026, 10, 10, 16, 5, 0) * 1000;
const LANDED = { onGround: 1, inAir: 2 };

function twoFlights(): { bytes: Uint8Array; flightOneEnds: number } {
  const log = new TlogWriter();
  log.heartbeat(UTC, false, { type: 6, autopilot: 8, system: 255 });
  log.heartbeat(UTC + S, false);
  log.autopilotVersion(UTC + S, 0x0035002b34345117n);
  log.heartbeat(UTC + 10 * S, true);
  log.position(UTC + 11 * S, RIDGE, 1850, 0, 1);
  log.landedState(UTC + 12 * S, LANDED.inAir);
  log.other(UTC + 13 * S);
  log.position(UTC + 30 * S, RIDGE, 1880, 30.5);
  log.landedState(UTC + 70 * S, LANDED.onGround);
  log.heartbeat(UTC + 72 * S, false);
  const flightOneEnds = log.length;
  log.heartbeat(UTC + 100 * S, true);
  log.landedState(UTC + 102 * S, LANDED.inAir);
  log.position(UTC + 150 * S, QUARRY, 1900, 50);
  log.landedState(UTC + 200 * S, LANDED.onGround);
  log.heartbeat(UTC + 203 * S, false);
  return { bytes: log.done(), flightOneEnds };
}

describe('MAVLink telemetry log reader', () => {
  it('is told from its first timed packet', () => {
    expect(formatOf(twoFlights().bytes.subarray(0, 16))).toBe('tlog');
  });

  it('reads two flights of the first autopilot heard, with times from the ground station’s clock', async () => {
    const reading = await readTlog(chunks(twoFlights().bytes, 9));
    expect(reading.stopped).toBeUndefined();
    expect(reading.absoluteTime).toMatch(/ground station/);
    expect(reading.vehicle?.identifier).toBe('0035002b34345117');
    expect(reading.flights).toHaveLength(2);
    expect(reading.flights[0]).toMatchObject({
      rule: 'takeoff_to_landing',
      takeoffAt: '2026-11-10T16:05:12Z',
      landingAt: '2026-11-10T16:06:10Z',
      takeoffPlace: RIDGE,
      greatestHeight: { meters: 30.5, reference: expect.stringMatching(/relative_alt/) },
    });
    expect(reading.flights[1]).toMatchObject({ landingPlaces: [QUARRY], takeoffAt: '2026-11-10T16:06:42Z' });
  });

  it('ignores a second vehicle on the same link', async () => {
    const log = new TlogWriter();
    log.heartbeat(UTC, false);
    log.heartbeat(UTC + S, true, { system: 2 });
    log.heartbeat(UTC + 2 * S, true);
    log.heartbeat(UTC + 9 * S, false, { system: 2 });
    log.heartbeat(UTC + 12 * S, false);
    const reading = await readTlog([log.done()]);
    expect(reading.flights).toHaveLength(1);
    expect(reading.flights[0]).toMatchObject({ rule: 'arming_to_disarming', durationSeconds: 10 });
  });

  it('stops cleanly at a packet that fails its checksum, keeping the flights before it', async () => {
    const { bytes } = twoFlights();
    const log = new TlogWriter();
    log.heartbeat(UTC + 300 * S, true).packet(UTC + 301 * S, 33, new Uint8Array(28), { badCrc: true });
    const joined = new Uint8Array(bytes.byteLength + log.length);
    joined.set(bytes);
    joined.set(log.done(), bytes.byteLength);
    const reading = await readTlog([joined]);
    expect(reading.flights).toHaveLength(2);
    expect(reading.stopped?.reason).toMatch(/checksum/);
    expect(reading.unfinished?.reason).toMatch(/stopped while the aircraft was armed/);
  });

  it('stops cleanly wherever the log is cut, and keeps only whole flights', async () => {
    const { bytes, flightOneEnds } = twoFlights();
    for (const cut of [0, 4, 9, 30, flightOneEnds - 1, flightOneEnds, flightOneEnds + 12, bytes.byteLength - 2]) {
      const reading = await readTlog(chunks(bytes.subarray(0, cut), 5));
      expect(reading.flights, `cut at ${cut}`).toHaveLength(cut >= flightOneEnds ? 1 : 0);
      if (cut !== flightOneEnds) expect(reading.stopped, `cut at ${cut}`).toBeDefined();
    }
  });
});
