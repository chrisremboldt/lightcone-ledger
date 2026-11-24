import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  subjectReferenceKey,
  type CheckedRuleLeaf,
  type EvidenceEnvelope,
  type RuleEvaluationRecord,
  type RulePackVersion,
} from '../../packages/contracts/src/index.js';
import { canonicalDigest, canonicalize, entryHash, INTEGRITY_VERSION } from '../../packages/integrity/src/index.js';
import { findCheckKind } from '../../packages/domain/src/check-kinds.js';
import { defineCheckedRule } from '../../packages/domain/src/checked-rules.js';
import { findingOrigin, ruleEvaluationView } from '../../packages/domain/src/sms-origins.js';
import type { FindingPacketSources, PacketEvent } from '../../packages/evidence/src/finding-packet-assembly.js';

// One made-up finding with every kind of record a finding packet holds: an evaluation of a toy rule adopted in a
// toy pack, the observation it read with its receipt and source, a withdrawn earlier reading, a hazard opened from the
// finding and its assessment. The rule is the toy rule unless a caller passes another rule and its pack.
const tenantId = 'toy-tenant';
const organizationId = `organization:${tenantId}`;
const subject = { scope: 'source' as const, kind: 'aircraft' as const, id: 'toy-tail-1', sourceId: 'toy-sensor' };
const streams = { source: 'toy-source-stream', organization: 'toy-organization-stream', correction: 'toy-correction' };

function packetEvent(
  id: string,
  type: string,
  streamId: string,
  sequence: number,
  payload: Record<string, unknown>,
  extra: Partial<EvidenceEnvelope> = {},
  previous?: PacketEvent,
): PacketEvent {
  const envelope: EvidenceEnvelope = {
    eventId: id,
    tenantId,
    streamId,
    sequence: String(sequence),
    type,
    schemaVersion: 1,
    principalId: 'toy-principal',
    sourceId: null,
    sourceSessionId: null,
    occurredAt: null,
    effectiveAt: null,
    receivedAt: '2026-11-02T10:20:00.000Z',
    causationId: null,
    artifactId: null,
    payload,
    ...extra,
  };
  const envelopeDigest = canonicalDigest(envelope);
  const previousHash = previous?.entry.entryHash ?? '';
  return {
    envelope,
    entry: {
      canonicalEnvelope: canonicalize(envelope),
      envelopeDigest,
      previousHash,
      entryHash: entryHash(tenantId, streamId, BigInt(sequence), previousHash, envelopeDigest),
      encodingVersion: INTEGRITY_VERSION,
    },
  };
}

export function toyRule(
  sourceKind: 'operator_procedure' | 'proposed_regulation' = 'operator_procedure',
): CheckedRuleLeaf {
  return defineCheckedRule({
    id: 'toy.rotor-icing-packet-floor',
    version: 1,
    title: 'Outside air stays above the icing floor',
    source:
      sourceKind === 'proposed_regulation'
        ? {
            kind: 'proposed_regulation',
            reference: 'Toy proposed rule 1',
            text: 'Toy proposed text: stop at the icing floor.',
          }
        : { kind: 'operator_procedure', reference: 'Toy procedure 3', text: 'Stop at the icing floor.' },
    target: { subjectKind: 'aircraft' },
    reads: [{ name: 'subject', type: 'rotor.icing', versions: [1], about: 'target', required: true, select: 'latest' }],
    check: {
      kind: findCheckKind('value.within-limit', 1)!,
      params: { field: 'values.outsideAirTemperatureCelsius', comparison: 'above', limit: 0 },
    },
  } as Parameters<typeof defineCheckedRule>[0]);
}

export function toyPack(leaf: CheckedRuleLeaf): RulePackVersion {
  const content = {
    packId: 'toy.rotor-icing-packets',
    version: 1,
    title: 'Toy rotor icing procedures',
    status: 'draft' as const,
    review: 'ai_drafted' as const,
    adopted: false as const,
    bindings: [],
    leaves: [leaf],
  };
  return { ...content, digest: canonicalDigest(content) };
}

export interface ToyFinding {
  sources: FindingPacketSources;
  evaluation: RuleEvaluationRecord;
  pack: RulePackVersion;
}

export interface ToyFindingOptions {
  /** The adoption's mode. */
  mode?: 'shadow' | 'active';
  /** The kind of the toy rule's text. */
  sourceKind?: 'operator_procedure' | 'proposed_regulation';
  /** Another rule in its pack, the observation type it reads and its adopted parameters, in place of the toy rule. */
  rule?: { leaf: CheckedRuleLeaf; pack: RulePackVersion; observationType: string; parameters?: object };
  /** The subject state the evaluation recorded. */
  subjectState?: RuleEvaluationRecord['subjectState'];
}

/** A toy finding's packet sources. */
export function toyFinding(options: ToyFindingOptions = {}): ToyFinding {
  const leaf = options.rule?.leaf ?? toyRule(options.sourceKind);
  const pack = options.rule?.pack ?? toyPack(leaf);
  const observationType = options.rule?.observationType ?? 'rotor.icing';
  const mode = options.mode ?? 'active';
  const interval = { start: '2026-11-01T00:00:00.000Z', end: '2026-12-01T00:00:00.000Z' };
  const adoption = packetEvent('toy-adoption', 'rule-pack.adopt', streams.organization, 1, {
    acceptance: {
      organizationId,
      acceptedRevision: 1,
      actor: {
        id: 'toy-principal',
        name: 'Toy safety lead',
        kind: 'human',
        principalRevision: 1,
        capabilities: ['pack:adopt'],
        checkedCapabilities: ['pack:adopt'],
        policyVersion: 'ledger.pack-adoption-authority.1',
      },
      pack,
      scope: { kind: 'organization', organizationId },
      effectiveInterval: interval,
      note: 'Adopt the toy procedures.',
      mode,
      renderedInputCut: { streams: {}, basisRevision: 0 },
      acceptedInputCut: { streams: {}, basisRevision: 0 },
      dependencyBasis: canonicalDigest({ toy: 'adoption-basis' }),
    },
  });
  const withdrawn = packetEvent(
    'toy-observation-0',
    'observation',
    streams.source,
    1,
    { reading: 'earlier' },
    {
      artifactId: 'toy-artifact-0',
    },
  );
  const read = packetEvent(
    'toy-observation-1',
    'observation',
    streams.source,
    2,
    { reading: 'latest' },
    {
      artifactId: 'toy-artifact-1',
    },
    withdrawn,
  );
  const withdrawal = packetEvent('toy-withdrawal', 'observation.withdraw', streams.correction, 1, {
    observationId: 'toy-observation-0',
  });
  const recorded: Omit<RuleEvaluationRecord, 'recordedAt'> = {
    version: 'ledger.rule-evaluation.1',
    id: 'toy-evaluation-1',
    subject,
    subjectKey: subjectReferenceKey(subject),
    organizationId,
    adoption: { id: 'toy-adoption', acceptedRevision: 1, effectiveInterval: interval, mode },
    pack: { id: pack.packId, version: pack.version, digest: pack.digest },
    rule: { id: leaf.id, version: leaf.version, digest: leaf.digest, title: leaf.title, source: leaf.source },
    check: { kind: leaf.check.kind, version: leaf.check.version, definitionDigest: leaf.check.definitionDigest },
    parameters: { ...leaf.check.params, ...options.rule?.parameters },
    applicability: 'applicable',
    evidenceState: 'supported',
    outcome: 'attention',
    reasonCode: 'value_outside_limit',
    summary: 'The toy reading is below the icing floor.',
    evidence: [
      {
        observationId: 'toy-observation-1',
        eventId: 'toy-observation-1',
        receiptId: 'toy-receipt-1',
        sourceId: subject.sourceId,
        type: observationType,
        version: 1,
        occurredAt: '2026-11-02T10:15:00.000Z',
      },
    ],
    inputs: [
      {
        name: 'subject',
        type: observationType,
        about: 'target',
        required: true,
        observationIds: ['toy-observation-1'],
        truncated: false,
      },
    ],
    clock: { mode: 'wall', evaluatedAt: '2026-11-02T10:20:00.000Z' },
    trigger: { kind: 'observation', eventId: 'toy-observation-1' },
    inputCut: { streams: { [streams.source]: 2, [streams.organization]: 1, [streams.correction]: 1 } },
    dependencyBasis: canonicalDigest({ toy: 'basis' }),
    observationDigest: canonicalDigest({ toy: 'observations' }),
    inputDigest: canonicalDigest({ toy: 'inputs' }),
    ...(options.subjectState ? { subjectState: options.subjectState } : {}),
  };
  const evaluationEvent = packetEvent('toy-evaluation-1', 'rule-evaluation.recorded', 'toy-evaluation-stream', 1, {
    evaluation: recorded,
  });
  const evaluation: RuleEvaluationRecord = { ...recorded, recordedAt: evaluationEvent.envelope.receivedAt };
  const finding = {
    id: 'toy-finding-1',
    subject,
    subjectKey: evaluation.subjectKey,
    packId: pack.packId,
    ruleId: leaf.id,
    openedAt: evaluation.recordedAt,
    initialEvaluationId: evaluation.id,
    latestEvaluationId: evaluation.id,
    status: 'open',
  };
  const origin = findingOrigin({
    findingId: finding.id,
    findingKind: 'subject',
    subject,
    subjectKey: finding.subjectKey,
    ruleId: leaf.id,
    status: 'open',
    latest: ruleEvaluationView(evaluation),
  });
  const opening = packetEvent('toy-hazard-opening', 'sms.record.open', 'toy-hazard-stream', 1, {
    recordId: 'toy-hazard',
    recordedOrigin: origin,
  });
  const assessment = packetEvent(
    'toy-assessment',
    'decision.record',
    'toy-hazard-stream',
    2,
    { acceptance: { subjectId: 'toy-hazard', kind: 'risk.assess' } },
    {},
    opening,
  );
  const receipt = (id: string, eventId: string, artifactId: string) => ({
    tenantId,
    id,
    eventId,
    sourceId: subject.sourceId,
    kind: 'observation',
    occurredAt: '2026-11-02T10:15:00.000Z',
    receivedAt: '2026-11-02T10:20:00.000Z',
    sourceRevision: null,
    artifactId,
    payload: {},
    inputSubject: {},
  });
  return {
    pack,
    evaluation,
    sources: {
      tenantId,
      finding,
      evaluationIds: [evaluation.id],
      events: [adoption, withdrawn, read, withdrawal, evaluationEvent, opening, assessment],
      observations: [
        {
          observationId: 'toy-observation-1',
          eventId: 'toy-observation-1',
          receiptId: 'toy-receipt-1',
          artifactId: 'toy-artifact-1',
          replacesObservationId: null,
        },
        {
          observationId: 'toy-observation-0',
          eventId: 'toy-observation-0',
          receiptId: 'toy-receipt-0',
          artifactId: 'toy-artifact-0',
          replacesObservationId: null,
        },
      ],
      corrections: {
        [evaluation.id]: [{ kind: 'withdrawal', eventId: 'toy-withdrawal', observationId: 'toy-observation-0' }],
      },
      receipts: [receipt('toy-receipt-1', 'toy-observation-1', 'toy-artifact-1')],
      artifacts: [
        {
          tenantId,
          id: 'toy-artifact-1',
          sha256: canonicalDigest({ toy: 'source bytes' }),
          byteLength: 42,
          contentType: 'application/json',
        },
      ],
      treatments: [],
      hazards: [
        {
          recordId: 'toy-hazard',
          openingEventId: 'toy-hazard-opening',
          origin,
          assessmentIds: ['toy-assessment'],
          acceptanceIds: [],
        },
      ],
    },
  };
}

export const toyIssue = {
  packetId: '00000000-0000-4000-8000-000000000028',
  issuedBy: 'toy-principal',
  issuedAt: '2026-11-02T11:00:00.000Z',
};

/**
 * Runs the finding packet verifier CLI on the packet bytes in a separate process with an empty environment, from a
 * copy of the verifier outside the repository, so it can reach no Ledger package. Returns its exit code and output.
 */
export function verifyOffline(bytes: string | Uint8Array, args: string[] = []): { status: number; result: any } {
  const directory = mkdtempSync(join(tmpdir(), 'ledger-finding-packet-'));
  try {
    const path = join(directory, 'packet.json');
    writeFileSync(path, bytes);
    cpSync(new URL('../../tools/verifier/', import.meta.url), join(directory, 'verifier'), { recursive: true });
    const cli = join(directory, 'verifier', 'finding-packet-cli.mjs');
    const options = { encoding: 'utf8' as const, cwd: directory, env: {} };
    try {
      return { status: 0, result: JSON.parse(execFileSync(process.execPath, [cli, path, ...args], options)) };
    } catch (error: any) {
      if (typeof error.status !== 'number') throw error;
      return { status: error.status, result: JSON.parse(error.stdout) };
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
