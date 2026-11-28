import { flightRecordV1, parseRecordFile, recordCsvTemplate } from '@ledger/contracts';
import { describe, expect, it } from 'vitest';
import { flightRecordCsv, formatOf, GUTMA_MAX_BYTES, readGutma, readingLines, readLog } from '../src/index.js';
import { chunks, gutmaEvent as event, gutmaMessage as message, gutmaSample as at, QUARRY, RIDGE } from './encoders.js';

const bytesOf = (document: unknown, indent?: number) =>
  new TextEncoder().encode(JSON.stringify(document, null, indent));
const read = (document: unknown) => readGutma([bytesOf(document)]);
const without = (key: string) => ({ [key]: undefined });

describe('GUTMA flight log reader', () => {
  it('is told from the file’s content, compact or indented, and other JSON is not taken for one', () => {
    expect(formatOf(bytesOf(message()).subarray(0, 64))).toBe('gutma');
    expect(formatOf(bytesOf(message(), 4).subarray(0, 64))).toBe('gutma');
    expect(formatOf(new TextEncoder().encode(`﻿\r\n${JSON.stringify(message())}`).subarray(0, 64))).toBe('gutma');
    expect(formatOf(bytesOf({ type: 'FeatureCollection', features: [] }))).toBeUndefined();
    expect(formatOf(bytesOf([{ exchange: {} }]))).toBeUndefined();
    expect(formatOf(new TextEncoder().encode('exchange, flight_logging'))).toBeUndefined();
  });

  it('reads a complete log: the events’ times and places, the altitude with its datum, the aircraft for a person', async () => {
    const bytes = bytesOf(message(), 2);
    const reading = await readLog('gutma', chunks(bytes));
    expect(reading).toMatchObject({ format: 'gutma', formatName: 'GUTMA flight log', bytesRead: bytes.byteLength });
    expect(reading.stopped).toBeUndefined();
    expect(reading.unfinished).toBeUndefined();
    expect(reading.absoluteTime).toMatch(/^logging_start_dtg/);
    expect(reading.vehicle).toEqual({ identifier: 'EXAMPLE-RIDGE-0001', from: 'flight_data.aircraft.serial_number' });
    expect(reading.flights).toEqual([
      {
        number: 1,
        rule: 'takeoff_event_to_landing_event',
        takeoffAt: '2026-11-10T16:05:12Z',
        landingAt: '2026-11-10T16:06:58Z',
        durationSeconds: 106,
        takeoffPlace: RIDGE,
        landingPlaces: [QUARRY],
        greatestAltitude: {
          meters: 1890.4,
          reference: 'MSL (above mean sea level), the altitude system the log names for gps_altitude',
        },
        bytes: { offset: 0, length: bytes.byteLength },
        notRead: [],
      },
    ]);
    const notes = reading.notes.join('\n');
    expect(notes).toContain(
      'The log describes the aircraft (flight_data.aircraft): manufacturer Example Aero, model EX-4, name Ridge survey one, serial number EXAMPLE-RIDGE-0001, firmware 2.01b, hardware 1.00B.',
    );
    expect(notes).toContain('no id column is filled from it');
    expect(notes).toContain('checked against no product’s real export');
  });

  it('lists every key it did not read, and every event that is no take-off or landing', async () => {
    const document = message({ wind_estimate: 3 }, { operator_note: 'none' });
    Object.assign(document.exchange.message.flight_data.aircraft, { colour: 'orange' });
    const notes = (await read(document)).notes;
    expect(notes).toContain('Sample keys not read: speed, battery_voltage.');
    expect(notes).toContain(
      'Other keys not read: message.operator_note, flight_data.gcs, flight_data.payload, flight_data.project, flight_data.aircraft.colour, flight_logging.tick_increment_modulo, flight_logging.tick_increment_seconds, flight_logging.wind_estimate, file.logging_type, file.filename, file.creation_dtg, event.event_type.',
    );
    expect(notes.join('\n')).toMatch(/^Events not read: GPS_LOST \(1\)\. This reader reads take-off events/m);
  });

  it('writes no time when the log states no start, or states one with no time zone, and says why', async () => {
    const none = await read(message(without('logging_start_dtg')));
    expect(none.absoluteTime).toBeUndefined();
    expect(none.flights[0]).toMatchObject({ durationSeconds: 106, takeoffPlace: RIDGE });
    expect(none.flights[0]).not.toHaveProperty('takeoffAt');
    expect(none.flights[0]).not.toHaveProperty('landingAt');
    expect(none.notes.join('\n')).toMatch(
      /states no start of logging \(logging_start_dtg\), so no takeoff or landing time/,
    );

    const local = await read(message({ logging_start_dtg: '2026-11-10T09:05:00' }));
    expect(local.flights[0]).not.toHaveProperty('takeoffAt');
    expect(local.notes.join('\n')).toMatch(/“2026-11-10T09:05:00”\) names no time zone/);

    const wrong = await read(message({ logging_start_dtg: '10 November 2026, 9:05' }));
    expect(wrong.flights[0]).not.toHaveProperty('takeoffAt');
    expect(wrong.notes.join('\n')).toMatch(/is not a date and time as the format's description writes one/);
    const impossible = await read(message({ logging_start_dtg: '2026-02-30T09:05:00Z' }));
    expect(impossible.flights[0]).not.toHaveProperty('takeoffAt');
  });

  it('reads a start of logging with an offset as the UTC instant it names', async () => {
    const offset = await read(message({ logging_start_dtg: '2026-11-10T09:05:00.250-07:00' }));
    expect(offset.flights[0]).toMatchObject({ takeoffAt: '2026-11-10T16:05:12Z', landingAt: '2026-11-10T16:06:58Z' });
    const east = await read(message({ logging_start_dtg: '2026-11-10T21:35:00+0530' }));
    expect(east.flights[0]!.takeoffAt).toBe('2026-11-10T16:05:12Z');
  });

  it('with no take-off or landing event, takes the flight as the description gives it, and says so', async () => {
    const reading = await read(message({ event: [event('GPS_LOST', 50)] }));
    expect(reading.flights).toHaveLength(1);
    const [flight] = reading.flights;
    expect(flight).toMatchObject({
      rule: 'logging_start_to_last_sample',
      takeoffAt: '2026-11-10T16:05:00Z',
      landingAt: '2026-11-10T16:07:05Z',
      durationSeconds: 125,
      takeoffPlace: RIDGE,
      landingPlaces: [QUARRY],
    });
    expect(flight!.notRead.join('\n')).toMatch(/records no take-off event for this flight/);
    expect(flight!.notRead.join('\n')).toMatch(
      /records no landing event: the landing time and place are the last sample’s/,
    );
    expect((await read(message(without('event')))).flights[0]!.rule).toBe('logging_start_to_last_sample');
  });

  it('uses the event the log does record and the description’s rule for the other end', async () => {
    const takeoffOnly = await read(message({ event: [event('take off', 12)] }));
    expect(takeoffOnly.flights[0]).toMatchObject({
      rule: 'takeoff_event_to_last_sample',
      takeoffAt: '2026-11-10T16:05:12Z',
      durationSeconds: 113,
    });
    expect(takeoffOnly.flights[0]!.notRead).toHaveLength(1);
    expect(takeoffOnly.flights[0]!.notRead[0]).toMatch(/records no landing event/);

    const landingOnly = await read(message({ event: [event('LANDED', 118)] }));
    expect(landingOnly.flights[0]).toMatchObject({
      rule: 'logging_start_to_landing_event',
      takeoffAt: '2026-11-10T16:05:00Z',
      landingAt: '2026-11-10T16:06:58Z',
    });
    expect(landingOnly.flights[0]!.notRead[0]).toMatch(/records no take-off event/);
  });

  it('reads two flights when the log records two take-offs and two landings', async () => {
    const reading = await read(
      message({
        flight_logging_items: [
          at(5, RIDGE, 1850),
          at(30, RIDGE, 1880),
          at(60, QUARRY, 1831),
          at(100, QUARRY, 1830),
          at(140, RIDGE, 1905),
          at(180, RIDGE, 1850),
        ],
        event: [event('TAKE_OFF', 10), event('LANDING', 60), event('TAKE_OFF', 100), event('LANDING', 180)],
      }),
    );
    expect(reading.flights.map((flight) => [flight.number, flight.rule, flight.durationSeconds])).toEqual([
      [1, 'takeoff_event_to_landing_event', 50],
      [2, 'takeoff_event_to_landing_event', 80],
    ]);
    const [first, second] = reading.flights;
    expect(first).toMatchObject({ takeoffPlace: RIDGE, landingPlaces: [QUARRY], greatestAltitude: { meters: 1880 } });
    expect(second).toMatchObject({
      takeoffAt: '2026-11-10T16:06:40Z',
      takeoffPlace: QUARRY,
      landingPlaces: [RIDGE],
      greatestAltitude: { meters: 1905 },
    });
    expect(reading.notes).toContain('A GUTMA log is one JSON document, so each flight’s bytes are the whole file.');
  });

  it('never invents a landing: a take-off with none after it, in a log that records landings, is not written', async () => {
    const reading = await read(
      message({ event: [event('TAKE_OFF', 12), event('LANDING', 40), event('TAKE_OFF', 90)] }),
    );
    expect(reading.flights).toHaveLength(1);
    expect(reading.unfinished).toEqual({
      startedSecondsIntoLog: 90,
      reason: 'the log records landings as events and records none after this take-off',
    });
    const again = await read(message({ event: [event('TAKE_OFF', 12), event('TAKE_OFF', 30), event('LANDING', 118)] }));
    expect(again.flights).toHaveLength(1);
    expect(again.flights[0]!.notRead[0]).toMatch(/another take-off 30 s into the log with no landing before it/);
    const twice = await read(message({ event: [event('TAKE_OFF', 12), event('LANDING', 90), event('LANDING', 118)] }));
    expect(twice.flights).toHaveLength(1);
    expect(twice.notes.join('\n')).toMatch(/a landing 118 s into the log with no take-off since the landing before it/);
  });

  it('writes an altitude with the datum the log names, and as height above the ground only when the log says AGL', async () => {
    const [msl] = (await read(message({ altitude_system: 'MSL' }))).flights;
    expect(msl!.greatestAltitude!.reference).toMatch(/^MSL \(above mean sea level\)/);
    expect(msl).not.toHaveProperty('greatestHeight');

    const [wgs84] = (await read(message({ altitude_system: 'WGS84' }))).flights;
    expect(wgs84!.greatestAltitude).toEqual({
      meters: 1890.4,
      reference: 'WGS84, the altitude system the log names for gps_altitude',
    });
    expect(wgs84).not.toHaveProperty('greatestHeight');

    const agl = await read(
      message({
        altitude_system: 'AGL',
        flight_logging_items: [at(12, RIDGE, 0), at(40, RIDGE, 61.26), at(118, QUARRY, 0.3)],
      }),
    );
    expect(agl.flights[0]!.greatestHeight).toEqual({
      meters: 61.3,
      reference: 'AGL (above ground level), the altitude system the log names for gps_altitude',
      aboveGround: true,
    });
    expect(agl.flights[0]).not.toHaveProperty('greatestAltitude');
  });

  it('writes no height when the log names no altitude system, one the description does not document, or other units', async () => {
    const none = await read(message(without('altitude_system')));
    expect(none.flights[0]).not.toHaveProperty('greatestAltitude');
    expect(none.flights[0]).not.toHaveProperty('greatestHeight');
    expect(none.notes.join('\n')).toMatch(/names no altitude system \(altitude_system\), so gps_altitude was not read/);

    const other = await read(message({ altitude_system: 'BARO' }));
    expect(other.flights[0]).not.toHaveProperty('greatestAltitude');
    expect(other.notes.join('\n')).toMatch(
      /names its altitude system “BARO”\. The format's description documents AGL, MSL and WGS84 only/,
    );

    const feet = await read(message({ uom_system: 'Imperial' }));
    expect(feet.flights[0]).not.toHaveProperty('greatestAltitude');
    expect(feet.flights[0]).toMatchObject({ takeoffPlace: RIDGE });
    expect(feet.notes.join('\n')).toMatch(/states its units as “Imperial” \(uom_system\)/);
  });

  it('finds latitude and longitude by their keys whatever their order, and skips rows it cannot read', async () => {
    const reading = await read(
      message({
        flight_logging_keys: ['gps_lat', 'gps_lon', 'timestamp', 'gps_altitude'],
        flight_logging_items: [
          [QUARRY.latitude, QUARRY.longitude, 118, 1830],
          [RIDGE.latitude, RIDGE.longitude, 12, 1850],
          [RIDGE.latitude, RIDGE.longitude, 40],
          [RIDGE.latitude, RIDGE.longitude, 'soon', 1850],
          'not a row',
          [0, 0, 60, 1900],
        ],
      }),
    );
    expect(reading.flights[0]).toMatchObject({
      takeoffPlace: RIDGE,
      landingPlaces: [QUARRY],
      greatestAltitude: { meters: 1900 },
    });
    expect(reading.notes.join('\n')).toMatch(/^3 sample rows of 6 could not be read/m);
    expect(reading.notes).toContain(
      'The samples are not in order of time in the file; they were read in order of time.',
    );
  });

  it('does not take a clock the description does not document for seconds since the start of logging', async () => {
    const epoch = Date.UTC(2026, 10, 10, 16, 5, 0);
    const reading = await read(
      message({
        flight_logging_items: [at(epoch, RIDGE, 1850), at(epoch + 60_000, QUARRY, 1890)],
        event: [event('TAKE_OFF', epoch), event('LANDING', String(epoch + 60_000))],
      }),
    );
    expect(reading.flights).toEqual([]);
    expect(reading.notes.join('\n')).toMatch(/^2 sample rows of 2 could not be read/m);
    expect(reading.notes.join('\n')).toMatch(/^2 take-off or landing events had no event_timestamp of 0 to 30 days/m);
  });

  it('says when a flight has no position, and when the log has no sample', async () => {
    const noPlace = await read(
      message({ flight_logging_keys: ['timestamp'], flight_logging_items: [[1], [50], [125]] }),
    );
    expect(noPlace.flights[0]).toMatchObject({ landingPlaces: [], durationSeconds: 106 });
    expect(noPlace.flights[0]).not.toHaveProperty('takeoffPlace');
    expect(noPlace.flights[0]!.notRead).toContain(
      'The log holds no position during this flight: no takeoff or landing place.',
    );
    const empty = await read(message({ flight_logging_items: [], event: [] }));
    expect(empty.flights).toEqual([]);
    expect(empty.notes.join('\n')).toMatch(/records no take-off or landing event and holds no sample after its start/);
  });

  it('refuses a file that is not JSON, is another message, or follows a later version, with a sentence saying which', async () => {
    const reason = async (bytes: Uint8Array) => {
      const reading = await readGutma([bytes]);
      expect(reading.flights).toEqual([]);
      expect(reading.stopped?.offset).toBe(0);
      return reading.stopped!.reason;
    };
    const whole = JSON.stringify(message());
    expect(await reason(new TextEncoder().encode(whole.slice(0, whole.length / 2)))).toBe(
      'The file is not valid JSON, so it was not read.',
    );
    expect(await reason(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]))).toBe(
      'The file is not valid JSON, so it was not read.',
    );
    expect(await reason(bytesOf({ type: 'FeatureCollection', features: [] }))).toMatch(
      /is JSON but not a flight logging message: it has no “exchange” object/,
    );
    expect(await reason(bytesOf([1, 2, 3]))).toMatch(/not a flight logging message/);
    expect(await reason(bytesOf({ exchange: { exchange_type: 'flight_declaration', message: {} } }))).toMatch(
      /a different kind of message: its exchange_type is “flight_declaration”, not “flight_logging”/,
    );
    expect(await reason(bytesOf(message({}, { message_type: 'flight_logging_request' })))).toMatch(
      /a different message type: its message_type is “flight_logging_request”, not “flight_logging_submission”/,
    );
    expect(await reason(bytesOf(message({}, { file: { version: '2.0.0' } })))).toMatch(
      /follows version “2\.0\.0” of the protocol \(file\.version\)\. This reader was built from version 1\.0\.0/,
    );
    expect(await reason(bytesOf(message({}, without('flight_logging'))))).toMatch(/holds no flight_logging section/);
    expect(await reason(bytesOf(message({ flight_logging_keys: 'timestamp' })))).toMatch(
      /flight_logging_keys is not a list of names/,
    );
    expect(await reason(bytesOf(message({ flight_logging_keys: ['gps_lat', 'gps_lon'] })))).toMatch(
      /have no timestamp key/,
    );
    expect(await reason(bytesOf(message({ flight_logging_items: {} })))).toMatch(
      /flight_logging_items is not a list of rows/,
    );
  });

  it('refuses a file larger than its bound without holding it', async () => {
    const megabyte = new Uint8Array(1024 * 1024).fill(0x20);
    let given = 0;
    function* oversized() {
      while (true) {
        given += megabyte.byteLength;
        yield megabyte;
      }
    }
    const reading = await readGutma(oversized());
    expect(reading.flights).toEqual([]);
    expect(reading.stopped).toEqual({
      offset: 0,
      reason:
        'The file is larger than 10 MB, the most this reader reads at once and the most Ledger keeps as an original, so it was not read.',
    });
    expect(given).toBe(GUTMA_MAX_BYTES + megabyte.byteLength);
  });

  it('writes the same CSV columns as the other readers, and the height above the ground only from an AGL log', async () => {
    const log = { name: 'RIDGE-AC-1-2026-11-10.json', sha256: 'b'.repeat(64) };
    const msl = await read(message());
    const csv = flightRecordCsv(msl, log);
    expect(csv.split('\r\n')[0]).toBe(recordCsvTemplate(flightRecordV1).trimEnd());
    const row = parseRecordFile(new TextEncoder().encode(csv), 'csv').rows[0]!.cells;
    expect(row).toMatchObject({
      subjectId: '',
      secondarySubjectId: '',
      takeoffAt: '2026-11-10T16:05:12Z',
      landingAt: '2026-11-10T16:06:58Z',
      takeoffLocation: '39.5012345, -105.2034567',
      landingLocations: '39.5141000, -105.1873000',
      maxHeightFlownAboveGroundMeters: '',
      heightNotes:
        'Greatest altitude 1890.4 m MSL (above mean sea level), the altitude system the log names for gps_altitude. The log does not hold the height above the ground.',
    });
    expect(row.flightPathReference).toMatch(/^RIDGE-AC-1-2026-11-10\.json \(sha256 b{64}\), flight 1, bytes 0 to \d+$/);

    const agl = await read(
      message({ altitude_system: 'AGL', flight_logging_items: [at(12, RIDGE, 0), at(118, RIDGE, 61)] }),
    );
    const aglRow = parseRecordFile(new TextEncoder().encode(flightRecordCsv(agl, log)), 'csv').rows[0]!.cells;
    expect(aglRow).toMatchObject({
      maxHeightFlownAboveGroundMeters: '61',
      heightNotes: 'Greatest height 61 m AGL (above ground level), the altitude system the log names for gps_altitude.',
    });

    const lines = readingLines(msl, log.name).join('\n');
    expect(lines).toMatch(/^RIDGE-AC-1-2026-11-10\.json: GUTMA flight log, \d+ bytes read\. 1 whole flight\./);
    expect(lines).toContain('Times are UTC, from logging_start_dtg');
    expect(lines).toContain(
      'The log names the vehicle EXAMPLE-RIDGE-0001 (flight_data.aircraft.serial_number); it is not your own id for the aircraft.',
    );
    expect(lines).toContain('Flight 1, from the log’s take-off event to its landing event:');
  });
});
