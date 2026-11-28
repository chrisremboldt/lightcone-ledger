import { createHash } from 'node:crypto';
import { closeSync, createReadStream, existsSync, openSync, readSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, relative } from 'node:path';
import {
  flightRecordCsv,
  formatOf,
  KEPT_ORIGINAL_MAX_BYTES,
  LOG_HEAD_BYTES,
  logFormats,
  logFormatWords,
  readingLines,
  readLog,
  type LogFormat,
  type LogReading,
} from '@ledger/flight-logs';
import { UsageError, type Output } from './commands.js';

/**
 * Reads an aircraft's own log, a flight log a fleet product exported, the flight record a manufacturer's app
 * wrote or an open tool's CSV of one, into rows of Ledger's flight record, offline: nothing is sent to Ledger or to anyone else. The rows go
 * through `records check` and `records import` like any other file, with the log itself kept as their original.
 */

/** "a, b, c or d": every format a reader exists for, as a person names them. */
function formatsInWords(): string {
  const words = logFormats.map((format) => logFormatWords[format]);
  return `${words.slice(0, -1).join(', ')} or ${words.at(-1)}`;
}

/** What a person still writes about the height above the ground, which only some logs state. */
function heightAboveGroundWords(reading: LogReading): string {
  return reading.flights.every((flight) => flight.greatestHeight?.aboveGround)
    ? ''
    : 'maxHeightFlownAboveGroundMeters (the log does not state a height above the ground; heightNotes has the heights it does state and what each is measured from), ';
}

function head(path: string): Uint8Array {
  let descriptor: number;
  try {
    descriptor = openSync(path, 'r');
  } catch {
    throw new UsageError(`Cannot read ${path}.`);
  }
  try {
    const bytes = new Uint8Array(LOG_HEAD_BYTES);
    const count = readSync(descriptor, bytes, 0, bytes.byteLength, 0);
    return bytes.subarray(0, count);
  } finally {
    closeSync(descriptor);
  }
}

/** The SHA-256 of the whole file, read in chunks. */
async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

const chunksOf = (path: string) => createReadStream(path, { highWaterMark: 64 * 1024 }) as AsyncIterable<Uint8Array>;

export async function readFlightLog(
  logPath: string,
  options: { format?: string; out?: string; folder: string },
): Promise<Output> {
  if (options.format !== undefined && !logFormats.includes(options.format as LogFormat))
    throw new UsageError(`--format is one of ${logFormats.join(', ')}: ${options.format}`);
  const start = head(logPath);
  const format = (options.format as LogFormat | undefined) ?? formatOf(start);
  if (!format)
    throw new UsageError(
      `${basename(logPath)} does not begin as ${formatsInWords()} does, so it was not read. Give --format if you know which it is.`,
    );
  const sha256 = await sha256Of(logPath);
  const reading = await readLog(format, chunksOf(logPath));
  const name = basename(logPath);
  const lines = readingLines(reading, name);
  const out = options.out ?? `${options.folder}/${basename(logPath, extname(logPath))}.flight.record.csv`;
  const shown = relative(options.folder, out) || out;
  const data = { reading, log: { name, sha256 } };
  if (!reading.flights.length)
    return { data, refused: true, lines: [...lines, 'No whole flight was read, so no file was written.'] };
  if (existsSync(out)) throw new UsageError(`${shown} already exists; nothing was written. Give another --out.`);
  writeFileSync(out, flightRecordCsv(reading, { name, sha256 }));
  const shownLog = relative(options.folder, logPath) || logPath;
  // A file larger than Ledger keeps cannot be the records' original; the rows are checked and imported without it.
  const kept = statSync(logPath).size <= KEPT_ORIGINAL_MAX_BYTES;
  const original = kept ? ` --original ${shownLog}` : '';
  return {
    data: { ...data, out },
    refused: Boolean(reading.unfinished),
    lines: [
      ...lines,
      '',
      `Wrote ${shown}: one flight.record row for each whole flight, with only what the log holds.`,
      `Before importing, write in each row what the log does not hold: subjectId (your own id for the flight), secondarySubjectId (your own id for the aircraft), ${heightAboveGroundWords(reading)}and anything else your records keep for a flight.`,
      ...(heightAboveGroundWords(reading)
        ? []
        : [
            'maxHeightFlownAboveGroundMeters is the greatest altitude in the log, which the log itself states as above ground level; check it before importing.',
          ]),
      `Then: pnpm ledger records check flight.record ${shown}${original}`,
      `  and: pnpm ledger records import flight.record ${shown}${original}`,
      kept
        ? 'Ledger keeps the log itself as each record’s original, and the CSV as the reading of it.'
        : `${name} is larger than the ${KEPT_ORIGINAL_MAX_BYTES / 1024 / 1024} MB Ledger keeps as an original, so it is not given as one: Ledger keeps the CSV, and you keep ${name} yourself.`,
    ],
  };
}
