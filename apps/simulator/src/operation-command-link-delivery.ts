import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  commandLinkStatusAdapter,
  digest,
  HttpObservationSink,
  submitVendorMessage,
  type LedgerClient,
} from '@ledger/adapters';
import type { FlightListResponse } from '@ledger/contracts';
import type { PreparedWorldFact } from './operation-delivery.js';
import type { OperationTransport } from './operation-transport.js';
import { readJournalEnvelope, writeJournalEnvelope } from './private-journal.js';

/** What Ledger confirmed for one report: the observation's receipt and the artifact holding its original bytes. */
export interface CommandLinkAcceptance {
  receiptId: string;
  artifactId: string;
}
interface CommandLinkJournal {
  version: 2;
  binding: string;
  principalId?: string;
  flightId?: string;
  facts: Record<string, PreparedWorldFact & { accepted?: CommandLinkAcceptance }>;
}
interface OriginatingJournal {
  version: 1 | 2;
  binding: string;
  aircraftId?: string;
  flightId?: string;
  facts: Record<string, PreparedWorldFact>;
}
const MAX_JOURNAL_BYTES = 2 * 1024 * 1024;

export async function deliverCommandLink(
  prepared: PreparedWorldFact,
  config: { apiUrl: string; stateDirectory: string; transport: Pick<OperationTransport, 'commandLink'> },
  ledger: LedgerClient,
): Promise<{ receiptId: string }> {
  const { fact } = prepared;
  if (fact.kind !== 'command-link') throw new Error('Command-link delivery requires a source report');
  const identity = {
    apiUrl: config.apiUrl,
    tenantId: `tenant-${fact.tenant}`,
    attemptId: fact.attemptId,
    sourceId: fact.sourceId,
    sourceSessionId: fact.sourceSessionId,
    aircraftId: fact.aircraftId,
  };
  const binding = digest(JSON.stringify(identity));
  const path = join(config.stateDirectory, 'command-link', `${digest(fact.attemptId)}.json`);
  const retained = (await readJournalEnvelope(path, MAX_JOURNAL_BYTES)) as CommandLinkJournal | undefined;
  // Version 1 journals were kept by the retired dedicated intake; their pending reports cannot be resumed here.
  const journal: CommandLinkJournal = retained ?? { version: 2, binding, facts: {} };
  if (journal.version !== 2)
    throw new Error('Command-link journal belongs to the retired command-link intake; start a new state directory');
  if (journal.binding !== binding || !journal.facts || Array.isArray(journal.facts))
    throw new Error('Command-link journal belongs to another retained source binding');
  const previous = journal.facts[fact.sequence];
  if (
    previous &&
    JSON.stringify({ fact: previous.fact, bytesBase64: previous.bytesBase64 }) !== JSON.stringify(prepared)
  )
    throw new Error('A retained command-link fact cannot change on retry');
  if (previous?.accepted) return { receiptId: previous.accepted.receiptId };
  const entry = previous ?? (journal.facts[fact.sequence] = structuredClone(prepared));
  const save = () => writeJournalEnvelope(path, journal, MAX_JOURNAL_BYTES);
  await save();
  const { principal } = await ledger.request<{ principal: { id: string; tenantId: string } }>('/v1/me');
  if (
    !principal?.id ||
    principal.tenantId !== identity.tenantId ||
    (journal.principalId && journal.principalId !== principal.id)
  )
    throw new Error('Command-link delivery principal changed its retained source identity');
  journal.principalId ??= principal.id;
  await save();
  if (!journal.flightId) {
    const originatingPath = join(config.stateDirectory, 'delivery', `${digest(fact.attemptId)}.json`);
    const originating = JSON.parse(await readFile(originatingPath, 'utf8')) as OriginatingJournal;
    const primaryBinding = digest(
      JSON.stringify({ apiUrl: config.apiUrl, tenant: fact.tenant, attemptId: fact.attemptId }),
    );
    if (
      originating.version !== 2 ||
      originating.binding !== primaryBinding ||
      originating.aircraftId !== fact.aircraftId ||
      !originating.facts
    )
      throw new Error('Command-link report lacks its retained originating flight binding');
    journal.flightId = originating.flightId;
    if (!journal.flightId) {
      const order = Object.values(originating.facts).find((value) => value.fact.kind === 'order')?.fact;
      if (order?.kind !== 'order') throw new Error('Command-link report lacks its retained originating order');
      let cursor: string | undefined;
      const seen = new Set<string>();
      const deadline = Date.now() + 5000;
      do {
        if (Date.now() >= deadline) throw new Error('Command-link originating flight lookup exceeded its deadline');
        const query = new URLSearchParams({ search: order.order.order_id, limit: '200' });
        if (cursor) query.set('cursor', cursor);
        const page = await ledger.request<FlightListResponse>(`/v1/flights?${query}`);
        journal.flightId = page.flights.find((flight) => flight.originationKey === fact.attemptId)?.id;
        cursor = page.nextCursor ?? undefined;
        if (cursor && seen.has(cursor)) throw new Error('Command-link originating flight lookup repeated its cursor');
        if (cursor) seen.add(cursor);
      } while (!journal.flightId && cursor);
      if (!journal.flightId) throw new Error('Command-link report is pending its originated flight');
    }
    await save();
  }
  const flightId = journal.flightId;
  const sink = new HttpObservationSink({ ledger, sourceId: fact.sourceId });
  // The same bytes and transport give the same upload and observation keys, so a retry after a crash is idempotent.
  const accepted = await config.transport.commandLink(prepared, async (raw) => {
    // The adapter process's own step: translate, retain the original bytes, submit under the adapters' keys.
    const outcome = await submitVendorMessage(
      commandLinkStatusAdapter,
      { bytes: raw, contentType: 'application/json', transport: {}, capturedAt: fact.at },
      {
        subjects: { scope: 'ledger', ids: { flight: { [fact.sourceSessionId]: flightId } } },
        binding: { sourceSessionId: fact.sourceSessionId, aircraftId: fact.aircraftId },
      },
      sink,
    );
    const submitted = outcome.submitted[0];
    if (outcome.rejections.length || outcome.submitted.length !== 1 || !submitted || !outcome.artifactId)
      throw new Error(
        `Command-link report was not translated to one observation: ${outcome.rejections
          .map((item) => item.reason)
          .join('; ')}`,
      );
    return { receiptId: submitted.receiptId, artifactId: outcome.artifactId };
  });
  entry.accepted = accepted;
  await save();
  return { receiptId: accepted.receiptId };
}
