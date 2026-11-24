import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import type {
  DecisionPacket,
  DecisionRecord,
  EvidenceEntry,
  EvidenceEnvelope,
  EvaluationRecord,
  InputCut,
  TimelineItem,
} from '../../packages/contracts/src/index.js';
import { landingDisagreementEvaluation } from '../../packages/contracts/fixtures/demo/v1/landing-hazards.js';
import { decisionPacketOffer } from '../../apps/web/src/decision-packet-eligibility.js';
import {
  DECISION_PACKET_LIMITATIONS as PUBLIC_LIMITATIONS,
  DECISION_PACKET_LIMITS as PUBLIC_LIMITS,
  DecisionPacketSchema,
} from '../../packages/contracts/src/decision-packets.js';
import {
  canonicalDigest,
  canonicalize,
  entryHash,
  INTEGRITY_VERSION,
  sha256,
} from '../../packages/integrity/src/index.js';
import {
  commandLinkEvidenceLeafV1,
  commandLinkStatusBindingV1,
  evaluateCommandLinkEvidence,
} from '../../packages/domain/src/rules/command-link-evidence-v1.js';
import {
  BundleVerificationError,
  DECISION_PACKET_LIMITATIONS,
  DECISION_PACKET_LIMITS,
  verifyDecisionPacket,
} from '../../tools/verifier/decision-packet.mjs';

const tenantId = 'fictional-packet-tenant';
const flightId = 'fictional-packet-flight';
const evaluatedAt = '2026-10-15T12:00:00.000Z';
const clock = { mode: 'wall' as const, evaluatedAt };
const findingId = `finding:${canonicalDigest({ tenant: tenantId, flightId, leafId: commandLinkEvidenceLeafV1.id, scope: 'flight' })}`;

function entry(envelope: EvidenceEnvelope, previousHash = 'a'.repeat(64)): EvidenceEntry {
  const envelopeDigest = canonicalDigest(envelope);
  return {
    canonicalEnvelope: canonicalize(envelope),
    envelopeDigest,
    previousHash,
    entryHash: entryHash(envelope.tenantId, envelope.streamId, BigInt(envelope.sequence), previousHash, envelopeDigest),
    encodingVersion: INTEGRITY_VERSION,
  };
}
function event(
  id: string,
  type: string,
  streamId: string,
  position: string,
  payload: Record<string, unknown>,
): EvidenceEnvelope {
  return {
    eventId: id,
    tenantId,
    streamId,
    sequence: position,
    type,
    schemaVersion: 1,
    principalId: 'fictional-operator',
    sourceId: null,
    sourceSessionId: null,
    occurredAt: null,
    effectiveAt: null,
    receivedAt: evaluatedAt,
    causationId: null,
    artifactId: null,
    payload,
  };
}
function seal(packet: DecisionPacket): DecisionPacket {
  packet.manifest.inventory = [
    ...packet.events.map((item) => {
      const envelope = JSON.parse(item.canonicalEnvelope) as EvidenceEnvelope;
      return {
        kind: 'event' as const,
        id: envelope.eventId,
        digest: canonicalDigest(item),
        reason:
          envelope.eventId === packet.manifest.decisionId
            ? ('selected_decision' as const)
            : envelope.eventId === packet.manifest.evaluationId
              ? ('selected_evaluation' as const)
              : ('evaluation_report' as const),
      };
    }),
    ...packet.receipts.map((item) => ({
      kind: 'receipt' as const,
      id: item.id,
      digest: canonicalDigest(item),
      reason: 'report_receipt' as const,
    })),
    ...packet.artifacts.map((item) => ({
      kind: 'artifact' as const,
      id: item.id,
      digest: canonicalDigest(item),
      reason: 'report_original' as const,
    })),
  ];
  packet.manifest.counts = {
    events: packet.events.length,
    receipts: packet.receipts.length,
    artifacts: packet.artifacts.length,
    artifactBytes: packet.artifacts.reduce((sum, item) => sum + item.byteLength, 0),
  };
  packet.manifestDigest = canonicalDigest(packet.manifest);
  return packet;
}
function fixture(): DecisionPacket {
  const packet: DecisionPacket = {
    format: 'ledger.decision-packet.1',
    manifestDigest: '',
    events: [],
    receipts: [],
    artifacts: [],
    manifest: {
      format: 'ledger.decision-packet.1',
      packetId: 'packet-one',
      tenantId,
      flightId,
      decisionId: 'decision-one',
      evaluationId: 'evaluation-one',
      findingId,
      issuedBy: 'fictional-operator',
      issuedAt: evaluatedAt,
      scope: 'selected_c2_finding_treatment_records',
      selection: 'command-link-finding-treatment.1',
      historicalActorPolicy: { status: 'not_retained' },
      dependencyManifest: { status: 'not_retained' },
      inventory: [],
      counts: { events: 0, receipts: 0, artifacts: 0, artifactBytes: 0 },
      limits: { ...PUBLIC_LIMITS },
      limitations: [...PUBLIC_LIMITATIONS],
    },
  };
  const reports = ['lost', 'restored'].map((status, index) => {
    const raw = {
      sourceSessionId: 'session-one',
      sourceEventId: `source-event-${index}`,
      incidentId: 'incident-one',
      aircraftId: 'aircraft-one',
      occurredAt: `2026-10-15T11:00:${index === 0 ? '00' : '30'}Z`,
      status,
    };
    const { sourceSessionId, occurredAt, ...payload } = raw;
    const artifactId = `original-${index}`;
    const input = {
      sourceId: 'command-link',
      sourceSessionId,
      kind: 'command-link.status',
      occurredAt,
      subject: { flightId },
      artifactId,
      fidelity: 'synthetic_contract',
      payload,
      flightId,
      acceptedAuthority: {
        version: 'ledger.command-link-authority.1',
        principalId: 'fictional-adapter',
        tenantId,
        principalRevision: 1,
        inputKind: 'command-link.status',
        sourceId: 'command-link',
        requiredCapabilities: ['input:write', 'command-link:write'],
        grantedSources: ['command-link'],
      },
    };
    const envelope = {
      ...event(`report-${index}`, input.kind, 'source-stream', String(17 + index), input),
      principalId: 'fictional-adapter',
      sourceId: input.sourceId,
      sourceSessionId,
      occurredAt,
      artifactId,
    };
    packet.events.push(entry(envelope));
    const receiptId = `receipt-${index}`;
    packet.receipts.push({
      tenantId,
      id: receiptId,
      eventId: envelope.eventId,
      sourceId: input.sourceId,
      kind: input.kind,
      occurredAt: new Date(occurredAt).toISOString(),
      receivedAt: evaluatedAt,
      sourceRevision: null,
      artifactId,
      payload,
      inputSubject: input.subject,
    });
    const bytes = Buffer.from(`${JSON.stringify(raw, null, 2)}\n`);
    packet.artifacts.push({
      tenantId,
      id: artifactId,
      sha256: sha256(bytes),
      byteLength: bytes.length,
      contentType: 'application/json',
      bytesBase64: bytes.toString('base64'),
    });
    return {
      flightId,
      eventId: envelope.eventId,
      receiptId,
      sourceId: input.sourceId,
      sourceSessionId,
      sourceEventId: raw.sourceEventId,
      incidentId: raw.incidentId,
      aircraftId: raw.aircraftId,
      occurredAt: new Date(occurredAt).toISOString(),
      status,
    };
  });
  const evaluationCut = { streams: { 'source-stream': 18 }, principalRevision: 1 };
  const value = {
    ...evaluateCommandLinkEvidence({ flightId, reports, clock }),
    clock,
    inputCut: evaluationCut,
    acceptedInputCut: evaluationCut,
    dependencyBasis: sha256('retained-evaluation-basis'),
  };
  const evaluation = {
    ...event('evaluation-one', 'evaluation.recorded', 'evaluation-stream', '31', {
      flightId,
      findingId,
      evaluation: value,
      leaf: commandLinkEvidenceLeafV1,
      binding: commandLinkStatusBindingV1,
      declaredSubjects: [flightId],
    }),
    principalId: 'fictional-worker',
    causationId: 'report-1',
  };
  packet.events.push(entry(evaluation));
  const acceptedFindingBasis: EvaluationRecord = {
    ...value,
    id: evaluation.eventId,
    recordedAt: evaluation.receivedAt,
    rule: {
      reference: commandLinkEvidenceLeafV1.source.reference,
      text: commandLinkEvidenceLeafV1.source.text,
      review: 'ai_drafted',
      adopted: false,
    },
  };
  const decisionCut = {
    streams: { 'source-stream': 18, 'evaluation-stream': 31 },
    basisRevision: 3,
    principalRevision: 2,
  };
  packet.events.push(
    entry(
      event('decision-one', 'decision.record', 'flight-stream', '41', {
        kind: 'decision.record',
        flightId,
        expectedRevision: 3,
        expectedBasisRevision: 3,
        inputCut: decisionCut,
        acceptedInputCut: decisionCut,
        expectedDependencyBasis: sha256('retained-decision-basis'),
        findingTreatment: { findingId, evaluationId: evaluation.eventId, action: 'resolve' },
        decision: { kind: 'finding.resolve', note: 'Private review note must not appear in CLI output' },
        acceptedFindingBasis,
      }),
    ),
  );
  return seal(packet);
}
function amend(packet: DecisionPacket, eventId: string, change: (envelope: EvidenceEnvelope) => void): void {
  const index = packet.events.findIndex(
    (item) => (JSON.parse(item.canonicalEnvelope) as EvidenceEnvelope).eventId === eventId,
  );
  const envelope = JSON.parse(packet.events[index].canonicalEnvelope) as EvidenceEnvelope;
  change(envelope);
  packet.events[index] = entry(envelope, packet.events[index].previousHash);
}
function verify(packet: DecisionPacket) {
  return verifyDecisionPacket(packet, { expectedManifestDigest: packet.manifestDigest });
}
function failure(packet: DecisionPacket): string {
  try {
    verify(packet);
    return 'unexpected_success';
  } catch (error) {
    return (error as BundleVerificationError).issues[0].code;
  }
}

describe('selected C2 finding-treatment decision packet', () => {
  it('offers the finding packet for a rule-evaluation treatment and only the older packets for a retained one', () => {
    const envelope = fixture()
      .events.map((entry) => JSON.parse(entry.canonicalEnvelope) as EvidenceEnvelope)
      .find((entry) => entry.eventId === 'decision-one')!;
    const retained = envelope.payload.decision as { kind: string; note: string };
    const decision: DecisionRecord = {
      id: envelope.eventId,
      flightId,
      actorId: envelope.principalId,
      kind: retained.kind,
      note: retained.note,
      recordedAt: envelope.receivedAt,
      renderedInputCut: envelope.payload.inputCut as InputCut,
      acceptedInputCut: envelope.payload.acceptedInputCut as InputCut,
      acceptedBasisRevision: 3,
    };
    const item: TimelineItem = {
      id: decision.id,
      lane: 'decisions',
      kind: 'decision.record',
      title: retained.kind,
      occurredAt: envelope.receivedAt,
      receivedAt: envelope.receivedAt,
      actorId: decision.actorId,
      payload: envelope.payload,
      linkStatus: 'linked',
    };
    expect(decisionPacketOffer(decision, item)).toEqual({ kind: 'older' });
    expect(decisionPacketOffer(decision, null)).toEqual({ kind: 'none' });
    expect(decisionPacketOffer(decision, { ...item, id: 'another-decision' })).toEqual({ kind: 'none' });
    const landingDecision = { ...decision, flightId: landingDisagreementEvaluation.flightId, kind: 'finding.respond' };
    const landingItem = {
      ...item,
      payload: {
        ...item.payload,
        flightId: landingDecision.flightId,
        decision: { kind: landingDecision.kind, note: decision.note },
        findingTreatment: {
          findingId: 'resolved-landing-finding',
          evaluationId: landingDisagreementEvaluation.id,
          action: 'respond',
        },
        // A treatment of a finding from an adopted rule pins a rule evaluation shown in the flight's shape.
        acceptedFindingBasis: {
          ...landingDisagreementEvaluation,
          explanation: { ...landingDisagreementEvaluation.explanation, kind: 'rule' },
        },
      },
    };
    expect(decisionPacketOffer(landingDecision, landingItem)).toEqual({
      kind: 'finding',
      findingId: 'resolved-landing-finding',
    });
    expect(
      decisionPacketOffer(landingDecision, {
        ...landingItem,
        payload: {
          ...landingItem.payload,
          findingTreatment: { ...landingItem.payload.findingTreatment, evaluationId: 'different-evaluation' },
        },
      }),
    ).toEqual({ kind: 'none' });
  });

  it('verifies exact selected records offline without requiring omitted prefixes or emitting the private note', () => {
    const packet = fixture();
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(DecisionPacketSchema);
    expect(validate(packet), JSON.stringify(validate.errors)).toBe(true);
    expect(DECISION_PACKET_LIMITS).toEqual(PUBLIC_LIMITS);
    expect(DECISION_PACKET_LIMITATIONS).toEqual(PUBLIC_LIMITATIONS);
    expect(verify(packet)).toMatchObject({
      status: 'verified',
      format: 'ledger.decision-packet.1',
      flightId,
      decisionId: 'decision-one',
      counts: { events: 4, receipts: 2, artifacts: 2 },
    });
    const directory = mkdtempSync(join(tmpdir(), 'ledger-decision-packet-'));
    try {
      cpSync(new URL('../../tools/verifier/', import.meta.url), join(directory, 'verifier'), { recursive: true });
      const file = join(directory, 'packet.json');
      writeFileSync(file, canonicalize(packet));
      const cli = (path = file) =>
        spawnSync(
          process.execPath,
          [
            join(directory, 'verifier/decision-packet-cli.mjs'),
            path,
            '--expected-manifest-sha256',
            packet.manifestDigest,
          ],
          { cwd: directory, encoding: 'utf8', env: {} },
        );
      const result = cli();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ status: 'verified' });
      expect(result.stdout).not.toContain('Private review note');
      expect(JSON.parse(result.stdout)).not.toHaveProperty('replays');
      writeFileSync(file, `{"format":"ledger.decision-packet.1",${canonicalize(packet).slice(1)}`);
      expect(JSON.parse(cli().stdout).issues[0].code).toBe('json_duplicate_key');
      writeFileSync(file, Buffer.alloc(PUBLIC_LIMITS.maxPacketBytes + 1, 32));
      expect(JSON.parse(cli().stdout).issues[0].code).toBe('packet_bound');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('requires the independent anchor and commits complete local entry framing in inventory', () => {
    const packet = fixture();
    expect(() => verifyDecisionPacket(packet)).toThrow('independently retained');
    expect(() => verifyDecisionPacket(packet, { expectedManifestDigest: '0'.repeat(64) })).toThrow(
      'independently retained',
    );
    const first = packet.events[0];
    const envelope = JSON.parse(first.canonicalEnvelope) as EvidenceEnvelope;
    packet.events[0] = entry(envelope, 'b'.repeat(64));
    expect(failure(packet)).toBe('packet_inventory');
  });

  it('rejects replacement accepted bases, unsupported judgments and same-version rule drift', () => {
    const basis = fixture();
    amend(basis, 'decision-one', (event) => {
      (event.payload.acceptedFindingBasis as EvaluationRecord).recordedAt = '2026-10-15T12:00:01.000Z';
    });
    seal(basis);
    expect(failure(basis)).toBe('packet_accepted_basis');
    const generic = fixture();
    amend(generic, 'decision-one', (event) => {
      (event.payload.decision as { kind: string }).kind = 'reviewed';
    });
    seal(generic);
    expect(failure(generic)).toBe('packet_decision');
    const drift = fixture();
    amend(drift, 'evaluation-one', (event) => {
      (event.payload.leaf as { title: string }).title = 'Different same-version procedure';
    });
    seal(drift);
    expect(failure(drift)).toBe('packet_rule');
  });

  it('rejects missing, unrelated and cross-tenant selected records instead of extending reference closure', () => {
    const missing = fixture();
    missing.events.shift();
    seal(missing);
    expect(failure(missing)).toBe('packet_report');
    const extra = fixture();
    extra.events.push(
      entry(event('unrelated', 'flight.created', 'unrelated-stream', '2', { flightId: 'unrelated-flight' })),
    );
    seal(extra);
    expect(failure(extra)).toBe('packet_closure');
    const foreign = fixture();
    amend(foreign, 'report-0', (event) => {
      event.tenantId = 'other-tenant';
    });
    seal(foreign);
    expect(failure(foreign)).toBe('packet_tenant');
    const duplicate = fixture();
    duplicate.manifest.inventory[1] = { ...duplicate.manifest.inventory[0] };
    duplicate.manifestDigest = canonicalDigest(duplicate.manifest);
    expect(failure(duplicate)).toBe('packet_inventory');
    const opaque = fixture();
    amend(opaque, 'report-0', (event) => {
      event.causationId = 'unselected-opaque-causation';
    });
    seal(opaque);
    expect(verify(opaque).status).toBe('verified');
  });

  it('checks exact original JSON mapping and retained source authority inside the selected closure', () => {
    const raw = fixture();
    const artifact = raw.artifacts[0];
    const changed = JSON.parse(Buffer.from(artifact.bytesBase64, 'base64').toString('utf8')) as { status: string };
    changed.status = 'restored';
    const bytes = Buffer.from(JSON.stringify(changed));
    Object.assign(artifact, { bytesBase64: bytes.toString('base64'), byteLength: bytes.length, sha256: sha256(bytes) });
    seal(raw);
    expect(failure(raw)).toBe('command_link_evidence');
    const grant = fixture();
    amend(grant, 'report-0', (event) => {
      (event.payload.acceptedAuthority as { grantedSources: string[] }).grantedSources = [];
    });
    seal(grant);
    expect(failure(grant)).toBe('command_link_evidence');
  });

  it('rejects envelope and encoded-original bounds before parsing their invalid nested content', () => {
    const envelope = fixture();
    envelope.events[0].canonicalEnvelope = 'x'.repeat(PUBLIC_LIMITS.maxEnvelopeBytes + 1);
    expect(failure(envelope)).toBe('packet_envelope_bound');
    const original = fixture();
    original.artifacts[0].bytesBase64 = 'x'.repeat(100000);
    expect(failure(original)).toBe('packet_original_bound');
  });
});
