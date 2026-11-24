import { useEffect, useRef, useState } from 'react';
import { LedgerClient } from '@ledger/contracts/client';
import type { Principal } from '@ledger/contracts';
import { readFailureOutcome } from './read-failure.js';

export interface HistoricalAttentionStatus {
  present: boolean | null;
  checkedAt: string | null;
  interrupted: boolean;
}

interface Read {
  client: LedgerClient;
  scope: string;
  status: HistoricalAttentionStatus;
}

const unknown: HistoricalAttentionStatus = { present: null, checkedAt: null, interrupted: false };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function presence(value: unknown): HistoricalAttentionStatus {
  if (
    !record(value) ||
    !Array.isArray(value.flights) ||
    value.flights.length > 1 ||
    !record(value.meta) ||
    typeof value.meta.computedAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(value.meta.computedAt) ||
    !Number.isFinite(Date.parse(value.meta.computedAt)) ||
    (value.nextCursor !== undefined &&
      value.nextCursor !== null &&
      (typeof value.nextCursor !== 'string' || !value.nextCursor || value.nextCursor.length > 4096)) ||
    (value.flights.length === 0 && value.nextCursor != null)
  )
    throw new Error('The historical issue presence read is incomplete.');

  if (value.flights.length) {
    const flight: unknown = value.flights[0];
    if (
      !record(flight) ||
      typeof flight.id !== 'string' ||
      !flight.id ||
      flight.id.length > 200 ||
      (flight.activity !== 'landed' && flight.activity !== 'cancelled') ||
      !record(flight.operation) ||
      flight.operation.scope !== 'historical-issues' ||
      flight.operation.reason !== 'terminal-issues'
    )
      throw new Error('The historical issue presence read does not match this category.');
  }
  return { present: value.flights.length > 0, checkedAt: value.meta.computedAt, interrupted: false };
}

export function useHistoricalAttention(client: LedgerClient, principal: Principal | null): HistoricalAttentionStatus {
  const scope = principal ? JSON.stringify([principal.id, principal.tenantId, principal.revision]) : null;
  const [read, setRead] = useState<Read | null>(null);
  const identity = useRef({ client, scope });
  identity.current = { client, scope };

  useEffect(() => {
    setRead(null);
    if (!scope) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    const current = () => !stopped && identity.current.client === client && identity.current.scope === scope;

    async function poll() {
      const request = new AbortController();
      controller = request;
      const deadline = setTimeout(() => request.abort(), 8000);
      try {
        const response = await client.readJson<unknown>('/v1/flights?view=historical-issues&limit=1', {
          maxBytes: 256 * 1024,
          signal: request.signal,
        });
        const status = presence(response);
        if (current()) setRead({ client, scope: scope!, status });
      } catch (failure) {
        if (current()) {
          // The flight list names no record the API could hide behind a 404.
          const unauthorized = readFailureOutcome(failure, false) === 'access_lost';
          setRead((previous) => {
            if (!current()) return previous;
            const prior = previous?.client === client && previous.scope === scope ? previous.status : null;
            return {
              client,
              scope: scope!,
              status: {
                present: !unauthorized && prior?.present === true ? true : null,
                checkedAt: unauthorized ? null : (prior?.checkedAt ?? null),
                interrupted: true,
              },
            };
          });
        }
      } finally {
        clearTimeout(deadline);
        if (current()) timer = setTimeout(() => void poll(), 5000);
      }
    }

    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
    };
  }, [client, scope]);

  return read?.client === client && read.scope === scope ? read.status : unknown;
}
