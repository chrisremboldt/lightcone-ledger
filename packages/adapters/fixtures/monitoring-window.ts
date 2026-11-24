import type { LedgerClient } from '@ledger/contracts/client';
import { canonicalDigest, sha256 } from '@ledger/integrity';
import {
  monitoringInputV2,
  monitoringOriginalBytesBase64V2,
  monitoringRecordV2,
  monitoringSourceV2,
} from '../../contracts/fixtures/demo/v1/monitoring-window.js';
import type {
  MonitoringWindowAdapterConfig,
  MonitoringWindowAdapterResult,
  PreparedMonitoringWindowInput,
} from '../src/monitoring-window.js';

export const monitoringWindowAdapterBinding = {
  tenantId: monitoringRecordV2.authority.tenantId,
  sourceId: monitoringInputV2.sourceId,
  sourceSessionId: monitoringSourceV2.sourceSessionId,
  sourceWindowId: monitoringSourceV2.sourceWindowId,
} satisfies Omit<MonitoringWindowAdapterConfig, 'ledger'>;
export const monitoringWindowAdapterConfig = (ledger: LedgerClient): MonitoringWindowAdapterConfig => ({
  ledger,
  ...monitoringWindowAdapterBinding,
});
export const monitoringWindowAdapterOriginalText = Buffer.from(monitoringOriginalBytesBase64V2, 'base64').toString(
  'utf8',
);
const content: Omit<PreparedMonitoringWindowInput, 'submissionDigest'> = {
  version: 'ledger.monitoring-window-submission.2',
  apiUrl: 'https://ledger.invalid',
  tenantId: monitoringWindowAdapterBinding.tenantId,
  principalId: monitoringRecordV2.authority.principalId,
  key: `monitoring-window:revision:${canonicalDigest({
    version: 'ledger.monitoring-window-delivery.2',
    ...monitoringWindowAdapterBinding,
    sourceRevision: monitoringSourceV2.sourceRevision,
  })}`,
  input: { ...monitoringInputV2, artifactId: 'submitted-monitoring-window-artifact' },
  bytesBase64: monitoringOriginalBytesBase64V2,
  sha256: sha256(monitoringWindowAdapterOriginalText),
};
export const preparedMonitoringWindowInput = {
  ...content,
  submissionDigest: canonicalDigest(content),
} satisfies PreparedMonitoringWindowInput;
export const monitoringWindowAdapterResult = {
  receipt: {
    receipt: {
      id: 'fixture-native-monitoring-receipt',
      eventId: monitoringRecordV2.id,
      sourceId: monitoringInputV2.sourceId,
      kind: monitoringInputV2.kind,
      occurredAt: monitoringInputV2.occurredAt,
      receivedAt: monitoringRecordV2.recordedAt,
      status: 'accepted',
      processing: { status: 'pending', attempts: 0 },
      linkStatus: 'linked',
      artifactId: monitoringInputV2.artifactId,
      payload: monitoringInputV2.payload,
    },
    meta: {
      requestId: 'monitoring-window-adapter-delivery',
      effectId: 'fixture-native-monitoring-receipt',
      projectionRevision: 0,
      inputCut: { streams: {}, principalRevision: monitoringRecordV2.authority.principalRevision },
      computedAt: monitoringRecordV2.recordedAt,
      outstandingWork: 1,
    },
  },
  submittedUploadArtifactId: preparedMonitoringWindowInput.input.artifactId,
  sha256: preparedMonitoringWindowInput.sha256,
} satisfies MonitoringWindowAdapterResult;
