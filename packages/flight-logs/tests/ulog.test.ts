import { describe, expect, it } from 'vitest';
import { formatOf, readUlog } from '../src/index.js';
import { chunks, px4, px4Definitions, QUARRY, RIDGE, UlogWriter } from './encoders.js';

const S = 1_000_000;
const UTC = Date.UTC(2026, 10, 10, 16, 5, 0) * 1000;

/** Two flights: ridge pad to ridge pad, then ridge pad to the quarry gate, with GPS time from the start. */
function twoFlights(): { bytes: Uint8Array; flightOneEnds: number; flightTwoAt: number } {
  const log = px4Definitions(new UlogWriter());
  px4.gps(log, 5 * S, UTC + 5 * S, RIDGE);
  px4.landed(log, 6 * S, true);
  px4.status(log, 10 * S, true);
  px4.global(log, 11 * S, RIDGE, 1850);
  px4.landed(log, 12 * S, false);
  px4.global(log, 13 * S, RIDGE, 1880.4);
  px4.global(log, 40 * S, RIDGE, 1851);
  px4.landed(log, 70 * S, true);
  px4.status(log, 72 * S, false);
  const flightOneEnds = log.length;
  log.logged('Disarmed by auto preflight disarming');
  const flightTwoAt = log.length;
  px4.status(log, 100 * S, true);
  px4.global(log, 101 * S, RIDGE, 1850);
  px4.landed(log, 102 * S, false);
  px4.global(log, 150 * S, QUARRY, 1900);
  px4.landed(log, 200 * S, true);
  px4.global(log, 201 * S, QUARRY, 1830);
  px4.status(log, 203 * S, false);
  return { bytes: log.done(), flightOneEnds, flightTwoAt };
}

describe('ULog reader', () => {
  it('is told from the file header', () => {
    expect(formatOf(twoFlights().bytes.subarray(0, 16))).toBe('ulog');
  });

  it('reads two flights from takeoff to landing, with UTC from the GPS receiver', async () => {
    const reading = await readUlog(chunks(twoFlights().bytes));
    expect(reading.stopped).toBeUndefined();
    expect(reading.unfinished).toBeUndefined();
    expect(reading.vehicle).toEqual({ identifier: 'EXAMPLE-RIDGE-0001', from: 'the ULog information field sys_uuid' });
    expect(reading.absoluteTime).toMatch(/sensor_gps.time_utc_usec/);
    expect(reading.flights).toHaveLength(2);
    const [first, second] = reading.flights;
    expect(first).toMatchObject({
      number: 1,
      rule: 'takeoff_to_landing',
      takeoffAt: '2026-11-10T16:05:12Z',
      landingAt: '2026-11-10T16:06:10Z',
      durationSeconds: 58,
      takeoffPlace: RIDGE,
      landingPlaces: [RIDGE],
      greatestHeight: { meters: 30.4 },
      greatestAltitude: { meters: 1880.4 },
    });
    expect(first!.greatestHeight!.reference).toMatch(/^above the takeoff point/);
    expect(second).toMatchObject({
      takeoffAt: '2026-11-10T16:06:42Z',
      landingAt: '2026-11-10T16:08:20Z',
      landingPlaces: [QUARRY],
      greatestHeight: { meters: 50 },
    });
  });

  it('prefers the estimator’s position and reads the GPS receiver when the log has only that', async () => {
    const log = px4Definitions(new UlogWriter(), false);
    px4.oldGps(log, 5 * S, UTC, RIDGE);
    px4.status(log, 10 * S, true);
    px4.landed(log, 11 * S, false);
    px4.oldGps(log, 12 * S, UTC + 7 * S, QUARRY);
    px4.landed(log, 20 * S, true);
    px4.status(log, 21 * S, false);
    const [flight] = (await readUlog([log.done()])).flights;
    expect(flight!.takeoffAt).toBe('2026-11-10T16:05:06Z');
    expect(flight!.takeoffPlace).toEqual({ latitude: QUARRY.latitude, longitude: QUARRY.longitude });
    expect(flight!.greatestAltitude?.reference).toMatch(/vehicle_gps_position/);
  });

  it('gives no time of day when the log holds no absolute time, and says so', async () => {
    const log = px4Definitions(new UlogWriter());
    px4.status(log, 10 * S, true);
    px4.landed(log, 12 * S, false);
    px4.landed(log, 40 * S, true);
    px4.status(log, 41 * S, false);
    const reading = await readUlog([log.done()]);
    expect(reading.absoluteTime).toBeUndefined();
    expect(reading.flights[0]).not.toHaveProperty('takeoffAt');
    expect(reading.flights[0]!.durationSeconds).toBe(28);
    expect(reading.notes.join(' ')).toMatch(/no absolute time/);
    expect(reading.flights[0]!.notRead.join(' ')).toMatch(/no position/);
  });

  it('runs a flight from arming to disarming when the log has no land detector', async () => {
    const log = new UlogWriter()
      .format('vehicle_status:uint64_t timestamp;uint8_t nav_state;uint8_t arming_state;')
      .subscribe('vehicle_status');
    px4.status(log, 10 * S, true);
    px4.status(log, 30 * S, false);
    const reading = await readUlog([log.done()]);
    expect(reading.flights[0]).toMatchObject({ rule: 'arming_to_disarming', durationSeconds: 20 });
    expect(reading.notes.join(' ')).toMatch(/no land detector/);
  });

  it('does not count arming without leaving the ground as a flight', async () => {
    const log = px4Definitions(new UlogWriter());
    px4.landed(log, 5 * S, true);
    px4.status(log, 10 * S, true);
    px4.status(log, 15 * S, false);
    const reading = await readUlog([log.done()]);
    expect(reading.flights).toEqual([]);
    expect(reading.notes.join(' ')).toMatch(/Once the aircraft was armed and disarmed without leaving the ground/);
  });

  it('skips messages it does not use and a second instance of a topic', async () => {
    const log = px4Definitions(new UlogWriter());
    log.subscribe('vehicle_status', 1).logged('Takeoff detected');
    px4.status(log, 10 * S, true);
    log.data(
      'vehicle_status',
      (bytes) =>
        bytes
          .u64(11 * S)
          .u8(4)
          .u8(1),
      1,
    );
    px4.status(log, 20 * S, false);
    expect((await readUlog([log.done()])).flights).toHaveLength(1);
  });

  it('refuses a log with an incompatible feature it does not know', async () => {
    const log = new UlogWriter().flags([0b10]);
    const reading = await readUlog([log.done()]);
    expect(reading.stopped?.reason).toMatch(/later ULog version/);
  });

  it('reads on from appended data when a message is cut where it begins', async () => {
    const log = px4Definitions(new UlogWriter());
    px4.status(log, 10 * S, true);
    px4.status(log, 20 * S, false);
    const bytes = log.done();
    // The flag bits message is the first after the header: set DATA_APPENDED and the offset where appended data starts.
    const cutAt = bytes.byteLength - 5;
    const appended = new UlogWriter();
    px4.status(appended, 30 * S, true);
    const tail = appended.done().subarray(16);
    const withAppended = new Uint8Array(cutAt + tail.byteLength);
    withAppended.set(bytes.subarray(0, cutAt));
    withAppended.set(tail, cutAt);
    const view = new DataView(withAppended.buffer);
    view.setUint8(16 + 3 + 8, 1);
    view.setBigUint64(16 + 3 + 16, BigInt(cutAt), true);
    // The last disarm is cut off, so the appended data's sample would otherwise be read as part of it.
    const reading = await readUlog([withAppended]);
    expect(reading.stopped).toBeUndefined();
    expect(reading.notes.join(' ')).toMatch(/appended/);
  });

  it('stops cleanly at a damaged byte and keeps the flights before it', async () => {
    const { bytes, flightTwoAt } = twoFlights();
    const damaged = bytes.slice();
    damaged[flightTwoAt + 2] = 0x00;
    const reading = await readUlog([damaged]);
    expect(reading.flights).toHaveLength(1);
    expect(reading.stopped).toEqual({ offset: flightTwoAt, reason: expect.stringMatching(/damaged/) });
  });

  it('stops cleanly wherever the log is cut, and keeps only whole flights', async () => {
    const { bytes, flightOneEnds, flightTwoAt } = twoFlights();
    for (const cut of [0, 5, 16, 40, flightOneEnds - 1, flightOneEnds, flightTwoAt + 30, bytes.byteLength - 1]) {
      const reading = await readUlog(chunks(bytes.subarray(0, cut), 13));
      const whole = cut >= flightOneEnds ? 1 : 0;
      expect(reading.flights, `cut at ${cut}`).toHaveLength(whole);
      expect(reading.bytesRead).toBeLessThanOrEqual(cut);
      if (cut > 16 && cut !== flightOneEnds)
        expect(reading.stopped?.reason, `cut at ${cut}`).toMatch(/ends part-way|header/);
      if (cut >= flightTwoAt + 30) expect(reading.unfinished?.reason).toMatch(/armed/);
    }
  });
});
