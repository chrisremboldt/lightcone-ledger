import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import type {
  EvidenceEnvelope,
  PackAdoptionAcceptance,
  RulePackLeaf,
  RulePackVersion,
  SubjectDecisionAcceptance,
  SubjectEvidenceBundle,
} from '../../packages/contracts/src/index.js';
import { SubjectEvidenceBundleSchema } from '../../packages/contracts/src/subject-evidence.js';
import { getRulePackVersion, getRuleSource } from '../../packages/domain/src/rule-pack-registry.js';
import { PART108_NPRM_SOURCE_ID } from '../../packages/pack-part108-nprm/src/index.js';
import { exampleOperationsVersionOne } from '../../packages/pack-example-operations/src/index.js';
import { exampleWaiverRulePack } from '../../packages/pack-example-waiver/src/index.js';
import { buildPackFolder, verifiedPackFile } from '../../packages/standard-packs/src/index.js';
import {
  canonicalDigest,
  canonicalize,
  entryHash,
  INTEGRITY_VERSION,
  sha256,
} from '../../packages/integrity/src/index.js';
import { interpretEvidenceCut } from '../../packages/evidence/src/evidence-cut.mjs';
import { verifyBundle } from '../../tools/verifier/index.mjs';
import { MISSION_RELEASE_LIMITATION } from '../../tools/verifier/mission-release.mjs';
import { appendMissionHistory } from './mission-history-fixture.js';
import { appendMissionReleaseHistory, missionReleaseHistoryEffect } from './mission-release-history-fixture.js';
import { appendMissionDepartureHistory, missionDepartureHistoryEffect } from './mission-departure-history-fixture.js';
import { appendMissionBriefingHistory, missionBriefingHistoryEffects } from './mission-briefing-history-fixture.js';
import { appendCommandLinkBaselineHistory } from './command-link-baseline-history-fixture.js';
import { appendMonitoringWindowHistory } from './monitoring-window-history-fixture.js';
import {
  commandLinkLossSource,
  commandLinkRestorationSource,
  proposedCommandLinkLoss,
  proposedCommandLinkRestoration,
} from '../../packages/contracts/fixtures/demo/v1/proposed.js';

const tenantId = 'subject-verifier-tenant';
const subject = { kind: 'organization' as const, id: `organization:${tenantId}` };
const time = '2026-10-15T14:00:00.000Z';
const streamId = 'organization-stream';
const cutNames = ['rendered', 'accepted', 'issuance'] as const;
const sectionNames = [
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

function seal(bundle: SubjectEvidenceBundle): SubjectEvidenceBundle {
  bundle.manifest.sectionDigests = Object.fromEntries(
    sectionNames.map((name) => [name, canonicalDigest(bundle[name])]),
  );
  bundle.manifest.interpretationDigests = {
    rendered: canonicalDigest(bundle.interpretations.rendered),
    accepted: canonicalDigest(bundle.interpretations.accepted),
    issuance: canonicalDigest(bundle.interpretations.issuance),
  };
  bundle.manifestDigest = canonicalDigest(bundle.manifest);
  return bundle;
}
function rechain(bundle: SubjectEvidenceBundle): SubjectEvidenceBundle {
  let previous = '';
  for (const entry of bundle.entries) {
    const envelope = JSON.parse(entry.canonicalEnvelope) as EvidenceEnvelope;
    entry.envelopeDigest = canonicalDigest(envelope);
    entry.previousHash = previous;
    entry.entryHash = entryHash(tenantId, streamId, BigInt(envelope.sequence), previous, entry.envelopeDigest);
    previous = entry.entryHash;
  }
  bundle.streams[0].headHash = previous;
  for (const name of cutNames) {
    const position = bundle.cuts[name].streams[streamId] ?? 0;
    bundle.streams[0].cutHeads[name] = {
      sequence: String(position),
      hash: position === 0 ? '' : bundle.entries[position - 1].entryHash,
    };
    bundle.interpretations[name] = interpretEvidenceCut(bundle.entries, bundle.cuts[name], tenantId);
  }
  return seal(bundle);
}
function updateReviewEvent(bundle: SubjectEvidenceBundle): void {
  const envelope = JSON.parse(bundle.entries[1].canonicalEnvelope) as EvidenceEnvelope;
  const { id: _id, recordedAt: _time, ...acceptance } = bundle.decision;
  envelope.payload.acceptance = acceptance;
  envelope.payload.expectedDependencyBasis = bundle.decision.dependencyBasis;
  envelope.payload.adoption = bundle.decision.adoption;
  envelope.payload.inputCut = bundle.decision.renderedInputCut;
  bundle.entries[1].canonicalEnvelope = canonicalize(envelope);
  rechain(bundle);
}
async function fixture(
  options: { version?: number; mode?: 'shadow' | 'active'; pack?: RulePackVersion } = {},
): Promise<SubjectEvidenceBundle> {
  const pack = options.pack ?? getRulePackVersion('ledger.part108-nprm', options.version ?? 1)!;
  const quotesDocument = pack.leaves.some((leaf) => 'document' in leaf.source);
  const sources = quotesDocument ? [(await getRuleSource(PART108_NPRM_SOURCE_ID))!] : [];
  const empty = { streams: {}, basisRevision: 0, principalRevision: 1 };
  const adoption: PackAdoptionAcceptance = {
    id: 'adoption-one',
    organizationId: subject.id,
    acceptedRevision: 1,
    actor: {
      id: 'adopter',
      name: 'Adoption owner',
      kind: 'human',
      principalRevision: 1,
      capabilities: ['pack:adopt'],
      checkedCapabilities: ['pack:adopt'],
      policyVersion: 'ledger.pack-adoption-authority.1',
    },
    pack,
    scope: { kind: 'organization', organizationId: subject.id },
    effectiveInterval: { start: time, end: '2026-10-16T14:00:00.000Z' },
    note: 'Original adoption',
    renderedInputCut: empty,
    acceptedInputCut: empty,
    dependencyBasis: 'a'.repeat(64),
    acceptedAt: time,
    ...(options.mode ? { mode: options.mode } : {}),
  };
  const basisManifest: SubjectDecisionAcceptance['basisManifest'] = {
    version: 'subject-evidence.1',
    subjectId: subject.id,
    principalId: 'reviewer',
    principalRevision: 1,
    subjects: [subject.id],
    edges: [],
    frontiers: [{ subjectId: subject.id, streamId, sequence: 1, projectedSequence: 1 }],
    authority: null,
  };
  const displayed = { streams: { [streamId]: 1 }, basisRevision: 1, principalRevision: 1 };
  const citation = {
    id: adoption.id,
    acceptedRevision: 1,
    pack: { packId: pack.packId, version: pack.version, digest: pack.digest },
  };
  const decision: SubjectDecisionAcceptance = {
    id: 'review-one',
    subject,
    acceptedRevision: 2,
    actor: {
      id: 'reviewer',
      name: 'Review owner',
      kind: 'human',
      principalRevision: 1,
      capabilities: ['decision:write'],
      checkedCapabilities: ['decision:write'],
      policyVersion: 'ledger.organization-review-authority.1',
      historicalProfile: 'retained',
      scope: subject,
    },
    adoption: citation,
    kind: 'adoption.review',
    note: 'Private review note',
    recordedAt: time,
    renderedInputCut: displayed,
    acceptedInputCut: displayed,
    acceptedBasisRevision: 1,
    dependencyBasis: canonicalDigest(basisManifest),
    basisManifest,
  };
  const { id: _adoptionId, acceptedAt: _acceptedAt, ...adopted } = adoption;
  const { id: _decisionId, recordedAt: _recordedAt, ...accepted } = decision;
  const reference = ({ id, version, digest }: { id: string; version: number; digest: string }) => ({
    id,
    version,
    digest,
  });
  const envelope = (
    id: string,
    sequence: string,
    type: string,
    principalId: string,
    payload: Record<string, unknown>,
  ): EvidenceEnvelope => ({
    eventId: id,
    tenantId,
    streamId,
    sequence,
    type,
    schemaVersion: 1,
    principalId,
    sourceId: null,
    sourceSessionId: null,
    occurredAt: null,
    effectiveAt: null,
    receivedAt: time,
    causationId: null,
    artifactId: null,
    payload,
  });
  const envelopes = [
    envelope(adoption.id, '1', 'rule-pack.adopt', 'adopter', {
      kind: 'rule-pack.adopt',
      expectedRevision: 0,
      inputCut: empty,
      expectedDependencyBasis: adoption.dependencyBasis,
      pack: {
        packId: pack.packId,
        version: pack.version,
        digest: pack.digest,
        leaves: pack.leaves.map(reference),
        bindings: [],
      },
      effectiveInterval: adoption.effectiveInterval,
      note: adoption.note,
      ...(options.mode ? { mode: options.mode } : {}),
      acceptance: adopted,
    }),
    envelope(decision.id, '2', 'decision.record', 'reviewer', {
      kind: 'decision.record',
      subject: { kind: 'organization' },
      expectedRevision: 1,
      inputCut: displayed,
      expectedDependencyBasis: decision.dependencyBasis,
      adoption: citation,
      decision: { kind: decision.kind, note: decision.note },
      acceptance: accepted,
    }),
  ];
  const interpreterSource = readFileSync(
    new URL('../../packages/evidence/src/evidence-cut.mjs', import.meta.url),
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
  const bundle: SubjectEvidenceBundle = {
    format: 'ledger.subject-evidence.2',
    manifest: {
      format: 'ledger.subject-evidence.2',
      exportId: 'export-one',
      tenantId,
      scope: 'whole_tenant_prefixes',
      subject,
      decisionId: decision.id,
      issuedBy: 'reviewer',
      issuedAt: time,
      versions: { integrity: INTEGRITY_VERSION, interpretation: 'evidence-cut.1', snapshot: 'thread.1' },
      counts: {
        events: 2,
        streams: 1,
        receipts: 0,
        artifacts: 0,
        artifactBytes: 0,
        ruleSources: sources.length,
        ruleSourceBytes: sources.reduce((sum, source) => sum + source.byteLength, 0),
      },
      limits: {
        maxEvents: 5000,
        maxStreams: 2000,
        maxArtifacts: 1024,
        maxArtifactBytes: 16 * 1024 * 1024,
        maxBundleBytes: 32 * 1024 * 1024,
        maxRuleSources: 4,
        maxRuleSourceBytes: 8 * 1024 * 1024,
      },
      sectionDigests: {},
      interpretationDigests: { rendered: '', accepted: '', issuance: '' },
      limitations: [],
    },
    manifestDigest: '',
    streams: [
      {
        tenantId,
        id: streamId,
        name: subject.id,
        headSequence: '2',
        headHash: '',
        cutHeads: {
          rendered: { sequence: '1', hash: '' },
          accepted: { sequence: '1', hash: '' },
          issuance: { sequence: '2', hash: '' },
        },
      },
    ],
    entries: envelopes.map((event) => ({
      canonicalEnvelope: canonicalize(event),
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
    ruleSources: sources.map((source) => ({
      sourceId: source.sourceId,
      sha256: source.sha256,
      byteLength: source.byteLength,
      contentType: source.contentType,
      bytesBase64: source.bytes.toString('base64'),
    })),
    cuts: { rendered: displayed, accepted: displayed, issuance: { streams: { [streamId]: 2 } } },
    snapshot: {
      kind: 'export_time_sql_snapshot',
      capturedAt: time,
      projectorVersion: 'thread.1',
      projectionCut: { streams: { [streamId]: 2 } },
      projectionRevision: 2,
      subject,
      organization: { id: subject.id, label: 'Fictional operator', revision: 2, projectedRevision: 2 },
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
      rendered: interpretEvidenceCut([], displayed, tenantId),
      accepted: interpretEvidenceCut([], displayed, tenantId),
      issuance: interpretEvidenceCut([], { streams: { [streamId]: 2 } }, tenantId),
    },
  };
  return rechain(bundle);
}
/** Changes a retained leaf, then re-anchors the pack, the adoption event and the review citation to the change. */
function reanchorLeaf(bundle: SubjectEvidenceBundle, leafId: string, change: (leaf: RulePackLeaf) => void): void {
  const pack = structuredClone(bundle.adoption.pack);
  const leaf = pack.leaves.find((candidate) => candidate.id === leafId)!;
  change(leaf);
  const { digest: _leafDigest, ...leafContent } = leaf;
  leaf.digest = canonicalDigest(leafContent);
  const { digest: _packDigest, ...packContent } = pack;
  pack.digest = canonicalDigest(packContent);
  bundle.adoption.pack = pack;
  bundle.decision.adoption.pack.digest = pack.digest;
  const envelope = JSON.parse(bundle.entries[0].canonicalEnvelope) as EvidenceEnvelope;
  const { id: _id, acceptedAt: _acceptedAt, ...acceptance } = bundle.adoption;
  envelope.payload.acceptance = acceptance;
  envelope.payload.pack = {
    ...(envelope.payload.pack as Record<string, unknown>),
    digest: pack.digest,
    leaves: pack.leaves.map(({ id, version, digest }) => ({ id, version, digest })),
  };
  bundle.entries[0].canonicalEnvelope = canonicalize(envelope);
  updateReviewEvent(bundle);
}
function verify(bundle: SubjectEvidenceBundle) {
  return verifyBundle(bundle, { expectedManifestDigest: bundle.manifestDigest });
}
function failure(bundle: SubjectEvidenceBundle): string {
  try {
    verify(bundle);
    return 'unexpected_success';
  } catch (error) {
    return (error as { issues: { code: string }[] }).issues[0].code;
  }
}

describe('subject evidence acceptance and retained-basis verification', () => {
  it('verifies organization monitoring receipts and referenced histories without replacing the selected review basis', async () => {
    const original = await fixture();
    const selected = structuredClone({
      decision: original.decision,
      actor: original.actor,
      adoption: original.adoption,
    });
    const bundle = appendMonitoringWindowHistory(original);
    const result = verify(bundle);
    expect(result.status).toBe('verified');
    expect(result.counts).toMatchObject({ events: 10, receipts: 8, artifacts: 8 });
    expect(
      result.replays.issuance.output.events.filter((event: { type: string }) => event.type === 'monitoring.window'),
    ).toHaveLength(2);
    expect(bundle.receipts.find((receipt) => receipt.id === 'monitoring-receipt-0')!.inputSubject).toEqual({
      organizationId: subject.id,
    });
    expect(bundle.decision).toEqual(selected.decision);
    expect(bundle.actor).toEqual(selected.actor);
    expect(bundle.adoption).toEqual(selected.adoption);
  });
  it('verifies native baseline receipts throughout organization prefixes without replacing selected review commitments', async () => {
    const original = await fixture();
    const selected = structuredClone({
      decision: original.decision,
      actor: original.actor,
      adoption: original.adoption,
    });
    const bundle = appendCommandLinkBaselineHistory(original);
    const result = verify(bundle);
    expect(result.status).toBe('verified');
    expect(result.counts).toMatchObject({ events: 6, receipts: 4, artifacts: 4 });
    expect(
      result.replays.issuance.output.events.filter((event: { type: string }) => event.type === 'command-link.baseline'),
    ).toHaveLength(2);
    expect(bundle.receipts.find((receipt) => receipt.id === 'native-c2-receipt-0')!.inputSubject).toEqual({
      flightId: 'unrelated-native-flight',
    });
    expect(bundle.decision).toEqual(selected.decision);
    expect(bundle.actor).toEqual(selected.actor);
    expect(bundle.adoption).toEqual(selected.adoption);
  });
  it('verifies unrelated planned mission receipts without changing the retained organization review basis', async () => {
    const original = await fixture();
    const selected = structuredClone({
      decision: original.decision,
      actor: original.actor,
      adoption: original.adoption,
    });
    const bundle = appendMissionHistory(original);
    const result = verify(bundle);
    expect(result.status).toBe('verified');
    expect(result.counts).toMatchObject({ events: 4, receipts: 2, artifacts: 2 });
    expect(
      result.replays.issuance.output.events.filter((event: { type: string }) => event.type === 'mission.revision'),
    ).toHaveLength(2);
    expect(bundle.decision).toEqual(selected.decision);
    expect(bundle.actor).toEqual(selected.actor);
    expect(bundle.adoption).toEqual(selected.adoption);
  });
  it('retains mission releases as nonreceipt inventory without replacing the selected organization review', async () => {
    const original = await fixture();
    const originalBytes = canonicalize(original);
    const effect = missionReleaseHistoryEffect(tenantId);
    expect(verify(original).limitations.join(' ')).not.toContain('Recorded mission releases');
    const bundle = appendMissionReleaseHistory(structuredClone(original));
    const result = verify(bundle);
    expect(result.status).toBe('verified');
    expect(result.decisionId).toBe(original.decision.id);
    expect(result.counts).toMatchObject({ events: 3, receipts: 0, artifacts: 0 });
    expect(bundle.entries.some((entry) => entry.canonicalEnvelope === canonicalize(effect))).toBe(true);
    expect(result.replays.issuance.output.events).toContainEqual(
      expect.objectContaining({ eventId: effect.eventId, type: 'mission.release' }),
    );
    expect(result.replays.accepted.output).toEqual(original.interpretations.accepted);
    expect(bundle.decision).toEqual(original.decision);
    expect(bundle.actor).toEqual(original.actor);
    expect(bundle.adoption).toEqual(original.adoption);
    expect(result.limitations).toContain(MISSION_RELEASE_LIMITATION);
    expect(bundle.manifest.limitations.join(' ')).not.toContain('Recorded mission releases');
    expect(canonicalize(original)).toBe(originalBytes);
  });
  it('retains departure authorizations opaquely without replacing the selected organization review', async () => {
    const original = await fixture();
    const originalBytes = canonicalize(original);
    const effect = missionDepartureHistoryEffect(tenantId);
    expect(verify(original).limitations.join(' ')).not.toContain('Recorded departure authorizations');
    const bundle = appendMissionDepartureHistory(structuredClone(original));
    const result = verify(bundle);
    expect(result.status).toBe('verified');
    expect(result.decisionId).toBe(original.decision.id);
    expect(result.counts).toMatchObject({ events: 4, receipts: 0, artifacts: 0 });
    expect(bundle.entries.some((entry) => entry.canonicalEnvelope === canonicalize(effect))).toBe(true);
    expect(result.replays.issuance.output.events).toContainEqual(
      expect.objectContaining({ eventId: effect.eventId, type: 'mission.departure-authorize' }),
    );
    expect(result.replays.accepted.output).toEqual(original.interpretations.accepted);
    expect(bundle.decision).toEqual(original.decision);
    expect(bundle.actor).toEqual(original.actor);
    expect(bundle.adoption).toEqual(original.adoption);
    expect(result.limitations).toContain(
      'Recorded departure authorizations are opaque journal inventory; this format does not verify authorization eligibility, current lease validity, resource allocation, operation fit or departure consumption.',
    );
    expect(bundle.manifest.limitations.join(' ')).not.toContain('Recorded departure authorizations');
    expect(canonicalize(original)).toBe(originalBytes);
  });
  it('retains briefings and personal acknowledgements opaquely without replacing the selected organization review', async () => {
    const original = await fixture();
    const originalBytes = canonicalize(original);
    const effects = missionBriefingHistoryEffects(tenantId);
    expect(verify(original).limitations.join(' ')).not.toContain('Mission briefings and acknowledgements');
    const bundle = appendMissionBriefingHistory(structuredClone(original));
    const result = verify(bundle);
    expect(result.status).toBe('verified');
    expect(result.decisionId).toBe(original.decision.id);
    expect(result.counts).toMatchObject({ events: 5, receipts: 0, artifacts: 0 });
    for (const effect of effects) {
      expect(bundle.entries.some((entry) => entry.canonicalEnvelope === canonicalize(effect))).toBe(true);
      expect(result.replays.issuance.output.events).toContainEqual(
        expect.objectContaining({ eventId: effect.eventId, type: effect.type, principalId: effect.principalId }),
      );
    }
    expect(result.replays.accepted.output).toEqual(original.interpretations.accepted);
    expect(bundle.decision).toEqual(original.decision);
    expect(bundle.actor).toEqual(original.actor);
    expect(bundle.adoption).toEqual(original.adoption);
    expect(result.limitations).toContain(
      'Mission briefings and acknowledgements are opaque journal inventory; this format does not verify personal review, message delivery, operational-crew coverage, control implementation or current release/departure validity.',
    );
    expect(bundle.manifest.limitations.join(' ')).not.toContain('Mission briefings and acknowledgements');
    expect(canonicalize(original)).toBe(originalBytes);
  });
  it('verifies unrelated source-authorized command-link bytes within an organization whole-tenant bundle', async () => {
    const bundle = await fixture();
    const linkStream = 'unrelated-link-stream';
    let previous = '';
    for (const [index, input] of [proposedCommandLinkLoss, proposedCommandLinkRestoration].entries()) {
      const raw = index === 0 ? commandLinkLossSource : commandLinkRestorationSource;
      const envelope: EvidenceEnvelope = {
        eventId: `link-event-${index}`,
        tenantId,
        streamId: linkStream,
        sequence: String(index + 1),
        type: input.kind,
        schemaVersion: 1,
        principalId: 'link-adapter',
        sourceId: input.sourceId,
        sourceSessionId: input.sourceSessionId,
        occurredAt: input.occurredAt,
        effectiveAt: null,
        receivedAt: time,
        causationId: null,
        artifactId: input.artifactId,
        payload: {
          ...input,
          acceptedAuthority: {
            version: 'ledger.command-link-authority.1',
            principalId: 'link-adapter',
            tenantId,
            principalRevision: 1,
            inputKind: input.kind,
            sourceId: input.sourceId,
            requiredCapabilities: ['input:write', 'command-link:write'],
            grantedSources: [input.sourceId],
          },
        },
      };
      const canonicalEnvelope = canonicalize(envelope);
      const envelopeDigest = canonicalDigest(envelope);
      const hash = entryHash(tenantId, linkStream, BigInt(index + 1), previous, envelopeDigest);
      bundle.entries.push({
        canonicalEnvelope,
        envelopeDigest,
        previousHash: previous,
        entryHash: hash,
        encodingVersion: INTEGRITY_VERSION,
      });
      previous = hash;
      const bytes = Buffer.from(JSON.stringify(raw), 'utf8');
      bundle.artifacts.push({
        tenantId,
        id: input.artifactId,
        sha256: sha256(bytes),
        byteLength: bytes.length,
        contentType: 'application/json',
        bytesBase64: bytes.toString('base64'),
      });
      bundle.receipts.push({
        tenantId,
        id: `link-receipt-${index}`,
        eventId: envelope.eventId,
        sourceId: input.sourceId,
        kind: input.kind,
        occurredAt: input.occurredAt,
        receivedAt: time,
        sourceRevision: null,
        artifactId: input.artifactId,
        payload: input.payload,
        inputSubject: input.subject,
      });
    }
    bundle.streams.push({
      tenantId,
      id: linkStream,
      name: 'source:link-adapter:command-link:session',
      headSequence: '2',
      headHash: previous,
      cutHeads: {
        rendered: { sequence: '0', hash: '' },
        accepted: { sequence: '0', hash: '' },
        issuance: { sequence: '2', hash: previous },
      },
    });
    bundle.cuts.issuance.streams[linkStream] = 2;
    bundle.manifest.counts.events = bundle.entries.length;
    bundle.manifest.counts.streams = bundle.streams.length;
    bundle.manifest.counts.receipts = bundle.receipts.length;
    bundle.manifest.counts.artifacts = bundle.artifacts.length;
    bundle.manifest.counts.artifactBytes = bundle.artifacts.reduce((sum, artifact) => sum + artifact.byteLength, 0);
    for (const name of cutNames)
      bundle.interpretations[name] = interpretEvidenceCut(bundle.entries, bundle.cuts[name], tenantId);
    seal(bundle);
    expect(verify(bundle).status).toBe('verified');
  });
  it('verifies the public v2 contract and all three inventories offline using the unchanged interpreter', async () => {
    const bundle = await fixture();
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(SubjectEvidenceBundleSchema);
    expect(validate(bundle), JSON.stringify(validate.errors)).toBe(true);
    expect(verify(bundle)).toMatchObject({ status: 'verified', format: 'ledger.subject-evidence.2', subject });
    const directory = mkdtempSync(join(tmpdir(), 'ledger-subject-verifier-'));
    try {
      cpSync(new URL('../../tools/verifier/', import.meta.url), join(directory, 'verifier'), { recursive: true });
      writeFileSync(join(directory, 'bundle.json'), canonicalize(bundle));
      const stdout = execFileSync(
        process.execPath,
        [
          join(directory, 'verifier/cli.mjs'),
          join(directory, 'bundle.json'),
          '--expected-manifest-sha256',
          bundle.manifestDigest,
          '--rebuild-dir',
          join(directory, 'rebuilt'),
        ],
        { encoding: 'utf8', cwd: directory, env: {} },
      );
      expect(JSON.parse(stdout).status).toBe('verified');
      expect(stdout).not.toContain('Private review note');
      for (const name of cutNames)
        expect(JSON.parse(readFileSync(join(directory, 'rebuilt', `${name}.json`), 'utf8'))).toEqual(
          bundle.interpretations[name],
        );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('rejects self-consistently reanchored authority, citation and basis inconsistencies', async () => {
    const unauthorized = await fixture();
    unauthorized.actor.capabilities = [];
    updateReviewEvent(unauthorized);
    expect(failure(unauthorized)).toBe('authority_policy');
    const uncited = await fixture();
    uncited.decision.adoption.pack.digest = '0'.repeat(64);
    updateReviewEvent(uncited);
    expect(failure(uncited)).toBe('adoption_citation');
    const changedBasis = await fixture();
    changedBasis.decision.basisManifest.frontiers[0].projectedSequence = 0;
    changedBasis.decision.dependencyBasis = canonicalDigest(changedBasis.decision.basisManifest);
    updateReviewEvent(changedBasis);
    expect(failure(changedBasis)).toBe('basis_cut');
    const futureBasis = await fixture();
    futureBasis.decision.acceptedInputCut = { ...futureBasis.decision.acceptedInputCut, streams: { [streamId]: 2 } };
    futureBasis.cuts.accepted = futureBasis.decision.acceptedInputCut;
    futureBasis.decision.basisManifest.frontiers[0].sequence = 2;
    futureBasis.decision.dependencyBasis = canonicalDigest(futureBasis.decision.basisManifest);
    updateReviewEvent(futureBasis);
    expect(failure(futureBasis)).toBe('basis_cut');
  });
  it('verifies an explicitly cited pending adoption without equating rendered and accepted cuts', async () => {
    const bundle = await fixture();
    bundle.decision.renderedInputCut = { ...bundle.decision.renderedInputCut, streams: { [streamId]: 0 } };
    bundle.cuts.rendered = bundle.decision.renderedInputCut;
    bundle.decision.basisManifest.frontiers[0].projectedSequence = 0;
    bundle.decision.dependencyBasis = canonicalDigest(bundle.decision.basisManifest);
    bundle.snapshot.organization.projectedRevision = 0;
    bundle.snapshot.projectionCut = { streams: {} };
    updateReviewEvent(bundle);
    expect(verify(bundle).status).toBe('verified');
  });
  it('verifies a shadow adoption of automated rules that quote a retained document, and refuses a moved quote', async () => {
    const bundle = await fixture({ version: 2, mode: 'shadow' });
    const quoted = bundle.adoption.pack.leaves.filter(
      (leaf) => leaf.coverage === 'automated' && 'document' in leaf.source,
    );
    expect(quoted.length).toBeGreaterThan(0);
    expect(verify(bundle)).toMatchObject({ status: 'verified', counts: { ruleSources: 1 } });

    const moved = await fixture({ version: 2, mode: 'shadow' });
    reanchorLeaf(moved, quoted[0]!.id, (leaf) => {
      leaf.source.textSpan = { ...leaf.source.textSpan, start: leaf.source.textSpan.start + 1 };
    });
    expect(failure(moved)).toBe('leaf_source');

    const bound = await fixture({ version: 2, mode: 'shadow' });
    reanchorLeaf(bound, quoted[0]!.id, (leaf) => Object.assign(leaf, { bindingId: 'fabricated-binding' }));
    expect(failure(bound)).toBe('leaf_coverage');
  });
  it('verifies adoptions of checked rules that quote an operator procedure or a waiver, and refuses a changed quote', async () => {
    for (const pack of [exampleOperationsVersionOne(), exampleWaiverRulePack().versions[0]!]) {
      const procedures = pack.leaves.filter(
        (leaf) =>
          leaf.coverage === 'automated' && ['operator_procedure', 'waiver_or_exemption'].includes(leaf.source.kind),
      );
      expect(procedures.length).toBeGreaterThan(0);
      expect(verify(await fixture({ pack, mode: 'active' }))).toMatchObject({
        status: 'verified',
        counts: { ruleSources: 0 },
      });

      const changed = await fixture({ pack, mode: 'active' });
      reanchorLeaf(changed, procedures[0]!.id, (leaf) => {
        leaf.source.text = `${leaf.source.text} Except at night.`;
      });
      expect(failure(changed)).toBe('leaf_source');

      const overrun = await fixture({ pack, mode: 'active' });
      reanchorLeaf(overrun, procedures[0]!.id, (leaf) => {
        leaf.source.textSpan = { ...leaf.source.textSpan, end: leaf.source.byteLength + 1 };
      });
      expect(failure(overrun)).toBe('leaf_source');

      const bound = await fixture({ pack, mode: 'active' });
      reanchorLeaf(bound, procedures[0]!.id, (leaf) => Object.assign(leaf, { bindingId: 'fabricated-binding' }));
      expect(failure(bound)).toBe('leaf_coverage');

      const undefinedCheck = await fixture({ pack, mode: 'active' });
      reanchorLeaf(undefinedCheck, procedures[0]!.id, (leaf) =>
        Object.assign(leaf, { check: { ...(leaf as { check: object }).check, definitionDigest: '' } }),
      );
      expect(failure(undefinedCheck)).toBe('leaf_check');
    }
  });
  it('verifies an adopted pack file whose provisions a person checks, and refuses a changed or partial quote', async () => {
    const built = buildPackFolder(
      fileURLToPath(new URL('../../packages/standard-packs/examples/invented-waiver/', import.meta.url)),
    );
    const pack = verifiedPackFile(built.file).version;
    const manual = pack.leaves.find((leaf) => leaf.coverage === 'manual')!;
    expect(manual.source.kind).toBe('waiver_or_exemption');
    expect(verify(await fixture({ pack, mode: 'active' }))).toMatchObject({ status: 'verified' });

    const changed = await fixture({ pack, mode: 'active' });
    reanchorLeaf(changed, manual.id, (leaf) => {
      leaf.source.text = `${leaf.source.text} Except at night.`;
    });
    expect(failure(changed)).toBe('leaf_source');

    const partial = await fixture({ pack, mode: 'active' });
    reanchorLeaf(partial, manual.id, (leaf) => {
      leaf.source.textSpan = { ...leaf.source.textSpan, start: 1 };
    });
    expect(failure(partial)).toBe('leaf_source');
  });
  it('checks original source bytes and same-tenant subject scope independently of a replacement anchor', async () => {
    const source = await fixture();
    const bytes = Buffer.from(source.ruleSources[0].bytesBase64, 'base64');
    bytes[0] ^= 1;
    source.ruleSources[0].bytesBase64 = bytes.toString('base64');
    seal(source);
    expect(failure(source)).toBe('rule_source_bytes');
    const foreign = await fixture();
    foreign.manifest.subject = { kind: 'organization', id: 'organization:another-tenant' };
    seal(foreign);
    expect(failure(foreign)).toBe('subject_scope');
  });
});
