import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  DecisionEvidenceBundle,
  EvidenceEnvelope,
  FlightEvidenceBundle,
  MissionInput,
  MissionRevisionRecord,
} from '../../packages/contracts/src/index.js';
import type {
  ProposedCommandLinkInput,
  ProposedCommandLinkSource,
} from '../../packages/contracts/src/command-link-proposal.js';
import {
  commandLinkLossSource,
  commandLinkRestorationSource,
  proposedCommandLinkLoss,
  proposedCommandLinkRestoration,
} from '../../packages/contracts/fixtures/demo/v1/proposed.js';
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
import { appendJournalHistory } from './journal-history-fixture.js';
import { missionReleaseRecord } from '../../packages/contracts/fixtures/demo/v1/mission-release.js';
import { appendMissionHistory } from './mission-history-fixture.js';
import {
  appendMissionReleaseHistory,
  appendMissionReleaseV2History,
  missionReleaseHistoryEffect,
  missionReleaseV2HistoryEffect,
} from './mission-release-history-fixture.js';
import { appendMissionDepartureHistory, missionDepartureHistoryEffect } from './mission-departure-history-fixture.js';
import { appendMissionBriefingHistory, missionBriefingHistoryEffects } from './mission-briefing-history-fixture.js';
import { appendCommandLinkBaselineHistory } from './command-link-baseline-history-fixture.js';
import type { CommandLinkBaselineInput } from '../../packages/contracts/src/command-link-baseline.js';
import type { MonitoringRecordV2, MonitoringReportInputV2 } from '../../packages/contracts/src/monitoring-window.js';
import { appendMonitoringWindowHistory } from './monitoring-window-history-fixture.js';

type FlightFixture = FlightEvidenceBundle;
const tenant = 'flight-v2-tenant';
const time = '2026-10-15T14:00:00.000Z';
const names = ['rendered', 'accepted', 'issuance'] as const;

function seal<T extends FlightFixture | DecisionEvidenceBundle>(bundle: T): T {
  bundle.manifest.sectionDigests = Object.fromEntries(
    Object.entries(bundle)
      .filter(([name]) => !['format', 'manifest', 'manifestDigest'].includes(name))
      .map(([name, value]) => [name, canonicalDigest(value)]),
  ) as typeof bundle.manifest.sectionDigests;
  bundle.manifest.interpretationDigests = {
    rendered: canonicalDigest(bundle.interpretations.rendered),
    accepted: canonicalDigest(bundle.interpretations.accepted),
    issuance: canonicalDigest(bundle.interpretations.issuance),
  };
  bundle.manifestDigest = canonicalDigest(bundle.manifest);
  return bundle;
}
function rechain<T extends FlightFixture | DecisionEvidenceBundle>(bundle: T): T {
  for (const stream of bundle.streams) {
    let previous = '';
    const rows = bundle.entries.filter(
      (entry) => (JSON.parse(entry.canonicalEnvelope) as EvidenceEnvelope).streamId === stream.id,
    );
    for (const entry of rows) {
      const event = JSON.parse(entry.canonicalEnvelope) as EvidenceEnvelope;
      entry.envelopeDigest = canonicalDigest(event);
      entry.previousHash = previous;
      entry.entryHash = entryHash(tenant, stream.id, BigInt(event.sequence), previous, entry.envelopeDigest);
      previous = entry.entryHash;
    }
    stream.headHash = previous;
    for (const name of names) {
      const sequence = bundle.cuts[name].streams[stream.id] ?? 0;
      stream.cutHeads[name] = { sequence: String(sequence), hash: sequence === 0 ? '' : rows[sequence - 1].entryHash };
    }
  }
  for (const name of names)
    bundle.interpretations[name] = interpretEvidenceCut(bundle.entries, bundle.cuts[name], tenant);
  return seal(bundle);
}
function fixture(): FlightFixture {
  const rendered = { streams: { 'flight-stream': 1 }, basisRevision: 1, principalRevision: 7 };
  const decision = {
    id: 'review-one',
    flightId: 'flight-one',
    actorId: 'operator',
    kind: 'reviewed',
    note: 'Private ordinary review note',
    recordedAt: time,
    renderedInputCut: rendered,
    acceptedInputCut: rendered,
    acceptedBasisRevision: 1,
  };
  const event = (
    eventId: string,
    sequence: string,
    type: string,
    payload: Record<string, unknown>,
  ): EvidenceEnvelope => ({
    eventId,
    tenantId: tenant,
    streamId: 'flight-stream',
    sequence,
    type,
    schemaVersion: 1,
    principalId: 'operator',
    sourceId: null,
    sourceSessionId: null,
    occurredAt: null,
    effectiveAt: null,
    receivedAt: time,
    causationId: null,
    artifactId: null,
    payload,
  });
  const events = [
    event('created', '1', 'flight.created', { flightId: 'flight-one' }),
    event(decision.id, '2', 'decision.record', {
      flightId: 'flight-one',
      inputCut: rendered,
      acceptedInputCut: rendered,
      expectedBasisRevision: 1,
      decision: { kind: decision.kind, note: decision.note },
    }),
  ];
  const source = readFileSync(new URL('../../packages/evidence/src/evidence-cut.mjs', import.meta.url), 'utf8');
  const runtimeContract = {
    name: 'node' as const,
    major: 24 as const,
    moduleFormat: 'esm' as const,
    dependencies: [] as [],
    network: 'none' as const,
    interpretation: 'evidence-cut.1' as const,
    canonicalization: INTEGRITY_VERSION,
  };
  const empty = interpretEvidenceCut([], rendered, tenant);
  const bundle: FlightFixture = {
    format: 'ledger.flight-evidence.2',
    manifest: {
      format: 'ledger.flight-evidence.2',
      exportId: 'flight-export',
      tenantId: tenant,
      scope: 'whole_tenant_prefixes',
      flightId: 'flight-one',
      subject: { kind: 'flight', id: 'flight-one' },
      decisionId: decision.id,
      issuedBy: 'operator',
      issuedAt: time,
      versions: { integrity: INTEGRITY_VERSION, interpretation: 'evidence-cut.1', snapshot: 'thread.1' },
      counts: { events: 2, streams: 1, receipts: 0, artifacts: 0, artifactBytes: 0 },
      limits: {
        maxEvents: 5000,
        maxStreams: 2000,
        maxArtifacts: 1024,
        maxArtifactBytes: 16 * 1024 * 1024,
        maxBundleBytes: 32 * 1024 * 1024,
      },
      sectionDigests: {} as FlightFixture['manifest']['sectionDigests'],
      interpretationDigests: { rendered: '', accepted: '', issuance: '' },
      limitations: [],
    },
    manifestDigest: '',
    streams: [
      {
        tenantId: tenant,
        id: 'flight-stream',
        name: 'flight:flight-one',
        headSequence: '2',
        headHash: '',
        cutHeads: {
          rendered: { sequence: '1', hash: '' },
          accepted: { sequence: '1', hash: '' },
          issuance: { sequence: '2', hash: '' },
        },
      },
    ],
    entries: events.map((envelope) => ({
      canonicalEnvelope: canonicalize(envelope),
      envelopeDigest: '',
      previousHash: '',
      entryHash: '',
      encodingVersion: INTEGRITY_VERSION,
    })),
    receipts: [],
    artifacts: [],
    decision,
    actor: { id: 'operator', authorityRevision: 7, historicalProfile: 'not_retained' },
    basisManifest: { status: 'not_retained' },
    cuts: { rendered, accepted: rendered, issuance: { streams: { 'flight-stream': 2 } } },
    snapshot: {
      kind: 'export_time_sql_snapshot',
      capturedAt: time,
      projectorVersion: 'thread.1',
      projectionCut: { streams: { 'flight-stream': 2 } },
      projectionRevision: 2,
      flight: {
        id: 'flight-one',
        label: 'Ordinary flight',
        originationKey: 'ordinary-one',
        revision: 2,
        basisRevision: 2,
        activity: 'planned',
        coverage: 'unknown',
        orderIds: [],
        sourceIds: [],
        unresolvedCount: 0,
        conflictCount: 0,
        outstandingWork: 0,
      },
      items: [],
      decisions: [decision],
      limitations: [],
    },
    interpreter: {
      name: 'evidence-cut.1',
      sourceEncoding: 'utf8',
      source,
      sourceSha256: sha256(source),
      runtimeContract,
      runtimeContractDigest: canonicalDigest(runtimeContract),
    },
    interpretations: { rendered: empty, accepted: empty, issuance: empty },
  };
  return rechain(bundle);
}
function legacy(bundle: FlightFixture): DecisionEvidenceBundle {
  const { basisManifest: _basis, ...sections } = structuredClone(bundle);
  const { subject: _subject, ...manifest } = sections.manifest;
  return seal({
    ...sections,
    format: 'ledger.decision-evidence.1',
    manifest: { ...manifest, format: 'ledger.decision-evidence.1' },
  });
}
function verify(bundle: FlightFixture | DecisionEvidenceBundle) {
  return verifyBundle(bundle, { expectedManifestDigest: bundle.manifestDigest });
}
function withCommandLink(): FlightFixture {
  const bundle = fixture();
  for (const [index, proposed] of [proposedCommandLinkLoss, proposedCommandLinkRestoration].entries()) {
    const flightId = index === 0 ? 'flight-one' : 'unrelated-flight';
    const raw: ProposedCommandLinkSource = index === 0 ? commandLinkLossSource : commandLinkRestorationSource;
    const { sourceSessionId, occurredAt, ...payload } = raw;
    const input: ProposedCommandLinkInput = {
      ...proposed,
      sourceSessionId,
      occurredAt,
      subject: { flightId },
      payload,
    };
    const sourceStreamId = `link-stream-${index}`;
    const envelope: EvidenceEnvelope = {
      eventId: `link-event-${index}`,
      tenantId: tenant,
      streamId: sourceStreamId,
      sequence: '1',
      type: input.kind,
      schemaVersion: 1,
      principalId: 'link-adapter',
      sourceId: input.sourceId,
      sourceSessionId,
      occurredAt,
      effectiveAt: null,
      receivedAt: time,
      causationId: null,
      artifactId: input.artifactId,
      payload: {
        ...input,
        flightId,
        acceptedAuthority: {
          version: 'ledger.command-link-authority.1',
          principalId: 'link-adapter',
          tenantId: tenant,
          principalRevision: 1,
          inputKind: input.kind,
          sourceId: input.sourceId,
          requiredCapabilities: ['input:write', 'command-link:write'],
          grantedSources: [input.sourceId, 'another-authorized-source'],
        },
      },
    };
    const bytes = Buffer.from(JSON.stringify(raw), 'utf8');
    bundle.entries.push({
      canonicalEnvelope: canonicalize(envelope),
      envelopeDigest: '',
      previousHash: '',
      entryHash: '',
      encodingVersion: INTEGRITY_VERSION,
    });
    bundle.streams.push({
      tenantId: tenant,
      id: sourceStreamId,
      name: `source:link-adapter:${input.sourceId}:${sourceSessionId}:${index}`,
      headSequence: '1',
      headHash: '',
      cutHeads: {
        rendered: { sequence: '0', hash: '' },
        accepted: { sequence: '0', hash: '' },
        issuance: { sequence: '1', hash: '' },
      },
    });
    bundle.receipts.push({
      tenantId: tenant,
      id: `link-receipt-${index}`,
      eventId: envelope.eventId,
      sourceId: input.sourceId,
      kind: input.kind,
      occurredAt,
      receivedAt: time,
      sourceRevision: null,
      artifactId: input.artifactId,
      payload,
      inputSubject: input.subject,
    });
    bundle.artifacts.push({
      tenantId: tenant,
      id: input.artifactId,
      sha256: sha256(bytes),
      byteLength: bytes.length,
      contentType: 'application/json',
      bytesBase64: bytes.toString('base64'),
    });
    bundle.cuts.issuance.streams[sourceStreamId] = 1;
  }
  bundle.manifest.counts = {
    events: bundle.entries.length,
    streams: bundle.streams.length,
    receipts: bundle.receipts.length,
    artifacts: bundle.artifacts.length,
    artifactBytes: bundle.artifacts.reduce((sum, artifact) => sum + artifact.byteLength, 0),
  };
  return rechain(bundle);
}
function failure(bundle: FlightFixture): string {
  try {
    verify(bundle);
    return 'unexpected_success';
  } catch (error) {
    return (error as { issues: { code: string }[] }).issues[0].code;
  }
}

type NativeC2Input = (CommandLinkBaselineInput | ProposedCommandLinkInput) & {
  flightId: string;
  acceptedAuthority: Record<string, unknown>;
};
function replaceNativeOriginal(bundle: FlightFixture, artifactId: string, bytes: Buffer): void {
  const artifact = bundle.artifacts.find((artifact) => artifact.id === artifactId)!;
  artifact.bytesBase64 = bytes.toString('base64');
  artifact.byteLength = bytes.byteLength;
  artifact.sha256 = sha256(bytes);
  bundle.manifest.counts.artifactBytes = bundle.artifacts.reduce((sum, artifact) => sum + artifact.byteLength, 0);
}
function rewriteNativeInput(
  bundle: FlightFixture,
  eventId: string,
  change: (input: NativeC2Input, envelope: EvidenceEnvelope) => void,
): void {
  const entry = bundle.entries.find(
    (entry) => (JSON.parse(entry.canonicalEnvelope) as EvidenceEnvelope).eventId === eventId,
  )!;
  const envelope = JSON.parse(entry.canonicalEnvelope) as EvidenceEnvelope;
  const input = envelope.payload as unknown as NativeC2Input;
  change(input, envelope);
  envelope.sourceId = input.sourceId;
  envelope.sourceSessionId = input.sourceSessionId;
  envelope.occurredAt = input.occurredAt;
  const source =
    input.kind === 'command-link.baseline'
      ? {
          ...input.payload,
          sourceId: input.sourceId,
          sourceSessionId: input.sourceSessionId,
          flightId: input.subject.flightId,
          occurredAt: input.occurredAt,
        }
      : { sourceSessionId: input.sourceSessionId, occurredAt: input.occurredAt, ...input.payload };
  replaceNativeOriginal(bundle, input.artifactId, Buffer.from(JSON.stringify(source)));
  const receipt = bundle.receipts.find((receipt) => receipt.eventId === eventId)!;
  receipt.payload = input.payload;
  receipt.inputSubject = input.subject;
  receipt.receivedAt = envelope.receivedAt;
  receipt.occurredAt = input.occurredAt;
  receipt.sourceId = input.sourceId;
  entry.canonicalEnvelope = canonicalize(envelope);
  rechain(bundle);
}

type MonitoringInput = MonitoringReportInputV2 & {
  organizationId: string;
  acceptedAuthority: MonitoringRecordV2['authority'];
};
function rewriteMonitoringInput(
  bundle: FlightFixture,
  eventId: string,
  change: (input: MonitoringInput) => void,
): void {
  const entry = bundle.entries.find(
    (entry) => (JSON.parse(entry.canonicalEnvelope) as EvidenceEnvelope).eventId === eventId,
  )!;
  const envelope = JSON.parse(entry.canonicalEnvelope) as EvidenceEnvelope;
  const input = envelope.payload as unknown as MonitoringInput;
  change(input);
  envelope.sourceId = input.sourceId;
  envelope.sourceSessionId = input.sourceSessionId;
  envelope.occurredAt = input.occurredAt;
  replaceNativeOriginal(
    bundle,
    input.artifactId,
    Buffer.from(
      JSON.stringify({
        sourceSessionId: input.sourceSessionId,
        occurredAt: input.occurredAt,
        ...input.payload,
      }),
    ),
  );
  const receipt = bundle.receipts.find((receipt) => receipt.eventId === eventId)!;
  receipt.payload = input.payload;
  receipt.sourceRevision = String(input.payload.sourceRevision);
  receipt.inputSubject = { organizationId: input.organizationId };
  receipt.sourceId = input.sourceId;
  receipt.occurredAt = input.occurredAt;
  entry.canonicalEnvelope = canonicalize(envelope);
  rechain(bundle);
}

describe('ordinary flight evidence version boundary', () => {
  it('verifies organization monitoring revisions and exact originals in flight V2 and standalone CLI while V1 stays closed', () => {
    const bundle = appendMonitoringWindowHistory(fixture());
    const result = verify(bundle);
    expect(result.status).toBe('verified');
    expect(result.counts).toMatchObject({ events: 10, receipts: 8, artifacts: 8 });
    expect(
      result.replays.issuance.output.events.filter((event: { type: string }) => event.type === 'monitoring.window'),
    ).toHaveLength(2);
    const receipt = bundle.receipts.find((receipt) => receipt.id === 'monitoring-receipt-1')!;
    expect(receipt).toMatchObject({
      sourceRevision: '2',
      inputSubject: { organizationId: `organization:${tenant}` },
      payload: { populationComplete: false, flights: [{ observedIntervals: [], coverageIntervals: null }] },
    });
    expect(result.limitations).toContain(
      'Monitoring windows retain reported samples, originals, intake authority and exact referenced records; the control record version and risk acceptance a window cites are safety records outside this export, so those pins are not checked here. This format does not establish current evidence completeness, observed exposure, incident counts, effectiveness rates or operational permission.',
    );
    expect(() => verify(legacy(bundle))).toThrow('unsupported input event');
    expect(bundle.actor.historicalProfile).toBe('not_retained');
    expect(bundle.basisManifest).toEqual({ status: 'not_retained' });
    const directory = mkdtempSync(join(tmpdir(), 'ledger-monitoring-window-'));
    try {
      cpSync(new URL('../../tools/verifier/', import.meta.url), join(directory, 'verifier'), { recursive: true });
      const path = join(directory, 'monitoring-flight-v2.json');
      writeFileSync(path, canonicalize(bundle));
      const stdout = execFileSync(
        process.execPath,
        [join(directory, 'verifier/cli.mjs'), path, '--expected-manifest-sha256', bundle.manifestDigest],
        { cwd: directory, encoding: 'utf8', env: {} },
      );
      expect(JSON.parse(stdout)).toMatchObject({
        status: 'verified',
        format: 'ledger.flight-evidence.2',
        counts: { events: 10, receipts: 8 },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('rejects monitoring original mismatch, missing source authority and the 128 KiB source bound under replacement anchors', () => {
    const mismapped = appendMonitoringWindowHistory(fixture());
    const artifact = mismapped.artifacts.find((artifact) => artifact.id === 'monitoring-artifact-0')!;
    const raw = JSON.parse(Buffer.from(artifact.bytesBase64, 'base64').toString('utf8'));
    raw.populationComplete = false;
    replaceNativeOriginal(mismapped, artifact.id, Buffer.from(JSON.stringify(raw)));
    rechain(mismapped);
    expect(failure(mismapped)).toBe('monitoring_window_evidence');
    const unauthorized = appendMonitoringWindowHistory(fixture());
    rewriteMonitoringInput(unauthorized, 'monitoring-event-0', (input) => {
      input.acceptedAuthority.grantedSources = ['another-source'];
    });
    expect(failure(unauthorized)).toBe('monitoring_window_evidence');
    const oversized = appendMonitoringWindowHistory(fixture());
    const original = oversized.artifacts.find((artifact) => artifact.id === 'monitoring-artifact-0')!;
    replaceNativeOriginal(
      oversized,
      original.id,
      Buffer.concat([Buffer.from(' '.repeat(128 * 1024)), Buffer.from(original.bytesBase64, 'base64')]),
    );
    rechain(oversized);
    expect(failure(oversized)).toBe('monitoring_window_evidence');
  });
  it('rejects monitoring pins that no longer match the retained mission or native baseline', () => {
    for (const reference of ['mission', 'baseline'] as const) {
      const bundle = appendMonitoringWindowHistory(fixture());
      rewriteMonitoringInput(bundle, 'monitoring-event-0', (input) => {
        if (reference === 'mission') input.payload.flights[0].mission.recordDigest = 'f'.repeat(64);
        if (reference === 'baseline') input.payload.flights[0].baseline.digest = 'f'.repeat(64);
      });
      expect(failure(bundle), reference).toBe('monitoring_window_reference');
    }
  });
  it('preserves contiguous monitoring context and enforces reported clock and combined membership bounds', () => {
    for (const mutation of ['revision', 'context', 'future-observation', 'membership'] as const) {
      const bundle = appendMonitoringWindowHistory(fixture());
      rewriteMonitoringInput(bundle, 'monitoring-event-1', (input) => {
        if (mutation === 'revision') input.payload.sourceRevision = 3;
        if (mutation === 'context') input.payload.window.end = '2026-10-15T14:21:00Z';
        if (mutation === 'future-observation')
          input.payload.flights[0].observedIntervals = [{ start: '2026-10-15T14:20:00Z', end: '2026-10-15T14:21:00Z' }];
        if (mutation === 'membership')
          input.payload.flights[0].declaredC2SourceEventIds = Array.from(
            { length: 128 },
            (_, index) => `reported-event-${index}`,
          );
      });
      expect(failure(bundle), mutation).toBe(
        mutation === 'revision' || mutation === 'context' ? 'monitoring_window_history' : 'monitoring_window_evidence',
      );
    }
  });
  it('verifies native baseline originals and unrelated receipts in flight V2 while V1 stays closed', () => {
    const bundle = appendCommandLinkBaselineHistory(fixture());
    const result = verify(bundle);
    expect(result.status).toBe('verified');
    expect(result.counts).toMatchObject({ events: 6, receipts: 4, artifacts: 4 });
    expect(
      result.replays.issuance.output.events.filter((event: { type: string }) => event.type === 'command-link.baseline'),
    ).toHaveLength(2);
    expect(bundle.receipts.find((receipt) => receipt.id === 'native-c2-receipt-3')!.inputSubject).toEqual({
      flightId: 'unrelated-native-flight-2',
    });
    expect(() => verify(legacy(bundle))).toThrow('unsupported input event');
    expect(bundle.actor.historicalProfile).toBe('not_retained');
    expect(bundle.basisManifest).toEqual({ status: 'not_retained' });
    const directory = mkdtempSync(join(tmpdir(), 'ledger-native-baseline-'));
    try {
      cpSync(new URL('../../tools/verifier/', import.meta.url), join(directory, 'verifier'), { recursive: true });
      const path = join(directory, 'baseline-flight-v2.json');
      writeFileSync(path, canonicalize(bundle));
      const stdout = execFileSync(
        process.execPath,
        [join(directory, 'verifier/cli.mjs'), path, '--expected-manifest-sha256', bundle.manifestDigest],
        { cwd: directory, encoding: 'utf8', env: {} },
      );
      expect(JSON.parse(stdout)).toMatchObject({ status: 'verified', format: 'ledger.flight-evidence.2' });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('rejects native baseline original mapping, source grants and intake byte violations under replacement anchors', () => {
    const original = appendCommandLinkBaselineHistory(fixture());
    const mismapped = structuredClone(original);
    const artifact = mismapped.artifacts.find((artifact) => artifact.id === 'native-c2-artifact-0')!;
    const source = JSON.parse(Buffer.from(artifact.bytesBase64, 'base64').toString('utf8')) as Record<string, unknown>;
    source.flightId = 'another-flight';
    replaceNativeOriginal(mismapped, artifact.id, Buffer.from(JSON.stringify(source)));
    seal(mismapped);
    expect(failure(mismapped)).toBe('command_link_baseline_evidence');
    const authority = structuredClone(original);
    rewriteNativeInput(authority, 'native-c2-event-0', (input) => {
      input.acceptedAuthority.grantedSources = ['another-source'];
    });
    expect(failure(authority)).toBe('command_link_baseline_evidence');
    for (const prefix of [Buffer.from([0xef, 0xbb, 0xbf]), Buffer.alloc(64 * 1024, 0x20)]) {
      const oversized = structuredClone(original);
      const artifact = oversized.artifacts.find((artifact) => artifact.id === 'native-c2-artifact-0')!;
      replaceNativeOriginal(
        oversized,
        artifact.id,
        Buffer.concat([prefix, Buffer.from(artifact.bytesBase64, 'base64')]),
      );
      seal(oversized);
      expect(failure(oversized)).toBe('command_link_baseline_evidence');
    }
  });
  it('rejects inconsistent native session binding, shared event identities and comparable acceptance order', () => {
    for (const mutation of ['binding', 'source-event', 'extra-baseline', 'acceptance-order'] as const) {
      const bundle = appendCommandLinkBaselineHistory(fixture());
      if (mutation === 'binding')
        rewriteNativeInput(bundle, 'native-c2-event-1', (input) => {
          input.subject.flightId = 'another-flight';
          input.flightId = input.subject.flightId;
        });
      if (mutation === 'source-event')
        rewriteNativeInput(bundle, 'native-c2-event-1', (input) => {
          input.payload.sourceEventId = 'native-session-baseline';
        });
      if (mutation === 'extra-baseline')
        rewriteNativeInput(bundle, 'native-c2-event-3', (input) => {
          input.sourceSessionId = 'fixture-native-c2-session';
          input.subject.flightId = 'flight-one';
          input.flightId = input.subject.flightId;
          input.payload.aircraftId = 'demo-71031:aircraft:1';
        });
      if (mutation === 'acceptance-order')
        rewriteNativeInput(bundle, 'native-c2-event-0', (_input, envelope) => {
          envelope.receivedAt = '2026-10-15T14:15:00.000Z';
        });
      expect(failure(bundle), mutation).toBe('command_link_baseline_history');
    }
  });
  it('rejects reused Ledger mission IDs and competing mission bindings on one flight under replacement anchors', () => {
    for (const collision of ['mission', 'flight'] as const) {
      const bundle = appendMissionHistory(fixture());
      const event = JSON.parse(bundle.entries[3].canonicalEnvelope) as EvidenceEnvelope;
      const input = event.payload as unknown as MissionInput & {
        flightId: string;
        acceptance: Omit<MissionRevisionRecord, 'id' | 'recordedAt'>;
      };
      if (collision === 'mission') input.acceptance.missionId = 'mission-0';
      else {
        input.subject.flightId = 'flight-one';
        input.flightId = 'flight-one';
        input.acceptance.flightId = 'flight-one';
        bundle.receipts[1].inputSubject = input.subject;
        const artifact = bundle.artifacts[1];
        input.acceptance.contentDigest = canonicalDigest({
          version: 'ledger.mission-content.1',
          sourceId: input.sourceId,
          flightId: input.subject.flightId,
          sourceRevision: input.sourceRevision,
          occurredAt: input.occurredAt,
          fidelity: input.fidelity,
          payload: input.payload,
          original: {
            sha256: artifact.sha256,
            byteLength: artifact.byteLength,
            bytesBase64: artifact.bytesBase64,
          },
        });
      }
      bundle.entries[3].canonicalEnvelope = canonicalize(event);
      rechain(bundle);
      expect(failure(bundle), collision).toBe('mission_identity');
    }
  });
  it('verifies exact planned mission bytes and retained authority across flight-v2 inventory while v1 stays closed', () => {
    const bundle = appendMissionHistory(fixture());
    const result = verify(bundle);
    expect(result.status).toBe('verified');
    expect(result.limitations).toContain(
      'Mission revisions verify reported planned geometry, original bytes and retained intake authority only; this format does not establish applicability, flown geometry or flight release.',
    );
    expect(
      result.replays.issuance.output.events.filter((event: { type: string }) => event.type === 'mission.revision'),
    ).toHaveLength(2);
    expect(bundle.receipts[1].inputSubject).toEqual({ flightId: 'unrelated-mission-flight-1' });
    expect(() => verify(legacy(bundle))).toThrow('unsupported input event');
    const original = structuredClone(bundle);
    const artifact = original.artifacts[0];
    const bytes = Buffer.concat([Buffer.from(' '), Buffer.from(artifact.bytesBase64, 'base64')]);
    artifact.bytesBase64 = bytes.toString('base64');
    artifact.byteLength = bytes.byteLength;
    artifact.sha256 = sha256(bytes);
    original.manifest.counts.artifactBytes++;
    const originalEvent = JSON.parse(original.entries[2].canonicalEnvelope) as EvidenceEnvelope;
    (originalEvent.payload.acceptance as { original: unknown }).original = {
      sha256: artifact.sha256,
      byteLength: artifact.byteLength,
    };
    original.entries[2].canonicalEnvelope = canonicalize(originalEvent);
    rechain(original);
    expect(failure(original)).toBe('mission_evidence');
    for (const change of [
      { grantedSources: ['another-mission-source'] },
      { version: 'ledger.command-link-authority.1' },
    ]) {
      const invalid = structuredClone(bundle);
      const event = JSON.parse(invalid.entries[2].canonicalEnvelope) as EvidenceEnvelope;
      event.payload.acceptedAuthority = {
        ...(event.payload.acceptedAuthority as Record<string, unknown>),
        ...change,
      };
      (event.payload.acceptance as { authority: unknown }).authority = event.payload.acceptedAuthority;
      invalid.entries[2].canonicalEnvelope = canonicalize(event);
      rechain(invalid);
      expect(failure(invalid)).toBe('mission_evidence');
    }
  });
  it('retains mission releases as nonreceipt inventory in both ordinary formats without selecting the release', () => {
    const original = fixture();
    const originalBytes = canonicalize(original);
    const effect = missionReleaseHistoryEffect(tenant);
    expect(verify(original).limitations.join(' ')).not.toContain('Recorded mission releases');
    const bundle = appendMissionReleaseHistory(structuredClone(original));
    for (const current of [bundle, legacy(bundle)]) {
      const result = verify(current);
      expect(result.status).toBe('verified');
      expect(result.decisionId).toBe(original.decision.id);
      expect(result.counts).toMatchObject({ events: 3, receipts: 0, artifacts: 0 });
      expect(current.entries.some((entry) => entry.canonicalEnvelope === canonicalize(effect))).toBe(true);
      expect(result.replays.issuance.output.events).toContainEqual(
        expect.objectContaining({ eventId: effect.eventId, type: 'mission.release' }),
      );
      expect(result.replays.accepted.output).toEqual(original.interpretations.accepted);
      expect(current.decision).toEqual(original.decision);
      expect(current.actor).toEqual(original.actor);
      expect(result.limitations).toContain(MISSION_RELEASE_LIMITATION);
      expect(current.manifest.limitations.join(' ')).not.toContain('Recorded mission releases');
    }
    expect(bundle.basisManifest).toEqual({ status: 'not_retained' });
    expect(canonicalize(original)).toBe(originalBytes);
  });
  it('verifies a release that lists no findings, and the evaluations listed findings are pinned to', () => {
    const unlisted = appendMissionReleaseHistory(fixture());
    expect(verify(unlisted).limitations).toContain(MISSION_RELEASE_LIMITATION);
    const bundle = appendMissionReleaseV2History(fixture());
    for (const current of [bundle, legacy(bundle)]) {
      const result = verify(current);
      expect(result.status).toBe('verified');
      expect(result.limitations).toContain(MISSION_RELEASE_LIMITATION);
    }
    type Payload = {
      acceptance: {
        policy: { version: number };
        basis: { findings: { digest: string; findings: { answer: { summary: string } }[] } };
      };
      expectedFindingsDigest?: string;
    };
    const payload = (effect: { payload: Record<string, unknown> }) => effect.payload as unknown as Payload;
    // A listed answer that differs from its pinned evaluation, with every digest recomputed around it.
    const reworded = appendMissionReleaseV2History(fixture(), (effect) => {
      const changed = structuredClone(effect);
      const findings = payload(changed).acceptance.basis.findings;
      findings.findings[0]!.answer.summary = 'A different summary than the evaluation recorded.';
      const { digest: _digest, ...body } = findings;
      findings.digest = canonicalDigest(body);
      payload(changed).expectedFindingsDigest = findings.digest;
      return changed;
    });
    expect(failure(reworded)).toBe('mission_release_findings');
    // The pinned evaluation is missing from the inventory.
    const missing = appendJournalHistory(
      fixture(),
      [missionReleaseV2HistoryEffect(tenant)],
      `flight:${missionReleaseRecord.flightId}`,
    );
    expect(failure(missing)).toBe('mission_release_findings');
    // A proposed-rule evaluation is never counted.
    const shadow = appendMissionReleaseV2History(fixture(), undefined, (effect) => {
      const changed = structuredClone(effect);
      (changed.payload.evaluation as { adoption: { mode: string } }).adoption.mode = 'shadow';
      return changed;
    });
    expect(failure(shadow)).toBe('mission_release_findings');
    // The command pins a different list than the release recorded.
    const unpinned = appendMissionReleaseV2History(fixture(), (effect) => {
      const changed = structuredClone(effect);
      payload(changed).expectedFindingsDigest = 'e'.repeat(64);
      return changed;
    });
    expect(failure(unpinned)).toBe('mission_release_commitment');
    // A release names only the registered policy version.
    const superseded = appendJournalHistory(
      fixture(),
      [
        (() => {
          const changed = structuredClone(missionReleaseHistoryEffect(tenant));
          payload(changed).acceptance.policy.version = 1;
          return changed;
        })(),
      ],
      `flight:${missionReleaseRecord.flightId}`,
    );
    expect(failure(superseded)).toBe('mission_release_policy');
  });
  it('retains departure authorizations opaquely in both ordinary formats without changing the selected decision', () => {
    const original = fixture();
    const originalBytes = canonicalize(original);
    const effect = missionDepartureHistoryEffect(tenant);
    expect(verify(original).limitations.join(' ')).not.toContain('Recorded departure authorizations');
    const bundle = appendMissionDepartureHistory(structuredClone(original));
    for (const current of [bundle, legacy(bundle)]) {
      const result = verify(current);
      expect(result.status).toBe('verified');
      expect(result.decisionId).toBe(original.decision.id);
      expect(result.counts).toMatchObject({ events: 4, receipts: 0, artifacts: 0 });
      expect(current.entries.some((entry) => entry.canonicalEnvelope === canonicalize(effect))).toBe(true);
      expect(result.replays.issuance.output.events).toContainEqual(
        expect.objectContaining({ eventId: effect.eventId, type: 'mission.departure-authorize' }),
      );
      expect(result.replays.accepted.output).toEqual(original.interpretations.accepted);
      expect(current.decision).toEqual(original.decision);
      expect(current.actor).toEqual(original.actor);
      expect(result.limitations).toContain(
        'Recorded departure authorizations are opaque journal inventory; this format does not verify authorization eligibility, current lease validity, resource allocation, operation fit or departure consumption.',
      );
      expect(current.manifest.limitations.join(' ')).not.toContain('Recorded departure authorizations');
    }
    expect(bundle.basisManifest).toEqual({ status: 'not_retained' });
    expect(canonicalize(original)).toBe(originalBytes);
  });
  it('retains briefings and personal acknowledgements opaquely in both ordinary formats', () => {
    const original = fixture();
    const originalBytes = canonicalize(original);
    const effects = missionBriefingHistoryEffects(tenant);
    expect(verify(original).limitations.join(' ')).not.toContain('Mission briefings and acknowledgements');
    const bundle = appendMissionBriefingHistory(structuredClone(original));
    for (const current of [bundle, legacy(bundle)]) {
      const result = verify(current);
      expect(result.status).toBe('verified');
      expect(result.decisionId).toBe(original.decision.id);
      expect(result.counts).toMatchObject({ events: 5, receipts: 0, artifacts: 0 });
      for (const effect of effects) {
        expect(current.entries.some((entry) => entry.canonicalEnvelope === canonicalize(effect))).toBe(true);
        expect(result.replays.issuance.output.events).toContainEqual(
          expect.objectContaining({ eventId: effect.eventId, type: effect.type, principalId: effect.principalId }),
        );
      }
      expect(result.replays.accepted.output).toEqual(original.interpretations.accepted);
      expect(current.decision).toEqual(original.decision);
      expect(current.actor).toEqual(original.actor);
      expect(result.limitations).toContain(
        'Mission briefings and acknowledgements are opaque journal inventory; this format does not verify personal review, message delivery, operational-crew coverage, control implementation or current release/departure validity.',
      );
      expect(current.manifest.limitations.join(' ')).not.toContain('Mission briefings and acknowledgements');
    }
    expect(bundle.basisManifest).toEqual({ status: 'not_retained' });
    expect(canonicalize(original)).toBe(originalBytes);
  });
  it('verifies old issued v1 and new flight-v2 bundles with the same pinned inventory offline', () => {
    const bundle = fixture();
    expect(verify(bundle)).toMatchObject({
      status: 'verified',
      format: 'ledger.flight-evidence.2',
      subject: { kind: 'flight', id: 'flight-one' },
    });
    const old = legacy(bundle);
    expect(verify(old).status).toBe('verified');
    for (const name of names) expect(verify(bundle).replays[name].output).toEqual(verify(old).replays[name].output);
    const directory = mkdtempSync(join(tmpdir(), 'ledger-flight-v2-'));
    try {
      cpSync(new URL('../../tools/verifier/', import.meta.url), join(directory, 'verifier'), { recursive: true });
      for (const current of [old, bundle]) {
        const path = join(directory, `${current.format}.json`);
        writeFileSync(path, canonicalize(current));
        const stdout = execFileSync(
          process.execPath,
          [
            join(directory, 'verifier/cli.mjs'),
            path,
            '--expected-manifest-sha256',
            current.manifestDigest,
            '--rebuild-dir',
            join(directory, current.format),
          ],
          { cwd: directory, encoding: 'utf8', env: {} },
        );
        expect(JSON.parse(stdout).status).toBe('verified');
        expect(stdout).not.toContain('Private ordinary review note');
        for (const name of names)
          expect(JSON.parse(readFileSync(join(directory, current.format, `${name}.json`), 'utf8'))).toEqual(
            current.interpretations[name],
          );
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('rejects changed flight targets and invented retained basis or authority under a replacement anchor', () => {
    const target = fixture();
    target.manifest.subject.id = 'another-flight';
    seal(target);
    expect(failure(target)).toBe('flight_target');
    const basis = fixture();
    Object.assign(basis.basisManifest, { status: 'retained', subjects: ['flight-one'] });
    seal(basis);
    expect(failure(basis)).toBe('flight_basis');
    const authority = fixture();
    Object.assign(authority.actor, { historicalProfile: 'retained' });
    seal(authority);
    expect(failure(authority)).toBe('actor_context');
    const decision = fixture();
    decision.decision.note = 'Replacement judgment';
    seal(decision);
    expect(failure(decision)).toBe('decision_commitment');
  });
  it('verifies explicit lost and restored original bytes across whole-tenant prefixes while v1 stays closed', () => {
    const bundle = withCommandLink();
    expect(verify(bundle).status).toBe('verified');
    expect(
      verify(bundle).replays.issuance.output.events.filter(
        (event: { type: string }) => event.type === 'command-link.status',
      ),
    ).toHaveLength(2);
    const old = legacy(bundle);
    expect(() => verify(old)).toThrow('unsupported input event');
    const mismapped = structuredClone(bundle);
    const artifact = mismapped.artifacts[1];
    const source = JSON.parse(
      Buffer.from(artifact.bytesBase64, 'base64').toString('utf8'),
    ) as ProposedCommandLinkSource;
    source.status = 'lost';
    const bytes = Buffer.from(JSON.stringify(source), 'utf8');
    artifact.bytesBase64 = bytes.toString('base64');
    artifact.byteLength = bytes.length;
    artifact.sha256 = sha256(bytes);
    mismapped.manifest.counts.artifactBytes = mismapped.artifacts.reduce((sum, item) => sum + item.byteLength, 0);
    seal(mismapped);
    expect(failure(mismapped)).toBe('command_link_evidence');
    const invalid = structuredClone(bundle);
    const envelope = JSON.parse(invalid.entries[2].canonicalEnvelope) as EvidenceEnvelope;
    const input = envelope.payload as unknown as ProposedCommandLinkInput;
    input.payload.position = { longitude: 181, latitude: 30.2 };
    invalid.receipts[0].payload = input.payload;
    invalid.entries[2].canonicalEnvelope = canonicalize(envelope);
    rechain(invalid);
    expect(failure(invalid)).toBe('command_link_evidence');
  });
  it('requires retained command-link authority for the exact recorded source without a legacy fallback', () => {
    for (const change of [
      { grantedSources: ['another-authorized-source'] },
      { sourceId: 'another-authorized-source' },
      { version: 'ledger.input-authority.1' },
      undefined,
    ]) {
      const bundle = withCommandLink();
      const event = JSON.parse(bundle.entries[2].canonicalEnvelope) as EvidenceEnvelope;
      if (change === undefined) delete event.payload.acceptedAuthority;
      else
        event.payload.acceptedAuthority = {
          ...(event.payload.acceptedAuthority as Record<string, unknown>),
          ...change,
        };
      bundle.entries[2].canonicalEnvelope = canonicalize(event);
      rechain(bundle);
      expect(failure(bundle)).toBe('command_link_evidence');
    }
  });
  it('rejects BOM-prefixed and oversized originals even with replacement byte commitments and anchors', () => {
    for (const prefix of [Buffer.from([0xef, 0xbb, 0xbf]), Buffer.alloc(64 * 1024, 0x20)]) {
      const bundle = withCommandLink();
      const artifact = bundle.artifacts[0];
      const bytes = Buffer.concat([prefix, Buffer.from(artifact.bytesBase64, 'base64')]);
      artifact.bytesBase64 = bytes.toString('base64');
      artifact.byteLength = bytes.byteLength;
      artifact.sha256 = sha256(bytes);
      bundle.manifest.counts.artifactBytes = bundle.artifacts.reduce((sum, item) => sum + item.byteLength, 0);
      seal(bundle);
      expect(failure(bundle)).toBe('command_link_evidence');
    }
  });
});
