import {
  adoptionMode,
  evaluationMode,
  FINDING_PACKET_FORMAT,
  FINDING_PACKET_LIMITATIONS,
  FINDING_PACKET_LIMITS,
  FINDING_PACKET_V2_FORMAT,
  FINDING_PACKET_V2_LIMITATIONS,
  FINDING_PACKET_V2_LIMITS,
  findingPacketEventReasons,
  findingPacketLeftOutStatement,
  type EvidenceEntry,
  type EvidenceEnvelope,
  type EvidenceReceipt,
  type FindingPacket,
  type FindingPacketArtifact,
  type FindingPacketEvaluation,
  type FindingPacketInventoryEntry,
  type FindingPacketManifest,
  type FindingPacketV2,
  type HazardOrigin,
  type InputCut,
  type PackAdoptionAcceptance,
  type RuleEvaluationRecord,
} from '@ledger/contracts';
import { canonicalDigest, sha256 } from '@ledger/integrity';
import { DomainError } from '@ledger/persistence';

/** A retained journal event: its exact entry and the envelope parsed from it. */
export interface PacketEvent {
  entry: EvidenceEntry;
  envelope: EvidenceEnvelope;
}

export type PacketFinding = FindingPacketManifest['finding'];
export type PacketObservation = FindingPacketEvaluation['observations'][number] & { observationId: string };
export type PacketCorrection = FindingPacketEvaluation['corrections'][number];
export type PacketTreatment = FindingPacketManifest['decisions']['treatments'][number];

export interface PacketHazard {
  recordId: string;
  openingEventId: string;
  origin: HazardOrigin;
  assessmentIds: string[];
  acceptanceIds: string[];
}

/** Everything a finding packet holds, as loaded from retained records. */
export interface FindingPacketSources {
  tenantId: string;
  finding: PacketFinding;
  /** The finding's evaluations, oldest first. */
  evaluationIds: string[];
  events: PacketEvent[];
  observations: PacketObservation[];
  corrections: Record<string, PacketCorrection[]>;
  receipts: EvidenceReceipt[];
  artifacts: FindingPacketArtifact[];
  treatments: PacketTreatment[];
  hazards: PacketHazard[];
}

export interface PacketIssue {
  packetId: string;
  issuedBy: string;
  issuedAt: string;
}

type EventReason = (typeof findingPacketEventReasons)[number];

function requireRecord(condition: unknown, message: string): asserts condition {
  if (!condition) throw new DomainError(409, 'finding_packet_reference_invalid', message);
}

function bounded(condition: boolean): void {
  if (!condition)
    throw new DomainError(429, 'finding_packet_budget_exceeded', 'The finding records exceed the packet budget');
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function withinCut(event: EvidenceEnvelope, cut: InputCut): boolean {
  return BigInt(event.sequence) <= BigInt(cut.streams[event.streamId] ?? 0);
}

/** The evaluation record an evaluation event retains, as the evaluator stored and digests it. */
export function evaluationRecordOf(event: EvidenceEnvelope): RuleEvaluationRecord {
  const evaluation = event.payload.evaluation;
  requireRecord(
    event.type === 'rule-evaluation.recorded' && object(evaluation) && evaluation.id === event.eventId,
    `Event ${event.eventId} is not a retained rule evaluation`,
  );
  return { ...(evaluation as Omit<RuleEvaluationRecord, 'recordedAt'>), recordedAt: event.receivedAt };
}

/** The adoption record an adoption event retains. */
export function adoptionRecordOf(event: EvidenceEnvelope): PackAdoptionAcceptance {
  const acceptance = event.payload.acceptance;
  requireRecord(
    event.type === 'rule-pack.adopt' && object(acceptance) && object(acceptance.pack),
    `Event ${event.eventId} is not a retained pack adoption`,
  );
  return {
    ...(acceptance as Omit<PackAdoptionAcceptance, 'id' | 'acceptedAt'>),
    id: event.eventId,
    acceptedAt: event.receivedAt,
  };
}

class EventIndex {
  private readonly byId = new Map<string, PacketEvent>();
  constructor(events: PacketEvent[], tenantId: string) {
    for (const event of events) {
      requireRecord(!this.byId.has(event.envelope.eventId), 'Packet events must be unique');
      requireRecord(event.envelope.tenantId === tenantId, 'A packet event belongs to another tenant');
      this.byId.set(event.envelope.eventId, event);
    }
  }
  get(id: string, what: string): EvidenceEnvelope {
    const event = this.byId.get(id);
    requireRecord(event, `The ${what} event ${id} is not retained`);
    return event.envelope;
  }
  all(): PacketEvent[] {
    return [...this.byId.values()];
  }
}

function checkAdoption(record: RuleEvaluationRecord, adoption: PackAdoptionAcceptance): void {
  const { digest, ...content } = adoption.pack;
  const leaf = adoption.pack.leaves.find((item) => item.id === record.rule.id && item.version === record.rule.version);
  requireRecord(
    adoption.pack.packId === record.pack.id &&
      adoption.pack.version === record.pack.version &&
      digest === record.pack.digest &&
      canonicalDigest(content) === digest &&
      leaf?.digest === record.rule.digest &&
      adoption.acceptedRevision === record.adoption.acceptedRevision &&
      adoption.organizationId === record.organizationId &&
      adoptionMode(adoption) === evaluationMode(record),
    `Evaluation ${record.id} differs from the adoption it names`,
  );
}

function checkObservations(
  record: RuleEvaluationRecord,
  rows: Map<string, PacketObservation>,
  events: EventIndex,
  receipts: Map<string, EvidenceReceipt>,
  artifacts: Map<string, FindingPacketArtifact>,
): PacketObservation[] {
  const ids = [...new Set(record.inputs.flatMap((input) => input.observationIds))];
  const read = ids.map((id) => {
    const row = rows.get(id);
    requireRecord(row, `Observation ${id} read by evaluation ${record.id} is not retained`);
    const event = events.get(row.eventId, 'observation');
    const receipt = receipts.get(row.receiptId);
    requireRecord(
      receipt &&
        receipt.eventId === event.eventId &&
        receipt.artifactId === row.artifactId &&
        event.artifactId === row.artifactId &&
        artifacts.has(row.artifactId) &&
        withinCut(event, record.inputCut),
      `Observation ${id} differs from its receipt, its source or the evaluation input cut`,
    );
    return row;
  });
  for (const item of record.evidence) {
    const row = rows.get(item.observationId);
    requireRecord(
      ids.includes(item.observationId) && row?.eventId === item.eventId && row.receiptId === item.receiptId,
      `Evidence of evaluation ${record.id} names an observation it did not read`,
    );
  }
  return read;
}

function checkCorrections(record: RuleEvaluationRecord, corrections: PacketCorrection[], events: EventIndex): void {
  for (const correction of corrections)
    requireRecord(
      withinCut(events.get(correction.eventId, 'correction'), record.inputCut),
      `Correction ${correction.eventId} lies outside the input cut of evaluation ${record.id}`,
    );
}

function evaluationSummary(
  record: RuleEvaluationRecord,
  observations: PacketObservation[],
  corrections: PacketCorrection[],
): FindingPacketEvaluation {
  const state = record.subjectState;
  return {
    id: record.id,
    digest: canonicalDigest(record),
    recordedAt: record.recordedAt,
    mode: evaluationMode(record),
    adoptionId: record.adoption.id,
    ruleSourceKind: record.rule.source.kind,
    outcome: record.outcome,
    evidenceState: record.evidenceState,
    observations: observations.map((item) => ({ ...item })),
    corrections: corrections.map((item) => ({ ...item })),
    subjectState: state
      ? { name: state.name, kind: state.kind, revision: state.revision, digest: canonicalDigest(state.state) }
      : null,
  };
}

function checkHazard(
  hazard: PacketHazard,
  finding: PacketFinding,
  digests: Map<string, string>,
  events: EventIndex,
): void {
  const origin = hazard.origin;
  requireRecord(
    origin.kind === 'finding' &&
      origin.findingId === finding.id &&
      origin.subjectKey === finding.subjectKey &&
      digests.get(origin.evaluationId) === origin.evaluationDigest,
    `Hazard ${hazard.recordId} pins an evaluation that is not this finding's`,
  );
  const opening = events.get(hazard.openingEventId, 'hazard opening');
  requireRecord(
    opening.type === 'sms.record.open' && opening.payload.recordId === hazard.recordId,
    `Hazard ${hazard.recordId} has no retained opening`,
  );
  const decisions = [
    ...hazard.assessmentIds.map((id) => ['risk.assess', id] as const),
    ...hazard.acceptanceIds.map((id) => ['risk.accept', id] as const),
  ];
  for (const [kind, id] of decisions) {
    const acceptance = events.get(id, 'hazard decision').payload.acceptance;
    requireRecord(
      object(acceptance) && acceptance.subjectId === hazard.recordId && acceptance.kind === kind,
      `Decision ${id} is not a ${kind} of hazard ${hazard.recordId}`,
    );
  }
}

function statements(records: RuleEvaluationRecord[]): string[] {
  const latest = records.at(-1)!;
  const shadow = records.filter((record) => evaluationMode(record) === 'shadow');
  const proposed = records.some((record) => record.rule.source.kind === 'proposed_regulation');
  return [
    ...(evaluationMode(latest) === 'shadow'
      ? [
          'The rule behind this finding was adopted in shadow. Shadow findings are recorded and labelled, and are not counted in what a person attests to.',
        ]
      : []),
    ...(shadow.length && evaluationMode(latest) !== 'shadow'
      ? ['Some evaluations in this packet ran while the rule was adopted in shadow; each evaluation states its mode.']
      : []),
    ...(proposed
      ? ['The rule text is proposed text that is not in force. It is included as written so a person can review it.']
      : []),
    'This packet records what the evidence supported and what people decided. It does not determine whether any requirement is met.',
  ];
}

class Inventory {
  private readonly reasons = new Map<string, EventReason>();
  add(id: string, reason: EventReason): void {
    if (!this.reasons.has(id)) this.reasons.set(id, reason);
  }
  ids(): string[] {
    return [...this.reasons.keys()];
  }
  reason(id: string): EventReason {
    return this.reasons.get(id)!;
  }
}

/**
 * Checks that the loaded records are one finding's complete selection and assembles its packet. Every reference
 * must resolve to an included record; nothing depends on which rule, pack or observation type produced the finding.
 */
export function assembleFindingPacket(sources: FindingPacketSources, issue: PacketIssue): FindingPacket {
  const { finding, tenantId } = sources;
  const limits = FINDING_PACKET_LIMITS;
  bounded(
    sources.evaluationIds.length <= limits.maxEvaluations &&
      sources.events.length <= limits.maxEvents &&
      sources.receipts.length <= limits.maxReceipts &&
      sources.artifacts.length <= limits.maxArtifacts &&
      sources.hazards.length <= limits.maxHazards,
  );
  requireRecord(sources.evaluationIds.length > 0, 'The finding has no retained evaluation');
  const events = new EventIndex(sources.events, tenantId);
  const rows = new Map(sources.observations.map((row) => [row.observationId, row]));
  const receipts = new Map(sources.receipts.map((item) => [item.id, item]));
  const artifacts = new Map(sources.artifacts.map((item) => [item.id, item]));
  const inventory = new Inventory();

  const records = sources.evaluationIds.map((id) => evaluationRecordOf(events.get(id, 'evaluation')));
  requireRecord(
    records[0]!.id === finding.initialEvaluationId && records.at(-1)!.id === finding.latestEvaluationId,
    'The evaluations do not run from the finding’s first evaluation to its latest',
  );
  const adoptions = new Map<string, PackAdoptionAcceptance>();
  const evaluations: FindingPacketEvaluation[] = [];
  for (const record of records) {
    requireRecord(
      record.subjectKey === finding.subjectKey &&
        record.pack.id === finding.packId &&
        record.rule.id === finding.ruleId,
      `Evaluation ${record.id} is about another subject or rule`,
    );
    inventory.add(record.id, 'finding_evaluation');
    const adoption = adoptions.get(record.adoption.id) ?? adoptionRecordOf(events.get(record.adoption.id, 'adoption'));
    checkAdoption(record, adoption);
    adoptions.set(adoption.id, adoption);
    const read = checkObservations(record, rows, events, receipts, artifacts);
    const corrections = sources.corrections[record.id] ?? [];
    checkCorrections(record, corrections, events);
    evaluations.push(evaluationSummary(record, read, corrections));
  }
  for (const id of adoptions.keys()) inventory.add(id, 'evaluation_adoption');
  for (const evaluation of evaluations)
    for (const item of evaluation.observations) inventory.add(item.eventId, 'read_observation');
  for (const evaluation of evaluations)
    for (const correction of evaluation.corrections) {
      const corrected = rows.get(correction.observationId);
      if (corrected) inventory.add(corrected.eventId, 'corrected_observation');
      inventory.add(correction.eventId, 'observation_correction');
    }

  const digests = new Map(evaluations.map((item) => [item.id, item.digest]));
  for (const treatment of sources.treatments) {
    requireRecord(digests.has(treatment.evaluationId), `Treatment ${treatment.id} names another evaluation`);
    events.get(treatment.id, 'treatment');
    inventory.add(treatment.id, 'finding_treatment');
  }
  for (const hazard of sources.hazards) {
    checkHazard(hazard, finding, digests, events);
    inventory.add(hazard.openingEventId, 'hazard_opening');
    for (const id of hazard.assessmentIds) inventory.add(id, 'hazard_assessment');
    for (const id of hazard.acceptanceIds) inventory.add(id, 'hazard_acceptance');
  }

  const included = inventory.ids();
  requireRecord(
    included.length === sources.events.length,
    'The loaded events differ from the events the finding’s records reference',
  );
  const usedReceipts = new Set(evaluations.flatMap((item) => item.observations.map((row) => row.receiptId)));
  const usedArtifacts = new Set(evaluations.flatMap((item) => item.observations.map((row) => row.artifactId)));
  requireRecord(
    usedReceipts.size === receipts.size && usedArtifacts.size === artifacts.size,
    'The loaded receipts or sources differ from those the evaluations read',
  );
  const origins = sources.hazards
    .map((hazard) => ({
      recordId: hazard.recordId,
      origin: hazard.origin as Extract<HazardOrigin, { kind: 'finding' }>,
    }))
    .sort((left, right) => left.recordId.localeCompare(right.recordId));
  const byId = <T extends { id: string }>(items: T[]) => [...items].sort((a, b) => a.id.localeCompare(b.id));
  const packetEvents = events.all().sort((a, b) => a.envelope.eventId.localeCompare(b.envelope.eventId));
  const packetReceipts = byId(sources.receipts);
  const packetArtifacts = byId(sources.artifacts);
  const entries: FindingPacketInventoryEntry[] = [
    ...packetEvents.map((item) => ({
      kind: 'event' as const,
      id: item.envelope.eventId,
      digest: canonicalDigest(item.entry),
      reason: inventory.reason(item.envelope.eventId),
    })),
    ...packetReceipts.map((item) => ({
      kind: 'receipt' as const,
      id: item.id,
      digest: canonicalDigest(item),
      reason: 'observation_receipt' as const,
    })),
    ...packetArtifacts.map((item) => ({
      kind: 'artifact' as const,
      id: item.id,
      digest: canonicalDigest(item),
      reason: 'observation_source' as const,
    })),
    ...origins.map((item) => ({
      kind: 'origin' as const,
      id: item.recordId,
      digest: canonicalDigest(item),
      reason: 'hazard_origin' as const,
    })),
  ];
  const manifest: FindingPacketManifest = {
    format: FINDING_PACKET_FORMAT,
    packetId: issue.packetId,
    tenantId,
    issuedBy: issue.issuedBy,
    issuedAt: issue.issuedAt,
    finding: { ...finding },
    statements: statements(records),
    evaluations,
    adoptions: [...adoptions.values()].map((adoption) => ({
      id: adoption.id,
      digest: canonicalDigest(adoption),
      mode: adoptionMode(adoption),
      packId: adoption.pack.packId,
      packVersion: adoption.pack.version,
      packDigest: adoption.pack.digest,
    })),
    decisions: {
      treatments: sources.treatments.map((item) => ({ ...item })),
      hazards: sources.hazards.map((hazard) => ({
        recordId: hazard.recordId,
        openingEventId: hazard.openingEventId,
        originDigest: canonicalDigest(origins.find((item) => item.recordId === hazard.recordId)),
        evaluationId: (hazard.origin as Extract<HazardOrigin, { kind: 'finding' }>).evaluationId,
        assessmentIds: [...hazard.assessmentIds],
        acceptanceIds: [...hazard.acceptanceIds],
      })),
    },
    inventory: entries,
    counts: {
      evaluations: evaluations.length,
      events: packetEvents.length,
      receipts: packetReceipts.length,
      artifacts: packetArtifacts.length,
      hazards: origins.length,
    },
    limits: { ...limits },
    limitations: [...FINDING_PACKET_LIMITATIONS],
  };
  return {
    format: FINDING_PACKET_FORMAT,
    manifest,
    manifestDigest: canonicalDigest(manifest),
    events: packetEvents.map((item) => item.entry),
    receipts: packetReceipts,
    artifacts: packetArtifacts,
    origins,
  };
}

/** The order in which a version 2 packet leaves out source bytes: largest first, ties by id. */
export function originalsLeaveOutOrder(artifacts: FindingPacketArtifact[]): FindingPacketArtifact[] {
  return [...artifacts].sort((a, b) => b.byteLength - a.byteLength || a.id.localeCompare(b.id));
}

/** The sources whose bytes are left out so the rest fit within the original-byte bound, in leave-out order. */
export function originalsLeftOut(artifacts: FindingPacketArtifact[]): string[] {
  let carried = artifacts.reduce((sum, item) => sum + item.byteLength, 0);
  const leftOut: string[] = [];
  for (const item of originalsLeaveOutOrder(artifacts)) {
    if (carried <= FINDING_PACKET_V2_LIMITS.maxOriginalBytes) break;
    leftOut.push(item.id);
    carried -= item.byteLength;
  }
  return leftOut;
}

/**
 * Assembles a version 2 packet: the version 1 selection, with the exact bytes of every source an evaluation read except
 * those in `leftOut`, which must be a prefix of the leave-out order. Each carried byte range is checked against the
 * digest and length of the source its receipt names.
 */
export function assembleFindingPacketV2(
  sources: FindingPacketSources,
  issue: PacketIssue,
  originals: ReadonlyMap<string, Uint8Array>,
  leftOut: string[],
): FindingPacketV2 {
  const packet = assembleFindingPacket(sources, issue);
  const order = originalsLeaveOutOrder(packet.artifacts).map((item) => item.id);
  requireRecord(
    leftOut.every((id, index) => order[index] === id),
    'Source bytes must be left out largest first',
  );
  const omitted = new Set(leftOut);
  let originalBytes = 0;
  const artifacts = packet.artifacts.map((artifact) => {
    if (omitted.has(artifact.id)) return { ...artifact, bytesBase64: null };
    const bytes = originals.get(artifact.id);
    requireRecord(
      bytes && bytes.byteLength === artifact.byteLength && sha256(bytes) === artifact.sha256,
      `The original bytes of source ${artifact.id} differ from its digest or length`,
    );
    originalBytes += bytes.byteLength;
    return { ...artifact, bytesBase64: Buffer.from(bytes).toString('base64') };
  });
  bounded(originalBytes <= FINDING_PACKET_V2_LIMITS.maxOriginalBytes);
  const byId = new Map(artifacts.map((item) => [item.id, item]));
  const inventory = packet.manifest.inventory.map((entry) => {
    const artifact = entry.kind === 'artifact' ? byId.get(entry.id)! : undefined;
    if (!artifact) return entry;
    return {
      kind: 'artifact' as const,
      id: entry.id,
      digest: canonicalDigest(artifact),
      reason:
        artifact.bytesBase64 === null ? ('observation_source_digest_only' as const) : ('observation_source' as const),
    };
  });
  const { format: _format, ...fields } = packet.manifest;
  const manifest: FindingPacketV2['manifest'] = {
    ...fields,
    format: FINDING_PACKET_V2_FORMAT,
    statements: [...fields.statements, ...(leftOut.length ? [findingPacketLeftOutStatement(leftOut.length)] : [])],
    inventory,
    leftOutOriginals: [...leftOut],
    counts: { ...fields.counts, originalBytes, leftOutOriginals: leftOut.length },
    limits: { ...FINDING_PACKET_V2_LIMITS },
    limitations: [...FINDING_PACKET_V2_LIMITATIONS],
  };
  return {
    format: FINDING_PACKET_V2_FORMAT,
    manifest,
    manifestDigest: canonicalDigest(manifest),
    events: packet.events,
    receipts: packet.receipts,
    artifacts,
    origins: packet.origins,
  };
}
