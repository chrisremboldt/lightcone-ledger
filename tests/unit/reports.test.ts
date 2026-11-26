import { describe, expect, it } from 'vitest';
import {
  actionsOpenAt,
  checkPeriod,
  findingsByMonth,
  hazardLevels,
  monthBefore,
  monthsBetween,
} from '../../packages/domain/src/reports.js';
import type { SettledAction } from '../../packages/domain/src/sms-assurance.js';
import { addMonths, hoursAndMinutes, lastDayOf, periodChoices } from '../../apps/web/src/report-periods.js';

describe('the periods a report covers', () => {
  it('takes two calendar days in order, at most two years', () => {
    expect(() => checkPeriod({ from: '2026-01-01', until: '2026-12-31' })).not.toThrow();
    expect(() => checkPeriod({ from: '2026-02-29', until: '2026-03-01' })).toThrow(/not a calendar date/);
    expect(() => checkPeriod({ from: '2026-03-02', until: '2026-03-01' })).toThrow(/comes before/);
    expect(() => checkPeriod({ from: '2020-01-01', until: '2026-01-01' })).toThrow(/at most 731 days/);
  });

  it('counts months across a year’s end', () => {
    expect(monthsBetween('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(monthsBetween('2026-05', '2026-05')).toEqual(['2026-05']);
    expect(monthBefore('2026-03', 11)).toBe('2025-04');
    expect(monthBefore('2026-01', 1)).toBe('2025-12');
  });

  it('offers this month, last month, this year and last year from the organization’s day', () => {
    expect(periodChoices('2026-03-14')).toEqual([
      { label: 'This month', from: '2026-03-01', until: '2026-03-31' },
      { label: 'Last month', from: '2026-02-01', until: '2026-02-28' },
      { label: 'This year', from: '2026-01-01', until: '2026-12-31' },
      { label: 'Last year', from: '2025-01-01', until: '2025-12-31' },
    ]);
    expect(periodChoices('2026-01-05')[1]).toEqual({ label: 'Last month', from: '2025-12-01', until: '2025-12-31' });
    expect(lastDayOf('2028-02')).toBe('2028-02-29');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2025-12', 13)).toBe('2027-01');
  });

  it('writes recorded flight time as hours and whole minutes', () => {
    expect(hoursAndMinutes(5400)).toBe('1 h 30 min');
    expect(hoursAndMinutes(59)).toBe('0 h 00 min');
    expect(hoursAndMinutes(45_300)).toBe('12 h 35 min');
  });
});

describe('counting what stood at the end of a period', () => {
  const action = (setAt: string, dueOn: string, closedAt?: string) =>
    ({
      action: { id: `action-${setAt}-${dueOn}`, what: 'Fictional action', ownerId: 'person-1', dueOn, findingId: null },
      setIn: { versionNumber: 1, bodyDigest: 'a'.repeat(64) },
      setAt,
      closed: closedAt ? ({ recordedAt: closedAt } as SettledAction['closed']) : null,
    }) as SettledAction;

  it('counts an action open when it was set before the instant and not closed by then; overdue when due before its day', () => {
    const asOf = new Date('2026-04-01T06:00:00Z');
    const counted = actionsOpenAt(
      [
        action('2026-03-01T00:00:00Z', '2026-03-15'),
        action('2026-03-01T00:00:00Z', '2026-04-01'),
        action('2026-03-01T00:00:00Z', '2026-03-10', '2026-03-20T00:00:00Z'),
        action('2026-03-01T00:00:00Z', '2026-03-10', '2026-04-02T00:00:00Z'),
        action('2026-04-02T00:00:00Z', '2026-03-10'),
      ],
      asOf,
      '2026-04-01',
    );
    expect(counted).toEqual({ open: 3, overdue: 2 });
  });

  it('counts open hazards by level, least serious first, the matrix naming each level', () => {
    const levels = [
      { id: 'low', label: 'Low' },
      { id: 'medium', label: 'Medium' },
      { id: 'high', label: 'High' },
    ];
    expect(
      hazardLevels([
        { closed: false, level: 'high', levels },
        { closed: false, level: 'low', levels },
        { closed: false, level: 'high', levels },
        { closed: true, level: 'medium', levels },
        { closed: false, level: null, levels: [] },
      ]),
    ).toEqual({
      levels: [
        { level: 'low', label: 'Low', count: 1 },
        { level: 'high', label: 'High', count: 2 },
      ],
      notAssessed: 1,
      total: 4,
    });
  });

  it('lays out counts by rule and month in the order of the months, with their totals', () => {
    const shaped = findingsByMonth(
      [
        {
          pack_id: 'ledger.part107',
          leaf_id: 'rule-b',
          rule_title: 'Rule B',
          pack_version: null,
          month: '2026-02',
          opened: '2',
          closed: '0',
        },
        {
          pack_id: 'ledger.part107',
          leaf_id: 'rule-a',
          rule_title: 'Rule A',
          pack_version: null,
          month: '2026-01',
          opened: '1',
          closed: '1',
        },
        {
          pack_id: 'ledger.part107',
          leaf_id: 'rule-a',
          rule_title: 'Rule A',
          pack_version: null,
          month: '2026-03',
          opened: '0',
          closed: '2',
        },
        {
          pack_id: 'ledger.part107',
          leaf_id: 'rule-a',
          rule_title: 'Rule A',
          pack_version: null,
          month: '2025-12',
          opened: '9',
          closed: '9',
        },
      ],
      ['2026-01', '2026-02', '2026-03'],
      () => 'Fictional pack',
    );
    expect(shaped.rules.map((rule) => [rule.ruleId, rule.opened, rule.closed])).toEqual([
      ['rule-a', [1, 0, 0], [1, 0, 2]],
      ['rule-b', [0, 2, 0], [0, 0, 0]],
    ]);
    expect(shaped.total).toEqual({ opened: [1, 2, 0], closed: [1, 0, 2] });
  });
});
