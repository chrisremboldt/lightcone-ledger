import { flightRecordV1, parseRecordFile, recordCsvTemplate } from '@ledger/contracts';
import { describe, expect, it } from 'vitest';
import { crc64Jones } from '../src/dji.js';
import { DJI_MAX_BYTES, flightRecordCsv, formatOf, readDji, readingLines, readLog } from '../src/index.js';
import {
  chunks,
  concat,
  DJI_START,
  djiFile,
  djiFlight,
  djiFrame as frame,
  djiRecord as record,
  djiState,
  djiTime,
  QUARRY,
  RIDGE,
} from './encoders.js';

const read = (bytes: Uint8Array) => readDji([bytes]);
const HEIGHT = { meters: 44.8, reference: 'above the takeoff point, the reference the app records height from' };
/** The whole flight of `djiFlight`, as every version that needs no key should give it. */
const FLOWN = {
  number: 1,
  rule: 'first_in_air_to_last_on_ground',
  takeoffAt: '2026-11-10T16:05:12Z',
  landingAt: '2026-11-10T16:06:58Z',
  durationSeconds: 106,
  takeoffPlace: RIDGE,
  landingPlaces: [QUARRY],
  greatestHeight: HEIGHT,
  notRead: [],
};
/** A small picture as a camera writes one: a segment holding a thumbnail's own end mark, then stuffed scan data. */
const JPEG = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe1, 0x00, 0x06, 0xff, 0xd9, 0x01, 0x02, 0xff, 0xda, 0x00, 0x04, 0x01, 0x02, 0x11, 0xff, 0x00,
  0x22, 0xff, 0xd0, 0x33, 0xff, 0xd9,
]);
const MARKER = Uint8Array.from([0x39, 0x30, 0x00, 0x00]);

describe('DJI flight record reader', () => {
  it('computes the checksum the scrambling uses as its published check value says', () => {
    expect(crc64Jones(0n, new TextEncoder().encode('123456789'))).toBe(0xe9c6d914c4b8d9can);
  });

  it('is told from the file’s first bytes in every version, and text or another log is not taken for one', () => {
    for (const version of [1, 3, 6, 8, 12, 13, 14, 15])
      expect(formatOf(djiFile(version, djiFlight(version)).subarray(0, 1024)), `version ${version}`).toBe('dji');
    expect(formatOf(new TextEncoder().encode('DJIFlightRecord_2026-11-10_[09-05-12].txt'))).toBeUndefined();
    expect(formatOf(new Uint8Array(200))).toBeUndefined();
    const noVersion = djiFile(8, []);
    noVersion[10] = 0;
    expect(formatOf(noVersion)).toBeUndefined();
  });

  it.each([3, 6, 8, 11, 12])(
    'reads a version %i file whole: the header, the flight’s times, places and height',
    async (version) => {
      const bytes = djiFile(version, djiFlight(version));
      const reading = await readLog('dji', chunks(bytes, 97));
      expect(reading).toMatchObject({ format: 'dji', formatName: 'DJI flight record', bytesRead: bytes.byteLength });
      expect(reading.stopped).toBeUndefined();
      expect(reading.unfinished).toBeUndefined();
      expect(reading.absoluteTime).toMatch(/^the time the app wrote in its own records \(type 5\)/);
      expect(reading.vehicle?.identifier).toBe('EXAMPLE001');
      expect(reading.flights).toHaveLength(1);
      expect(reading.flights[0]).toMatchObject(FLOWN);
      // From the record that first says in the air to the end of the one that says on the ground again.
      const firstRecord = version < 6 ? 12 : version === 12 ? 536 : 100;
      const frameBytes = concat(...frame(version, 0, RIDGE, 0, { inAir: false })).byteLength;
      expect(reading.flights[0]!.bytes).toEqual({
        offset: firstRecord + 2 * frameBytes,
        length: 3 * frameBytes + record(version, 1, djiState(RIDGE, 0, { inAir: false })).byteLength,
      });
      const notes = reading.notes.join('\n');
      expect(notes).toContain(
        `The file is version ${version} of the DJI flight record format, whose records are ${version < 7 ? 'stored plainly' : 'scrambled with a key that is in the file itself; no key from outside is needed'}.`,
      );
      expect(notes).toContain(
        'The file’s header gives the aircraft’s name “Ridge survey one” and its serial number “EXAMPLE001”, as the app recorded them, and the start of the log, 2026-11-10T16:04:58Z.',
      );
      expect(notes).toContain(
        'The header also states a total time of 2 min 5 s, a greatest height of 44.8 m and the place 39.5012345, -105.2034567. That is the app’s own summary, printed for you to compare; it is written to no row.',
      );
      expect(notes).toContain(
        'Read 7 records of the aircraft’s state (type 1) and 7 records of the app’s time (type 5); 7 samples had both, 7 of them with a position.',
      );
      expect(notes).toContain('Record types not read, with how many of each: 3 (7).');
      expect(reading.notes.at(-1)).toMatch(/has been run against no real flight record\. Test it against your own/);
    },
  );

  it('reads the time in seconds in a version 2 file', async () => {
    const reading = await read(djiFile(2, djiFlight(2)));
    expect(reading.flights[0]).toMatchObject(FLOWN);
  });

  it('writes the flight in the import template’s columns, with the height as from the takeoff point', async () => {
    const reading = await read(djiFile(8, djiFlight(8)));
    const log = { name: 'DJIFlightRecord_2026-11-10_[09-05-12].txt', sha256: 'b'.repeat(64) };
    const csv = flightRecordCsv(reading, log);
    expect(csv.split('\r\n')[0]).toBe(recordCsvTemplate(flightRecordV1).trimEnd());
    const row = parseRecordFile(new TextEncoder().encode(csv), 'csv').rows[0]!;
    expect(row.cells).toMatchObject({
      subjectId: '',
      secondarySubjectId: '',
      takeoffAt: '2026-11-10T16:05:12Z',
      landingAt: '2026-11-10T16:06:58Z',
      takeoffLocation: '39.5012345, -105.2034567',
      landingLocations: '39.5141000, -105.1873000',
      maxHeightFlownAboveGroundMeters: '',
      heightNotes:
        'Greatest height 44.8 m above the takeoff point, the reference the app records height from. The log does not hold the height above the ground.',
    });
    // The aircraft's serial number is printed, never written as the organization's id for the aircraft.
    expect(csv).not.toContain('EXAMPLE001');
    const lines = readingLines(reading, log.name);
    expect(lines).toContain(
      'Flight 1, from the first sample that says the aircraft is in the air to the last time a sample says it is back on the ground; the file is one flight:',
    );
    expect(lines).toContain(
      'The log names the vehicle EXAMPLE001 (the aircraft’s serial number in the file’s header, as the app recorded it); it is not your own id for the aircraft.',
    );
  });

  it.each([13, 14])(
    'reads only the header of a version %i file and stops with the sentence about the key',
    async (version) => {
      const encrypted = Uint8Array.from({ length: 300 }, (_, index) => (index * 37) & 0xff);
      const bytes = djiFile(version, [encrypted]);
      const reading = await read(bytes);
      expect(reading.flights).toEqual([]);
      expect(reading.unfinished).toBeUndefined();
      expect(reading.absoluteTime).toBeUndefined();
      expect(reading.vehicle?.identifier).toBe('EXAMPLE001');
      expect(reading.stopped).toEqual({
        offset: bytes.byteLength - encrypted.byteLength,
        reason: `This file is version ${version} of the DJI flight record format. From version 13 on its records are encrypted, and reading them needs a key from the maker’s service, which Ledger does not call; only the header was read. The open-source tool dji-log-parser fetches that key with a developer key of your own and writes the flight as a CSV, which records read-log reads by the same rule; examples/dji-flight-record shows the steps.`,
      });
      expect(reading.bytesRead).toBe(bytes.byteLength - encrypted.byteLength);
      expect(reading.notes[0]).toMatch(/^The file’s header gives the aircraft’s name “Ridge survey one”/);
      expect(reading.notes[0]).toContain('the start of the log, 2026-11-10T16:04:58Z');
      expect(reading.notes.at(-1)).toMatch(/has been run against no real flight record/);
    },
  );

  it('says which version a file is when the layout it was built from does not describe it', async () => {
    const reading = await read(djiFile(15, [new Uint8Array(40)]));
    expect(reading.flights).toEqual([]);
    expect(reading.stopped?.reason).toBe(
      'This file says it is version 15 of the DJI flight record format. The layout this reader was built from describes versions 1 to 14, so nothing of it was read.',
    );
    expect(reading.notes.join('\n')).toContain('has been run against no real flight record');
  });

  it('reads on past a content of 256 bytes or more, whose length byte wraps and has no end byte', async () => {
    const [first, ...rest] = [...Array(7).keys()].map((index) => djiFlight(8).slice(index * 3, index * 3 + 3));
    const long = record(8, 40, new Uint8Array(298).fill(0xff), 0x77);
    expect(long[1]).toBe(300 - 256);
    const reading = await read(djiFile(8, [...first!, long, record(8, 40, new Uint8Array(600), 0x02), ...rest.flat()]));
    expect(reading.stopped).toBeUndefined();
    expect(reading.flights[0]).toMatchObject(FLOWN);
    expect(reading.notes).toContain('Record types not read, with how many of each: 3 (7), 40 (2).');
  });

  it('steps over an image embedded between records, and a marker left alone', async () => {
    const records = djiFlight(6);
    const withImages = [
      ...records.slice(0, 6),
      MARKER,
      JPEG,
      ...records.slice(6, 9),
      MARKER,
      MARKER,
      ...records.slice(9, 12),
      JPEG,
      ...records.slice(12),
      MARKER,
    ];
    const reading = await read(djiFile(6, withImages));
    expect(reading.stopped).toBeUndefined();
    expect(reading.flights[0]).toMatchObject(FLOWN);
    expect(reading.notes).toContain('2 embedded images stepped over.');
    const cut = await read(djiFile(6, [...records.slice(0, 6), MARKER, JPEG.subarray(0, 12), ...records.slice(6)]));
    expect(cut.stopped?.reason).toMatch(/^the image embedded at this byte does not end as a JPEG image does/);
  });

  it('takes both values of the state bits for on the ground and for in the air', async () => {
    const records = [
      ...frame(8, 0, RIDGE, 0, { inAir: false, bits: 0x02 | 0x08 }),
      ...frame(8, 10, RIDGE, 30, { inAir: true, bits: 0x06 | 0x08 }),
      ...frame(8, 20, RIDGE, 12, { inAir: true, bits: 0x04 | 0x08 }),
      ...frame(8, 31, RIDGE, 0, { inAir: false, bits: 0x00 }),
    ];
    const reading = await read(djiFile(8, records));
    expect(reading.flights[0]).toMatchObject({
      takeoffAt: '2026-11-10T16:05:10Z',
      landingAt: '2026-11-10T16:05:31Z',
      durationSeconds: 21,
      greatestHeight: { meters: 30 },
    });
  });

  it('lists every touchdown of the one flight, the last where it landed', async () => {
    const records = [
      ...frame(8, 0, RIDGE, 0, { inAir: false }),
      ...frame(8, 10, RIDGE, 20, { inAir: true }),
      ...frame(8, 50, QUARRY, -19, { inAir: false }),
      ...frame(8, 60, QUARRY, 12, { inAir: true }),
      ...frame(8, 95, RIDGE, 0.1, { inAir: false }),
    ];
    const reading = await read(djiFile(8, records));
    expect(reading.flights).toHaveLength(1);
    expect(reading.flights[0]).toMatchObject({
      takeoffAt: '2026-11-10T16:05:10Z',
      landingAt: '2026-11-10T16:06:35Z',
      takeoffPlace: RIDGE,
      landingPlaces: [QUARRY, RIDGE],
      greatestHeight: { meters: 20 },
    });
  });

  it('writes no flight when the file ends in the air, or never says in the air, and says which', async () => {
    const cut = await read(djiFile(8, djiFlight(8).slice(0, 15)));
    expect(cut.flights).toEqual([]);
    expect(cut.unfinished).toEqual({
      startedSecondsIntoLog: 12,
      reason: 'the file’s last record still says the aircraft is in the air',
    });
    const ground = [...frame(8, 0, RIDGE, 0, { inAir: false }), ...frame(8, 30, RIDGE, 0, { inAir: false })];
    const idle = await read(djiFile(8, ground));
    expect(idle.flights).toEqual([]);
    expect(idle.unfinished).toBeUndefined();
    expect(idle.notes.join('\n')).toContain(
      'No record says the aircraft was in the air, though some say the motors were on. That is no flight by this reader’s rule',
    );
    const still = await read(djiFile(8, frame(8, 0, RIDGE, 0, { inAir: false, motorsOn: false })));
    expect(still.notes).toContain('No record says the aircraft was in the air, so the file holds no flight.');
  });

  it('stops at a record without its end mark, says the byte, and keeps the flight when it had landed', async () => {
    const records = djiFlight(6);
    const damaged = record(6, 9, new Uint8Array(20));
    damaged[damaged.byteLength - 1] = 0x00;
    const before = concat(...records).byteLength;
    const landed = await read(djiFile(6, [...records, damaged, ...frame(6, 130, QUARRY, 0, { inAir: false })]));
    expect(landed.stopped).toEqual({
      offset: 100 + before,
      reason:
        'the record that begins at this byte (type 9, 20 bytes) is not followed by the end mark the layout describes. The file is damaged here, or it is laid out differently from the description this reader was built from.',
    });
    expect(landed.bytesRead).toBe(100 + before);
    expect(landed.flights[0]).toMatchObject(FLOWN);
    const inAir = await read(djiFile(6, [...records.slice(0, 12), damaged, ...records.slice(12)]));
    expect(inAir.flights).toEqual([]);
    expect(inAir.unfinished?.reason).toBe(
      'the reader stopped while the file’s records still said the aircraft was in the air',
    );
  });

  it('reads the records of a file cut before its header, and says the file is cut short', async () => {
    const whole = djiFile(8, djiFlight(8));
    const recordsEnd = 100 + concat(...djiFlight(8)).byteLength;
    const reading = await read(whole.subarray(0, recordsEnd));
    expect(reading.stopped).toEqual({
      offset: recordsEnd,
      reason: `the file ends before its header, which its first bytes place at byte ${recordsEnd}: the file is cut short.`,
    });
    expect(reading.vehicle).toBeUndefined();
    expect(reading.flights[0]).toMatchObject(FLOWN);
    expect(reading.notes).toContain('The file’s header was not read: the file ends before it.');
    const inRecord = await read(whole.subarray(0, recordsEnd - 5));
    expect(inRecord.stopped?.reason).toMatch(
      /^the record that begins at this byte \(type 5, 20 bytes\) runs past the end/,
    );
    expect(inRecord.flights[0]).toMatchObject(FLOWN);
  });

  it('leaves out a state record that comes before any time, and reads no flight from a file with no time', async () => {
    const late = [record(8, 1, djiState(RIDGE, 0, { inAir: false })), ...djiFlight(8)];
    const reading = await read(djiFile(8, late));
    expect(reading.flights[0]).toMatchObject(FLOWN);
    expect(reading.notes).toContain('1 state record came before any time of the app’s (type 5) and was left out.');
    const untimed = djiFlight(8).filter((_, index) => index % 3 !== 2);
    const none = await read(djiFile(8, untimed));
    expect(none.flights).toEqual([]);
    expect(none.absoluteTime).toBeUndefined();
    expect(none.notes.join('\n')).toContain('so no sample could be timed and no flight was read');
    const wrongTime = [...djiFlight(8), record(8, 5, djiTime(0, 8)), record(8, 5, new Uint8Array(4))];
    const odd = (await read(djiFile(8, wrongTime))).notes.join('\n');
    expect(odd).toContain('1 time record held no time between 2011 and 2100 and was left out.');
    expect(odd).toContain('1 state or time record was shorter than the fields this reader reads and was left out.');
  });

  it('writes no place for a position that is none, and still the height', async () => {
    const nowhere = { latitude: 0, longitude: 0 };
    const records = [
      ...frame(8, 0, nowhere, 0, { inAir: false }),
      ...frame(8, 10, nowhere, 31.4, { inAir: true }),
      ...frame(8, 20, { latitude: 400, longitude: 12 }, 2, { inAir: true }),
      ...frame(8, 30, nowhere, 0, { inAir: false }),
    ];
    const flight = (await read(djiFile(8, records))).flights[0]!;
    expect(flight).not.toHaveProperty('takeoffPlace');
    expect(flight.landingPlaces).toEqual([]);
    expect(flight.greatestHeight).toEqual({ ...HEIGHT, meters: 31.4 });
    expect(flight.notRead).toEqual(['The file holds no position during this flight: no takeoff or landing place.']);
  });

  it('says so when the header holds nothing it reads, and when the app’s time runs backwards', async () => {
    const blank = {
      name: '',
      serial: '',
      startUtc: 0,
      place: { latitude: 0, longitude: 0 },
      totalSeconds: 0,
      greatestHeight: 0,
    };
    const records = [
      ...frame(8, 0, RIDGE, 0, { inAir: false }),
      ...frame(8, 40, RIDGE, 9, { inAir: true }),
      ...frame(8, 20, RIDGE, 0, { inAir: false }),
    ];
    const reading = await read(djiFile(8, records, blank));
    expect(reading.vehicle).toBeUndefined();
    expect(reading.notes).toContain(
      'The file’s header gives no aircraft name, no serial number and no start of the log.',
    );
    expect(reading.notes).toContain(
      'The app’s time went backwards once in the file; the takeoff and landing times are as the app wrote them.',
    );
    expect(reading.flights[0]).not.toHaveProperty('takeoffAt');
    expect(reading.flights[0]!.notRead).toEqual([
      'The app’s time at the landing is not after its time at the takeoff, so no takeoff or landing time is written.',
    ]);
  });

  it('refuses a file that is no flight record, one too short, and one larger than it holds at once', async () => {
    const text = await read(new TextEncoder().encode('Flight notes for the ridge survey, 10 November'));
    expect(text.stopped?.reason).toMatch(/^The file does not begin as a DJI flight record does/);
    expect((await read(new Uint8Array(5))).stopped?.reason).toMatch(/^The file is shorter than the 12 bytes/);
    const short = await read(djiFile(12, []).subarray(0, 300));
    expect(short.stopped?.reason).toBe(
      'The file is version 12 of the DJI flight record format and ends before byte 536, where its records would begin: it is cut short.',
    );
    const megabyte = new Uint8Array(1024 * 1024);
    const large = await readDji(Array.from({ length: DJI_MAX_BYTES / megabyte.byteLength + 1 }, () => megabyte));
    expect(large.stopped?.reason).toBe(
      'The file is larger than 128 MB, the most this reader reads at once, so it was not read.',
    );
    for (const reading of [text, short, large]) expect(reading.flights).toEqual([]);
  });
});
