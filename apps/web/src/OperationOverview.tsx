import type { FlightListResponse } from '@ledger/contracts';
import { useEffect, useRef } from 'react';
import { Button, Spinner } from '@ledger/ui';
import { ctDayName, time, timeZoneLabel } from './format.js';
import { operationViews, type OperationView } from './operation-display.js';
import { operationOverview } from './operation-overview.js';

const orientation: Record<OperationView, { title: string; purpose: string; empty: string }> = {
  monitor: {
    title: 'Current operation',
    purpose: 'Follow recent reported activity, inspect upcoming plans and identify work that still needs planning.',
    empty: 'No current flights on this page. Orders awaiting their first flight appear separately in the roster.',
  },
  overdue: {
    title: 'Overdue work',
    purpose:
      'Review elapsed plans and unconfirmed outcomes. An elapsed window does not establish a landing or cancellation.',
    empty: 'No overdue flights on this page. Review other categories for current work and retained exceptions.',
  },
  'historical-issues': {
    title: 'Historical issues',
    purpose: 'Resolve the findings and record signals that remain on flights with a recorded landing or cancellation.',
    empty: 'No historical issues on this page. Completed records without outstanding issues appear in History.',
  },
  history: {
    title: 'Flight history',
    purpose: 'Inspect completed records, retained evidence and the decisions made against what was known at the time.',
    empty: 'No completed records on this page. Flights with unresolved exceptions remain in Historical issues.',
  },
};

export function OperationOverview({
  view,
  navigationRequest,
  page,
  search,
  continued,
  error,
  onChooseFlight,
  onClearSearch,
}: {
  view: OperationView;
  navigationRequest: number;
  page: FlightListResponse | null;
  search: string;
  continued: boolean;
  error: string | null;
  onChooseFlight: () => void;
  onClearSearch: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!navigationRequest || !window.matchMedia('(max-width: 820px)').matches) return;
    heading.current?.scrollIntoView({ block: 'start' });
    heading.current?.focus({ preventScroll: true });
  }, [navigationRequest]);
  const content = orientation[view];
  const label = view === 'history' ? 'History' : operationViews.find((item) => item.view === view)!.label;
  const rows = operationOverview(page?.flights ?? [], view);

  return (
    <section className="operation-overview" aria-label={`${label} summary`} data-testid="operation-overview">
      <header>
        <p className="thread-crumbs">{view === 'history' ? 'Records / History' : `Operation / ${label}`}</p>
        <h2 ref={heading} tabIndex={-1}>
          {content.title}
        </h2>
        <p className="overview-purpose">{content.purpose}</p>
      </header>
      {!page ? (
        <div className="overview-state" role="status">
          {error ? (
            <p>Flight records are unavailable. Retrying automatically; other categories remain available.</p>
          ) : (
            <Spinner label={`Reading ${label.toLowerCase()} flight records`} />
          )}
        </div>
      ) : (
        <>
          <div className="overview-page">
            <h3>
              <b className="mono">{page.flights.length}</b> {page.flights.length === 1 ? 'flight' : 'flights'} on this
              page
            </h3>
            <p>
              {search ? (
                <>
                  Flight search: <strong>{search}</strong>
                </>
              ) : (
                'All flights in this category’s loaded page'
              )}
            </p>
            {(continued || page.nextCursor) && <p>More records may exist. Use the page controls in the roster.</p>}
            <p className="overview-read-time">
              {error ? 'Last successful read' : 'Read'}{' '}
              <time dateTime={page.meta.computedAt}>
                {ctDayName(page.meta.computedAt)} · {time(page.meta.computedAt)} {timeZoneLabel()}
              </time>
            </p>
          </div>
          {rows.length > 0 ? (
            <dl className="overview-breakdown" aria-label="Flights on this page">
              {rows.map((row) => (
                <div key={row.key}>
                  <dt>{row.label}</dt>
                  <dd>{row.count}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="overview-state">
              {search ? 'No flights match this search in this category.' : content.empty}
            </p>
          )}
          <div className="overview-next">
            {page.flights.length > 0 ? (
              <>
                <Button kind="next" onClick={onChooseFlight}>
                  Choose a flight
                </Button>
                <p>Select a flight in the roster or map to inspect its record and available actions.</p>
              </>
            ) : search ? (
              <Button kind="next" onClick={onClearSearch}>
                Clear flight search
              </Button>
            ) : (
              <p>Choose another category in the roster to continue.</p>
            )}
          </div>
        </>
      )}
    </section>
  );
}
