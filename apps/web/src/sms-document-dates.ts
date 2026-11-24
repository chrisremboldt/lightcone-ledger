import { timeZone, timeZoneLabel } from './format.js';

// The names keep "central" from when every organization was shown in Central time; they now use the organization's
// zone.
const zoned = (options: Intl.DateTimeFormatOptions, locale = 'en-US') =>
  new Intl.DateTimeFormat(locale, { ...options, timeZone: timeZone() });
const dateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

export function documentTime(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return dateFormatter.format(new Date(`${value}T00:00:00Z`));
  const shown = zoned({ month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `${shown.format(new Date(value))} ${timeZoneLabel()}`;
}

export function documentDate(value: string): string {
  return zoned({ month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(value));
}

const REVIEW_NOTICE_MS = 30 * 24 * 60 * 60 * 1000;
/** Matches the server's 30-day notice for periodic review. */
export function reviewState(reviewDueAt: string | null, now = Date.now()): 'overdue' | 'due_soon' | null {
  if (!reviewDueAt) return null;
  const remaining = Date.parse(reviewDueAt) - now;
  return remaining <= 0 ? 'overdue' : remaining <= REVIEW_NOTICE_MS ? 'due_soon' : null;
}

/** The instant as the organization's wall clock reads it, for a datetime-local field. */
export function centralDateTimeInput(value: string): string {
  const parts = zoned(
    {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    },
    'en-CA',
  ).formatToParts(new Date(value));
  const part = (name: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === name)!.value;
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}`;
}

/** How far the organization's wall clock is ahead of UTC at an instant, in milliseconds. */
function offsetAt(instant: number): number {
  return Date.parse(`${centralDateTimeInput(new Date(instant).toISOString())}Z`) - Math.floor(instant / 1000) * 1000;
}

/** The instant a wall-clock time in the organization's zone names; refuses a time that names none or two. */
export function fromCentralDateTimeInput(value: string): string {
  const label = timeZoneLabel();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value))
    throw new Error(`Choose a valid date and time (${label}).`);
  const normalized = value.length === 16 ? `${value}:00` : value;
  const nominal = new Date(`${normalized}Z`);
  if (!Number.isFinite(nominal.getTime()) || nominal.toISOString().slice(0, 19) !== normalized)
    throw new Error(`Choose a valid date and time (${label}).`);
  const day = 24 * 60 * 60 * 1000;
  const offsets = new Set([offsetAt(nominal.getTime() - day), offsetAt(nominal.getTime() + day)]);
  const candidates = [...offsets]
    .map((offset) => new Date(nominal.getTime() - offset).toISOString())
    .filter((candidate) => centralDateTimeInput(candidate) === normalized)
    .sort();
  if (candidates.length > 1)
    throw new Error(
      `This ${label} time occurs twice when daylight saving time ends. Choose a time outside the repeated hour.`,
    );
  if (!candidates.length)
    throw new Error(`This ${label} time does not exist when daylight saving time starts. Choose another time.`);
  return candidates[0]!;
}
