import { useEffect, useState, type FormEvent } from 'react';
import type { LedgerClient } from '@ledger/contracts/client';
import type {
  ControlIndicatorResultListResponse,
  ControlWindow,
  ControlWindowIndicatorResponse,
  ControlWindowQuery,
  IndicatorResult,
} from '@ledger/contracts';
import { Badge, Button, Notice, Spinner } from '@ledger/ui';
import { errorMessage, json, time, timeZoneLabel } from './format.js';
import { PlaceLink } from './TopBar.js';

type Loaded<T> = { state: 'loading' } | { state: 'failed'; message: string } | { state: 'loaded'; value: T };

const statusPresentation: Record<IndicatorResult['status'], { label: string; tone: 'planned' | 'attention' }> = {
  supported: { label: 'Rate stated', tone: 'planned' },
  insufficient: { label: 'Insufficient evidence', tone: 'attention' },
  conflicting: { label: 'Conflicting evidence', tone: 'attention' },
};

function useLoaded<T>(load: () => Promise<T>, key: string): Loaded<T> {
  const [loaded, setLoaded] = useState<Loaded<T>>({ state: 'loading' });
  useEffect(() => {
    let current = true;
    setLoaded({ state: 'loading' });
    load().then(
      (value) => current && setLoaded({ state: 'loaded', value }),
      (failure: unknown) => current && setLoaded({ state: 'failed', message: errorMessage(failure) }),
    );
    return () => {
      current = false;
    };
    // The key names everything the load reads.
  }, [key]);
  return loaded;
}

type Wording = ControlWindowIndicatorResponse['wording'];

/** A code's sentence, or the code itself when no current definition words it. */
function Explained({ item }: { item: Wording['reasons'][number] }) {
  return item.sentence ? <>{item.sentence}</> : <span className="mono">{item.code}</span>;
}

function Sentences({ label, items }: { label: string; items: Wording['reasons'] | Wording['gaps'] }) {
  if (!items.length) return <>None</>;
  return (
    <ul aria-label={label}>
      {items.map((item) => (
        <li key={item.code}>
          <Explained item={item} />
          {'count' in item && !item.sentence ? <> ({item.count})</> : null}
        </li>
      ))}
    </ul>
  );
}

/** Identifiers, codes and digests, folded away for someone who needs them. */
function Identifiers({ label, value }: { label: string; value: unknown }) {
  return (
    <details>
      <summary>{label}</summary>
      <pre>{json(value)}</pre>
    </details>
  );
}

/** One indicator result for a window: what was counted, over what exposure, and what the evidence supports. */
function IndicatorResultView({
  result,
  wording,
  revision,
}: {
  result: IndicatorResult;
  wording: Wording;
  revision: number;
}) {
  const status = statusPresentation[result.status];
  return (
    <div data-testid="control-indicator-result">
      <p>
        <Badge tone={status.tone}>{status.label}</Badge> {wording.rate ?? 'No rate stated'}
      </p>
      <dl className="safety-facts">
        <div>
          <dt>Counted</dt>
          <dd>{wording.events}</dd>
        </div>
        <div>
          <dt>Exposure</dt>
          <dd>{wording.exposure}</dd>
        </div>
        <div>
          <dt>Exposure gaps</dt>
          <dd>
            <Sentences label="Exposure gaps" items={wording.gaps} />
          </dd>
        </div>
        <div>
          <dt>Exposure conflicts</dt>
          <dd>
            <Sentences label="Exposure conflicts" items={wording.conflicts} />
          </dd>
        </div>
        <div>
          <dt>Population</dt>
          <dd>{wording.population}</dd>
        </div>
        {wording.reasons.length > 0 && (
          <div>
            <dt>Why no rate is stated</dt>
            <dd>
              <Sentences label="Reasons" items={wording.reasons} />
            </dd>
          </div>
        )}
        {wording.limitations.length > 0 && (
          <div>
            <dt>Not taken into account</dt>
            <dd>
              <Sentences label="Limitations" items={wording.limitations} />
            </dd>
          </div>
        )}
        <div>
          <dt>Evidence read through</dt>
          <dd>
            {time(result.recordedThrough, true)} {timeZoneLabel()}, window revision {revision}
          </dd>
        </div>
      </dl>
      <Identifiers
        label="Identifiers and digests"
        value={{
          definition: result.definition,
          exposureKind: result.exposureKind,
          control: result.control,
          window: result.window,
          reasons: result.reasons,
          limitations: result.limitations ?? [],
          gaps: result.exposure.gaps,
          conflicts: result.exposure.conflicts,
          population: result.population,
          counted: result.counted,
          inputDigest: result.inputDigest,
        }}
      />
    </div>
  );
}

function WindowIndicator({
  client,
  window,
  indicator,
}: {
  client: LedgerClient;
  window: ControlWindow;
  indicator: ControlWindow['indicators'][number];
}) {
  const loaded = useLoaded(
    () => client.controlWindowIndicator(window.id, indicator),
    `${window.id}:${window.revision.digest}:${indicator.id}:${indicator.version}`,
  );
  const title =
    window.wording?.indicators.find((entry) => entry.id === indicator.id && entry.version === indicator.version)
      ?.title ?? (loaded.state === 'loaded' ? loaded.value.wording.title : null);
  return (
    <li>
      <p>{title ? <strong>{title}</strong> : <strong className="mono">{indicator.id}</strong>}</p>
      {loaded.state === 'loaded' && loaded.value.wording.description ? (
        <p className="muted">{loaded.value.wording.description}</p>
      ) : null}
      <p>
        <PlaceLink place={{ section: 'reports', report: 'indicators', id: indicator.id, version: indicator.version }}>
          Its recorded results over time
        </PlaceLink>
      </p>
      {loaded.state === 'loading' ? (
        <Spinner label="Calculating the indicator" />
      ) : loaded.state === 'failed' ? (
        <Notice tone="attention" title="Indicator unavailable">
          <p>{loaded.message}</p>
        </Notice>
      ) : (
        <>
          <IndicatorResultView
            result={loaded.value.result}
            wording={loaded.value.wording}
            revision={loaded.value.revision}
          />
          <RecordedResults client={client} window={window} indicator={indicator} />
        </>
      )}
    </li>
  );
}

const conclusions = ['effective', 'ineffective', 'inconclusive'] as const;

/** One recorded result and the form for a person's review of it. */
function RecordedResult({
  client,
  recorded,
  reviews,
  onReviewed,
}: {
  client: LedgerClient;
  recorded: ControlIndicatorResultListResponse['results'][number];
  reviews: ControlIndicatorResultListResponse['reviews'];
  onReviewed: () => void;
}) {
  const allowed = recorded.record.result.status === 'supported' ? conclusions : (['inconclusive'] as const);
  const [conclusion, setConclusion] = useState<(typeof conclusions)[number]>('inconclusive');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const own = reviews.filter((review) => review.record.result.id === recorded.record.id);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await client.reviewControlIndicatorResult(
        { result: { id: recorded.record.id, digest: recorded.digest }, conclusion, note: note.trim() },
        crypto.randomUUID(),
      );
      setNote('');
      onReviewed();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <li data-testid="control-indicator-recorded">
      <p>
        Recorded {time(recorded.record.recordedAt, true)} {timeZoneLabel()}
      </p>
      <IndicatorResultView
        result={recorded.record.result}
        wording={recorded.wording}
        revision={recorded.record.windowRevision}
      />
      <Identifiers
        label="Recorded result identifiers"
        value={{ id: recorded.record.id, digest: recorded.digest, windowId: recorded.record.windowId }}
      />
      {own.length > 0 && (
        <ul aria-label="Reviews">
          {own.map((review) => (
            <li key={review.record.id}>
              <Badge>{review.record.conclusion}</Badge> {review.record.actor.name} ·{' '}
              {time(review.record.recordedAt, true)} {timeZoneLabel()} · {review.record.note}
            </li>
          ))}
        </ul>
      )}
      <form className="safety-form" onSubmit={submit} aria-label="Review this result">
        <label>
          Conclusion
          <select value={conclusion} onChange={(event) => setConclusion(event.target.value as typeof conclusion)}>
            {allowed.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label>
          Note
          <textarea value={note} onChange={(event) => setNote(event.target.value)} required />
        </label>
        {error && (
          <Notice tone="attention" title="Review not recorded">
            <p>{error}</p>
          </Notice>
        )}
        <Button kind="next" type="submit" disabled={busy || !note.trim()}>
          Record review
        </Button>
      </form>
    </li>
  );
}

/** The results recorded for one indicator of a window, and recording the current one. */
function RecordedResults({
  client,
  window,
  indicator,
}: {
  client: LedgerClient;
  window: ControlWindow;
  indicator: ControlWindow['indicators'][number];
}) {
  const [generation, setGeneration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const loaded = useLoaded(() => client.controlIndicatorResults(window.id), `${window.id}:${generation}`);
  async function record() {
    setBusy(true);
    setError(null);
    try {
      await client.recordControlIndicatorResult(
        window.id,
        {
          definition: { ...indicator },
          expectedRevision: { number: window.revision.number, digest: window.revision.digest },
        },
        crypto.randomUUID(),
      );
      setGeneration((value) => value + 1);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  const own =
    loaded.state === 'loaded'
      ? loaded.value.results.filter(
          (item) =>
            item.record.result.definition.id === indicator.id &&
            item.record.result.definition.version === indicator.version,
        )
      : [];
  return (
    <div data-testid="control-indicator-recording">
      <Button kind="next" onClick={record} disabled={busy}>
        Record this result
      </Button>
      {error && (
        <Notice tone="attention" title="Result not recorded">
          <p>{error}</p>
        </Notice>
      )}
      {loaded.state === 'failed' ? (
        <Notice tone="attention" title="Recorded results unavailable">
          <p>{loaded.message}</p>
        </Notice>
      ) : own.length > 0 ? (
        <ul aria-label="Recorded results">
          {own.map((recorded) => (
            <RecordedResult
              key={recorded.record.id}
              client={client}
              recorded={recorded}
              reviews={loaded.state === 'loaded' ? loaded.value.reviews : []}
              onReviewed={() => setGeneration((value) => value + 1)}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * The indicator results for one accepted control: each window declared for it, with its population and the result
 * of every indicator the window was opened for. A result is evidence for a person to review, never a verdict.
 */
export function ControlIndicators({ client, query }: { client: LedgerClient; query: ControlWindowQuery }) {
  const loaded = useLoaded(() => client.controlWindows(query), JSON.stringify(query));
  const windows = loaded.state === 'loaded' ? loaded.value.windows.filter((window) => window.indicators.length) : [];
  return (
    <section className="safety-section" aria-label="Indicator results" data-testid="control-indicators">
      <h3>Indicator results</h3>
      {loaded.state === 'loading' ? (
        <Spinner label="Reading the control’s windows" />
      ) : loaded.state === 'failed' ? (
        <Notice tone="attention" title="Windows unavailable">
          <p>{loaded.message}</p>
        </Notice>
      ) : windows.length === 0 ? (
        <p className="muted">No window with an indicator has been declared for this control.</p>
      ) : (
        <ul className="assurance-history">
          {windows.map((window) => (
            <li key={window.id}>
              <p>
                {time(window.period.start, true)} – {time(window.period.end, true)} {timeZoneLabel()} · Covers{' '}
                {window.wording?.population ?? `${window.population.subjects.length} listed`}
              </p>
              <Identifiers
                label="Window identifiers"
                value={{
                  id: window.id,
                  revision: window.revision,
                  population: {
                    subjectKind: window.population.subjectKind,
                    subjects: window.population.subjects,
                    declaredBy: window.population.declaredBy,
                  },
                  indicators: window.indicators,
                }}
              />
              <ul>
                {window.indicators.map((indicator) => (
                  <WindowIndicator
                    key={`${indicator.id}@${indicator.version}`}
                    client={client}
                    window={window}
                    indicator={indicator}
                  />
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
