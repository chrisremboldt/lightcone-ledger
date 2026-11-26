import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeWrittenAt } from '../../packages/contracts/src/operator-record-import.js';
import { setTimeZone } from '../../apps/web/src/format.js';
import {
  limitationText,
  recordHeadline,
  recordTime,
  type RecordTypeSummary,
} from '../../apps/web/src/operator-records.js';

const day = { day: '2026-11-20', timeZone: 'America/Chicago', nextDayAt: '2026-11-21T06:00:00.000Z' };

describe('a record’s times on screen', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-26T12:00:00Z'));
    setTimeZone('America/Chicago');
  });
  afterEach(() => vi.useRealTimers());

  it('shows a time placed by a date alone as that date, never as midnight', () => {
    const record = {
      occurredAt: '2026-11-20T06:00:00.000Z',
      record: { checkedOn: '2026-11-20T06:00:00.000Z' },
      dayOnly: { checkedOn: day },
    };
    expect(recordTime(record)).toBe('as of 2026-11-20 (date only)');
    expect(recordTime(record, { asOf: false })).toBe('2026-11-20 (date only)');
    expect(recordTime({ ...record, dayOnly: undefined })).toBe('as of Nov 20, 00:00:00 CT');
    const type = {
      title: 'Battery check',
      fields: [{ name: 'checkedOn', label: 'Checked on', kind: 'date_time', required: true }],
      columns: [],
    } as unknown as RecordTypeSummary;
    expect(recordHeadline(type, record.record, record.dayOnly)).toBe('2026-11-20 (date only)');
  });

  it('shows the time a device says it wrote a record in the organization’s time zone', () => {
    expect(limitationText(describeWrittenAt('2026-11-26T08:15:30.000Z'))).toBe(
      'Written at Nov 26, 02:15:30 CT by the clock of the device it was entered on; Ledger does not check that clock.',
    );
    const conversion =
      'Takeoff at was entered as 2026-11-25T09:30 in America/Chicago and recorded as 2026-11-25T15:30:00Z.';
    expect(limitationText(conversion)).toBe(conversion);
  });
});
