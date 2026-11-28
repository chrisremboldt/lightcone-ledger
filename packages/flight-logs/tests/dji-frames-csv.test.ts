import { readFileSync } from 'node:fs';
import { parseRecordFile } from '@ledger/contracts';
import { describe, expect, it } from 'vitest';
import {
  flightRecordCsv,
  formatOf,
  KEPT_ORIGINAL_MAX_BYTES,
  readDji,
  readDjiFramesCsv,
  readingLines,
  readLog,
} from '../src/index.js';
import {
  chunks,
  DJI_FRAME_COLUMNS,
  DJI_FRAMES,
  type DjiCsvFrame,
  djiExampleFrames,
  djiFile,
  djiFlight,
  djiFramesCsv as csv,
  QUARRY,
  RIDGE,
} from './encoders.js';

const bytesOf = (text: string) => new TextEncoder().encode(text);
const read = (text: string) => readDjiFramesCsv([bytesOf(text)]);
const FLOWN = {
  number: 1,
  rule: 'first_in_air_to_last_on_ground',
  takeoffAt: '2026-11-10T16:05:12Z',
  landingAt: '2026-11-10T16:06:58Z',
  durationSeconds: 106,
  takeoffPlace: RIDGE,
  landingPlaces: [QUARRY],
  greatestHeight: { meters: 44.8, reference: 'above the takeoff point, the reference the app records height from' },
  notRead: [],
};
const NEEDED = 'CUSTOM.dateTime, OSD.latitude, OSD.longitude, OSD.height and OSD.isOnGround';

describe('reader of the CSV of frames the dji-log tool writes from a DJI flight record', () => {
  it('is told from the header row by the tool’s column names, and another CSV is not taken for one', () => {
    expect(formatOf(bytesOf(csv(DJI_FRAMES)).subarray(0, 1024))).toBe('dji-frames-csv');
    expect(formatOf(bytesOf(`﻿${csv(DJI_FRAMES, { lineEnd: '\r\n' })}`).subarray(0, 1024))).toBe('dji-frames-csv');
    expect(formatOf(bytesOf('"CUSTOM.dateTime","OSD.flyTime","OSD.latitude"\n'))).toBe('dji-frames-csv');
    expect(formatOf(bytesOf(`Flight id,Aircraft id,${csv(DJI_FRAMES)}`))).toBeUndefined();
    expect(formatOf(bytesOf('subjectId,takeoffAt,landingAt\nFLT-1,2026-11-10T16:05:12Z,\n'))).toBeUndefined();
    expect(formatOf(bytesOf('CUSTOM.dateTime of each frame, as text'))).toBeUndefined();
  });

  it('reads a whole flight as a stream: times, places and the height above the takeoff point', async () => {
    const text = csv(DJI_FRAMES);
    const bytes = bytesOf(text);
    const reading = await readLog('dji-frames-csv', chunks(bytes, 53));
    expect(reading).toMatchObject({
      format: 'dji-frames-csv',
      formatName: 'CSV of frames written by the dji-log tool from a DJI flight record',
      bytesRead: bytes.byteLength,
    });
    expect(reading.stopped).toBeUndefined();
    expect(reading.unfinished).toBeUndefined();
    expect(reading.absoluteTime).toBe(
      'CUSTOM.dateTime, the column the dji-log tool gives as the date and time of the frame; its source types it as UTC, and every cell read states its own zone',
    );
    expect(reading.vehicle).toEqual({
      identifier: 'EXAMPLE001',
      from: 'DETAILS.aircraftSerial, the aircraft’s serial number as the app recorded it',
    });
    expect(reading.flights).toHaveLength(1);
    expect(reading.flights[0]).toMatchObject(FLOWN);
    // From the row that first says in the air to the end of the row that says on the ground again.
    const lines = text.split('\n');
    const before = (count: number) => bytesOf(lines.slice(0, count).join('\n')).byteLength + 1;
    expect(reading.flights[0]!.bytes).toEqual({ offset: before(3), length: before(7) - before(3) });
    expect(reading.notes).toEqual([
      'The file is the CSV the open-source dji-log tool writes from a DJI flight record, one row for each frame. It is the tool’s decoding, not the maker’s own file: keep the flight record it was made from as well.',
      'The file’s first row gives the aircraft’s name “Ridge survey one” (DETAILS.aircraftName) and its serial number “EXAMPLE001” (DETAILS.aircraftSerial), as the app recorded them.',
      'It states the start of the log as 2026-11-10T16:04:58.000Z (DETAILS.startTime), a total time of 125 s (DETAILS.totalTime) and a greatest height of 44.8 m (DETAILS.maxHeight). That is the app’s own summary, printed for you to compare; it is written to no row.',
      'Read 7 rows of frames; 7 rows had a date and time and said on the ground or not, 7 of them with a position.',
      `Columns read: ${NEEDED.replace(' and ', ', ')}, OSD.isMotorOn, DETAILS.aircraftName, DETAILS.aircraftSerial, DETAILS.startTime, DETAILS.totalTime and DETAILS.maxHeight. The file’s other 6 columns were not read.`,
      'OSD.height is written as a height above the takeoff point. The tool’s own words for it are “height above ground level”, but it gives OSD.altitude as this height plus the altitude of the home point: it is counted from where the aircraft took off, not from the ground under it.',
      'This reader was built from the source of the open-source dji-log tool, which gives the names of the CSV’s columns and not how their values are written, and has been run against no CSV the tool wrote. Test it against your own before you rely on it: compare what it reads here (the times, the places, the height, the aircraft’s name and serial number) with what the app shows for this flight.',
    ]);
  });

  it('reads the same flight from the tool’s CSV as from the flight record itself', async () => {
    const fromFile = (await readDji([djiFile(8, djiFlight(8))])).flights[0]!;
    const fromCsv = (await read(csv(DJI_FRAMES))).flights[0]!;
    expect({ ...fromCsv, bytes: undefined }).toEqual({ ...fromFile, bytes: undefined });
  });

  it('writes the flight in the import template’s columns, and no id from the serial number', async () => {
    const reading = await read(csv(DJI_FRAMES));
    const log = { name: 'frames.csv', sha256: 'c'.repeat(64) };
    const written = flightRecordCsv(reading, log);
    expect(parseRecordFile(bytesOf(written), 'csv').rows[0]!.cells).toMatchObject({
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
    expect(written).not.toContain('EXAMPLE001');
    expect(readingLines(reading, log.name)).toContain(
      'Flight 1, from the first sample that says the aircraft is in the air to the last time a sample says it is back on the ground; the file is one flight:',
    );
  });

  it('finds its columns by name whatever their order, among quoted cells that hold commas, quotes and line breaks', async () => {
    const columns = ['APP.tip', ...[...DJI_FRAME_COLUMNS].reverse(), 'APP.warn'];
    const text = csv(DJI_FRAMES, {
      columns,
      name: 'Ridge "one", survey',
      lineEnd: '\r\n',
      cell: (column, frame, value) =>
        column === 'APP.tip' ? `Takeoff, "home" set\r\nat ${frame.seconds} s` : column === 'APP.warn' ? '' : value,
    });
    expect(text).toContain('"Ridge ""one"", survey"');
    const reading = await readDjiFramesCsv(chunks(bytesOf(text), 11));
    expect(reading.stopped).toBeUndefined();
    expect(reading.flights[0]).toMatchObject(FLOWN);
    expect(reading.notes.join('\n')).toContain('the aircraft’s name “Ridge "one", survey” (DETAILS.aircraftName)');
    expect(reading.notes.join('\n')).toContain('The file’s other 8 columns were not read.');
    const cut = await read(text.slice(0, text.lastIndexOf('Takeoff,') + 4));
    expect(cut.stopped?.reason).toBe(
      'the file ends inside a quoted value that begins in the row at this byte: it is cut short.',
    );
    expect(cut.flights[0]).toMatchObject(FLOWN);
  });

  it('writes no flight when the file ends in the air, or no row says in the air, and says which', async () => {
    const cut = await read(csv(DJI_FRAMES.slice(0, 5)));
    expect(cut.flights).toEqual([]);
    expect(cut.unfinished).toEqual({
      startedSecondsIntoLog: 12,
      reason: 'the file’s last row still says the aircraft is in the air',
    });
    const ground = DJI_FRAMES.map((frame) => ({ ...frame, inAir: false }));
    const idle = await read(csv(ground));
    expect(idle.flights).toEqual([]);
    expect(idle.unfinished).toBeUndefined();
    expect(idle.notes.join('\n')).toContain(
      'No row says the aircraft was in the air (OSD.isOnGround is true in every row), though some say the motors were on.',
    );
    const still = await read(csv(ground.map((frame) => ({ ...frame, motorsOn: false }))));
    expect(still.notes).toContain(
      'No row says the aircraft was in the air (OSD.isOnGround is true in every row), so the file holds no flight.',
    );
    expect((await read(csv([]))).notes).toContain(
      'The file holds no row of frames this reader could read, so it holds no flight.',
    );
  });

  it('refuses a file without one of the columns it needs, naming those it looked for', async () => {
    const columns = DJI_FRAME_COLUMNS.filter((column) => column !== 'OSD.height' && column !== 'OSD.isOnGround');
    const reading = await readLog('dji-frames-csv', [bytesOf(csv(DJI_FRAMES, { columns }))]);
    expect(reading.flights).toEqual([]);
    expect(reading.stopped).toEqual({
      offset: 0,
      reason: `The file’s header row does not name OSD.height and OSD.isOnGround. This reader looks for ${NEEDED}, the names the dji-log tool gives those columns in its CSV of frames, so the file was not read.`,
    });
    expect(reading.notes.at(-1)).toMatch(/has been run against no CSV the tool wrote/);
    const other = await read('subjectId,takeoffAt\nFLT-1,2026-11-10T16:05:12Z\n');
    expect(other.stopped?.reason).toMatch(new RegExp(`^The file’s header row does not name ${NEEDED}\\.`));
    expect((await read('')).stopped?.reason).toBe('The file is empty, so it was not read.');
  });

  it('reads the summary columns only when the file has them', async () => {
    const reading = await read(csv(DJI_FRAMES, { columns: DJI_FRAME_COLUMNS.slice(0, 8) }));
    expect(reading.flights[0]).toMatchObject(FLOWN);
    expect(reading.vehicle).toBeUndefined();
    expect(reading.notes.join('\n')).not.toContain('first row gives');
    expect(reading.notes.join('\n')).toContain(`Columns read: ${NEEDED}. The file’s other 3 columns were not read.`);
  });

  it('writes no time of day when the date and time states no zone, and takes one that states an offset', async () => {
    const local = (value: string) => value.replace('T', ' ').replace('.000Z', '');
    const zoneless = await read(
      csv(DJI_FRAMES, { cell: (column, _frame, value) => (column === 'CUSTOM.dateTime' ? local(value) : value) }),
    );
    expect(zoneless.absoluteTime).toBeUndefined();
    expect(zoneless.flights[0]).toMatchObject({ durationSeconds: 106, takeoffPlace: RIDGE });
    expect(zoneless.flights[0]).not.toHaveProperty('takeoffAt');
    expect(zoneless.notes).toContain(
      'CUSTOM.dateTime is written with no time zone in 7 rows (as “2026-11-10 16:05:00”). The tool’s source types the column as UTC but does not say how it is written, and a cell that does not state its zone is not taken for UTC: no takeoff or landing time is written, and the duration is from the same column.',
    );
    const shifted = (value: string) =>
      new Date(Date.parse(value) - 7 * 3_600_000).toISOString().replace('.000Z', '-07:00');
    const offset = await read(
      csv(DJI_FRAMES, { cell: (column, _frame, value) => (column === 'CUSTOM.dateTime' ? shifted(value) : value) }),
    );
    expect(offset.flights[0]).toMatchObject(FLOWN);
    const named = await read(
      csv(DJI_FRAMES, { cell: (column, _f, value) => (column === 'CUSTOM.dateTime' ? `${local(value)} UTC` : value) }),
    );
    expect(named.flights[0]).toMatchObject(FLOWN);
  });

  it('stops at a row whose on-the-ground cell is neither true nor false, and says the row', async () => {
    const odd = (at: number) =>
      csv(DJI_FRAMES, {
        cell: (column, frame, value) => (column === 'OSD.isOnGround' && frame.seconds === at ? '1' : value),
      });
    const inAir = await read(odd(90));
    expect(inAir.stopped?.reason).toBe(
      'row 6 of the file holds “1” in OSD.isOnGround, where this reader expects true or false. The tool’s source does not say how it writes the column, so nothing from this row on was read.',
    );
    expect(inAir.flights).toEqual([]);
    expect(inAir.unfinished?.reason).toBe(
      'the reader stopped while the file’s rows still said the aircraft was in the air',
    );
    const landed = await read(odd(125));
    expect(landed.stopped?.reason).toMatch(/^row 8 of the file/);
    expect(landed.flights[0]).toMatchObject(FLOWN);
  });

  it('leaves out a row with no date and time or too few cells, a position that is none and a height that is none', async () => {
    const text = csv(DJI_FRAMES, {
      cell: (column, frame, value) =>
        (column === 'CUSTOM.dateTime' && frame.seconds === 5) || (column === 'OSD.height' && frame.seconds !== 5)
          ? ''
          : column === 'OSD.latitude' || column === 'OSD.longitude'
            ? '0'
            : value,
    });
    const reading = await read(`${text}2026-11-10T16:07:10.000Z,130\n\n`);
    expect(reading.notes).toContain('1 row had fewer cells than the columns this reader reads and was left out.');
    expect(reading.notes).toContain(
      '1 row held no date and time between 2011 and 2100 in CUSTOM.dateTime and was left out.',
    );
    expect(reading.notes.join('\n')).toContain('Read 8 rows of frames; 6 rows had a date and time');
    const flight = reading.flights[0]!;
    expect(flight).toMatchObject({ takeoffAt: FLOWN.takeoffAt, landingAt: FLOWN.landingAt, landingPlaces: [] });
    expect(flight).not.toHaveProperty('takeoffPlace');
    expect(flight).not.toHaveProperty('greatestHeight');
    expect(flight.notRead).toEqual([
      'The file holds no position during this flight: no takeoff or landing place.',
      'The file holds no height during this flight.',
    ]);
  });

  it('reads a file larger than Ledger keeps as an original without holding it, and says it cannot be kept', async () => {
    const header = `${DJI_FRAME_COLUMNS.join(',')}\n`;
    const rowOf = (frame: DjiCsvFrame) => csv([frame]).slice(header.length);
    const ground = bytesOf(rowOf(DJI_FRAMES[1]!));
    const air = bytesOf(rowOf(DJI_FRAMES[3]!).repeat(500));
    const last = bytesOf(rowOf(DJI_FRAMES[5]!));
    const blocks = Math.ceil(KEPT_ORIGINAL_MAX_BYTES / air.byteLength) + 1;
    function* file() {
      yield bytesOf(header);
      yield ground;
      for (let block = 0; block < blocks; block += 1) yield air;
      yield last;
    }
    const total = header.length + ground.byteLength + blocks * air.byteLength + last.byteLength;
    expect(total).toBeGreaterThan(KEPT_ORIGINAL_MAX_BYTES);
    const reading = await readDjiFramesCsv(file());
    expect(reading.bytesRead).toBe(total);
    expect(reading.flights[0]).toMatchObject({
      takeoffAt: '2026-11-10T16:05:40Z',
      landingAt: '2026-11-10T16:06:58Z',
      landingPlaces: [QUARRY],
    });
    expect(reading.notes).toContain(
      `This file is ${(total / 1024 / 1024).toFixed(1)} MB. Ledger keeps a file of at most 10 MB as the original of the records read from it, so this one cannot be given as their original: the rows written from it can still be checked and imported without it, and you keep the file, and the flight record it was made from, yourself.`,
    );
    expect(reading.notes.join('\n')).toContain(`Read ${blocks * 500 + 2} rows of frames`);
  });

  it('stops at a row that never ends, as when a quote is not closed', async () => {
    function* file() {
      yield bytesOf(csv(DJI_FRAMES));
      yield bytesOf('2026-11-10T16:07:10.000Z,"');
      for (let block = 0; block < 20; block += 1) yield new Uint8Array(64 * 1024).fill(0x41);
    }
    const reading = await readDjiFramesCsv(file());
    expect(reading.stopped).toEqual({
      offset: bytesOf(csv(DJI_FRAMES)).byteLength,
      reason:
        'the row that begins at this byte is longer than 1 MB, as when a double quote is never closed; no CSV of frames has such a row, so nothing after it was read.',
    });
    expect(reading.flights[0]).toMatchObject(FLOWN);
  });

  it('keeps the example’s invented export as its encoder writes it, and reads its short flight', async () => {
    const example = new URL('../../../examples/dji-flight-record/frames.csv', import.meta.url);
    const text = readFileSync(example, 'utf8');
    expect(text).toBe(csv(djiExampleFrames()));
    expect(text.trimEnd().split('\n')).toHaveLength(41);
    const reading = await read(text);
    expect(reading.flights[0]).toMatchObject({
      takeoffAt: '2026-11-10T16:05:06Z',
      landingAt: '2026-11-10T16:05:37Z',
      durationSeconds: 31,
      takeoffPlace: RIDGE,
      landingPlaces: [QUARRY],
      greatestHeight: { meters: 44.8 },
    });
  });
});
