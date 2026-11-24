import { Type, type Static } from '@sinclair/typebox';
import type { EvidenceEntry, EvidenceReceipt } from './evidence.js';
import { SubjectReferenceSchema } from './rule-evaluations.js';
import { HazardFindingOriginSchema } from './sms.js';

/**
 * A packet for one finding the generic evaluator opened, about any subject and from any rule. Which records it holds
 * is decided by which records exist for the finding, never by the rule, pack or observation type behind it.
 * Version 1 identifies source originals by digest only; version 2, which Ledger issues now, carries their bytes.
 */
export const FINDING_PACKET_FORMAT = 'ledger.finding-packet.1';
export const FINDING_PACKET_V2_FORMAT = 'ledger.finding-packet.2';
export const FINDING_PACKET_LIMITS = Object.freeze({
  maxEvaluations: 32,
  maxEvents: 512,
  maxReceipts: 256,
  maxArtifacts: 256,
  maxHazards: 8,
  maxEnvelopeBytes: 262144,
  maxPacketBytes: 4194304,
} as const);
export const FINDING_PACKET_LIMITATIONS = Object.freeze([
  'This packet contains one finding, its evaluations, the records they read and the decisions recorded about it; it is not a complete journal prefix, a full subject history or a whole-tenant export.',
  'Inventory digests commit complete selected records; included journal framing does not prove journal membership or complete-prefix continuity.',
  'Source originals are identified by their SHA-256 digest, length and content type; their bytes are not included.',
  "Corrections are those recorded within each evaluation's input cut for observations its reads could select; corrections recorded later are not included.",
  'This packet does not replay the evaluator, its check kind or any projection, and does not reconstruct a historical display.',
  'Evidence states and outcomes say what the evidence supported and what needed a person; they are not a determination that any requirement is met. A named person with the authority decides.',
  "The manifest digest must be retained independently; this packet is not externally timestamped, anchored or a person's electronic signature.",
] as const);
/** Version 2 carries original source bytes up to maxOriginalBytes, the bound the older decision packet used. */
export const FINDING_PACKET_V2_LIMITS = Object.freeze({ ...FINDING_PACKET_LIMITS, maxOriginalBytes: 1048576 } as const);
export const FINDING_PACKET_V2_LIMITATIONS = Object.freeze(
  FINDING_PACKET_LIMITATIONS.map((limitation) =>
    limitation.startsWith('Source originals')
      ? 'Source originals are included as their exact bytes, each checked against its SHA-256 digest and length, up to the packet bound; a source left out to keep within the bound is identified by its digest, length and content type only, and the manifest lists it.'
      : limitation,
  ),
);

/** The plain-language statement a version 2 packet makes when it left out the bytes of some sources. */
export function findingPacketLeftOutStatement(count: number): string {
  return `The original bytes of ${count} ${count === 1 ? 'source were' : 'sources were'} left out to keep this packet within its size bound, largest first; each is identified by its SHA-256 digest, length and content type only.`;
}

const S = Type.String();
const Id = Type.String({ minLength: 1, maxLength: 200 });
const PacketId = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const N = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const Version = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const Digest = Type.String({ pattern: '^[a-f0-9]{64}$' });
const Time = Type.String({ format: 'date-time' });
const Closed = { additionalProperties: false } as const;
const Format = Type.Literal(FINDING_PACKET_FORMAT);
const FormatV2 = Type.Literal(FINDING_PACKET_V2_FORMAT);
const Mode = Type.Union([Type.Literal('shadow'), Type.Literal('active')]);

export const FindingPacketCreateSchema = Type.Object({ findingId: Id }, Closed);
export type FindingPacketCreate = Static<typeof FindingPacketCreateSchema>;
export const FindingPacketParamsSchema = Type.Object({ id: PacketId }, Closed);
export type FindingPacketParams = Static<typeof FindingPacketParamsSchema>;

const Limits = Type.Object(
  {
    maxEvaluations: Type.Literal(FINDING_PACKET_LIMITS.maxEvaluations),
    maxEvents: Type.Literal(FINDING_PACKET_LIMITS.maxEvents),
    maxReceipts: Type.Literal(FINDING_PACKET_LIMITS.maxReceipts),
    maxArtifacts: Type.Literal(FINDING_PACKET_LIMITS.maxArtifacts),
    maxHazards: Type.Literal(FINDING_PACKET_LIMITS.maxHazards),
    maxEnvelopeBytes: Type.Literal(FINDING_PACKET_LIMITS.maxEnvelopeBytes),
    maxPacketBytes: Type.Literal(FINDING_PACKET_LIMITS.maxPacketBytes),
  },
  Closed,
);
const LimitsV2 = Type.Object(
  { ...Limits.properties, maxOriginalBytes: Type.Literal(FINDING_PACKET_V2_LIMITS.maxOriginalBytes) },
  Closed,
);
const Counts = Type.Object(
  {
    evaluations: Type.Integer({ minimum: 1, maximum: FINDING_PACKET_LIMITS.maxEvaluations }),
    events: Type.Integer({ minimum: 2, maximum: FINDING_PACKET_LIMITS.maxEvents }),
    receipts: Type.Integer({ minimum: 0, maximum: FINDING_PACKET_LIMITS.maxReceipts }),
    artifacts: Type.Integer({ minimum: 0, maximum: FINDING_PACKET_LIMITS.maxArtifacts }),
    hazards: Type.Integer({ minimum: 0, maximum: FINDING_PACKET_LIMITS.maxHazards }),
  },
  Closed,
);

const CountsV2 = Type.Object(
  {
    ...Counts.properties,
    originalBytes: Type.Integer({
      minimum: 0,
      maximum: FINDING_PACKET_V2_LIMITS.maxOriginalBytes,
      description: 'The total length of the original source bytes the packet carries.',
    }),
    leftOutOriginals: Type.Integer({
      minimum: 0,
      maximum: FINDING_PACKET_LIMITS.maxArtifacts,
      description: 'Sources whose bytes were left out to keep within the bound; they are identified by digest only.',
    }),
  },
  Closed,
);

const RecordFields = {
  id: PacketId,
  tenantId: Id,
  findingId: Id,
  subjectKey: Type.String({ minLength: 1, maxLength: 1000 }),
  eventId: Type.String({
    minLength: 1,
    maxLength: 200,
    description: 'The journal event that records the issue: who issued the packet and when.',
  }),
  issuedBy: Id,
  issuedAt: Time,
  byteLength: Type.Integer({ minimum: 1, maximum: FINDING_PACKET_LIMITS.maxPacketBytes }),
  packetSha256: Digest,
  manifestDigest: Digest,
};
export const FindingPacketRecordV1Schema = Type.Object(
  { ...RecordFields, format: Format, counts: Counts, limits: Limits },
  Closed,
);
export const FindingPacketRecordV2Schema = Type.Object(
  { ...RecordFields, format: FormatV2, counts: CountsV2, limits: LimitsV2 },
  Closed,
);
export const FindingPacketRecordSchema = Type.Union([FindingPacketRecordV1Schema, FindingPacketRecordV2Schema], {
  description: 'An issued finding packet. Ledger issues version 2; version 1 packets issued earlier stay readable.',
});
export type FindingPacketRecordV1 = Static<typeof FindingPacketRecordV1Schema>;
export type FindingPacketRecordV2 = Static<typeof FindingPacketRecordV2Schema>;
export type FindingPacketRecord = Static<typeof FindingPacketRecordSchema>;
export interface FindingPacketResponse {
  record: FindingPacketRecord;
  requestId: string;
}
export const FINDING_PACKET_PAGE_LIMIT = 50;
export const FindingPacketQuerySchema = Type.Object(
  {
    findingId: Id,
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: FINDING_PACKET_PAGE_LIMIT })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  },
  { ...Closed, description: 'Packets issued for one finding, newest first.' },
);
export type FindingPacketQuery = Static<typeof FindingPacketQuerySchema>;
export const FindingPacketListResponseSchema = Type.Object(
  {
    records: Type.Array(FindingPacketRecordSchema, { maxItems: FINDING_PACKET_PAGE_LIMIT }),
    page: Type.Object(
      {
        limit: Type.Integer({ minimum: 1, maximum: FINDING_PACKET_PAGE_LIMIT }),
        returned: Type.Integer({ minimum: 0, maximum: FINDING_PACKET_PAGE_LIMIT }),
        hasMore: Type.Boolean(),
        nextCursor: Type.Union([Type.String(), Type.Null()]),
      },
      Closed,
    ),
    requestId: S,
  },
  Closed,
);
export type FindingPacketListResponse = Static<typeof FindingPacketListResponseSchema>;

export const findingPacketEventReasons = [
  'finding_evaluation',
  'evaluation_adoption',
  'read_observation',
  'corrected_observation',
  'observation_correction',
  'finding_treatment',
  'hazard_opening',
  'hazard_assessment',
  'hazard_acceptance',
] as const;
export const FindingPacketInventoryEntrySchema = Type.Union(
  [
    Type.Object(
      {
        kind: Type.Literal('event'),
        id: Id,
        digest: Digest,
        reason: Type.Union(findingPacketEventReasons.map((reason) => Type.Literal(reason))),
      },
      Closed,
    ),
    Type.Object(
      { kind: Type.Literal('receipt'), id: Id, digest: Digest, reason: Type.Literal('observation_receipt') },
      Closed,
    ),
    Type.Object(
      { kind: Type.Literal('artifact'), id: Id, digest: Digest, reason: Type.Literal('observation_source') },
      Closed,
    ),
    Type.Object(
      { kind: Type.Literal('origin'), id: Id, digest: Digest, reason: Type.Literal('hazard_origin') },
      Closed,
    ),
  ],
  {
    description:
      'Each digest is the canonical SHA-256 digest of the complete included item: the journal entry for an event, and the receipt, artifact or origin item as it appears in the packet.',
  },
);
export type FindingPacketInventoryEntry = Static<typeof FindingPacketInventoryEntrySchema>;

const ObservationRead = Type.Object(
  {
    observationId: Id,
    eventId: Id,
    receiptId: Id,
    artifactId: Id,
    replacesObservationId: Type.Union([Id, Type.Null()]),
  },
  Closed,
);
const Correction = Type.Object(
  {
    kind: Type.Union([Type.Literal('replacement'), Type.Literal('withdrawal'), Type.Literal('subject_resolution')]),
    eventId: Id,
    observationId: Id,
  },
  {
    ...Closed,
    description:
      'A correction recorded within the evaluation input cut. replacement: eventId is the replacing observation; withdrawal: the withdrawal; subject_resolution: the resolution that decided which subject the observation is about.',
  },
);
export const FindingPacketEvaluationSchema = Type.Object(
  {
    id: Id,
    digest: Digest,
    recordedAt: Time,
    mode: Mode,
    adoptionId: Id,
    ruleSourceKind: Id,
    outcome: S,
    evidenceState: S,
    observations: Type.Array(ObservationRead),
    corrections: Type.Array(Correction),
    subjectState: Type.Union([
      Type.Object(
        { name: Id, kind: Id, revision: Type.Union([Digest, Type.Null()]), digest: Digest },
        {
          ...Closed,
          description: 'The subject state the evaluation recorded; digest is the canonical digest of its content.',
        },
      ),
      Type.Null(),
    ]),
  },
  {
    ...Closed,
    description:
      'One evaluation of the finding. digest is the canonical digest of the evaluation record: the evaluation in its event payload with recordedAt set to the event receivedAt.',
  },
);
export type FindingPacketEvaluation = Static<typeof FindingPacketEvaluationSchema>;

export const FindingPacketManifestSchema = Type.Object(
  {
    format: Format,
    packetId: PacketId,
    tenantId: Id,
    issuedBy: Id,
    issuedAt: Time,
    finding: Type.Object(
      {
        id: Id,
        subject: SubjectReferenceSchema,
        subjectKey: Type.String({ minLength: 1, maxLength: 1000 }),
        packId: Id,
        ruleId: Id,
        openedAt: Time,
        initialEvaluationId: Id,
        latestEvaluationId: Id,
        status: S,
      },
      Closed,
    ),
    statements: Type.Array(S, {
      description: 'Plain-word statements a reader needs first: the adoption mode and any proposed rule text.',
    }),
    evaluations: Type.Array(FindingPacketEvaluationSchema, {
      minItems: 1,
      maxItems: FINDING_PACKET_LIMITS.maxEvaluations,
    }),
    adoptions: Type.Array(
      Type.Object(
        { id: Id, digest: Digest, mode: Mode, packId: Id, packVersion: Version, packDigest: Digest },
        {
          ...Closed,
          description:
            'digest is the canonical digest of the adoption record: the acceptance in its event payload with id and acceptedAt set to the event id and receivedAt.',
        },
      ),
    ),
    decisions: Type.Object(
      {
        treatments: Type.Array(Type.Object({ id: Id, evaluationId: Id, action: S }, Closed)),
        hazards: Type.Array(
          Type.Object(
            {
              recordId: Id,
              openingEventId: Id,
              originDigest: Digest,
              evaluationId: Id,
              assessmentIds: Type.Array(Id),
              acceptanceIds: Type.Array(Id),
            },
            Closed,
          ),
          { maxItems: FINDING_PACKET_LIMITS.maxHazards },
        ),
      },
      Closed,
    ),
    inventory: Type.Array(FindingPacketInventoryEntrySchema, { minItems: 2 }),
    counts: Counts,
    limits: Limits,
    limitations: Type.Array(S),
  },
  Closed,
);
export type FindingPacketManifest = Static<typeof FindingPacketManifestSchema>;

const Entry = Type.Object(
  {
    canonicalEnvelope: Type.String({ maxLength: FINDING_PACKET_LIMITS.maxEnvelopeBytes }),
    envelopeDigest: Digest,
    previousHash: Type.String({ pattern: '^(?:[a-f0-9]{64})?$' }),
    entryHash: Digest,
    encodingVersion: Type.Literal('ledger.v6.sha256.jcs.1'),
  },
  Closed,
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
  Closed,
);
const ArtifactDigest = Type.Object({ tenantId: Id, id: Id, sha256: Digest, byteLength: N, contentType: S }, Closed);
export type FindingPacketArtifact = Static<typeof ArtifactDigest>;
const Origin = Type.Object({ recordId: Id, origin: HazardFindingOriginSchema }, Closed);
export type FindingPacketOrigin = Static<typeof Origin>;

export const FindingPacketSchema = Type.Object(
  {
    format: Format,
    manifest: FindingPacketManifestSchema,
    manifestDigest: Digest,
    events: Type.Array(Entry, { minItems: 2, maxItems: FINDING_PACKET_LIMITS.maxEvents }),
    receipts: Type.Array(Receipt, { maxItems: FINDING_PACKET_LIMITS.maxReceipts }),
    artifacts: Type.Array(ArtifactDigest, { maxItems: FINDING_PACKET_LIMITS.maxArtifacts }),
    origins: Type.Array(Origin, { maxItems: FINDING_PACKET_LIMITS.maxHazards }),
  },
  Closed,
);
export interface FindingPacket {
  format: typeof FINDING_PACKET_FORMAT;
  manifest: FindingPacketManifest;
  manifestDigest: string;
  events: EvidenceEntry[];
  receipts: EvidenceReceipt[];
  artifacts: FindingPacketArtifact[];
  origins: FindingPacketOrigin[];
}

const InventoryEntryV2 = Type.Union(
  [
    ...FindingPacketInventoryEntrySchema.anyOf,
    Type.Object(
      {
        kind: Type.Literal('artifact'),
        id: Id,
        digest: Digest,
        reason: Type.Literal('observation_source_digest_only'),
      },
      Closed,
    ),
  ],
  {
    description:
      'As in version 1. A source whose bytes the packet carries is listed as observation_source; one whose bytes were left out to keep within the bound as observation_source_digest_only.',
  },
);
export type FindingPacketInventoryEntryV2 = Static<typeof InventoryEntryV2>;
const {
  format: _format,
  inventory: _inventory,
  counts: _counts,
  limits: _limits,
  ...ManifestFields
} = FindingPacketManifestSchema.properties;
export const FindingPacketManifestV2Schema = Type.Object(
  {
    ...ManifestFields,
    format: FormatV2,
    inventory: Type.Array(InventoryEntryV2, { minItems: 2 }),
    leftOutOriginals: Type.Array(Id, {
      maxItems: FINDING_PACKET_LIMITS.maxArtifacts,
      description:
        'The sources whose bytes were left out to keep within the bound, largest first (ties by id). Bytes are left out in that order until the rest fit.',
    }),
    counts: CountsV2,
    limits: LimitsV2,
  },
  Closed,
);
export type FindingPacketManifestV2 = Static<typeof FindingPacketManifestV2Schema>;
const ArtifactV2 = Type.Object(
  {
    ...ArtifactDigest.properties,
    bytesBase64: Type.Union([Type.String(), Type.Null()], {
      description: 'The exact original bytes, or null when they were left out to keep within the bound.',
    }),
  },
  Closed,
);
export type FindingPacketArtifactV2 = Static<typeof ArtifactV2>;
export const FindingPacketV2Schema = Type.Object(
  {
    format: FormatV2,
    manifest: FindingPacketManifestV2Schema,
    manifestDigest: Digest,
    events: Type.Array(Entry, { minItems: 2, maxItems: FINDING_PACKET_LIMITS.maxEvents }),
    receipts: Type.Array(Receipt, { maxItems: FINDING_PACKET_LIMITS.maxReceipts }),
    artifacts: Type.Array(ArtifactV2, { maxItems: FINDING_PACKET_LIMITS.maxArtifacts }),
    origins: Type.Array(Origin, { maxItems: FINDING_PACKET_LIMITS.maxHazards }),
  },
  Closed,
);
export interface FindingPacketV2 {
  format: typeof FINDING_PACKET_V2_FORMAT;
  manifest: FindingPacketManifestV2;
  manifestDigest: string;
  events: EvidenceEntry[];
  receipts: EvidenceReceipt[];
  artifacts: FindingPacketArtifactV2[];
  origins: FindingPacketOrigin[];
}
