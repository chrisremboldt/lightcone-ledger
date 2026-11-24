import {
  BundleVerificationError,
  canonicalDigest,
  canonicalize,
  entryHash,
  parseStrictJson,
  requireValue,
  sequence,
  sha256,
} from './integrity.mjs';

// Verifies a ledger.finding-packet.1 or .2 packet: one finding from any rule about any subject. Every check follows the
// records' references; nothing here depends on which rule, pack or observation type produced the finding. Version 2
// also carries original source bytes, each checked against the digest and length its receipt's source names.
export { BundleVerificationError, parseStrictJson } from './integrity.mjs';
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
});
export const FINDING_PACKET_LIMITATIONS = Object.freeze([
  'This packet contains one finding, its evaluations, the records they read and the decisions recorded about it; it is not a complete journal prefix, a full subject history or a whole-tenant export.',
  'Inventory digests commit complete selected records; included journal framing does not prove journal membership or complete-prefix continuity.',
  'Source originals are identified by their SHA-256 digest, length and content type; their bytes are not included.',
  "Corrections are those recorded within each evaluation's input cut for observations its reads could select; corrections recorded later are not included.",
  'This packet does not replay the evaluator, its check kind or any projection, and does not reconstruct a historical display.',
  'Evidence states and outcomes say what the evidence supported and what needed a person; they are not a determination that any requirement is met. A named person with the authority decides.',
  "The manifest digest must be retained independently; this packet is not externally timestamped, anchored or a person's electronic signature.",
]);
export const FINDING_PACKET_V2_LIMITS = Object.freeze({ ...FINDING_PACKET_LIMITS, maxOriginalBytes: 1048576 });
export const FINDING_PACKET_V2_LIMITATIONS = Object.freeze(
  FINDING_PACKET_LIMITATIONS.map((limitation) =>
    limitation.startsWith('Source originals')
      ? 'Source originals are included as their exact bytes, each checked against its SHA-256 digest and length, up to the packet bound; a source left out to keep within the bound is identified by its digest, length and content type only, and the manifest lists it.'
      : limitation,
  ),
);
/** What this verifier cannot establish from the packet alone; reported with every result. */
export const FINDING_PACKET_NOT_CHECKED = Object.freeze([
  'Source original bytes are not in the packet; each source is checked only as the digest, length and content type its receipt links to.',
  'Journal membership and complete-prefix continuity: only the links between included consecutive entries of a stream are checked.',
  'Complete selection: the packet cannot show that no other record exists for the finding.',
  'The evaluator, its check kind and any projection are not replayed; outcomes and evidence states are checked as recorded.',
  "A rule's digest is checked against the adopted pack that lists it, not recomputed from the rule's content.",
  'Correction, treatment and hazard decision events are checked for presence, position and what they name, not for the rest of their content.',
]);
export const FINDING_PACKET_V2_NOT_CHECKED = Object.freeze([
  'A source whose original bytes were left out to keep within the bound is checked only as the digest, length and content type its receipt links to; the result lists each one.',
  'Carried original bytes are checked against their digest and length only; they are not parsed or compared with the observation recorded from them.',
  ...FINDING_PACKET_NOT_CHECKED.slice(1),
]);
const NO_ANCHOR =
  'No expected manifest digest was given: only the internal consistency of the packet was checked, not that it is the packet that was issued.';
const ENCODING = 'ledger.v6.sha256.jcs.1';
const MODES = ['shadow', 'active'];
const CORRECTION_KINDS = ['replacement', 'withdrawal', 'subject_resolution'];
const EVENT_REASONS = [
  'finding_evaluation',
  'evaluation_adoption',
  'read_observation',
  'corrected_observation',
  'observation_correction',
  'finding_treatment',
  'hazard_opening',
  'hazard_assessment',
  'hazard_acceptance',
];
const ITEM_REASONS = { receipt: 'observation_receipt', artifact: 'observation_source', origin: 'hazard_origin' };
const DIGEST_ONLY = 'observation_source_digest_only';
const leftOutStatement = (count) =>
  `The original bytes of ${count} ${count === 1 ? 'source were' : 'sources were'} left out to keep this packet within its size bound, largest first; each is identified by its SHA-256 digest, length and content type only.`;
/** What differs between the two versions of the format. */
const PROFILES = {
  [FINDING_PACKET_FORMAT]: {
    format: FINDING_PACKET_FORMAT,
    carriesOriginals: false,
    limits: FINDING_PACKET_LIMITS,
    limitations: FINDING_PACKET_LIMITATIONS,
    notChecked: FINDING_PACKET_NOT_CHECKED,
  },
  [FINDING_PACKET_V2_FORMAT]: {
    format: FINDING_PACKET_V2_FORMAT,
    carriesOriginals: true,
    limits: FINDING_PACKET_V2_LIMITS,
    limitations: FINDING_PACKET_V2_LIMITATIONS,
    notChecked: FINDING_PACKET_V2_NOT_CHECKED,
  },
};
const STATEMENTS = {
  shadow:
    'The rule behind this finding was adopted in shadow. Shadow findings are recorded and labelled, and are not counted in what a person attests to.',
  someShadow:
    'Some evaluations in this packet ran while the rule was adopted in shadow; each evaluation states its mode.',
  proposed: 'The rule text is proposed text that is not in force. It is included as written so a person can review it.',
  always:
    'This packet records what the evidence supported and what people decided. It does not determine whether any requirement is met.',
};
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
const version = (value) => Number.isSafeInteger(value) && value >= 1;
const id = (value) => typeof value === 'string' && value.length > 0 && value.length <= 200;
const nullableId = (value) => value === null || id(value);
const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const key = (value) => typeof value === 'string' && value.length > 0 && value.length <= 1000;
const modeOf = (holder) => holder.mode ?? 'active';

function shape(condition, path, message = 'The value differs from the finding packet format') {
  check(condition, 'packet_shape', path, message);
}
function fields(value, required, path, optional = []) {
  shape(
    object(value) &&
      required.every((name) => Object.hasOwn(value, name)) &&
      Object.keys(value).every((name) => required.includes(name) || optional.includes(name)),
    path,
    'The fields differ from the finding packet format',
  );
}
function list(value, path, max, min = 0) {
  shape(
    Array.isArray(value) && value.length >= min && value.length <= max,
    path,
    `Expected a list of ${min} to ${max} items`,
  );
  return value;
}
function isTime(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 19) === value.slice(0, 19)
  );
}
function time(value, path, nullable = false) {
  shape((nullable && value === null) || isTime(value), path, 'Expected a UTC timestamp');
}

/** The one string for a subject reference, as Ledger keys subjects: ledger/kind/id or source/sourceId/kind/id. */
export function subjectKeyOf(subject) {
  const part = encodeURIComponent;
  return subject.scope === 'ledger'
    ? `ledger/${subject.kind}/${part(subject.id)}`
    : `source/${part(subject.sourceId)}/${subject.kind}/${part(subject.id)}`;
}
function subjectShape(subject, path) {
  fields(subject, ['scope', 'kind', 'id'], path, ['sourceId']);
  shape(
    id(subject.kind) &&
      id(subject.id) &&
      ((subject.scope === 'ledger' && subject.sourceId === undefined) ||
        (subject.scope === 'source' && id(subject.sourceId))),
    path,
    'The subject reference is invalid',
  );
}

// (a) Shape: every field of the packet and its manifest as the format declares it.
function findingShape(finding, path) {
  const names = ['id', 'packId', 'ruleId', 'initialEvaluationId', 'latestEvaluationId'];
  fields(finding, [...names, 'subject', 'subjectKey', 'openedAt', 'status'], path);
  shape(names.every((name) => id(finding[name])) && typeof finding.status === 'string', path);
  subjectShape(finding.subject, `${path}.subject`);
  shape(
    key(finding.subjectKey) && finding.subjectKey === subjectKeyOf(finding.subject),
    `${path}.subjectKey`,
    'The subject key is not the key of the finding subject',
  );
  time(finding.openedAt, `${path}.openedAt`);
}
function evaluationShape(evaluation, path) {
  const names = ['id', 'adoptionId', 'ruleSourceKind'];
  fields(
    evaluation,
    [
      ...names,
      'digest',
      'recordedAt',
      'mode',
      'outcome',
      'evidenceState',
      'observations',
      'corrections',
      'subjectState',
    ],
    path,
  );
  shape(
    names.every((name) => id(evaluation[name])) &&
      hash(evaluation.digest) &&
      MODES.includes(evaluation.mode) &&
      typeof evaluation.outcome === 'string' &&
      typeof evaluation.evidenceState === 'string',
    path,
  );
  time(evaluation.recordedAt, `${path}.recordedAt`);
  list(evaluation.observations, `${path}.observations`, FINDING_PACKET_LIMITS.maxEvents).forEach((row, index) => {
    const at = `${path}.observations[${index}]`;
    fields(row, ['observationId', 'eventId', 'receiptId', 'artifactId', 'replacesObservationId'], at);
    shape(
      ['observationId', 'eventId', 'receiptId', 'artifactId'].every((name) => id(row[name])) &&
        nullableId(row.replacesObservationId),
      at,
    );
  });
  list(evaluation.corrections, `${path}.corrections`, FINDING_PACKET_LIMITS.maxEvents).forEach((item, index) => {
    const at = `${path}.corrections[${index}]`;
    fields(item, ['kind', 'eventId', 'observationId'], at);
    shape(CORRECTION_KINDS.includes(item.kind) && id(item.eventId) && id(item.observationId), at);
  });
  const state = evaluation.subjectState;
  if (state !== null) {
    fields(state, ['name', 'kind', 'revision', 'digest'], `${path}.subjectState`);
    shape(
      id(state.name) && id(state.kind) && (state.revision === null || hash(state.revision)) && hash(state.digest),
      `${path}.subjectState`,
    );
  }
}
function decisionsShape(decisions, path) {
  fields(decisions, ['treatments', 'hazards'], path);
  list(decisions.treatments, `${path}.treatments`, FINDING_PACKET_LIMITS.maxEvents).forEach((item, index) => {
    fields(item, ['id', 'evaluationId', 'action'], `${path}.treatments[${index}]`);
    shape(id(item.id) && id(item.evaluationId) && typeof item.action === 'string', `${path}.treatments[${index}]`);
  });
  list(decisions.hazards, `${path}.hazards`, FINDING_PACKET_LIMITS.maxHazards).forEach((item, index) => {
    const at = `${path}.hazards[${index}]`;
    fields(item, ['recordId', 'openingEventId', 'originDigest', 'evaluationId', 'assessmentIds', 'acceptanceIds'], at);
    shape(id(item.recordId) && id(item.openingEventId) && hash(item.originDigest) && id(item.evaluationId), at);
    for (const name of ['assessmentIds', 'acceptanceIds'])
      shape(list(item[name], `${at}.${name}`, FINDING_PACKET_LIMITS.maxEvents).every(id), `${at}.${name}`);
  });
}
function countsShape(counts, path, profile) {
  const { maxEvaluations, maxEvents, maxReceipts, maxArtifacts, maxHazards } = FINDING_PACKET_LIMITS;
  const bounds = {
    evaluations: [1, maxEvaluations],
    events: [2, maxEvents],
    receipts: [0, maxReceipts],
    artifacts: [0, maxArtifacts],
    hazards: [0, maxHazards],
    ...(profile.carriesOriginals
      ? { originalBytes: [0, profile.limits.maxOriginalBytes], leftOutOriginals: [0, maxArtifacts] }
      : {}),
  };
  fields(counts, Object.keys(bounds), path);
  shape(
    Object.entries(bounds).every(
      ([name, [min, max]]) => integer(counts[name]) && counts[name] >= min && counts[name] <= max,
    ),
    path,
  );
}
function manifestShape(manifest, profile) {
  const path = '$.manifest';
  fields(
    manifest,
    [
      'format',
      'packetId',
      'tenantId',
      'issuedBy',
      'issuedAt',
      'finding',
      'statements',
      'evaluations',
      'adoptions',
      'decisions',
      'inventory',
      'counts',
      'limits',
      'limitations',
      ...(profile.carriesOriginals ? ['leftOutOriginals'] : []),
    ],
    path,
  );
  check(manifest.format === profile.format, 'packet_format', `${path}.format`, 'Unsupported packet format');
  shape(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(manifest.packetId),
    `${path}.packetId`,
    'The packet id is not a UUID',
  );
  shape(id(manifest.tenantId) && id(manifest.issuedBy), path);
  time(manifest.issuedAt, `${path}.issuedAt`);
  findingShape(manifest.finding, `${path}.finding`);
  shape(
    list(manifest.statements, `${path}.statements`, 16).every((item) => typeof item === 'string'),
    `${path}.statements`,
  );
  list(manifest.evaluations, `${path}.evaluations`, FINDING_PACKET_LIMITS.maxEvaluations, 1).forEach((item, index) =>
    evaluationShape(item, `${path}.evaluations[${index}]`),
  );
  list(manifest.adoptions, `${path}.adoptions`, FINDING_PACKET_LIMITS.maxEvaluations).forEach((item, index) => {
    const at = `${path}.adoptions[${index}]`;
    fields(item, ['id', 'digest', 'mode', 'packId', 'packVersion', 'packDigest'], at);
    shape(
      id(item.id) &&
        hash(item.digest) &&
        MODES.includes(item.mode) &&
        id(item.packId) &&
        version(item.packVersion) &&
        hash(item.packDigest),
      at,
    );
  });
  decisionsShape(manifest.decisions, `${path}.decisions`);
  const inventoryBound =
    FINDING_PACKET_LIMITS.maxEvents +
    FINDING_PACKET_LIMITS.maxReceipts +
    FINDING_PACKET_LIMITS.maxArtifacts +
    FINDING_PACKET_LIMITS.maxHazards;
  list(manifest.inventory, `${path}.inventory`, inventoryBound, 2).forEach((item, index) => {
    const at = `${path}.inventory[${index}]`;
    fields(item, ['kind', 'id', 'digest', 'reason'], at);
    shape(
      id(item.id) &&
        hash(item.digest) &&
        (item.kind === 'event'
          ? EVENT_REASONS.includes(item.reason)
          : ITEM_REASONS[item.kind] === item.reason ||
            (profile.carriesOriginals && item.kind === 'artifact' && item.reason === DIGEST_ONLY)),
      at,
      'The inventory entry has an unknown kind or reason',
    );
  });
  if (profile.carriesOriginals)
    shape(
      list(manifest.leftOutOriginals, `${path}.leftOutOriginals`, FINDING_PACKET_LIMITS.maxArtifacts).every(id),
      `${path}.leftOutOriginals`,
    );
  countsShape(manifest.counts, `${path}.counts`, profile);
  same(manifest.limits, profile.limits, 'packet_limits', `${path}.limits`, 'The limits differ from the format');
  same(
    manifest.limitations,
    profile.limitations,
    'packet_limitations',
    `${path}.limitations`,
    'The limitations differ from the exact wording of the format',
  );
}
function originShape(item, path) {
  fields(item, ['recordId', 'origin'], path);
  shape(id(item.recordId), `${path}.recordId`);
  const origin = item.origin;
  const at = `${path}.origin`;
  fields(
    origin,
    [
      'kind',
      'findingId',
      'findingKind',
      'subject',
      'subjectKey',
      'evaluationId',
      'evaluationDigest',
      'evaluationRecordedAt',
      'rule',
    ],
    at,
  );
  shape(
    origin.kind === 'finding' &&
      id(origin.findingId) &&
      id(origin.findingKind) &&
      key(origin.subjectKey) &&
      id(origin.evaluationId) &&
      hash(origin.evaluationDigest),
    at,
  );
  subjectShape(origin.subject, `${at}.subject`);
  time(origin.evaluationRecordedAt, `${at}.evaluationRecordedAt`);
  const rule = origin.rule;
  fields(
    rule,
    ['packId', 'packVersion', 'ruleId', 'ruleVersion', 'ruleDigest', 'bindingId', 'bindingVersion', 'title'],
    `${at}.rule`,
  );
  shape(
    nullableId(rule.packId) &&
      (rule.packVersion === null || version(rule.packVersion)) &&
      id(rule.ruleId) &&
      integer(rule.ruleVersion) &&
      (rule.ruleDigest === null || hash(rule.ruleDigest)) &&
      nullableId(rule.bindingId) &&
      (rule.bindingVersion === null || version(rule.bindingVersion)) &&
      typeof rule.title === 'string',
    `${at}.rule`,
  );
}
function packetShape(packet, profile) {
  fields(packet, ['format', 'manifest', 'manifestDigest', 'events', 'receipts', 'artifacts', 'origins'], '$');
  const limits = profile.limits;
  list(packet.events, '$.events', limits.maxEvents, 2).forEach((entry, index) => {
    const path = `$.events[${index}]`;
    fields(entry, ['canonicalEnvelope', 'envelopeDigest', 'previousHash', 'entryHash', 'encodingVersion'], path);
    shape(
      typeof entry.canonicalEnvelope === 'string' &&
        Buffer.byteLength(entry.canonicalEnvelope, 'utf8') <= limits.maxEnvelopeBytes &&
        typeof entry.envelopeDigest === 'string' &&
        typeof entry.previousHash === 'string' &&
        typeof entry.entryHash === 'string' &&
        typeof entry.encodingVersion === 'string',
      path,
      'The journal entry fields are invalid or exceed their bound',
    );
  });
  list(packet.receipts, '$.receipts', limits.maxReceipts).forEach((receipt, index) => {
    const path = `$.receipts[${index}]`;
    const names = ['tenantId', 'id', 'eventId', 'sourceId'];
    fields(
      receipt,
      [...names, 'kind', 'occurredAt', 'receivedAt', 'sourceRevision', 'artifactId', 'payload', 'inputSubject'],
      path,
    );
    shape(
      names.every((name) => id(receipt[name])) &&
        typeof receipt.kind === 'string' &&
        (receipt.sourceRevision === null || typeof receipt.sourceRevision === 'string') &&
        nullableId(receipt.artifactId) &&
        object(receipt.payload) &&
        object(receipt.inputSubject),
      path,
    );
    time(receipt.occurredAt, `${path}.occurredAt`);
    time(receipt.receivedAt, `${path}.receivedAt`);
  });
  list(packet.artifacts, '$.artifacts', limits.maxArtifacts).forEach((artifact, index) => {
    const path = `$.artifacts[${index}]`;
    const names = ['tenantId', 'id', 'sha256', 'byteLength', 'contentType'];
    fields(artifact, profile.carriesOriginals ? [...names, 'bytesBase64'] : names, path);
    shape(
      id(artifact.tenantId) &&
        id(artifact.id) &&
        hash(artifact.sha256) &&
        integer(artifact.byteLength) &&
        typeof artifact.contentType === 'string' &&
        (!profile.carriesOriginals ||
          artifact.bytesBase64 === null ||
          (typeof artifact.bytesBase64 === 'string' &&
            artifact.bytesBase64.length === 4 * Math.ceil(artifact.byteLength / 3))),
      path,
    );
  });
  list(packet.origins, '$.origins', limits.maxHazards).forEach((item, index) =>
    originShape(item, `$.origins[${index}]`),
  );
  manifestShape(packet.manifest, profile);
  check(
    Buffer.byteLength(canonicalize(packet), 'utf8') <= limits.maxPacketBytes,
    'packet_bound',
    '$',
    'The packet exceeds its byte bound',
  );
}

// (b) Events: exact canonical envelopes, recomputed digests and entry hashes, one tenant, linked stream neighbours.
function readEvents(packet, tenantId) {
  const events = new Map();
  packet.events.forEach((entry, index) => {
    const path = `$.events[${index}]`;
    const envelope = parseStrictJson(entry.canonicalEnvelope, `${path}.canonicalEnvelope`);
    fields(envelope, ENVELOPE_KEYS, `${path}.canonicalEnvelope`);
    check(
      canonicalize(envelope) === entry.canonicalEnvelope,
      'packet_envelope_bytes',
      `${path}.canonicalEnvelope`,
      'The envelope does not round-trip: it is not the exact canonical form of its content',
    );
    check(
      entry.encodingVersion === ENCODING,
      'packet_encoding',
      `${path}.encodingVersion`,
      `The entry is not encoded as ${ENCODING}`,
    );
    check(
      envelope.tenantId === tenantId,
      'packet_tenant',
      `${path}.canonicalEnvelope`,
      'The event belongs to another tenant',
    );
    shape(
      ['eventId', 'streamId', 'type', 'principalId'].every((name) => id(envelope[name])) &&
        version(envelope.schemaVersion) &&
        ['sourceId', 'sourceSessionId', 'causationId', 'artifactId'].every((name) => nullableId(envelope[name])) &&
        object(envelope.payload) &&
        isTime(envelope.receivedAt) &&
        [envelope.occurredAt, envelope.effectiveAt].every((value) => value === null || isTime(value)),
      `${path}.canonicalEnvelope`,
      'The event identity, attribution, times or payload are invalid',
    );
    const position = sequence(envelope.sequence, `${path}.canonicalEnvelope`);
    check(
      sha256(entry.canonicalEnvelope) === entry.envelopeDigest,
      'packet_entry',
      `${path}.envelopeDigest`,
      'The envelope digest does not recompute from the envelope',
    );
    check(
      position === 1n ? entry.previousHash === '' : hash(entry.previousHash),
      'packet_entry',
      `${path}.previousHash`,
      'The previous hash is invalid for the entry position',
    );
    check(
      entryHash(tenantId, envelope.streamId, position, entry.previousHash, entry.envelopeDigest) === entry.entryHash,
      'packet_entry',
      `${path}.entryHash`,
      'The entry hash does not recompute from the entry',
    );
    check(!events.has(envelope.eventId), 'packet_duplicate', path, 'The event is included twice');
    events.set(envelope.eventId, { entry, envelope, path, position });
  });
  const byPosition = new Map();
  for (const event of events.values()) {
    const at = canonicalize([event.envelope.streamId, String(event.position)]);
    check(!byPosition.has(at), 'packet_chain', event.path, 'Two included events claim one stream position');
    byPosition.set(at, event);
  }
  for (const event of events.values()) {
    const prior = byPosition.get(canonicalize([event.envelope.streamId, String(event.position - 1n)]));
    check(
      !prior || event.entry.previousHash === prior.entry.entryHash,
      'packet_chain',
      `${event.path}.previousHash`,
      'The entry does not link to the included entry before it in its stream',
    );
  }
  return events;
}
function requireEvent(events, eventId, code, path, what) {
  const event = events.get(eventId);
  check(event, code, path, `The ${what} event ${eventId} is not in the packet`);
  return event;
}
function withinCut(event, cut) {
  const streams = cut.streams;
  const limit = Object.hasOwn(streams, event.envelope.streamId) ? streams[event.envelope.streamId] : 0;
  return event.position <= BigInt(limit);
}

// (d, h) Evaluations: each manifest summary is its retained evaluation record, about the finding's subject and rule.
function recordedEvaluation(event, path) {
  const evaluation = event.envelope.payload.evaluation;
  check(
    event.envelope.type === 'rule-evaluation.recorded' &&
      object(evaluation) &&
      evaluation.id === event.envelope.eventId,
    'packet_evaluation',
    path,
    'The event is not a recorded rule evaluation',
  );
  const record = { ...evaluation, recordedAt: event.envelope.receivedAt };
  const { pack, rule, adoption, inputCut, subjectState } = record;
  check(
    object(pack) &&
      id(pack.id) &&
      object(rule) &&
      id(rule.id) &&
      object(rule.source) &&
      object(adoption) &&
      id(adoption.id) &&
      (adoption.mode === undefined || MODES.includes(adoption.mode)) &&
      Array.isArray(record.inputs) &&
      record.inputs.every((input) => object(input) && Array.isArray(input.observationIds)) &&
      Array.isArray(record.evidence) &&
      record.evidence.every(object) &&
      object(inputCut) &&
      object(inputCut.streams) &&
      Object.values(inputCut.streams).every(integer) &&
      (subjectState === undefined || object(subjectState)),
    'packet_evaluation',
    path,
    'The recorded evaluation lacks a field the packet relies on',
  );
  return record;
}
function checkSubjectState(summary, record, path) {
  const state = record.subjectState;
  if (state === undefined) {
    check(summary.subjectState === null, 'packet_subject_state', path, 'The evaluation recorded no subject state');
    return;
  }
  check(
    summary.subjectState !== null &&
      summary.subjectState.name === state.name &&
      summary.subjectState.kind === state.kind &&
      summary.subjectState.revision === state.revision &&
      summary.subjectState.digest === canonicalDigest(state.state ?? null),
    'packet_subject_state',
    path,
    'The subject-state digest or identity differs from the state the evaluation recorded',
  );
}
function checkEvaluations(manifest, events) {
  const { finding } = manifest;
  const evaluations = new Map();
  manifest.evaluations.forEach((summary, index) => {
    const path = `$.manifest.evaluations[${index}]`;
    check(!evaluations.has(summary.id), 'packet_evaluation', path, 'The evaluation is listed twice');
    const event = requireEvent(events, summary.id, 'packet_evaluation', path, 'evaluation');
    const record = recordedEvaluation(event, path);
    check(
      canonicalDigest(record) === summary.digest && summary.recordedAt === record.recordedAt,
      'packet_evaluation',
      `${path}.digest`,
      'The evaluation digest is not the digest of its record: the evaluation in its event payload plus recordedAt',
    );
    check(
      record.subjectKey === finding.subjectKey &&
        record.pack.id === finding.packId &&
        record.rule.id === finding.ruleId,
      'packet_evaluation',
      path,
      'The evaluation is about another subject, pack or rule than the finding',
    );
    check(
      summary.mode === modeOf(record.adoption) &&
        summary.adoptionId === record.adoption.id &&
        summary.ruleSourceKind === record.rule.source.kind &&
        summary.outcome === record.outcome &&
        summary.evidenceState === record.evidenceState,
      'packet_evaluation',
      path,
      'The evaluation summary differs from its record',
    );
    checkSubjectState(summary, record, `${path}.subjectState`);
    evaluations.set(summary.id, { summary, record, path });
  });
  check(
    manifest.evaluations[0].id === finding.initialEvaluationId &&
      manifest.evaluations.at(-1).id === finding.latestEvaluationId,
    'packet_evaluation',
    '$.manifest.evaluations',
    "The evaluations do not run from the finding's initial evaluation to its latest",
  );
  return evaluations;
}

// (e) Adoptions: each is a retained pack adoption whose pack recomputes and lists the evaluated rule.
function checkAdoptions(manifest, events, evaluations) {
  const adoptions = new Map();
  manifest.adoptions.forEach((summary, index) => {
    const path = `$.manifest.adoptions[${index}]`;
    check(!adoptions.has(summary.id), 'packet_adoption', path, 'The adoption is listed twice');
    const event = requireEvent(events, summary.id, 'packet_adoption', path, 'adoption');
    const acceptance = event.envelope.payload.acceptance;
    check(
      event.envelope.type === 'rule-pack.adopt' &&
        object(acceptance) &&
        object(acceptance.pack) &&
        Array.isArray(acceptance.pack.leaves),
      'packet_adoption',
      path,
      'The event is not a pack adoption',
    );
    const record = { ...acceptance, id: event.envelope.eventId, acceptedAt: event.envelope.receivedAt };
    check(
      canonicalDigest(record) === summary.digest,
      'packet_adoption',
      `${path}.digest`,
      'The adoption digest is not the digest of its record',
    );
    const { digest, ...content } = acceptance.pack;
    check(
      hash(digest) && canonicalDigest(content) === digest,
      'packet_adoption',
      `${path}.packDigest`,
      'The pack digest does not recompute from the adopted pack',
    );
    check(
      summary.packDigest === digest &&
        summary.packId === acceptance.pack.packId &&
        summary.packVersion === acceptance.pack.version &&
        summary.mode === modeOf(acceptance),
      'packet_adoption',
      path,
      'The adoption summary differs from its record',
    );
    adoptions.set(summary.id, acceptance);
  });
  const named = new Set([...evaluations.values()].map(({ record }) => record.adoption.id));
  check(
    named.size === adoptions.size && [...named].every((adoptionId) => adoptions.has(adoptionId)),
    'packet_adoption',
    '$.manifest.adoptions',
    'The adoptions listed differ from those the evaluations name',
  );
  for (const { record, path } of evaluations.values()) {
    const adoption = adoptions.get(record.adoption.id);
    const leaf = adoption.pack.leaves.find(
      (item) => object(item) && item.id === record.rule.id && item.version === record.rule.version,
    );
    check(
      adoption.pack.packId === record.pack.id &&
        adoption.pack.version === record.pack.version &&
        adoption.pack.digest === record.pack.digest &&
        leaf?.digest === record.rule.digest &&
        adoption.acceptedRevision === record.adoption.acceptedRevision &&
        adoption.organizationId === record.organizationId &&
        modeOf(adoption) === modeOf(record.adoption),
      'packet_adoption',
      path,
      "The evaluation's pack, rule digest, accepted revision, organization or mode differs from its adoption",
    );
  }
}

// (f, g) Reads and corrections: each read links event, receipt and source, and lies within the input cut.
function checkReads(packet, events, evaluations) {
  const receipts = new Map();
  packet.receipts.forEach((receipt, index) => {
    check(!receipts.has(receipt.id), 'packet_inventory', `$.receipts[${index}]`, 'The receipt is included twice');
    receipts.set(receipt.id, receipt);
  });
  const artifacts = new Map();
  packet.artifacts.forEach((artifact, index) => {
    check(!artifacts.has(artifact.id), 'packet_inventory', `$.artifacts[${index}]`, 'The source is included twice');
    artifacts.set(artifact.id, artifact);
  });
  for (const { summary, record, path } of evaluations.values()) {
    const read = [...new Set(record.inputs.flatMap((input) => input.observationIds))];
    same(
      summary.observations.map((row) => row.observationId),
      read,
      'packet_observation',
      `${path}.observations`,
      'The observations listed differ from those the evaluation read',
    );
    summary.observations.forEach((row, index) => {
      const at = `${path}.observations[${index}]`;
      const event = requireEvent(events, row.eventId, 'packet_observation', at, 'observation');
      const receipt = receipts.get(row.receiptId);
      check(receipt, 'packet_observation', at, `The receipt ${row.receiptId} is not in the packet`);
      check(
        artifacts.has(row.artifactId),
        'packet_observation',
        at,
        `The source ${row.artifactId} is not in the packet`,
      );
      check(
        receipt.eventId === row.eventId &&
          receipt.artifactId === row.artifactId &&
          event.envelope.artifactId === row.artifactId,
        'packet_observation',
        at,
        'The observation event, its receipt and its source do not link to each other',
      );
      check(
        withinCut(event, record.inputCut),
        'packet_observation',
        at,
        "The observation event lies outside the evaluation's input cut",
      );
    });
    record.evidence.forEach((item, index) => {
      const row = summary.observations.find((candidate) => candidate.observationId === item.observationId);
      check(
        row && row.eventId === item.eventId && row.receiptId === item.receiptId,
        'packet_observation',
        `${path}.observations`,
        `Evidence item ${index} of the evaluation names an observation it did not read`,
      );
    });
  }
  return { receipts, artifacts };
}
/**
 * The event of a corrected observation: the read that names it, otherwise the observation's own event. Ledger gives
 * an observation the id of the event that recorded it, and the manifest names an unread corrected observation by id only.
 */
function correctedEventId(evaluations, observationId) {
  for (const { summary } of evaluations.values()) {
    const row = summary.observations.find((item) => item.observationId === observationId);
    if (row) return row.eventId;
  }
  return observationId;
}
function checkCorrections(events, evaluations) {
  for (const { summary, record, path } of evaluations.values())
    summary.corrections.forEach((correction, index) => {
      const at = `${path}.corrections[${index}]`;
      const event = requireEvent(events, correction.eventId, 'packet_correction', at, `${correction.kind}`);
      check(
        withinCut(event, record.inputCut),
        'packet_correction',
        at,
        "The correction event lies outside the evaluation's input cut",
      );
      requireEvent(
        events,
        correctedEventId(evaluations, correction.observationId),
        'packet_correction',
        at,
        'corrected observation',
      );
    });
}
function checkTreatments(manifest, events, evaluations) {
  const seen = new Set();
  manifest.decisions.treatments.forEach((treatment, index) => {
    const path = `$.manifest.decisions.treatments[${index}]`;
    check(
      !seen.has(treatment.id) && evaluations.has(treatment.evaluationId),
      'packet_treatment',
      path,
      'The treatment is listed twice or names an evaluation outside the packet',
    );
    requireEvent(events, treatment.id, 'packet_treatment', path, 'treatment');
    seen.add(treatment.id);
  });
}

// (i) Hazards: each origin pins one of the packet's evaluations; its opening and decisions are for that hazard.
function checkHazard(hazard, path, packet, finding, events, evaluations) {
  const item = packet.origins.find((candidate) => candidate.recordId === hazard.recordId);
  check(item, 'packet_hazard', path, `The origin of hazard ${hazard.recordId} is not in the packet`);
  check(
    canonicalDigest(item) === hazard.originDigest,
    'packet_hazard',
    `${path}.originDigest`,
    'The origin digest does not match the included origin',
  );
  const origin = item.origin;
  const pinned = evaluations.get(origin.evaluationId);
  check(
    origin.evaluationId === hazard.evaluationId && pinned && pinned.summary.digest === origin.evaluationDigest,
    'packet_hazard',
    path,
    "The hazard origin does not pin one of the packet's evaluations by its digest",
  );
  const { record } = pinned;
  check(
    origin.findingId === finding.id &&
      origin.subjectKey === finding.subjectKey &&
      origin.evaluationRecordedAt === record.recordedAt &&
      origin.rule.ruleId === record.rule.id &&
      origin.rule.ruleVersion === record.rule.version &&
      origin.rule.ruleDigest === record.rule.digest &&
      (origin.rule.packId === null || origin.rule.packId === record.pack.id) &&
      (origin.rule.packVersion === null || origin.rule.packVersion === record.pack.version),
    'packet_hazard',
    path,
    'The hazard origin names another finding, subject, rule or evaluation time',
  );
  const opening = requireEvent(events, hazard.openingEventId, 'packet_hazard', path, 'hazard opening').envelope;
  check(
    opening.type === 'sms.record.open' &&
      opening.payload.recordId === hazard.recordId &&
      (opening.payload.recordedOrigin === undefined ||
        canonicalize(opening.payload.recordedOrigin) === canonicalize(origin)),
    'packet_hazard',
    `${path}.openingEventId`,
    'The opening event is not the record opening of this hazard from this origin',
  );
  const decisions = [
    ...hazard.assessmentIds.map((eventId) => ['risk.assess', eventId, 'assessmentIds']),
    ...hazard.acceptanceIds.map((eventId) => ['risk.accept', eventId, 'acceptanceIds']),
  ];
  for (const [kind, eventId, field] of decisions) {
    const acceptance = requireEvent(events, eventId, 'packet_hazard', `${path}.${field}`, kind).envelope.payload
      .acceptance;
    check(
      object(acceptance) && acceptance.subjectId === hazard.recordId && acceptance.kind === kind,
      'packet_hazard',
      `${path}.${field}`,
      `Decision ${eventId} is not a ${kind} of hazard ${hazard.recordId}`,
    );
  }
}
function checkHazards(packet, manifest, events, evaluations) {
  const hazards = manifest.decisions.hazards;
  const recordIds = new Set(hazards.map((hazard) => hazard.recordId));
  const originIds = new Set(packet.origins.map((item) => item.recordId));
  check(
    recordIds.size === hazards.length &&
      originIds.size === packet.origins.length &&
      recordIds.size === originIds.size &&
      [...originIds].every((recordId) => recordIds.has(recordId)),
    'packet_hazard',
    '$.origins',
    'The hazard origins differ from the hazards listed',
  );
  hazards.forEach((hazard, index) =>
    checkHazard(hazard, `$.manifest.decisions.hazards[${index}]`, packet, manifest.finding, events, evaluations),
  );
}

// (c) Inventory: exactly the included records, each under its digest and the reason the records give it.
function eventReasons(manifest, evaluations) {
  const reasons = new Map();
  const add = (eventId, reason) => {
    if (!reasons.has(eventId)) reasons.set(eventId, reason);
  };
  const summaries = [...evaluations.values()].map(({ summary }) => summary);
  for (const summary of summaries) add(summary.id, 'finding_evaluation');
  for (const { record } of evaluations.values()) add(record.adoption.id, 'evaluation_adoption');
  for (const summary of summaries) for (const row of summary.observations) add(row.eventId, 'read_observation');
  for (const summary of summaries)
    for (const correction of summary.corrections) {
      add(correctedEventId(evaluations, correction.observationId), 'corrected_observation');
      add(correction.eventId, 'observation_correction');
    }
  for (const treatment of manifest.decisions.treatments) add(treatment.id, 'finding_treatment');
  for (const hazard of manifest.decisions.hazards) {
    add(hazard.openingEventId, 'hazard_opening');
    for (const eventId of hazard.assessmentIds) add(eventId, 'hazard_assessment');
    for (const eventId of hazard.acceptanceIds) add(eventId, 'hazard_acceptance');
  }
  return reasons;
}
function checkInventory(packet, manifest, events, evaluations, receipts, artifacts, profile) {
  const reasons = eventReasons(manifest, evaluations);
  for (const event of events.values())
    check(
      reasons.has(event.envelope.eventId),
      'packet_inventory',
      event.path,
      'The packet holds an event that no record of the finding references',
    );
  const rows = [...evaluations.values()].flatMap(({ summary }) => summary.observations);
  const readReceipts = new Set(rows.map((row) => row.receiptId));
  const readSources = new Set(rows.map((row) => row.artifactId));
  check(
    readReceipts.size === receipts.size && readSources.size === artifacts.size,
    'packet_inventory',
    '$',
    'The packet holds a receipt or source that no evaluation read',
  );
  for (const [path, item] of [
    ...packet.receipts.map((receipt, index) => [`$.receipts[${index}]`, receipt]),
    ...packet.artifacts.map((artifact, index) => [`$.artifacts[${index}]`, artifact]),
  ])
    check(item.tenantId === manifest.tenantId, 'packet_tenant', path, 'The record belongs to another tenant');
  const expected = new Map();
  const add = (kind, itemId, record, reason) =>
    expected.set(canonicalize([kind, itemId]), { digest: canonicalDigest(record), reason });
  for (const event of events.values())
    add('event', event.envelope.eventId, event.entry, reasons.get(event.envelope.eventId));
  for (const receipt of packet.receipts) add('receipt', receipt.id, receipt, ITEM_REASONS.receipt);
  for (const artifact of packet.artifacts)
    add('artifact', artifact.id, artifact, artifact.bytesBase64 === null ? DIGEST_ONLY : ITEM_REASONS.artifact);
  for (const origin of packet.origins) add('origin', origin.recordId, origin, ITEM_REASONS.origin);
  const listed = new Set();
  manifest.inventory.forEach((item, index) => {
    const path = `$.manifest.inventory[${index}]`;
    const at = canonicalize([item.kind, item.id]);
    const record = expected.get(at);
    check(
      record && !listed.has(at),
      'packet_inventory',
      path,
      'The inventory lists a record that is not in the packet, or lists it twice',
    );
    check(record.digest === item.digest, 'packet_inventory', `${path}.digest`, 'The inventory digest does not match');
    check(record.reason === item.reason, 'packet_inventory', `${path}.reason`, 'The inventory reason does not match');
    listed.add(at);
  });
  check(
    listed.size === expected.size,
    'packet_inventory',
    '$.manifest.inventory',
    'The inventory does not list every included record',
  );
  const counts = {
    evaluations: evaluations.size,
    events: events.size,
    receipts: receipts.size,
    artifacts: artifacts.size,
    hazards: packet.origins.length,
    ...(profile.carriesOriginals
      ? {
          originalBytes: packet.artifacts.reduce(
            (sum, artifact) => sum + (artifact.bytesBase64 === null ? 0 : artifact.byteLength),
            0,
          ),
          leftOutOriginals: packet.artifacts.filter((artifact) => artifact.bytesBase64 === null).length,
        }
      : {}),
  };
  same(manifest.counts, counts, 'packet_counts', '$.manifest.counts', 'The counts differ from the included records');
  return counts;
}

// (j) Statements: the fixed plain-language wording follows the evaluations' modes and kinds of rule text.
function checkStatements(manifest, profile) {
  const evaluations = manifest.evaluations;
  const latestShadow = evaluations.at(-1).mode === 'shadow';
  const anyShadow = evaluations.some((item) => item.mode === 'shadow');
  const proposed = evaluations.some((item) => item.ruleSourceKind === 'proposed_regulation');
  const expected = [
    ...(latestShadow ? [STATEMENTS.shadow] : []),
    ...(anyShadow && !latestShadow ? [STATEMENTS.someShadow] : []),
    ...(proposed ? [STATEMENTS.proposed] : []),
    STATEMENTS.always,
    ...(profile.carriesOriginals && manifest.leftOutOriginals.length
      ? [leftOutStatement(manifest.leftOutOriginals.length)]
      : []),
  ];
  same(
    manifest.statements,
    expected,
    'packet_statements',
    '$.manifest.statements',
    'The plain-language statements do not match the adoption modes and the kinds of rule text',
  );
}

/** Strict base64: only the canonical encoding of some bytes is accepted. */
function decodeBase64(value, path) {
  const bytes = Buffer.from(value, 'base64');
  check(
    /^[A-Za-z0-9+/]*={0,2}$/.test(value) && bytes.toString('base64') === value,
    'packet_original',
    path,
    'The original bytes are not canonical base64',
  );
  return bytes;
}

// (k) Originals, version 2: each carried byte range matches the digest and length of the source its receipt names;
// bytes left out are listed, largest first, and only as many as the bound required.
function checkOriginals(packet, manifest, profile) {
  let carriedBytes = 0;
  packet.artifacts.forEach((artifact, index) => {
    if (artifact.bytesBase64 === null) return;
    const path = `$.artifacts[${index}].bytesBase64`;
    const bytes = decodeBase64(artifact.bytesBase64, path);
    check(
      bytes.byteLength === artifact.byteLength,
      'packet_original',
      path,
      `The original bytes of source ${artifact.id} differ from its recorded length`,
    );
    check(
      sha256(bytes) === artifact.sha256,
      'packet_original',
      path,
      `The original bytes of source ${artifact.id} differ from its recorded SHA-256 digest`,
    );
    carriedBytes += bytes.byteLength;
  });
  check(
    carriedBytes <= profile.limits.maxOriginalBytes,
    'packet_bound',
    '$.artifacts',
    'The carried original bytes exceed their bound',
  );
  const order = [...packet.artifacts]
    .sort((a, b) => b.byteLength - a.byteLength || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((artifact) => artifact.id);
  const omitted = packet.artifacts.filter((artifact) => artifact.bytesBase64 === null).map((artifact) => artifact.id);
  same(
    [...manifest.leftOutOriginals].sort(),
    [...omitted].sort(),
    'packet_original',
    '$.manifest.leftOutOriginals',
    'The sources listed as left out differ from those whose bytes the packet does not carry',
  );
  check(
    manifest.leftOutOriginals.every((artifactId, index) => order[index] === artifactId),
    'packet_original',
    '$.manifest.leftOutOriginals',
    'Source bytes were not left out largest first',
  );
  const byId = new Map(packet.artifacts.map((artifact) => [artifact.id, artifact]));
  return {
    carried: packet.artifacts.length - omitted.length,
    carriedBytes,
    leftOut: manifest.leftOutOriginals.map((artifactId) => {
      const { sha256: digest, byteLength, contentType } = byId.get(artifactId);
      return { artifactId, sha256: digest, byteLength, contentType };
    }),
  };
}

/**
 * Verifies a finding packet of either version. With `expectedManifestDigest`, the digest the holder kept separately, the result is
 * `verified`; without it the result is `internally_consistent` and says that authenticity was not checked.
 */
export function verifyFindingPacket(packet, { expectedManifestDigest } = {}) {
  check(
    expectedManifestDigest === undefined || hash(expectedManifestDigest),
    'packet_anchor',
    '$.manifest',
    'The expected manifest digest must be 64 lowercase hexadecimal characters',
  );
  check(
    object(packet) && Object.hasOwn(PROFILES, packet.format),
    'packet_format',
    '$.format',
    'Unsupported packet format',
  );
  const profile = PROFILES[packet.format];
  packetShape(packet, profile);
  const { manifest } = packet;
  const manifestDigest = canonicalDigest(manifest);
  check(
    packet.manifestDigest === manifestDigest,
    'packet_manifest_digest',
    '$.manifestDigest',
    'The manifest digest is not the canonical digest of the manifest',
  );
  check(
    expectedManifestDigest === undefined || manifestDigest === expectedManifestDigest,
    'packet_anchor',
    '$.manifestDigest',
    'The manifest differs from the digest kept separately: this is not the packet that was issued',
  );
  const events = readEvents(packet, manifest.tenantId);
  const originals = profile.carriesOriginals ? checkOriginals(packet, manifest, profile) : undefined;
  const evaluations = checkEvaluations(manifest, events);
  checkAdoptions(manifest, events, evaluations);
  const { receipts, artifacts } = checkReads(packet, events, evaluations);
  checkCorrections(events, evaluations);
  checkTreatments(manifest, events, evaluations);
  checkHazards(packet, manifest, events, evaluations);
  const counts = checkInventory(packet, manifest, events, evaluations, receipts, artifacts, profile);
  checkStatements(manifest, profile);
  const anchored = expectedManifestDigest !== undefined;
  return {
    status: anchored ? 'verified' : 'internally_consistent',
    format: profile.format,
    packetId: manifest.packetId,
    tenantId: manifest.tenantId,
    findingId: manifest.finding.id,
    subjectKey: manifest.finding.subjectKey,
    manifestDigest,
    authenticity: anchored
      ? { checked: true, message: 'The manifest matches the digest kept separately.' }
      : { checked: false, message: NO_ANCHOR },
    counts,
    ...(originals ? { originals } : {}),
    notChecked: [...profile.notChecked],
    limitations: [...profile.limitations],
  };
}
