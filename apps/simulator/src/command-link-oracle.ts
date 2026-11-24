import { createHash } from 'node:crypto';
import type { ArtifactResponse, Principal, Receipt, ReceiptResponse, TimelineResponse } from '@ledger/contracts';
import { commandLinkStatusAdapter, completeObservations } from '@ledger/adapters';
import { canonicalize } from '@ledger/integrity';
import type { OracleIssue, OracleReader, OracleStatus } from './attempt-oracle.js';
import { OracleReadError } from './oracle-api.js';
import { C2EvidenceError, readCommandLinkJournal, type C2RetainedFact } from './command-link-oracle-journal.js';
import { compareCommandLinkFinding } from './command-link-oracle-finding.js';

export interface CommandLinkOracleContext {
  attemptId: string;
  tenant: 'alpha' | 'beta';
  apiUrl: string;
}
export interface CommandLinkOracleReport {
  receiptId: string;
  eventId: string;
  sourceId: string;
  sourceSessionId: string;
  sourceEventId: string;
  incidentId: string;
  aircraftId: string;
  occurredAt: string;
  status: 'lost' | 'restored';
  actorId?: string;
}
export interface CommandLinkOracleResult {
  kind: 'command-link';
  status: OracleStatus;
  attemptId: string;
  tenant: 'alpha' | 'beta';
  journalSha256: string;
  flightId?: string;
  reports: CommandLinkOracleReport[];
  finding?: {
    findingId: string;
    evaluationId: string;
    evidenceState: string;
    outcome: string;
    treatmentStatus: string;
    treatmentOwner: { id: string; name: string } | null;
  };
  counts: { confirmedFacts: number; unconfirmedFacts: number; receipts: number; artifacts: number };
  issues: OracleIssue[];
  usage: { requests: number; bytes: number };
}
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const same = (left: unknown, right: unknown) => canonicalize(left) === canonicalize(right);
function id(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200)
    throw new C2EvidenceError('Public evidence identity is missing or unsupported');
  return value;
}
function utc(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,3})?Z$/.test(value))
    throw new C2EvidenceError('Public evidence requires an explicit UTC time');
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== value.slice(0, 19))
    throw new C2EvidenceError('Public evidence has an invalid UTC time');
  return new Date(time).toISOString();
}
/** The link.status observation the command-link adapter makes of the retained bytes, citing the artifact. */
function expectedObservation(entry: C2RetainedFact, flightId: string, artifactId: string): unknown {
  const translated = commandLinkStatusAdapter.translate(
    { bytes: entry.bytes, contentType: 'application/json', transport: {}, capturedAt: entry.source.occurredAt },
    {
      subjects: { scope: 'ledger', ids: { flight: { [entry.source.sourceSessionId]: flightId } } },
      binding: { sourceSessionId: entry.source.sourceSessionId, aircraftId: entry.source.aircraftId },
    },
  );
  if (translated.rejections.length || translated.drafts.length !== 1)
    throw new C2EvidenceError('Retained command-link bytes do not translate to one link.status observation');
  return completeObservations(commandLinkStatusAdapter.descriptor, translated.drafts, artifactId)[0];
}

const isLinkStatus = (payload: unknown) =>
  typeof payload === 'object' && payload !== null && (payload as { type?: unknown }).type === 'link.status';

function completeTimeline(timeline: TimelineResponse): void {
  const page = timeline.window?.items;
  if (
    !Array.isArray(timeline.items) ||
    timeline.items.length > 500 ||
    page?.hasMore !== false ||
    page.consistency !== 'live_projection' ||
    page.selection !== 'initial' ||
    page.order !== 'received_ascending' ||
    page.nextCursor !== null ||
    !Number.isSafeInteger(page.limit) ||
    page.limit < 1 ||
    page.limit > 500 ||
    !Number.isSafeInteger(page.returned) ||
    page.returned < 0 ||
    page.returned > page.limit ||
    page.returned !== timeline.items.length
  )
    throw new C2EvidenceError('Flight timeline is outside the complete 500-item comparison boundary');
  if (!Number.isSafeInteger(timeline.flight.outstandingWork) || timeline.flight.outstandingWork < 0)
    throw new C2EvidenceError('Flight snapshot has no supported subject work count');
}
function requireKnownEvidence(timeline: TimelineResponse, receipts: Map<string, Receipt>): void {
  const ordinary = [
    'order.revision',
    'intent.revision',
    'flight.observation',
    'telemetry.segment',
    'airspace.status',
    'source.observation',
  ];
  for (const item of timeline.items) {
    if (item.correctionOf || /correct/i.test(item.kind) || ['identity.link', 'flight.assign'].includes(item.kind))
      throw new C2EvidenceError('Flight contains corrections or identity changes outside this comparison');
    const linkReport = item.kind === 'observation' && isLinkStatus(item.payload);
    if (linkReport && (!item.receiptId || !receipts.has(item.receiptId)))
      throw new C2EvidenceError('Flight contains additional command-link evidence outside this journal');
    if (['observed', 'evidence'].includes(item.lane) && !linkReport && !ordinary.includes(item.kind))
      throw new C2EvidenceError('Flight contains an unsupported source kind');
  }
}

export async function auditCommandLinkJournal(
  raw: Uint8Array,
  context: CommandLinkOracleContext,
  api: OracleReader,
): Promise<CommandLinkOracleResult> {
  const result: CommandLinkOracleResult = {
    kind: 'command-link',
    status: 'unverifiable',
    attemptId: context.attemptId,
    tenant: context.tenant,
    journalSha256: hash(raw),
    reports: [],
    counts: { confirmedFacts: 0, unconfirmedFacts: 0, receipts: 0, artifacts: 0 },
    issues: [],
    usage: api.usage(),
  };
  const priorities: Record<OracleStatus, number> = { match: 0, pending: 1, unverifiable: 2, mismatch: 3 };
  let strongest: OracleStatus = 'match';
  const add = (issue: OracleIssue) => {
    if (priorities[issue.status] > priorities[strongest]) strongest = issue.status;
    if (result.issues.length < 16) result.issues.push(issue);
    else {
      const weaker = result.issues.findIndex((entry) => priorities[entry.status] < priorities[issue.status]);
      if (weaker >= 0) result.issues[weaker] = issue;
    }
  };
  let reading: { receiptId?: string; artifactId?: string } = {};
  try {
    const journal = readCommandLinkJournal(raw, context);
    result.flightId = journal.flightId;
    const confirmed = journal.facts.filter((entry) => entry.accepted);
    result.counts.confirmedFacts = confirmed.length;
    result.counts.unconfirmedFacts = journal.facts.length - confirmed.length;
    for (const entry of journal.facts.filter((fact) => !fact.accepted))
      add({
        status: 'pending',
        code: 'delivery_pending',
        reason: 'A retained source report has not completed delivery; delivering it again is idempotent',
      });
    const { principal } = await api.json<{ principal: Principal }>('/v1/me');
    if (
      principal?.tenantId !== `tenant-${context.tenant}` ||
      !Array.isArray(principal.capabilities) ||
      !principal.capabilities.includes('flight:read') ||
      !principal.capabilities.includes('evidence:read')
    )
      throw new C2EvidenceError('Oracle requires an authenticated tenant reader with flight:read and evidence:read');
    if (!journal.flightId)
      add({
        status: 'pending',
        code: 'flight_unconfirmed',
        reason: 'The retained report has not resolved its originating flight',
      });
    else if (confirmed.length) {
      const receipts = new Map<string, Receipt>();
      const entries = new Map<string, C2RetainedFact>();
      const artifacts = new Map<string, { artifact: ArtifactResponse['artifact']; bytes: Uint8Array }>();
      const checkArtifact = async (artifactId: string, entry: C2RetainedFact, receiptId: string) => {
        reading = { receiptId, artifactId };
        let retained = artifacts.get(artifactId);
        if (!retained) {
          const { artifact } = await api.json<ArtifactResponse>(`/v1/artifacts/${encodeURIComponent(artifactId)}`);
          const bytes = await api.bytes(`/v1/artifacts/${encodeURIComponent(artifactId)}/content`);
          retained = { artifact, bytes };
          artifacts.set(artifactId, retained);
          result.counts.artifacts++;
        }
        const { artifact, bytes } = retained;
        if (
          artifact.id !== artifactId ||
          artifact.contentType !== 'application/json' ||
          artifact.byteLength !== bytes.byteLength ||
          artifact.sha256 !== hash(bytes) ||
          !entry.bytes.equals(bytes)
        )
          add({
            status: 'mismatch',
            code: 'artifact_bytes',
            reason: 'Artifact metadata or exact original bytes differ from the retained source',
            receiptId,
            artifactId,
          });
      };
      for (const entry of confirmed) {
        const accepted = entry.accepted!;
        const receiptId = id(accepted.receiptId);
        reading = { receiptId };
        const { receipt } = await api.json<ReceiptResponse>(`/v1/receipts/${encodeURIComponent(receiptId)}`);
        id(receipt.eventId);
        id(receipt.artifactId);
        utc(receipt.receivedAt);
        if (
          receipt.status !== 'accepted' ||
          !['pending', 'processing', 'completed', 'failed'].includes(receipt.processing.status)
        )
          throw new C2EvidenceError('Receipt has an unsupported acceptance or processing state');
        if (
          receipt.id !== receiptId ||
          receipt.kind !== 'observation' ||
          receipt.sourceId !== entry.sourceId ||
          receipt.flightId !== journal.flightId ||
          receipt.linkStatus !== 'linked' ||
          receipt.artifactId !== accepted.artifactId ||
          utc(receipt.occurredAt) !== utc(entry.source.occurredAt) ||
          !same(receipt.payload, expectedObservation(entry, journal.flightId, accepted.artifactId))
        )
          add({
            status: 'mismatch',
            code: 'receipt_identity',
            reason: 'Public receipt differs from the observation the adapter makes of the retained report',
            receiptId,
          });
        if (receipt.processing.status === 'failed')
          add({
            status: 'mismatch',
            code: 'processing_failed',
            reason: 'Confirmed command-link receipt failed processing',
            receiptId,
          });
        else if (receipt.processing.status !== 'completed')
          add({
            status: 'pending',
            code: 'projection_pending',
            reason: 'Confirmed command-link receipt has not completed projection',
            receiptId,
          });
        receipts.set(receiptId, receipt);
        entries.set(receiptId, entry);
        result.counts.receipts++;
        await checkArtifact(accepted.artifactId, entry, receiptId);
      }
      reading = {};
      const timeline = await api.json<TimelineResponse>(
        `/v1/flights/${encodeURIComponent(journal.flightId)}/timeline?limit=500&decisionLimit=1`,
      );
      completeTimeline(timeline);
      requireKnownEvidence(timeline, receipts);
      if (
        timeline.flight.id !== journal.flightId ||
        timeline.flight.originationKey !== context.attemptId ||
        timeline.flight.aircraft !== confirmed[0]!.source.aircraftId
      )
        add({
          status: 'mismatch',
          code: 'flight_identity',
          reason: 'Public flight identity differs from the selected source binding',
        });
      if (timeline.flight.outstandingWork > 0)
        add({
          status: 'pending',
          code: 'subject_work_pending',
          reason: 'The selected flight still has work awaiting projection or evaluation',
        });
      let visible = true;
      for (const [receiptId, receipt] of receipts) {
        const entry = entries.get(receiptId)!;
        const report: CommandLinkOracleReport = {
          receiptId,
          eventId: receipt.eventId,
          sourceId: entry.sourceId,
          sourceSessionId: entry.source.sourceSessionId,
          sourceEventId: entry.source.sourceEventId,
          incidentId: entry.source.incidentId,
          aircraftId: entry.source.aircraftId,
          occurredAt: utc(receipt.occurredAt),
          status: entry.source.status,
        };
        result.reports.push(report);
        const items = timeline.items.filter((item) => item.receiptId === receiptId || item.id === receipt.eventId);
        if (!items.length) {
          visible = false;
          add({
            status: 'pending',
            code: 'timeline_pending',
            reason: 'Confirmed command-link evidence is not yet visible in the public flight snapshot',
            receiptId,
          });
          continue;
        }
        const item = items[0]!;
        report.actorId = id(item.actorId);
        if (
          items.length !== 1 ||
          item.id !== receipt.eventId ||
          item.receiptId !== receiptId ||
          item.kind !== 'observation' ||
          item.lane !== 'observed' ||
          item.sourceId !== receipt.sourceId ||
          item.artifactId !== receipt.artifactId ||
          item.linkStatus !== 'linked' ||
          utc(item.occurredAt) !== utc(receipt.occurredAt) ||
          utc(item.receivedAt) !== utc(receipt.receivedAt) ||
          !same(item.payload, receipt.payload)
        ) {
          visible = false;
          add({
            status: 'mismatch',
            code: 'timeline_evidence',
            reason: 'Canonical public event differs from its confirmed receipt or source scope',
            receiptId,
          });
        }
      }
      if (
        visible &&
        confirmed.length === journal.facts.length &&
        [...receipts.values()].every((receipt) => receipt.processing.status === 'completed') &&
        timeline.flight.outstandingWork === 0
      ) {
        result.finding = await compareCommandLinkFinding(
          timeline,
          result.reports,
          add,
          api,
          `tenant-${context.tenant}`,
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
        reason: error instanceof C2EvidenceError ? error.message : 'Evidence response is malformed or unsupported',
        ...reading,
      });
  }
  result.status = strongest;
  result.usage = api.usage();
  return result;
}
