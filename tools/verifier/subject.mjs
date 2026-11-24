import { canonicalDigest, canonicalize, decodeBase64, requireValue, sha256 } from './integrity.mjs';

export const SUBJECT_FORMAT = 'ledger.subject-evidence.2';
export const SUBJECT_SECTIONS = [
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
];
export const SUBJECT_LIMITATIONS = [
  'The anchor verifies retained record, dependency-basis and authority-policy consistency, not dependency completeness, external identity or evaluator semantics.',
  'The unchanged evidence-cut.1 outputs are inventories only; their legacy flight wording does not select this bundle subject.',
  'The export-time organization snapshot is not a replayed historical browser display. The earlier adoption has no retained basis manifest.',
  'Retained authority is not a person’s electronic signature; grants and evidence omitted before the independent anchor remain outside this proof.',
];
const check = (condition, code, message, path = '$.decision') => requireValue(condition, code, path, message);
const same = (actual, expected, code, message, path) =>
  check(canonicalize(actual) === canonicalize(expected), code, message, path);
const object = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
function keys(value, required, code = 'subject_shape') {
  check(
    object(value) &&
      Object.keys(value).length === required.length &&
      required.every((key) => Object.hasOwn(value, key)),
    code,
    'Subject record fields do not match the versioned contract',
  );
}
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const text = (value) => typeof value === 'string' && value.length > 0;
function utc(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return NaN;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === value.slice(0, 19) ? time : NaN;
}
function authority(actor, capability, policy, subject, retained) {
  keys(
    actor,
    [
      'id',
      'name',
      'kind',
      'principalRevision',
      'capabilities',
      'checkedCapabilities',
      'policyVersion',
      ...(retained ? ['historicalProfile', 'scope'] : []),
    ],
    'authority_shape',
  );
  check(
    text(actor.id) && typeof actor.name === 'string' && text(actor.kind) && integer(actor.principalRevision),
    'authority_snapshot',
    'Authority attribution or revision is invalid',
  );
  check(
    Array.isArray(actor.capabilities) &&
      actor.capabilities.every(text) &&
      actor.capabilities.includes(capability) &&
      actor.policyVersion === policy,
    'authority_policy',
    'Retained granted authority does not satisfy the acceptance policy',
  );
  same(
    actor.checkedCapabilities,
    [capability],
    'authority_policy',
    'Checked capability does not match the acceptance policy',
  );
  if (retained) {
    check(
      actor.historicalProfile === 'retained',
      'authority_snapshot',
      'Review authority must be retained at acceptance',
    );
    same(actor.scope, subject, 'authority_scope', 'Authority scope differs from the selected organization');
  }
}
function committed(record, timeField, type, events) {
  const event = events.get(record.id)?.envelope;
  const { id, [timeField]: time, ...acceptance } = record;
  check(
    event && event.type === type && event.principalId === record.actor.id && event.receivedAt === time,
    'subject_commitment',
    'Selected acceptance attribution or time differs from its journal event',
  );
  same(
    event.payload.acceptance,
    acceptance,
    'subject_commitment',
    'Selected acceptance differs from its immutable journal commitment',
  );
  return event;
}
function basis(decision, streams, events) {
  const manifest = decision.basisManifest;
  keys(
    manifest,
    ['version', 'subjectId', 'principalId', 'principalRevision', 'subjects', 'edges', 'frontiers', 'authority'],
    'basis_manifest',
  );
  check(
    manifest.version === 'subject-evidence.1' &&
      manifest.subjectId === decision.subject.id &&
      manifest.principalId === decision.actor.id &&
      manifest.principalRevision === decision.actor.principalRevision &&
      canonicalDigest(manifest) === decision.dependencyBasis,
    'basis_manifest',
    'Retained basis manifest does not reproduce the committed dependency token',
  );
  check(
    Array.isArray(manifest.subjects) &&
      manifest.subjects.every(text) &&
      new Set(manifest.subjects).size === manifest.subjects.length &&
      manifest.subjects.includes(manifest.subjectId) &&
      Array.isArray(manifest.edges) &&
      Array.isArray(manifest.frontiers),
    'basis_manifest',
    'Basis subject closure is malformed',
  );
  const included = (event) =>
    event && BigInt(event.sequence) <= BigInt(decision.acceptedInputCut.streams[event.streamId] ?? 0);
  const edgeKeys = new Set();
  for (const edge of manifest.edges) {
    keys(edge, ['subjectId', 'dependencySubjectId', 'eventId'], 'basis_manifest');
    const edgeKey = canonicalize([edge.subjectId, edge.dependencySubjectId]);
    check(
      manifest.subjects.includes(edge.subjectId) &&
        manifest.subjects.includes(edge.dependencySubjectId) &&
        !edgeKeys.has(edgeKey) &&
        included(events.get(edge.eventId)?.envelope),
      'basis_manifest',
      'Basis dependency edge is duplicate, absent or outside the accepted cut',
    );
    edgeKeys.add(edgeKey);
  }
  const reachable = new Set([manifest.subjectId]);
  for (let count = 0; count < manifest.subjects.length; count++)
    for (const edge of manifest.edges) if (reachable.has(edge.subjectId)) reachable.add(edge.dependencySubjectId);
  check(
    reachable.size === manifest.subjects.length,
    'basis_manifest',
    'Basis includes subjects outside its recorded dependency closure',
  );
  const rendered = {};
  const accepted = {};
  const frontierKeys = new Set();
  for (const frontier of [...manifest.frontiers, ...(manifest.authority === null ? [] : [manifest.authority])]) {
    const isAuthority = frontier === manifest.authority;
    keys(
      frontier,
      isAuthority
        ? ['streamId', 'sequence', 'projectedSequence']
        : ['subjectId', 'streamId', 'sequence', 'projectedSequence'],
      'basis_manifest',
    );
    const frontierKey = canonicalize([frontier.subjectId ?? null, frontier.streamId]);
    check(
      !frontierKeys.has(frontierKey) &&
        integer(frontier.sequence) &&
        integer(frontier.projectedSequence) &&
        frontier.projectedSequence <= frontier.sequence &&
        streams.has(frontier.streamId) &&
        BigInt(frontier.sequence) <= streams.get(frontier.streamId).head &&
        (isAuthority
          ? streams.get(frontier.streamId).stream.name === `authority:${decision.actor.id}`
          : manifest.subjects.includes(frontier.subjectId)),
      'basis_manifest',
      'Basis frontier is duplicate or exceeds its retained stream',
    );
    frontierKeys.add(frontierKey);
    accepted[frontier.streamId] = Math.max(accepted[frontier.streamId] ?? 0, frontier.sequence);
    rendered[frontier.streamId] = Math.max(rendered[frontier.streamId] ?? 0, frontier.projectedSequence);
  }
  same(
    decision.renderedInputCut.streams,
    rendered,
    'basis_cut',
    'Rendered cut does not match the retained projected basis',
  );
  same(
    decision.acceptedInputCut.streams,
    accepted,
    'basis_cut',
    'Accepted cut does not match the retained accepted basis',
  );
  for (const cut of [decision.renderedInputCut, decision.acceptedInputCut])
    check(
      cut.basisRevision === decision.acceptedBasisRevision &&
        cut.principalRevision === decision.actor.principalRevision,
      'basis_cut',
      'Cut revision does not match the acceptance authority or organization basis',
    );
}
function contentDigest(value, code) {
  const { digest, ...content } = value;
  check(
    typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest) && canonicalDigest(content) === digest,
    code,
    'Retained content digest does not reproduce its exact content',
  );
}
/** The definition itself is not exported, so its digest is checked for form and for agreement across the pack. */
function checkReference(reference, digests) {
  check(
    object(reference) &&
      text(reference.kind) &&
      Number.isSafeInteger(reference.version) &&
      reference.version >= 1 &&
      typeof reference.definitionDigest === 'string' &&
      /^[a-f0-9]{64}$/.test(reference.definitionDigest),
    'leaf_check',
    'Checked rule does not name a versioned check kind and its definition digest',
  );
  const key = canonicalize([reference.kind, reference.version]);
  check(
    (digests.get(key) ?? reference.definitionDigest) === reference.definitionDigest,
    'leaf_check',
    'Rules naming one check kind version disagree on its definition digest',
  );
  digests.set(key, reference.definitionDigest);
}
function packSources(bundle) {
  const sources = new Map();
  check(
    Array.isArray(bundle.ruleSources) && bundle.ruleSources.length <= 4,
    'rule_source',
    'Original rule-source inventory is absent or exceeds its bound',
  );
  let sourceBytes = 0;
  for (const source of bundle.ruleSources) {
    keys(source, ['sourceId', 'sha256', 'byteLength', 'contentType', 'bytesBase64'], 'rule_source');
    check(
      text(source.sourceId) &&
        !sources.has(source.sourceId) &&
        integer(source.byteLength) &&
        source.byteLength <= 8 * 1024 * 1024,
      'rule_source',
      'Rule-source identity or length is invalid',
    );
    const bytes = decodeBase64(source.bytesBase64, '$.ruleSources.bytesBase64');
    check(
      bytes.length === source.byteLength && sha256(bytes) === source.sha256,
      'rule_source_bytes',
      'Original rule-source bytes differ from their retained digest',
    );
    sourceBytes += bytes.length;
    check(sourceBytes <= 8 * 1024 * 1024, 'rule_source', 'Rule-source inventory exceeds its standalone byte bound');
    sources.set(source.sourceId, { ...source, bytes });
  }
  const pack = bundle.adoption.pack;
  contentDigest(pack, 'pack_digest');
  check(
    Array.isArray(pack.leaves) &&
      Array.isArray(pack.bindings) &&
      new Set(pack.leaves.map((leaf) => leaf.id)).size === pack.leaves.length &&
      new Set(pack.bindings.map((binding) => binding.id)).size === pack.bindings.length,
    'pack_reference',
    'Retained leaf or binding references are invalid',
  );
  for (const binding of pack.bindings) contentDigest(binding, 'binding_digest');
  const referencedSources = new Set();
  const checkDigests = new Map();
  for (const leaf of pack.leaves) {
    contentDigest(leaf, 'leaf_digest');
    const bytes = Buffer.from(leaf.source.text, 'utf8');
    check(
      leaf.source.encoding === 'utf-8' &&
        leaf.source.byteLength === bytes.length &&
        leaf.source.sha256 === sha256(bytes),
      'leaf_source',
      'Leaf source text differs from its retained UTF-8 bytes',
    );
    const span = leaf.source.textSpan;
    check(
      span.unit === 'utf8_byte' && integer(span.start) && integer(span.end) && span.end >= span.start,
      'leaf_source',
      'Leaf source span is invalid',
    );
    // A rule the generic evaluator runs is automated without a binding, whatever its source kind.
    const checkedRule = Object.hasOwn(leaf, 'check') && Object.hasOwn(leaf, 'reads');
    if (checkedRule) checkReference(leaf.check, checkDigests);
    if (Object.hasOwn(leaf.source, 'document')) {
      const descriptor = leaf.source.document;
      const original = sources.get(descriptor.sourceId);
      check(
        original &&
          span.sourceId === descriptor.sourceId &&
          original.sha256 === descriptor.sha256 &&
          original.byteLength === descriptor.byteLength &&
          original.contentType === descriptor.contentType &&
          span.end <= original.bytes.length &&
          original.bytes.subarray(span.start, span.end).equals(bytes),
        'leaf_source',
        'Leaf paragraph does not match the cited original document span',
      );
      check(
        (['manual', 'unsupported'].includes(leaf.coverage) || (leaf.coverage === 'automated' && checkedRule)) &&
          !Object.hasOwn(leaf, 'bindingId'),
        'leaf_coverage',
        'Proposed coverage cannot assert a fabricated automated binding',
      );
      referencedSources.add(descriptor.sourceId);
    } else if (checkedRule) {
      check(
        ['operator_procedure', 'waiver_or_exemption'].includes(leaf.source.kind) && span.end <= bytes.length,
        'leaf_source',
        'Checked procedure rule does not quote its own text within its span',
      );
      check(
        leaf.coverage === 'automated' && !Object.hasOwn(leaf, 'bindingId'),
        'leaf_coverage',
        'Checked rule cannot assert a fabricated automated binding',
      );
    } else if (['manual', 'unsupported'].includes(leaf.coverage)) {
      // An organization's own provision that no check runs carries its quoted words whole.
      check(
        ['operator_procedure', 'waiver_or_exemption'].includes(leaf.source.kind) &&
          span.start === 0 &&
          span.end === bytes.length &&
          !Object.hasOwn(leaf, 'bindingId'),
        'leaf_source',
        'Provision a person checks does not quote its own text whole',
      );
    } else {
      const binding = pack.bindings.find(
        (candidate) =>
          candidate.id === leaf.bindingId &&
          candidate.version === leaf.bindingVersion &&
          candidate.digest === leaf.bindingDigest,
      );
      check(
        leaf.source.kind === 'operator_procedure' &&
          leaf.coverage === 'automated' &&
          binding &&
          span.end <= bytes.length,
        'leaf_binding',
        'Procedure leaf does not identify its retained binding and source span',
      );
    }
  }
  check(
    referencedSources.size === sources.size,
    'rule_source',
    'Rule-source inventory contains unreferenced documents',
  );
  return { ruleSources: sources.size, ruleSourceBytes: sourceBytes };
}
export function verifySubjectCommitments(bundle, events, streams) {
  const decision = bundle.decision;
  keys(decision, [
    'id',
    'subject',
    'acceptedRevision',
    'actor',
    'adoption',
    'kind',
    'note',
    'recordedAt',
    'renderedInputCut',
    'acceptedInputCut',
    'acceptedBasisRevision',
    'dependencyBasis',
    'basisManifest',
  ]);
  keys(bundle.manifest.subject, ['kind', 'id']);
  check(
    bundle.manifest.subject.kind === 'organization' &&
      bundle.manifest.subject.id === `organization:${bundle.manifest.tenantId}`,
    'subject_scope',
    'Subject does not identify the manifest tenant organization',
  );
  same(decision.subject, bundle.manifest.subject, 'subject_scope', 'Selected decision belongs to another subject');
  check(
    decision.id === bundle.manifest.decisionId &&
      decision.kind === 'adoption.review' &&
      typeof decision.note === 'string' &&
      integer(decision.acceptedBasisRevision) &&
      decision.acceptedRevision === decision.acceptedBasisRevision + 1,
    'subject_decision',
    'Selected decision is not a versioned informational adoption review',
  );
  authority(decision.actor, 'decision:write', 'ledger.organization-review-authority.1', decision.subject, true);
  same(bundle.actor, decision.actor, 'authority_snapshot', 'Actor section differs from the retained acceptance');
  const event = committed(decision, 'recordedAt', 'decision.record', events);
  check(
    streams.get(event.streamId)?.stream.name === decision.subject.id,
    'subject_scope',
    'Review event is outside its organization stream',
  );
  check(
    BigInt(decision.acceptedInputCut.streams[event.streamId] ?? 0) < BigInt(event.sequence),
    'basis_cut',
    'The accepted organization basis must precede its selected review event',
  );
  same(
    event.payload.subject,
    { kind: 'organization' },
    'subject_scope',
    'Review command must derive its organization from authentication',
  );
  same(
    event.payload.decision,
    { kind: decision.kind, note: decision.note },
    'subject_decision',
    'Review outcome differs from the original command',
  );
  same(
    event.payload.adoption,
    decision.adoption,
    'adoption_citation',
    'Review citation differs from the original command',
  );
  same(
    event.payload.inputCut,
    decision.renderedInputCut,
    'basis_cut',
    'Review displayed cut differs from the original command',
  );
  check(
    event.payload.expectedRevision === decision.acceptedBasisRevision &&
      event.payload.expectedDependencyBasis === decision.dependencyBasis,
    'basis_manifest',
    'Review basis differs from the original command',
  );
  basis(decision, streams, events);
  same(
    bundle.cuts.rendered,
    decision.renderedInputCut,
    'basis_cut',
    'Bundle rendered cut differs from the selected review',
  );
  same(
    bundle.cuts.accepted,
    decision.acceptedInputCut,
    'basis_cut',
    'Bundle accepted cut differs from the selected review',
  );
  same(
    bundle.cuts.issuance,
    { streams: Object.fromEntries([...streams].map(([id, captured]) => [id, Number(captured.head)])) },
    'issuance_cut',
    'Issuance cut must include every captured stream head',
  );
  const adoption = bundle.adoption;
  keys(
    adoption,
    [
      'id',
      'organizationId',
      'acceptedRevision',
      'actor',
      'pack',
      'scope',
      'effectiveInterval',
      'note',
      'renderedInputCut',
      'acceptedInputCut',
      'dependencyBasis',
      'acceptedAt',
      // Adoptions accepted before modes existed carry neither field.
      ...['mode', 'revises'].filter((key) => Object.hasOwn(adoption, key)),
    ],
    'adoption_shape',
  );
  check(
    adoption.mode === undefined || adoption.mode === 'shadow' || adoption.mode === 'active',
    'adoption_shape',
    'Adoption mode is unsupported',
  );
  check(
    adoption.id === decision.adoption.id &&
      adoption.organizationId === decision.subject.id &&
      adoption.acceptedRevision === decision.adoption.acceptedRevision,
    'adoption_citation',
    'Cited adoption identity or revision differs from the review',
  );
  same(
    { packId: adoption.pack.packId, version: adoption.pack.version, digest: adoption.pack.digest },
    decision.adoption.pack,
    'adoption_citation',
    'Cited pack version differs from the retained adoption',
  );
  same(
    adoption.scope,
    { kind: 'organization', organizationId: decision.subject.id },
    'adoption_citation',
    'Adoption belongs to another organization',
  );
  authority(adoption.actor, 'pack:adopt', 'ledger.pack-adoption-authority.1', decision.subject, false);
  const adopted = committed(adoption, 'acceptedAt', 'rule-pack.adopt', events);
  check(
    streams.get(adopted.streamId)?.stream.name === decision.subject.id,
    'subject_scope',
    'Adoption event is outside its organization stream',
  );
  check(
    BigInt(adopted.sequence) <= BigInt(decision.acceptedInputCut.streams[adopted.streamId] ?? 0) &&
      adoption.acceptedRevision <= decision.acceptedBasisRevision,
    'adoption_citation',
    'The review citation was not present in its accepted organization basis',
  );
  check(
    Number.isFinite(utc(adoption.effectiveInterval.start)) &&
      utc(adoption.effectiveInterval.end) > utc(adoption.effectiveInterval.start),
    'adoption_interval',
    'Retained adoption interval is not finite half-open UTC',
  );
  same(
    adopted.payload.effectiveInterval,
    adoption.effectiveInterval,
    'adoption_commitment',
    'Adoption interval differs from its original command',
  );
  same(
    adopted.payload.inputCut,
    adoption.renderedInputCut,
    'adoption_commitment',
    'Adoption displayed cut differs from its original command',
  );
  check(
    adopted.payload.note === adoption.note &&
      adopted.payload.mode === adoption.mode &&
      adopted.payload.revises === adoption.revises &&
      adopted.payload.expectedDependencyBasis === adoption.dependencyBasis &&
      adopted.payload.expectedRevision + 1 === adoption.acceptedRevision,
    'adoption_commitment',
    'Adoption acceptance differs from its original basis or note',
  );
  for (const cut of [adoption.renderedInputCut, adoption.acceptedInputCut]) {
    check(
      cut.principalRevision === adoption.actor.principalRevision &&
        cut.basisRevision === adopted.payload.expectedRevision &&
        object(cut.streams),
      'adoption_commitment',
      'Adoption cut revisions differ from its authority snapshot',
    );
    for (const [id, position] of Object.entries(cut.streams))
      check(
        integer(position) && streams.has(id) && BigInt(position) <= streams.get(id).head,
        'adoption_commitment',
        'Adoption cut exceeds retained stream prefixes',
      );
  }
  for (const [id, position] of Object.entries(adoption.renderedInputCut.streams))
    check(
      position <= (adoption.acceptedInputCut.streams[id] ?? 0),
      'adoption_commitment',
      'Adoption rendered cut exceeds its accepted cut',
    );
  const references = (values) => values.map(({ id, version, digest }) => canonicalize({ id, version, digest })).sort();
  const requested = adopted.payload.pack;
  same(
    { packId: requested.packId, version: requested.version, digest: requested.digest },
    decision.adoption.pack,
    'adoption_commitment',
    'Adoption requested a different pack',
  );
  same(
    references(requested.leaves),
    references(adoption.pack.leaves),
    'adoption_commitment',
    'Adoption leaf references differ from its immutable snapshot',
  );
  same(
    references(requested.bindings),
    references(adoption.pack.bindings),
    'adoption_commitment',
    'Adoption binding references differ from its immutable snapshot',
  );
  const snapshot = bundle.snapshot;
  keys(
    snapshot,
    [
      'kind',
      'capturedAt',
      'projectorVersion',
      'projectionCut',
      'projectionRevision',
      'subject',
      'organization',
      'limitations',
    ],
    'snapshot_scope',
  );
  check(
    snapshot.kind === 'export_time_sql_snapshot' &&
      snapshot.projectorVersion === 'thread.1' &&
      snapshot.organization.id === decision.subject.id &&
      integer(snapshot.organization.revision) &&
      integer(snapshot.organization.projectedRevision) &&
      snapshot.organization.projectedRevision <= snapshot.organization.revision,
    'snapshot_scope',
    'Snapshot is not an export-time organization capture',
  );
  same(snapshot.subject, decision.subject, 'snapshot_scope', 'Snapshot subject differs from the selected decision');
  return packSources(bundle);
}
