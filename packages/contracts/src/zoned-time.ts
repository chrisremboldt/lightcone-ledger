/**
 * Wall-clock times in an IANA time zone, read and written without the machine's own zone. Used where a person enters
 * or reads a time in the organization's zone.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function wallFormatter(timeZone: string): Intl.DateTimeFormat | undefined {
  const known = formatters.get(timeZone);
  if (known) return known;
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
    return formatter;
  } catch {
    return undefined;
  }
}

/** True when the platform knows the IANA zone name. */
export function knownTimeZone(timeZone: string): boolean {
  return Boolean(timeZone) && wallFormatter(timeZone) !== undefined;
}

/** The wall-clock time at an instant in the zone, as milliseconds of the same reading taken as UTC. */
function wallMillis(instant: number, timeZone: string): number {
  const parts = Object.fromEntries(
    wallFormatter(timeZone)!
      .formatToParts(new Date(instant))
      .map((part) => [part.type, part.value]),
  );
  return Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
}

const pad = (value: number, length = 2) => String(value).padStart(length, '0');

/** The zone's wall-clock reading of an instant, written YYYY-MM-DDThh:mm:ss. Undefined for an unknown zone. */
export function zonedWallTime(instant: string | number, timeZone: string): string | undefined {
  const at = typeof instant === 'number' ? instant : Date.parse(instant);
  if (!Number.isFinite(at) || !knownTimeZone(timeZone)) return undefined;
  const wall = new Date(wallMillis(at, timeZone));
  return `${pad(wall.getUTCFullYear(), 4)}-${pad(wall.getUTCMonth() + 1)}-${pad(wall.getUTCDate())}T${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}:${pad(wall.getUTCSeconds())}`;
}

/** The zone's offset from UTC at an instant, written +hh:mm or -hh:mm. */
export function zoneOffset(instant: number, timeZone: string): string {
  const minutes = Math.round((wallMillis(instant, timeZone) - Math.floor(instant / 1000) * 1000) / 60_000);
  const sign = minutes < 0 ? '-' : '+';
  return `${sign}${pad(Math.floor(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}`;
}

/**
 * Every instant at which the zone's clocks read the wall time given as UTC milliseconds: one normally, none in a gap
 * when clocks move forward, two in the hour that repeats when they move back.
 */
export function instantsOfWallTime(wall: number, timeZone: string): number[] {
  const offsets = new Set<number>();
  for (const probe of [-36, -12, 0, 12, 36]) {
    const around = wall + probe * 3_600_000;
    offsets.add(wallMillis(around, timeZone) - Math.floor(around / 1000) * 1000);
  }
  return [...offsets]
    .map((offset) => wall - offset)
    .filter((instant) => wallMillis(instant, timeZone) === wall)
    .sort((a, b) => a - b);
}

/** An instant written as UTC with seconds, and milliseconds only when it has them. */
export function utcText(instant: number): string {
  const text = new Date(instant).toISOString();
  return text.endsWith('.000Z') ? `${text.slice(0, 19)}Z` : text;
}

/** An instant as a sentence states it in a zone: 2026-11-10 09:00 America/Chicago, with seconds when it has them. */
export function zonedInstantText(instant: string | number, timeZone: string): string | undefined {
  const wall = zonedWallTime(instant, timeZone);
  if (!wall) return undefined;
  const [date, time] = wall.split('T') as [string, string];
  return `${date} ${time.endsWith(':00') ? time.slice(0, 5) : time} ${timeZone}`;
}

const utcInstantInText = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z\b/g;

/**
 * A sentence with every UTC instant it states written in the zone with the zone's name, so a person reads times as
 * the organization keeps them. An unknown zone leaves the sentence as it is.
 */
export function localizeInstants(text: string, timeZone: string | undefined): string {
  if (!timeZone || !knownTimeZone(timeZone)) return text;
  return text.replace(utcInstantInText, (instant) => zonedInstantText(instant, timeZone) ?? instant);
}
