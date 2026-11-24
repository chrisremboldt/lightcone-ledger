import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ctDay,
  ctDayName,
  dayTime,
  setTimeZone,
  time,
  timeRange,
  timeZone,
  timeZoneLabel,
  timeZoneName,
} from '../../apps/web/src/format.js';
import { centralDateTimeInput, fromCentralDateTimeInput } from '../../apps/web/src/sms-document-dates.js';

describe("times in the organization's zone", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T12:00:00Z'));
  });
  afterEach(() => {
    setTimeZone('America/Chicago');
    vi.useRealTimers();
  });

  it('shows a time and its short zone label in each organization’s zone', () => {
    setTimeZone('America/Chicago');
    expect(time('2026-11-21T23:33:09Z', true)).toBe('Nov 21, 17:33:09');
    expect(timeZoneLabel()).toBe('CT');
    expect(timeZoneName()).toBe('CT (America/Chicago)');
    expect(dayTime('2026-11-21T23:33:09Z')).toBe('Sat 17:33:09 CT');
    setTimeZone('Europe/Berlin');
    expect(timeZone()).toBe('Europe/Berlin');
    expect(time('2026-11-21T23:33:09Z', true)).toBe('Nov 22, 00:33:09');
    expect(timeZoneLabel()).toBe('Europe/Berlin');
    expect(timeZoneName()).toBe('Europe/Berlin');
    setTimeZone('UTC');
    expect(timeZoneLabel()).toBe('UTC');
    setTimeZone('Nowhere/Zone');
    expect(timeZone()).toBe('UTC');
  });

  it('shows the year of a date outside the current year, on whichever side of the boundary each zone puts it', () => {
    const newYear = '2027-01-01T03:00:00Z';
    setTimeZone('America/Chicago');
    expect(time(newYear, true)).toBe('Dec 31, 21:00:00');
    expect(ctDay(newYear)).toBe('2026-12-31');
    expect(ctDayName(newYear)).toBe('Thu Dec 31');
    setTimeZone('Europe/Berlin');
    expect(time(newYear, true)).toBe('Jan 01, 2027, 04:00:00');
    expect(ctDay(newYear)).toBe('2027-01-01');
    expect(ctDayName(newYear)).toBe('Fri Jan 1, 2027');
    expect(time(newYear)).toBe('04:00:00');
  });

  it('shows the year on both ends of a range across years, or of one outside the current year', () => {
    setTimeZone('America/Chicago');
    expect(timeRange('2026-11-21T23:33:09Z', '2027-11-21T23:33:09Z')).toBe(
      'Nov 21, 2026, 17:33:09 to Nov 21, 2027, 17:33:09 CT',
    );
    expect(timeRange('2025-02-01T18:00:00Z', '2025-03-01T18:00:00Z')).toBe(
      'Feb 01, 2025, 12:00:00 to Mar 01, 2025, 12:00:00 CT',
    );
    expect(timeRange('2026-02-01T18:00:00Z', '2026-03-01T18:00:00Z')).toBe('Feb 01, 12:00:00 to Mar 01, 12:00:00 CT');
    // The same instants fall in different years in another zone.
    setTimeZone('Asia/Tokyo');
    expect(timeRange('2026-12-31T14:30:00Z', '2026-12-31T16:00:00Z')).toBe(
      `Dec 31, 2026, 23:30:00 to Jan 01, 2027, 01:00:00 ${timeZoneLabel()}`,
    );
  });

  it('follows each zone across its own daylight-saving change', () => {
    setTimeZone('America/Chicago');
    expect(time('2026-03-08T07:59:59Z')).toBe('01:59:59');
    expect(time('2026-03-08T08:00:00Z')).toBe('03:00:00');
    expect(fromCentralDateTimeInput('2026-07-01T12:00')).toBe('2026-07-01T17:00:00.000Z');
    expect(() => fromCentralDateTimeInput('2026-03-08T02:30')).toThrow('does not exist');
    setTimeZone('Europe/Berlin');
    expect(time('2026-03-29T00:59:59Z')).toBe('01:59:59');
    expect(time('2026-03-29T01:00:00Z')).toBe('03:00:00');
    expect(fromCentralDateTimeInput('2026-07-01T12:00')).toBe('2026-07-01T10:00:00.000Z');
    expect(fromCentralDateTimeInput('2026-01-15T12:00')).toBe('2026-01-15T11:00:00.000Z');
    expect(centralDateTimeInput('2026-07-01T10:00:00.000Z')).toBe('2026-07-01T12:00:00');
    expect(() => fromCentralDateTimeInput('2026-03-29T02:30')).toThrow('does not exist');
    expect(() => fromCentralDateTimeInput('2026-10-25T02:30')).toThrow('occurs twice');
    setTimeZone('Australia/Sydney');
    expect(() => fromCentralDateTimeInput('2026-04-05T02:30')).toThrow('occurs twice');
    expect(() => fromCentralDateTimeInput('2026-10-04T02:30')).toThrow('does not exist');
  });
});
