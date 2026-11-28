import { useEffect, useState, type ReactNode } from 'react';
import { Button, Notice, Spinner } from '@ledger/ui';
import { counted, errorMessage } from './format.js';
import type { Place } from './place.js';
import { readingNeeds } from './report-periods.js';
import { PlaceLink } from './TopBar.js';

/** What every report page is made of: a read with its three states, a count that opens its list, and printing. */

export type Loaded<T> = { state: 'loading' } | { state: 'failed'; message: string } | { state: 'loaded'; value: T };

export function useRead<T>(read: () => Promise<T>, key: string): Loaded<T> {
  const [loaded, setLoaded] = useState<Loaded<T>>({ state: 'loading' });
  useEffect(() => {
    let current = true;
    setLoaded({ state: 'loading' });
    read().then(
      (value) => current && setLoaded({ state: 'loaded', value }),
      (failure: unknown) => current && setLoaded({ state: 'failed', message: errorMessage(failure) }),
    );
    return () => {
      current = false;
    };
    // The key names everything the read depends on.
  }, [key]);
  return loaded;
}

export function Shown<T>({
  loaded,
  label,
  children,
}: {
  loaded: Loaded<T>;
  label: string;
  children: (value: T) => ReactNode;
}) {
  if (loaded.state === 'loading') return <Spinner label={label} />;
  if (loaded.state === 'failed')
    return (
      <Notice tone="alert" title="This report could not be read">
        {loaded.message}
      </Notice>
    );
  return <>{children(loaded.value)}</>;
}

export function PrintButton() {
  return (
    <Button kind="secondary" onClick={() => window.print()}>
      Print or save as PDF
    </Button>
  );
}

/**
 * A count that links to the list it counts; on paper, just the number. It is read out with what it counts, in the
 * words for one of them when it counts one: "1 flight of RIDGE-AC-1", "2 flights of RIDGE-AC-1".
 */
export function CountLink({ count, place, one, many }: { count: number; place: Place; one: string; many: string }) {
  return (
    <PlaceLink className="report-count" place={place}>
      <span aria-label={counted(count, one, many)}>{count}</span>
    </PlaceLink>
  );
}

export function NotYours({ part, capability }: { part: string; capability: string }) {
  return (
    <p className="records-note report-not-yours" data-testid="report-part-not-readable">
      {part}: not yours to read. Reading them needs {readingNeeds[capability] ?? capability}.
    </p>
  );
}
