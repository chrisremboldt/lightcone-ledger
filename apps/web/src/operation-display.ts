import type { FlightSummary } from '@ledger/contracts';
import { ctDay, ctDayName, shortTime, timeZoneLabel } from './format.js';

export type OperationView = 'monitor' | 'overdue' | 'historical-issues' | 'history';

export const operationViews: { view: Exclude<OperationView, 'history'>; label: string; description: string }[] = [
  {
    view: 'monitor',
    label: 'Current',
    description: 'Recent reported activity, usable plans and work that needs planning.',
  },
  { view: 'overdue', label: 'Overdue', description: 'Elapsed plans and unconfirmed flight outcomes need disposition.' },
  {
    view: 'historical-issues',
    label: 'Historical issues',
    description: 'Earlier landed or cancelled flights with unresolved findings or record signals.',
  },
];

export function operationTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) return;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== value.slice(0, 19)) return;
  return value;
}

export function awaitingOrderStatus(
  payload: Record<string, unknown>,
  readAt: string,
  view: 'awaiting-current' | 'awaiting-overdue',
) {
  const start = operationTimestamp(payload.scheduledStart);
  const end = operationTimestamp(payload.scheduledEnd);
  const readTime = operationTimestamp(readAt);
  if (
    view === 'awaiting-current' &&
    start &&
    end &&
    readTime &&
    Date.parse(start) > Date.parse(readTime) &&
    Date.parse(end) > Date.parse(start)
  )
    return 'Upcoming · awaiting dispatch';
  return 'No flight linked';
}

export function operationWindow(start?: string, end?: string) {
  if (!start && !end) return null;
  const at = (value: string) => `${ctDayName(value)} ${shortTime(value)}`;
  if (!start) return `By ${at(end!)} ${timeZoneLabel()}`;
  if (!end) return `From ${at(start)} ${timeZoneLabel()}`;
  return `${at(start)}–${ctDay(start) === ctDay(end) ? shortTime(end) : at(end)} ${timeZoneLabel()}`;
}

export function operationDisplay(flight: FlightSummary) {
  const operation = flight.operation;
  const requested = operationWindow(flight.scheduledStart, flight.scheduledEnd);
  if (!operation)
    return { reason: null, windowLabel: 'Requested window', window: requested, requested: null, mission: null };

  const reasons = {
    'reported-active': 'Recent airborne report',
    'plan-window': 'Planned work',
    'needs-planning': 'Needs planning · no usable window',
    'window-elapsed': 'Plan window elapsed · needs disposition',
    'status-unconfirmed': 'Current flight status unconfirmed',
    'plan-unconfirmed': 'Mission plan unconfirmed',
    'terminal-issues': 'Earlier flight · unresolved issues',
    terminal: 'Recorded flight',
  };
  const { mission } = operation;
  const accepted = mission.accepted;
  const projected = mission.projected;
  const current =
    mission.state === 'current' &&
    accepted &&
    projected &&
    accepted.id === projected.id &&
    accepted.sourceRevision === projected.sourceRevision &&
    accepted.operatingInterval.start === projected.operatingInterval.start &&
    accepted.operatingInterval.end === projected.operatingInterval.end &&
    operation.window?.basis === 'mission' &&
    operation.window.start === accepted.operatingInterval.start &&
    operation.window.end === accepted.operatingInterval.end;
  const window =
    mission.state === 'none' && operation.window?.basis === 'requested'
      ? operation.window
      : current
        ? operation.window
        : null;
  const missionLabel = {
    none: null,
    current: current ? `Mission revision ${accepted!.sourceRevision}` : 'Mission window unconfirmed',
    pending: accepted ? `Mission revision ${accepted.sourceRevision} pending` : 'Mission pending',
    processing: accepted ? `Mission revision ${accepted.sourceRevision} processing` : 'Mission processing',
    failed: accepted
      ? `Mission revision ${accepted.sourceRevision} needs source review`
      : 'Mission needs source review',
  }[mission.state];
  return {
    reason:
      operation.reason === 'reported-active' && window?.end && Date.parse(window.end) <= Date.parse(operation.asOf)
        ? 'Window elapsed · still reporting airborne'
        : reasons[operation.reason],
    windowLabel: window?.basis === 'mission' ? 'Current mission window' : 'Requested window',
    window: window ? operationWindow(window.start, window.end) : null,
    requested: mission.state === 'none' ? null : requested,
    mission: missionLabel,
  };
}
