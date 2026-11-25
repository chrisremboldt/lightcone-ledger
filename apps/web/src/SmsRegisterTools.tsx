import { useEffect, useState } from 'react';
import type { LedgerClient } from '@ledger/contracts/client';
import type { SmsRecordKind, SmsRecordSummary, SmsRegisterOrder, SmsRegisterResponse } from '@ledger/contracts';
import { Button, Notice } from '@ledger/ui';
import { timeZoneLabel } from './format.js';
import { plainError } from './sms-labels.js';
import { narrowed, orderLabels, registerPath, unnarrowed, type RegisterQuery } from './sms-register-query.js';

/** Waits this long after the last keystroke of a search before reading the register. */
const TYPING_PAUSE_MS = 250;

/**
 * One safety register as a person narrowed it, a page at a time. Unnarrowed, it shows the first page the safety
 * section keeps current; narrowed, it reads its own first page, again whenever that one is read again.
 */
export function useRegisterList(
  client: LedgerClient,
  kind: SmsRecordKind,
  polled: SmsRegisterResponse,
  query: RegisterQuery,
) {
  const key = registerPath(kind, query);
  const [own, setOwn] = useState<SmsRegisterResponse | null>(null);
  const [later, setLater] = useState<{ records: SmsRecordSummary[]; nextCursor: string | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const isNarrowed = narrowed(query);

  useEffect(() => {
    setOwn(null);
    setLater(null);
    setFailure(null);
  }, [key]);
  useEffect(() => {
    if (!isNarrowed) return;
    let stopped = false;
    client
      .request<SmsRegisterResponse>(key)
      .then((page) => !stopped && setOwn(page))
      .catch((error: unknown) => !stopped && setFailure(plainError(error).message));
    return () => {
      stopped = true;
    };
  }, [client, key, isNarrowed, polled.computedAt]);

  const first = isNarrowed ? own : polled;
  const shownIds = new Set(first?.records.map((record) => record.id));
  const records = first
    ? [...first.records, ...(later?.records ?? []).filter((record) => !shownIds.has(record.id))]
    : null;
  const nextCursor = later ? later.nextCursor : (first?.nextCursor ?? null);
  async function more() {
    if (!nextCursor) return;
    setLoading(true);
    setFailure(null);
    try {
      const page = await client.request<SmsRegisterResponse>(registerPath(kind, query, nextCursor));
      setLater((previous) => ({
        records: [...(previous?.records ?? []), ...page.records],
        nextCursor: page.nextCursor,
      }));
    } catch (error) {
      setFailure(plainError(error).message);
    } finally {
      setLoading(false);
    }
  }
  return { records, more: nextCursor ? more : null, loading, failure };
}

/** The search box and the filters above a safety register, in the manner of the document library. */
export function RegisterTools({
  noun,
  query,
  onQuery,
  searchLabel,
  searchHint,
  statuses,
  types,
  orders,
  openedLabel,
}: {
  /** The register's records, as in "Find hazards". */
  noun: string;
  query: RegisterQuery;
  onQuery: (query: RegisterQuery) => void;
  searchLabel: string;
  searchHint: string;
  statuses: readonly { value: string; label: string }[];
  types?: readonly { value: string; label: string }[];
  orders: readonly SmsRegisterOrder[];
  /** Offers the days a record was opened, with what opening means for this register. */
  openedLabel?: string;
}) {
  const [search, setSearch] = useState(query.search);
  useEffect(() => {
    if (search === query.search) return;
    const timer = setTimeout(() => onQuery({ ...query, search }), TYPING_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [search, query]);
  const set = (field: keyof RegisterQuery) => (event: { target: { value: string } }) =>
    onQuery({ ...query, [field]: event.target.value });
  return (
    <div className="sms-register-tools">
      <div className="sms-library-tools">
        <label className="roster-search">
          <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
            <circle cx="5.5" cy="5.5" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="M8.7 8.7L12 12" stroke="currentColor" strokeWidth="1.4" />
          </svg>
          <input
            aria-label={`Find ${noun}`}
            type="search"
            value={search}
            maxLength={80}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={searchLabel}
          />
        </label>
        <select aria-label="State" value={query.status} onChange={set('status')}>
          <option value="">Every state</option>
          {statuses.map((status) => (
            <option key={status.value} value={status.value}>
              {status.label}
            </option>
          ))}
        </select>
        {types && (
          <select aria-label="Type" value={query.assuranceType} onChange={set('assuranceType')}>
            <option value="">Every type</option>
            {types.map((type) => (
              <option key={type.value} value={type.value}>
                {type.label}
              </option>
            ))}
          </select>
        )}
        {orders.length > 1 && (
          <select aria-label="Order" value={query.order} onChange={set('order')}>
            {orders.map((order) => (
              <option key={order} value={order}>
                {orderLabels[order]}
              </option>
            ))}
          </select>
        )}
      </div>
      {openedLabel && (
        <div className="sms-register-days">
          <label>
            {openedLabel} from ({timeZoneLabel()})
            <input type="date" value={query.openedFrom} onChange={set('openedFrom')} />
          </label>
          <label>
            until
            <input type="date" value={query.openedUntil} onChange={set('openedUntil')} />
          </label>
        </div>
      )}
      <p className="sms-register-hint">
        {searchHint}
        {narrowed(query) && (
          <>
            {' '}
            <Button
              kind="quiet"
              onClick={() => {
                setSearch('');
                onQuery(unnarrowed);
              }}
            >
              Clear search and filters
            </Button>
          </>
        )}
      </p>
    </div>
  );
}

/** Reads the next page of a register, and says when it could not. */
export function RegisterMore({
  label,
  list,
}: {
  label: string;
  list: { more: (() => Promise<void>) | null; loading: boolean; failure: string | null };
}) {
  return (
    <>
      {list.failure && (
        <Notice tone="alert" title={`${label} unavailable`}>
          {list.failure}
        </Notice>
      )}
      {list.more && (
        <div className="history-navigation">
          <Button kind="quiet" disabled={list.loading} onClick={() => void list.more?.()}>
            {list.loading ? 'Loading…' : label}
          </Button>
        </div>
      )}
    </>
  );
}
