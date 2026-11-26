import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type {
  DecisionRecord,
  EvidenceActor,
  EvidenceArtifact,
  EvidenceCounts,
  EvidenceCuts,
  EvidenceEntry,
  EvidenceEnvelope,
  EvidenceInterpreter,
  EvidenceLimits,
  EvidenceReceipt,
  EvidenceRuntimeContract,
  EvidenceSnapshot,
  EvidenceStream,
  ExportCreate,
  ExportRecord,
  FlightEvidenceBundle,
  FlightEvidenceManifest,
  FlightSummary,
  InputCut,
  TimelineItem,
} from '@ledger/contracts';
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
export {
  createRecordProduction,
  getRecordProduction,
  getRecordProductionContent,
  listRecordProductions,
} from './record-productions.js';
export { assembleRecordProduction, type ProductionSources } from './record-production-assembly.js';
export {
  createRecordLink,
  listRecordLinks,
  openSharedRecords,
  openSharedRecordsArchive,
  openSharedRecordsFile,
  revokeRecordLink,
} from './record-production-links.js';
export {
  createProgramGrant,
  grantLinkSecret,
  grantNotInUse,
  listProgramGrants,
  readProgramView,
  revokeProgramGrant,
} from './program-grants.js';
export { readZip, writeZip } from './zip.js';
export { createSubjectExport, getSubjectExport, getSubjectExportObject, listSubjectExports } from './subject.js';
export { createSmsExport, getSmsExport, SMS_EXPORT_FORMAT } from './sms.js';
export { renderSmsPacket, type SmsPacketBundle } from './sms-packet.js';
export {
  createDecisionPacket,
  getDecisionPacket,
  getDecisionPacketObject,
  listDecisionPackets,
} from './decision-packets.js';
export {
  createFindingPacket,
  getFindingPacket,
  getFindingPacketContent,
  listFindingPackets,
} from './finding-packet-records.js';
export {
  assembleFindingPacket,
  assembleFindingPacketV2,
  originalsLeftOut,
  type FindingPacketSources,
  type PacketEvent,
} from './finding-packet-assembly.js';

const FLIGHT_FORMAT = 'ledger.flight-evidence.2';
const FLIGHT_FORMATS = ['ledger.decision-evidence.1', FLIGHT_FORMAT];
export const EXPORT_LIMITS: EvidenceLimits = {
  maxEvents: 5000,
  maxStreams: 2000,
  maxArtifacts: 1024,
  maxArtifactBytes: 16 * 1024 * 1024,
  maxBundleBytes: 32 * 1024 * 1024,
};
const LIMITATIONS = [
  'Disclosure includes complete prefixes of every captured tenant stream, including evidence unrelated to the selected flight.',
  'Exact replay means the retained evidence-cut.1 immutable inventory at the stored cuts; it does not mean thread.1 operational SQL replay.',
  'Historical browser snapshots, actor names/capabilities at prior authority revisions, random SQL identities and cross-stream acceptance/projector commit order were not retained.',
  'The operational SQL snapshot is captured when this export is created; it is not the historical rendered or accepted display and is not journal-rebuilt.',
  'The canonical manifest digest is an integrity anchor to retain independently; this record is not externally timestamped, signed or anchored.',
  'An older row without exact envelope retention is exported only when its reconstructed original envelope reproduces its stored digest.',
  'Flight decision dependency-basis manifests were not retained; this export does not reconstruct them from current dependencies.',
];
const iso = (value: string | Date): string => new Date(value).toISOString();
const number = (value: unknown): number => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new DomainError(409, 'unsupported_evidence_number', 'Evidence has an unsupported numeric position');
  return n;
};
function decision(row: Record<string, any>): DecisionRecord {
  return {
    id: row.id,
    flightId: row.flight_id,
    actorId: row.actor_id,
    kind: row.kind,
    note: row.note,
    recordedAt: iso(row.recorded_at),
    renderedInputCut: row.rendered_input_cut,
    acceptedInputCut: row.accepted_input_cut,
    acceptedBasisRevision: number(row.accepted_basis_revision),
  };
}
function timeline(row: Record<string, any>): TimelineItem {
  return {
    id: row.id,
    lane: row.lane,
    kind: row.kind,
    title: row.title,
    occurredAt: iso(row.occurred_at),
    receivedAt: iso(row.received_at),
    actorId: row.actor_id,
    ...(row.source_id ? { sourceId: row.source_id } : {}),
    payload: row.payload,
    ...(row.receipt_id ? { receiptId: row.receipt_id } : {}),
    ...(row.artifact_id ? { artifactId: row.artifact_id } : {}),
    ...(row.correction_of ? { correctionOf: row.correction_of } : {}),
    linkStatus: row.link_status,
  };
}
function envelope(row: Record<string, any>): EvidenceEnvelope {
  // The hashed envelope used the source's lexical timestamps, not PostgreSQL's normalized spelling.
  const input = [
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
  ].includes(row.event_type);
  const occurredAt = input || row.event_type === 'evidence.correct' ? (row.payload.occurredAt ?? null) : null;
  const effectiveAt = input ? (row.payload.effectiveAt ?? null) : null;
  const derived: EvidenceEnvelope = {
    eventId: row.id,
    tenantId: row.tenant_id,
    streamId: row.stream_id,
    sequence: String(row.stream_sequence),
    type: row.event_type,
    schemaVersion: row.schema_version,
    principalId: row.principal_id,
    sourceId: row.source_id,
    sourceSessionId: row.source_session_id,
    occurredAt,
    effectiveAt,
    receivedAt: iso(row.received_at),
    causationId: row.causation_id,
    artifactId: row.artifact_id,
    payload: row.payload,
  };
  const exact = row.immutable_envelope ? (JSON.parse(row.immutable_envelope) as EvidenceEnvelope) : derived;
  const canonical = canonicalize(exact);
  if (
    row.encoding_version !== INTEGRITY_VERSION ||
    canonicalDigest(exact) !== row.envelope_digest ||
    (row.immutable_envelope && canonical !== row.immutable_envelope)
  )
    throw new DomainError(
      409,
      'historical_envelope_unavailable',
      'Original journal envelope cannot be reproduced under its retained encoding',
      { eventId: row.id },
    );
  for (const key of [
    'eventId',
    'tenantId',
    'streamId',
    'sequence',
    'type',
    'schemaVersion',
    'principalId',
    'sourceId',
    'sourceSessionId',
    'receivedAt',
    'causationId',
    'artifactId',
    'payload',
  ] as const)
    if (canonicalize(exact[key]) !== canonicalize(derived[key]))
      throw new DomainError(409, 'journal_envelope_mismatch', 'Retained envelope differs from its journal row', {
        eventId: row.id,
      });
  for (const [name, value] of [
    ['occurred_at', exact.occurredAt],
    ['effective_at', exact.effectiveAt],
  ] as const)
    if ((row[name] === null) !== (value === null) || (value !== null && iso(row[name]) !== iso(value)))
      throw new DomainError(
        409,
        'journal_envelope_mismatch',
        'Retained source timestamp differs from its journal row',
        { eventId: row.id },
      );
  return exact;
}

/** All data below is evaluated in ONE MVCC statement, after the normal idempotency/authority locks.
 * Count and conservative byte checks gate json_agg, so an over-budget tenant never materializes payloads in the API. */
const captureSql = `WITH selected AS MATERIALIZED (SELECT * FROM decisions WHERE id=$1 AND flight_id=$2),
 counts AS MATERIALIZED (SELECT (SELECT COUNT(*) FROM journal_events) AS events,(SELECT COUNT(*) FROM streams) AS streams,
 (SELECT COUNT(*) FROM artifacts a WHERE EXISTS(SELECT 1 FROM journal_events e WHERE e.artifact_id=a.id)) AS artifacts,
 (SELECT COALESCE(SUM(byte_length),0) FROM artifacts a WHERE EXISTS(SELECT 1 FROM journal_events e WHERE e.artifact_id=a.id)) AS artifact_bytes),
 small AS MATERIALIZED (SELECT *,events<=$3 AND streams<=$4 AND artifacts<=$5 AND artifact_bytes<=$6 AS allowed FROM counts),
 sizes AS MATERIALIZED (SELECT *,
 CASE WHEN allowed THEN
 COALESCE((SELECT SUM(3*COALESCE(octet_length(immutable_envelope),octet_length(payload::text)+2000)+2*octet_length(payload::text)+4000) FROM journal_events),0)+
 COALESCE((SELECT SUM(2*octet_length(payload::text)+2*octet_length(input_subject::text)+1000) FROM receipts),0)+
 COALESCE((SELECT SUM(2*octet_length(payload::text)+1000) FROM timeline_items WHERE flight_id=$2),0)+
 COALESCE((SELECT SUM(2*octet_length(note)+2*octet_length(rendered_input_cut::text)+2*octet_length(accepted_input_cut::text)+1000) FROM decisions WHERE flight_id=$2),0)+
 streams*1000+CEIL(artifact_bytes*4.0/3)+artifacts*1000+65536 ELSE 0 END AS estimated_bytes FROM small),
 allowed AS MATERIALIZED (SELECT *,allowed AND estimated_bytes<=$7 AS materialize FROM sizes),
 journal AS MATERIALIZED (SELECT e.* FROM journal_events e WHERE (SELECT materialize FROM allowed) AND EXISTS(SELECT 1 FROM selected)),
 receipt_rows AS MATERIALIZED (SELECT r.id,r.tenant_id,r.event_id,r.source_id,r.kind,r.occurred_at,r.received_at,r.source_revision::text,r.artifact_id,r.payload,r.input_subject FROM receipts r WHERE EXISTS(SELECT 1 FROM journal e WHERE e.id=r.event_id)),
 timeline_rows AS MATERIALIZED (SELECT * FROM timeline_items WHERE flight_id=$2 AND (SELECT materialize FROM allowed) AND EXISTS(SELECT 1 FROM selected)),
 decision_rows AS MATERIALIZED (SELECT * FROM decisions WHERE flight_id=$2 AND (SELECT materialize FROM allowed) AND EXISTS(SELECT 1 FROM selected))
 SELECT (SELECT row_to_json(s) FROM selected s) AS decision,
 (SELECT row_to_json(a) FROM allowed a) AS budget,
 clock_timestamp() AS captured_at,
 CASE WHEN (SELECT materialize FROM allowed) THEN (SELECT json_agg(s ORDER BY s.id COLLATE "C") FROM (SELECT id,tenant_id,name,sequence::text,head_hash FROM streams) s) END AS streams,
 CASE WHEN (SELECT materialize FROM allowed) THEN (SELECT json_agg(e ORDER BY e.stream_id COLLATE "C",e.stream_sequence) FROM (SELECT j.*,j.stream_sequence::text AS sequence_text FROM journal j) e) END AS entries,
 CASE WHEN (SELECT materialize FROM allowed) THEN (SELECT json_agg(r ORDER BY r.id COLLATE "C") FROM receipt_rows r) END AS receipts,
 CASE WHEN (SELECT materialize FROM allowed) THEN (SELECT json_agg(a ORDER BY a.id COLLATE "C") FROM artifacts a WHERE EXISTS(SELECT 1 FROM journal e WHERE e.artifact_id=a.id)) END AS artifacts,
 CASE WHEN (SELECT materialize FROM allowed) THEN (SELECT row_to_json(f) FROM flight_views f WHERE f.id=$2) END AS flight,
 CASE WHEN (SELECT materialize FROM allowed) THEN (SELECT json_agg(t ORDER BY t.received_at,t.id COLLATE "C") FROM timeline_rows t) END AS timeline,
 CASE WHEN (SELECT materialize FROM allowed) THEN (SELECT json_agg(d ORDER BY d.recorded_at,d.id COLLATE "C") FROM decision_rows d) END AS decisions,
 CASE WHEN (SELECT materialize FROM allowed) THEN (SELECT json_agg(f ORDER BY f.order_external_id COLLATE "C") FROM fulfillments f WHERE f.flight_id=$2) END AS fulfillments,
 CASE WHEN (SELECT materialize FROM allowed) THEN (SELECT json_agg(p ORDER BY p.stream_id COLLATE "C") FROM projection_offsets p) END AS offsets,
 (SELECT COALESCE(MAX(id),0)::text FROM view_changes) AS projection_revision,
 (SELECT COUNT(*) FROM work_items w LEFT JOIN receipts r ON r.tenant_id=w.tenant_id AND r.event_id=w.event_id JOIN journal_events e ON e.tenant_id=w.tenant_id AND e.id=w.event_id WHERE w.state<>'completed' AND (r.flight_id=$2 OR e.payload->>'flightId'=$2)) AS outstanding,
 (SELECT COUNT(*) FROM receipts r JOIN flight_views f ON f.id=$2 WHERE r.link_status IN ('unresolved','candidate') AND (r.input_subject->>'originationKey'=f.origination_key OR EXISTS(SELECT 1 FROM aliases a WHERE a.subject_id=f.id AND a.source_id=r.source_id AND a.external_id=r.input_subject->>'externalFlightId' AND (a.valid_from IS NULL OR a.valid_from<=r.occurred_at) AND (a.valid_to IS NULL OR a.valid_to>r.occurred_at)))) AS unresolved`;

export async function getExport(client: PoolClient, id: string): Promise<ExportRecord> {
  const row = (
    await client.query<{ metadata: Omit<ExportRecord, 'format'>; format: ExportRecord['format'] }>(
      'SELECT metadata,format FROM export_records WHERE id=$1 AND format=ANY($2::text[])',
      [id, FLIGHT_FORMATS],
    )
  ).rows[0];
  if (!row) throw new DomainError(404, 'export_not_found', 'Export is unavailable within this scope');
  return { ...row.metadata, format: row.format };
}
export async function getExportObject(client: PoolClient, id: string): Promise<{ record: ExportRecord; key: string }> {
  const row = (
    await client.query<{
      metadata: Omit<ExportRecord, 'format'>;
      format: ExportRecord['format'];
      object_key: string;
    }>('SELECT metadata,format,object_key FROM export_records WHERE id=$1 AND format=ANY($2::text[])', [
      id,
      FLIGHT_FORMATS,
    ])
  ).rows[0];
  if (!row) throw new DomainError(404, 'export_not_found', 'Export is unavailable within this scope');
  return { record: { ...row.metadata, format: row.format }, key: row.object_key };
}
export async function createExport(
  client: PoolClient,
  principal: AuthContext,
  input: ExportCreate,
  store: ObjectStore,
): Promise<ExportRecord> {
  const operationUntil = Date.now() + 45000;
  const ioTimeout = () => {
    const remaining = operationUntil - Date.now();
    if (remaining <= 0)
      throw new DomainError(
        409,
        'export_deadline_exceeded',
        'Export exceeded its bounded object I/O time; retry this request',
      );
    return Math.min(10000, remaining);
  };
  await client.query("SET LOCAL statement_timeout='15s'");
  const limits = EXPORT_LIMITS;
  const captured = (
    await client.query(captureSql, [
      input.decisionId,
      input.flightId,
      limits.maxEvents,
      limits.maxStreams,
      limits.maxArtifacts,
      limits.maxArtifactBytes,
      limits.maxBundleBytes,
    ])
  ).rows[0];
  if (!captured.decision)
    throw new DomainError(404, 'decision_not_found', 'Decision and flight are unavailable within this scope');
  if (!captured.budget.materialize)
    throw new DomainError(
      429,
      'export_budget_exceeded',
      'The complete tenant prefixes exceed this bounded export budget',
      {
        limits,
        counts: {
          events: captured.budget.events,
          streams: captured.budget.streams,
          artifacts: captured.budget.artifacts,
          artifactBytes: captured.budget.artifact_bytes,
        },
        estimatedBytes: captured.budget.estimated_bytes,
      },
    );
  const selected = decision(captured.decision),
    entries: EvidenceEntry[] = [],
    envelopes: EvidenceEnvelope[] = [];
  for (const row of captured.entries ?? []) {
    row.stream_sequence = row.sequence_text;
    const exact = envelope(row);
    envelopes.push(exact);
    entries.push({
      canonicalEnvelope: canonicalize(exact),
      envelopeDigest: row.envelope_digest,
      previousHash: row.previous_hash,
      entryHash: row.entry_hash,
      encodingVersion: row.encoding_version,
    });
  }
  const byId = new Map(envelopes.map((e, i) => [e.eventId, { envelope: e, entry: entries[i] }]));
  const commitment = byId.get(selected.id);
  if (
    !commitment ||
    commitment.envelope.type !== 'decision.record' ||
    commitment.envelope.principalId !== selected.actorId ||
    commitment.envelope.payload.flightId !== selected.flightId ||
    canonicalDigest(commitment.envelope.payload.decision) !==
      canonicalDigest({ kind: selected.kind, note: selected.note }) ||
    canonicalDigest(commitment.envelope.payload.inputCut) !== canonicalDigest(selected.renderedInputCut) ||
    canonicalDigest(commitment.envelope.payload.acceptedInputCut) !== canonicalDigest(selected.acceptedInputCut)
  )
    throw new DomainError(
      409,
      'decision_commitment_mismatch',
      'Decision row differs from its immutable journal commitment',
    );
  const issuance: InputCut = {
    streams: Object.fromEntries(
      (captured.streams ?? []).map((stream: Record<string, any>) => [stream.id, number(stream.sequence)]),
    ),
  };
  const cuts: EvidenceCuts = { rendered: selected.renderedInputCut, accepted: selected.acceptedInputCut, issuance };
  const groups = new Map<string, { e: EvidenceEnvelope; entry: EvidenceEntry }[]>();
  for (let i = 0; i < envelopes.length; i++) {
    const e = envelopes[i];
    const group = groups.get(e.streamId) ?? [];
    group.push({ e, entry: entries[i] });
    groups.set(e.streamId, group);
  }
  const streams: EvidenceStream[] = [];
  for (const row of captured.streams ?? []) {
    const group = groups.get(row.id) ?? [];
    let previous = '';
    let sequence = 0n;
    for (const { e, entry } of group) {
      sequence++;
      if (
        BigInt(e.sequence) !== sequence ||
        entry.previousHash !== previous ||
        entryHash(principal.tenantId, row.id, sequence, previous, entry.envelopeDigest) !== entry.entryHash
      )
        throw new DomainError(409, 'journal_prefix_invalid', 'Journal stream is incomplete or corrupt', {
          streamId: row.id,
        });
      previous = entry.entryHash;
    }
    if (sequence !== BigInt(row.sequence) || previous !== row.head_hash)
      throw new DomainError(409, 'journal_head_mismatch', 'Journal prefix does not reproduce its captured head', {
        streamId: row.id,
      });
    const head = (cut: InputCut) => {
      const position = BigInt(cut.streams[row.id] ?? 0);
      if (position < 0n || position > sequence)
        throw new DomainError(409, 'decision_cut_unavailable', 'Stored decision cut exceeds retained prefixes');
      return {
        sequence: position.toString(),
        hash: position === 0n ? '' : group[number(position) - 1].entry.entryHash,
      };
    };
    streams.push({
      tenantId: row.tenant_id,
      id: row.id,
      name: row.name,
      headSequence: sequence.toString(),
      headHash: previous,
      cutHeads: { rendered: head(cuts.rendered), accepted: head(cuts.accepted), issuance: head(cuts.issuance) },
    });
  }
  for (const cut of Object.values(cuts) as InputCut[])
    for (const [id, position] of Object.entries(cut.streams))
      if (
        !streams.some((stream) => stream.id === id) ||
        typeof position !== 'number' ||
        !Number.isSafeInteger(position) ||
        position < 0
      )
        throw new DomainError(409, 'decision_cut_unavailable', 'Stored decision cut names an unavailable stream');
  const receipts: EvidenceReceipt[] = (captured.receipts ?? []).map((r: Record<string, any>) => ({
    tenantId: r.tenant_id,
    id: r.id,
    eventId: r.event_id,
    sourceId: r.source_id,
    kind: r.kind,
    occurredAt: iso(r.occurred_at),
    receivedAt: iso(r.received_at),
    sourceRevision: r.source_revision,
    artifactId: r.artifact_id,
    payload: r.payload,
    inputSubject: r.input_subject,
  }));
  const receiptIds = new Set(receipts.map((r) => r.id));
  for (const e of envelopes) {
    if (
      (e.causationId && !byId.has(e.causationId)) ||
      (typeof e.payload.correctionOf === 'string' && !byId.has(e.payload.correctionOf)) ||
      (e.type === 'identity.link' && typeof e.payload.receiptId === 'string' && !receiptIds.has(e.payload.receiptId))
    )
      throw new DomainError(
        409,
        'evidence_reference_missing',
        'Whole-tenant prefix lacks a durable referenced record',
        { eventId: e.eventId },
      );
  }
  const artifacts: EvidenceArtifact[] = [];
  for (const row of captured.artifacts ?? []) {
    let bytes: Uint8Array;
    try {
      bytes = await readBoundedObject(store, row.object_key, { maxBytes: row.byte_length, timeoutMs: ioTimeout() });
    } catch {
      throw new DomainError(
        409,
        'artifact_unavailable',
        'Original artifact bytes are unavailable or exceeded their byte/time bounds',
        { artifactId: row.id },
      );
    }
    if (bytes.byteLength !== row.byte_length || sha256(bytes) !== row.sha256)
      throw new DomainError(409, 'artifact_integrity_failure', 'Original artifact bytes fail their retained digest', {
        artifactId: row.id,
      });
    artifacts.push({
      tenantId: row.tenant_id,
      id: row.id,
      sha256: row.sha256,
      byteLength: row.byte_length,
      contentType: row.content_type,
      bytesBase64: Buffer.from(bytes).toString('base64'),
    });
  }
  const actor: EvidenceActor = {
    id: selected.actorId,
    authorityRevision: selected.acceptedInputCut.principalRevision ?? null,
    historicalProfile: 'not_retained',
  };
  const f = captured.flight as Record<string, any>;
  const flight: FlightSummary = {
    id: f.id,
    label: f.label,
    originationKey: f.origination_key,
    revision: number(f.revision),
    basisRevision: number(f.basis_revision),
    activity: f.activity,
    coverage: f.coverage,
    ...(f.aircraft ? { aircraft: f.aircraft } : {}),
    ...(f.scheduled_start ? { scheduledStart: iso(f.scheduled_start) } : {}),
    ...(f.scheduled_end ? { scheduledEnd: iso(f.scheduled_end) } : {}),
    ...(f.last_occurred_at ? { lastOccurredAt: iso(f.last_occurred_at) } : {}),
    ...(f.last_received_at ? { lastReceivedAt: iso(f.last_received_at) } : {}),
    orderIds: (captured.fulfillments ?? []).map((r: Record<string, any>) => r.order_external_id),
    sourceIds: f.source_ids,
    unresolvedCount: number(captured.unresolved),
    conflictCount: number(f.conflict_count),
    outstandingWork: number(captured.outstanding),
  };
  const snapshot: EvidenceSnapshot = {
    kind: 'export_time_sql_snapshot',
    capturedAt: iso(captured.captured_at),
    projectorVersion: 'thread.1',
    projectionCut: {
      streams: Object.fromEntries(
        (captured.offsets ?? []).map((r: Record<string, any>) => [r.stream_id, number(r.sequence)]),
      ),
      basisRevision: flight.basisRevision,
      principalRevision: principal.revision,
    },
    projectionRevision: number(captured.projection_revision),
    flight,
    items: (captured.timeline ?? []).map(timeline),
    decisions: (captured.decisions ?? []).map(decision),
    limitations: [LIMITATIONS[1], LIMITATIONS[2], LIMITATIONS[3]],
  };
  const source = await readFile(new URL('./evidence-cut.mjs', import.meta.url), 'utf8');
  const runtimeContract: EvidenceRuntimeContract = {
    name: 'node',
    major: 24,
    moduleFormat: 'esm',
    dependencies: [],
    network: 'none',
    interpretation: 'evidence-cut.1',
    canonicalization: INTEGRITY_VERSION,
  };
  const interpreter: EvidenceInterpreter = {
    name: 'evidence-cut.1',
    sourceEncoding: 'utf8',
    source,
    sourceSha256: sha256(source),
    runtimeContract,
    runtimeContractDigest: canonicalDigest(runtimeContract),
  };
  const interpretations = {
    rendered: interpretEvidenceCut(entries, cuts.rendered, principal.tenantId),
    accepted: interpretEvidenceCut(entries, cuts.accepted, principal.tenantId),
    issuance: interpretEvidenceCut(entries, cuts.issuance, principal.tenantId),
  };
  const counts: EvidenceCounts = {
    events: entries.length,
    streams: streams.length,
    receipts: receipts.length,
    artifacts: artifacts.length,
    artifactBytes: artifacts.reduce((n, a) => n + a.byteLength, 0),
  };
  const id = randomUUID(),
    issuedAt = iso(captured.captured_at);
  const sections = {
    streams,
    entries,
    receipts,
    artifacts,
    decision: selected,
    actor,
    basisManifest: { status: 'not_retained' as const },
    cuts,
    snapshot,
    interpreter,
    interpretations,
  };
  const sectionDigests = Object.fromEntries(
    Object.entries(sections).map(([name, value]) => [name, canonicalDigest(value)]),
  ) as FlightEvidenceManifest['sectionDigests'];
  const interpretationDigests = {
    rendered: canonicalDigest(interpretations.rendered),
    accepted: canonicalDigest(interpretations.accepted),
    issuance: canonicalDigest(interpretations.issuance),
  };
  const manifest: FlightEvidenceManifest = {
    format: FLIGHT_FORMAT,
    exportId: id,
    tenantId: principal.tenantId,
    scope: 'whole_tenant_prefixes',
    flightId: input.flightId,
    subject: { kind: 'flight', id: input.flightId },
    decisionId: input.decisionId,
    issuedBy: principal.id,
    issuedAt,
    versions: { integrity: INTEGRITY_VERSION, interpretation: 'evidence-cut.1', snapshot: 'thread.1' },
    counts,
    limits: { ...limits },
    sectionDigests,
    interpretationDigests,
    limitations: [...LIMITATIONS],
  };
  const bundle: FlightEvidenceBundle = {
    format: manifest.format,
    manifest,
    manifestDigest: canonicalDigest(manifest),
    ...sections,
  };
  const bytes = Buffer.from(canonicalize(bundle), 'utf8');
  if (bytes.byteLength > limits.maxBundleBytes)
    throw new DomainError(429, 'export_budget_exceeded', 'Serialized evidence exceeds the bounded bundle byte limit', {
      byteLength: bytes.byteLength,
      limits,
    });
  const summary = (name: keyof typeof interpretations) => ({
    eventCount: interpretations[name].events.length,
    digest: interpretationDigests[name],
    causalClosure: interpretations[name].missingCausationIds.length ? ('incomplete' as const) : ('closed' as const),
    missingCausationIds: interpretations[name].missingCausationIds,
  });
  const renderedIds = new Set(interpretations.rendered.events.map((e) => e.eventId));
  const record: ExportRecord = {
    id,
    format: FLIGHT_FORMAT,
    tenantId: principal.tenantId,
    flightId: input.flightId,
    decisionId: input.decisionId,
    issuedBy: principal.id,
    issuedAt,
    scope: 'whole_tenant_prefixes',
    byteLength: bytes.byteLength,
    bundleSha256: sha256(bytes),
    manifestDigest: bundle.manifestDigest,
    snapshotDigest: sectionDigests.snapshot,
    anchorStatus: 'not_externally_anchored',
    interpretation: 'evidence-cut.1',
    counts,
    limits: { ...limits },
    cuts,
    interpretations: { rendered: summary('rendered'), accepted: summary('accepted'), issuance: summary('issuance') },
    addedAcceptedEventIds: interpretations.accepted.events
      .filter((e) => !renderedIds.has(e.eventId))
      .map((e) => e.eventId),
    limitations: [...LIMITATIONS],
  };
  const key = `${principal.tenantId}/exports/${id}/bundle`;
  const stored = await writeBoundedObject(store, key, bytes, 'application/json', ioTimeout());
  ioTimeout();
  await client.query(
    'INSERT INTO export_records(id,tenant_id,decision_id,flight_id,format,issued_by,issued_at,object_key,object_version,bundle_sha256,manifest_digest,byte_length,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
    [
      id,
      principal.tenantId,
      input.decisionId,
      input.flightId,
      FLIGHT_FORMAT,
      principal.id,
      issuedAt,
      key,
      stored.version ?? null,
      record.bundleSha256,
      record.manifestDigest,
      bytes.byteLength,
      record,
    ],
  );
  return record;
}
