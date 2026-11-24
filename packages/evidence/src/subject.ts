import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type {
  EvidenceArtifact,
  EvidenceEntry,
  EvidenceEnvelope,
  EvidenceReceipt,
  EvidenceStream,
  InputCut,
  PackAdoptionAcceptance,
  SubjectDecisionAcceptance,
  SubjectEvidenceBundle,
  SubjectExportCreate,
  SubjectExportRecord,
} from '@ledger/contracts';
import { getRuleSource } from '@ledger/domain';
import { canonicalDigest, canonicalize, entryHash, INTEGRITY_VERSION, sha256 } from '@ledger/integrity';
import {
  DomainError,
  readBoundedObject,
  writeBoundedObject,
  type AuthContext,
  type ObjectStore,
  type PoolClient,
} from '@ledger/persistence';
import { interpretEvidenceCut } from './evidence-cut.mjs';

const FORMAT = 'ledger.subject-evidence.2';
const LIMITS = {
  maxEvents: 5000,
  maxStreams: 2000,
  maxArtifacts: 1024,
  maxArtifactBytes: 16 * 1024 * 1024,
  maxBundleBytes: 32 * 1024 * 1024,
  maxRuleSources: 4,
  maxRuleSourceBytes: 8 * 1024 * 1024,
};
const LIMITATIONS = [
  'Disclosure includes complete prefixes of every captured tenant stream, including evidence unrelated to the selected organization decision.',
  'The unchanged evidence-cut.1 interpreter supplies immutable inventories only; its legacy flight wording does not define this subject bundle target.',
  'Retained basis and authority consistency is verified against journal commitments; dependency completeness, historical browser state and evaluator semantics are not replayed.',
  'The cited adoption retains authority and cuts but no historical dependency-basis manifest; that earlier manifest is not reconstructed.',
  'The organization snapshot is captured at export time and is not a historical accepted display.',
  'The manifest digest must be retained independently; this record is not externally timestamped or a person’s electronic signature.',
];
const INPUT_TYPES = [
  'order.revision',
  'intent.revision',
  'flight.observation',
  'airspace.status',
  'source.observation',
  'telemetry.segment',
  'command-link.status',
  'command-link.baseline',
  'monitoring.window',
  'mission.revision',
  // Generic intake, which command-link reports now use; the verifier already reads its receipts.
  'observation',
];
const safeNumber = (value: unknown): number => {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0)
    throw new DomainError(409, 'unsupported_evidence_number', 'Evidence has an unsupported numeric position');
  return result;
};
interface JournalRow {
  id: string;
  tenant_id: string;
  stream_id: string;
  sequence_text: string;
  event_type: string;
  schema_version: number;
  principal_id: string;
  source_id: string | null;
  source_session_id: string | null;
  occurred_at: string | null;
  effective_at: string | null;
  received_at: string;
  causation_id: string | null;
  artifact_id: string | null;
  payload: Record<string, unknown>;
  immutable_envelope: string | null;
  envelope_digest: string;
  previous_hash: string;
  entry_hash: string;
  encoding_version: string;
}
interface StreamRow {
  id: string;
  tenant_id: string;
  name: string;
  sequence: string;
  head_hash: string;
}
interface ArtifactRow {
  id: string;
  tenant_id: string;
  object_key: string;
  byte_length: number;
  sha256: string;
  content_type: string;
}
interface Capture {
  decision: SubjectDecisionAcceptance | null;
  adoption: PackAdoptionAcceptance | null;
  captured_at: Date;
  budget: {
    materialize: boolean;
    events: string;
    streams: string;
    artifacts: string;
    artifact_bytes: string;
    estimated_bytes: string;
    source_count: string;
    source_bytes: string;
  };
  entries: JournalRow[] | null;
  streams: StreamRow[] | null;
  receipts: EvidenceReceipt[] | null;
  artifacts: ArtifactRow[] | null;
  organization: { id: string; label: string; revision: number; projectedRevision: number };
  offsets: { stream_id: string; sequence: string }[] | null;
  projection_revision: string;
}

const captureSql = `WITH selected AS MATERIALIZED (
 SELECT record FROM decisions WHERE tenant_id=$3 AND id=$1 AND subject_id=$2 AND record IS NOT NULL
), cited AS MATERIALIZED (
 SELECT a.record FROM organization_pack_adoptions a,selected s
 WHERE a.tenant_id=$3 AND a.organization_id=$2 AND a.id=s.record->'adoption'->>'id'
), sources AS MATERIALIZED (
 SELECT DISTINCT leaf->'source'->'document'->>'sourceId' AS id,(leaf->'source'->'document'->>'byteLength')::bigint AS size
 FROM cited c CROSS JOIN LATERAL jsonb_array_elements(c.record->'pack'->'leaves') leaf WHERE leaf->'source' ? 'document'
), counts AS MATERIALIZED (
 SELECT (SELECT COUNT(*) FROM journal_events) AS events,(SELECT COUNT(*) FROM streams) AS streams,
 (SELECT COUNT(*) FROM artifacts a WHERE EXISTS(SELECT 1 FROM journal_events e WHERE e.artifact_id=a.id)) AS artifacts,
 (SELECT COALESCE(SUM(byte_length),0) FROM artifacts a WHERE EXISTS(SELECT 1 FROM journal_events e WHERE e.artifact_id=a.id)) AS artifact_bytes,
 (SELECT COUNT(*) FROM sources) AS source_count,(SELECT COALESCE(SUM(size),0) FROM sources) AS source_bytes
), small AS MATERIALIZED (
 SELECT *,events<=$4 AND streams<=$5 AND artifacts<=$6 AND artifact_bytes<=$7 AND source_count<=$9 AND source_bytes<=$10 AS allowed FROM counts
), sizes AS MATERIALIZED (
 SELECT *,CASE WHEN allowed THEN
 COALESCE((SELECT SUM(3*COALESCE(octet_length(immutable_envelope),octet_length(payload::text)+2000)+2*octet_length(payload::text)+4000) FROM journal_events),0)+
 COALESCE((SELECT SUM(2*octet_length(payload::text)+2*octet_length(input_subject::text)+1000) FROM receipts),0)+
 COALESCE((SELECT 3*octet_length(record::text) FROM selected),0)+COALESCE((SELECT 3*octet_length(record::text) FROM cited),0)+
 streams*1000+CEIL((artifact_bytes+source_bytes)*4.0/3)+artifacts*1000+65536 ELSE 0 END AS estimated_bytes FROM small
), allowed AS MATERIALIZED (SELECT *,allowed AND estimated_bytes<=$8 AS materialize FROM sizes),
 journal AS MATERIALIZED (SELECT e.* FROM journal_events e WHERE (SELECT materialize FROM allowed) AND EXISTS(SELECT 1 FROM selected))
SELECT (SELECT record FROM selected) AS decision,(SELECT record FROM cited) AS adoption,(SELECT row_to_json(a) FROM allowed a) AS budget,
 clock_timestamp() AS captured_at,
 CASE WHEN (SELECT materialize FROM allowed) THEN (SELECT json_agg(s ORDER BY s.id COLLATE "C") FROM (SELECT id,tenant_id,name,sequence::text,head_hash FROM streams) s) END AS streams,
 CASE WHEN (SELECT materialize FROM allowed) THEN (SELECT json_agg(j ORDER BY j.stream_id COLLATE "C",j.stream_sequence) FROM (SELECT e.*,e.stream_sequence::text AS sequence_text FROM journal e) j) END AS entries,
 CASE WHEN (SELECT materialize FROM allowed) THEN (SELECT json_agg(r ORDER BY r.id COLLATE "C") FROM (
 SELECT r.tenant_id AS "tenantId",r.id,r.event_id AS "eventId",r.source_id AS "sourceId",r.kind,r.occurred_at AS "occurredAt",r.received_at AS "receivedAt",r.source_revision::text AS "sourceRevision",r.artifact_id AS "artifactId",r.payload,r.input_subject AS "inputSubject"
 FROM receipts r WHERE EXISTS(SELECT 1 FROM journal e WHERE e.id=r.event_id)) r) END AS receipts,
 CASE WHEN (SELECT materialize FROM allowed) THEN (SELECT json_agg(a ORDER BY a.id COLLATE "C") FROM artifacts a WHERE EXISTS(SELECT 1 FROM journal e WHERE e.artifact_id=a.id)) END AS artifacts,
 (SELECT json_build_object('id',o.id,'label',t.name,'revision',o.revision,'projectedRevision',o.projected_revision) FROM organizations o JOIN tenants t ON t.id=o.tenant_id WHERE o.tenant_id=$3 AND o.id=$2) AS organization,
 CASE WHEN (SELECT materialize FROM allowed) THEN (SELECT json_agg(p ORDER BY p.stream_id COLLATE "C") FROM (SELECT stream_id,sequence::text FROM projection_offsets) p) END AS offsets,
 (SELECT COALESCE(MAX(id),0)::text FROM view_changes) AS projection_revision`;

function envelope(row: JournalRow): EvidenceEnvelope {
  const input = INPUT_TYPES.includes(row.event_type);
  const derived: EvidenceEnvelope = {
    eventId: row.id,
    tenantId: row.tenant_id,
    streamId: row.stream_id,
    sequence: row.sequence_text,
    type: row.event_type,
    schemaVersion: row.schema_version,
    principalId: row.principal_id,
    sourceId: row.source_id,
    sourceSessionId: row.source_session_id,
    occurredAt: input || row.event_type === 'evidence.correct' ? ((row.payload.occurredAt as string) ?? null) : null,
    effectiveAt: input ? ((row.payload.effectiveAt as string) ?? null) : null,
    receivedAt: new Date(row.received_at).toISOString(),
    causationId: row.causation_id,
    artifactId: row.artifact_id,
    payload: row.payload,
  };
  const exact = row.immutable_envelope ? (JSON.parse(row.immutable_envelope) as EvidenceEnvelope) : derived;
  if (
    row.encoding_version !== INTEGRITY_VERSION ||
    canonicalDigest(exact) !== row.envelope_digest ||
    (row.immutable_envelope !== null && canonicalize(exact) !== row.immutable_envelope)
  )
    throw new DomainError(409, 'historical_envelope_unavailable', 'Original journal envelope cannot be reproduced');
  for (const key of Object.keys(derived) as (keyof EvidenceEnvelope)[]) {
    if (key === 'occurredAt' || key === 'effectiveAt') {
      const value = key === 'occurredAt' ? row.occurred_at : row.effective_at;
      if (
        (exact[key] === null) !== (value === null) ||
        (value !== null && new Date(value).toISOString() !== new Date(exact[key]!).toISOString())
      )
        throw new DomainError(
          409,
          'journal_envelope_mismatch',
          'Retained source timestamp differs from its journal row',
        );
    } else if (canonicalize(exact[key]) !== canonicalize(derived[key]))
      throw new DomainError(409, 'journal_envelope_mismatch', 'Retained envelope differs from its journal row');
  }
  return exact;
}

export async function getSubjectExport(client: PoolClient, id: string): Promise<SubjectExportRecord> {
  return (await getSubjectExportObject(client, id)).record;
}
export async function getSubjectExportObject(
  client: PoolClient,
  id: string,
): Promise<{ record: SubjectExportRecord; key: string }> {
  const row = (
    await client.query<{ metadata: SubjectExportRecord; object_key: string }>(
      'SELECT metadata,object_key FROM export_records WHERE id=$1 AND format=$2',
      [id, FORMAT],
    )
  ).rows[0];
  if (!row) throw new DomainError(404, 'export_not_found', 'Subject export is unavailable within this scope');
  return { record: row.metadata, key: row.object_key };
}
export async function listSubjectExports(
  client: PoolClient,
  principal: AuthContext,
  decisionId?: string,
): Promise<{ records: SubjectExportRecord[]; limit: 20; hasMore: boolean }> {
  const rows = (
    await client.query<{ metadata: SubjectExportRecord }>(
      'SELECT metadata FROM export_records WHERE tenant_id=$1 AND subject_id=$2 AND format=$3 AND ($4::text IS NULL OR decision_id=$4) ORDER BY issued_at DESC,id DESC LIMIT 21',
      [principal.tenantId, `organization:${principal.tenantId}`, FORMAT, decisionId ?? null],
    )
  ).rows;
  return { records: rows.slice(0, 20).map((row) => row.metadata), limit: 20, hasMore: rows.length > 20 };
}

export async function createSubjectExport(
  client: PoolClient,
  principal: AuthContext,
  input: SubjectExportCreate,
  store: ObjectStore,
): Promise<SubjectExportRecord> {
  const until = Date.now() + 45000;
  const timeout = () => {
    const remaining = until - Date.now();
    if (remaining <= 0) throw new DomainError(409, 'export_deadline_exceeded', 'Export exceeded its bounded I/O time');
    return Math.min(10000, remaining);
  };
  await client.query("SET LOCAL statement_timeout='15s'");
  const subject = { kind: 'organization' as const, id: `organization:${principal.tenantId}` };
  const captured = (
    await client.query<Capture>(captureSql, [
      input.decisionId,
      subject.id,
      principal.tenantId,
      LIMITS.maxEvents,
      LIMITS.maxStreams,
      LIMITS.maxArtifacts,
      LIMITS.maxArtifactBytes,
      LIMITS.maxBundleBytes,
      LIMITS.maxRuleSources,
      LIMITS.maxRuleSourceBytes,
    ])
  ).rows[0];
  if (!captured.decision || !captured.adoption || !captured.organization)
    throw new DomainError(
      404,
      'decision_not_found',
      'Organization decision and adoption are unavailable within this scope',
    );
  if (!captured.budget.materialize)
    throw new DomainError(429, 'export_budget_exceeded', 'Complete tenant prefixes exceed the bounded export budget', {
      limits: LIMITS,
    });
  const decision = captured.decision;
  const adoption = captured.adoption;
  const envelopes = (captured.entries ?? []).map(envelope);
  const entries: SubjectEvidenceBundle['entries'] = (captured.entries ?? []).map((row, index) => ({
    canonicalEnvelope: canonicalize(envelopes[index]),
    envelopeDigest: row.envelope_digest,
    previousHash: row.previous_hash,
    entryHash: row.entry_hash,
    encodingVersion: INTEGRITY_VERSION,
  }));
  const byId = new Map(envelopes.map((event) => [event.eventId, event]));
  const { id: decisionId, recordedAt, ...accepted } = decision;
  const { id: adoptionId, acceptedAt, ...adopted } = adoption;
  if (
    byId.get(decisionId)?.type !== 'decision.record' ||
    byId.get(decisionId)?.receivedAt !== recordedAt ||
    canonicalDigest(byId.get(decisionId)?.payload.acceptance) !== canonicalDigest(accepted) ||
    byId.get(adoptionId)?.type !== 'rule-pack.adopt' ||
    byId.get(adoptionId)?.receivedAt !== acceptedAt ||
    canonicalDigest(byId.get(adoptionId)?.payload.acceptance) !== canonicalDigest(adopted)
  )
    throw new DomainError(
      409,
      'decision_commitment_mismatch',
      'Selected records differ from their immutable journal commitments',
    );
  const cuts = {
    rendered: decision.renderedInputCut,
    accepted: decision.acceptedInputCut,
    issuance: {
      streams: Object.fromEntries((captured.streams ?? []).map((row) => [row.id, safeNumber(row.sequence)])),
    },
  };
  const streams: EvidenceStream[] = (captured.streams ?? []).map((row) => {
    const group = envelopes.flatMap((event, index) =>
      event.streamId === row.id ? [{ event, entry: entries[index] }] : [],
    );
    let previous = '';
    for (const [index, item] of group.entries()) {
      if (
        BigInt(item.event.sequence) !== BigInt(index + 1) ||
        item.entry.previousHash !== previous ||
        entryHash(principal.tenantId, row.id, BigInt(index + 1), previous, item.entry.envelopeDigest) !==
          item.entry.entryHash
      )
        throw new DomainError(409, 'journal_prefix_invalid', 'Journal stream is incomplete or corrupt');
      previous = item.entry.entryHash;
    }
    if (BigInt(row.sequence) !== BigInt(group.length) || previous !== row.head_hash)
      throw new DomainError(409, 'journal_head_mismatch', 'Journal prefix differs from its captured head');
    const head = (cut: InputCut) => {
      const position = safeNumber(cut.streams[row.id] ?? 0);
      if (position > group.length)
        throw new DomainError(409, 'decision_cut_unavailable', 'Decision cut exceeds retained prefixes');
      return { sequence: String(position), hash: position === 0 ? '' : group[position - 1].entry.entryHash };
    };
    return {
      tenantId: row.tenant_id,
      id: row.id,
      name: row.name,
      headSequence: row.sequence,
      headHash: row.head_hash,
      cutHeads: { rendered: head(cuts.rendered), accepted: head(cuts.accepted), issuance: head(cuts.issuance) },
    };
  });
  for (const cut of Object.values(cuts))
    for (const id of Object.keys(cut.streams))
      if (!streams.some((stream) => stream.id === id))
        throw new DomainError(409, 'decision_cut_unavailable', 'Decision cut names an unavailable stream');
  const receipts = (captured.receipts ?? []).map((receipt) => ({
    ...receipt,
    occurredAt: new Date(receipt.occurredAt).toISOString(),
    receivedAt: new Date(receipt.receivedAt).toISOString(),
  }));
  if (receipts.some((receipt) => !INPUT_TYPES.includes(receipt.kind)))
    throw new DomainError(409, 'unsupported_receipt_kind', 'Subject exports do not yet support this receipt kind');
  const artifacts: EvidenceArtifact[] = [];
  for (const row of captured.artifacts ?? []) {
    let bytes: Uint8Array;
    try {
      bytes = await readBoundedObject(store, row.object_key, { maxBytes: row.byte_length, timeoutMs: timeout() });
    } catch {
      throw new DomainError(409, 'artifact_unavailable', 'Original artifact bytes are unavailable');
    }
    if (bytes.byteLength !== row.byte_length || sha256(bytes) !== row.sha256)
      throw new DomainError(409, 'artifact_integrity_failure', 'Original artifact bytes fail their retained digest');
    artifacts.push({
      tenantId: row.tenant_id,
      id: row.id,
      sha256: row.sha256,
      byteLength: row.byte_length,
      contentType: row.content_type,
      bytesBase64: Buffer.from(bytes).toString('base64'),
    });
  }
  const ruleSources: SubjectEvidenceBundle['ruleSources'] = [];
  for (const leaf of adoption.pack.leaves) {
    if (!('document' in leaf.source)) continue;
    const descriptor = leaf.source.document;
    if (ruleSources.some((source) => source.sourceId === descriptor.sourceId)) continue;
    const source = await getRuleSource(descriptor.sourceId);
    if (
      !source ||
      source.sha256 !== descriptor.sha256 ||
      source.byteLength !== descriptor.byteLength ||
      source.contentType !== descriptor.contentType
    )
      throw new DomainError(409, 'rule_source_unavailable', 'The exact original rule source is unavailable');
    ruleSources.push({
      sourceId: source.sourceId,
      sha256: source.sha256,
      byteLength: source.byteLength,
      contentType: source.contentType,
      bytesBase64: source.bytes.toString('base64'),
    });
  }
  const source = await readFile(new URL('./evidence-cut.mjs', import.meta.url), 'utf8');
  const runtimeContract: SubjectEvidenceBundle['interpreter']['runtimeContract'] = {
    name: 'node' as const,
    major: 24 as const,
    moduleFormat: 'esm' as const,
    dependencies: [] as string[],
    network: 'none' as const,
    interpretation: 'evidence-cut.1' as const,
    canonicalization: INTEGRITY_VERSION,
  };
  const interpretations = {
    rendered: interpretEvidenceCut(entries, cuts.rendered, principal.tenantId),
    accepted: interpretEvidenceCut(entries, cuts.accepted, principal.tenantId),
    issuance: interpretEvidenceCut(entries, cuts.issuance, principal.tenantId),
  };
  const issuedAt = captured.captured_at.toISOString();
  const sections = {
    streams,
    entries,
    receipts,
    artifacts,
    decision,
    actor: decision.actor,
    adoption,
    ruleSources,
    cuts,
    snapshot: {
      kind: 'export_time_sql_snapshot' as const,
      capturedAt: issuedAt,
      projectorVersion: 'thread.1' as const,
      projectionCut: {
        streams: Object.fromEntries((captured.offsets ?? []).map((row) => [row.stream_id, safeNumber(row.sequence)])),
      },
      projectionRevision: safeNumber(captured.projection_revision),
      subject,
      organization: captured.organization,
      limitations: [...LIMITATIONS],
    },
    interpreter: {
      name: 'evidence-cut.1' as const,
      sourceEncoding: 'utf8' as const,
      source,
      sourceSha256: sha256(source),
      runtimeContract,
      runtimeContractDigest: canonicalDigest(runtimeContract),
    },
    interpretations,
  };
  const counts = {
    events: entries.length,
    streams: streams.length,
    receipts: receipts.length,
    artifacts: artifacts.length,
    artifactBytes: artifacts.reduce((sum, item) => sum + item.byteLength, 0),
    ruleSources: ruleSources.length,
    ruleSourceBytes: ruleSources.reduce((sum, item) => sum + item.byteLength, 0),
  };
  const id = randomUUID();
  const interpretationDigests = {
    rendered: canonicalDigest(interpretations.rendered),
    accepted: canonicalDigest(interpretations.accepted),
    issuance: canonicalDigest(interpretations.issuance),
  };
  const manifest: SubjectEvidenceBundle['manifest'] = {
    format: FORMAT,
    exportId: id,
    tenantId: principal.tenantId,
    scope: 'whole_tenant_prefixes' as const,
    subject,
    decisionId,
    issuedBy: principal.id,
    issuedAt,
    versions: {
      integrity: INTEGRITY_VERSION,
      interpretation: 'evidence-cut.1' as const,
      snapshot: 'thread.1' as const,
    },
    counts,
    limits: { ...LIMITS },
    sectionDigests: Object.fromEntries(Object.entries(sections).map(([name, value]) => [name, canonicalDigest(value)])),
    interpretationDigests,
    limitations: [...LIMITATIONS],
  };
  const bundle: SubjectEvidenceBundle = {
    format: FORMAT,
    manifest,
    manifestDigest: canonicalDigest(manifest),
    ...sections,
  };
  const bytes = Buffer.from(canonicalize(bundle), 'utf8');
  if (bytes.byteLength > LIMITS.maxBundleBytes)
    throw new DomainError(429, 'export_budget_exceeded', 'Serialized evidence exceeds the bounded bundle byte limit');
  const summary = (name: keyof typeof interpretations) => ({
    eventCount: interpretations[name].events.length,
    digest: interpretationDigests[name],
    causalClosure: interpretations[name].missingCausationIds.length ? ('incomplete' as const) : ('closed' as const),
    missingCausationIds: interpretations[name].missingCausationIds,
  });
  const renderedIds = new Set(interpretations.rendered.events.map((event) => event.eventId));
  const record: SubjectExportRecord = {
    id,
    tenantId: principal.tenantId,
    format: FORMAT,
    subject,
    decisionId,
    issuedBy: principal.id,
    issuedAt,
    scope: 'whole_tenant_prefixes',
    byteLength: bytes.length,
    bundleSha256: sha256(bytes),
    manifestDigest: bundle.manifestDigest,
    snapshotDigest: canonicalDigest(sections.snapshot),
    anchorStatus: 'not_externally_anchored',
    interpretation: 'evidence-cut.1',
    counts,
    limits: { ...LIMITS },
    cuts,
    interpretations: { rendered: summary('rendered'), accepted: summary('accepted'), issuance: summary('issuance') },
    addedAcceptedEventIds: interpretations.accepted.events
      .filter((event) => !renderedIds.has(event.eventId))
      .map((event) => event.eventId),
    limitations: [...LIMITATIONS],
  };
  const key = `${principal.tenantId}/exports/${id}/bundle`;
  const stored = await writeBoundedObject(store, key, bytes, 'application/json', timeout());
  timeout();
  await client.query(
    'INSERT INTO export_records(id,tenant_id,decision_id,flight_id,subject_id,format,issued_by,issued_at,object_key,object_version,bundle_sha256,manifest_digest,byte_length,metadata) VALUES($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
    [
      id,
      principal.tenantId,
      decisionId,
      subject.id,
      FORMAT,
      principal.id,
      issuedAt,
      key,
      stored.version ?? null,
      record.bundleSha256,
      record.manifestDigest,
      record.byteLength,
      record,
    ],
  );
  return record;
}
