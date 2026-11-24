import {
  BundleVerificationError,
  canonicalDigest,
  canonicalize,
  decodeBase64,
  entryHash,
  parseStrictJson,
  requireValue,
  sequence,
  sha256,
} from './integrity.mjs';
import { verifyCommandLinkReceipt } from './flight.mjs';

export { BundleVerificationError, parseStrictJson } from './integrity.mjs';
export const DECISION_PACKET_FORMAT = 'ledger.decision-packet.1';
export const DECISION_PACKET_LIMITS = Object.freeze({
  maxEvents: 128,
  maxReceipts: 126,
  maxArtifacts: 126,
  maxReferenceDepth: 2,
  maxEnvelopeBytes: 262144,
  maxOriginalBytes: 1048576,
  maxPacketBytes: 4194304,
});
export const DECISION_PACKET_LIMITATIONS = Object.freeze([
  'This packet contains selected command-link finding-treatment records only; it is not a complete journal prefix, full flight history or whole-tenant export.',
  'Inventory digests commit complete selected records; included journal framing does not prove journal membership or complete-prefix continuity.',
  'Historical actor authority and dependency-basis manifests were not retained for this flight decision and are not reconstructed.',
  'This packet does not reconstruct a historical display or replay evaluator or projection behavior.',
  'Reported command-link evidence does not establish present communications health, monitored exposure or a loss rate.',
  "The manifest digest must be retained independently; this packet is not externally timestamped, anchored or a person's electronic signature.",
]);
const INTEGRITY = 'ledger.v6.sha256.jcs.1';
const SCOPE = 'selected_c2_finding_treatment_records';
const SELECTION = 'command-link-finding-treatment.1';
const LEAF = 'ledger.demo.command-link-loss-review';
const BINDING = 'ledger.command-link-status';
const LEAF_DIGEST = '91bb4acacc1a8708254a746c03ea96e362a93079c5840ee2c00e7691f8274e8f';
const BINDING_DIGEST = 'a8d3e22580e514d8a1910aef848325d08ac621e44ffc266d533c1a6f1bdc7eb0';
const ENVELOPE_KEYS = [
  'eventId',
  'tenantId',
  'streamId',
  'sequence',
  'type',
  'schemaVersion',
  'principalId',
  'sourceId',
  'sourceSessionId',
  'occurredAt',
  'effectiveAt',
  'receivedAt',
  'causationId',
  'artifactId',
  'payload',
];
const check = (condition, code, path, message) => requireValue(condition, code, path, message);
const same = (actual, expected, code, path, message) =>
  check(canonicalize(actual) === canonicalize(expected), code, path, message);
const object = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const id = (value) => typeof value === 'string' && value.length > 0 && value.length <= 200;
const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function keys(value, required, path, optional = []) {
  check(
    object(value) &&
      required.every((key) => Object.hasOwn(value, key)) &&
      Object.keys(value).every((key) => required.includes(key) || optional.includes(key)),
    'packet_shape',
    path,
    'Fields do not match the selected packet contract',
  );
}
function time(value, path, nullable = false) {
  if (nullable && value === null) return;
  check(
    typeof value === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,3})?Z$/.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString().slice(0, 19) === value.slice(0, 19),
    'packet_time',
    path,
    'Expected a valid retained UTC timestamp',
  );
}
function boundedPacket(value) {
  let remaining = DECISION_PACKET_LIMITS.maxPacketBytes;
  const visit = (item, depth) => {
    check(depth <= 64, 'packet_bound', '$', 'Packet JSON exceeds its depth bound');
    if (typeof item === 'string') remaining -= Buffer.byteLength(item, 'utf8') + 2;
    else if (item === null || typeof item === 'boolean') remaining -= 5;
    else if (typeof item === 'number') {
      check(
        Number.isFinite(item) && (!Number.isInteger(item) || Number.isSafeInteger(item)),
        'packet_number',
        '$',
        'Packet contains an unsupported JSON number',
      );
      remaining -= 1;
    } else {
      check(Array.isArray(item) || object(item), 'packet_shape', '$', 'Packet must contain plain JSON values');
      remaining -= 2;
      for (const [key, child] of Object.entries(item)) {
        remaining -= Array.isArray(item) ? 1 : Buffer.byteLength(key, 'utf8') + 3;
        check(remaining >= 0, 'packet_bound', '$', 'Packet exceeds its byte bound');
        visit(child, depth + 1);
      }
    }
    check(remaining >= 0, 'packet_bound', '$', 'Packet exceeds its byte bound');
  };
  visit(value, 0);
  check(
    Buffer.byteLength(canonicalize(value), 'utf8') <= DECISION_PACKET_LIMITS.maxPacketBytes,
    'packet_bound',
    '$',
    'Packet exceeds its byte bound',
  );
}
function preflightRecords(packet) {
  for (const entry of packet.events)
    check(
      typeof entry?.canonicalEnvelope === 'string' &&
        Buffer.byteLength(entry.canonicalEnvelope, 'utf8') <= DECISION_PACKET_LIMITS.maxEnvelopeBytes,
      'packet_envelope_bound',
      '$.events',
      'Selected envelope exceeds its byte bound',
    );
  let originalBytes = 0;
  for (const artifact of packet.artifacts) {
    check(
      integer(artifact?.byteLength) &&
        artifact.byteLength <= 64 * 1024 &&
        typeof artifact.bytesBase64 === 'string' &&
        artifact.bytesBase64.length <= 4 * Math.ceil(artifact.byteLength / 3),
      'packet_original_bound',
      '$.artifacts',
      'Selected C2 original exceeds its byte bound',
    );
    originalBytes += artifact.byteLength;
    check(
      originalBytes <= DECISION_PACKET_LIMITS.maxOriginalBytes,
      'packet_original_bound',
      '$.artifacts',
      'Selected originals exceed their aggregate byte bound',
    );
  }
}
function cut(value, path) {
  keys(value, ['streams', 'principalRevision'], path, ['basisRevision']);
  check(
    object(value.streams) &&
      Object.entries(value.streams).every(([streamId, position]) => id(streamId) && integer(position)) &&
      integer(value.principalRevision) &&
      (value.basisRevision === undefined || integer(value.basisRevision)),
    'packet_cut',
    path,
    'Retained cut has invalid positions or revisions',
  );
}
function cutPair(rendered, accepted, path) {
  cut(rendered, path);
  cut(accepted, path);
  check(
    rendered.principalRevision === accepted.principalRevision &&
      rendered.basisRevision === accepted.basisRevision &&
      Object.entries(rendered.streams).every(([streamId, position]) => position <= (accepted.streams[streamId] ?? 0)),
    'packet_cut',
    path,
    'Rendered and accepted cuts are inconsistent',
  );
}
const inCut = (event, value) => BigInt(event.sequence) <= BigInt(value.streams[event.streamId] ?? 0);
const scopeKey = (report) =>
  canonicalize([report.sourceId, report.sourceSessionId, report.incidentId, report.aircraftId]);

function readEvents(packet, manifest) {
  const events = new Map();
  for (const [index, entry] of packet.events.entries()) {
    const path = `$.events[${index}]`;
    keys(entry, ['canonicalEnvelope', 'envelopeDigest', 'previousHash', 'entryHash', 'encodingVersion'], path);
    check(
      typeof entry.canonicalEnvelope === 'string' &&
        Buffer.byteLength(entry.canonicalEnvelope, 'utf8') <= DECISION_PACKET_LIMITS.maxEnvelopeBytes,
      'packet_envelope_bound',
      path,
      'Selected envelope exceeds its byte bound',
    );
    const envelope = parseStrictJson(entry.canonicalEnvelope, path);
    keys(envelope, ENVELOPE_KEYS, path);
    check(
      canonicalize(envelope) === entry.canonicalEnvelope,
      'packet_envelope_bytes',
      path,
      'Selected envelope is not its exact canonical representation',
    );
    check(envelope.tenantId === manifest.tenantId, 'packet_tenant', path, 'Selected event belongs to another tenant');
    check(
      ['eventId', 'streamId', 'type', 'principalId'].every((field) => id(envelope[field])) &&
        envelope.schemaVersion === 1 &&
        object(envelope.payload),
      'packet_envelope',
      path,
      'Selected event identity or payload is invalid',
    );
    for (const field of ['sourceId', 'sourceSessionId', 'causationId', 'artifactId'])
      check(
        envelope[field] === null || id(envelope[field]),
        'packet_envelope',
        path,
        'Selected event attribution is invalid',
      );
    time(envelope.receivedAt, path);
    time(envelope.occurredAt, path, true);
    time(envelope.effectiveAt, path, true);
    const position = sequence(envelope.sequence, path);
    check(
      entry.encodingVersion === INTEGRITY &&
        hash(entry.envelopeDigest) &&
        hash(entry.entryHash) &&
        (position === 1n ? entry.previousHash === '' : hash(entry.previousHash)),
      'packet_entry',
      path,
      'Selected journal framing is invalid',
    );
    check(
      sha256(entry.canonicalEnvelope) === entry.envelopeDigest &&
        entryHash(manifest.tenantId, envelope.streamId, position, entry.previousHash, entry.envelopeDigest) ===
          entry.entryHash,
      'packet_entry',
      path,
      'Selected local journal hashes do not reproduce the retained entry',
    );
    check(!events.has(envelope.eventId), 'packet_duplicate', path, 'Selected event identity is duplicated');
    events.set(envelope.eventId, { entry, envelope });
  }
  return events;
}

function readArtifacts(packet, manifest) {
  const artifacts = new Map();
  let artifactBytes = 0;
  for (const [index, artifact] of packet.artifacts.entries()) {
    const path = `$.artifacts[${index}]`;
    keys(artifact, ['tenantId', 'id', 'sha256', 'byteLength', 'contentType', 'bytesBase64'], path);
    check(
      artifact.tenantId === manifest.tenantId &&
        id(artifact.id) &&
        typeof artifact.contentType === 'string' &&
        hash(artifact.sha256),
      'packet_artifact',
      path,
      'Selected artifact attribution is invalid',
    );
    check(
      integer(artifact.byteLength) &&
        artifact.byteLength <= DECISION_PACKET_LIMITS.maxOriginalBytes &&
        typeof artifact.bytesBase64 === 'string' &&
        artifact.bytesBase64.length <= 4 * Math.ceil(artifact.byteLength / 3),
      'packet_original_bound',
      path,
      'Selected original exceeds its declared byte bound',
    );
    artifactBytes += artifact.byteLength;
    check(
      artifactBytes <= DECISION_PACKET_LIMITS.maxOriginalBytes,
      'packet_original_bound',
      path,
      'Selected originals exceed their aggregate byte bound',
    );
    const bytes = decodeBase64(artifact.bytesBase64, path);
    check(
      bytes.byteLength === artifact.byteLength && sha256(bytes) === artifact.sha256,
      'packet_original',
      path,
      'Selected original differs from its retained byte commitment',
    );
    check(!artifacts.has(artifact.id), 'packet_duplicate', path, 'Selected artifact identity is duplicated');
    artifacts.set(artifact.id, artifact);
  }
  return { artifacts, artifactBytes };
}

function selectedBasis(manifest, events) {
  const decision = events.get(manifest.decisionId)?.envelope;
  const evaluation = events.get(manifest.evaluationId)?.envelope;
  check(
    decision?.type === 'decision.record' && evaluation?.type === 'evaluation.recorded',
    'packet_selection',
    '$.events',
    'Selected decision or evaluation is unavailable',
  );
  const body = decision.payload;
  keys(
    body,
    [
      'kind',
      'flightId',
      'expectedRevision',
      'expectedBasisRevision',
      'inputCut',
      'expectedDependencyBasis',
      'findingTreatment',
      'decision',
      'acceptedInputCut',
      'acceptedFindingBasis',
    ],
    '$.decision',
  );
  keys(body.findingTreatment, ['findingId', 'evaluationId', 'action'], '$.decision.findingTreatment');
  keys(body.decision, ['kind', 'note'], '$.decision.decision');
  const action = body.findingTreatment.action;
  check(
    body.kind === 'decision.record' &&
      body.flightId === manifest.flightId &&
      ['acknowledge', 'respond', 'resolve'].includes(action) &&
      body.decision.kind === `finding.${action}` &&
      typeof body.decision.note === 'string' &&
      body.decision.note.length > 0 &&
      body.decision.note.length <= 4000 &&
      body.findingTreatment.findingId === manifest.findingId &&
      body.findingTreatment.evaluationId === manifest.evaluationId,
    'packet_decision',
    '$.decision',
    'Packet supports only a C2 finding treatment with exact retained references',
  );
  check(
    integer(body.expectedRevision) && integer(body.expectedBasisRevision) && hash(body.expectedDependencyBasis),
    'packet_decision',
    '$.decision',
    'Decision basis fields are invalid',
  );
  cutPair(body.inputCut, body.acceptedInputCut, '$.decision.cuts');
  check(
    body.inputCut.basisRevision === body.expectedBasisRevision &&
      inCut(evaluation, body.inputCut) &&
      !inCut(decision, body.acceptedInputCut),
    'packet_cut',
    '$.decision',
    'Selected evaluation or preappend decision position differs from the retained cuts',
  );
  const payload = evaluation.payload;
  keys(payload, ['flightId', 'findingId', 'evaluation', 'leaf', 'binding', 'declaredSubjects'], '$.evaluation');
  check(
    payload.flightId === manifest.flightId && payload.findingId === manifest.findingId,
    'packet_evaluation',
    '$.evaluation',
    'Evaluation selects a different flight or finding',
  );
  same(
    payload.declaredSubjects,
    [manifest.flightId],
    'packet_evaluation',
    '$.evaluation',
    'Evaluation declares a different subject scope',
  );
  check(
    canonicalDigest(payload.leaf) === LEAF_DIGEST && canonicalDigest(payload.binding) === BINDING_DIGEST,
    'packet_rule',
    '$.evaluation',
    'Evaluation does not retain the supported version-one company procedure and binding',
  );
  const value = payload.evaluation;
  keys(
    value,
    [
      'flightId',
      'leafId',
      'leafVersion',
      'bindingId',
      'bindingVersion',
      'applicability',
      'evidenceState',
      'outcome',
      'title',
      'explanation',
      'clock',
      'inputCut',
      'acceptedInputCut',
      'dependencyBasis',
    ],
    '$.evaluation.evaluation',
  );
  check(
    value.flightId === manifest.flightId &&
      value.leafId === LEAF &&
      value.leafVersion === 1 &&
      value.bindingId === BINDING &&
      value.bindingVersion === 1 &&
      value.title === payload.leaf.title &&
      value.applicability === 'applicable' &&
      ['supported', 'insufficient', 'conflicting'].includes(value.evidenceState) &&
      ['pass', 'attention', 'pending'].includes(value.outcome) &&
      hash(value.dependencyBasis),
    'packet_evaluation',
    '$.evaluation',
    'Evaluation is outside the supported C2 procedure scope',
  );
  keys(value.clock, ['mode', 'evaluatedAt'], '$.evaluation.clock');
  time(value.clock.evaluatedAt, '$.evaluation.clock');
  check(
    value.clock.mode === 'wall',
    'packet_evaluation',
    '$.evaluation.clock',
    'Evaluation must retain an explicit wall clock',
  );
  cutPair(value.inputCut, value.acceptedInputCut, '$.evaluation.cuts');
  check(
    !inCut(evaluation, value.acceptedInputCut),
    'packet_cut',
    '$.evaluation',
    'Evaluation cannot include itself in its preappend basis',
  );
  const retained = {
    ...value,
    rule: {
      reference: payload.leaf.source.reference,
      text: payload.leaf.source.text,
      review: payload.leaf.review,
      adopted: payload.leaf.adopted,
    },
    id: evaluation.eventId,
    recordedAt: evaluation.receivedAt,
  };
  same(
    body.acceptedFindingBasis,
    retained,
    'packet_accepted_basis',
    '$.decision.acceptedFindingBasis',
    'Decision does not pin the complete selected evaluation acceptance',
  );
  check(
    action !== 'resolve' || (value.outcome === 'pass' && value.evidenceState === 'supported'),
    'packet_decision',
    '$.decision',
    'Resolution does not retain cleared C2 evidence',
  );
  const expectedFindingId = `finding:${canonicalDigest({ tenant: manifest.tenantId, flightId: manifest.flightId, leafId: LEAF, scope: 'flight' })}`;
  check(
    manifest.findingId === expectedFindingId,
    'packet_selection',
    '$.manifest.findingId',
    'Finding identity differs from its stable flight and leaf scope',
  );
  return { decision, evaluation, value };
}

function reportClosure(packet, manifest, events, artifacts, selected) {
  const explanation = selected.value.explanation;
  keys(explanation, ['kind', 'code', 'summary', 'evidence', 'groups', 'evaluatedAt'], '$.evaluation.explanation');
  check(
    explanation.kind === 'command_link' &&
      typeof explanation.code === 'string' &&
      typeof explanation.summary === 'string' &&
      Array.isArray(explanation.evidence) &&
      explanation.evidence.length <= DECISION_PACKET_LIMITS.maxReceipts &&
      Array.isArray(explanation.groups) &&
      explanation.groups.length <= DECISION_PACKET_LIMITS.maxReceipts,
    'packet_reports',
    '$.evaluation.explanation',
    'Evaluation does not retain bounded C2 report evidence',
  );
  time(explanation.evaluatedAt, '$.evaluation.explanation');
  check(
    Date.parse(explanation.evaluatedAt) === Date.parse(selected.value.clock.evaluatedAt),
    'packet_evaluation',
    '$.evaluation.explanation',
    'Explanation and evaluation clocks differ',
  );
  const reports = new Map();
  const reportReceipts = new Map();
  const sourceEvents = new Set();
  const groups = new Map();
  for (const report of explanation.evidence) {
    keys(
      report,
      [
        'flightId',
        'eventId',
        'receiptId',
        'sourceId',
        'sourceSessionId',
        'sourceEventId',
        'incidentId',
        'aircraftId',
        'occurredAt',
        'status',
      ],
      '$.evaluation.explanation.evidence',
    );
    check(
      [
        'flightId',
        'eventId',
        'receiptId',
        'sourceId',
        'sourceSessionId',
        'sourceEventId',
        'incidentId',
        'aircraftId',
      ].every((field) => id(report[field])) &&
        report.flightId === manifest.flightId &&
        ['lost', 'restored'].includes(report.status),
      'packet_report',
      '$.evaluation.explanation.evidence',
      'Report identity or scope is invalid',
    );
    time(report.occurredAt, '$.evaluation.explanation.evidence');
    check(
      !reports.has(report.eventId) && !reportReceipts.has(report.receiptId),
      'packet_duplicate',
      '$.evaluation.explanation.evidence',
      'Evaluation duplicates a report event or receipt',
    );
    const identity = canonicalize([report.sourceId, report.sourceSessionId, report.sourceEventId]);
    check(
      !sourceEvents.has(identity),
      'packet_duplicate',
      '$.evaluation.explanation.evidence',
      'Evaluation duplicates a source event identity',
    );
    const event = events.get(report.eventId)?.envelope;
    check(
      event?.type === 'command-link.status' &&
        event.sourceId === report.sourceId &&
        event.sourceSessionId === report.sourceSessionId &&
        event.payload.subject?.flightId === manifest.flightId &&
        event.payload.flightId === manifest.flightId &&
        event.payload.payload?.sourceEventId === report.sourceEventId &&
        event.payload.payload?.incidentId === report.incidentId &&
        event.payload.payload?.aircraftId === report.aircraftId &&
        event.payload.payload?.status === report.status &&
        Date.parse(event.occurredAt) === Date.parse(report.occurredAt) &&
        inCut(event, selected.value.inputCut),
      'packet_report',
      '$.evaluation.explanation.evidence',
      'Report differs from its selected C2 event or retained rendered cut',
    );
    verifyCommandLinkReceipt(event, artifacts, '$.evaluation.explanation.evidence');
    reports.set(report.eventId, report);
    reportReceipts.set(report.receiptId, event);
    sourceEvents.add(identity);
    const key = scopeKey(report);
    const group = groups.get(key) ?? { losses: [], restorations: [] };
    (report.status === 'lost' ? group.losses : group.restorations).push(report.eventId);
    groups.set(key, group);
  }
  check(
    reports.has(selected.evaluation.causationId),
    'packet_report',
    '$.evaluation.causationId',
    'Evaluation trigger is not among its cited reports',
  );
  const declaredGroups = new Set();
  for (const group of explanation.groups) {
    keys(
      group,
      ['sourceId', 'sourceSessionId', 'incidentId', 'aircraftId', 'state', 'lossEventIds', 'restorationEventIds'],
      '$.evaluation.explanation.groups',
    );
    const key = scopeKey(group);
    const expected = groups.get(key);
    check(
      expected &&
        !declaredGroups.has(key) &&
        ['unresolved', 'restored', 'conflicting', 'insufficient'].includes(group.state) &&
        Array.isArray(group.lossEventIds) &&
        Array.isArray(group.restorationEventIds),
      'packet_report_group',
      '$.evaluation.explanation.groups',
      'Evaluation report scope is absent or duplicated',
    );
    same(
      [...group.lossEventIds].sort(),
      [...expected.losses].sort(),
      'packet_report_group',
      '$.evaluation.explanation.groups',
      'Group loss references differ from their scoped reports',
    );
    same(
      [...group.restorationEventIds].sort(),
      [...expected.restorations].sort(),
      'packet_report_group',
      '$.evaluation.explanation.groups',
      'Group restoration references differ from their scoped reports',
    );
    declaredGroups.add(key);
  }
  check(
    declaredGroups.size === groups.size &&
      events.size === reports.size + 2 &&
      !reports.has(manifest.decisionId) &&
      !reports.has(manifest.evaluationId),
    'packet_closure',
    '$.events',
    'Selected packet contains missing or unrelated event records',
  );
  const receipts = new Map();
  for (const [index, receipt] of packet.receipts.entries()) {
    const path = `$.receipts[${index}]`;
    keys(
      receipt,
      [
        'tenantId',
        'id',
        'eventId',
        'sourceId',
        'kind',
        'occurredAt',
        'receivedAt',
        'sourceRevision',
        'artifactId',
        'payload',
        'inputSubject',
      ],
      path,
    );
    const event = reportReceipts.get(receipt.id);
    check(
      event &&
        !receipts.has(receipt.id) &&
        receipt.tenantId === manifest.tenantId &&
        receipt.eventId === event.eventId &&
        receipt.sourceId === event.sourceId &&
        receipt.kind === event.type &&
        receipt.artifactId === event.artifactId &&
        receipt.sourceRevision === null &&
        receipt.receivedAt === event.receivedAt,
      'packet_receipt',
      path,
      'Receipt differs from its selected report event',
    );
    time(receipt.occurredAt, path);
    check(
      Date.parse(receipt.occurredAt) === Date.parse(event.occurredAt),
      'packet_receipt',
      path,
      'Receipt occurrence differs from its selected report',
    );
    same(
      receipt.payload,
      event.payload.payload,
      'packet_receipt',
      path,
      'Receipt payload differs from its selected report',
    );
    same(
      receipt.inputSubject,
      event.payload.subject,
      'packet_receipt',
      path,
      'Receipt target differs from its selected report',
    );
    receipts.set(receipt.id, receipt);
  }
  const originals = new Set([...reportReceipts.values()].map((event) => event.artifactId));
  check(
    receipts.size === reports.size &&
      artifacts.size === originals.size &&
      [...artifacts.keys()].every((artifactId) => originals.has(artifactId)),
    'packet_closure',
    '$',
    'Packet has missing or unrelated receipts or originals',
  );
  return { reports, receipts };
}

export function verifyDecisionPacket(packet, { expectedManifestDigest } = {}) {
  check(
    hash(expectedManifestDigest),
    'packet_anchor_required',
    '$.manifest',
    'An independently retained expected manifest digest is required',
  );
  keys(packet, ['format', 'manifest', 'manifestDigest', 'events', 'receipts', 'artifacts'], '$');
  check(
    Array.isArray(packet.events) &&
      packet.events.length <= DECISION_PACKET_LIMITS.maxEvents &&
      Array.isArray(packet.receipts) &&
      packet.receipts.length <= DECISION_PACKET_LIMITS.maxReceipts &&
      Array.isArray(packet.artifacts) &&
      packet.artifacts.length <= DECISION_PACKET_LIMITS.maxArtifacts,
    'packet_bound',
    '$',
    'Packet exceeds its selected record bounds',
  );
  preflightRecords(packet);
  boundedPacket(packet);
  const manifest = packet.manifest;
  keys(
    manifest,
    [
      'packetId',
      'tenantId',
      'flightId',
      'decisionId',
      'evaluationId',
      'findingId',
      'issuedBy',
      'issuedAt',
      'format',
      'scope',
      'selection',
      'historicalActorPolicy',
      'dependencyManifest',
      'inventory',
      'counts',
      'limits',
      'limitations',
    ],
    '$.manifest',
  );
  check(
    packet.format === DECISION_PACKET_FORMAT &&
      manifest.format === packet.format &&
      manifest.scope === SCOPE &&
      manifest.selection === SELECTION,
    'packet_format',
    '$.manifest',
    'Unsupported selected packet format or scope',
  );
  check(
    ['packetId', 'tenantId', 'flightId', 'decisionId', 'evaluationId', 'findingId', 'issuedBy'].every((field) =>
      id(manifest[field]),
    ) && manifest.decisionId !== manifest.evaluationId,
    'packet_selection',
    '$.manifest',
    'Selected packet identities are invalid',
  );
  time(manifest.issuedAt, '$.manifest.issuedAt');
  same(
    manifest.historicalActorPolicy,
    { status: 'not_retained' },
    'packet_policy',
    '$.manifest',
    'Historical actor authority cannot be reconstructed',
  );
  same(
    manifest.dependencyManifest,
    { status: 'not_retained' },
    'packet_policy',
    '$.manifest',
    'Historical dependency manifest cannot be reconstructed',
  );
  same(
    manifest.limits,
    DECISION_PACKET_LIMITS,
    'packet_limits',
    '$.manifest.limits',
    'Packet limits differ from the fixed selection policy',
  );
  same(
    manifest.limitations,
    DECISION_PACKET_LIMITATIONS,
    'packet_limitations',
    '$.manifest.limitations',
    'Packet must retain the exact versioned limitations',
  );
  const manifestDigest = canonicalDigest(manifest);
  check(
    hash(packet.manifestDigest) &&
      packet.manifestDigest === manifestDigest &&
      manifestDigest === expectedManifestDigest,
    'packet_anchor',
    '$.manifest',
    'Manifest differs from its independently retained digest',
  );
  const events = readEvents(packet, manifest);
  const { artifacts, artifactBytes } = readArtifacts(packet, manifest);
  const selected = selectedBasis(manifest, events);
  const { receipts } = reportClosure(packet, manifest, events, artifacts, selected);
  const inventory = new Map();
  check(
    Array.isArray(manifest.inventory) && manifest.inventory.length === events.size + receipts.size + artifacts.size,
    'packet_inventory',
    '$.manifest.inventory',
    'Inventory does not describe the exact selected records',
  );
  for (const item of manifest.inventory) {
    keys(item, ['kind', 'id', 'digest', 'reason'], '$.manifest.inventory');
    const key = canonicalize([item.kind, item.id]);
    check(
      id(item.id) && hash(item.digest) && !inventory.has(key),
      'packet_inventory',
      '$.manifest.inventory',
      'Inventory identity is invalid or duplicated',
    );
    let record;
    let reason;
    if (item.kind === 'event') {
      record = events.get(item.id)?.entry;
      reason =
        item.id === manifest.decisionId
          ? 'selected_decision'
          : item.id === manifest.evaluationId
            ? 'selected_evaluation'
            : 'evaluation_report';
    } else if (item.kind === 'receipt') {
      record = receipts.get(item.id);
      reason = 'report_receipt';
    } else if (item.kind === 'artifact') {
      record = artifacts.get(item.id);
      reason = 'report_original';
    }
    check(
      record && item.reason === reason && item.digest === canonicalDigest(record),
      'packet_inventory',
      '$.manifest.inventory',
      'Inventory digest or reason differs from its complete selected record',
    );
    inventory.set(key, item);
  }
  const counts = { events: events.size, receipts: receipts.size, artifacts: artifacts.size, artifactBytes };
  same(
    manifest.counts,
    counts,
    'packet_counts',
    '$.manifest.counts',
    'Packet counts differ from the exact selected records',
  );
  return {
    status: 'verified',
    format: DECISION_PACKET_FORMAT,
    scope: SCOPE,
    selection: SELECTION,
    tenantId: manifest.tenantId,
    flightId: manifest.flightId,
    decisionId: manifest.decisionId,
    evaluationId: manifest.evaluationId,
    findingId: manifest.findingId,
    manifestDigest,
    counts,
    limitations: [...DECISION_PACKET_LIMITATIONS],
  };
}
