import type { LedgerClient } from '@ledger/contracts/client';
import { canonicalDigest, sha256 } from '@ledger/integrity';
import {
  missionAuthority,
  missionInput,
  missionRecord,
  missionSource,
  missionSourceText,
} from '../../contracts/fixtures/demo/v1/missions.js';
import type { MissionAdapterConfig, MissionAdapterResult, PreparedMissionInput } from '../src/mission-types.js';

export const missionAdapterBinding = {
  tenantId: missionAuthority.tenantId,
  sourceId: missionInput.sourceId,
  sourceMissionId: missionSource.sourceMissionId,
  aircraftId: missionSource.aircraftId,
  flightId: missionInput.subject.flightId,
} satisfies Omit<MissionAdapterConfig, 'ledger'>;
export const missionAdapterConfig = (ledger: LedgerClient): MissionAdapterConfig => ({
  ledger,
  ...missionAdapterBinding,
});
export const missionAdapterOriginalText = missionSourceText;
const content: Omit<PreparedMissionInput, 'submissionDigest'> = {
  version: 'ledger.mission-submission.1',
  apiUrl: 'https://ledger.invalid',
  tenantId: missionAdapterBinding.tenantId,
  principalId: missionAuthority.principalId,
  key: `mission:revision:${canonicalDigest({
    version: 'ledger.mission-delivery.1',
    tenantId: missionAdapterBinding.tenantId,
    sourceId: missionAdapterBinding.sourceId,
    sourceMissionId: missionAdapterBinding.sourceMissionId,
    sourceRevision: missionInput.sourceRevision,
  })}`,
  input: { ...missionInput, artifactId: 'submitted-mission-upload-artifact' },
  bytesBase64: Buffer.from(missionAdapterOriginalText, 'utf8').toString('base64'),
  sha256: sha256(missionAdapterOriginalText),
};
export const preparedMissionInput = {
  ...content,
  submissionDigest: canonicalDigest(content),
} satisfies PreparedMissionInput;
export const missionAdapterResult = {
  receipt: {
    receipt: {
      id: missionRecord.receiptId,
      eventId: missionRecord.id,
      sourceId: missionInput.sourceId,
      kind: missionInput.kind,
      occurredAt: missionInput.occurredAt,
      receivedAt: missionRecord.recordedAt,
      status: 'accepted',
      processing: { status: 'pending', attempts: 0 },
      linkStatus: 'linked',
      flightId: missionInput.subject.flightId,
      artifactId: missionRecord.artifactId,
      payload: missionInput.payload,
    },
    meta: {
      requestId: 'mission-adapter-delivery',
      effectId: missionRecord.receiptId,
      projectionRevision: 0,
      inputCut: { streams: {}, basisRevision: 1, principalRevision: missionAuthority.principalRevision },
      computedAt: missionRecord.recordedAt,
      outstandingWork: 1,
    },
  },
  submittedUploadArtifactId: preparedMissionInput.input.artifactId,
  sha256: preparedMissionInput.sha256,
} satisfies MissionAdapterResult;
