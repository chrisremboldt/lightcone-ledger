import {
  FINDING_PACKET_LIMITS,
  type EvidenceEnvelope,
  type EvidenceReceipt,
  type FindingPacketArtifact,
  type HazardOrigin,
  type RuleEvaluationRecord,
  type SubjectReference,
} from '@ledger/contracts';
import { correctionSql } from '@ledger/domain';
import { canonicalDigest, canonicalize, entryHash, INTEGRITY_VERSION, parseStrictJson } from '@ledger/integrity';
import { DomainError, type PoolClient } from '@ledger/persistence';
import {
  adoptionRecordOf,
  evaluationRecordOf,
  type FindingPacketSources,
  type PacketCorrection,
  type PacketEvent,
  type PacketFinding,
  type PacketHazard,
  type PacketObservation,
  type PacketTreatment,
} from './finding-packet-assembly.js';

const LIMITS = FINDING_PACKET_LIMITS;

interface JournalRow {
  id: string;
  tenant_id: string;
  stream_id: string;
  sequence: string;
  immutable_envelope: string | null;
  bytes: number | null;
  envelope_digest: string;
  previous_hash: string;
  entry_hash: string;
  encoding_version: string;
}

function requireRecord(condition: unknown, message: string): asserts condition {
  if (!condition) throw new DomainError(409, 'finding_packet_reference_invalid', message);
}

function bounded(condition: boolean): void {
  if (!condition)
    throw new DomainError(429, 'finding_packet_budget_exceeded', 'The finding records exceed the packet budget');
}

/** Loads retained journal entries by id, each checked against its own integrity fields. */
async function loadEvents(client: PoolClient, tenantId: string, ids: string[]): Promise<PacketEvent[]> {
  const wanted = [...new Set(ids)];
  if (!wanted.length) return [];
  bounded(wanted.length <= LIMITS.maxEvents);
  const rows = await client.query<JournalRow>(
    `SELECT id,tenant_id,stream_id,stream_sequence::text AS sequence,
       CASE WHEN octet_length(immutable_envelope)<=$3 THEN immutable_envelope END AS immutable_envelope,
       octet_length(immutable_envelope) AS bytes,envelope_digest,previous_hash,entry_hash,encoding_version
     FROM journal_events WHERE tenant_id=$1 AND id=ANY($2::text[]) ORDER BY id LIMIT $4`,
    [tenantId, wanted, LIMITS.maxEnvelopeBytes, wanted.length + 1],
  );
  requireRecord(rows.rows.length === wanted.length, 'A selected event is missing within this tenant');
  return rows.rows.map((row) => {
    requireRecord(row.bytes !== null, `The exact bytes of event ${row.id} were not retained`);
    bounded(row.immutable_envelope !== null);
    const envelope = parseStrictJson(row.immutable_envelope!, {
      maxBytes: LIMITS.maxEnvelopeBytes,
    }) as EvidenceEnvelope;
    requireRecord(
      envelope.eventId === row.id &&
        envelope.tenantId === tenantId &&
        envelope.streamId === row.stream_id &&
        envelope.sequence === row.sequence &&
        canonicalize(envelope) === row.immutable_envelope &&
        canonicalDigest(envelope) === row.envelope_digest &&
        row.encoding_version === INTEGRITY_VERSION &&
        entryHash(tenantId, row.stream_id, BigInt(row.sequence), row.previous_hash, row.envelope_digest) ===
          row.entry_hash,
      `Event ${row.id} differs from its retained integrity fields`,
    );
    return {
      envelope,
      entry: {
        canonicalEnvelope: row.immutable_envelope!,
        envelopeDigest: row.envelope_digest,
        previousHash: row.previous_hash,
        entryHash: row.entry_hash,
        encodingVersion: row.encoding_version,
      },
    };
  });
}

interface FindingRow {
  id: string;
  subject_key: string | null;
  subject_scope: SubjectReference['scope'];
  subject_kind: SubjectReference['kind'];
  subject_id: string;
  subject_source_id: string | null;
  pack_id: string;
  leaf_id: string;
  opened_at: Date;
  initial_rule_evaluation_id: string | null;
  latest_rule_evaluation_id: string | null;
  status: string;
}

async function loadFinding(client: PoolClient, tenantId: string, findingId: string): Promise<PacketFinding> {
  const row = (
    await client.query<FindingRow>(
      `SELECT f.id,f.subject_key,f.subject_scope,f.subject_kind,f.subject_id,f.subject_source_id,f.pack_id,f.leaf_id,
         f.opened_at,f.initial_rule_evaluation_id,v.latest_rule_evaluation_id,v.status
       FROM findings f JOIN finding_views v ON v.tenant_id=f.tenant_id AND v.id=f.id WHERE f.tenant_id=$1 AND f.id=$2`,
      [tenantId, findingId],
    )
  ).rows[0];
  if (!row) throw new DomainError(404, 'finding_packet_not_found', 'The finding was not found in your organization');
  // Eligibility is which records exist: a finding without rule evaluations has none of what this packet holds.
  if (!row.subject_key || !row.initial_rule_evaluation_id || !row.latest_rule_evaluation_id)
    throw new DomainError(
      409,
      'finding_packet_unavailable',
      'This finding has no rule evaluations for a subject; its decisions are packaged as a decision packet',
    );
  return {
    id: row.id,
    subject:
      row.subject_scope === 'source'
        ? { scope: 'source', kind: row.subject_kind, id: row.subject_id, sourceId: row.subject_source_id! }
        : { scope: 'ledger', kind: row.subject_kind, id: row.subject_id },
    subjectKey: row.subject_key,
    packId: row.pack_id,
    ruleId: row.leaf_id,
    openedAt: row.opened_at.toISOString(),
    initialEvaluationId: row.initial_rule_evaluation_id,
    latestEvaluationId: row.latest_rule_evaluation_id,
    status: row.status,
  };
}

async function loadEvaluationIds(client: PoolClient, tenantId: string, finding: PacketFinding): Promise<string[]> {
  const rows = await client.query<{ id: string }>(
    `SELECT r.id FROM rule_evaluations r
     JOIN rule_evaluations first ON first.tenant_id=r.tenant_id AND first.id=$5
     WHERE r.tenant_id=$1 AND r.subject_key=$2 AND r.pack_id=$3 AND r.leaf_id=$4
       AND (r.recorded_at,r.id)>=(first.recorded_at,first.id)
     ORDER BY r.recorded_at,r.id LIMIT $6`,
    [
      tenantId,
      finding.subjectKey,
      finding.packId,
      finding.ruleId,
      finding.initialEvaluationId,
      LIMITS.maxEvaluations + 1,
    ],
  );
  bounded(rows.rows.length <= LIMITS.maxEvaluations);
  return rows.rows.map((row) => row.id);
}

interface ObservationRow {
  id: string;
  event_id: string;
  receipt_id: string;
  artifact_id: string;
  replaces_observation_id: string | null;
}

async function loadObservations(client: PoolClient, tenantId: string, ids: string[]): Promise<PacketObservation[]> {
  if (!ids.length) return [];
  const rows = await client.query<ObservationRow>(
    `SELECT id,event_id,receipt_id,artifact_id,replaces_observation_id FROM observations
     WHERE tenant_id=$1 AND id=ANY($2::text[]) ORDER BY id`,
    [tenantId, [...new Set(ids)]],
  );
  return rows.rows.map((row) => ({
    observationId: row.id,
    eventId: row.event_id,
    receiptId: row.receipt_id,
    artifactId: row.artifact_id,
    replacesObservationId: row.replaces_observation_id,
  }));
}

interface CorrectedRow {
  id: string;
  read: boolean;
  replaced_by: string | null;
  withdrawal_event_id: string | null;
  subject_resolution_id: string | null;
  secondary_resolution_id: string | null;
}

/**
 * Corrections recorded within the evaluation's input cut for observations its reads could select: about the read's
 * subject (now or before a resolution moved it) and of the read's type.
 */
async function loadCorrections(
  client: PoolClient,
  tenantId: string,
  record: RuleEvaluationRecord,
): Promise<{ corrections: PacketCorrection[]; observationIds: string[] }> {
  const corrections = correctionSql('$2');
  const found: CorrectedRow[] = [];
  for (const input of record.inputs) {
    const about: SubjectReference =
      input.subject ??
      (input.about === 'organization'
        ? { scope: 'ledger', kind: 'organization', id: record.organizationId }
        : record.subject);
    const subjectMatch =
      about.scope === 'ledger'
        ? // The source id has no part in a Ledger subject's match; naming it gives the unused parameter a type.
          `$6::text IS NULL AND ((o.subject_kind=$4 AND (COALESCE(pr.ledger_subject_id,o.subject_ledger_id)=$5 OR o.subject_ledger_id=$5))
           OR (o.secondary_subject_kind=$4 AND (COALESCE(sr.ledger_subject_id,o.secondary_subject_ledger_id)=$5
             OR o.secondary_subject_ledger_id=$5)))`
        : `o.source_id=$6 AND ((o.subject_scope='source' AND o.subject_kind=$4 AND o.subject_id=$5)
           OR (o.secondary_subject_scope='source' AND o.secondary_subject_kind=$4 AND o.secondary_subject_id=$5))`;
    const rows = await client.query<CorrectedRow>(
      `SELECT o.id,o.id=ANY($7::text[]) AS read,${corrections.columns} FROM observations o
       JOIN journal_events e ON e.tenant_id=o.tenant_id AND e.id=o.event_id
       ${corrections.joins}
       WHERE o.tenant_id=$1 AND (($2::jsonb)->>e.stream_id)::bigint>=e.stream_sequence AND o.observation_type=$3
         AND ${subjectMatch}
         AND (rep.id IS NOT NULL OR wd.id IS NOT NULL OR pr.id IS NOT NULL OR sr.id IS NOT NULL)
       ORDER BY o.id LIMIT $8`,
      [
        tenantId,
        JSON.stringify(record.inputCut.streams),
        input.type,
        about.kind,
        about.id,
        about.scope === 'source' ? about.sourceId : null,
        input.observationIds,
        LIMITS.maxEvents,
      ],
    );
    bounded(rows.rows.length < LIMITS.maxEvents);
    found.push(...rows.rows);
  }
  const replacements = await loadObservations(
    client,
    tenantId,
    found.flatMap((row) => (row.replaced_by ? [row.replaced_by] : [])),
  );
  const resolutionIds = found.flatMap((row) =>
    [row.subject_resolution_id, row.secondary_resolution_id].filter((id): id is string => id !== null),
  );
  const resolutions = resolutionIds.length
    ? (
        await client.query<{ id: string; event_id: string }>(
          'SELECT id,event_id FROM observation_subject_resolutions WHERE tenant_id=$1 AND id=ANY($2::text[])',
          [tenantId, resolutionIds],
        )
      ).rows
    : [];
  const byKey = new Map<string, PacketCorrection>();
  const add = (correction: PacketCorrection | undefined) => {
    if (correction) byKey.set(canonicalize(correction), correction);
  };
  for (const row of found) {
    if (row.replaced_by) {
      const replacement = replacements.find((item) => item.observationId === row.replaced_by);
      requireRecord(replacement, `The replacement of observation ${row.id} is not retained`);
      add({ kind: 'replacement', eventId: replacement.eventId, observationId: row.id });
    }
    if (row.withdrawal_event_id) add({ kind: 'withdrawal', eventId: row.withdrawal_event_id, observationId: row.id });
    for (const id of [row.subject_resolution_id, row.secondary_resolution_id]) {
      const resolution = resolutions.find((item) => item.id === id);
      if (id) requireRecord(resolution, `The subject resolution ${id} is not retained`);
      if (resolution) add({ kind: 'subject_resolution', eventId: resolution.event_id, observationId: row.id });
    }
  }
  const sorted = [...byKey.values()].sort((a, b) => canonicalize(a).localeCompare(canonicalize(b)));
  return { corrections: sorted, observationIds: found.filter((row) => !row.read).map((row) => row.id) };
}

async function loadTreatments(client: PoolClient, tenantId: string, findingId: string): Promise<PacketTreatment[]> {
  const rows = await client.query<{ id: string; rule_evaluation_id: string; action: string }>(
    `SELECT id,rule_evaluation_id,action FROM finding_treatments
     WHERE tenant_id=$1 AND finding_id=$2 AND rule_evaluation_id IS NOT NULL ORDER BY recorded_at,id LIMIT $3`,
    [tenantId, findingId, LIMITS.maxEvents],
  );
  bounded(rows.rows.length < LIMITS.maxEvents);
  return rows.rows.map((row) => ({ id: row.id, evaluationId: row.rule_evaluation_id, action: row.action }));
}

async function loadHazards(client: PoolClient, tenantId: string, findingId: string): Promise<PacketHazard[]> {
  const origins = await client.query<{ id: string; record_id: string; origin: HazardOrigin }>(
    `SELECT id,record_id,origin FROM sms_hazard_origins WHERE tenant_id=$1 AND finding_id=$2
     ORDER BY recorded_at,id LIMIT $3`,
    [tenantId, findingId, LIMITS.maxHazards + 1],
  );
  bounded(origins.rows.length <= LIMITS.maxHazards);
  const hazards: PacketHazard[] = [];
  for (const row of origins.rows) {
    const decisions = await client.query<{ id: string; kind: string }>(
      `SELECT id,kind FROM decisions WHERE tenant_id=$1 AND subject_id=$2 AND kind IN ('risk.assess','risk.accept')
       ORDER BY recorded_at,id LIMIT $3`,
      [tenantId, row.record_id, LIMITS.maxEvents],
    );
    bounded(decisions.rows.length < LIMITS.maxEvents);
    hazards.push({
      recordId: row.record_id,
      openingEventId: row.id,
      origin: row.origin,
      assessmentIds: decisions.rows.filter((item) => item.kind === 'risk.assess').map((item) => item.id),
      acceptanceIds: decisions.rows.filter((item) => item.kind === 'risk.accept').map((item) => item.id),
    });
  }
  return hazards;
}

async function loadReceipts(client: PoolClient, tenantId: string, ids: string[]): Promise<EvidenceReceipt[]> {
  const wanted = [...new Set(ids)];
  bounded(wanted.length <= LIMITS.maxReceipts);
  if (!wanted.length) return [];
  const rows = await client.query<{
    tenant_id: string;
    id: string;
    event_id: string;
    source_id: string;
    kind: string;
    occurred_at: Date;
    received_at: Date;
    source_revision: string | null;
    artifact_id: string | null;
    payload: Record<string, unknown>;
    input_subject: Record<string, unknown>;
  }>(
    `SELECT tenant_id,id,event_id,source_id,kind,occurred_at,received_at,source_revision::text AS source_revision,
       artifact_id,payload,input_subject FROM receipts WHERE tenant_id=$1 AND id=ANY($2::text[]) ORDER BY id`,
    [tenantId, wanted],
  );
  requireRecord(rows.rows.length === wanted.length, 'A receipt of a read observation is missing');
  return rows.rows.map((row) => ({
    tenantId: row.tenant_id,
    id: row.id,
    eventId: row.event_id,
    sourceId: row.source_id,
    kind: row.kind,
    occurredAt: row.occurred_at.toISOString(),
    receivedAt: row.received_at.toISOString(),
    sourceRevision: row.source_revision,
    artifactId: row.artifact_id,
    payload: row.payload,
    inputSubject: row.input_subject,
  }));
}

async function loadArtifacts(client: PoolClient, tenantId: string, ids: string[]): Promise<FindingPacketArtifact[]> {
  const wanted = [...new Set(ids)];
  bounded(wanted.length <= LIMITS.maxArtifacts);
  if (!wanted.length) return [];
  const rows = await client.query<{
    tenant_id: string;
    id: string;
    sha256: string;
    byte_length: number;
    content_type: string;
  }>(
    'SELECT tenant_id,id,sha256,byte_length,content_type FROM artifacts WHERE tenant_id=$1 AND id=ANY($2::text[]) ORDER BY id',
    [tenantId, wanted],
  );
  requireRecord(rows.rows.length === wanted.length, 'The source of a read observation is missing');
  return rows.rows.map((row) => ({
    tenantId: row.tenant_id,
    id: row.id,
    sha256: row.sha256,
    byteLength: Number(row.byte_length),
    contentType: row.content_type,
  }));
}

/** Loads every record the finding's packet holds, by which records exist for it. */
export async function loadFindingPacketSources(
  client: PoolClient,
  tenantId: string,
  findingId: string,
): Promise<FindingPacketSources> {
  const finding = await loadFinding(client, tenantId, findingId);
  const evaluationIds = await loadEvaluationIds(client, tenantId, finding);
  const evaluationEvents = await loadEvents(client, tenantId, evaluationIds);
  const records = evaluationIds.map((id) =>
    evaluationRecordOf(evaluationEvents.find((event) => event.envelope.eventId === id)!.envelope),
  );
  const adoptionEvents = await loadEvents(
    client,
    tenantId,
    records.map((record) => record.adoption.id),
  );
  for (const event of adoptionEvents) adoptionRecordOf(event.envelope);
  const readIds = [...new Set(records.flatMap((record) => record.inputs.flatMap((input) => input.observationIds)))];
  const corrections: Record<string, PacketCorrection[]> = {};
  const correctedIds: string[] = [];
  for (const record of records) {
    const loaded = await loadCorrections(client, tenantId, record);
    corrections[record.id] = loaded.corrections;
    correctedIds.push(...loaded.observationIds);
  }
  const read = await loadObservations(client, tenantId, readIds);
  requireRecord(read.length === readIds.length, 'An observation an evaluation read is missing');
  const corrected = await loadObservations(
    client,
    tenantId,
    correctedIds.filter((id) => !readIds.includes(id)),
  );
  const treatments = await loadTreatments(client, tenantId, finding.id);
  const hazards = await loadHazards(client, tenantId, finding.id);
  const otherEventIds = [
    ...read.map((row) => row.eventId),
    ...corrected.map((row) => row.eventId),
    ...Object.values(corrections).flatMap((items) => items.map((item) => item.eventId)),
    ...treatments.map((item) => item.id),
    ...hazards.flatMap((hazard) => [hazard.openingEventId, ...hazard.assessmentIds, ...hazard.acceptanceIds]),
  ];
  const known = new Set([...evaluationIds, ...adoptionEvents.map((event) => event.envelope.eventId)]);
  const otherEvents = await loadEvents(
    client,
    tenantId,
    otherEventIds.filter((id) => !known.has(id)),
  );
  return {
    tenantId,
    finding,
    evaluationIds,
    events: [...evaluationEvents, ...adoptionEvents, ...otherEvents],
    observations: [...read, ...corrected],
    corrections,
    receipts: await loadReceipts(
      client,
      tenantId,
      read.map((row) => row.receiptId),
    ),
    artifacts: await loadArtifacts(
      client,
      tenantId,
      read.map((row) => row.artifactId),
    ),
    treatments,
    hazards,
  };
}
