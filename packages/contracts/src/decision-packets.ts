import { Type, type Static } from '@sinclair/typebox';
import type { EvidenceArtifact, EvidenceEntry, EvidenceReceipt } from './evidence.js';
import { EvaluatorReferenceSchema } from './rule-selection.js';

export const DECISION_PACKET_LIMITS = Object.freeze({
  maxEvents: 128,
  maxReceipts: 126,
  maxArtifacts: 126,
  maxReferenceDepth: 2,
  maxEnvelopeBytes: 262144,
  maxOriginalBytes: 1048576,
  maxPacketBytes: 4194304,
} as const);
export const DECISION_PACKET_V2_LIMITS = Object.freeze({ ...DECISION_PACKET_LIMITS, maxReferenceDepth: 3 } as const);
export const DECISION_PACKET_LIMITATIONS = Object.freeze([
  'This packet contains selected command-link finding-treatment records only; it is not a complete journal prefix, full flight history or whole-tenant export.',
  'Inventory digests commit complete selected records; included journal framing does not prove journal membership or complete-prefix continuity.',
  'Historical actor authority and dependency-basis manifests were not retained for this flight decision and are not reconstructed.',
  'This packet does not reconstruct a historical display or replay evaluator or projection behavior.',
  'Reported command-link evidence does not establish present communications health, monitored exposure or a loss rate.',
  "The manifest digest must be retained independently; this packet is not externally timestamped, anchored or a person's electronic signature.",
] as const);
export const DECISION_PACKET_V2_LIMITATIONS = Object.freeze([
  ...DECISION_PACKET_LIMITATIONS,
  'Execution checks establish consistency of the declared selection, adoption, evaluator and clock; they do not prove complete selection or replay the evaluator.',
] as const);

const S = Type.String();
const Id = Type.String({ minLength: 1, maxLength: 200 });
const N = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const Digest = Type.String({ pattern: '^[a-f0-9]{64}$' });
const Time = Type.String({ format: 'date-time' });
const Format = Type.Literal('ledger.decision-packet.1');
const FormatV2 = Type.Literal('ledger.decision-packet.2');
const Scope = Type.Literal('selected_c2_finding_treatment_records');
const Counts = Type.Object(
  {
    events: Type.Integer({ minimum: 2, maximum: DECISION_PACKET_LIMITS.maxEvents }),
    receipts: Type.Integer({ minimum: 0, maximum: DECISION_PACKET_LIMITS.maxReceipts }),
    artifacts: Type.Integer({ minimum: 0, maximum: DECISION_PACKET_LIMITS.maxArtifacts }),
    artifactBytes: Type.Integer({ minimum: 0, maximum: DECISION_PACKET_LIMITS.maxOriginalBytes }),
  },
  { additionalProperties: false },
);
const Limits = Type.Object(
  {
    maxEvents: Type.Literal(DECISION_PACKET_LIMITS.maxEvents),
    maxReceipts: Type.Literal(DECISION_PACKET_LIMITS.maxReceipts),
    maxArtifacts: Type.Literal(DECISION_PACKET_LIMITS.maxArtifacts),
    maxReferenceDepth: Type.Literal(DECISION_PACKET_LIMITS.maxReferenceDepth),
    maxEnvelopeBytes: Type.Literal(DECISION_PACKET_LIMITS.maxEnvelopeBytes),
    maxOriginalBytes: Type.Literal(DECISION_PACKET_LIMITS.maxOriginalBytes),
    maxPacketBytes: Type.Literal(DECISION_PACKET_LIMITS.maxPacketBytes),
  },
  { additionalProperties: false },
);
const LimitsV2 = Type.Object(
  { ...Limits.properties, maxReferenceDepth: Type.Literal(DECISION_PACKET_V2_LIMITS.maxReferenceDepth) },
  { additionalProperties: false },
);
export const DecisionPacketCreateSchema = Type.Object(
  { flightId: Id, decisionId: Id },
  { additionalProperties: false },
);
export type DecisionPacketCreate = Static<typeof DecisionPacketCreateSchema>;
export const DecisionPacketQuerySchema = Type.Object(
  { flightId: Type.Optional(Id), decisionId: Type.Optional(Id) },
  { additionalProperties: false },
);
export type DecisionPacketQuery = Static<typeof DecisionPacketQuerySchema>;
export const DecisionPacketParamsSchema = Type.Object({ id: Id }, { additionalProperties: false });
export type DecisionPacketParams = Static<typeof DecisionPacketParamsSchema>;
export const DecisionPacketInventoryEntrySchema = Type.Union(
  [
    Type.Object(
      {
        kind: Type.Literal('event'),
        id: Id,
        digest: Digest,
        reason: Type.Union([
          Type.Literal('selected_decision'),
          Type.Literal('selected_evaluation'),
          Type.Literal('evaluation_report'),
        ]),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      { kind: Type.Literal('receipt'), id: Id, digest: Digest, reason: Type.Literal('report_receipt') },
      { additionalProperties: false },
    ),
    Type.Object(
      { kind: Type.Literal('artifact'), id: Id, digest: Digest, reason: Type.Literal('report_original') },
      { additionalProperties: false },
    ),
  ],
  {
    description:
      'Each digest is the canonical SHA-256 digest of the complete selected event, receipt or artifact item.',
  },
);
export type DecisionPacketInventoryEntry = Static<typeof DecisionPacketInventoryEntrySchema>;
export const DecisionPacketInventoryEntryV2Schema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('event'),
      id: Id,
      digest: Digest,
      reason: Type.Union([
        Type.Literal('selected_decision'),
        Type.Literal('selected_evaluation'),
        Type.Literal('evaluation_report'),
        Type.Literal('selected_rule_selection'),
        Type.Literal('selected_adoption'),
      ]),
    },
    { additionalProperties: false },
  ),
  ...DecisionPacketInventoryEntrySchema.anyOf.slice(1),
]);
export type DecisionPacketInventoryEntryV2 = Static<typeof DecisionPacketInventoryEntryV2Schema>;
export const DecisionPacketRecordV1Schema = Type.Object(
  {
    id: Id,
    format: Format,
    tenantId: Id,
    flightId: Id,
    decisionId: Id,
    issuedBy: Id,
    issuedAt: Time,
    byteLength: Type.Integer({ minimum: 1, maximum: DECISION_PACKET_LIMITS.maxPacketBytes }),
    packetSha256: Digest,
    manifestDigest: Digest,
    scope: Scope,
    counts: Counts,
    limits: Limits,
  },
  { additionalProperties: false },
);
export type DecisionPacketRecordV1 = Static<typeof DecisionPacketRecordV1Schema>;
export const DecisionPacketRecordV2Schema = Type.Object(
  { ...DecisionPacketRecordV1Schema.properties, format: FormatV2, limits: LimitsV2 },
  { additionalProperties: false },
);
export type DecisionPacketRecordV2 = Static<typeof DecisionPacketRecordV2Schema>;
export const DecisionPacketRecordSchema = Type.Union([DecisionPacketRecordV1Schema, DecisionPacketRecordV2Schema]);
export type DecisionPacketRecord = Static<typeof DecisionPacketRecordSchema>;
export interface DecisionPacketResponse {
  record: DecisionPacketRecord;
  requestId: string;
}
export interface DecisionPacketListResponse {
  records: DecisionPacketRecord[];
  limit: 20;
  hasMore: boolean;
  requestId: string;
}
export const DecisionPacketManifestSchema = Type.Object(
  {
    format: Format,
    packetId: Id,
    tenantId: Id,
    flightId: Id,
    decisionId: Id,
    evaluationId: Id,
    findingId: Id,
    issuedBy: Id,
    issuedAt: Time,
    selection: Type.Literal('command-link-finding-treatment.1'),
    scope: Scope,
    historicalActorPolicy: Type.Object({ status: Type.Literal('not_retained') }, { additionalProperties: false }),
    dependencyManifest: Type.Object({ status: Type.Literal('not_retained') }, { additionalProperties: false }),
    inventory: Type.Array(DecisionPacketInventoryEntrySchema, {
      minItems: 2,
      maxItems:
        DECISION_PACKET_LIMITS.maxEvents + DECISION_PACKET_LIMITS.maxReceipts + DECISION_PACKET_LIMITS.maxArtifacts,
    }),
    counts: Counts,
    limits: Limits,
    limitations: Type.Array(S),
  },
  { additionalProperties: false },
);
export type DecisionPacketManifest = Static<typeof DecisionPacketManifestSchema>;
export const DecisionPacketManifestV2Schema = Type.Object(
  {
    ...DecisionPacketManifestSchema.properties,
    format: FormatV2,
    selection: Type.Literal('c2-execution-finding-treatment.2'),
    selectionId: Id,
    selectionDigest: Digest,
    evaluator: EvaluatorReferenceSchema,
    adoptionId: Type.Union([Id, Type.Null()]),
    inventory: Type.Array(DecisionPacketInventoryEntryV2Schema, {
      minItems: 3,
      maxItems:
        DECISION_PACKET_V2_LIMITS.maxEvents +
        DECISION_PACKET_V2_LIMITS.maxReceipts +
        DECISION_PACKET_V2_LIMITS.maxArtifacts,
    }),
    limits: LimitsV2,
  },
  { additionalProperties: false },
);
export type DecisionPacketManifestV2 = Static<typeof DecisionPacketManifestV2Schema>;
const Entry = Type.Object(
  {
    canonicalEnvelope: Type.String({ maxLength: DECISION_PACKET_LIMITS.maxEnvelopeBytes }),
    envelopeDigest: Digest,
    previousHash: Type.String({ pattern: '^(?:[a-f0-9]{64})?$' }),
    entryHash: Digest,
    encodingVersion: Type.Literal('ledger.v6.sha256.jcs.1'),
  },
  { additionalProperties: false },
);
const Receipt = Type.Object(
  {
    tenantId: Id,
    id: Id,
    eventId: Id,
    sourceId: Id,
    kind: S,
    occurredAt: Time,
    receivedAt: Time,
    sourceRevision: Type.Union([S, Type.Null()]),
    artifactId: Type.Union([Id, Type.Null()]),
    payload: Type.Record(S, Type.Unknown()),
    inputSubject: Type.Record(S, Type.Unknown()),
  },
  { additionalProperties: false },
);
const Artifact = Type.Object(
  { tenantId: Id, id: Id, sha256: Digest, byteLength: N, contentType: S, bytesBase64: S },
  { additionalProperties: false },
);
export const DecisionPacketSchema = Type.Object(
  {
    format: Format,
    manifest: DecisionPacketManifestSchema,
    manifestDigest: Digest,
    events: Type.Array(Entry, { minItems: 2, maxItems: DECISION_PACKET_LIMITS.maxEvents }),
    receipts: Type.Array(Receipt, { maxItems: DECISION_PACKET_LIMITS.maxReceipts }),
    artifacts: Type.Array(Artifact, { maxItems: DECISION_PACKET_LIMITS.maxArtifacts }),
  },
  { additionalProperties: false },
);
export interface DecisionPacket {
  format: 'ledger.decision-packet.1';
  manifest: DecisionPacketManifest;
  manifestDigest: string;
  events: EvidenceEntry[];
  receipts: EvidenceReceipt[];
  artifacts: EvidenceArtifact[];
}
export const DecisionPacketV2Schema = Type.Object(
  {
    ...DecisionPacketSchema.properties,
    format: FormatV2,
    manifest: DecisionPacketManifestV2Schema,
    events: Type.Array(Entry, { minItems: 3, maxItems: DECISION_PACKET_V2_LIMITS.maxEvents }),
  },
  { additionalProperties: false },
);
export interface DecisionPacketV2 {
  format: 'ledger.decision-packet.2';
  manifest: DecisionPacketManifestV2;
  manifestDigest: string;
  events: EvidenceEntry[];
  receipts: EvidenceReceipt[];
  artifacts: EvidenceArtifact[];
}
