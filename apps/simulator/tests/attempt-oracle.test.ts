import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  ArtifactResponse,
  EvaluationRecord,
  Input,
  Principal,
  ReceiptResponse,
  ResponseMeta,
  RuleEvaluationExplanation,
  TimelineResponse,
  TelemetrySegment,
} from '@ledger/contracts';
import type { WorldFact } from '../../../packages/simulation-models/src/operation.js';
import { auditAttemptJournal } from '../src/attempt-oracle.js';
import { OracleApi } from '../src/oracle-api.js';
import { prepareWorldFact, type PreparedWorldFact } from '../src/operation-delivery.js';

const context = {
  attemptId: 'intent-oracle-alpha-0:attempt:1',
  tenant: 'alpha' as const,
  apiUrl: 'http://oracle.test',
};
const aircraftId = 'DJI-oracle-alpha-01';
const sourceSessionId = 'intent-oracle-alpha-0-capture-1';
const physicalLanding = '2026-10-15T14:06:00.000Z';
const reportedLanding = '2026-10-15T14:06:30.000Z';
const reportAt = '2026-10-15T14:07:30.000Z';
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

function meta(revision: number): ResponseMeta {
  return {
    requestId: `request-${revision}`,
    projectionRevision: revision,
    inputCut: { streams: { unrelated: revision }, basisRevision: revision },
    dependencyBasis: sha256(`unrelated-basis-${revision}`),
    computedAt: reportAt,
    outstandingWork: 999,
  };
}

function fixture(includeTransport = false, extraPendingDepartures = 0) {
  const landing: WorldFact = {
    sequence: includeTransport ? 4 : 3,
    tenant: context.tenant,
    attemptId: context.attemptId,
    aircraftId,
    sourceSessionId,
    kind: 'landing',
    at: physicalLanding,
    personId: 'oracle-person-alpha-01',
    personName: 'Maya Chen',
  };
  const report: WorldFact = {
    ...landing,
    sequence: includeTransport ? 5 : 4,
    kind: 'landing-report',
    at: reportAt,
    sourceId: 'simulation-person-alpha-buffered',
    sourceSessionId: `${sourceSessionId}-buffered-person`,
    reportAt,
    reportedLandingAt: reportedLanding,
    incidentId: `${context.attemptId}:landing-disagreement`,
    incidentCause: 'handset-clock-offset',
    personId: 'oracle-person-alpha-ground',
    personName: 'Avery Collins',
  };
  const facts: Record<string, PreparedWorldFact & { receiptId?: string }> = {};
  const commitments: Array<{
    principalId: string;
    key: string;
    input: Input;
    wireDigests: string[];
    receiptId?: string;
  }> = [];
  const receipts = new Map<string, ReceiptResponse>();
  const artifacts = new Map<string, ArtifactResponse>();
  const originals = new Map<string, Uint8Array>();
  function retain(prepared: PreparedWorldFact[], input: Input, bytes: Uint8Array, wireDigests: string[] = []) {
    const fact = prepared[0]!.fact;
    const receiptId = `receipt-${fact.sequence}`;
    const artifactId = input.artifactId!;
    for (const entry of prepared) facts[entry.fact.sequence] = { ...entry, receiptId };
    commitments.push({
      principalId: input.kind === 'flight.observation' ? 'actor-alpha' : 'partner-alpha',
      key: `operation:${fact.sourceSessionId}:${fact.sequence}:${fact.kind}`,
      input,
      wireDigests,
      receiptId,
    });
    receipts.set(receiptId, {
      receipt: {
        id: receiptId,
        eventId: `event-${fact.sequence}`,
        sourceId: input.sourceId,
        kind: input.kind,
        occurredAt: input.occurredAt,
        receivedAt: reportAt,
        status: 'accepted',
        processing: { status: 'completed', attempts: 1 },
        linkStatus: 'linked',
        flightId: 'flight-oracle',
        artifactId,
        payload: structuredClone(input.payload),
      },
      meta: meta(fact.sequence + 10),
    });
    artifacts.set(artifactId, {
      artifact: {
        id: artifactId,
        uploadId: `upload-${fact.sequence}`,
        sha256: sha256(bytes),
        byteLength: bytes.byteLength,
        contentType: 'application/json',
        key: `retained/${artifactId}`,
      },
      meta: meta(fact.sequence + 20),
    });
    originals.set(artifactId, bytes);
  }

  const departure: WorldFact = { ...landing, sequence: 1, kind: 'departure', at: '2026-10-15T14:00:00.000Z' };
  const additionalDepartures: WorldFact[] = Array.from({ length: extraPendingDepartures }, (_, index) => ({
    ...departure,
    sequence: index + 10,
    sourceSessionId: `${sourceSessionId}-pending-${index}`,
  }));
  const native = includeTransport ? [departure, landing, report] : [landing, report];
  for (const fact of [...native, ...additionalDepartures]) {
    const prepared = prepareWorldFact(fact);
    const bytes = Uint8Array.from(Buffer.from(prepared.bytesBase64, 'base64'));
    retain(
      [prepared],
      {
        kind: 'flight.observation',
        sourceId: fact.kind === 'landing-report' ? fact.sourceId : 'simulation-person-alpha',
        sourceSessionId: fact.sourceSessionId,
        occurredAt: fact.at,
        subject: { originationKey: context.attemptId },
        payload: JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, unknown>,
        artifactId: `artifact-${fact.sequence}`,
        fidelity: 'synthetic_contract',
      },
      bytes,
    );
    if (fact.sequence >= 10) receipts.get(`receipt-${fact.sequence}`)!.receipt.processing.status = 'pending';
  }
  if (includeTransport) {
    const order: WorldFact = {
      ...departure,
      sequence: 0,
      kind: 'order',
      order: {
        order_id: 'order-oracle',
        version: 2,
        updated_at: departure.at,
        state: 'accepted',
        schedule: { start: departure.at, end: physicalLanding },
        requested_work: { name: 'Lab courier' },
        flights: [
          {
            flight_intent_id: 'intent-oracle-alpha-0',
            attempt: 1,
            order_refs: ['order-oracle'],
            aircraft_id: aircraftId,
          },
        ],
      },
    };
    const preparedOrder = prepareWorldFact(order);
    retain(
      [preparedOrder],
      {
        kind: 'order.revision',
        sourceId: 'partner-orders',
        sourceSessionId,
        occurredAt: departure.at,
        sourceRevision: 2,
        subject: { orderId: 'order-oracle' },
        payload: {
          externalId: 'order-oracle',
          revision: 2,
          status: 'accepted',
          label: 'Lab courier',
          scheduledStart: departure.at,
          scheduledEnd: physicalLanding,
          fulfillments: [
            {
              originationKey: context.attemptId,
              label: 'Lab courier',
              aircraft: aircraftId,
              scheduledStart: departure.at,
              scheduledEnd: physicalLanding,
              orderRefs: [{ orderId: 'order-oracle', revision: 2 }],
              aliases: [{ sourceId: 'partner-orders', externalId: 'intent-oracle-alpha-0' }],
            },
          ],
        },
        artifactId: 'artifact-0',
        fidelity: 'synthetic_contract',
      },
      Buffer.from(preparedOrder.bytesBase64, 'base64'),
    );
    const positions = [10, 20].map((second, index) => {
      const at = `2026-10-15T14:00:${second}.000Z`;
      return prepareWorldFact({
        ...departure,
        sequence: index + 2,
        kind: 'position',
        at,
        point: {
          occurredAt: at,
          latitude: 41.8804 + index * 0.0006,
          longitude: -87.6296 + index * 0.0006,
          height: 240,
          horizontalSpeed: 8,
        },
      });
    });
    const topic = `thing/product/${aircraftId}/osd`;
    const segment: TelemetrySegment = {
      format: 'ledger.telemetry-segment.1',
      sourceId: 'dji-osd',
      sourceSessionId,
      deviceId: aircraftId,
      gatewayId: `GW-${aircraftId}`,
      decoderVersion: 'dji-osd.synthetic.1',
      fidelity: 'synthetic_contract',
      coordinateReference: 'WGS84',
      sequenceBasis: 'adapter_capture',
      sessionStartSequence: 0,
      samples: positions.map((prepared, index) => {
        if (prepared.fact.kind !== 'position') throw new Error('Position fixture missing');
        return {
          sequence: index,
          occurredAt: prepared.fact.at,
          latitude: prepared.fact.point.latitude,
          longitude: prepared.fact.point.longitude,
          altitudeMeters: 240,
          altitudeReference: 'ellipsoid',
          speedMetersPerSecond: 8,
          original: { topic, bytesBase64: prepared.bytesBase64 },
        };
      }),
    };
    retain(
      positions,
      {
        kind: 'telemetry.segment',
        sourceId: 'dji-osd',
        sourceSessionId,
        occurredAt: positions[1]!.fact.at,
        subject: { flightId: 'flight-oracle' },
        payload: {
          format: segment.format,
          deviceId: aircraftId,
          gatewayId: segment.gatewayId,
          decoderVersion: segment.decoderVersion,
          sequenceBasis: 'adapter_capture',
          sessionStartSequence: 0,
          sampleCount: 2,
          firstSequence: 0,
          lastSequence: 1,
          firstOccurredAt: positions[0]!.fact.at,
          lastOccurredAt: positions[1]!.fact.at,
        },
        artifactId: 'artifact-2',
        fidelity: 'synthetic_contract',
      },
      new TextEncoder().encode(JSON.stringify(segment)),
      positions.map((prepared) =>
        sha256(Buffer.concat([Buffer.from(topic), Buffer.from([0]), Buffer.from(prepared.bytesBase64, 'base64')])),
      ),
    );
  }
  const items = [...receipts.values()]
    .filter(({ receipt }) => receipt.processing.status === 'completed')
    .map(({ receipt }) => ({
      id: receipt.eventId,
      lane: 'observed' as const,
      kind: receipt.kind,
      title: String(receipt.payload.title),
      occurredAt: receipt.occurredAt,
      receivedAt: receipt.receivedAt,
      actorId: commitments.find((commitment) => commitment.receiptId === receipt.id)!.principalId,
      sourceId: receipt.sourceId,
      payload: structuredClone(receipt.payload),
      receiptId: receipt.id,
      artifactId: receipt.artifactId,
      linkStatus: 'linked' as const,
    }));
  const evidence = items
    .filter((item) => item.kind === 'flight.observation')
    .map((item) => ({
      eventId: item.id,
      receiptId: item.receiptId,
      sourceId: item.sourceId,
      occurredAt: item.occurredAt,
    }));
  const evaluation: EvaluationRecord = {
    id: 'evaluation-oracle',
    flightId: 'flight-oracle',
    leafId: 'ledger.demo.landing-disagreement',
    leafVersion: 2,
    bindingId: 'ledger.demo-procedures',
    bindingVersion: 4,
    applicability: 'applicable',
    evidenceState: 'conflicting',
    outcome: 'attention',
    title: 'Landing reports disagree',
    explanation: {
      kind: 'rule',
      code: 'values_disagree',
      summary: 'Two retained landing claims disagree.',
      evidence: evidence.map((ref) => ({ ...ref, observationId: ref.eventId, type: 'flight.report', version: 1 })),
      details: {
        values: [physicalLanding, reportedLanding]
          .map((value) => new Date(value).toISOString())
          .sort()
          .join(', '),
        valueCount: 2,
        reportCount: 2,
      },
      parameters: { fields: ['values.landingAt'], valueType: 'utc_instant' },
      inputs: [{ name: 'reports', type: 'flight.report', observationIds: evidence.map((ref) => ref.eventId) }],
      ruleEvaluation: {
        pack: { id: 'ledger.demo-procedures', version: 4, digest: 'b'.repeat(64) },
        ruleDigest: 'c'.repeat(64),
        check: { kind: 'values.disagree', version: 1 },
        mode: 'active',
        subjectKey: 'ledger/flight/flight-oracle',
      },
      evaluatedAt: reportAt,
    },
    clock: { mode: 'wall', evaluatedAt: reportAt },
    inputCut: { streams: { observations: 2 }, basisRevision: 2 },
    acceptedInputCut: { streams: { observations: 2, later_work: 4 }, basisRevision: 7 },
    dependencyBasis: sha256('evaluation-basis'),
    recordedAt: reportAt,
  };
  const timeline: TimelineResponse = {
    flight: {
      id: 'flight-oracle',
      label: 'Lab courier',
      originationKey: context.attemptId,
      revision: 9,
      basisRevision: 8,
      activity: 'landed',
      coverage: 'conflicting',
      aircraft: aircraftId,
      orderIds: ['order-oracle'],
      sourceIds: items.map((item) => item.sourceId),
      unresolvedCount: 0,
      conflictCount: 1,
      outstandingWork: 0,
    },
    items,
    decisions: [],
    findings: [
      {
        id: 'finding-oracle',
        flightId: 'flight-oracle',
        status: 'open',
        owner: null,
        openedAt: reportAt,
        initialEvaluation: structuredClone(evaluation),
        latestEvaluation: evaluation,
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
    meta: meta(100),
  };
  const journal = {
    version: 2,
    binding: sha256(JSON.stringify({ apiUrl: context.apiUrl, tenant: context.tenant, attemptId: context.attemptId })),
    principals: { source: 'partner-alpha', actor: 'actor-alpha' },
    flightId: 'flight-oracle',
    aircraftId,
    primarySessionId: sourceSessionId,
    facts,
    commitments,
  };
  const reads: string[] = [];
  const usage = { requests: 0, bytes: 0 };
  const reader: Principal = {
    commandLinkSources: [],
    id: 'read-only-auditor',
    tenantId: 'tenant-alpha',
    name: 'Read-only auditor',
    capabilities: ['flight:read', 'evidence:read'],
    revision: 1,
  };
  const api = {
    async json<T>(path: string): Promise<T> {
      reads.push(path);
      const url = new URL(path, context.apiUrl);
      let value: unknown;
      if (url.pathname === '/v1/me')
        value = {
          principal: reader,
          meta: meta(1),
        };
      else if (url.pathname === '/v1/flights/flight-oracle/timeline') {
        expect(url.searchParams.get('limit')).toBe('500');
        expect(url.searchParams.get('decisionLimit')).toBe('1');
        value = timeline;
      } else if (url.pathname.startsWith('/v1/receipts/')) value = receipts.get(url.pathname.split('/').at(-1)!);
      else if (url.pathname.startsWith('/v1/artifacts/')) value = artifacts.get(url.pathname.split('/').at(-1)!);
      if (!value) throw new Error(`Unexpected oracle GET ${path}`);
      usage.requests++;
      usage.bytes += Buffer.byteLength(JSON.stringify(value));
      return structuredClone(value) as T;
    },
    async bytes(path: string): Promise<Uint8Array> {
      reads.push(path);
      const match = path.match(/^\/v1\/artifacts\/([^/]+)\/content$/);
      const bytes = match ? originals.get(match[1]!) : undefined;
      if (!bytes) throw new Error(`Unexpected oracle artifact GET ${path}`);
      usage.requests++;
      usage.bytes += bytes.byteLength;
      return Uint8Array.from(bytes);
    },
    usage: () => ({ ...usage }),
  };
  const raw = () => new TextEncoder().encode(JSON.stringify(journal) + '\n');
  return {
    journal,
    receipts,
    artifacts,
    originals,
    timeline,
    raw,
    api,
    reader,
    reads,
    audit: () => auditAttemptJournal(raw(), context, api),
  };
}

describe('one-attempt retained-byte oracle', () => {
  it('matches retained reports, wire frames and findings despite unrelated tenant work and different read bases', async () => {
    const f = fixture(true);
    const explanation = f.timeline.findings![0]!.latestEvaluation.explanation;
    explanation.evidence = explanation.evidence
      .map((entry) => Object.fromEntries(Object.entries(entry).reverse()) as typeof entry)
      .reverse();
    const result = await f.audit();
    expect(result).toMatchObject({
      status: 'match',
      attemptId: context.attemptId,
      tenant: 'alpha',
      journalSha256: sha256(f.raw()),
      flightId: 'flight-oracle',
      physicalLanding,
      counts: { confirmedFacts: 6, unconfirmedFacts: 0, receipts: 5, artifacts: 5 },
      issues: [],
    });
    expect(result.reportedLandings).toEqual([
      {
        receiptId: 'receipt-4',
        eventId: 'event-4',
        sourceId: 'simulation-person-alpha',
        occurredAt: physicalLanding,
        landingTime: physicalLanding,
      },
      {
        receiptId: 'receipt-5',
        eventId: 'event-5',
        sourceId: 'simulation-person-alpha-buffered',
        occurredAt: reportAt,
        landingTime: reportedLanding,
      },
    ]);
    expect(result.usage).toEqual(f.api.usage());
    expect(f.reads.filter((path) => path.endsWith('/content'))).toHaveLength(5);
    expect(f.timeline.findings![0]!.latestEvaluation.explanation.evidence).toHaveLength(3);
    const segment = JSON.parse(Buffer.from(f.originals.get('artifact-2')!).toString('utf8')) as TelemetrySegment;
    segment.samples[1]!.original.bytesBase64 = segment.samples[0]!.original.bytesBase64;
    const changed = new TextEncoder().encode(JSON.stringify(segment));
    f.originals.set('artifact-2', changed);
    Object.assign(f.artifacts.get('artifact-2')!.artifact, { sha256: sha256(changed), byteLength: changed.byteLength });
    expect((await f.audit()).status).toBe('mismatch');

    const normalized = fixture(true);
    const normalizedSegment = JSON.parse(
      Buffer.from(normalized.originals.get('artifact-2')!).toString('utf8'),
    ) as TelemetrySegment;
    normalizedSegment.samples[1]!.latitude += 0.01;
    const normalizedBytes = new TextEncoder().encode(JSON.stringify(normalizedSegment));
    normalized.originals.set('artifact-2', normalizedBytes);
    Object.assign(normalized.artifacts.get('artifact-2')!.artifact, {
      sha256: sha256(normalizedBytes),
      byteLength: normalizedBytes.byteLength,
    });
    const normalizedResult = await normalized.audit();
    expect(normalizedResult.status).toBe('mismatch');
    expect(
      normalizedResult.issues.some((issue) => issue.status === 'mismatch' && issue.artifactId === 'artifact-2'),
    ).toBe(true);
  });

  it('rejects immutable receipt, original-byte and flight identity mismatches', async () => {
    const receipt = fixture();
    receipt.receipts.get('receipt-4')!.receipt.payload.landingTime = physicalLanding;
    expect((await receipt.audit()).status).toBe('mismatch');

    const original = fixture();
    const changed = Buffer.concat([original.originals.get('artifact-4')!, Buffer.from('\n')]);
    original.originals.set('artifact-4', changed);
    Object.assign(original.artifacts.get('artifact-4')!.artifact, {
      sha256: sha256(changed),
      byteLength: changed.byteLength,
    });
    expect((await original.audit()).status).toBe('mismatch');

    const flight = fixture();
    flight.timeline.flight.originationKey = 'a-different-attempt';
    expect((await flight.audit()).status).toBe('mismatch');

    const attribution = fixture();
    attribution.timeline.items[0]!.actorId = 'other-actor';
    attribution.timeline.items[0]!.artifactId = 'other-artifact';
    const attributionResult = await attribution.audit();
    expect(attributionResult.status).toBe('mismatch');
    expect(attributionResult.issues.some((issue) => issue.status === 'pending')).toBe(false);
  });

  it('distinguishes pending projection and locally unconfirmed delivery from evidence absence', async () => {
    const pending = fixture();
    pending.receipts.get('receipt-4')!.receipt.processing.status = 'pending';
    pending.timeline.items = pending.timeline.items.slice(0, 1);
    pending.timeline.window.items.returned = 1;
    pending.timeline.findings = [];
    const pendingResult = await pending.audit();
    expect(pendingResult.status).toBe('pending');
    expect(pendingResult.issues.some((issue) => issue.status === 'pending' && issue.receiptId === 'receipt-4')).toBe(
      true,
    );

    const subjectPending = fixture();
    subjectPending.timeline.flight.outstandingWork = 1;
    subjectPending.timeline.findings = [];
    const subjectPendingResult = await subjectPending.audit();
    expect(subjectPendingResult.status).toBe('pending');
    expect(subjectPendingResult.counts.confirmedFacts).toBe(2);
    expect(subjectPendingResult.issues.some((issue) => issue.status === 'mismatch')).toBe(false);

    const saturated = fixture(false, 18);
    const lastArtifactId = 'artifact-27';
    const changed = Buffer.concat([saturated.originals.get(lastArtifactId)!, Buffer.from('\n')]);
    saturated.originals.set(lastArtifactId, changed);
    Object.assign(saturated.artifacts.get(lastArtifactId)!.artifact, {
      sha256: sha256(changed),
      byteLength: changed.byteLength,
    });
    const saturatedResult = await saturated.audit();
    expect(saturatedResult.status).toBe('mismatch');
    expect(saturatedResult.counts).toMatchObject({ receipts: 20, artifacts: 20 });
    expect(saturatedResult.issues.length).toBeLessThanOrEqual(16);
    expect(
      saturatedResult.issues.some((issue) => issue.status === 'mismatch' && issue.artifactId === lastArtifactId),
    ).toBe(true);

    const unconfirmed = fixture();
    delete unconfirmed.journal.facts['4']!.receiptId;
    delete unconfirmed.journal.commitments[1]!.receiptId;
    const unconfirmedResult = await unconfirmed.audit();
    expect(unconfirmedResult.status).toBe('unverifiable');
    expect(unconfirmedResult.counts.unconfirmedFacts).toBe(1);
    expect(unconfirmedResult.issues.some((issue) => issue.status === 'mismatch')).toBe(false);

    const absentTruth = fixture();
    delete absentTruth.journal.facts['3'];
    absentTruth.journal.commitments.shift();
    absentTruth.timeline.items.shift();
    absentTruth.timeline.window.items.returned = 1;
    absentTruth.timeline.findings = [];
    const absentResult = await absentTruth.audit();
    expect(absentResult.status).toBe('unverifiable');
    expect(absentResult.physicalLanding).toBeUndefined();
  });

  it('refuses unsupported local bytes or timeline evidence outside the retained attempt scope', async () => {
    const version = fixture();
    version.journal.version = 77;
    expect((await version.audit()).status).toBe('unverifiable');

    const changed = fixture();
    const payload = { ...changed.journal.commitments[1]!.input.payload, landingTime: physicalLanding };
    changed.journal.commitments[1]!.input.payload = payload;
    changed.journal.facts['4']!.bytesBase64 = Buffer.from(JSON.stringify(payload)).toString('base64');
    expect((await changed.audit()).status).toBe('unverifiable');

    const extra = fixture();
    extra.timeline.items.push({
      ...structuredClone(extra.timeline.items[0]!),
      id: 'event-outside-journal',
      receiptId: 'receipt-outside-journal',
      sourceId: 'another-source',
    });
    extra.timeline.window.items.returned = 3;
    expect((await extra.audit()).status).toBe('unverifiable');

    const correction = fixture();
    correction.timeline.items[0]!.correctionOf = 'older-corrected-event';
    expect((await correction.audit()).status).toBe('unverifiable');

    const otherTenant = fixture();
    otherTenant.reader.tenantId = 'tenant-beta';
    expect((await otherTenant.audit()).status).toBe('unverifiable');
    expect(otherTenant.reads).toEqual(['/v1/me']);
  });

  it('requires the completed disagreement finding to pin both report identities and landing claims', async () => {
    const absent = fixture();
    absent.timeline.findings = [];
    expect((await absent.audit()).status).toBe('mismatch');

    const wrongBasis = fixture();
    const explanation = wrongBasis.timeline.findings![0]!.latestEvaluation.explanation;
    explanation.evidence[1]!.sourceId = 'wrong-source';
    expect((await wrongBasis.audit()).status).toBe('mismatch');
    const wrongTimes = fixture();
    const compared = wrongTimes.timeline.findings![0]!.latestEvaluation.explanation as RuleEvaluationExplanation;
    compared.details = { ...compared.details, values: physicalLanding };
    expect((await wrongTimes.audit()).status).toBe('mismatch');
  });

  it('bounds GET requests, downloaded bytes and stalled requests with an abort signal', async () => {
    let calls = 0;
    const fetcher: typeof fetch = async (_url, init) => {
      expect(init?.method ?? 'GET').toBe('GET');
      calls++;
      return new Response(Uint8Array.from(calls % 2 === 1 ? [1, 2] : [3, 4, 5]));
    };
    const capped = new OracleApi(context.apiUrl, 'test-read-only-token', { requests: 2, bytes: 5 }, fetcher);
    expect(await capped.bytes('/v1/first')).toEqual(Uint8Array.from([1, 2]));
    expect(await capped.bytes('/v1/second')).toEqual(Uint8Array.from([3, 4, 5]));
    await expect(capped.bytes('/v1/third')).rejects.toThrow();
    expect(capped.usage()).toEqual({ requests: 2, bytes: 5 });
    expect(calls).toBe(2);

    const byteCapped = new OracleApi(context.apiUrl, 'test-read-only-token', { requests: 3, bytes: 4 }, fetcher);
    await byteCapped.bytes('/v1/first');
    await expect(byteCapped.bytes('/v1/too-large')).rejects.toThrow();

    let requestSignal: AbortSignal | undefined;
    const stalled: typeof fetch = async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        requestSignal = init?.signal ?? undefined;
        requestSignal!.addEventListener('abort', () => reject(requestSignal!.reason), { once: true });
      });
    const timed = new OracleApi(
      context.apiUrl,
      'test-read-only-token',
      { requests: 1, bytes: 100, requestTimeoutMs: 10, timeoutMs: 1000 },
      stalled,
    );
    await expect(timed.bytes('/v1/stalled')).rejects.toThrow();
    expect(requestSignal?.aborted).toBe(true);
  });
});
