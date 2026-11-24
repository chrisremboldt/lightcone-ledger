import { Type, type Static } from '@sinclair/typebox';
import type { DecisionRecord, FlightSummary, InputCut, ResponseMeta, TimelineItem } from './index.js';

export const ExportCreateSchema = Type.Object(
  {
    flightId: Type.String({ minLength: 1, maxLength: 200 }),
    decisionId: Type.String({ minLength: 1, maxLength: 200 }),
    scope: Type.Literal('whole_tenant_prefixes'),
  },
  { additionalProperties: false },
);
export type ExportCreate = Static<typeof ExportCreateSchema>;
export interface EvidenceLimits {
  maxEvents: number;
  maxStreams: number;
  maxArtifacts: number;
  maxArtifactBytes: number;
  maxBundleBytes: number;
}
export interface EvidenceCounts {
  events: number;
  streams: number;
  receipts: number;
  artifacts: number;
  artifactBytes: number;
}
export interface EvidenceCuts {
  rendered: InputCut;
  accepted: InputCut;
  issuance: InputCut;
}
export interface EvidenceCutSummary {
  eventCount: number;
  digest: string;
  causalClosure: 'closed' | 'incomplete';
  missingCausationIds: string[];
}
export interface ExportRecord {
  format: 'ledger.decision-evidence.1' | 'ledger.flight-evidence.2';
  id: string;
  tenantId: string;
  flightId: string;
  decisionId: string;
  issuedBy: string;
  issuedAt: string;
  scope: 'whole_tenant_prefixes';
  byteLength: number;
  bundleSha256: string;
  manifestDigest: string;
  snapshotDigest: string;
  anchorStatus: 'not_externally_anchored';
  interpretation: 'evidence-cut.1';
  counts: EvidenceCounts;
  limits: EvidenceLimits;
  cuts: EvidenceCuts;
  interpretations: { rendered: EvidenceCutSummary; accepted: EvidenceCutSummary; issuance: EvidenceCutSummary };
  addedAcceptedEventIds: string[];
  limitations: string[];
}
export interface ExportResponse {
  record: ExportRecord;
  meta: ResponseMeta;
}
export interface ExportListResponse {
  records: ExportRecord[];
  limit: number;
  hasMore: boolean;
  meta: ResponseMeta;
}
export interface EvidenceEnvelope {
  eventId: string;
  tenantId: string;
  streamId: string;
  sequence: string;
  type: string;
  schemaVersion: number;
  principalId: string;
  sourceId: string | null;
  sourceSessionId: string | null;
  occurredAt: string | null;
  effectiveAt: string | null;
  receivedAt: string;
  causationId: string | null;
  artifactId: string | null;
  payload: Record<string, unknown>;
}
export interface EvidenceEntry {
  canonicalEnvelope: string;
  envelopeDigest: string;
  previousHash: string;
  entryHash: string;
  encodingVersion: string;
}
export interface EvidenceStream {
  tenantId: string;
  id: string;
  name: string;
  headSequence: string;
  headHash: string;
  cutHeads: {
    rendered: { sequence: string; hash: string };
    accepted: { sequence: string; hash: string };
    issuance: { sequence: string; hash: string };
  };
}
export interface EvidenceReceipt {
  tenantId: string;
  id: string;
  eventId: string;
  sourceId: string;
  kind: string;
  occurredAt: string;
  receivedAt: string;
  sourceRevision: string | null;
  artifactId: string | null;
  payload: Record<string, unknown>;
  inputSubject: Record<string, unknown>;
}
export interface EvidenceArtifact {
  tenantId: string;
  id: string;
  sha256: string;
  byteLength: number;
  contentType: string;
  bytesBase64: string;
}
export interface EvidenceActor {
  id: string;
  authorityRevision: number | null;
  historicalProfile: 'not_retained';
}
export interface EvidenceSnapshot {
  kind: 'export_time_sql_snapshot';
  capturedAt: string;
  projectorVersion: 'thread.1';
  projectionCut: InputCut;
  projectionRevision: number;
  flight: FlightSummary;
  items: TimelineItem[];
  decisions: DecisionRecord[];
  limitations: string[];
}
export interface EvidenceRuntimeContract {
  name: 'node';
  major: 24;
  moduleFormat: 'esm';
  dependencies: [];
  network: 'none';
  interpretation: 'evidence-cut.1';
  canonicalization: 'ledger.v6.sha256.jcs.1';
}
export interface EvidenceInterpreter {
  name: 'evidence-cut.1';
  sourceEncoding: 'utf8';
  source: string;
  sourceSha256: string;
  runtimeContract: EvidenceRuntimeContract;
  runtimeContractDigest: string;
}
export interface EvidenceInventoryEvent {
  eventId: string;
  streamId: string;
  sequence: string;
  type: string;
  principalId: string;
  sourceId: string | null;
  occurredAt: string | null;
  effectiveAt: string | null;
  receivedAt: string;
  causationId: string | null;
  artifactId: string | null;
  envelopeDigest: string;
  entryHash: string;
}
export interface EvidenceCutOutput {
  interpretation: 'evidence-cut.1';
  tenantId: string;
  cut: InputCut;
  events: EvidenceInventoryEvent[];
  missingCausationIds: string[];
  limitations: string[];
}
export interface EvidenceInterpretations {
  rendered: EvidenceCutOutput;
  accepted: EvidenceCutOutput;
  issuance: EvidenceCutOutput;
}
export type EvidenceSection =
  | 'streams'
  | 'entries'
  | 'receipts'
  | 'artifacts'
  | 'decision'
  | 'actor'
  | 'cuts'
  | 'snapshot'
  | 'interpreter'
  | 'interpretations';
export interface EvidenceManifest {
  format: 'ledger.decision-evidence.1';
  exportId: string;
  tenantId: string;
  scope: 'whole_tenant_prefixes';
  flightId: string;
  decisionId: string;
  issuedBy: string;
  issuedAt: string;
  versions: { integrity: 'ledger.v6.sha256.jcs.1'; interpretation: 'evidence-cut.1'; snapshot: 'thread.1' };
  counts: EvidenceCounts;
  limits: EvidenceLimits;
  sectionDigests: Record<EvidenceSection, string>;
  interpretationDigests: { rendered: string; accepted: string; issuance: string };
  limitations: string[];
}
export interface DecisionEvidenceBundle {
  format: 'ledger.decision-evidence.1';
  manifest: EvidenceManifest;
  manifestDigest: string;
  streams: EvidenceStream[];
  entries: EvidenceEntry[];
  receipts: EvidenceReceipt[];
  artifacts: EvidenceArtifact[];
  decision: DecisionRecord;
  actor: EvidenceActor;
  cuts: EvidenceCuts;
  snapshot: EvidenceSnapshot;
  interpreter: EvidenceInterpreter;
  interpretations: EvidenceInterpretations;
}

const S = Type.String(),
  N = Type.Integer({ minimum: 0 });
const Cut = Type.Object({
  streams: Type.Record(S, N),
  basisRevision: Type.Optional(N),
  principalRevision: Type.Optional(N),
});
const Cuts = Type.Object({ rendered: Cut, accepted: Cut, issuance: Cut });
const Summary = Type.Object({
  eventCount: N,
  digest: S,
  causalClosure: Type.Union([Type.Literal('closed'), Type.Literal('incomplete')]),
  missingCausationIds: Type.Array(S),
});
export const ExportRecordSchema = Type.Object({
  format: Type.Union([Type.Literal('ledger.decision-evidence.1'), Type.Literal('ledger.flight-evidence.2')]),
  id: S,
  tenantId: S,
  flightId: S,
  decisionId: S,
  issuedBy: S,
  issuedAt: Type.String({ format: 'date-time' }),
  scope: Type.Literal('whole_tenant_prefixes'),
  byteLength: N,
  bundleSha256: S,
  manifestDigest: S,
  snapshotDigest: S,
  anchorStatus: Type.Literal('not_externally_anchored'),
  interpretation: Type.Literal('evidence-cut.1'),
  counts: Type.Object({ events: N, streams: N, receipts: N, artifacts: N, artifactBytes: N }),
  limits: Type.Object({ maxEvents: N, maxStreams: N, maxArtifacts: N, maxArtifactBytes: N, maxBundleBytes: N }),
  cuts: Cuts,
  interpretations: Type.Object({ rendered: Summary, accepted: Summary, issuance: Summary }),
  addedAcceptedEventIds: Type.Array(S),
  limitations: Type.Array(S),
});
