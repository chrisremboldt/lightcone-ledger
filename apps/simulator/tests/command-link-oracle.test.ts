import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { commandLinkStatusAdapter, completeObservations } from '@ledger/adapters';
import type { ArtifactResponse, CommandLinkSource, Principal, ReceiptResponse, TimelineItem } from '@ledger/contracts';
import { canonicalDigest } from '../../../packages/integrity/src/index.js';
import type { WorldFact } from '../../../packages/simulation-models/src/operation.js';
import { auditCommandLinkJournal } from '../src/command-link-oracle.js';
import { OracleApi, OracleReadError } from '../src/oracle-api.js';

const context = {
  attemptId: 'intent-c2-oracle-alpha-2:attempt:1',
  tenant: 'alpha' as const,
  apiUrl: 'http://oracle.test',
};
const tenantId = 'tenant-alpha';
const sourceId = 'command-link';
const sourceSessionId = 'intent-c2-oracle-alpha-2-capture-1-command-link-1';
const aircraftId = 'DJI-c2-oracle-alpha-03';
const incidentId = 'c2-oracle:incident:canal-market-relay:1';
const flightId = 'flight-c2-oracle';
const principalId = 'source-current-alpha';
const lostAt = '2026-10-15T14:01:30.000Z';
const restoredAt = '2026-10-15T14:02:00.000Z';
const evaluatedAt = '2026-10-15T14:02:10.000Z';
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

interface Entry {
  fact: Extract<WorldFact, { kind: 'command-link' }>;
  bytesBase64: string;
  accepted?: { receiptId: string; artifactId: string };
}
interface Journal {
  version: number;
  binding: string;
  principalId: string;
  flightId: string;
  facts: Record<string, Entry>;
}

/** The link.status observation the command-link adapter makes of the report bytes, citing the artifact. */
function observationOf(bytes: Uint8Array, artifactId: string) {
  const translated = commandLinkStatusAdapter.translate(
    { bytes, contentType: 'application/json', transport: {}, capturedAt: lostAt },
    {
      subjects: { scope: 'ledger', ids: { flight: { [sourceSessionId]: flightId } } },
      binding: { sourceSessionId, aircraftId },
    },
  );
  return completeObservations(
    commandLinkStatusAdapter.descriptor,
    translated.drafts,
    artifactId,
  )[0]! as unknown as Record<string, unknown>;
}

function meta(revision: number) {
  return {
    requestId: `request-${revision}`,
    projectionRevision: revision,
    inputCut: { streams: { unrelated: revision }, basisRevision: revision, principalRevision: 19 },
    dependencyBasis: sha256(`unrelated-basis-${revision}`),
    computedAt: evaluatedAt,
    outstandingWork: 999,
  };
}

function fixture(canonicalEarlier = false) {
  const facts: Record<string, Entry> = {};
  const receipts = new Map<string, ReceiptResponse>();
  const artifacts = new Map<string, ArtifactResponse>();
  const originals = new Map<string, Uint8Array>();
  const historicalSelections = new Map<string, { selection: FlightRuleSelectionRecordV2 }>();
  const canonicalActor = canonicalEarlier ? 'source-earlier-alpha' : principalId;
  const canonicalSource = (status: 'lost' | 'restored'): CommandLinkSource => ({
    sourceSessionId,
    occurredAt: status === 'lost' ? lostAt : restoredAt,
    sourceEventId: `${context.attemptId}:command-link:${status}`,
    incidentId,
    aircraftId,
    status,
    position: { longitude: -87.638, latitude: 41.8811 },
  });
  function artifact(id: string, bytes: Uint8Array): void {
    originals.set(id, Uint8Array.from(bytes));
    artifacts.set(id, {
      artifact: {
        id,
        uploadId: `upload-${id}`,
        sha256: sha256(bytes),
        byteLength: bytes.byteLength,
        contentType: 'application/json',
        key: `retained/${id}`,
      },
      meta: meta(30),
    });
  }
  for (const [index, status] of (['lost', 'restored'] as const).entries()) {
    const sequence = index + 31;
    const raw = canonicalSource(status);
    const bytes = Buffer.from(JSON.stringify(raw));
    // An earlier delivery of the same bytes under another issuer retained them first; the upload is keyed by digest.
    const artifactId = canonicalEarlier ? `artifact-canonical-${status}` : `artifact-${status}`;
    artifact(artifactId, bytes);
    const receipt: ReceiptResponse = {
      receipt: {
        id: `receipt-${status}`,
        eventId: `event-${status}`,
        sourceId,
        kind: 'observation',
        occurredAt: raw.occurredAt,
        receivedAt: `2026-10-15T14:02:0${index + 5}.000Z`,
        status: 'accepted',
        processing: { status: 'completed', attempts: 1 },
        linkStatus: 'linked',
        flightId,
        artifactId,
        payload: observationOf(bytes, artifactId),
      },
      meta: meta(index + 40),
    };
    receipts.set(receipt.receipt.id, receipt);
    facts[sequence] = {
      fact: {
        sequence,
        kind: 'command-link',
        tenant: context.tenant,
        attemptId: context.attemptId,
        aircraftId,
        sourceSessionId,
        at: raw.occurredAt,
        sourceId,
        sourceEventId: raw.sourceEventId,
        incidentId,
        status,
        position: raw.position!,
      },
      bytesBase64: bytes.toString('base64'),
      accepted: { receiptId: receipt.receipt.id, artifactId },
    };
  }
  const entries = Object.values(facts);
  // The lost-link review on the generic evaluator cites the accepted reports as records.
  const evidence = entries.map(({ accepted, fact }) => ({
    eventId: receipts.get(accepted!.receiptId)!.receipt.eventId,
    receiptId: accepted!.receiptId,
    sourceId,
    occurredAt: fact.at,
    observationId: receipts.get(accepted!.receiptId)!.receipt.eventId,
    type: 'link.status',
    version: 1,
  }));
  const details = {
    episodeCount: 1,
    openEpisodeCount: 0,
    conflictingEpisodeCount: 0,
    closedEpisodeCount: 1,
    unreadableCount: 0,
    leftOutCount: 0,
    transitionCount: 2,
    latestOpenedAt: null as string | null,
  };
  const latestEvaluation = {
    id: 'evaluation-restored',
    flightId,
    leafId: 'fictional.lost-link-review',
    leafVersion: 2,
    bindingId: 'ledger.demo-procedures',
    bindingVersion: 5,
    applicability: 'applicable',
    evidenceState: 'supported',
    outcome: 'pass',
    title: 'Reported command-link loss',
    rule: { reference: 'ledger.demo-procedures.5', text: 'Fictional procedure.', review: 'ai_drafted', adopted: false },
    explanation: {
      kind: 'rule',
      code: 'episodes_closed',
      summary: 'Every reported loss has a strictly later restoration.',
      evidence,
      details,
      parameters: {},
      inputs: [{ name: 'transitions', type: 'link.status', observationIds: evidence.map((item) => item.eventId) }],
      ruleEvaluation: {
        pack: { id: 'ledger.demo-procedures', version: 5, digest: sha256('fictional-pack') },
        ruleDigest: sha256('fictional-rule'),
        check: { kind: 'episode.open', version: 1 },
        mode: 'active',
        subjectKey: `ledger/flight/${flightId}`,
      },
      evaluatedAt,
    },
    clock: { mode: 'wall', evaluatedAt },
    inputCut: { streams: { retained_source: 2 } },
    acceptedInputCut: { streams: { retained_source: 2 } },
    dependencyBasis: sha256('retained-evaluation-basis'),
    recordedAt: evaluatedAt,
  };
  const initialEvaluation = structuredClone(latestEvaluation);
  initialEvaluation.id = 'evaluation-lost';
  initialEvaluation.evidenceState = 'insufficient';
  initialEvaluation.outcome = 'attention';
  initialEvaluation.explanation.code = 'episode_open';
  initialEvaluation.explanation.summary = 'A reported loss lacks a strictly later restoration.';
  initialEvaluation.explanation.evidence = [structuredClone(evidence[0]!)];
  initialEvaluation.explanation.details = {
    ...details,
    openEpisodeCount: 1,
    closedEpisodeCount: 0,
    transitionCount: 1,
  };
  initialEvaluation.clock.evaluatedAt = '2026-10-15T14:02:05.100Z';
  initialEvaluation.explanation.evaluatedAt = initialEvaluation.clock.evaluatedAt;
  initialEvaluation.recordedAt = '2026-10-15T14:02:05.101Z';
  initialEvaluation.inputCut.streams.retained_source = 1;
  initialEvaluation.acceptedInputCut.streams.retained_source = 1;
  const items: TimelineItem[] = entries.map(({ accepted, fact }) => {
    const receipt = receipts.get(accepted!.receiptId)!.receipt;
    return {
      id: receipt.eventId,
      kind: receipt.kind,
      lane: 'observed' as const,
      title: `Command link reported ${fact.status}`,
      occurredAt: receipt.occurredAt,
      receivedAt: receipt.receivedAt,
      actorId: canonicalActor,
      sourceId,
      artifactId: receipt.artifactId,
      receiptId: receipt.id,
      linkStatus: 'linked' as const,
      payload: structuredClone(receipt.payload),
    };
  });
  const timeline = {
    flight: {
      id: flightId,
      label: 'Fictional relay hold',
      originationKey: context.attemptId,
      revision: 20,
      basisRevision: 15,
      activity: 'active',
      coverage: 'partial',
      aircraft: aircraftId,
      orderIds: [],
      sourceIds: [sourceId],
      unresolvedCount: 0,
      conflictCount: 0,
      outstandingWork: 0,
    },
    items,
    decisions: [],
    findings: [
      {
        id: 'finding-command-link',
        flightId,
        status: 'acknowledged',
        owner: { id: 'operator-alpha', name: 'Maya Chen' } as { id: string; name: string } | null,
        openedAt: initialEvaluation.recordedAt,
        initialEvaluation,
        latestEvaluation,
        treatments: [],
        hasOlderTreatments: false,
      },
    ],
    selectedItem: null,
    selectedDecision: null,
    window: {
      items: {
        limit: 500,
        returned: items.length,
        hasMore: false,
        nextCursor: null,
        selection: 'initial',
        order: 'received_ascending',
        consistency: 'live_projection',
      },
      decisions: {
        limit: 1,
        returned: 0,
        hasMore: false,
        nextCursor: null,
        selection: 'initial',
        order: 'recorded_ascending',
        consistency: 'live_projection',
      },
    },
    availableCommands: ['flight:read', 'evidence:read'],
    meta: meta(99),
  };
  const journal: Journal = {
    version: 2,
    binding: sha256(
      JSON.stringify({
        apiUrl: context.apiUrl,
        tenantId,
        attemptId: context.attemptId,
        sourceId,
        sourceSessionId,
        aircraftId,
      }),
    ),
    principalId,
    flightId,
    facts,
  };
  const reader: Principal = {
    id: 'read-only-auditor',
    tenantId,
    name: 'Read-only auditor',
    revision: 19,
    capabilities: ['flight:read', 'evidence:read'],
    commandLinkSources: [],
  };
  const reads: string[] = [];
  const usage = { requests: 0, bytes: 0 };
  const readFailures = new Map<string, Error>();
  const api = {
    async json<T>(path: string): Promise<T> {
      reads.push(path);
      if (readFailures.has(path)) throw readFailures.get(path)!;
      const url = new URL(path, context.apiUrl);
      let value: unknown;
      if (url.pathname === '/v1/me') value = { principal: reader, meta: meta(1) };
      else if (url.pathname === `/v1/flights/${flightId}/timeline`) {
        expect(url.searchParams.get('limit')).toBe('500');
        expect(url.searchParams.get('decisionLimit')).toBe('1');
        value = timeline;
      } else if (url.pathname.startsWith(`/v1/flights/${flightId}/rule-selections/`)) {
        expect(url.search).toBe('');
        value = historicalSelections.get(decodeURIComponent(url.pathname.split('/').at(-1)!));
        if (!value)
          throw new OracleReadError('pending', 'resource_unavailable', 'Historical selection is not available');
      } else if (url.pathname.startsWith('/v1/receipts/')) value = receipts.get(url.pathname.split('/').at(-1)!);
      else if (url.pathname.startsWith('/v1/artifacts/')) value = artifacts.get(url.pathname.split('/').at(-1)!);
      if (!value) throw new Error(`Unexpected command-link oracle GET ${path}`);
      usage.requests++;
      usage.bytes += Buffer.byteLength(JSON.stringify(value));
      return structuredClone(value) as T;
    },
    async bytes(path: string): Promise<Uint8Array> {
      reads.push(path);
      if (readFailures.has(path)) throw readFailures.get(path)!;
      const match = path.match(/^\/v1\/artifacts\/([^/]+)\/content$/);
      const value = match ? originals.get(match[1]!) : undefined;
      if (!value) throw new Error(`Unexpected command-link oracle bytes GET ${path}`);
      usage.requests++;
      usage.bytes += value.byteLength;
      return Uint8Array.from(value);
    },
    usage: () => ({ ...usage }),
  };
  const raw = () => {
    const body = JSON.stringify(journal);
    return Buffer.from(JSON.stringify({ version: 1, body, sha256: sha256(body) }) + '\n');
  };
  return {
    journal,
    entries,
    receipts,
    artifacts,
    originals,
    historicalSelections,
    timeline,
    reader,
    reads,
    readFailures,
    api,
    raw,
    audit: () => auditCommandLinkJournal(raw(), context, api),
  };
}

function retimeReport(f: ReturnType<typeof fixture>, status: 'lost' | 'restored', occurredAt: string): void {
  const entry = f.entries.find((candidate) => candidate.fact.status === status)!;
  const source = JSON.parse(Buffer.from(entry.bytesBase64, 'base64').toString('utf8')) as CommandLinkSource;
  source.occurredAt = occurredAt;
  const bytes = Buffer.from(JSON.stringify(source));
  const digest = sha256(bytes);
  entry.fact.at = occurredAt;
  entry.bytesBase64 = bytes.toString('base64');
  const receipt = f.receipts.get(entry.accepted!.receiptId)!.receipt;
  receipt.occurredAt = occurredAt;
  receipt.payload = observationOf(bytes, entry.accepted!.artifactId);
  const item = f.timeline.items.find((candidate) => candidate.receiptId === receipt.id)!;
  item.occurredAt = occurredAt;
  item.payload = structuredClone(receipt.payload);
  f.originals.set(entry.accepted!.artifactId, Uint8Array.from(bytes));
  const artifact = f.artifacts.get(entry.accepted!.artifactId)!.artifact;
  artifact.sha256 = digest;
  artifact.byteLength = bytes.byteLength;
  const finding = f.timeline.findings[0]!;
  for (const evaluation of [finding.initialEvaluation, finding.latestEvaluation]) {
    const evidence = evaluation.explanation.evidence.find((report) => report.receiptId === receipt.id);
    if (evidence) evidence.occurredAt = occurredAt;
  }
}

function removeReport(f: ReturnType<typeof fixture>, status: 'lost' | 'restored'): string {
  const entry = f.entries.find((candidate) => candidate.fact.status === status)!;
  const receiptId = entry.accepted!.receiptId;
  delete f.journal.facts[entry.fact.sequence];
  f.entries.splice(f.entries.indexOf(entry), 1);
  f.receipts.delete(receiptId);
  f.artifacts.delete(entry.accepted!.artifactId);
  f.originals.delete(entry.accepted!.artifactId);
  f.timeline.items = f.timeline.items.filter((item) => item.receiptId !== receiptId);
  f.timeline.window.items.returned = f.timeline.items.length;
  return receiptId;
}

function removeRestoration(f: ReturnType<typeof fixture>): void {
  const receiptId = removeReport(f, 'restored');
  const finding = f.timeline.findings[0]!;
  const evaluation = finding.latestEvaluation;
  evaluation.explanation.evidence = evaluation.explanation.evidence.filter((report) => report.receiptId !== receiptId);
  evaluation.explanation.details = {
    ...evaluation.explanation.details,
    openEpisodeCount: 1,
    closedEpisodeCount: 0,
    transitionCount: 1,
  };
  evaluation.explanation.code = 'episode_open';
  evaluation.explanation.summary = 'A reported loss lacks a strictly later restoration.';
  evaluation.evidenceState = 'insufficient';
  evaluation.outcome = 'attention';
  finding.initialEvaluation = structuredClone(evaluation);
  finding.openedAt = finding.initialEvaluation.recordedAt;
}

describe('retained command-link oracle', () => {
  it('matches exact originals and scoped reports while retaining an earlier canonical artifact and issuer', async () => {
    const f = fixture(true);
    const result = await f.audit();
    expect(result).toMatchObject({
      kind: 'command-link',
      status: 'match',
      attemptId: context.attemptId,
      tenant: 'alpha',
      flightId,
      journalSha256: sha256(f.raw()),
      counts: { confirmedFacts: 2, unconfirmedFacts: 0, receipts: 2, artifacts: 2 },
      issues: [],
    });
    expect(result.reports.map((report) => report.status)).toEqual(['lost', 'restored']);
    for (const report of result.reports) {
      expect(report).toMatchObject({
        sourceId,
        sourceSessionId,
        aircraftId,
        incidentId,
        actorId: 'source-earlier-alpha',
      });
    }
    for (const status of ['lost', 'restored'])
      expect(f.reads).toContain(`/v1/artifacts/artifact-canonical-${status}/content`);
    expect(f.reader.capabilities).toEqual(['flight:read', 'evidence:read']);
    expect(f.timeline.meta.outstandingWork).toBe(999);
    expect(result.finding).toMatchObject({
      findingId: 'finding-command-link',
      evaluationId: 'evaluation-restored',
      evidenceState: 'supported',
      outcome: 'pass',
    });
    expect(result.finding).toMatchObject({
      treatmentStatus: 'acknowledged',
      treatmentOwner: { id: 'operator-alpha', name: 'Maya Chen' },
    });
    expect(f.reads.some((path) => path.includes('/rule-selections/'))).toBe(false);
  });

  it('rejects changed original bytes, normalized source mapping and immutable flight scope', async () => {
    const changedBytes = fixture();
    const artifact = changedBytes.artifacts.get('artifact-lost')!.artifact;
    const bytes = Buffer.concat([Buffer.from(changedBytes.originals.get(artifact.id)!), Buffer.from('\n')]);
    changedBytes.originals.set(artifact.id, bytes);
    artifact.sha256 = sha256(bytes);
    artifact.byteLength = bytes.byteLength;
    expect((await changedBytes.audit()).status).toBe('mismatch');

    const mapped = fixture();
    const values = {
      ...(mapped.receipts.get('receipt-lost')!.receipt.payload.values as object),
      sourceEpisodeId: 'other',
    };
    mapped.receipts.get('receipt-lost')!.receipt.payload.values = values;
    mapped.timeline.items[0]!.payload.values = values;
    expect((await mapped.audit()).status).toBe('mismatch');

    const scoped = fixture();
    scoped.receipts.get('receipt-restored')!.receipt.flightId = 'other-flight';
    scoped.timeline.items[1]!.actorId = 'different-actor';
    expect((await scoped.audit()).status).toBe('mismatch');
  });

  it('keeps undelivered facts pending without searching by key or writing', async () => {
    const undelivered = fixture();
    for (const entry of undelivered.entries) delete entry.accepted;
    undelivered.timeline.items = [];
    undelivered.timeline.findings = [];
    undelivered.timeline.window.items.returned = 0;
    expect(await undelivered.audit()).toMatchObject({
      status: 'pending',
      counts: { confirmedFacts: 0, unconfirmedFacts: 2, receipts: 0, artifacts: 0 },
    });
    expect(undelivered.reads.some((path) => /receipts|artifacts|idempotency|inputs/.test(path))).toBe(false);
  });

  it('fails closed on broken local commitments, unknown versions and a different authenticated tenant', async () => {
    const brokenEnvelope = fixture();
    const envelope = JSON.parse(brokenEnvelope.raw().toString()) as { version: number; body: string; sha256: string };
    envelope.body += ' ';
    expect(
      (await auditCommandLinkJournal(Buffer.from(JSON.stringify(envelope)), context, brokenEnvelope.api)).status,
    ).toBe('unverifiable');
    expect(brokenEnvelope.reads).toEqual([]);

    const changedAcceptance = fixture();
    (changedAcceptance.entries[0]!.accepted as Record<string, unknown>).submission = 'added after delivery';
    expect((await changedAcceptance.audit()).status).toBe('unverifiable');
    expect(changedAcceptance.reads).toEqual([]);

    // A journal kept by the retired dedicated intake is not read.
    const retired = fixture();
    retired.journal.version = 1;
    expect((await retired.audit()).status).toBe('unverifiable');
    expect(retired.reads).toEqual([]);

    const foreign = fixture();
    foreign.reader.tenantId = 'tenant-beta';
    expect((await foreign.audit()).status).toBe('unverifiable');
    expect(foreign.reads).toEqual(['/v1/me']);
  });

  it('preserves pending versus unverifiable read errors and enforces the shared HTTP request budget', async () => {
    const unavailable = fixture();
    unavailable.readFailures.set(
      '/v1/receipts/receipt-lost',
      new OracleReadError('pending', 'resource_unavailable', 'Receipt is not available'),
    );
    expect((await unavailable.audit()).status).toBe('pending');
    const denied = fixture();
    denied.readFailures.set(
      '/v1/artifacts/artifact-lost',
      new OracleReadError('unverifiable', 'authority_unavailable', 'Read authority is unavailable'),
    );
    expect((await denied.audit()).status).toBe('unverifiable');

    const bounded = fixture();
    const api = new OracleApi(context.apiUrl, 'fictional-read-only-token', { requests: 2 }, async (url, init) => {
      expect(init?.method).toBe('GET');
      const path = new URL(String(url));
      return Response.json(await bounded.api.json(`${path.pathname}${path.search}`));
    });
    const result = await auditCommandLinkJournal(bounded.raw(), context, api);
    expect(result.status).toBe('unverifiable');
    expect(result.issues.some((issue) => issue.code === 'request_limit')).toBe(true);
    expect(result.usage.requests).toBe(2);
  });

  it('requires a complete projected C2 verdict with exact evidence while allowing unrelated landing rows', async () => {
    const unrelated = fixture();
    unrelated.timeline.items.push({
      id: 'native-landing-event',
      kind: 'flight.observation',
      lane: 'observed',
      title: 'Landing reported',
      occurredAt: restoredAt,
      receivedAt: evaluatedAt,
      actorId: 'native-person-alpha',
      sourceId: 'simulation-person-alpha',
      payload: { activity: 'landed', landingTime: restoredAt },
      receiptId: 'native-landing-receipt',
      artifactId: 'native-landing-artifact',
      linkStatus: 'linked',
    });
    unrelated.timeline.flight.activity = 'landed';
    unrelated.timeline.window.items.returned = unrelated.timeline.items.length;
    expect((await unrelated.audit()).status).toBe('match');

    const continuation = fixture();
    continuation.timeline.window.items.selection = 'continuation';
    expect((await continuation.audit()).status).toBe('unverifiable');
    const incompleteCount = fixture();
    incompleteCount.timeline.window.items.returned = incompleteCount.timeline.items.length - 1;
    expect((await incompleteCount.audit()).status).toBe('unverifiable');

    const pending = fixture();
    pending.timeline.flight.outstandingWork = 1;
    pending.timeline.findings = [];
    expect((await pending.audit()).status).toBe('pending');

    const absent = fixture();
    absent.timeline.findings = [];
    expect((await absent.audit()).status).toBe('unverifiable');
    const restorationOnly = fixture();
    removeReport(restorationOnly, 'lost');
    expect((await restorationOnly.audit()).status).toBe('unverifiable');
    const wrongScope = fixture();
    wrongScope.timeline.findings[0]!.latestEvaluation.explanation.details.openEpisodeCount = 1;
    expect((await wrongScope.audit()).status).toBe('mismatch');
    const unsupported = fixture();
    unsupported.timeline.findings[0]!.latestEvaluation.explanation.ruleEvaluation.check.kind = 'values.disagree';
    expect((await unsupported.audit()).status).toBe('unverifiable');
    const unknownExplanation = fixture();
    unknownExplanation.timeline.findings[0]!.latestEvaluation.explanation.kind = 'rule_v2';
    expect((await unknownExplanation.audit()).status).toBe('unverifiable');
  });

  it('independently matches unresolved, tied and future-blocked verdicts without treating consistency as healthy communications', async () => {
    const unresolved = fixture();
    removeRestoration(unresolved);
    expect(await unresolved.audit()).toMatchObject({
      status: 'match',
      counts: { confirmedFacts: 1, unconfirmedFacts: 0, receipts: 1, artifacts: 1 },
      finding: { evidenceState: 'insufficient', outcome: 'attention' },
    });

    const tied = fixture();
    retimeReport(tied, 'restored', lostAt);
    const conflict = tied.timeline.findings[0]!.latestEvaluation;
    conflict.explanation.details = {
      ...conflict.explanation.details,
      closedEpisodeCount: 0,
      conflictingEpisodeCount: 1,
    };
    conflict.explanation.code = 'episode_conflicting';
    conflict.explanation.summary =
      'Loss and restoration are reported at the same latest instant within an incident scope.';
    conflict.evidenceState = 'conflicting';
    conflict.outcome = 'attention';
    expect(await tied.audit()).toMatchObject({
      status: 'match',
      finding: { evidenceState: 'conflicting', outcome: 'attention' },
    });

    const future = fixture();
    retimeReport(future, 'restored', '2026-10-15T14:03:00.000Z');
    const blocked = future.timeline.findings[0]!.latestEvaluation;
    blocked.explanation.code = 'transition_unreadable';
    blocked.explanation.summary =
      'A scoped report occurs after the retained evaluation time. Restoration cannot be established.';
    blocked.evidenceState = 'insufficient';
    blocked.outcome = 'attention';
    expect(await future.audit()).toMatchObject({
      status: 'match',
      finding: { evidenceState: 'insufficient', outcome: 'attention' },
    });
    blocked.explanation.code = 'episodes_closed';
    blocked.evidenceState = 'supported';
    blocked.outcome = 'pass';
    expect((await future.audit()).status).toBe('mismatch');
  });

  it('matches an open review whose first evaluation already had restoration before the late historical loss arrived', async () => {
    const f = fixture();
    const loss = f.entries.find((entry) => entry.fact.status === 'lost')!;
    const lossReceipt = f.receipts.get(loss.accepted!.receiptId)!.receipt;
    lossReceipt.receivedAt = '2026-10-15T14:02:07.000Z';
    f.timeline.items.find((item) => item.receiptId === lossReceipt.id)!.receivedAt = lossReceipt.receivedAt;
    f.timeline.items.sort((left, right) => left.receivedAt.localeCompare(right.receivedAt));
    expect(f.timeline.items.map((item) => item.receiptId)).toEqual(['receipt-restored', 'receipt-lost']);
    const finding = f.timeline.findings[0]!;
    finding.status = 'open';
    finding.owner = null;
    finding.initialEvaluation = structuredClone(finding.latestEvaluation);
    finding.openedAt = finding.initialEvaluation.recordedAt;
    const result = await f.audit();
    expect(result).toMatchObject({
      status: 'match',
      finding: { evidenceState: 'supported', outcome: 'pass' },
    });
    expect(result.finding).toMatchObject({ treatmentStatus: 'open', treatmentOwner: null });
    expect(finding.initialEvaluation.outcome).toBe('pass');
    expect(finding.latestEvaluation.outcome).toBe('pass');
  });
});
