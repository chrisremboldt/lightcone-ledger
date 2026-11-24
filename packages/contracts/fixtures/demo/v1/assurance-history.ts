import { canonicalDigest } from '../../../../integrity/src/index.js';
import type {
  AssuranceHistoryPage,
  HazardMonitoringHistoryQuery,
  HazardMonitoringHistoryResponse,
  MonitoringWindowSummary,
} from '../../../src/assurance-history.js';
import type { MonitoringRecordV2 } from '../../../src/monitoring-window.js';
import {
  monitoringRecordV2,
  monitoringRecordV2Revision2,
  monitoringRevision2OriginalBytesBase64,
} from './monitoring-window.js';

const control = monitoringRecordV2.source.control;
const scope = {
  hazardId: control.hazardId,
  controlEventId: control.controlEventId,
  controlDigest: control.controlDigest,
};
const readAt = '2026-10-15T14:20:07Z';
const terminalPage = {
  limit: 25,
  returned: 1,
  hasMore: false,
  nextCursor: null,
  selection: 'initial',
  order: 'recorded_descending',
  consistency: 'accepted_history',
} satisfies AssuranceHistoryPage;

function monitoringSummary(record: MonitoringRecordV2): MonitoringWindowSummary {
  return {
    id: record.id,
    digest: canonicalDigest(record),
    occurredAt: record.source.occurredAt,
    recordedAt: record.recordedAt,
    sourceId: record.sourceId,
    sourceSessionId: record.source.sourceSessionId,
    sourceWindowId: record.source.sourceWindowId,
    sourceRevision: record.source.sourceRevision,
    window: { ...record.source.window },
  };
}

export const monitoringRevision2 = {
  record: monitoringRecordV2Revision2,
  originalBytesBase64: monitoringRevision2OriginalBytesBase64,
};
const firstMonitoring = monitoringSummary(monitoringRecordV2);
const secondMonitoring = monitoringSummary(monitoringRevision2.record);
const monitoringCursor = 'fixture-monitoring-continuation';

export const hazardMonitoringHistoryQuery = {
  controlEventId: control.controlEventId,
  limit: 1,
} satisfies HazardMonitoringHistoryQuery;

export const hazardMonitoringHistory = {
  ...scope,
  monitoring: [secondMonitoring],
  page: { ...terminalPage, limit: 1, hasMore: true, nextCursor: monitoringCursor },
  readAt,
} satisfies HazardMonitoringHistoryResponse;

export const hazardMonitoringHistoryContinuationQuery = {
  ...hazardMonitoringHistoryQuery,
  cursor: monitoringCursor,
} satisfies HazardMonitoringHistoryQuery;

export const hazardMonitoringHistoryContinuation = {
  ...scope,
  monitoring: [firstMonitoring],
  page: { ...terminalPage, limit: 1, selection: 'continuation' },
  readAt: '2026-10-15T14:20:08Z',
} satisfies HazardMonitoringHistoryResponse;
