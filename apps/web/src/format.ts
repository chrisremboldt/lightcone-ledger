import { ApiError } from '@ledger/contracts/client';
import type { ErrorResponse, InputCut } from '@ledger/contracts';

/**
 * Every screen shows times in the organization's zone, read with the signed-in person. Until it is read, and for a
 * recording made before the organization's zone was returned, times are shown in the zone the fictional
 * organizations declare.
 */
const recordedZone = 'America/Chicago';
let zone = recordedZone;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(options: Intl.DateTimeFormatOptions, locale = 'en-US'): Intl.DateTimeFormat {
  const key = `${locale}|${zone}|${JSON.stringify(options)}`;
  let found = formatters.get(key);
  if (!found) {
    found = new Intl.DateTimeFormat(locale, { ...options, timeZone: zone });
    formatters.set(key, found);
  }
  return found;
}

function knownZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Sets the organization's zone; an absent or unknown zone leaves the current one. */
export function setTimeZone(value?: string | null) {
  if (value && knownZone(value)) zone = value;
}
export function timeZone() {
  return zone;
}
/** The zone's short name, as in "CT"; the zone's own name where it has no short one. */
export function timeZoneLabel() {
  if (zone === 'UTC' || zone === 'Etc/UTC') return 'UTC';
  const generic = formatter({ timeZoneName: 'shortGeneric' })
    .formatToParts(0)
    .find((part) => part.type === 'timeZoneName')?.value;
  return generic && !/\s/.test(generic) ? generic : zone;
}
/** The short name with the zone's name, as in "CT (America/Chicago)", for a field a person types a time into. */
export function timeZoneName() {
  const label = timeZoneLabel();
  return label === zone ? zone : `${label} (${zone})`;
}

function yearOf(value: number | Date) {
  return formatter({ year: 'numeric' }).format(value);
}
function inCurrentYear(date: Date) {
  return yearOf(date) === yearOf(Date.now());
}
function clock(date: Date, withDate: boolean, withYear: boolean) {
  return formatter({
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    ...(withDate ? { month: 'short', day: '2-digit' } : {}),
    ...(withDate && withYear ? { year: 'numeric' } : {}),
  }).format(date);
}
function instant(value?: string) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

/** A time in the organization's zone; with its date, and the year when it is not this year. */
export function time(value?: string, includeDate = false) {
  const date = instant(value);
  if (!date) return '—';
  return clock(date, includeDate, includeDate && !inCurrentYear(date));
}
/**
 * Two times with their dates and the zone. Both show their year when the years differ or neither is this year, so a
 * range a year long never reads as one day.
 */
/** Whether an interval's end stands for no end: Ledger records an interval with no end date as ending in the year 9999. */
export function noEndDate(end?: string | null): boolean {
  const until = instant(end ?? undefined);
  return Boolean(until && until.getUTCFullYear() >= 9999);
}
export function timeRange(start: string, end: string) {
  const from = instant(start);
  const until = instant(end);
  if (from && noEndDate(end))
    return `${clock(from, true, !inCurrentYear(from))} ${timeZoneLabel()} onward, with no end date`;
  if (!from || !until) return `${time(start, true)} to ${time(end, true)} ${timeZoneLabel()}`;
  const withYear = yearOf(from) !== yearOf(until) || !inCurrentYear(from);
  return `${clock(from, true, withYear)} to ${clock(until, true, withYear)} ${timeZoneLabel()}`;
}
export function shortTime(value?: string) {
  return time(value).slice(0, 5);
}
export function ctDay(value: string | number) {
  return formatter({ year: 'numeric', month: '2-digit', day: '2-digit' }, 'en-CA').format(new Date(value));
}
/** Weekday, month and day, and the year when it is not this year. */
export function ctDayName(value: string | number) {
  const date = new Date(value);
  return formatter({
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(inCurrentYear(date) ? {} : { year: 'numeric' }),
  })
    .format(date)
    .replace(',', '');
}
export function dayTime(value?: string) {
  return value ? `${ctDayName(value).split(' ')[0]} ${time(value)} ${timeZoneLabel()}` : '—';
}
export function age(value?: string) {
  if (!value) return 'No receipt';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  return seconds < 60
    ? `${seconds}s ago`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m ago`
      : `${Math.floor(seconds / 3600)}h ago`;
}
export function shortId(value: string) {
  return value.length > 25 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}
export function sentence(value: string) {
  return value.replaceAll('_', ' ').replaceAll('.', ' / ');
}
export function byteSize(value: number) {
  if (value < 1024) return `${value} B`;
  return value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`;
}
export function errorMessage(error: unknown) {
  if (error instanceof ApiError) {
    const response = error.body as Partial<ErrorResponse>;
    return response?.error?.message ?? `Request failed (${error.status}). Check API access and retry.`;
  }
  return error instanceof Error
    ? error.message
    : 'The request could not be completed. Retry when the API is available.';
}
export function cutSize(cut: InputCut) {
  return Object.values(cut.streams).reduce((sum, sequence) => sum + sequence, 0);
}
export function json(value: unknown) {
  return JSON.stringify(value, null, 2);
}

/**
 * A count with its words, singular for one and plural otherwise: "0 rules", "1 rule", "2 rules"; "1 finding is",
 * "2 findings are". Every count the app writes beside its noun is written with this.
 */
export function counted(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
