import { readFileSync } from 'node:fs';
import type {
  EvidenceEnvelope,
  EvidenceRuleSource,
  OrganizationDecisionCommand,
  PackAdoptionAcceptance,
  PackAdoptionRecord,
  Principal,
  RulePackLeaf,
  RulePackVersion,
  SubjectDecisionAcceptance,
  SubjectDecisionRecord,
  SubjectEvidenceBundle,
  SubjectExportRecord,
} from '@ledger/contracts';
import { canonicalDigest, canonicalize, entryHash, INTEGRITY_VERSION, sha256 } from '@ledger/integrity';
import { interpretEvidenceCut } from '../../../../tools/verifier/evidence-cut.1.mjs';

export const fixtureTime = '2026-10-15T14:30:00.000Z';
export const organizationStream = 'fixture-organization-stream';
const cutNames = ['rendered', 'accepted', 'issuance'] as const;
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

export function smallRetainedPack(): { pack: RulePackVersion; source: EvidenceRuleSource } {
  const prefix = '<html><body>Préface 航空 —<p>';
  const manual = 'An identified safety lead reviews the assessment.';
  const separator = '</p><p>';
  const unsupported = 'The command-link control needs a separate implementation.';
  const bytes = Buffer.from(`${prefix}${manual}${separator}${unsupported}</p></body></html>`, 'utf8');
  const sourceId = 'fictional-retained-requirements.1';
  const descriptor = {
    sourceId,
    url: 'https://fictional.invalid/requirements',
    sha256: sha256(bytes),
    byteLength: bytes.length,
    contentType: 'text/html; charset=utf-8' as const,
    readPath: `/v1/rule-sources/${sourceId}/content`,
  };
  const leaves = [
    { id: 'fictional.manual-assessment', text: manual, offset: Buffer.byteLength(prefix), coverage: 'manual' as const },
    {
      id: 'fictional.unsupported-link',
      text: unsupported,
      offset: Buffer.byteLength(`${prefix}${manual}${separator}`),
      coverage: 'unsupported' as const,
    },
  ].map((entry): RulePackLeaf => {
    const content: Omit<Extract<RulePackLeaf, { coverage: 'manual' | 'unsupported' }>, 'digest'> = {
      id: entry.id,
      version: 1,
      title: entry.text,
      source: {
        kind: 'proposed_regulation',
        reference: entry.id,
        text: entry.text,
        encoding: 'utf-8',
        byteLength: Buffer.byteLength(entry.text),
        sha256: sha256(entry.text),
        textSpan: {
          start: entry.offset,
          end: entry.offset + Buffer.byteLength(entry.text),
          unit: 'utf8_byte',
          sourceId,
        },
        document: descriptor,
      },
      review: 'ai_drafted',
      adopted: false,
      dependencies: [],
      coverage: entry.coverage,
    };
    return { ...content, digest: canonicalDigest(content) };
  });
  const content: Omit<RulePackVersion, 'digest'> = {
    packId: 'fictional.review-requirements',
    version: 1,
    title: 'Fictional retained requirements',
    status: 'draft',
    review: 'ai_drafted',
    adopted: false,
    bindings: [],
    leaves,
  };
  return {
    pack: { ...content, digest: canonicalDigest(content) },
    source: {
      sourceId,
      sha256: descriptor.sha256,
      byteLength: bytes.length,
      contentType: descriptor.contentType,
      bytesBase64: bytes.toString('base64'),
    },
  };
}

export function retainedAdoption(tenantId: string, pack: RulePackVersion): PackAdoptionRecord {
  const empty = { streams: {}, basisRevision: 0, principalRevision: 3 };
  const subjectId = `organization:${tenantId}`;
  return {
    id: 'adoption-one',
    organizationId: subjectId,
    acceptedRevision: 1,
    actor: {
      id: 'fictional-adopter',
      name: 'Fictional adoption owner',
      kind: 'simulated_person',
      principalRevision: 3,
      capabilities: ['pack:adopt'],
      checkedCapabilities: ['pack:adopt'],
      policyVersion: 'ledger.pack-adoption-authority.1',
    },
    pack: structuredClone(pack),
    scope: { kind: 'organization', organizationId: subjectId },
    effectiveInterval: { start: '2026-10-15T14:00:00.000Z', end: '2026-10-15T22:00:00.000Z' },
    note: 'Fictional adoption for this simulated operating day.',
    renderedInputCut: structuredClone(empty),
    acceptedInputCut: structuredClone(empty),
    dependencyBasis: sha256('original-adoption-basis'),
    acceptedAt: fixtureTime,
    processing: { status: 'pending' },
    state: 'pending',
    coverage: pack.leaves.map((leaf) => ({
      leafId: leaf.id,
      coverage: leaf.coverage,
      evidenceState: leaf.coverage === 'manual' ? 'manual_review_required' : 'unsupported',
    })),
  };
}

export function reviewBasis(
  tenantId: string,
  principal: Principal,
  projectedSequence = 0,
): SubjectDecisionAcceptance['basisManifest'] {
  const subjectId = `organization:${tenantId}`;
  return {
    version: 'subject-evidence.1',
    subjectId,
    principalId: principal.id,
    principalRevision: principal.revision,
    subjects: [subjectId],
    edges: [],
    frontiers: [{ subjectId, streamId: organizationStream, sequence: 1, projectedSequence }],
    authority: null,
  };
}

export function retainedReview(
  command: OrganizationDecisionCommand,
  principal: Principal,
  tenantId: string,
  id = 'review-one',
  processing: 'pending' | 'projected' = 'pending',
): SubjectDecisionRecord {
  const subject = { kind: 'organization' as const, id: `organization:${tenantId}` };
  const projected = command.inputCut.streams[organizationStream] ?? 0;
  return {
    id,
    subject,
    acceptedRevision: command.expectedRevision + 1,
    actor: {
      id: principal.id,
      name: principal.name,
      kind: 'simulated_person',
      principalRevision: principal.revision,
      capabilities: [...principal.capabilities],
      checkedCapabilities: ['decision:write'],
      policyVersion: 'ledger.organization-review-authority.1',
      historicalProfile: 'retained',
      scope: subject,
    },
    adoption: structuredClone(command.adoption),
    kind: 'adoption.review',
    note: command.decision.note,
    recordedAt: fixtureTime,
    renderedInputCut: structuredClone(command.inputCut),
    acceptedInputCut: { ...structuredClone(command.inputCut), streams: { [organizationStream]: 1 } },
    acceptedBasisRevision: command.expectedRevision,
    dependencyBasis: command.expectedDependencyBasis,
    basisManifest: reviewBasis(tenantId, principal, projected),
    processing: { status: processing },
  };
}

export function sealSubjectBundle(bundle: SubjectEvidenceBundle): SubjectEvidenceBundle {
  bundle.manifest.sectionDigests = Object.fromEntries(sections.map((name) => [name, canonicalDigest(bundle[name])]));
  bundle.manifest.interpretationDigests = Object.fromEntries(
    cutNames.map((name) => [name, canonicalDigest(bundle.interpretations[name])]),
  ) as SubjectEvidenceBundle['manifest']['interpretationDigests'];
  bundle.manifestDigest = canonicalDigest(bundle.manifest);
  return bundle;
}

export function rechainSubjectBundle(bundle: SubjectEvidenceBundle): SubjectEvidenceBundle {
  let previous = '';
  for (const entry of bundle.entries) {
    const envelope = JSON.parse(entry.canonicalEnvelope) as EvidenceEnvelope;
    entry.envelopeDigest = canonicalDigest(envelope);
    entry.previousHash = previous;
    entry.entryHash = entryHash(
      bundle.manifest.tenantId,
      envelope.streamId,
      BigInt(envelope.sequence),
      previous,
      entry.envelopeDigest,
    );
    previous = entry.entryHash;
  }
  bundle.streams[0]!.headHash = previous;
  for (const name of cutNames) {
    const position = bundle.cuts[name].streams[organizationStream] ?? 0;
    bundle.streams[0]!.cutHeads[name] = {
      sequence: String(position),
      hash: position ? bundle.entries[position - 1]!.entryHash : '',
    };
    bundle.interpretations[name] = interpretEvidenceCut(bundle.entries, bundle.cuts[name], bundle.manifest.tenantId);
  }
  return sealSubjectBundle(bundle);
}

export function subjectBundle(
  adopted: PackAdoptionRecord,
  reviewed: SubjectDecisionRecord,
  source: EvidenceRuleSource,
  exportId = 'export-one',
): SubjectEvidenceBundle {
  const {
    processing: _adoptionProcessing,
    state: _state,
    coverage: _coverage,
    ...adoption
  }: PackAdoptionRecord = structuredClone(adopted);
  const { processing: _reviewProcessing, ...decision }: SubjectDecisionRecord = structuredClone(reviewed);
  const tenantId = decision.subject.id.slice('organization:'.length);
  const { id: _adoptionId, acceptedAt: _adoptionAt, ...adoptionAcceptance }: PackAdoptionAcceptance = adoption;
  const { id: _decisionId, recordedAt: _decisionAt, ...reviewAcceptance }: SubjectDecisionAcceptance = decision;
  const reference = ({ id, version, digest }: { id: string; version: number; digest: string }) => ({
    id,
    version,
    digest,
  });
  const event = (
    id: string,
    sequence: string,
    type: string,
    principalId: string,
    payload: Record<string, unknown>,
  ): EvidenceEnvelope => ({
    eventId: id,
    tenantId,
    streamId: organizationStream,
    sequence,
    type,
    schemaVersion: 1,
    principalId,
    sourceId: null,
    sourceSessionId: null,
    occurredAt: null,
    effectiveAt: null,
    receivedAt: fixtureTime,
    causationId: null,
    artifactId: null,
    payload,
  });
  const envelopes = [
    event(adoption.id, '1', 'rule-pack.adopt', adoption.actor.id, {
      kind: 'rule-pack.adopt',
      expectedRevision: 0,
      inputCut: adoption.renderedInputCut,
      expectedDependencyBasis: adoption.dependencyBasis,
      pack: {
        packId: adoption.pack.packId,
        version: adoption.pack.version,
        digest: adoption.pack.digest,
        leaves: adoption.pack.leaves.map(reference),
        bindings: [],
      },
      effectiveInterval: adoption.effectiveInterval,
      note: adoption.note,
      acceptance: adoptionAcceptance,
    }),
    event(decision.id, '2', 'decision.record', decision.actor.id, {
      kind: 'decision.record',
      subject: { kind: 'organization' },
      expectedRevision: decision.acceptedBasisRevision,
      inputCut: decision.renderedInputCut,
      expectedDependencyBasis: decision.dependencyBasis,
      adoption: decision.adoption,
      decision: { kind: decision.kind, note: decision.note },
      acceptance: reviewAcceptance,
    }),
  ];
  const interpreterSource = readFileSync(
    new URL('../../../../tools/verifier/evidence-cut.1.mjs', import.meta.url),
    'utf8',
  );
  const runtimeContract = {
    name: 'node' as const,
    major: 24 as const,
    moduleFormat: 'esm' as const,
    dependencies: [],
    network: 'none' as const,
    interpretation: 'evidence-cut.1' as const,
    canonicalization: INTEGRITY_VERSION,
  };
  const limits = {
    maxEvents: 5000,
    maxStreams: 2000,
    maxArtifacts: 1024,
    maxArtifactBytes: 16 * 1024 * 1024,
    maxBundleBytes: 32 * 1024 * 1024,
    maxRuleSources: 4,
    maxRuleSourceBytes: 8 * 1024 * 1024,
  };
  const cuts = {
    rendered: decision.renderedInputCut,
    accepted: decision.acceptedInputCut,
    issuance: { streams: { [organizationStream]: 2 } },
  };
  const bundle: SubjectEvidenceBundle = {
    format: 'ledger.subject-evidence.2',
    manifest: {
      format: 'ledger.subject-evidence.2',
      exportId,
      tenantId,
      scope: 'whole_tenant_prefixes',
      subject: decision.subject,
      decisionId: decision.id,
      issuedBy: decision.actor.id,
      issuedAt: fixtureTime,
      versions: { integrity: INTEGRITY_VERSION, interpretation: 'evidence-cut.1', snapshot: 'thread.1' },
      counts: {
        events: 2,
        streams: 1,
        receipts: 0,
        artifacts: 0,
        artifactBytes: 0,
        ruleSources: 1,
        ruleSourceBytes: source.byteLength,
      },
      limits,
      sectionDigests: {},
      interpretationDigests: { rendered: '', accepted: '', issuance: '' },
      limitations: [],
    },
    manifestDigest: '',
    streams: [
      {
        tenantId,
        id: organizationStream,
        name: decision.subject.id,
        headSequence: '2',
        headHash: '',
        cutHeads: {
          rendered: { sequence: '0', hash: '' },
          accepted: { sequence: '1', hash: '' },
          issuance: { sequence: '2', hash: '' },
        },
      },
    ],
    entries: envelopes.map((envelope) => ({
      canonicalEnvelope: canonicalize(envelope),
      envelopeDigest: '',
      previousHash: '',
      entryHash: '',
      encodingVersion: INTEGRITY_VERSION,
    })),
    receipts: [],
    artifacts: [],
    decision,
    actor: decision.actor,
    adoption,
    ruleSources: [source],
    cuts,
    snapshot: {
      kind: 'export_time_sql_snapshot',
      capturedAt: fixtureTime,
      projectorVersion: 'thread.1',
      projectionCut: reviewed.processing.status === 'pending' ? { streams: {} } : cuts.issuance,
      projectionRevision: reviewed.processing.status === 'pending' ? 0 : 2,
      subject: decision.subject,
      organization: {
        id: decision.subject.id,
        label: 'Fictional Alpha',
        revision: decision.acceptedRevision,
        projectedRevision: reviewed.processing.status === 'pending' ? 0 : decision.acceptedRevision,
      },
      limitations: [],
    },
    interpreter: {
      name: 'evidence-cut.1',
      sourceEncoding: 'utf8',
      source: interpreterSource,
      sourceSha256: sha256(interpreterSource),
      runtimeContract,
      runtimeContractDigest: canonicalDigest(runtimeContract),
    },
    interpretations: {
      rendered: interpretEvidenceCut([], cuts.rendered, tenantId),
      accepted: interpretEvidenceCut([], cuts.accepted, tenantId),
      issuance: interpretEvidenceCut([], cuts.issuance, tenantId),
    },
  };
  return rechainSubjectBundle(bundle);
}

export function exportFixture(bundle: SubjectEvidenceBundle): { record: SubjectExportRecord; bytes: Uint8Array } {
  const bytes = new TextEncoder().encode(canonicalize(bundle));
  const summary = (name: (typeof cutNames)[number]) => ({
    eventCount: bundle.interpretations[name].events.length,
    digest: bundle.manifest.interpretationDigests[name],
    causalClosure: bundle.interpretations[name].missingCausationIds.length
      ? ('incomplete' as const)
      : ('closed' as const),
    missingCausationIds: bundle.interpretations[name].missingCausationIds,
  });
  const rendered = new Set(bundle.interpretations.rendered.events.map((event) => event.eventId));
  return {
    bytes,
    record: {
      id: bundle.manifest.exportId,
      tenantId: bundle.manifest.tenantId,
      format: bundle.format,
      subject: bundle.manifest.subject,
      decisionId: bundle.manifest.decisionId,
      issuedBy: bundle.manifest.issuedBy,
      issuedAt: bundle.manifest.issuedAt,
      scope: bundle.manifest.scope,
      byteLength: bytes.byteLength,
      bundleSha256: sha256(bytes),
      manifestDigest: bundle.manifestDigest,
      snapshotDigest: canonicalDigest(bundle.snapshot),
      anchorStatus: 'not_externally_anchored',
      interpretation: 'evidence-cut.1',
      counts: bundle.manifest.counts,
      limits: bundle.manifest.limits,
      cuts: bundle.cuts,
      interpretations: { rendered: summary('rendered'), accepted: summary('accepted'), issuance: summary('issuance') },
      addedAcceptedEventIds: bundle.interpretations.accepted.events
        .filter((event) => !rendered.has(event.eventId))
        .map((event) => event.eventId),
      limitations: [],
    },
  };
}
