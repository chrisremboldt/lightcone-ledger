import { join } from 'node:path';
import {
  MissionAdapter,
  digest,
  type LedgerClient,
  type MissionAdapterResult,
  type PreparedMissionInput,
} from '@ledger/adapters';
import type { FlightListResponse } from '@ledger/contracts';
import { canonicalize } from '@ledger/integrity';
import type { PreparedWorldFact } from './operation-delivery.js';
import type { OperationTransport } from './operation-transport.js';
import { readJournalEnvelope, readPrivateText, writeJournalEnvelope } from './private-journal.js';

interface MissionJournal {
  version: 1;
  binding: string;
  principalId?: string;
  flightId?: string;
  facts: Record<
    string,
    PreparedWorldFact & {
      submission?: PreparedMissionInput;
      accepted?: MissionAdapterResult;
    }
  >;
}
interface OriginatingJournal {
  version: 2;
  binding: string;
  aircraftId?: string;
  flightId?: string;
  facts: Record<string, PreparedWorldFact>;
}
const MAX_JOURNAL_BYTES = 2 * 1024 * 1024;
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;

function retainedReceipt(entry: MissionJournal['facts'][string], journal: MissionJournal): string {
  const { fact, submission, accepted } = entry;
  const receipt = accepted?.receipt?.receipt;
  if (
    fact.kind !== 'mission' ||
    !submission?.input ||
    !id(journal.flightId) ||
    !id(journal.principalId) ||
    submission.principalId !== journal.principalId ||
    submission.bytesBase64 !== entry.bytesBase64 ||
    accepted?.sha256 !== submission.sha256 ||
    submission.sha256 !== digest(Buffer.from(entry.bytesBase64, 'base64')) ||
    !id(submission.input.artifactId) ||
    accepted?.submittedUploadArtifactId !== submission.input.artifactId
  )
    throw new Error('Retained mission acceptance changed its source or submission');
  const { sourceRevision, occurredAt, ...payload } = fact.source;
  const input = {
    sourceId: fact.sourceId,
    kind: 'mission.revision',
    sourceRevision,
    occurredAt,
    subject: { flightId: journal.flightId },
    artifactId: submission.input.artifactId,
    fidelity: 'synthetic_contract',
    payload,
  };
  if (
    canonicalize(submission.input) !== canonicalize(input) ||
    !receipt ||
    !id(receipt.id) ||
    !id(receipt.eventId) ||
    receipt.status !== 'accepted' ||
    receipt.kind !== input.kind ||
    receipt.sourceId !== input.sourceId ||
    receipt.flightId !== journal.flightId ||
    receipt.linkStatus !== 'linked' ||
    !id(receipt.artifactId) ||
    Date.parse(receipt.occurredAt) !== Date.parse(occurredAt) ||
    canonicalize(receipt.payload) !== canonicalize(payload)
  )
    throw new Error('Retained mission acceptance does not match its submitted planned geometry');
  return receipt.id;
}

async function originatingFlight(
  prepared: PreparedWorldFact,
  config: { apiUrl: string; stateDirectory: string },
  ledger: LedgerClient,
): Promise<string> {
  const { fact } = prepared;
  const path = join(config.stateDirectory, 'delivery', `${digest(fact.attemptId)}.json`);
  const originating = JSON.parse(await readPrivateText(path, MAX_JOURNAL_BYTES)) as OriginatingJournal;
  const binding = digest(JSON.stringify({ apiUrl: config.apiUrl, tenant: fact.tenant, attemptId: fact.attemptId }));
  if (
    !originating ||
    originating.version !== 2 ||
    originating.binding !== binding ||
    originating.aircraftId !== fact.aircraftId ||
    !originating.facts ||
    Array.isArray(originating.facts)
  )
    throw new Error('Mission plan lacks its retained originating flight binding');
  if (originating.flightId !== undefined) {
    if (!id(originating.flightId)) throw new Error('Mission originating flight identity is invalid');
    return originating.flightId;
  }
  const order = Object.values(originating.facts).find((entry) => entry.fact.kind === 'order')?.fact;
  if (order?.kind !== 'order' || order.attemptId !== fact.attemptId || order.tenant !== fact.tenant)
    throw new Error('Mission plan lacks its retained originating order');
  let cursor: string | undefined;
  const seen = new Set<string>();
  const deadline = Date.now() + 5000;
  do {
    if (Date.now() >= deadline) throw new Error('Mission originating flight lookup exceeded its deadline');
    const query = new URLSearchParams({ search: order.order.order_id, limit: '200' });
    if (cursor) query.set('cursor', cursor);
    const page = await ledger.request<FlightListResponse>(`/v1/flights?${query}`);
    const flight = page.flights.find((row) => row.originationKey === fact.attemptId);
    if (flight) {
      if (!id(flight.id)) throw new Error('Mission originating flight identity is invalid');
      return flight.id;
    }
    cursor = page.nextCursor ?? undefined;
    if (cursor && seen.has(cursor)) throw new Error('Mission originating flight lookup repeated its cursor');
    if (cursor) seen.add(cursor);
  } while (cursor);
  throw new Error('Mission plan is pending its originated flight');
}

type MissionDeliveryConfig = {
  apiUrl: string;
  stateDirectory: string;
  transport: Pick<OperationTransport, 'mission'>;
};

async function deliverEntry(
  entry: MissionJournal['facts'][string],
  journal: MissionJournal,
  config: MissionDeliveryConfig,
  ledger: LedgerClient,
  save: () => Promise<void>,
): Promise<string> {
  if (entry.accepted) return retainedReceipt(entry, journal);
  const { fact, bytesBase64 } = entry;
  if (fact.kind !== 'mission') throw new Error('Mission delivery requires a source plan');
  const prepared = { fact, bytesBase64 };
  if (!entry.submission) {
    const { principal } = await ledger.request<{ principal: { id: string; tenantId: string } }>('/v1/me');
    if (
      !id(principal?.id) ||
      principal.tenantId !== `tenant-${fact.tenant}` ||
      (journal.principalId && journal.principalId !== principal.id)
    )
      throw new Error('Mission delivery principal changed its retained source identity');
    journal.principalId ??= principal.id;
    await save();
    if (!journal.flightId) {
      journal.flightId = await originatingFlight(prepared, config, ledger);
      await save();
    }
  }
  if (!id(journal.flightId)) throw new Error('Mission submission lacks its retained originating flight');
  if (
    entry.submission &&
    (entry.submission.bytesBase64 !== entry.bytesBase64 || entry.submission.principalId !== journal.principalId)
  )
    throw new Error('Mission submission changed its retained source bytes or principal');
  const adapter = new MissionAdapter({
    ledger,
    tenantId: `tenant-${fact.tenant}`,
    sourceId: fact.sourceId,
    sourceMissionId: fact.source.sourceMissionId,
    aircraftId: fact.aircraftId,
    flightId: journal.flightId,
  });
  let accepted: MissionAdapterResult | undefined;
  await config.transport.mission(prepared, async (raw) => {
    if (Buffer.from(raw).toString('base64') !== entry.bytesBase64)
      throw new Error('Mission callback changed its retained source bytes');
    if (entry.submission) {
      accepted = await adapter.recover(entry.submission);
    } else {
      entry.submission = await adapter.prepare(raw);
      if (entry.submission.principalId !== journal.principalId || entry.submission.bytesBase64 !== entry.bytesBase64)
        throw new Error('Mission preparation changed its retained source bytes or principal');
      await save();
      accepted = await adapter.send(entry.submission);
    }
    return accepted;
  });
  if (!accepted) throw new Error('Mission callback has not confirmed canonical acceptance');
  entry.accepted = accepted;
  await save();
  return retainedReceipt(entry, journal);
}

export async function deliverMission(
  prepared: PreparedWorldFact,
  config: MissionDeliveryConfig,
  ledger: LedgerClient,
): Promise<{ receiptId: string }> {
  const { fact } = prepared;
  if (fact.kind !== 'mission') throw new Error('Mission delivery requires a source plan');
  const identity = {
    apiUrl: config.apiUrl,
    tenantId: `tenant-${fact.tenant}`,
    attemptId: fact.attemptId,
    sourceId: fact.sourceId,
    sourceMissionId: fact.source.sourceMissionId,
    aircraftId: fact.aircraftId,
  };
  const binding = digest(JSON.stringify(identity));
  const path = join(config.stateDirectory, 'mission', `${digest(fact.attemptId)}.json`);
  const retained = (await readJournalEnvelope(path, MAX_JOURNAL_BYTES)) as MissionJournal | undefined;
  const journal: MissionJournal = retained === undefined ? { version: 1, binding, facts: {} } : retained;
  if (
    !journal ||
    journal.version !== 1 ||
    journal.binding !== binding ||
    !journal.facts ||
    typeof journal.facts !== 'object' ||
    Array.isArray(journal.facts) ||
    (journal.principalId !== undefined && !id(journal.principalId)) ||
    (journal.flightId !== undefined && !id(journal.flightId))
  )
    throw new Error('Mission journal belongs to another retained source binding');
  const entries = Object.entries(journal.facts);
  const revisions = new Set<number>();
  for (const [sequence, entry] of entries) {
    const original = entry.fact;
    if (
      original?.kind !== 'mission' ||
      String(original.sequence) !== sequence ||
      original.tenant !== fact.tenant ||
      original.attemptId !== fact.attemptId ||
      original.sourceId !== fact.sourceId ||
      original.aircraftId !== fact.aircraftId ||
      original.source.sourceMissionId !== fact.source.sourceMissionId ||
      original.source.aircraftId !== fact.aircraftId ||
      !Number.isSafeInteger(original.source.sourceRevision) ||
      original.source.sourceRevision < 1 ||
      revisions.has(original.source.sourceRevision) ||
      Buffer.from(JSON.stringify(original.source), 'utf8').toString('base64') !== entry.bytesBase64
    )
      throw new Error('Mission journal changed its retained source revision identity');
    revisions.add(original.source.sourceRevision);
  }
  const previous = journal.facts[fact.sequence];
  if (
    previous &&
    JSON.stringify({ fact: previous.fact, bytesBase64: previous.bytesBase64 }) !== JSON.stringify(prepared)
  )
    throw new Error('A retained mission fact cannot change on retry');
  if (
    !previous &&
    (!Number.isSafeInteger(fact.source.sourceRevision) ||
      fact.source.sourceRevision < 1 ||
      [...revisions].some((revision) => revision >= fact.source.sourceRevision))
  )
    throw new Error('A new world mission fact requires a higher source revision');
  const entry = previous ?? (journal.facts[fact.sequence] = structuredClone(prepared));
  const save = () => writeJournalEnvelope(path, journal, MAX_JOURNAL_BYTES);
  if (!previous) await save();
  const ordered = Object.values(journal.facts)
    .filter((value) => value.fact.kind === 'mission' && value.fact.source.sourceRevision <= fact.source.sourceRevision)
    .sort((left, right) => {
      if (left.fact.kind !== 'mission' || right.fact.kind !== 'mission') return 0;
      return left.fact.source.sourceRevision - right.fact.source.sourceRevision;
    });
  for (const original of ordered) await deliverEntry(original, journal, config, ledger, save);
  return { receiptId: retainedReceipt(entry, journal) };
}
