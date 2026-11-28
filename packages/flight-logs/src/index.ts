import { isDataflash, readDataflash } from './dataflash.js';
import type { LogFormat, LogReading } from './flights.js';
import { isGutma, readGutma } from './gutma.js';
import { isTlog, readTlog } from './tlog.js';
import { isUlog, readUlog } from './ulog.js';

/**
 * Readers for the logs an aircraft writes and the flight logs a fleet product exports. Each reads one format from its
 * published description and says, per flight, what the log holds; nothing a log does not hold is filled in. Like an
 * adapter, a reader is an extension point: autopilot, product and format names belong here, never in core code.
 */

export * from './flights.js';
export { flightRecordCsv, flightRecordRow, readingLines } from './flight-record.js';
export { isDataflash, readDataflash } from './dataflash.js';
export { GUTMA_MAX_BYTES, isGutma, readGutma } from './gutma.js';
export { isTlog, readTlog } from './tlog.js';
export { isUlog, readUlog } from './ulog.js';

export const logFormats: readonly LogFormat[] = ['ulog', 'dataflash', 'tlog', 'gutma'];

/** Each format as a person names it, with the kind of file it is. */
export const logFormatWords: Record<LogFormat, string> = {
  ulog: 'a PX4 ULog (.ulg)',
  dataflash: 'an ArduPilot DataFlash log (.bin)',
  tlog: 'a MAVLink telemetry log (.tlog)',
  gutma: 'a GUTMA flight log (JSON)',
};

/** How much of a file's start `formatOf` needs to tell its format. */
export const LOG_HEAD_BYTES = 1024;

/** The format a file's first bytes show, or undefined when they show none this package reads. */
export function formatOf(head: Uint8Array): LogFormat | undefined {
  if (isUlog(head)) return 'ulog';
  if (isDataflash(head)) return 'dataflash';
  if (isTlog(head)) return 'tlog';
  if (isGutma(head)) return 'gutma';
  return undefined;
}

export function readLog(
  format: LogFormat,
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): Promise<LogReading> {
  switch (format) {
    case 'ulog':
      return readUlog(source);
    case 'dataflash':
      return readDataflash(source);
    case 'tlog':
      return readTlog(source);
    case 'gutma':
      return readGutma(source);
  }
}
