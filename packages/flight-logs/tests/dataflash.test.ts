import { describe, expect, it } from 'vitest';
import { formatOf, gpsWeekToUtc, readDataflash } from '../src/index.js';
import { arduPilot, arduPilotDefinitions, chunks, DataflashWriter, gpsTimeOf, QUARRY, RIDGE } from './encoders.js';

const S = 1_000_000;
const UTC = Date.UTC(2026, 10, 10, 16, 5, 0);
const EV = { armed: 10, disarmed: 11, landComplete: 18, notLanded: 28 };

function twoFlights(): { bytes: Uint8Array; flightOneEnds: number } {
  const log = arduPilotDefinitions(new DataflashWriter());
  arduPilot.parameter(log, 1 * S);
  arduPilot.gps(log, 5 * S, gpsTimeOf(UTC + 5000), RIDGE);
  arduPilot.event(log, 10 * S, EV.armed);
  arduPilot.arm(log, 10 * S, true);
  arduPilot.position(log, 11 * S, RIDGE, 1850, 0);
  arduPilot.event(log, 12 * S, EV.notLanded);
  arduPilot.position(log, 30 * S, RIDGE, 1895, 45.2);
  arduPilot.event(log, 70 * S, EV.landComplete);
  arduPilot.event(log, 72 * S, EV.disarmed);
  arduPilot.arm(log, 72 * S, false);
  const flightOneEnds = log.length;
  arduPilot.arm(log, 100 * S, true);
  arduPilot.position(log, 101 * S, RIDGE, 1850, 0);
  arduPilot.event(log, 102 * S, EV.notLanded);
  arduPilot.position(log, 150 * S, QUARRY, 1910, 60);
  arduPilot.event(log, 200 * S, EV.landComplete);
  arduPilot.arm(log, 203 * S, false);
  return { bytes: log.done(), flightOneEnds };
}

describe('DataFlash reader', () => {
  it('is told from its first format message', () => {
    expect(formatOf(twoFlights().bytes.subarray(0, 16))).toBe('dataflash');
  });

  it('turns GPS week time into UTC with the leap seconds of the day', () => {
    expect(gpsWeekToUtc(gpsTimeOf(UTC).week, gpsTimeOf(UTC).milliseconds)).toBe(UTC);
    expect(gpsWeekToUtc(0, 0)).toBeUndefined();
  });

  it('reads two flights from the land events, with heights above home as the log states them', async () => {
    const reading = await readDataflash(chunks(twoFlights().bytes, 50));
    expect(reading.stopped).toBeUndefined();
    expect(reading.vehicle).toBeUndefined();
    expect(reading.absoluteTime).toMatch(/GPS.GWk and GPS.GMS/);
    expect(reading.flights).toHaveLength(2);
    expect(reading.flights[0]).toMatchObject({
      rule: 'takeoff_to_landing',
      takeoffAt: '2026-11-10T16:05:12Z',
      landingAt: '2026-11-10T16:06:10Z',
      takeoffPlace: RIDGE,
      greatestHeight: { meters: 45.2, reference: 'above home, as the log states it (POS.RelHomeAlt)' },
      greatestAltitude: { meters: 1895 },
    });
    expect(reading.flights[1]).toMatchObject({ landingPlaces: [QUARRY], greatestHeight: { meters: 60 } });
  });

  it('reads the receiver’s position and time when the log has no estimated position', async () => {
    const log = arduPilotDefinitions(new DataflashWriter());
    arduPilot.event(log, 10 * S, EV.armed);
    arduPilot.gps(log, 11 * S, gpsTimeOf(UTC), RIDGE, 1);
    arduPilot.event(log, 12 * S, EV.notLanded);
    arduPilot.gps(log, 13 * S, gpsTimeOf(UTC + 2000), QUARRY);
    arduPilot.event(log, 20 * S, EV.landComplete);
    arduPilot.event(log, 21 * S, EV.disarmed);
    const [flight] = (await readDataflash([log.done()])).flights;
    expect(flight).toMatchObject({ takeoffAt: '2026-11-10T16:05:01Z', takeoffPlace: QUARRY });
    expect(flight!.greatestAltitude?.reference).toMatch(/GPS.Alt/);
  });

  it('gives no time of day when no GPS sample has a fix, and says so', async () => {
    const log = arduPilotDefinitions(new DataflashWriter());
    arduPilot.gps(log, 5 * S, gpsTimeOf(UTC), RIDGE, 1);
    arduPilot.arm(log, 10 * S, true);
    arduPilot.arm(log, 70 * S, false);
    const reading = await readDataflash([log.done()]);
    expect(reading.flights[0]).toMatchObject({ rule: 'arming_to_disarming', durationSeconds: 60 });
    expect(reading.flights[0]).not.toHaveProperty('takeoffAt');
    expect(reading.notes.join(' ')).toMatch(/no absolute time/);
  });

  it('reads the older millisecond clock', async () => {
    const log = new DataflashWriter().describe(130, 'EV', 'IB', 'TimeMS,Id');
    log.message('EV', (bytes) => bytes.u32(10_000).u8(EV.armed));
    log.message('EV', (bytes) => bytes.u32(25_000).u8(EV.disarmed));
    expect((await readDataflash([log.done()])).flights[0]!.durationSeconds).toBe(15);
  });

  it('stops cleanly at a damaged byte or a type no format described', async () => {
    const { bytes, flightOneEnds } = twoFlights();
    const damaged = bytes.slice();
    damaged[flightOneEnds] = 0x00;
    const reading = await readDataflash([damaged]);
    expect(reading.flights).toHaveLength(1);
    expect(reading.stopped).toEqual({ offset: flightOneEnds, reason: expect.stringMatching(/damaged/) });
    damaged[flightOneEnds] = 0xa3;
    damaged[flightOneEnds + 2] = 200;
    expect((await readDataflash([damaged])).stopped?.reason).toMatch(/type \(200\) no format message/);
  });

  it('stops cleanly wherever the log is cut, and keeps only whole flights', async () => {
    const { bytes, flightOneEnds } = twoFlights();
    for (const cut of [
      0,
      2,
      50,
      89 * 3 + 4,
      flightOneEnds - 18 - 3,
      flightOneEnds,
      flightOneEnds + 20,
      bytes.byteLength - 1,
    ]) {
      const reading = await readDataflash(chunks(bytes.subarray(0, cut), 11));
      expect(reading.flights, `cut at ${cut}`).toHaveLength(cut >= flightOneEnds ? 1 : 0);
      if (cut !== flightOneEnds) expect(reading.stopped, `cut at ${cut}`).toBeDefined();
      if (cut > flightOneEnds) expect(reading.unfinished).toBeDefined();
    }
  });
});
