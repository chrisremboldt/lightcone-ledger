import { describe, expect, it } from 'vitest';
import type { FlightSummary } from '@ledger/contracts';
import { activityPresentation, flightWindow } from '../../apps/web/src/labels.js';
import {
  awaitingOrderStatus,
  operationDisplay,
  operationTimestamp,
  operationWindow,
} from '../../apps/web/src/operation-display.js';

const requested = { start: '2026-10-16T14:00:00.000Z', end: '2026-10-16T15:00:00.000Z' };
const interval = { start: '2026-10-17T14:00:00.000Z', end: '2026-10-17T15:00:00.000Z' };
const head = { id: 'mission-2', sourceRevision: 2, operatingInterval: interval };
const flight: FlightSummary = {
  id: 'flight',
  label: 'Clinic delivery',
  originationKey: 'delivery',
  revision: 1,
  basisRevision: 1,
  activity: 'active',
  coverage: 'partial',
  scheduledStart: requested.start,
  scheduledEnd: requested.end,
  orderIds: [],
  sourceIds: [],
  unresolvedCount: 0,
  conflictCount: 0,
  outstandingWork: 0,
  operation: {
    scope: 'current',
    asOf: '2026-10-17T14:30:00.000Z',
    reason: 'reported-active',
    window: { basis: 'mission', ...interval },
    mission: { state: 'current', accepted: head, projected: head },
    activityReport: {
      activity: 'active',
      occurredAt: '2026-10-17T14:29:30.000Z',
      receivedAt: '2026-10-17T14:30:00.000Z',
    },
  },
};

describe('operation presentation', () => {
  it('uses the server read clock to identify an upcoming order without implying dispatch readiness', () => {
    const payload = { scheduledStart: interval.start, scheduledEnd: interval.end };
    const beforeStart = '2026-10-17T13:45:00.000Z';
    expect(awaitingOrderStatus(payload, beforeStart, 'awaiting-current')).toBe('Upcoming · awaiting dispatch');
    expect(awaitingOrderStatus(payload, interval.start, 'awaiting-current')).toBe('No flight linked');
    expect(awaitingOrderStatus(payload, beforeStart, 'awaiting-overdue')).toBe('No flight linked');
    expect(awaitingOrderStatus(payload, 'unavailable', 'awaiting-current')).toBe('No flight linked');
    expect(
      awaitingOrderStatus(
        { scheduledStart: interval.end, scheduledEnd: interval.start },
        beforeStart,
        'awaiting-current',
      ),
    ).toBe('No flight linked');
  });

  it('keeps the confirmed mission window separate from the requested calendar day', () => {
    expect(operationDisplay(flight)).toMatchObject({
      windowLabel: 'Current mission window',
      window: operationWindow(interval.start, interval.end),
      requested: operationWindow(requested.start, requested.end),
      mission: 'Mission revision 2',
    });
    expect(operationWindow(requested.start, interval.end)).toContain('Sat Oct 17');
    expect(flightWindow({ ...flight, scheduledStart: undefined, scheduledEnd: interval.end })).toBe(
      'By Sat Oct 17 10:00',
    );
    expect(flightWindow({ ...flight, scheduledStart: requested.start, scheduledEnd: interval.end })).toContain(
      'Sat Oct 17',
    );
    expect(operationTimestamp('2026-02-30T15:00:00Z')).toBeUndefined();
    expect(operationTimestamp('2026-10-17T14:00:00.123456Z')).toBe('2026-10-17T14:00:00.123456Z');
    expect(activityPresentation(flight, Date.parse(flight.operation!.asOf)).label).toBe('Reported airborne');
    expect(
      operationDisplay({
        ...flight,
        operation: {
          ...flight.operation!,
          asOf: '2026-10-17T15:01:00.000Z',
          activityReport: { ...flight.operation!.activityReport!, occurredAt: '2026-10-17T15:00:30.000Z' },
        },
      }).reason,
    ).toBe('Window elapsed · still reporting airborne');
  });

  it('does not present an older projected or requested window as a pending mission window', () => {
    const operation = flight.operation!;
    const pending = {
      ...flight,
      operation: {
        ...operation,
        reason: 'plan-unconfirmed' as const,
        window: null,
        mission: {
          state: 'processing' as const,
          accepted: { ...head, id: 'mission-3', sourceRevision: 3 },
          projected: head,
        },
      },
    };
    expect(operationDisplay(pending)).toMatchObject({
      window: null,
      requested: operationWindow(requested.start, requested.end),
      mission: 'Mission revision 3 processing',
    });
    expect(
      operationDisplay({
        ...pending,
        operation: { ...pending.operation, mission: { ...pending.operation.mission, state: 'current' } },
      }).window,
    ).toBeNull();
  });

  it('uses the canonical physical-position clock and rejects future witnesses without inferring an outcome', () => {
    const old = {
      ...flight,
      lastReceivedAt: flight.operation!.asOf,
      picture: {
        lastPosition: {
          latitude: 41.88,
          longitude: -87.63,
          occurredAt: flight.operation!.asOf,
          receivedAt: flight.operation!.asOf,
        },
      },
      operation: {
        ...flight.operation!,
        scope: 'overdue' as const,
        reason: 'status-unconfirmed' as const,
        activityReport: { ...flight.operation!.activityReport!, occurredAt: '2026-10-16T14:29:30.000Z' },
      },
    };
    expect(activityPresentation(old, Date.parse(old.operation.asOf))).toMatchObject({
      current: false,
      label: 'Last reported airborne',
      observedAt: '2026-10-16T14:29:30.000Z',
    });
    expect(operationDisplay(old).reason).toContain('unconfirmed');
    const positioned = {
      ...old,
      operation: {
        ...old.operation,
        scope: 'current' as const,
        reason: 'reported-active' as const,
        positionOccurredAt: old.operation.asOf,
      },
    };
    expect(activityPresentation(positioned, Date.parse(positioned.operation.asOf))).toMatchObject({
      current: true,
      label: 'Reported airborne',
      observedAt: positioned.operation.positionOccurredAt,
    });
    expect(
      activityPresentation(
        { ...positioned, operation: { ...positioned.operation, positionOccurredAt: '2026-10-17T14:31:00.000Z' } },
        Date.parse(positioned.operation.asOf),
      ),
    ).toMatchObject({ current: false, observedAt: old.operation.activityReport.occurredAt });
    expect(old.activity).toBe('active');
  });
});
