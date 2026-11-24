import type { MissionInput, ReceiptResponse } from '@ledger/contracts';
import type { LedgerClient } from '@ledger/contracts/client';

export interface MissionAdapterConfig {
  ledger: LedgerClient;
  tenantId: string;
  sourceId: string;
  sourceMissionId: string;
  aircraftId: string;
  flightId: string;
}
export interface PreparedMissionInput {
  version: 'ledger.mission-submission.1';
  apiUrl: string;
  tenantId: string;
  principalId: string;
  key: string;
  input: MissionInput;
  bytesBase64: string;
  sha256: string;
  submissionDigest: string;
}
export interface MissionAdapterResult {
  receipt: ReceiptResponse;
  submittedUploadArtifactId: string;
  sha256: string;
}
