import { SUBJECT_FORMAT, SUBJECT_SECTIONS, SUBJECT_LIMITATIONS, verifySubjectCommitments } from './subject.mjs';
import { COMMAND_LINK_KIND, FLIGHT_FORMAT, verifyCommandLinkReceipt, verifyFlightTarget } from './flight.mjs';
import { MISSION_KIND, verifyMissionReceipt } from './mission.mjs';
import { PINNED_CONTROLS_LIMITATION, verifyPinnedControls } from './flight-controls-seen.mjs';
import { MISSION_RELEASE_KIND, MISSION_RELEASE_LIMITATION, verifyMissionReleaseEvent } from './mission-release.mjs';
import {
  MONITORING_WINDOW_KIND,
  verifyMonitoringWindowReceipt,
  verifyMonitoringWindowReferences,
} from './monitoring-window.mjs';
import {
  COMMAND_LINK_BASELINE_KIND,
  verifyCommandLinkBaselineReceipt,
  verifyCommandLinkBaselineHistory,
} from './command-link-baseline.mjs';
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
export { BundleVerificationError, parseStrictJson } from './integrity.mjs';

const FORMAT = 'ledger.decision-evidence.1';
const INTEGRITY = 'ledger.v6.sha256.jcs.1';
const SOURCE_HASH = '037477a8af29cf06897d871391129efa670b7d9dd695d44baf775ec1cbfa46a8';
const SECTIONS = [
  'streams',
  'entries',
  'receipts',
  'artifacts',
  'decision',
  'actor',
  'cuts',
  'snapshot',
  'interpreter',
  'interpretations',
];
const CUTS = ['rendered', 'accepted', 'issuance'];
// Generic intake: any registered observation type; its receipt keeps the subjects intake resolved.
const OBSERVATION_KIND = 'observation';
const INPUT_TYPES = [
  'order.revision',
  'intent.revision',
  'flight.observation',
  'airspace.status',
  'source.observation',
  'telemetry.segment',
  OBSERVATION_KIND,
];
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
const INVENTORY_LIMITATIONS = [
  'Whole-tenant immutable evidence inventory; flightId identifies the selected decision, not a historical disclosure filter.',
  'Closure reports explicit journal causation references only; this interpretation does not rebuild thread.1 operational SQL state or the historical browser display.',
  'Source occurredAt and effectiveAt are retained claims; known-at-cut membership follows stream positions, not source timestamps.',
];
const MISSION_LIMITATION =
  'Mission revisions verify reported planned geometry, original bytes and retained intake authority only; this format does not establish applicability, flown geometry or flight release.';
const MISSION_DEPARTURE_LIMITATION =
  'Recorded departure authorizations are opaque journal inventory; this format does not verify authorization eligibility, current lease validity, resource allocation, operation fit or departure consumption.';
const MISSION_BRIEFING_LIMITATION =
  'Mission briefings and acknowledgements are opaque journal inventory; this format does not verify personal review, message delivery, operational-crew coverage, control implementation or current release/departure validity.';
const MONITORING_WINDOW_LIMITATION =
  'Monitoring windows retain reported samples, originals, intake authority and exact referenced records; the control record version and risk acceptance a window cites are safety records outside this export, so those pins are not checked here. This format does not establish current evidence completeness, observed exposure, incident counts, effectiveness rates or operational permission.';
const RUNTIME = {
  name: 'node',
  major: 24,
  moduleFormat: 'esm',
  dependencies: [],
  network: 'none',
  interpretation: 'evidence-cut.1',
  canonicalization: INTEGRITY,
};
const hash = (value, path) =>
  requireValue(
    typeof value === 'string' && /^[a-f0-9]{64}$/.test(value),
    'digest_encoding',
    path,
    'Expected a lowercase SHA-256 digest',
  );
const text = (value, path) =>
  requireValue(
    typeof value === 'string' && value.length > 0,
    'field_type',
    path,
    'Expected a nonempty identifier or text',
  );
const integer = (value, path) =>
  requireValue(Number.isSafeInteger(value) && value >= 0, 'integer_range', path, 'Expected a nonnegative safe integer');
const object = (value, path) =>
  requireValue(
    value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype,
    'section_shape',
    path,
    'Expected a JSON object',
  );
const array = (value, path) => requireValue(Array.isArray(value), 'section_shape', path, 'Expected a JSON array');
const same = (actual, expected, code, path, message) =>
  requireValue(canonicalize(actual) === canonicalize(expected), code, path, message);
function keys(value, required, path, optional = []) {
  object(value, path);
  requireValue(
    required.every((key) => Object.hasOwn(value, key)) &&
      Object.keys(value).every((key) => required.includes(key) || optional.includes(key)),
    'section_shape',
    path,
    'Section fields do not match the declared format',
  );
}
function timestamp(value, path, nullable = false) {
  if (nullable && value === null) return;
  requireValue(
    typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)),
    'time_encoding',
    path,
    'Expected a retained ISO timestamp',
  );
}
function cut(value, streamMap, path) {
  keys(value, ['streams'], path, ['basisRevision', 'principalRevision']);
  object(value.streams, `${path}.streams`);
  for (const [id, position] of Object.entries(value.streams)) {
    integer(position, `${path}.streams`);
    requireValue(
      streamMap.has(id) && BigInt(position) <= streamMap.get(id).head,
      'cut_bounds',
      path,
      'Cut references an absent stream or exceeds its captured prefix',
    );
  }
  if (value.basisRevision !== undefined) integer(value.basisRevision, `${path}.basisRevision`);
  if (value.principalRevision !== undefined) integer(value.principalRevision, `${path}.principalRevision`);
}

export function reconstructEvidenceCut(entries, inputCut, tenantId) {
  const selected = entries
    .map((entry) => ({ entry, envelope: parseStrictJson(entry.canonicalEnvelope) }))
    .filter((row) => BigInt(row.envelope.sequence) <= BigInt(inputCut.streams[row.envelope.streamId] ?? 0));
  selected.sort((left, right) => {
    const a = left.envelope;
    const b = right.envelope;
    if (a.streamId !== b.streamId) return a.streamId < b.streamId ? -1 : 1;
    return BigInt(a.sequence) < BigInt(b.sequence) ? -1 : BigInt(a.sequence) > BigInt(b.sequence) ? 1 : 0;
  });
  const events = selected.map(({ entry, envelope: value }) => ({
    eventId: value.eventId,
    streamId: value.streamId,
    sequence: value.sequence,
    type: value.type,
    principalId: value.principalId,
    sourceId: value.sourceId,
    occurredAt: value.occurredAt,
    effectiveAt: value.effectiveAt,
    receivedAt: value.receivedAt,
    causationId: value.causationId,
    artifactId: value.artifactId,
    envelopeDigest: entry.envelopeDigest,
    entryHash: entry.entryHash,
  }));
  const included = new Set(events.map((event) => event.eventId));
  const missingCausationIds = [
    ...new Set(
      events.flatMap((event) =>
        event.causationId !== null && !included.has(event.causationId) ? [event.causationId] : [],
      ),
    ),
  ].sort();
  return {
    interpretation: 'evidence-cut.1',
    tenantId,
    cut: inputCut,
    events,
    missingCausationIds,
    limitations: [...INVENTORY_LIMITATIONS],
  };
}

export function verifySubjectBundle(bundle, options = {}) {
  requireValue(bundle?.format === SUBJECT_FORMAT, 'bundle_format', '$.format', 'Expected a subject evidence bundle');
  return verifyBundle(bundle, options);
}

export function verifyBundle(bundle, { expectedManifestDigest } = {}) {
  requireValue(
    typeof expectedManifestDigest === 'string' && /^[a-fA-F0-9]{64}$/.test(expectedManifestDigest),
    'anchor_required',
    '$.manifest',
    'An independently retained expected manifest SHA-256 digest is required',
  );
  const subjectFormat = bundle?.format === SUBJECT_FORMAT;
  const flightFormat = bundle?.format === FLIGHT_FORMAT;
  const inputTypes =
    subjectFormat || flightFormat
      ? [...INPUT_TYPES, COMMAND_LINK_KIND, COMMAND_LINK_BASELINE_KIND, MISSION_KIND, MONITORING_WINDOW_KIND]
      : INPUT_TYPES;
  const format = subjectFormat ? SUBJECT_FORMAT : flightFormat ? FLIGHT_FORMAT : FORMAT;
  const sections = subjectFormat ? SUBJECT_SECTIONS : flightFormat ? [...SECTIONS, 'basisManifest'] : SECTIONS;
  keys(bundle, ['format', 'manifest', 'manifestDigest', ...sections], '$');
  requireValue(bundle.format === format, 'bundle_format', '$.format', 'Unsupported decision evidence bundle format');
  const manifest = bundle.manifest;
  keys(
    manifest,
    [
      'format',
      'exportId',
      'tenantId',
      'scope',
      ...(subjectFormat ? ['subject'] : flightFormat ? ['flightId', 'subject'] : ['flightId']),
      'decisionId',
      'issuedBy',
      'issuedAt',
      'versions',
      'counts',
      'limits',
      'sectionDigests',
      'interpretationDigests',
      'limitations',
    ],
    '$.manifest',
  );
  const computedManifest = canonicalDigest(manifest);
  hash(bundle.manifestDigest, '$.manifestDigest');
  requireValue(
    bundle.manifestDigest === computedManifest,
    'manifest_digest',
    '$.manifestDigest',
    'Manifest bytes do not match their declared digest',
  );
  requireValue(
    computedManifest === expectedManifestDigest.toLowerCase(),
    'anchor_mismatch',
    '$.manifest',
    'Manifest differs from the independently retained digest',
  );
  requireValue(
    manifest.format === format && manifest.scope === 'whole_tenant_prefixes',
    'manifest_scope',
    '$.manifest',
    'Manifest format or tenant-prefix scope is unsupported',
  );
  for (const key of ['exportId', 'tenantId', ...(subjectFormat ? [] : ['flightId']), 'decisionId', 'issuedBy'])
    text(manifest[key], `$.manifest.${key}`);
  timestamp(manifest.issuedAt, '$.manifest.issuedAt');
  same(
    manifest.versions,
    { integrity: INTEGRITY, interpretation: 'evidence-cut.1', snapshot: 'thread.1' },
    'version_contract',
    '$.manifest.versions',
    'Unsupported journal or snapshot version contract',
  );
  keys(manifest.sectionDigests, sections, '$.manifest.sectionDigests');
  for (const section of sections) {
    hash(manifest.sectionDigests[section], `$.manifest.sectionDigests.${section}`);
    requireValue(
      canonicalDigest(bundle[section]) === manifest.sectionDigests[section],
      'section_digest',
      `$.${section}`,
      'Committed bundle section is missing, modified, or contains omitted data',
    );
  }
  keys(manifest.interpretationDigests, CUTS, '$.manifest.interpretationDigests');
  keys(bundle.interpretations, CUTS, '$.interpretations');
  keys(bundle.cuts, CUTS, '$.cuts');
  for (const name of CUTS) {
    hash(manifest.interpretationDigests[name], `$.manifest.interpretationDigests.${name}`);
    requireValue(
      canonicalDigest(bundle.interpretations[name]) === manifest.interpretationDigests[name],
      'interpretation_commitment',
      `$.interpretations.${name}`,
      'Retained interpretation differs from its commitment',
    );
  }
  keys(
    manifest.counts,
    [
      'events',
      'streams',
      'receipts',
      'artifacts',
      'artifactBytes',
      ...(subjectFormat ? ['ruleSources', 'ruleSourceBytes'] : []),
    ],
    '$.manifest.counts',
  );
  keys(
    manifest.limits,
    [
      'maxEvents',
      'maxStreams',
      'maxArtifacts',
      'maxArtifactBytes',
      'maxBundleBytes',
      ...(subjectFormat ? ['maxRuleSources', 'maxRuleSourceBytes'] : []),
    ],
    '$.manifest.limits',
  );
  for (const [key, value] of Object.entries(manifest.counts)) integer(value, `$.manifest.counts.${key}`);
  for (const [key, value] of Object.entries(manifest.limits)) integer(value, `$.manifest.limits.${key}`);
  for (const section of ['streams', 'entries', 'receipts', 'artifacts']) array(bundle[section], `$.${section}`);
  requireValue(
    bundle.entries.length <= 100_000 && bundle.streams.length <= 100_000 && bundle.artifacts.length <= 10_000,
    'verifier_bound',
    '$',
    'Bundle exceeds standalone verifier item bounds',
  );
  const tenant = manifest.tenantId;
  const streams = new Map();
  const events = new Map();
  const byStream = new Map();
  for (const [index, stream] of bundle.streams.entries()) {
    const path = `$.streams[${index}]`;
    keys(stream, ['tenantId', 'id', 'name', 'headSequence', 'headHash', 'cutHeads'], path);
    text(stream.id, `${path}.id`);
    text(stream.name, `${path}.name`);
    requireValue(stream.tenantId === tenant, 'tenant_boundary', path, 'Stream belongs to another tenant');
    requireValue(!streams.has(stream.id), 'duplicate_stream', path, 'Stream identity is duplicated');
    const head = sequence(stream.headSequence, `${path}.headSequence`, true);
    if (head === 0n)
      requireValue(stream.headHash === '', 'genesis_hash', path, 'Empty stream must have an empty genesis head');
    else hash(stream.headHash, `${path}.headHash`);
    keys(stream.cutHeads, CUTS, `${path}.cutHeads`);
    streams.set(stream.id, { stream, head });
    byStream.set(stream.id, []);
  }
  for (const [index, entry] of bundle.entries.entries()) {
    const path = `$.entries[${index}]`;
    keys(entry, ['canonicalEnvelope', 'envelopeDigest', 'previousHash', 'entryHash', 'encodingVersion'], path);
    requireValue(entry.encodingVersion === INTEGRITY, 'entry_encoding', path, 'Unsupported journal entry encoding');
    const envelope = parseStrictJson(entry.canonicalEnvelope, `${path}.canonicalEnvelope`);
    keys(envelope, ENVELOPE_KEYS, `${path}.canonicalEnvelope`);
    requireValue(
      canonicalize(envelope) === entry.canonicalEnvelope,
      'envelope_bytes',
      path,
      'Envelope text is not its exact canonical byte representation',
    );
    for (const key of ['eventId', 'streamId', 'type', 'principalId']) text(envelope[key], `${path}.${key}`);
    requireValue(envelope.tenantId === tenant, 'tenant_boundary', path, 'Journal envelope belongs to another tenant');
    requireValue(envelope.schemaVersion === 1, 'schema_version', path, 'Unsupported journal envelope schema version');
    for (const key of ['sourceId', 'sourceSessionId', 'causationId', 'artifactId'])
      if (envelope[key] !== null) text(envelope[key], `${path}.${key}`);
    timestamp(envelope.occurredAt, path, true);
    timestamp(envelope.effectiveAt, path, true);
    timestamp(envelope.receivedAt, path);
    object(envelope.payload, `${path}.payload`);
    const position = sequence(envelope.sequence, `${path}.sequence`);
    requireValue(streams.has(envelope.streamId), 'missing_stream', path, 'Envelope references an absent stream');
    requireValue(!events.has(envelope.eventId), 'duplicate_event', path, 'Event identity is duplicated');
    hash(entry.envelopeDigest, path);
    hash(entry.entryHash, path);
    requireValue(
      sha256(entry.canonicalEnvelope) === entry.envelopeDigest,
      'envelope_digest',
      path,
      'Original envelope bytes have been modified',
    );
    requireValue(
      typeof entry.previousHash === 'string' &&
        (entry.previousHash === '' || /^[a-f0-9]{64}$/.test(entry.previousHash)),
      'previous_hash',
      path,
      'Predecessor hash encoding is invalid',
    );
    requireValue(
      entryHash(tenant, envelope.streamId, position, entry.previousHash, entry.envelopeDigest) === entry.entryHash,
      'entry_hash',
      path,
      'Journal entry commitment is invalid',
    );
    const record = { entry, envelope, position, path };
    events.set(envelope.eventId, record);
    byStream.get(envelope.streamId).push(record);
  }
  for (const [id, stream] of streams) {
    const records = byStream.get(id);
    records.sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
    requireValue(
      BigInt(records.length) === stream.head,
      'prefix_incomplete',
      '$.entries',
      'Stream does not contain its complete genesis-to-head prefix',
    );
    let previous = '';
    for (const [index, record] of records.entries()) {
      requireValue(
        record.position === BigInt(index + 1),
        'prefix_gap',
        record.path,
        'Stream sequence has a gap or duplicate position',
      );
      requireValue(
        record.entry.previousHash === previous,
        'chain_predecessor',
        record.path,
        'Stream predecessor commitment is broken',
      );
      previous = record.entry.entryHash;
    }
    requireValue(
      previous === stream.stream.headHash,
      'stream_head',
      '$.streams',
      'Captured stream head differs from its complete prefix',
    );
  }
  for (const name of CUTS) {
    cut(bundle.cuts[name], streams, `$.cuts.${name}`);
    for (const [id, { stream }] of streams) {
      const boundary = stream.cutHeads[name];
      keys(boundary, ['sequence', 'hash'], '$.streams.cutHeads');
      const position = sequence(boundary.sequence, '$.streams.cutHeads.sequence', true);
      requireValue(
        position === BigInt(bundle.cuts[name].streams[id] ?? 0),
        'cut_checkpoint',
        '$.streams.cutHeads',
        'Cut checkpoint sequence differs from its declared cut',
      );
      const expected = position === 0n ? '' : byStream.get(id)[Number(position - 1n)].entry.entryHash;
      requireValue(
        boundary.hash === expected,
        'cut_checkpoint',
        '$.streams.cutHeads',
        'Cut checkpoint hash differs from its stream prefix',
      );
    }
  }
  for (const id of streams.keys())
    requireValue(
      (bundle.cuts.rendered.streams[id] ?? 0) <= (bundle.cuts.accepted.streams[id] ?? 0),
      'cut_order',
      '$.cuts',
      'Rendered cut advances beyond the accepted cut',
    );
  const artifacts = new Map();
  let artifactBytes = 0;
  for (const [index, artifact] of bundle.artifacts.entries()) {
    const path = `$.artifacts[${index}]`;
    keys(artifact, ['tenantId', 'id', 'sha256', 'byteLength', 'contentType', 'bytesBase64'], path);
    requireValue(artifact.tenantId === tenant, 'tenant_boundary', path, 'Artifact belongs to another tenant');
    text(artifact.id, path);
    text(artifact.contentType, path);
    hash(artifact.sha256, path);
    integer(artifact.byteLength, path);
    requireValue(!artifacts.has(artifact.id), 'duplicate_artifact', path, 'Artifact identity is duplicated');
    const bytes = decodeBase64(artifact.bytesBase64, path);
    requireValue(
      bytes.byteLength === artifact.byteLength && sha256(bytes) === artifact.sha256,
      'artifact_bytes',
      path,
      'Original artifact bytes are missing or modified',
    );
    artifactBytes += bytes.byteLength;
    artifacts.set(artifact.id, artifact);
  }
  const referencedArtifacts = new Set();
  for (const record of events.values())
    if (record.envelope.artifactId !== null) {
      requireValue(
        artifacts.has(record.envelope.artifactId),
        'artifact_missing',
        record.path,
        'Journal artifact reference is missing',
      );
      referencedArtifacts.add(record.envelope.artifactId);
    }
  requireValue(
    referencedArtifacts.size === artifacts.size,
    'artifact_orphan',
    '$.artifacts',
    'Artifact is outside the captured journal references',
  );
  const receipts = new Map();
  const receiptEvents = new Set();
  const commandLinkHistory = [];
  const monitoringWindows = [];
  const missionBindingsBySource = new Map();
  const missionBindingsById = new Map();
  const missionBindingsByFlight = new Map();
  const missionRevisions = new Set();
  for (const [index, receipt] of bundle.receipts.entries()) {
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
    requireValue(receipt.tenantId === tenant, 'tenant_boundary', path, 'Receipt belongs to another tenant');
    text(receipt.id, path);
    requireValue(
      !receipts.has(receipt.id) && !receiptEvents.has(receipt.eventId),
      'duplicate_receipt',
      path,
      'Receipt or its journal identity is duplicated',
    );
    const record = events.get(receipt.eventId);
    requireValue(
      record && inputTypes.includes(record.envelope.type),
      'receipt_event',
      path,
      'Receipt references an absent or unsupported input event',
    );
    const envelope = record.envelope;
    const payload = envelope.payload;
    requireValue(
      receipt.sourceId === envelope.sourceId &&
        receipt.kind === envelope.type &&
        receipt.artifactId === envelope.artifactId &&
        receipt.receivedAt === envelope.receivedAt &&
        Date.parse(receipt.occurredAt) === Date.parse(envelope.occurredAt),
      'receipt_context',
      path,
      'Immutable receipt context differs from its journal envelope',
    );
    requireValue(
      receipt.sourceRevision ===
        (envelope.type === MONITORING_WINDOW_KIND
          ? String(payload.payload?.sourceRevision)
          : payload.sourceRevision === undefined
            ? null
            : String(payload.sourceRevision)),
      'receipt_revision',
      path,
      'Receipt source revision differs from its retained input',
    );
    same(receipt.payload, payload.payload, 'receipt_payload', path, 'Receipt payload differs from its retained input');
    same(
      receipt.inputSubject,
      envelope.type === MONITORING_WINDOW_KIND
        ? { organizationId: payload.organizationId }
        : envelope.type === OBSERVATION_KIND
          ? payload.subjects
          : payload.subject,
      'receipt_subject',
      path,
      'Receipt subject differs from its retained input',
    );
    if (envelope.type === COMMAND_LINK_KIND) {
      verifyCommandLinkReceipt(envelope, artifacts, path);
      commandLinkHistory.push({ envelope, path });
    }
    if (envelope.type === COMMAND_LINK_BASELINE_KIND) {
      verifyCommandLinkBaselineReceipt(envelope, artifacts, path);
      commandLinkHistory.push({ envelope, path });
    }
    if (envelope.type === MONITORING_WINDOW_KIND)
      monitoringWindows.push(verifyMonitoringWindowReceipt(envelope, receipt, artifacts, path));
    if (envelope.type === MISSION_KIND) {
      const mission = verifyMissionReceipt(envelope, receipt, artifacts, path);
      const identity = canonicalize([mission.sourceId, mission.sourceMissionId]);
      const binding = canonicalize([
        mission.missionId,
        mission.sourceId,
        mission.sourceMissionId,
        mission.flightId,
        mission.aircraftId,
      ]);
      const revision = canonicalize([mission.sourceId, mission.sourceMissionId, mission.sourceRevision]);
      requireValue(
        (!missionBindingsBySource.has(identity) || missionBindingsBySource.get(identity) === binding) &&
          (!missionBindingsById.has(mission.missionId) || missionBindingsById.get(mission.missionId) === binding) &&
          (!missionBindingsByFlight.has(mission.flightId) ||
            missionBindingsByFlight.get(mission.flightId) === binding) &&
          !missionRevisions.has(revision),
        'mission_identity',
        path,
        'Mission history changes its fixed source/mission/flight/aircraft binding or duplicates a source revision',
      );
      missionBindingsBySource.set(identity, binding);
      missionBindingsById.set(mission.missionId, binding);
      missionBindingsByFlight.set(mission.flightId, binding);
      missionRevisions.add(revision);
    }
    receipts.set(receipt.id, receipt);
    receiptEvents.add(receipt.eventId);
  }
  verifyCommandLinkBaselineHistory(commandLinkHistory);
  verifyMonitoringWindowReferences(monitoringWindows, events, receipts, artifacts);
  for (const record of events.values())
    if (inputTypes.includes(record.envelope.type))
      requireValue(
        receiptEvents.has(record.envelope.eventId),
        'receipt_missing',
        record.path,
        'Input event has no retained immutable receipt',
      );
  const incoming = new Map([...events.keys()].map((id) => [id, 0]));
  const successors = new Map([...events.keys()].map((id) => [id, []]));
  const edge = (from, to, path) => {
    requireValue(
      events.has(from),
      'causal_reference_missing',
      path,
      'A journal causal reference is missing from the complete tenant inventory',
    );
    incoming.set(to, incoming.get(to) + 1);
    successors.get(from).push(to);
  };
  for (const records of byStream.values())
    for (let index = 1; index < records.length; index++)
      edge(records[index - 1].envelope.eventId, records[index].envelope.eventId, records[index].path);
  for (const { envelope, path } of events.values()) {
    if (envelope.causationId !== null) edge(envelope.causationId, envelope.eventId, path);
    if (envelope.type === 'evidence.correct') {
      text(envelope.payload.correctionOf, path);
      edge(envelope.payload.correctionOf, envelope.eventId, path);
    }
    if (envelope.type === 'identity.link') {
      const receipt = receipts.get(envelope.payload.receiptId);
      requireValue(receipt, 'linked_receipt_missing', path, 'Identity command references a missing receipt');
      edge(receipt.eventId, envelope.eventId, path);
    }
  }
  let hasMissionRelease = false;
  for (const record of events.values())
    if (record.envelope.type === MISSION_RELEASE_KIND) {
      verifyMissionReleaseEvent(record, events, streams, tenant);
      hasMissionRelease = true;
    }
  const hasMissionDeparture = [...events.values()].some(
    ({ envelope }) => envelope.type === 'mission.departure-authorize',
  );
  const hasMissionBriefing = [...events.values()].some(({ envelope }) =>
    ['mission.brief', 'mission.briefing-acknowledge'].includes(envelope.type),
  );
  let hasPinnedControls = false;
  for (const record of events.values())
    if (['mission.brief', 'mission.departure-authorize'].includes(record.envelope.type))
      hasPinnedControls = verifyPinnedControls(record) || hasPinnedControls;
  const ready = [...incoming].filter(([, count]) => count === 0).map(([id]) => id);
  let visited = 0;
  for (let index = 0; index < ready.length; index++) {
    visited++;
    for (const id of successors.get(ready[index])) {
      incoming.set(id, incoming.get(id) - 1);
      if (incoming.get(id) === 0) ready.push(id);
    }
  }
  requireValue(visited === events.size, 'causal_cycle', '$.entries', 'Journal causal references contain a cycle');
  let subjectCounts = {};
  if (subjectFormat) {
    subjectCounts = verifySubjectCommitments(bundle, events, streams);
    timestamp(bundle.snapshot.capturedAt, '$.snapshot.capturedAt');
    cut(bundle.snapshot.projectionCut, streams, '$.snapshot.projectionCut');
    integer(bundle.snapshot.projectionRevision, '$.snapshot.projectionRevision');
  } else {
    if (flightFormat) verifyFlightTarget(bundle);
    const decision = bundle.decision;
    object(decision, '$.decision');
    const issuance = events.get(manifest.decisionId);
    requireValue(
      issuance && issuance.envelope.type === 'decision.record',
      'decision_missing',
      '$.decision',
      'Selected decision has no retained issuance event',
    );
    const envelope = issuance.envelope;
    const body = envelope.payload;
    requireValue(
      decision.id === manifest.decisionId &&
        decision.flightId === manifest.flightId &&
        decision.actorId === envelope.principalId &&
        body.flightId === manifest.flightId &&
        decision.recordedAt === envelope.receivedAt &&
        decision.kind === body.decision?.kind &&
        decision.note === body.decision?.note &&
        decision.acceptedBasisRevision === body.expectedBasisRevision,
      'decision_commitment',
      '$.decision',
      'Decision fields differ from their original journal commitment',
    );
    same(
      decision.renderedInputCut,
      body.inputCut,
      'decision_cut',
      '$.decision',
      'Rendered decision cut differs from its original commitment',
    );
    same(
      decision.acceptedInputCut,
      body.acceptedInputCut,
      'decision_cut',
      '$.decision',
      'Accepted decision cut differs from its original commitment',
    );
    same(
      bundle.cuts.rendered,
      decision.renderedInputCut,
      'decision_cut',
      '$.cuts.rendered',
      'Bundle rendered cut differs from its selected decision',
    );
    same(
      bundle.cuts.accepted,
      decision.acceptedInputCut,
      'decision_cut',
      '$.cuts.accepted',
      'Bundle accepted cut differs from its selected decision',
    );
    const issuanceCut = {
      streams: Object.fromEntries([...streams].map(([id, captured]) => [id, Number(captured.head)])),
    };
    same(
      bundle.cuts.issuance,
      issuanceCut,
      'issuance_cut',
      '$.cuts.issuance',
      'Bundle-issued cut must match every captured export-time stream head',
    );
    keys(bundle.actor, ['id', 'authorityRevision', 'historicalProfile'], '$.actor');
    requireValue(
      bundle.actor.id === decision.actorId && bundle.actor.historicalProfile === 'not_retained',
      'actor_context',
      '$.actor',
      'Actor context contradicts the retained decision or historical registry limitation',
    );
    if (bundle.actor.authorityRevision !== null) integer(bundle.actor.authorityRevision, '$.actor.authorityRevision');
    requireValue(
      bundle.actor.authorityRevision === (decision.acceptedInputCut.principalRevision ?? null),
      'actor_context',
      '$.actor',
      'Actor revision differs from its accepted decision cut',
    );
    const snapshot = bundle.snapshot;
    object(snapshot, '$.snapshot');
    requireValue(
      snapshot.kind === 'export_time_sql_snapshot' &&
        snapshot.projectorVersion === 'thread.1' &&
        snapshot.flight?.id === manifest.flightId,
      'snapshot_scope',
      '$.snapshot',
      'Snapshot must remain a separate export-time capture for the selected flight',
    );
    timestamp(snapshot.capturedAt, '$.snapshot.capturedAt');
    cut(snapshot.projectionCut, streams, '$.snapshot.projectionCut');
    integer(snapshot.projectionRevision, '$.snapshot.projectionRevision');
    array(snapshot.items, '$.snapshot.items');
    array(snapshot.decisions, '$.snapshot.decisions');
    for (const item of snapshot.items) {
      requireValue(
        events.has(item.id),
        'snapshot_reference',
        '$.snapshot.items',
        'Snapshot item references journal data outside its tenant inventory',
      );
      if (item.receiptId !== undefined)
        requireValue(
          receipts.has(item.receiptId),
          'snapshot_reference',
          '$.snapshot.items',
          'Snapshot item references a missing receipt',
        );
      if (item.artifactId !== undefined)
        requireValue(
          artifacts.has(item.artifactId),
          'snapshot_reference',
          '$.snapshot.items',
          'Snapshot item references a missing artifact',
        );
    }
    for (const item of snapshot.decisions)
      requireValue(
        events.get(item.id)?.envelope.type === 'decision.record',
        'snapshot_reference',
        '$.snapshot.decisions',
        'Snapshot decision references journal data outside its tenant inventory',
      );
  }
  const counts = {
    events: events.size,
    streams: streams.size,
    receipts: receipts.size,
    artifacts: artifacts.size,
    artifactBytes,
    ...subjectCounts,
  };
  same(
    manifest.counts,
    counts,
    'inventory_counts',
    '$.manifest.counts',
    'Manifest inventory counts differ from the complete bundle',
  );
  requireValue(
    counts.events <= manifest.limits.maxEvents &&
      counts.streams <= manifest.limits.maxStreams &&
      counts.artifacts <= manifest.limits.maxArtifacts &&
      artifactBytes <= manifest.limits.maxArtifactBytes &&
      (!subjectFormat ||
        (counts.ruleSources <= manifest.limits.maxRuleSources &&
          counts.ruleSourceBytes <= manifest.limits.maxRuleSourceBytes)) &&
      Buffer.byteLength(canonicalize(bundle)) <= manifest.limits.maxBundleBytes,
    'declared_limits',
    '$.manifest.limits',
    'Bundle exceeds its committed export limits',
  );
  const interpreter = bundle.interpreter;
  object(interpreter, '$.interpreter');
  requireValue(
    interpreter.sourceEncoding === 'utf8' && typeof interpreter.source === 'string',
    'interpreter_source',
    '$.interpreter',
    'Retained interpreter UTF-8 source is missing',
  );
  hash(interpreter.sourceSha256, '$.interpreter.sourceSha256');
  requireValue(
    sha256(interpreter.source) === interpreter.sourceSha256,
    'interpreter_bytes',
    '$.interpreter',
    'Retained interpreter bytes differ from their commitment',
  );
  const unavailable = [];
  if (interpreter.name !== 'evidence-cut.1' || interpreter.sourceSha256 !== SOURCE_HASH)
    unavailable.push(
      "Retained interpreter source is not in this verifier's pinned evidence-cut.1 allowlist; no source was evaluated.",
    );
  if (!interpreter.runtimeContract || !interpreter.runtimeContractDigest)
    unavailable.push('Retained runtime contract is missing; independent reconstruction is unavailable.');
  else {
    hash(interpreter.runtimeContractDigest, '$.interpreter.runtimeContractDigest');
    requireValue(
      canonicalDigest(interpreter.runtimeContract) === interpreter.runtimeContractDigest,
      'runtime_commitment',
      '$.interpreter',
      'Retained runtime contract differs from its commitment',
    );
    if (
      canonicalize(interpreter.runtimeContract) !== canonicalize(RUNTIME) ||
      Number(process.versions.node.split('.')[0]) !== 24
    )
      unavailable.push(
        'Retained runtime contract or current Node major is unsupported; independent reconstruction is unavailable.',
      );
  }
  const replays = {};
  for (const name of CUTS) {
    const expected = bundle.interpretations[name];
    object(expected, `$.interpretations.${name}`);
    requireValue(
      expected.tenantId === tenant && expected.interpretation === 'evidence-cut.1',
      'interpretation_scope',
      `$.interpretations.${name}`,
      'Interpretation declares another tenant or unsupported scope',
    );
    same(
      expected.cut,
      bundle.cuts[name],
      'interpretation_cut',
      `$.interpretations.${name}`,
      'Interpretation declares a different decision cut',
    );
    if (unavailable.length) replays[name] = { status: 'unavailable', limitations: [...unavailable] };
    else {
      const output = reconstructEvidenceCut(bundle.entries, bundle.cuts[name], tenant);
      const digest = canonicalDigest(output);
      same(
        output,
        expected,
        'replay_mismatch',
        `$.interpretations.${name}`,
        'Independent journal reconstruction differs from retained expected output',
      );
      replays[name] = {
        status: 'verified',
        digest,
        eventCount: output.events.length,
        missingCausationIds: output.missingCausationIds,
        output,
      };
    }
  }
  return {
    status: unavailable.length ? 'integrity_only' : 'verified',
    scope: 'whole_tenant_prefixes',
    tenantId: tenant,
    decisionId: manifest.decisionId,
    ...(subjectFormat || flightFormat ? { format, subject: manifest.subject } : {}),
    manifestDigest: computedManifest,
    counts,
    replays,
    limitations: [
      ...(subjectFormat
        ? [...SUBJECT_LIMITATIONS, ...unavailable]
        : [
            'The external digest anchors captured manifest contents; exporter honesty and evidence omitted before that anchor are outside this proof.',
            'Historical actor profile and authority registry are not retained; event attribution and accepted revision are verified as committed declarations.',
            'The export-time operational snapshot is committed data, not a replayed historical browser display or thread.1 SQL rebuild.',
            ...unavailable,
          ]),
      ...(missionRevisions.size ? [MISSION_LIMITATION] : []),
      ...(hasMissionRelease ? [MISSION_RELEASE_LIMITATION] : []),
      ...(hasMissionDeparture ? [MISSION_DEPARTURE_LIMITATION] : []),
      ...(hasMissionBriefing ? [MISSION_BRIEFING_LIMITATION] : []),
      ...(hasPinnedControls ? [PINNED_CONTROLS_LIMITATION] : []),
      ...(monitoringWindows.length ? [MONITORING_WINDOW_LIMITATION] : []),
    ],
  };
}
