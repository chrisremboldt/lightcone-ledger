import { createHash } from 'node:crypto';
import type {
  ArtifactResponse,
  FlightInput,
  Principal,
  Receipt,
  ReceiptResponse,
  TimelineResponse,
} from '@ledger/contracts';
import type { WorldFact } from '@ledger/simulation-models/operation';
import { OracleReadError } from './oracle-api.js';

export type OracleStatus = 'match' | 'mismatch' | 'pending' | 'unverifiable';
export interface OracleIssue {
  status: Exclude<OracleStatus, 'match'>;
  code: string;
  reason: string;
  receiptId?: string;
  artifactId?: string;
}
export interface ReportedLanding {
  receiptId: string;
  eventId: string;
  sourceId: string;
  occurredAt: string;
  landingTime: string;
}
export interface OracleResult {
  status: OracleStatus;
  attemptId: string;
  tenant: 'alpha' | 'beta';
  journalSha256: string;
  flightId?: string;
  physicalLanding?: string;
  reportedLandings: ReportedLanding[];
  counts: { confirmedFacts: number; unconfirmedFacts: number; receipts: number; artifacts: number };
  issues: OracleIssue[];
  usage: { requests: number; bytes: number };
}
export interface OracleReader {
  json<T>(path: string): Promise<T>;
  bytes(path: string): Promise<Uint8Array>;
  usage(): { requests: number; bytes: number };
}
interface Context {
  attemptId: string;
  tenant: 'alpha' | 'beta';
  apiUrl: string;
}
interface Commitment {
  principalId: string;
  input: FlightInput;
  wireDigests: string[];
  receiptId?: string;
}
interface RetainedFact {
  fact: WorldFact;
  bytes: Buffer;
  payload: Record<string, unknown>;
  commitment?: Commitment;
}
interface AttemptJournal {
  flightId?: string;
  facts: RetainedFact[];
  commitments: Commitment[];
}

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const wireHash = (topic: string, bytes: Uint8Array) =>
  hash(Buffer.concat([Buffer.from(topic), Buffer.from([0]), bytes]));
const same = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right))
    return left.length === right.length && left.every((value, index) => same(value, right[index]));
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const a = left as Record<string, unknown>;
    const b = right as Record<string, unknown>;
    return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((key) => same(a[key], b[key]));
  }
  return false;
};

class UnsupportedEvidence extends Error {}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new UnsupportedEvidence('Expected an evidence object');
  return value as Record<string, unknown>;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200)
    throw new UnsupportedEvidence('Evidence identity is missing or unsupported');
  return value;
}
function utc(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value))
    throw new UnsupportedEvidence('Evidence requires an explicit UTC occurrence time');
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== value.slice(0, 19))
    throw new UnsupportedEvidence('Evidence has an invalid UTC time');
  return new Date(time).toISOString();
}
function decode(value: unknown): Buffer {
  if (typeof value !== 'string' || !value || Buffer.from(value, 'base64').toString('base64') !== value)
    throw new UnsupportedEvidence('Original bytes are not canonical base64');
  return Buffer.from(value, 'base64');
}
function json(bytes: Uint8Array): Record<string, unknown> {
  return object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
}

function readJournal(raw: Uint8Array, context: Context): AttemptJournal {
  if (raw.byteLength > 8 * 1024 * 1024) throw new UnsupportedEvidence('Selected journal exceeds the 8 MiB bound');
  const journal = json(raw);
  if (journal.version !== 2) throw new UnsupportedEvidence('Only version 2 attempt journals are supported');
  if (
    journal.binding !==
    hash(JSON.stringify({ apiUrl: context.apiUrl, tenant: context.tenant, attemptId: context.attemptId }))
  )
    throw new UnsupportedEvidence('Journal does not match the selected API, tenant and attempt');
  const principals = object(journal.principals);
  if (!Array.isArray(journal.commitments) || journal.commitments.length > 256)
    throw new UnsupportedEvidence('Journal commitment count is unsupported');
  const commitments = journal.commitments.map((value): Commitment => {
    const entry = object(value);
    const input = object(entry.input);
    if (!['order.revision', 'flight.observation', 'telemetry.segment'].includes(String(input.kind)))
      throw new UnsupportedEvidence('Journal contains an unsupported input kind');
    identifier(input.sourceId);
    identifier(input.sourceSessionId);
    utc(input.occurredAt);
    identifier(input.artifactId);
    if (input.fidelity !== 'synthetic_contract')
      throw new UnsupportedEvidence('Input fidelity is outside this simulator profile');
    object(input.payload);
    const subject = object(input.subject);
    if (subject.flightId !== undefined && subject.flightId !== journal.flightId)
      throw new UnsupportedEvidence('Input references another flight');
    if (subject.originationKey !== undefined && subject.originationKey !== context.attemptId)
      throw new UnsupportedEvidence('Input references another attempt');
    if (input.kind !== 'order.revision' && !subject.flightId && !subject.originationKey)
      throw new UnsupportedEvidence('Input has no explicit flight identity');
    const principalId = identifier(entry.principalId);
    const role = input.kind === 'flight.observation' ? 'actor' : 'source';
    if (principalId !== principals[role])
      throw new UnsupportedEvidence('Input principal differs from the journal binding');
    if (
      !Array.isArray(entry.wireDigests) ||
      entry.wireDigests.some((value) => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    )
      throw new UnsupportedEvidence('Input wire commitments are malformed');
    return {
      principalId,
      input: input as unknown as FlightInput,
      wireDigests: entry.wireDigests,
      ...(entry.receiptId ? { receiptId: identifier(entry.receiptId) } : {}),
    };
  });
  const entries = Object.entries(object(journal.facts));
  if (entries.length > 2048) throw new UnsupportedEvidence('Selected attempt exceeds the 2048 fact bound');
  const facts = entries.map(([sequence, value]): RetainedFact => {
    const entry = object(value);
    const fact = object(entry.fact);
    if (
      fact.attemptId !== context.attemptId ||
      fact.tenant !== context.tenant ||
      String(fact.sequence) !== sequence ||
      !Number.isSafeInteger(fact.sequence)
    )
      throw new UnsupportedEvidence('Fact identity differs from the selected attempt');
    if (!['order', 'position', 'departure', 'landing', 'landing-report', 'cancellation'].includes(String(fact.kind)))
      throw new UnsupportedEvidence('Journal contains an unsupported world fact');
    utc(fact.at);
    identifier(fact.sourceSessionId);
    const bytes = decode(entry.bytesBase64);
    const payload = json(bytes);
    if (fact.kind === 'order') {
      if (!same(payload, fact.order)) throw new UnsupportedEvidence('Retained order differs from its original bytes');
    } else {
      const aircraftId = identifier(fact.aircraftId);
      if (journal.aircraftId !== undefined && aircraftId !== journal.aircraftId)
        throw new UnsupportedEvidence('Fact aircraft differs from the attempt binding');
      if (fact.kind === 'position') {
        const point = object(fact.point);
        const data = object(payload.data);
        if (
          payload.tid !== `${fact.sourceSessionId}:${sequence}` ||
          payload.bid !== `${fact.sourceSessionId}:osd:${sequence}` ||
          payload.gateway !== `GW-${aircraftId}` ||
          payload.timestamp !== Date.parse(utc(fact.at)) ||
          data.latitude !== point.latitude ||
          data.longitude !== point.longitude ||
          data.height !== point.height ||
          data.horizontal_speed !== point.horizontalSpeed
        )
          throw new UnsupportedEvidence('Retained vendor frame identity or coordinates differ from the world fact');
      } else if (
        payload.aircraft !== aircraftId ||
        payload.personId !== fact.personId ||
        payload.personName !== fact.personName ||
        payload.activity !==
          (fact.kind === 'departure' ? 'active' : fact.kind === 'cancellation' ? 'cancelled' : 'landed')
      )
        throw new UnsupportedEvidence('Retained source report differs from its world identity');
      if (fact.kind === 'landing' && utc(payload.landingTime) !== utc(fact.at))
        throw new UnsupportedEvidence('Original physical landing report differs from its retained fact');
      if (
        fact.kind === 'cancellation' &&
        (fact.reason !== 'requested_window_unreachable' ||
          payload.reason !== fact.reason ||
          payload.note !== fact.note ||
          payload.personRole !== 'dispatcher')
      )
        throw new UnsupportedEvidence('Original dispatcher cancellation differs from its retained fact');
      if (
        fact.kind === 'landing-report' &&
        (utc(payload.landingTime) !== utc(fact.reportedLandingAt) ||
          utc(payload.reportRecordedAt) !== utc(fact.reportAt) ||
          payload.incidentId !== fact.incidentId)
      )
        throw new UnsupportedEvidence('Original delayed landing report differs from its retained report');
    }
    const candidates = commitments.filter((commitment) => {
      const input = commitment.input;
      if (!commitment.receiptId || input.sourceSessionId !== fact.sourceSessionId) return false;
      const sourceId =
        fact.kind === 'order'
          ? 'partner-orders'
          : fact.kind === 'position'
            ? 'dji-osd'
            : fact.kind === 'landing-report'
              ? fact.sourceId
              : `simulation-person-${context.tenant}`;
      if (input.sourceId !== sourceId) return false;
      if (fact.kind === 'position')
        return (
          input.kind === 'telemetry.segment' &&
          commitment.wireDigests.includes(wireHash(`thing/product/${fact.aircraftId}/osd`, bytes))
        );
      if (utc(input.occurredAt) !== utc(fact.at)) return false;
      return fact.kind === 'order'
        ? input.kind === 'order.revision' && input.sourceRevision === object(fact.order).version
        : input.kind === 'flight.observation' && same(input.payload, payload);
    });
    if (
      candidates.length > 1 ||
      (entry.receiptId && !candidates.some((candidate) => candidate.receiptId === entry.receiptId))
    )
      throw new UnsupportedEvidence('Fact has no unique matching confirmed input commitment');
    return { fact: fact as unknown as WorldFact, bytes, payload, commitment: candidates[0] };
  });
  const confirmedIds = new Set(
    commitments.flatMap((commitment) => (commitment.receiptId ? [commitment.receiptId] : [])),
  );
  if (confirmedIds.size > 64) throw new UnsupportedEvidence('Selected attempt exceeds the 64 receipt bound');
  if (commitments.some((commitment) => commitment.receiptId && !facts.some((fact) => fact.commitment === commitment)))
    throw new UnsupportedEvidence('A confirmed input has no matching retained source fact');
  return { facts, commitments, ...(journal.flightId ? { flightId: identifier(journal.flightId) } : {}) };
}

function checkSegment(bytes: Uint8Array, commitment: Commitment, facts: RetainedFact[]): boolean {
  const segment = json(bytes);
  const descriptor = commitment.input.payload;
  if (segment.format !== 'ledger.telemetry-segment.1' || segment.decoderVersion !== 'dji-osd.synthetic.1')
    throw new UnsupportedEvidence('Telemetry artifact uses an unsupported format or decoder version');
  if (descriptor.format !== 'ledger.telemetry-segment.1' || descriptor.decoderVersion !== 'dji-osd.synthetic.1')
    throw new UnsupportedEvidence('Telemetry input uses an unsupported format or decoder version');
  if (!Array.isArray(segment.samples) || segment.samples.length > 120 || !segment.samples.length)
    throw new UnsupportedEvidence('Telemetry artifact has an unsupported sample count');
  const originals = segment.samples.map((value) => {
    const sample = object(value);
    const original = object(sample.original);
    return wireHash(identifier(original.topic), decode(original.bytesBase64));
  });
  const expected = facts.map((entry) => wireHash(`thing/product/${entry.fact.aircraftId}/osd`, entry.bytes));
  const samples = segment.samples.map(object);
  const normalized = samples.every((sample, index) => {
    const retained = facts.find(
      (entry) => wireHash(`thing/product/${entry.fact.aircraftId}/osd`, entry.bytes) === originals[index],
    );
    if (!retained) return false;
    const data = object(retained.payload.data);
    return (
      utc(sample.occurredAt) === utc(retained.fact.at) &&
      sample.latitude === data.latitude &&
      sample.longitude === data.longitude &&
      sample.altitudeMeters === (data.height ?? null) &&
      sample.altitudeReference === (data.height === undefined ? 'unknown' : 'ellipsoid') &&
      sample.speedMetersPerSecond === data.horizontal_speed &&
      Number.isSafeInteger(sample.sequence) &&
      Number(sample.sequence) >= Number(segment.sessionStartSequence) &&
      (index === 0 || Number(sample.sequence) > Number(samples[index - 1]!.sequence))
    );
  });
  const first = samples[0]!;
  const last = samples.at(-1)!;
  return (
    segment.sourceId === commitment.input.sourceId &&
    segment.sourceSessionId === commitment.input.sourceSessionId &&
    facts.every((entry) => entry.fact.aircraftId === segment.deviceId) &&
    segment.gatewayId === `GW-${segment.deviceId}` &&
    segment.coordinateReference === 'WGS84' &&
    segment.fidelity === 'synthetic_contract' &&
    segment.sequenceBasis === 'adapter_capture' &&
    descriptor.deviceId === segment.deviceId &&
    descriptor.gatewayId === segment.gatewayId &&
    descriptor.sequenceBasis === segment.sequenceBasis &&
    Number.isSafeInteger(segment.sessionStartSequence) &&
    Number(segment.sessionStartSequence) >= 0 &&
    descriptor.sessionStartSequence === segment.sessionStartSequence &&
    descriptor.firstSequence === first.sequence &&
    descriptor.lastSequence === last.sequence &&
    utc(descriptor.firstOccurredAt) === utc(first.occurredAt) &&
    utc(descriptor.lastOccurredAt) === utc(last.occurredAt) &&
    normalized &&
    descriptor.sampleCount === segment.samples.length &&
    originals.length === commitment.wireDigests.length &&
    same([...originals].sort(), [...commitment.wireDigests].sort()) &&
    expected.every((value) => originals.includes(value)) &&
    originals.every((value) => expected.includes(value))
  );
}

function compareFinding(
  timeline: TimelineResponse,
  landings: ReportedLanding[],
  observations: Receipt[],
  add: (issue: OracleIssue) => void,
): void {
  const findings = timeline.findings;
  if (!Array.isArray(findings)) throw new UnsupportedEvidence('Timeline does not include recorded findings');
  const matching = findings.filter((finding) => finding.latestEvaluation.leafId === 'ledger.demo.landing-disagreement');
  if (matching.length !== 1) {
    add({
      status: 'mismatch',
      code: 'disagreement_missing',
      reason: 'The completed clean two-report flight must have one recorded disagreement finding',
    });
    return;
  }
  const finding = matching[0]!;
  const evaluation = finding.latestEvaluation;
  const explanation = evaluation.explanation;
  // The landing rules run on the generic evaluator from demo procedures version 4.
  if (
    evaluation.leafVersion !== 2 ||
    evaluation.bindingId !== 'ledger.demo-procedures' ||
    evaluation.bindingVersion !== 4 ||
    !('kind' in explanation) ||
    explanation.kind !== 'rule'
  )
    throw new UnsupportedEvidence('Finding uses an unsupported rule or pack version');
  const expected = [...new Set(landings.map((landing) => utc(landing.landingTime)))].sort().join(', ');
  const actual = explanation.details.values;
  const evidence = explanation.evidence.map(({ eventId, receiptId, sourceId, occurredAt }) => ({
    eventId,
    receiptId,
    sourceId,
    occurredAt,
  }));
  const ordered = (values: unknown[]) =>
    [...values].sort((a, b) => identifier(object(a).receiptId).localeCompare(identifier(object(b).receiptId)));
  const expectedRefs = observations.map(({ eventId, id: receiptId, sourceId, occurredAt }) => ({
    eventId,
    receiptId,
    sourceId,
    occurredAt,
  }));
  if (
    finding.flightId !== timeline.flight.id ||
    evaluation.flightId !== timeline.flight.id ||
    evaluation.evidenceState !== 'conflicting' ||
    evaluation.outcome !== 'attention' ||
    evaluation.applicability !== 'applicable' ||
    explanation.code !== 'values_disagree' ||
    actual !== expected ||
    !same(ordered(evidence), ordered(expectedRefs))
  )
    add({
      status: 'mismatch',
      code: 'finding_disagrees',
      reason: 'Recorded disagreement outcome or scoped evidence differs from the two delivered reports',
    });
}

export async function auditAttemptJournal(raw: Uint8Array, context: Context, api: OracleReader): Promise<OracleResult> {
  const result: OracleResult = {
    status: 'unverifiable',
    attemptId: context.attemptId,
    tenant: context.tenant,
    journalSha256: hash(raw),
    reportedLandings: [],
    counts: { confirmedFacts: 0, unconfirmedFacts: 0, receipts: 0, artifacts: 0 },
    issues: [],
    usage: api.usage(),
  };
  const priority: Record<OracleStatus, number> = { match: 0, pending: 1, unverifiable: 2, mismatch: 3 };
  let strongest: OracleStatus = 'match';
  const add = (issue: OracleIssue) => {
    if (priority[issue.status] > priority[strongest]) strongest = issue.status;
    if (result.issues.length < 16) result.issues.push(issue);
    else {
      const weaker = result.issues.findIndex((previous) => priority[previous.status] < priority[issue.status]);
      if (weaker >= 0) result.issues[weaker] = issue;
    }
  };
  let reading: { receiptId?: string; artifactId?: string } = {};
  try {
    const journal = readJournal(raw, context);
    result.flightId = journal.flightId;
    const landings = journal.facts.filter((entry) => entry.fact.kind === 'landing');
    if (landings.length === 1) result.physicalLanding = landings[0]!.fact.at;
    result.counts.confirmedFacts = journal.facts.filter((entry) => entry.commitment).length;
    result.counts.unconfirmedFacts = journal.facts.length - result.counts.confirmedFacts;
    if (result.counts.unconfirmedFacts)
      add({
        status: 'unverifiable',
        code: 'unconfirmed_acceptance',
        reason: 'Some prepared facts have no confirmed receipt; their acceptance is unknown',
      });
    const { principal } = await api.json<{ principal: Principal }>('/v1/me');
    if (principal.tenantId !== `tenant-${context.tenant}`)
      throw new UnsupportedEvidence('Authenticated reader belongs to another tenant');
    if (!principal.capabilities.includes('flight:read') || !principal.capabilities.includes('evidence:read'))
      throw new UnsupportedEvidence('Oracle requires flight:read and evidence:read');
    if (!journal.flightId) {
      add({
        status: 'pending',
        code: 'flight_unconfirmed',
        reason: 'Delivery journal has not resolved its originating flight',
      });
    } else {
      const receipts = new Map<string, Receipt>();
      const confirmed = journal.commitments.filter((entry) => entry.receiptId);
      for (const commitment of confirmed) {
        const receiptId = commitment.receiptId!;
        reading = { receiptId };
        if (receipts.has(receiptId)) throw new UnsupportedEvidence('Multiple commitments share a receipt identity');
        const { receipt } = await api.json<ReceiptResponse>(`/v1/receipts/${encodeURIComponent(receiptId)}`);
        receipts.set(receiptId, receipt);
        result.counts.receipts++;
        const input = commitment.input;
        identifier(receipt.eventId);
        utc(receipt.receivedAt);
        if (
          receipt.status !== 'accepted' ||
          !['pending', 'processing', 'completed', 'failed'].includes(receipt.processing.status)
        )
          throw new UnsupportedEvidence('Receipt has an unsupported acceptance or processing state');
        if (
          receipt.id !== receiptId ||
          receipt.sourceId !== input.sourceId ||
          receipt.kind !== input.kind ||
          utc(receipt.occurredAt) !== utc(input.occurredAt) ||
          receipt.artifactId !== input.artifactId ||
          !same(receipt.payload, input.payload)
        )
          add({
            status: 'mismatch',
            code: 'receipt_identity',
            reason: 'Confirmed receipt differs from its retained submitted input',
            receiptId,
          });
        if (receipt.processing.status === 'failed')
          add({
            status: 'mismatch',
            code: 'processing_failed',
            reason: 'Confirmed receipt failed processing',
            receiptId,
          });
        else if (receipt.processing.status !== 'completed')
          add({
            status: 'pending',
            code: 'projection_pending',
            reason: 'Accepted receipt has not completed projection',
            receiptId,
          });
        else if (
          input.kind !== 'order.revision' &&
          (receipt.flightId !== journal.flightId || receipt.linkStatus !== 'linked')
        )
          add({
            status: 'mismatch',
            code: 'flight_link',
            reason: 'Completed source evidence is not linked to the selected flight',
            receiptId,
          });
        else if (receipt.flightId && receipt.flightId !== journal.flightId)
          add({ status: 'mismatch', code: 'flight_link', reason: 'Receipt references another flight', receiptId });
        const artifactId = input.artifactId!;
        reading = { receiptId, artifactId };
        const { artifact } = await api.json<ArtifactResponse>(`/v1/artifacts/${encodeURIComponent(artifactId)}`);
        const bytes = await api.bytes(`/v1/artifacts/${encodeURIComponent(artifactId)}/content`);
        result.counts.artifacts++;
        const facts = journal.facts.filter((entry) => entry.commitment === commitment);
        const identical =
          input.kind === 'telemetry.segment'
            ? checkSegment(bytes, commitment, facts)
            : facts.every((entry) => entry.bytes.equals(bytes));
        if (
          artifact.id !== artifactId ||
          artifact.contentType !== 'application/json' ||
          artifact.byteLength !== bytes.byteLength ||
          artifact.sha256 !== hash(bytes) ||
          !identical
        )
          add({
            status: 'mismatch',
            code: 'artifact_bytes',
            reason: 'Artifact integrity or original source bytes differ from the delivery journal',
            receiptId,
            artifactId,
          });
        for (const entry of facts) {
          if (entry.fact.kind === 'landing' || entry.fact.kind === 'landing-report') {
            result.reportedLandings.push({
              receiptId,
              eventId: receipt.eventId,
              sourceId: receipt.sourceId,
              occurredAt: receipt.occurredAt,
              landingTime: String(entry.payload.landingTime),
            });
          }
        }
      }
      reading = {};
      const timeline = await api.json<TimelineResponse>(
        `/v1/flights/${encodeURIComponent(journal.flightId)}/timeline?limit=500&decisionLimit=1`,
      );
      if (timeline.flight.id !== journal.flightId || timeline.flight.originationKey !== context.attemptId)
        add({ status: 'mismatch', code: 'flight_identity', reason: 'Public flight differs from the selected attempt' });
      const aircraftId = journal.facts.find((entry) => entry.fact.kind !== 'order')?.fact.aircraftId;
      if (aircraftId && timeline.flight.aircraft !== aircraftId)
        add({
          status: 'mismatch',
          code: 'flight_aircraft',
          reason: 'Public flight aircraft differs from the retained attempt',
        });
      if (timeline.window.items.hasMore || timeline.items.length > 500)
        throw new UnsupportedEvidence('Flight timeline exceeds the complete 500-item comparison boundary');
      if (timeline.window.items.consistency !== 'live_projection')
        throw new UnsupportedEvidence('Flight timeline has an unsupported consistency model');
      if (!Number.isSafeInteger(timeline.flight.outstandingWork) || timeline.flight.outstandingWork < 0)
        throw new UnsupportedEvidence('Flight snapshot has no supported subject work count');
      if (timeline.flight.outstandingWork > 0)
        add({
          status: 'pending',
          code: 'subject_work_pending',
          reason: 'The selected flight still has accepted work awaiting projection or evaluation',
        });
      const extras = timeline.items.filter(
        (item) =>
          item.correctionOf ||
          /correct/i.test(item.kind) ||
          ['identity.link', 'flight.assign'].includes(item.kind) ||
          (item.receiptId && !receipts.has(item.receiptId)) ||
          (['observed', 'evidence'].includes(item.lane) &&
            ![
              'flight.observation',
              'order.revision',
              'telemetry.segment',
              'airspace.status',
              'source.observation',
              'intent.revision',
            ].includes(item.kind)) ||
          ([
            'flight.observation',
            'order.revision',
            'telemetry.segment',
            'airspace.status',
            'source.observation',
            'intent.revision',
          ].includes(item.kind) &&
            (!item.receiptId || !receipts.has(item.receiptId))),
      );
      if (extras.length)
        throw new UnsupportedEvidence('Flight contains corrections or additional unmodelled source evidence');
      const completed = [...receipts.values()].every((receipt) => receipt.processing.status === 'completed');
      let evidencePresent = true;
      let missingEvidence = false;
      for (const receipt of receipts.values()) {
        if (receipt.kind === 'order.revision') continue;
        const items = timeline.items.filter((item) => item.receiptId === receipt.id);
        if (!items.length) {
          evidencePresent = false;
          missingEvidence = true;
          continue;
        }
        const item = items[0]!;
        const commitment = confirmed.find((entry) => entry.receiptId === receipt.id)!;
        if (
          items.length !== 1 ||
          item.id !== receipt.eventId ||
          item.sourceId !== receipt.sourceId ||
          item.kind !== receipt.kind ||
          item.actorId !== commitment.principalId ||
          item.artifactId !== receipt.artifactId ||
          item.linkStatus !== receipt.linkStatus ||
          utc(item.occurredAt) !== utc(receipt.occurredAt) ||
          utc(item.receivedAt) !== utc(receipt.receivedAt) ||
          !same(item.payload, receipt.payload)
        ) {
          evidencePresent = false;
          add({
            status: 'mismatch',
            code: 'timeline_evidence',
            reason: 'Public timeline evidence differs from its confirmed receipt or retained principal',
            receiptId: receipt.id,
            artifactId: receipt.artifactId,
          });
        }
      }
      if (missingEvidence)
        add({
          status: 'pending',
          code: 'timeline_pending',
          reason: 'Selected source evidence is not yet visible together in the public flight snapshot',
        });
      if (
        result.reportedLandings.length !== 2 ||
        landings.length !== 1 ||
        new Set(result.reportedLandings.map((landing) => utc(landing.landingTime))).size !== 2
      )
        throw new UnsupportedEvidence(
          'This oracle requires one physical landing and two distinct delivered landing-time reports',
        );
      if (completed && evidencePresent && timeline.flight.outstandingWork === 0) {
        if (timeline.flight.activity !== 'landed')
          add({
            status: 'mismatch',
            code: 'flight_activity',
            reason: 'Completed landing reports did not produce landed flight activity',
          });
        compareFinding(
          timeline,
          result.reportedLandings,
          [...receipts.values()].filter((receipt) => receipt.kind === 'flight.observation'),
          add,
        );
      }
    }
  } catch (error) {
    if (error instanceof OracleReadError)
      add({ status: error.status, code: error.code, reason: error.message, ...reading });
    else
      add({
        status: 'unverifiable',
        code: 'unsupported_evidence',
        reason: error instanceof UnsupportedEvidence ? error.message : 'Evidence response is malformed or unsupported',
        ...reading,
      });
  }
  result.status = strongest;
  result.usage = api.usage();
  return result;
}
