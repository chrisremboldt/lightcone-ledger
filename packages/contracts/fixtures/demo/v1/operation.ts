import type { FlightOperationSummary } from '../../../src/operation.js';

const originalPlan = {
  id: 'demo-mission-revision-1',
  sourceRevision: 1,
  operatingInterval: { start: '2026-10-17T16:00:00.000Z', end: '2026-10-17T16:05:00.000Z' },
};
const revisedPlan = {
  id: 'demo-mission-revision-2',
  sourceRevision: 2,
  operatingInterval: { start: '2026-10-17T16:15:00.000Z', end: '2026-10-17T16:20:00.000Z' },
};

export const currentOperation: FlightOperationSummary = {
  scope: 'current',
  asOf: '2026-10-17T16:10:00.000Z',
  reason: 'plan-window',
  window: { basis: 'mission', ...revisedPlan.operatingInterval },
  mission: { state: 'current', accepted: revisedPlan, projected: revisedPlan },
};

export const overdueOperation: FlightOperationSummary = {
  scope: 'overdue',
  asOf: '2026-10-17T16:10:00.000Z',
  reason: 'status-unconfirmed',
  window: { basis: 'mission', ...originalPlan.operatingInterval },
  mission: { state: 'current', accepted: originalPlan, projected: originalPlan },
  activityReport: {
    activity: 'active',
    occurredAt: '2026-10-17T16:01:00.000Z',
    receivedAt: '2026-10-17T16:01:01.000Z',
  },
};

export const pendingOperation: FlightOperationSummary = {
  scope: 'overdue',
  asOf: '2026-10-17T16:10:00.000Z',
  reason: 'plan-unconfirmed',
  window: null,
  mission: { state: 'pending', accepted: revisedPlan, projected: originalPlan },
};

export const historicalIssueOperation: FlightOperationSummary = {
  scope: 'historical-issues',
  asOf: '2026-10-17T16:10:00.000Z',
  reason: 'terminal-issues',
  window: { basis: 'requested', ...originalPlan.operatingInterval },
  mission: { state: 'none' },
  activityReport: {
    activity: 'landed',
    occurredAt: '2026-10-17T16:04:30.000Z',
    receivedAt: '2026-10-17T16:04:31.000Z',
  },
};
