import { useEffect, useState } from 'react';
import { ApiError, LedgerClient } from '@ledger/contracts/client';
import type { OrderListResponse } from '@ledger/contracts';
import { Button } from '@ledger/ui';
import { ctDay, ctDayName, dayTime, errorMessage, shortTime, timeZoneLabel } from './format.js';
import { sourceLabel } from './labels.js';
import { awaitingOrderStatus, operationTimestamp } from './operation-display.js';
import { readFailureOutcome } from './read-failure.js';

function requestedWindow(payload: Record<string, unknown>) {
  const start = operationTimestamp(payload.scheduledStart);
  const end = operationTimestamp(payload.scheduledEnd);
  if (start && end) {
    const until = ctDay(start) === ctDay(end) ? shortTime(end) : `${ctDayName(end)} ${shortTime(end)}`;
    return `Requested ${ctDayName(start)} · ${shortTime(start)}–${until} ${timeZoneLabel()}`;
  }
  if (start) return `Requested from ${dayTime(start)}`;
  if (end) return `Requested by ${dayTime(end)}`;
  return 'Requested window not recorded';
}

export function AwaitingOrders({
  client,
  view,
}: {
  client: LedgerClient;
  view: 'awaiting-current' | 'awaiting-overdue';
}) {
  const [cursor, setCursor] = useState<string | undefined>();
  const [page, setPage] = useState<OrderListResponse | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    setBusy(true);
    async function poll() {
      try {
        const result = await client.orders({ view, limit: 25, ...(cursor ? { cursor } : {}) });
        if (!stopped) {
          setPage(result);
          setError(null);
        }
      } catch (failure) {
        if (!stopped) {
          const cursorMismatch =
            failure instanceof ApiError &&
            failure.status === 400 &&
            (failure.body as { error?: { code?: string } })?.error?.code === 'cursor_scope_mismatch';
          if (cursor && cursorMismatch) setCursor(undefined);
          else {
            if (readFailureOutcome(failure, true) === 'access_lost') setPage(null);
            setError(errorMessage(failure));
          }
        }
      } finally {
        if (!stopped) {
          setBusy(false);
          timer = setTimeout(() => void poll(), 2000);
        }
      }
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [client, cursor, view]);

  return (
    <section className="roster-group roster-group--awaiting" aria-label="Awaiting flight" data-testid="awaiting-orders">
      <h2>
        {view === 'awaiting-overdue' ? 'Overdue orders awaiting flight' : 'Awaiting flight'}{' '}
        <span className="roster-count">
          {page ? `${page.orders.length}${page.page.hasMore ? '+' : ''}${cursor ? ' shown' : ''}` : '—'}
        </span>
      </h2>
      <p className="awaiting-order-status">Orders across this operator · not filtered by flight search</p>
      {error && (
        <p className="awaiting-order-status" role="status" title={error}>
          Order updates interrupted. Retrying.
        </p>
      )}
      {!page && !error && <p className="awaiting-order-status">Loading orders</p>}
      {page && page.orders.length === 0 && (
        <p className="awaiting-order-status">{cursor ? 'No orders on this page.' : 'No orders awaiting a flight.'}</p>
      )}
      {page?.orders.map((order) => (
        <article className="awaiting-order" key={order.id} data-testid={`awaiting-order-${order.id}`}>
          <strong>
            {typeof order.payload.label === 'string' && order.payload.label.trim()
              ? order.payload.label
              : order.externalId}
          </strong>
          <span className="awaiting-order-unlinked">
            {awaitingOrderStatus(order.payload, page.meta.computedAt, view)}
          </span>
          <span>{sourceLabel(order.sourceId)}</span>
          <span>{requestedWindow(order.payload)}</span>
          {!operationTimestamp(order.payload.scheduledEnd) && <span>Needs planning · no usable requested end</span>}
          {view === 'awaiting-overdue' && <span>Requested window elapsed · needs disposition</span>}
        </article>
      ))}
      {(cursor || page?.page.nextCursor) && (
        <div className="history-navigation awaiting-order-pages">
          {cursor && (
            <Button kind="quiet" disabled={busy} onClick={() => setCursor(undefined)}>
              First orders
            </Button>
          )}
          {page?.page.nextCursor && (
            <Button
              kind="quiet"
              disabled={busy || page.page.nextCursor === cursor}
              onClick={() => setCursor(page.page.nextCursor ?? undefined)}
            >
              More orders
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
