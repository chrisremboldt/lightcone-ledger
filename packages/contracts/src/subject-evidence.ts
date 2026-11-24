import { Type, type Static } from '@sinclair/typebox';
import type { ResponseMeta } from './index.js';
import { InputCutSchema } from './input-cut.js';
import { OrganizationSchema, PackAdoptionAcceptanceSchema } from './adoptions.js';
import {
  OrganizationSubjectSchema,
  SubjectDecisionAcceptanceSchema,
  SubjectDecisionActorSchema,
} from './subject-decisions.js';

const S = Type.String();
const Id = Type.String({ minLength: 1, maxLength: 200 });
const N = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const Digest = Type.String({ pattern: '^[a-f0-9]{64}$' });
const Time = Type.String({ format: 'date-time' });
const ObjectSchema = Type.Record(S, Type.Unknown());
const Format = Type.Literal('ledger.subject-evidence.2');
const Scope = Type.Literal('whole_tenant_prefixes');
const Cuts = Type.Object(
  { rendered: InputCutSchema, accepted: InputCutSchema, issuance: InputCutSchema },
  { additionalProperties: false },
);
const Summary = Type.Object({
  eventCount: N,
  digest: Digest,
  causalClosure: Type.Union([Type.Literal('closed'), Type.Literal('incomplete')]),
  missingCausationIds: Type.Array(S),
});
const Summaries = Type.Object({ rendered: Summary, accepted: Summary, issuance: Summary });
const Counts = Type.Object(
  { events: N, streams: N, receipts: N, artifacts: N, artifactBytes: N, ruleSources: N, ruleSourceBytes: N },
  { additionalProperties: false },
);
const Limits = Type.Object(
  {
    maxEvents: N,
    maxStreams: N,
    maxArtifacts: N,
    maxArtifactBytes: N,
    maxBundleBytes: N,
    maxRuleSources: N,
    maxRuleSourceBytes: N,
  },
  { additionalProperties: false },
);

export const SubjectExportCreateSchema = Type.Object(
  {
    subject: Type.Object({ kind: Type.Literal('organization') }, { additionalProperties: false }),
    decisionId: Id,
    scope: Scope,
  },
  { additionalProperties: false },
);
export type SubjectExportCreate = Static<typeof SubjectExportCreateSchema>;

export const SubjectExportRecordSchema = Type.Object(
  {
    id: S,
    tenantId: S,
    format: Format,
    subject: OrganizationSubjectSchema,
    decisionId: S,
    issuedBy: S,
    issuedAt: Time,
    scope: Scope,
    byteLength: N,
    bundleSha256: Digest,
    manifestDigest: Digest,
    snapshotDigest: Digest,
    anchorStatus: Type.Literal('not_externally_anchored'),
    interpretation: Type.Literal('evidence-cut.1'),
    counts: Counts,
    limits: Limits,
    cuts: Cuts,
    interpretations: Summaries,
    addedAcceptedEventIds: Type.Array(S),
    limitations: Type.Array(S),
  },
  { additionalProperties: false },
);
export type SubjectExportRecord = Static<typeof SubjectExportRecordSchema>;
export interface SubjectExportResponse {
  record: SubjectExportRecord;
  meta: ResponseMeta;
}
export interface SubjectExportListResponse {
  records: SubjectExportRecord[];
  limit: number;
  hasMore: boolean;
  meta: ResponseMeta;
}

const Head = Type.Object({ sequence: S, hash: S }, { additionalProperties: false });
const Stream = Type.Object(
  {
    tenantId: S,
    id: S,
    name: S,
    headSequence: S,
    headHash: S,
    cutHeads: Type.Object({ rendered: Head, accepted: Head, issuance: Head }),
  },
  { additionalProperties: false },
);
const Entry = Type.Object(
  {
    canonicalEnvelope: S,
    envelopeDigest: Digest,
    previousHash: S,
    entryHash: Digest,
    encodingVersion: Type.Literal('ledger.v6.sha256.jcs.1'),
  },
  { additionalProperties: false },
);
const Receipt = Type.Object(
  {
    tenantId: S,
    id: S,
    eventId: S,
    sourceId: S,
    kind: S,
    occurredAt: Time,
    receivedAt: Time,
    sourceRevision: Type.Union([S, Type.Null()]),
    artifactId: Type.Union([S, Type.Null()]),
    payload: ObjectSchema,
    inputSubject: ObjectSchema,
  },
  { additionalProperties: false },
);
const Artifact = Type.Object(
  { tenantId: S, id: S, sha256: Digest, byteLength: N, contentType: S, bytesBase64: S },
  { additionalProperties: false },
);
export const EvidenceRuleSourceSchema = Type.Object(
  { sourceId: S, sha256: Digest, byteLength: N, contentType: S, bytesBase64: S },
  { additionalProperties: false },
);
export type EvidenceRuleSource = Static<typeof EvidenceRuleSourceSchema>;
const Runtime = Type.Object(
  {
    name: Type.Literal('node'),
    major: Type.Literal(24),
    moduleFormat: Type.Literal('esm'),
    dependencies: Type.Array(S, { maxItems: 0 }),
    network: Type.Literal('none'),
    interpretation: Type.Literal('evidence-cut.1'),
    canonicalization: Type.Literal('ledger.v6.sha256.jcs.1'),
  },
  { additionalProperties: false },
);
const Interpreter = Type.Object(
  {
    name: Type.Literal('evidence-cut.1'),
    sourceEncoding: Type.Literal('utf8'),
    source: S,
    sourceSha256: Digest,
    runtimeContract: Runtime,
    runtimeContractDigest: Digest,
  },
  { additionalProperties: false },
);
const InventoryEvent = Type.Object({
  eventId: S,
  streamId: S,
  sequence: S,
  type: S,
  principalId: S,
  sourceId: Type.Union([S, Type.Null()]),
  occurredAt: Type.Union([S, Type.Null()]),
  effectiveAt: Type.Union([S, Type.Null()]),
  receivedAt: S,
  causationId: Type.Union([S, Type.Null()]),
  artifactId: Type.Union([S, Type.Null()]),
  envelopeDigest: Digest,
  entryHash: Digest,
});
const Interpretation = Type.Object({
  interpretation: Type.Literal('evidence-cut.1'),
  tenantId: S,
  cut: InputCutSchema,
  events: Type.Array(InventoryEvent),
  missingCausationIds: Type.Array(S),
  limitations: Type.Array(S),
});
const Interpretations = Type.Object({ rendered: Interpretation, accepted: Interpretation, issuance: Interpretation });
export const SubjectEvidenceSnapshotSchema = Type.Object(
  {
    kind: Type.Literal('export_time_sql_snapshot'),
    capturedAt: Time,
    projectorVersion: Type.Literal('thread.1'),
    projectionCut: InputCutSchema,
    projectionRevision: N,
    subject: OrganizationSubjectSchema,
    organization: OrganizationSchema,
    limitations: Type.Array(S),
  },
  { additionalProperties: false },
);
const sections = [
  'streams',
  'entries',
  'receipts',
  'artifacts',
  'decision',
  'actor',
  'adoption',
  'ruleSources',
  'cuts',
  'snapshot',
  'interpreter',
  'interpretations',
] as const;
const SectionDigests = Type.Object(Object.fromEntries(sections.map((name) => [name, Digest])), {
  additionalProperties: false,
});
export const SubjectEvidenceBundleSchema = Type.Object(
  {
    format: Format,
    manifest: Type.Object(
      {
        format: Format,
        exportId: S,
        tenantId: S,
        scope: Scope,
        subject: OrganizationSubjectSchema,
        decisionId: S,
        issuedBy: S,
        issuedAt: Time,
        versions: Type.Object({
          integrity: Type.Literal('ledger.v6.sha256.jcs.1'),
          interpretation: Type.Literal('evidence-cut.1'),
          snapshot: Type.Literal('thread.1'),
        }),
        counts: Counts,
        limits: Limits,
        sectionDigests: SectionDigests,
        interpretationDigests: Type.Object({ rendered: Digest, accepted: Digest, issuance: Digest }),
        limitations: Type.Array(S),
      },
      { additionalProperties: false },
    ),
    manifestDigest: Digest,
    streams: Type.Array(Stream),
    entries: Type.Array(Entry),
    receipts: Type.Array(Receipt),
    artifacts: Type.Array(Artifact),
    decision: SubjectDecisionAcceptanceSchema,
    actor: SubjectDecisionActorSchema,
    adoption: PackAdoptionAcceptanceSchema,
    ruleSources: Type.Array(EvidenceRuleSourceSchema),
    cuts: Cuts,
    snapshot: SubjectEvidenceSnapshotSchema,
    interpreter: Interpreter,
    interpretations: Interpretations,
  },
  { additionalProperties: false },
);
export type SubjectEvidenceBundle = Static<typeof SubjectEvidenceBundleSchema>;
