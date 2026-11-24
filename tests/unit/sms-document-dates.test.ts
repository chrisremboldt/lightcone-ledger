import { describe, expect, it } from 'vitest';
import { centralDateTimeInput, documentTime, fromCentralDateTimeInput } from '../../apps/web/src/sms-document-dates.js';

describe('document source and effective dates', () => {
  it('retains a source date without inventing a time or changing its day', () => {
    expect(documentTime('2026-10-23')).toBe('Oct 23, 2026');
  });

  it('converts unambiguous input in the organization zone, in standard and daylight time', () => {
    expect(fromCentralDateTimeInput('2026-01-23T08:30')).toBe('2026-01-23T14:30:00.000Z');
    expect(fromCentralDateTimeInput('2026-10-23T08:30:24')).toBe('2026-10-23T13:30:24.000Z');
    expect(centralDateTimeInput('2026-10-23T13:30:24.000Z')).toBe('2026-10-23T08:30:24');
  });

  it('rejects both an ambiguous repeated hour and a nonexistent hour', () => {
    expect(() => fromCentralDateTimeInput('2026-11-01T01:30')).toThrow('occurs twice');
    expect(() => fromCentralDateTimeInput('2026-03-08T02:30')).toThrow('does not exist');
    expect(() => fromCentralDateTimeInput('2026-02-30T08:30')).toThrow('valid date and time');
  });
});
