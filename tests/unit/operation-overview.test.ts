import { describe, expect, it } from 'vitest';
import type { FlightOperationSummary, FlightSummary } from '@ledger/contracts';
import { operationOverview } from '../../apps/web/src/operation-overview.js';
import type { OperationView } from '../../apps/web/src/operation-display.js';

const asOf = '2026-10-17T16:10:00.000Z';
const recent = '2026-10-17T16:09:30.000Z';
const earlier = '2026-10-17T15:00:00.000Z';

function flight(
  id: string,
  activity: FlightSummary['activity'],
  scope: FlightOperationSummary['scope'],
  reason: FlightOperationSummary['reason'],
): FlightSummary {
  return {
    id,
    label: id,
    originationKey: id,
    revision: 1,
    basisRevision: 1,
    activity,
    coverage: 'partial',
    orderIds: [],
    sourceIds: [],
    unresolvedCount: 0,
    conflictCount: 0,
    outstandingWork: 0,
    operation: {
      scope,
      reason,
      asOf,
      window: null,
      mission: { state: 'none' },
      ...(activity === 'unknown' ? {} : { activityReport: { activity, occurredAt: recent, receivedAt: asOf } }),
    },
  };
}

describe('loaded operation overview', () => {
  it('counts current page records once and requires a canonical physical witness for recent activity', () => {
    const airborne = flight('airborne', 'active', 'current', 'reported-active');
    const positioned = flight('positioned', 'active', 'current', 'reported-active');
    positioned.operation!.activityReport!.occurredAt = earlier;
    positioned.operation!.positionOccurredAt = recent;
    const planned = flight('planned', 'planned', 'current', 'plan-window');
    planned.operation!.window = { basis: 'requested', start: asOf, end: '2026-10-17T16:20:00.000Z' };
    const unplanned = flight('unplanned', 'unknown', 'current', 'needs-planning');
    const sourceReview = flight('source-review', 'planned', 'current', 'plan-unconfirmed');
    sourceReview.operation!.mission.state = 'pending';
    const old = flight('old', 'active', 'current', 'reported-active');
    old.operation!.activityReport!.occurredAt = earlier;
    old.lastReceivedAt = asOf;
    old.picture = { lastPosition: { latitude: 41.88, longitude: -87.63, occurredAt: recent, receivedAt: asOf } };
    const missing = { ...old, id: 'missing', operation: undefined };
    const page = [airborne, positioned, planned, unplanned, sourceReview, old, missing];

    const rows = operationOverview(page, 'monitor');
    expect(rows).toEqual([
      { key: 'airborne', label: 'Recent airborne reports', count: 2 },
      { key: 'planned', label: 'Planned work', count: 1 },
      { key: 'planning', label: 'Needs planning or source review', count: 2 },
      { key: 'other', label: 'Other records shown', count: 2 },
    ]);
    expect(rows.reduce((count, row) => count + row.count, 0)).toBe(page.length);
    expect(operationOverview([planned], 'monitor')).toEqual([{ key: 'planned', label: 'Planned work', count: 1 }]);
    expect(operationOverview([], 'monitor')).toEqual([]);
  });

  it('separates overdue outcomes, retained terminal issues and clean recorded history without double counting', () => {
    const overduePlan = flight('elapsed', 'planned', 'overdue', 'window-elapsed');
    const unconfirmed = flight('unconfirmed', 'active', 'overdue', 'status-unconfirmed');
    unconfirmed.operation!.activityReport!.occurredAt = earlier;
    const pending = flight('pending', 'planned', 'overdue', 'plan-unconfirmed');
    pending.operation!.mission.state = 'failed';
    const findings = flight('findings', 'landed', 'historical-issues', 'terminal-issues');
    findings.findingSummary = { openCount: 2, unownedCount: 1 };
    findings.unresolvedCount = 3;
    const signals = flight('signals', 'cancelled', 'historical-issues', 'terminal-issues');
    signals.unresolvedCount = 1;
    const landed = flight('landed', 'landed', 'history', 'terminal');
    const cancelled = flight('cancelled', 'cancelled', 'history', 'terminal');
    const cases: { view: OperationView; page: FlightSummary[]; expected: { key: string; count: number }[] }[] = [
      {
        view: 'overdue',
        page: [overduePlan, unconfirmed, pending, landed],
        expected: [
          { key: 'disposition', count: 1 },
          { key: 'outcome', count: 1 },
          { key: 'mission', count: 1 },
          { key: 'other', count: 1 },
        ],
      },
      {
        view: 'historical-issues',
        page: [findings, signals, overduePlan],
        expected: [
          { key: 'findings', count: 1 },
          { key: 'signals', count: 1 },
          { key: 'other', count: 1 },
        ],
      },
      {
        view: 'history',
        page: [landed, cancelled, findings],
        expected: [
          { key: 'landed', count: 1 },
          { key: 'cancelled', count: 1 },
          { key: 'other', count: 1 },
        ],
      },
    ];
    for (const { view, page, expected } of cases) {
      const rows = operationOverview(page, view);
      expect(rows.map(({ key, count }) => ({ key, count }))).toEqual(expected);
      expect(rows.reduce((count, row) => count + row.count, 0)).toBe(page.length);
    }
  });
});
