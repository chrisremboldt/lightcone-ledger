import type { FlightListResponse, FlightSummary, ReceiptListResponse } from '@ledger/contracts';
import { LedgerClient } from '@ledger/adapters';

class RecoveryIdentityError extends Error {}
function boundedRequest(deadline?: number): RequestInit {
  if (deadline === undefined) return {};
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('Public recovery paging exceeded its deadline');
  return { signal: AbortSignal.timeout(Math.min(10_000, remaining)) };
}
function counter(text: string): number {
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 0 || value === Number.MAX_SAFE_INTEGER)
    throw new RecoveryIdentityError('Retained trickle sequence is outside its integer bound');
  return value;
}

export async function publicFlights(
  client: LedgerClient,
  deadline?: number,
): Promise<{ flights: FlightSummary[]; outstandingWork: number }> {
  const flights: FlightSummary[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  let outstandingWork = 0;
  do {
    const query = new URLSearchParams({ limit: '200' });
    if (cursor) query.set('cursor', cursor);
    const page = await client.request<FlightListResponse>(`/v1/flights?${query}`, boundedRequest(deadline));
    flights.push(...page.flights);
    outstandingWork = Math.max(outstandingWork, page.meta.outstandingWork);
    cursor = page.nextCursor ?? undefined;
    if (cursor) {
      if (seen.has(cursor)) throw new RecoveryIdentityError('Public flight cursor repeated');
      seen.add(cursor);
    }
  } while (cursor);
  return { flights, outstandingWork };
}

export async function recoverTrickleNext(
  clients: Record<'alpha' | 'beta', LedgerClient>,
  timeout = 60_000,
): Promise<number> {
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('Public recovery timeout must be positive');
  const deadline = Date.now() + timeout;
  let lastFailure = 'trickle order projection has outstanding work';
  const orderState = async (tenant: 'alpha' | 'beta') => {
    let cursor: string | undefined,
      maximum = -1,
      unsettled = false;
    const seen = new Set<string>();
    do {
      const query = new URLSearchParams({ sourceId: 'partner-orders', limit: '200' });
      if (cursor) query.set('cursor', cursor);
      const page = await clients[tenant].request<ReceiptListResponse>(
        `/v1/receipts?${query}`,
        boundedRequest(deadline),
      );
      for (const receipt of page.receipts) {
        if (receipt.kind !== 'order.revision') continue;
        const externalId = receipt.payload.externalId;
        if (typeof externalId !== 'string' || !externalId.startsWith('order-trickle-')) continue;
        const match = externalId.match(/^order-trickle-(alpha|beta)-(0|[1-9]\d*)$/);
        if (!match || match[1] !== tenant || receipt.sourceId !== 'partner-orders')
          throw new RecoveryIdentityError('Retained trickle order does not match its tenant/source identity');
        const sequence = counter(match[2]!);
        const rows = receipt.payload.fulfillments;
        if (
          !Array.isArray(rows) ||
          rows.length !== 1 ||
          rows[0]?.originationKey !== `trickle-${tenant}-${sequence}:attempt:1`
        )
          throw new RecoveryIdentityError('Retained trickle fulfillment does not match its order identity');
        maximum = Math.max(maximum, sequence);
        if (['pending', 'processing'].includes(receipt.processing.status)) unsettled = true;
      }
      cursor = page.page.nextCursor ?? undefined;
      if (cursor) {
        if (seen.has(cursor)) throw new RecoveryIdentityError('Public receipt cursor repeated');
        seen.add(cursor);
      }
    } while (cursor);
    return { maximum, unsettled };
  };
  do {
    try {
      const [views, orders] = await Promise.all([
        Promise.all([publicFlights(clients.alpha, deadline), publicFlights(clients.beta, deadline)]),
        Promise.all([orderState('alpha'), orderState('beta')]),
      ]);
      if (orders.every((order) => !order.unsettled)) {
        let maximum = Math.max(...orders.map((order) => order.maximum));
        for (const [index, view] of views.entries())
          for (const flight of view.flights) {
            if (!flight.originationKey.startsWith('trickle-')) continue;
            const match = flight.originationKey.match(/^trickle-(alpha|beta)-(0|[1-9]\d*):attempt:1$/);
            if (!match || match[1] !== (index === 0 ? 'alpha' : 'beta'))
              throw new RecoveryIdentityError('Persisted trickle flight does not match its tenant identity');
            maximum = Math.max(maximum, counter(match[2]!));
          }
        return maximum + 1;
      }
    } catch (error) {
      if (error instanceof RecoveryIdentityError) throw error;
      lastFailure = error instanceof Error ? error.message : 'public API unavailable';
    }
    if (Date.now() < deadline)
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(250, deadline - Date.now())));
  } while (Date.now() < deadline);
  throw new Error(`Cannot recover trickle sequence from settled public state: ${lastFailure}`);
}
