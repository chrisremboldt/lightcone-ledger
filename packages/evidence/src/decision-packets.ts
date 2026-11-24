import { randomUUID } from 'node:crypto';
import type {
  CommandLinkInput,
  C2EvaluationExecution,
  DecisionPacket,
  DecisionPacketCreate,
  DecisionPacketRecord,
  DecisionPacketV2,
  EvaluationRecord,
  EvidenceArtifact,
  EvidenceEntry,
  EvidenceEnvelope,
  EvidenceReceipt,
  FlightRuleSelectionRecordV2,
  InputCut,
  PackAdoptionAcceptance,
  SubjectBasisManifest,
} from '@ledger/contracts';
import {
  DECISION_PACKET_LIMITATIONS,
  DECISION_PACKET_LIMITS,
  DECISION_PACKET_V2_LIMITATIONS,
  DECISION_PACKET_V2_LIMITS,
} from '@ledger/contracts';
import { getRulePackVersion, validateAcceptedCommandLinkAuthority, verifyCommandLinkInputSource } from '@ledger/domain';
import {
  c2ExecutionRegistration,
  commandLinkEvidenceLeafV1,
  commandLinkStatusBindingV1,
} from '@ledger/domain/retained-c2-execution';
import {
  canonicalDigest,
  canonicalize,
  entryHash,
  INTEGRITY_VERSION,
  parseStrictJson,
  sha256,
} from '@ledger/integrity';
import {
  DomainError,
  readBoundedObject,
  writeBoundedObject,
  type AuthContext,
  type JournalEvent,
  type ObjectStore,
  type PoolClient,
} from '@ledger/persistence';

const FORMAT = 'ledger.decision-packet.1';
const FORMAT_V2 = 'ledger.decision-packet.2';
const SCOPE = 'selected_c2_finding_treatment_records';
const LIMITS = DECISION_PACKET_LIMITS;
type C2Basis = EvaluationRecord & { explanation: Extract<EvaluationRecord['explanation'], { kind: 'command_link' }> };
type C2ExecutionBasis = C2Basis & { profile: 'ledger.c2-evaluation.2'; execution: C2EvaluationExecution };
interface PacketEvent {
  entry: EvidenceEntry;
  envelope: EvidenceEnvelope;
}
interface JournalRow {
  id: string;
  tenant_id: string;
  stream_id: string;
  sequence: string;
  event_type: string;
  schema_version: number;
  principal_id: string;
  source_id: string | null;
  source_session_id: string | null;
  occurred_at: Date | null;
  effective_at: Date | null;
  received_at: Date;
  causation_id: string | null;
  artifact_id: string | null;
  payload: Record<string, unknown>;
  immutable_envelope: string;
  envelope_digest: string;
  previous_hash: string;
  entry_hash: string;
  encoding_version: string;
}
interface ReceiptRow {
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
}
interface ArtifactRow {
  tenant_id: string;
  id: string;
  sha256: string;
  byte_length: number;
  content_type: string;
  object_key: string;
}
function requireReference(condition: unknown, message: string): asserts condition {
  if (!condition) throw new DomainError(409, 'decision_packet_reference_invalid', message);
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function equal(left: unknown, right: unknown): boolean {
  return canonicalDigest(left) === canonicalDigest(right);
}
function instant(left: unknown, right: unknown): boolean {
  return (
    typeof left === 'string' &&
    typeof right === 'string' &&
    Number.isFinite(Date.parse(left)) &&
    Date.parse(left) === Date.parse(right)
  );
}
function bounded(condition: boolean): void {
  if (!condition)
    throw new DomainError(
      429,
      'decision_packet_budget_exceeded',
      'Selected decision records exceed the packet byte or reference budget',
    );
}
class PacketBudget {
  private estimatedBytes = 65536 + (LIMITS.maxEvents + LIMITS.maxReceipts + LIMITS.maxArtifacts) * 1600;
  private eventIds = new Set<string>();
  constructor(private readonly maxReferenceDepth: number = LIMITS.maxReferenceDepth) {}
  addEvents(ids: string[], depth: number): void {
    bounded(depth <= this.maxReferenceDepth);
    for (const id of ids) {
      requireReference(
        typeof id === 'string' && id.length > 0 && id.length <= 200 && !this.eventIds.has(id),
        'Selected event references must be unique bounded identities',
      );
      this.eventIds.add(id);
    }
    bounded(this.eventIds.size <= LIMITS.maxEvents);
  }
  addBytes(bytes: number): void {
    bounded(Number.isSafeInteger(bytes) && bytes >= 0);
    this.estimatedBytes += bytes;
    bounded(this.estimatedBytes <= LIMITS.maxPacketBytes);
  }
}
async function loadEvents(
  client: PoolClient,
  tenantId: string,
  ids: string[],
  depth: number,
  budget: PacketBudget,
): Promise<PacketEvent[]> {
  budget.addEvents(ids, depth);
  if (!ids.length) return [];
  const sizes = await client.query<{ id: string; bytes: number | null; payload_bytes: number }>(
    'SELECT id,octet_length(immutable_envelope) AS bytes,octet_length(payload::text) AS payload_bytes FROM journal_events WHERE tenant_id=$1 AND id=ANY($2::text[]) LIMIT $3',
    [tenantId, ids, ids.length + 1],
  );
  requireReference(sizes.rows.length === ids.length, 'A selected immutable event is missing within this tenant');
  for (const row of sizes.rows) {
    requireReference(row.bytes !== null, 'Exact selected event bytes were not retained');
    bounded(row.bytes <= LIMITS.maxEnvelopeBytes && row.payload_bytes <= LIMITS.maxEnvelopeBytes);
    budget.addBytes((row.bytes + row.payload_bytes) * 3 + 512);
  }
  const rows = await client.query<JournalRow>(
    'SELECT *,stream_sequence::text AS sequence FROM journal_events WHERE tenant_id=$1 AND id=ANY($2::text[]) ORDER BY id LIMIT $3',
    [tenantId, ids, ids.length + 1],
  );
  return rows.rows.map((row) => {
    const envelope = parseStrictJson(row.immutable_envelope, { maxBytes: LIMITS.maxEnvelopeBytes }) as EvidenceEnvelope;
    requireReference(
      object(envelope) && envelope.tenantId === tenantId && envelope.eventId === row.id,
      'Selected event identity differs from its retained envelope',
    );
    const expected = {
      eventId: row.id,
      tenantId: row.tenant_id,
      streamId: row.stream_id,
      sequence: row.sequence,
      type: row.event_type,
      schemaVersion: row.schema_version,
      principalId: row.principal_id,
      sourceId: row.source_id,
      sourceSessionId: row.source_session_id,
      receivedAt: row.received_at.toISOString(),
      causationId: row.causation_id,
      artifactId: row.artifact_id,
      payload: row.payload,
      occurredAt: envelope.occurredAt,
      effectiveAt: envelope.effectiveAt,
    };
    requireReference(
      equal(envelope, expected) &&
        (row.occurred_at === null
          ? envelope.occurredAt === null
          : instant(envelope.occurredAt, row.occurred_at.toISOString())) &&
        (row.effective_at === null
          ? envelope.effectiveAt === null
          : instant(envelope.effectiveAt, row.effective_at.toISOString())),
      'Selected event differs from its immutable row',
    );
    requireReference(
      canonicalize(envelope) === row.immutable_envelope &&
        canonicalDigest(envelope) === row.envelope_digest &&
        row.encoding_version === INTEGRITY_VERSION &&
        entryHash(tenantId, row.stream_id, BigInt(row.sequence), row.previous_hash, row.envelope_digest) ===
          row.entry_hash,
      'Selected event integrity fields differ',
    );
    return {
      envelope,
      entry: {
        canonicalEnvelope: row.immutable_envelope,
        envelopeDigest: row.envelope_digest,
        previousHash: row.previous_hash,
        entryHash: row.entry_hash,
        encodingVersion: row.encoding_version,
      },
    };
  });
}
function selectedBasis(event: EvidenceEnvelope, flightId: string): C2Basis {
  const payload = event.payload;
  const treatment = payload.findingTreatment;
  const decision = payload.decision;
  const basis = payload.acceptedFindingBasis;
  if (
    event.type !== 'decision.record' ||
    payload.flightId !== flightId ||
    !object(treatment) ||
    !object(decision) ||
    !['acknowledge', 'respond', 'resolve'].includes(String(treatment.action)) ||
    decision.kind !== `finding.${treatment.action}` ||
    !object(basis) ||
    basis.leafId !== commandLinkEvidenceLeafV1.id ||
    basis.leafVersion !== 1 ||
    basis.bindingId !== commandLinkStatusBindingV1.id ||
    basis.bindingVersion !== 1 ||
    !object(basis.explanation) ||
    basis.explanation.kind !== 'command_link'
  )
    throw new DomainError(
      409,
      'unsupported_decision_packet',
      'Only retained C2 finding-treatment decisions support this packet format',
    );
  requireReference(
    basis.flightId === flightId &&
      treatment.evaluationId === basis.id &&
      typeof treatment.findingId === 'string' &&
      typeof basis.id === 'string' &&
      Array.isArray(basis.explanation.evidence),
    'The decision does not pin one exact C2 evaluation',
  );
  if (basis.profile !== undefined && basis.profile !== 'ledger.c2-evaluation.2')
    throw new DomainError(409, 'unsupported_decision_packet', 'The retained C2 evaluation profile is unsupported');
  requireReference(
    basis.profile === 'ledger.c2-evaluation.2'
      ? object(basis.execution) &&
          object(basis.clock) &&
          object(basis.inputCut) &&
          object(basis.inputCut.streams) &&
          object(basis.acceptedInputCut) &&
          object(basis.acceptedInputCut.streams)
      : basis.execution === undefined,
    'The retained C2 evaluation execution profile is incomplete',
  );
  bounded(basis.explanation.evidence.length <= LIMITS.maxEvents - (basis.profile ? 4 : 2));
  return basis as unknown as C2Basis;
}
function verifyEvaluation(basis: C2Basis, evaluation: EvidenceEnvelope, findingId: string): void {
  const payload = evaluation.payload;
  requireReference(
    evaluation.type === 'evaluation.recorded' &&
      evaluation.eventId === basis.id &&
      payload.flightId === basis.flightId &&
      payload.findingId === findingId &&
      object(payload.leaf) &&
      object(payload.binding) &&
      equal(payload.leaf, commandLinkEvidenceLeafV1) &&
      equal(payload.binding, commandLinkStatusBindingV1),
    'The selected evaluation definitions or subject differ',
  );
  const expected = {
    ...(payload.evaluation as object),
    id: evaluation.eventId,
    recordedAt: evaluation.receivedAt,
    rule: {
      reference: commandLinkEvidenceLeafV1.source.reference,
      text: commandLinkEvidenceLeafV1.source.text,
      review: commandLinkEvidenceLeafV1.review,
      adopted: commandLinkEvidenceLeafV1.adopted,
    },
  };
  requireReference(equal(basis, expected), 'The selected evaluation differs from the accepted finding basis');
  if (basis.profile === 'ledger.c2-evaluation.2') {
    const execution = basis.execution;
    requireReference(
      execution &&
        execution.version === 'flight.c2-execution.1' &&
        ['adopted', 'builtin_draft'].includes(execution.mode) &&
        execution.policyVersion === c2ExecutionRegistration.policyVersion &&
        equal(execution.evaluator, c2ExecutionRegistration.evaluator) &&
        object(execution.selection) &&
        execution.selection.version === 'flight.rule-selection.2' &&
        typeof execution.selection.id === 'string' &&
        typeof execution.selection.digest === 'string' &&
        (execution.adoption === null || object(execution.adoption)) &&
        object(execution.trigger) &&
        evaluation.causationId === execution.trigger.eventId &&
        (execution.trigger.kind === 'selection_change'
          ? execution.trigger.eventId === execution.selection.id
          : ['source_report', 'retained_bootstrap'].includes(execution.trigger.kind) &&
            basis.explanation.evidence.some((report) => report.eventId === execution.trigger.eventId)),
      'The retained C2 execution or trigger differs from its selected evaluation',
    );
  } else {
    requireReference(
      basis.explanation.evidence.some((report) => report.eventId === evaluation.causationId),
      'The evaluation trigger must be a selected command-link report',
    );
  }
}
function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
function included(event: EvidenceEnvelope, cut: InputCut): boolean {
  return BigInt(event.sequence) <= BigInt(cut.streams[event.streamId] ?? 0);
}
function verifySelectionBasis(selection: FlightRuleSelectionRecordV2, event: EvidenceEnvelope): void {
  const manifest = selection.basisManifest;
  requireReference(
    object(manifest) &&
      manifest.version === 'subject-evidence.1' &&
      manifest.subjectId === selection.flightId &&
      manifest.principalId === event.principalId &&
      nonnegativeInteger(manifest.principalRevision) &&
      Array.isArray(manifest.subjects) &&
      manifest.subjects.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 200) &&
      new Set(manifest.subjects).size === manifest.subjects.length &&
      manifest.subjects.includes(selection.flightId) &&
      manifest.subjects.includes(selection.organizationId) &&
      Array.isArray(manifest.edges) &&
      Array.isArray(manifest.frontiers) &&
      (manifest.authority === null || object(manifest.authority)) &&
      canonicalDigest(manifest) === selection.dependencyBasis,
    'The selected rule-selection basis manifest is unavailable or inconsistent',
  );
  const rendered: Record<string, number> = {};
  const accepted: Record<string, number> = {};
  const frontierKeys = new Set<string>();
  const frontiers: (SubjectBasisManifest['frontiers'][number] | NonNullable<SubjectBasisManifest['authority']>)[] = [
    ...manifest.frontiers,
    ...(manifest.authority === null ? [] : [manifest.authority]),
  ];
  for (const frontier of frontiers) {
    const authority = frontier === manifest.authority;
    requireReference(
      object(frontier) &&
        typeof frontier.streamId === 'string' &&
        frontier.streamId.length > 0 &&
        frontier.streamId.length <= 200 &&
        nonnegativeInteger(frontier.sequence) &&
        nonnegativeInteger(frontier.projectedSequence) &&
        frontier.projectedSequence <= frontier.sequence &&
        (authority || ('subjectId' in frontier && manifest.subjects.includes(frontier.subjectId))),
      'The selected rule-selection basis contains an invalid frontier',
    );
    const key = canonicalize([
      authority ? null : 'subjectId' in frontier ? frontier.subjectId : null,
      frontier.streamId,
    ]);
    requireReference(!frontierKeys.has(key), 'The selected rule-selection basis repeats a frontier');
    frontierKeys.add(key);
    rendered[frontier.streamId] = Math.max(rendered[frontier.streamId] ?? 0, frontier.projectedSequence);
    accepted[frontier.streamId] = Math.max(accepted[frontier.streamId] ?? 0, frontier.sequence);
  }
  const edges = new Set<string>();
  for (const edge of manifest.edges) {
    requireReference(
      object(edge) &&
        manifest.subjects.includes(edge.subjectId) &&
        manifest.subjects.includes(edge.dependencySubjectId) &&
        typeof edge.eventId === 'string' &&
        edge.eventId.length > 0 &&
        edge.eventId.length <= 200,
      'The selected rule-selection basis contains an invalid dependency declaration',
    );
    const key = canonicalize([edge.subjectId, edge.dependencySubjectId]);
    requireReference(!edges.has(key), 'The selected rule-selection basis repeats a dependency');
    edges.add(key);
  }
  requireReference(
    object(selection.renderedInputCut) &&
      object(selection.acceptedInputCut) &&
      equal(selection.renderedInputCut.streams, rendered) &&
      equal(selection.acceptedInputCut.streams, accepted) &&
      selection.renderedInputCut.principalRevision === manifest.principalRevision &&
      selection.acceptedInputCut.principalRevision === manifest.principalRevision &&
      selection.renderedInputCut.basisRevision === selection.acceptedInputCut.basisRevision &&
      BigInt(selection.acceptedInputCut.streams[event.streamId] ?? 0) < BigInt(event.sequence),
    'The selected rule-selection cuts differ from its retained preappend basis',
  );
}
function verifySelection(
  basis: C2ExecutionBasis,
  evaluation: EvidenceEnvelope,
  event: EvidenceEnvelope,
): FlightRuleSelectionRecordV2 {
  const value = event.payload.selection;
  requireReference(
    event.type === 'flight.rule-selection.recorded' &&
      event.eventId === basis.execution.selection.id &&
      event.payload.flightId === basis.flightId &&
      object(value) &&
      value.id === event.eventId &&
      value.version === 'flight.rule-selection.2' &&
      value.flightId === basis.flightId &&
      value.organizationId === `organization:${event.tenantId}` &&
      object(value.selection) &&
      (value.selection.adoption === null || object(value.selection.adoption)) &&
      object(value.execution) &&
      object(value.clock) &&
      (value.nextBoundary === null || object(value.nextBoundary)),
    'The selected rule-selection identity or scope differs from the retained execution',
  );
  const selection = value as unknown as FlightRuleSelectionRecordV2;
  const { version, flightId, organizationId, adoptionRevision, projectedAdoptionRevision, execution, nextBoundary } =
    selection;
  const state = {
    version,
    flightId,
    organizationId,
    adoptionRevision,
    projectedAdoptionRevision,
    selection: selection.selection,
    execution,
    nextBoundary,
  };
  const evaluatedAt = Date.parse(basis.clock.evaluatedAt);
  const selectedAt = Date.parse(selection.clock.evaluatedAt);
  requireReference(
    nonnegativeInteger(adoptionRevision) &&
      nonnegativeInteger(projectedAdoptionRevision) &&
      projectedAdoptionRevision <= adoptionRevision &&
      selection.selectionDigest === canonicalDigest(state) &&
      basis.execution.selection.digest === selection.selectionDigest &&
      equal(execution, {
        status: selection.selection.state === 'eligible' ? 'active' : 'inactive',
        baseline: 'builtin_draft',
        policyVersion: c2ExecutionRegistration.policyVersion,
        evaluator: c2ExecutionRegistration.evaluator,
      }) &&
      basis.execution.mode === (selection.selection.state === 'eligible' ? 'adopted' : 'builtin_draft') &&
      equal(basis.execution.adoption, selection.selection.adoption) &&
      ['not_adopted', 'pending', 'scheduled', 'eligible', 'expired'].includes(selection.selection.state) &&
      (selection.selection.state === 'not_adopted') === (selection.selection.adoption === null) &&
      selection.clock.mode === 'wall' &&
      Number.isFinite(selectedAt) &&
      Number.isFinite(evaluatedAt) &&
      selectedAt <= evaluatedAt &&
      (nextBoundary === null ||
        (Number.isFinite(Date.parse(nextBoundary.at)) && evaluatedAt < Date.parse(nextBoundary.at))) &&
      included(event, basis.inputCut) &&
      BigInt(basis.acceptedInputCut.streams[evaluation.streamId] ?? 0) < BigInt(evaluation.sequence),
    'The selected rule-selection commitment, execution or effective clock is inconsistent',
  );
  verifySelectionBasis(selection, event);
  return selection;
}
function verifyAdoption(
  basis: C2ExecutionBasis,
  selection: FlightRuleSelectionRecordV2,
  event: EvidenceEnvelope,
): void {
  const reference = basis.execution.adoption;
  const acceptance = event.payload.acceptance;
  requireReference(
    reference &&
      object(reference.pack) &&
      object(reference.leaf) &&
      object(reference.binding) &&
      object(reference.effectiveInterval) &&
      event.type === 'rule-pack.adopt' &&
      event.eventId === reference.id &&
      object(acceptance) &&
      object(acceptance.actor) &&
      object(acceptance.pack) &&
      Array.isArray(acceptance.pack.leaves) &&
      Array.isArray(acceptance.pack.bindings) &&
      object(acceptance.scope) &&
      object(acceptance.effectiveInterval),
    'The selected adoption acceptance is missing or differs from its execution reference',
  );
  const record = {
    ...acceptance,
    id: event.eventId,
    acceptedAt: event.receivedAt,
  } as unknown as PackAdoptionAcceptance;
  const pack = getRulePackVersion(reference.pack.id, reference.pack.version);
  const leaf = record.pack.leaves.find(
    (item) => item.id === reference.leaf.id && item.version === reference.leaf.version,
  );
  const binding = record.pack.bindings.find(
    (item) => item.id === reference.binding.id && item.version === reference.binding.version,
  );
  const start = Date.parse(record.effectiveInterval.start);
  const end = Date.parse(record.effectiveInterval.end);
  const selectedAt = Date.parse(selection.clock.evaluatedAt);
  requireReference(
    pack &&
      equal(record.pack, pack) &&
      equal(reference.pack, c2ExecutionRegistration.pack) &&
      equal(reference.leaf, c2ExecutionRegistration.leaf) &&
      equal(reference.binding, c2ExecutionRegistration.binding) &&
      record.pack.digest === reference.pack.digest &&
      leaf?.digest === reference.leaf.digest &&
      binding?.digest === reference.binding.digest &&
      record.organizationId === selection.organizationId &&
      equal(record.scope, { kind: 'organization', organizationId: selection.organizationId }) &&
      nonnegativeInteger(record.acceptedRevision) &&
      record.acceptedRevision === reference.acceptedRevision &&
      record.acceptedRevision <= selection.adoptionRevision &&
      equal(record.effectiveInterval, reference.effectiveInterval) &&
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      start < end &&
      (selection.selection.state === 'pending' ||
        (selection.selection.state === 'scheduled'
          ? selectedAt < start
          : selection.selection.state === 'eligible'
            ? start <= selectedAt && selectedAt < end
            : selection.selection.state === 'expired' && end <= selectedAt)) &&
      record.actor.id === event.principalId &&
      record.actor.policyVersion === 'ledger.pack-adoption-authority.1' &&
      nonnegativeInteger(record.actor.principalRevision) &&
      Array.isArray(record.actor.capabilities) &&
      record.actor.capabilities.every((capability) => typeof capability === 'string') &&
      record.actor.capabilities.includes('pack:adopt') &&
      equal(record.actor.checkedCapabilities, ['pack:adopt']) &&
      included(event, selection.acceptedInputCut),
    'The selected adoption definition, scope, retained authority or effective interval is inconsistent',
  );
  const knownBoundary = selectedAt < start ? start : selectedAt < end ? end : null;
  const nextBoundary = selection.nextBoundary;
  if (knownBoundary !== null)
    requireReference(
      nextBoundary !== null &&
        Date.parse(nextBoundary.at) <= knownBoundary &&
        Date.parse(basis.clock.evaluatedAt) < knownBoundary,
      'The selected rule selection omits or skips the next boundary of its included adoption',
    );
  if (nextBoundary?.adoptionId === reference.id)
    requireReference(
      ['start', 'end'].includes(nextBoundary.kind) &&
        Date.parse(nextBoundary.at) === Date.parse(record.effectiveInterval[nextBoundary.kind]),
      'The selected rule-selection boundary differs from its included adoption interval',
    );
}
function receipt(row: ReceiptRow): EvidenceReceipt {
  return {
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
  };
}
async function loadReceipts(
  client: PoolClient,
  tenantId: string,
  ids: string[],
  budget: PacketBudget,
): Promise<EvidenceReceipt[]> {
  bounded(ids.length <= LIMITS.maxReceipts);
  requireReference(new Set(ids).size === ids.length, 'Selected receipt references must be unique');
  const sizes = await client.query<{ id: string; bytes: number }>(
    'SELECT id,octet_length(payload::text)+octet_length(input_subject::text)+2000 AS bytes FROM receipts WHERE tenant_id=$1 AND id=ANY($2::text[]) LIMIT $3',
    [tenantId, ids, ids.length + 1],
  );
  requireReference(sizes.rows.length === ids.length, 'A selected report receipt is missing');
  for (const row of sizes.rows) {
    bounded(row.bytes <= LIMITS.maxEnvelopeBytes);
    budget.addBytes(row.bytes * 6);
  }
  const rows = await client.query<ReceiptRow>(
    'SELECT *,source_revision::text AS source_revision FROM receipts WHERE tenant_id=$1 AND id=ANY($2::text[]) ORDER BY id LIMIT $3',
    [tenantId, ids, ids.length + 1],
  );
  return rows.rows.map(receipt);
}
/**
 * Assembles a packet in the older decision-packet format. No route issues this format any more (findings are packaged
 * as finding packets); it is kept so tests can produce packets exactly as they were issued and show that they stay
 * readable and verifiable.
 */
export async function createDecisionPacket(
  client: PoolClient,
  principal: AuthContext,
  input: DecisionPacketCreate,
  store: ObjectStore,
): Promise<DecisionPacketRecord> {
  await client.query("SET LOCAL statement_timeout='15s'");
  const selected = await client.query('SELECT id FROM decisions WHERE tenant_id=$1 AND flight_id=$2 AND id=$3', [
    principal.tenantId,
    input.flightId,
    input.decisionId,
  ]);
  if (!selected.rowCount)
    throw new DomainError(404, 'decision_packet_not_found', 'Decision is unavailable within this flight and tenant');
  const budget = new PacketBudget(DECISION_PACKET_V2_LIMITS.maxReferenceDepth);
  const decisionEvent = (await loadEvents(client, principal.tenantId, [input.decisionId], 0, budget))[0];
  const basis = selectedBasis(decisionEvent.envelope, input.flightId);
  const evaluationEvent = (await loadEvents(client, principal.tenantId, [basis.id], 1, budget))[0];
  const findingId = String((decisionEvent.envelope.payload.findingTreatment as Record<string, unknown>).findingId);
  verifyEvaluation(basis, evaluationEvent.envelope, findingId);
  let executionBasis: C2ExecutionBasis | undefined;
  let selectionEvent: PacketEvent | undefined;
  let adoptionEvent: PacketEvent | undefined;
  if (basis.profile === 'ledger.c2-evaluation.2') {
    executionBasis = basis as C2ExecutionBasis;
    selectionEvent = (
      await loadEvents(client, principal.tenantId, [executionBasis.execution.selection.id], 2, budget)
    )[0];
    const selection = verifySelection(executionBasis, evaluationEvent.envelope, selectionEvent.envelope);
    if (executionBasis.execution.adoption !== null) {
      adoptionEvent = (
        await loadEvents(client, principal.tenantId, [executionBasis.execution.adoption.id], 3, budget)
      )[0];
      verifyAdoption(executionBasis, selection, adoptionEvent.envelope);
    }
  }
  const reports = await loadEvents(
    client,
    principal.tenantId,
    basis.explanation.evidence.map((report) => report.eventId),
    2,
    budget,
  );
  const receipts = await loadReceipts(
    client,
    principal.tenantId,
    basis.explanation.evidence.map((report) => report.receiptId),
    budget,
  );
  const receiptsById = new Map(receipts.map((item) => [item.id, item]));
  for (const report of basis.explanation.evidence) {
    const event = reports.find((item) => item.envelope.eventId === report.eventId)?.envelope;
    const receipt = receiptsById.get(report.receiptId);
    requireReference(
      event &&
        receipt &&
        event.type === 'command-link.status' &&
        receipt.eventId === event.eventId &&
        receipt.kind === event.type &&
        receipt.sourceId === event.sourceId &&
        receipt.artifactId === event.artifactId &&
        instant(receipt.occurredAt, event.occurredAt) &&
        instant(receipt.receivedAt, event.receivedAt) &&
        receipt.sourceRevision === null &&
        equal(receipt.payload, event.payload.payload) &&
        equal(receipt.inputSubject, { flightId: input.flightId }),
      'A report receipt differs from its selected source event',
    );
    const payload = event.payload as unknown as CommandLinkInput;
    requireReference(
      payload.subject.flightId === input.flightId &&
        report.flightId === input.flightId &&
        report.sourceId === event.sourceId &&
        report.sourceSessionId === event.sourceSessionId &&
        report.sourceEventId === payload.payload.sourceEventId &&
        report.incidentId === payload.payload.incidentId &&
        report.aircraftId === payload.payload.aircraftId &&
        report.status === payload.payload.status &&
        instant(report.occurredAt, event.occurredAt),
      'Selected C2 evidence differs from its reported identity or scope',
    );
    validateAcceptedCommandLinkAuthority({
      ...event,
      id: event.eventId,
      tenant_id: event.tenantId,
      stream_id: event.streamId,
      stream_sequence: event.sequence,
      event_type: event.type,
      principal_id: event.principalId,
      source_id: event.sourceId,
      source_session_id: event.sourceSessionId,
      occurred_at: event.occurredAt ? new Date(event.occurredAt) : null,
      received_at: new Date(event.receivedAt),
      artifact_id: event.artifactId,
      causation_id: event.causationId,
    } as JournalEvent);
  }
  const artifactIds = [...new Set(receipts.map((item) => item.artifactId!))];
  bounded(artifactIds.length <= LIMITS.maxArtifacts);
  const artifactRows = await client.query<ArtifactRow>(
    'SELECT tenant_id,id,sha256,byte_length,content_type,object_key FROM artifacts WHERE tenant_id=$1 AND id=ANY($2::text[]) ORDER BY id LIMIT $3',
    [principal.tenantId, artifactIds, artifactIds.length + 1],
  );
  requireReference(artifactRows.rows.length === artifactIds.length, 'A selected original artifact is missing');
  const originalBytes = artifactRows.rows.reduce((sum, row) => sum + row.byte_length, 0);
  bounded(
    Number.isSafeInteger(originalBytes) &&
      originalBytes <= LIMITS.maxOriginalBytes &&
      artifactRows.rows.every((row) => row.byte_length >= 0 && row.byte_length <= 65536),
  );
  budget.addBytes(Math.ceil(originalBytes / 3) * 4 + artifactRows.rows.length * 1024);
  const until = Date.now() + 30000;
  const timeout = () => {
    const remaining = until - Date.now();
    if (remaining <= 0)
      throw new DomainError(
        409,
        'decision_packet_bytes_unavailable',
        'Packet original-byte I/O exceeded its time bound',
      );
    return Math.min(10000, remaining);
  };
  const artifacts: EvidenceArtifact[] = [];
  for (const row of artifactRows.rows) {
    let bytes: Uint8Array;
    try {
      bytes = await readBoundedObject(store, row.object_key, { maxBytes: row.byte_length, timeoutMs: timeout() });
    } catch {
      throw new DomainError(
        409,
        'decision_packet_bytes_unavailable',
        'A selected original is unavailable within its byte/time bounds',
      );
    }
    requireReference(
      bytes.byteLength === row.byte_length && sha256(bytes) === row.sha256 && row.content_type === 'application/json',
      'A selected original differs from its immutable artifact metadata',
    );
    for (const report of reports.filter((item) => item.envelope.artifactId === row.id))
      verifyCommandLinkInputSource(report.envelope.payload as unknown as CommandLinkInput, bytes);
    artifacts.push({
      tenantId: row.tenant_id,
      id: row.id,
      sha256: row.sha256,
      byteLength: row.byte_length,
      contentType: row.content_type,
      bytesBase64: Buffer.from(bytes).toString('base64'),
    });
  }
  const id = randomUUID();
  const issuedAt = new Date().toISOString();
  const reportEvents = [decisionEvent, evaluationEvent, ...reports].sort((left, right) =>
    left.envelope.eventId.localeCompare(right.envelope.eventId),
  );
  const executionEvents = [...(selectionEvent ? [selectionEvent] : []), ...(adoptionEvent ? [adoptionEvent] : [])];
  const events = [...reportEvents, ...executionEvents].sort((left, right) =>
    left.envelope.eventId.localeCompare(right.envelope.eventId),
  );
  const inventory: DecisionPacket['manifest']['inventory'] = [
    ...reportEvents.map((item) => ({
      kind: 'event' as const,
      id: item.envelope.eventId,
      digest: canonicalDigest(item.entry),
      reason:
        item === decisionEvent
          ? ('selected_decision' as const)
          : item === evaluationEvent
            ? ('selected_evaluation' as const)
            : ('evaluation_report' as const),
    })),
    ...receipts.map((item) => ({
      kind: 'receipt' as const,
      id: item.id,
      digest: canonicalDigest(item),
      reason: 'report_receipt' as const,
    })),
    ...artifacts.map((item) => ({
      kind: 'artifact' as const,
      id: item.id,
      digest: canonicalDigest(item),
      reason: 'report_original' as const,
    })),
  ];
  const counts = {
    events: events.length,
    receipts: receipts.length,
    artifacts: artifacts.length,
    artifactBytes: originalBytes,
  };
  const manifestFields = {
    packetId: id,
    tenantId: principal.tenantId,
    flightId: input.flightId,
    decisionId: input.decisionId,
    evaluationId: basis.id,
    findingId: String((decisionEvent.envelope.payload.findingTreatment as Record<string, unknown>).findingId),
    issuedBy: principal.id,
    issuedAt,
    scope: SCOPE as typeof SCOPE,
    historicalActorPolicy: { status: 'not_retained' as const },
    dependencyManifest: { status: 'not_retained' as const },
    inventory,
    counts,
  };
  let packet: DecisionPacket | DecisionPacketV2;
  if (executionBasis) {
    const manifest: DecisionPacketV2['manifest'] = {
      ...manifestFields,
      format: FORMAT_V2,
      selection: 'c2-execution-finding-treatment.2',
      selectionId: executionBasis.execution.selection.id,
      selectionDigest: executionBasis.execution.selection.digest,
      evaluator: executionBasis.execution.evaluator,
      adoptionId: executionBasis.execution.adoption?.id ?? null,
      inventory: [
        ...inventory,
        ...executionEvents.map((item) => ({
          kind: 'event' as const,
          id: item.envelope.eventId,
          digest: canonicalDigest(item.entry),
          reason: item === selectionEvent ? ('selected_rule_selection' as const) : ('selected_adoption' as const),
        })),
      ],
      limits: { ...DECISION_PACKET_V2_LIMITS },
      limitations: [...DECISION_PACKET_V2_LIMITATIONS],
    };
    packet = {
      format: FORMAT_V2,
      manifest,
      manifestDigest: canonicalDigest(manifest),
      events: events.map((item) => item.entry),
      receipts,
      artifacts,
    };
  } else {
    const manifest: DecisionPacket['manifest'] = {
      ...manifestFields,
      format: FORMAT,
      selection: 'command-link-finding-treatment.1',
      limits: { ...LIMITS },
      limitations: [...DECISION_PACKET_LIMITATIONS],
    };
    packet = {
      format: FORMAT,
      manifest,
      manifestDigest: canonicalDigest(manifest),
      events: events.map((item) => item.entry),
      receipts,
      artifacts,
    };
  }
  const bytes = Buffer.from(canonicalize(packet), 'utf8');
  bounded(bytes.length <= LIMITS.maxPacketBytes);
  const recordFields = {
    id,
    tenantId: principal.tenantId,
    flightId: input.flightId,
    decisionId: input.decisionId,
    issuedBy: principal.id,
    issuedAt,
    byteLength: bytes.length,
    packetSha256: sha256(bytes),
    manifestDigest: packet.manifestDigest,
    scope: SCOPE as typeof SCOPE,
    counts,
  };
  const record: DecisionPacketRecord = executionBasis
    ? { ...recordFields, format: FORMAT_V2, limits: { ...DECISION_PACKET_V2_LIMITS } }
    : { ...recordFields, format: FORMAT, limits: { ...LIMITS } };
  const namespace = executionBasis ? 'decision-packets-v2' : 'decision-packets';
  const key = `${principal.tenantId}/${namespace}/${id}/packet`;
  const stored = await writeBoundedObject(store, key, bytes, 'application/json', timeout());
  await client.query(
    'INSERT INTO decision_packet_records(id,tenant_id,flight_id,decision_id,format,issued_by,issued_at,object_key,object_version,packet_sha256,manifest_digest,byte_length,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
    [
      id,
      principal.tenantId,
      input.flightId,
      input.decisionId,
      record.format,
      principal.id,
      issuedAt,
      key,
      stored.version ?? null,
      record.packetSha256,
      record.manifestDigest,
      record.byteLength,
      record,
    ],
  );
  return record;
}
export async function getDecisionPacket(client: PoolClient, id: string): Promise<DecisionPacketRecord> {
  return (await getDecisionPacketObject(client, id)).record;
}
function retainedRecord(row: { format: string; metadata: DecisionPacketRecord }): DecisionPacketRecord {
  if (
    ![FORMAT, FORMAT_V2].includes(row.format) ||
    row.metadata.format !== row.format ||
    !equal(row.metadata.limits, row.format === FORMAT ? LIMITS : DECISION_PACKET_V2_LIMITS)
  )
    throw new DomainError(
      409,
      'decision_packet_integrity_failure',
      'Retained packet metadata differs from its immutable format',
    );
  return row.metadata;
}
export async function getDecisionPacketObject(
  client: PoolClient,
  id: string,
): Promise<{ record: DecisionPacketRecord; key: string }> {
  const row = (
    await client.query<{ format: string; metadata: DecisionPacketRecord; object_key: string }>(
      'SELECT format,metadata,object_key FROM decision_packet_records WHERE id=$1',
      [id],
    )
  ).rows[0];
  if (!row) throw new DomainError(404, 'decision_packet_not_found', 'Decision packet is unavailable within this scope');
  return { record: retainedRecord(row), key: row.object_key };
}
export async function listDecisionPackets(client: PoolClient, query: { flightId?: string; decisionId?: string }) {
  const rows = (
    await client.query<{ format: string; metadata: DecisionPacketRecord }>(
      'SELECT format,metadata FROM decision_packet_records WHERE ($1::text IS NULL OR flight_id=$1) AND ($2::text IS NULL OR decision_id=$2) ORDER BY issued_at DESC,id DESC LIMIT 21',
      [query.flightId ?? null, query.decisionId ?? null],
    )
  ).rows;
  return { records: rows.slice(0, 20).map(retainedRecord), limit: 20, hasMore: rows.length > 20 };
}
