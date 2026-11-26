import { createHash } from 'node:crypto';
import { closeSync, createReadStream, existsSync, openSync, readSync, writeFileSync } from 'node:fs';
import { basename, extname, relative } from 'node:path';
import { flightRecordCsv, formatOf, logFormats, readingLines, readLog, type LogFormat } from '@ledger/flight-logs';
import { UsageError, type Output } from './commands.js';

/**
 * Reads an aircraft's own log into rows of Ledger's flight record, offline: nothing is sent to Ledger. The rows go
 * through `records check` and `records import` like any other file, with the log itself kept as their original.
 */

function head(path: string): Uint8Array {
  let descriptor: number;
  try {
    descriptor = openSync(path, 'r');
  } catch {
    throw new UsageError(`Cannot read ${path}.`);
  }
  try {
    const bytes = new Uint8Array(64);
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
      `${basename(logPath)} does not begin as a PX4 ULog (.ulg), an ArduPilot DataFlash log (.bin) or a MAVLink telemetry log (.tlog) does, so it was not read. Give --format if you know which it is.`,
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
  return {
    data: { ...data, out },
    refused: Boolean(reading.unfinished),
    lines: [
      ...lines,
      '',
      `Wrote ${shown}: one flight.record row for each whole flight, with only what the log holds.`,
      'Before importing, write in each row what the log does not hold: subjectId (your own id for the flight), secondarySubjectId (your own id for the aircraft), maxHeightFlownAboveGroundMeters (the log states heights from home or the takeoff point, not above the ground), and anything else your records keep for a flight.',
      `Then: pnpm ledger records check flight.record ${shown} --original ${shownLog}`,
      `  and: pnpm ledger records import flight.record ${shown} --original ${shownLog}`,
      'Ledger keeps the log itself as each record’s original, and the CSV as the reading of it.',
    ],
  };
}
