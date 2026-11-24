import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { LedgerClient } from '@ledger/contracts/client';
import type { TelemetryResponse, TelemetrySampleView } from '@ledger/contracts';
import { Badge, Button, Notice, Spinner } from '@ledger/ui';
import { age, errorMessage, json, time, timeZoneLabel } from './format.js';
import { coordinateLabel, fitCoordinates, mapFrame, projectCoordinate, type GeographicView } from './geography.js';
import { fidelity, sourceLabel } from './labels.js';
import { SpatialMap } from './SpatialMap.js';
import { lateTelemetrySamples, telemetryTrackEdges } from './telemetry-geometry.js';
import { readFailureOutcome } from './read-failure.js';

type Connection = 'connecting' | 'live' | 'polling' | 'resyncing' | 'access-lost';

const transportLabels: Record<Connection, string> = {
  connecting: 'Connecting live updates',
  live: 'Connected',
  polling: 'Reconnecting · checking every 2 s',
  resyncing: 'Catching up',
  'access-lost': 'Access unavailable · map cleared',
};

const altitudeReferences: Record<TelemetrySampleView['altitudeReference'], string> = {
  unknown: 'Datum unknown',
  relative: 'Relative to source reference',
  ellipsoid: 'Ellipsoidal',
};

const segmentFidelity = fidelity.synthetic_contract;
interface Props {
  client: LedgerClient;
  flightId: string;
  enabled: boolean;
  onInspectReceipt: (id: string) => void;
  onSnapshot: (snapshot: TelemetryResponse | null) => void;
  onReviewMap?: () => void;
}

function useTelemetry(client: LedgerClient, flightId: string, enabled: boolean, reload: number) {
  const [stored, setStored] = useState<{ client: LedgerClient; flightId: string; data: TelemetryResponse } | null>(
    null,
  );
  const [connection, setConnection] = useState<Connection>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [resyncs, setResyncs] = useState(0);
  const data = stored?.client === client && stored.flightId === flightId ? stored.data : null;

  useEffect(() => {
    if (!enabled) return;
    let stopped = false,
      accessLost = false,
      cursor: string | undefined,
      generation = 0;
    const seenNotifications = new Set<string>();
    let watch: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout>;
    let pendingRead: Promise<void> | null = null,
      queuedRead = false;
    const delay = (ms: number) =>
      new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, ms);
        watch?.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timeout);
            resolve();
          },
          { once: true },
        );
      });
    function clearPrivate(message: string) {
      accessLost = true;
      generation++;
      cursor = undefined;
      watch?.abort();
      setStored(null);
      setConnection('access-lost');
      setError(message);
    }
    async function read(): Promise<void> {
      if (stopped || accessLost) return;
      if (pendingRead) {
        queuedRead = true;
        return pendingRead;
      }
      pendingRead = (async () => {
        do {
          queuedRead = false;
          const readGeneration = generation;
          try {
            const snapshot = await client.telemetry(flightId);
            if (stopped || accessLost) return;
            if (readGeneration !== generation) continue;
            if (snapshot.flightId !== flightId) {
              clearPrivate('The telemetry response belongs to a different flight. The cached map was cleared.');
              return;
            }
            setStored({ client, flightId, data: snapshot });
            cursor = snapshot.cursor;
            setError(null);
          } catch (failure) {
            if (stopped || accessLost) return;
            if (readGeneration !== generation) continue;
            if (readFailureOutcome(failure, true) === 'access_lost')
              clearPrivate('Telemetry access is unavailable. The cached map was cleared.');
            else setError(errorMessage(failure));
          }
        } while (queuedRead && !stopped && !accessLost);
      })();
      await pendingRead;
      pendingRead = null;
    }
    async function poll() {
      if (stopped || accessLost) return;
      await read();
      if (!stopped && !accessLost) timer = setTimeout(() => void poll(), 2000);
    }
    async function stream() {
      setConnection('connecting');
      await read();
      while (!stopped && !accessLost) {
        watch = new AbortController();
        try {
          setConnection('connecting');
          for await (const event of client.watchFlight(flightId, {
            cursor,
            signal: watch.signal,
            onOpen: () => {
              if (!stopped && !accessLost) setConnection('live');
            },
          })) {
            if (stopped || accessLost) break;
            if (event.data.flightId !== flightId) {
              clearPrivate('The live update belongs to a different flight. The cached map was cleared.');
              break;
            }
            if (event.event === 'resync_required') {
              cursor = undefined;
              seenNotifications.clear();
              setConnection('resyncing');
              setResyncs((value) => value + 1);
              watch.abort();
              if (event.data.type === 'resync_required' && event.data.reason === 'scope_changed') {
                clearPrivate('Your live access scope changed. The cached map was cleared.');
                break;
              }
              await read();
              break;
            }
            if (event.event === 'stream.closed') {
              if (event.data.type === 'stream.closed' && event.data.reason === 'access_revoked')
                clearPrivate('Your telemetry access was revoked. The cached map was cleared.');
              else {
                generation++;
                cursor = undefined;
                watch.abort();
                setConnection('polling');
                setError(null);
                await read();
              }
              break;
            }
            if (event.data.type === 'telemetry.updated' || event.data.type === 'flight.updated') {
              const notificationId = event.id ?? event.data.cursor;
              if (seenNotifications.has(notificationId)) continue;
              seenNotifications.add(notificationId);
              if (seenNotifications.size > 512) seenNotifications.delete(seenNotifications.values().next().value!);
              cursor = notificationId;
              setConnection('live');
              void read();
            }
          }
        } catch (failure) {
          if (stopped || accessLost) return;
          if (readFailureOutcome(failure, true) === 'access_lost') {
            clearPrivate('Live telemetry access is unavailable. The cached map was cleared.');
            return;
          }
          if (!watch.signal.aborted) setError(`Live updates interrupted. ${errorMessage(failure)}`);
        }
        if (stopped || accessLost) return;
        setConnection('polling');
        await delay(2000);
      }
    }
    void stream();
    timer = setTimeout(() => void poll(), 2000);
    return () => {
      stopped = true;
      watch?.abort();
      clearTimeout(timer);
    };
  }, [client, flightId, enabled, reload]);
  return { data, connection, error, resyncs };
}

export function TelemetryLens({ client, flightId, enabled, onInspectReceipt, onSnapshot, onReviewMap }: Props) {
  const [reload, setReload] = useState(0);
  const { data, connection, error } = useTelemetry(client, flightId, enabled, reload);
  const [view, setView] = useState<GeographicView | null>(null);
  const [selected, setSelected] = useState<TelemetrySampleView | null>(null);
  const [newIds, setNewIds] = useState<Set<string>>(new Set());
  const known = useRef<Set<string> | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ id: string; offset: number } | null>(null);
  const samples = useMemo(
    () =>
      [...(data?.samples ?? [])].sort(
        (a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.sequence - b.sequence || a.id.localeCompare(b.id),
      ),
    [data],
  );
  useEffect(() => {
    onSnapshot(data);
  }, [data, onSnapshot]);
  const late = useMemo(() => lateTelemetrySamples(samples), [samples]);
  const edges = useMemo(() => telemetryTrackEdges(samples), [samples]);
  useEffect(() => {
    if (!data) {
      setView(null);
      setSelected(null);
      known.current = null;
      setNewIds(new Set());
      return;
    }
    if (known.current)
      setNewIds(
        (previous) =>
          new Set(
            [...previous]
              .filter((id) => data.samples.some((sample) => sample.id === id))
              .concat(data.samples.filter((sample) => !known.current!.has(sample.id)).map((sample) => sample.id)),
          ),
      );
    known.current = new Set(data.samples.map((sample) => sample.id));
    setSelected(
      (previous) => data.samples.find((sample) => sample.id === previous?.id) ?? previous ?? samples.at(-1) ?? null,
    );
    setView((previous) => previous ?? fitCoordinates(data.samples));
  }, [data, samples]);
  useLayoutEffect(() => {
    if (!anchor.current || !list.current) return;
    const row = Array.from(list.current.querySelectorAll<HTMLElement>('[data-sample-id]')).find(
      (item) => item.dataset.sampleId === anchor.current!.id,
    );
    if (row)
      list.current.scrollTop +=
        row.getBoundingClientRect().top - list.current.getBoundingClientRect().top - anchor.current.offset;
  }, [samples]);
  const outside = view ? samples.filter((sample) => !projectCoordinate(sample, view).inside).length : 0;
  const pendingSegments =
    data?.segments.filter((segment) => ['pending', 'processing'].includes(segment.processing.status)) ?? [];
  const failedSegments = data?.segments.filter((segment) => segment.processing.status === 'failed') ?? [];
  const selectedRetained = Boolean(selected && !samples.some((sample) => sample.id === selected.id));
  const first = samples[0]?.occurredAt,
    last = samples.at(-1)?.occurredAt;
  return (
    <section
      className="telemetry-lens"
      data-testid="telemetry-lens"
      aria-label="Flight telemetry map"
      hidden={!enabled}
    >
      <div className="telemetry-heading">
        <div>
          <h3>
            Observed track
            <Badge tone={segmentFidelity.tone} title={segmentFidelity.description}>
              {segmentFidelity.label}
            </Badge>
          </h3>
          <p>Recorded positions only. Segments still processing are not plotted.</p>
        </div>
        <Button
          onClick={() => {
            setView(fitCoordinates(samples));
            setNewIds(new Set());
          }}
          disabled={!samples.length}
        >
          Fit observed track
        </Button>
      </div>
      {error && (
        <Notice
          tone={connection === 'access-lost' ? 'alert' : 'attention'}
          title={connection === 'access-lost' ? 'Private map cleared' : 'Telemetry updates interrupted'}
        >
          {error}
          {connection !== 'access-lost' && data && (
            <p>The last scoped snapshot remains visible. Fresh snapshots are checked every two seconds.</p>
          )}
          <Button kind="quiet" onClick={() => setReload((value) => value + 1)}>
            Retry telemetry
          </Button>
        </Notice>
      )}
      {newIds.size > 0 && (
        <p className="telemetry-arrivals" role="status">
          <strong>
            {newIds.size} new sample{newIds.size === 1 ? '' : 's'}
          </strong>{' '}
          · selection and map extent kept. <button onClick={() => setNewIds(new Set())}>Mark reviewed</button>
        </p>
      )}
      <div className="telemetry-card">
        <div className="telemetry-transport" data-testid="telemetry-transport">
          <span>
            <i className={`connection-dot ${connection === 'live' ? '' : 'connection-dot--error'}`} />
            {transportLabels[connection]}
          </span>
          <span>{data ? `Snapshot ${time(data.meta.computedAt)} ${timeZoneLabel()}` : 'Awaiting snapshot'}</span>
        </div>
        {samples.length && view ? (
          <SpatialMap
            label={`North-up WGS84 coordinate plot of ${samples.length} recorded samples. Capture gaps and source-time regressions are not interpolated.`}
            className="telemetry-map"
            testId="telemetry-spatial-map"
            canvasTestId="telemetry-coordinate-map"
            coordinateGrid
            frame={mapFrame}
            view={view}
            onView={setView}
            lines={edges.map(({ from, to }) => ({
              id: `${from.id}:${to.id}`,
              label: `${sourceLabel(from.sourceId)} · captures ${from.sequence}–${to.sequence}`,
              kind: 'observed',
              points: [from, to],
              className: 'telemetry-track',
              sampleIds: [from.id, to.id],
            }))}
            points={samples.map((sample) => ({
              id: sample.id,
              label: `${sourceLabel(sample.sourceId)} · capture ${sample.sequence} · ${coordinateLabel(sample.latitude, 'latitude')} / ${coordinateLabel(sample.longitude, 'longitude')}`,
              position: sample,
              kind: 'sample',
              selected: sample.id === selected?.id,
              late: late.has(sample.id),
              onSelect: () => setSelected(sample),
            }))}
          />
        ) : (
          <figure className="telemetry-map">
            <div className="map-empty">
              {!data && connection !== 'access-lost' && !error ? (
                <Spinner label="Loading telemetry" />
              ) : (
                <>
                  <strong>
                    {connection === 'access-lost' ? 'Telemetry is unavailable in this scope' : 'No positions recorded'}
                  </strong>
                  <p>
                    {pendingSegments.length
                      ? `${pendingSegments.length} segment${pendingSegments.length === 1 ? ' is' : 's are'} still processing. Positions appear once recorded.`
                      : 'Positions appear here once a telemetry segment is recorded.'}
                  </p>
                </>
              )}
            </div>
            <figcaption>WGS84 horizontal · north up · coordinate grid only</figcaption>
          </figure>
        )}
        <div className="telemetry-summary">
          <span>
            <strong>{samples.length}</strong>samples
          </span>
          <span>
            <strong>{pendingSegments.length}</strong>processing
          </span>
          <span>
            <strong>{data?.gaps.length ?? 0}</strong>capture gaps
          </span>
          <span className={late.size ? 'is-late' : undefined}>
            <strong>{late.size}</strong>received out of order
          </span>
          <span>
            <strong>{samples.filter((sample) => sample.conflict).length}</strong>conflicting samples
          </span>
        </div>
        <div className="telemetry-legend">
          <span>
            <i className="track" />
            Observed track
          </span>
          <span>
            <i className="late" />
            Received out of order
          </span>
          <span>
            <i className="selected" />
            Selected
          </span>
          <span>Lines break at capture gaps</span>
        </div>
        {outside > 0 && (
          <p className="telemetry-outside">
            {outside} sample{outside === 1 ? ' is' : 's are'} outside the retained map extent. Fit observed track to
            include {outside === 1 ? 'it' : 'them'}.
          </p>
        )}
      </div>
      {first && last && (
        <p className="telemetry-window">
          Happened {time(first, true)}–{time(last, true)} {timeZoneLabel()}
          {data?.window.truncated && ' · earlier telemetry is outside this window'}
        </p>
      )}
      {failedSegments.map((segment) => (
        <Notice key={segment.id} tone="attention" title="A telemetry segment failed to process">
          Received {time(segment.receivedAt, true)} {timeZoneLabel()} ·{' '}
          {segment.processing.error ?? 'The failure is kept on the receipt.'}
          <Button kind="quiet" onClick={() => onInspectReceipt(segment.receiptId)}>
            Inspect receipt
          </Button>
        </Notice>
      ))}
      {selected && (
        <section
          className="telemetry-detail"
          data-testid="telemetry-sample-inspector"
          aria-label="Selected telemetry sample"
        >
          <div className="telemetry-detail-heading">
            <h4>Capture {selected.sequence}</h4>
            <Badge tone={selected.conflict ? 'attention' : 'observed'}>
              {selected.conflict ? 'Conflicting claim' : 'Recorded'}
            </Badge>
          </div>
          {selectedRetained && (
            <p className="telemetry-window">Outside the current snapshot window. Its details stay pinned.</p>
          )}
          <dl className="inspection-facts">
            <div>
              <dt>Latitude</dt>
              <dd>{coordinateLabel(selected.latitude, 'latitude', 6)}</dd>
            </div>
            <div>
              <dt>Longitude</dt>
              <dd>{coordinateLabel(selected.longitude, 'longitude', 6)}</dd>
            </div>
            <div>
              <dt>Altitude</dt>
              <dd>
                {selected.altitudeMeters === null ? 'Not reported' : `${selected.altitudeMeters} m`} ·{' '}
                {altitudeReferences[selected.altitudeReference]}
              </dd>
            </div>
            <div>
              <dt>Happened</dt>
              <dd>
                <time dateTime={selected.occurredAt}>{time(selected.occurredAt, true)}</time> {timeZoneLabel()}
              </dd>
            </div>
            <div>
              <dt>Ledger received it</dt>
              <dd>
                <time dateTime={selected.receivedAt}>{time(selected.receivedAt, true)}</time> {timeZoneLabel()}
              </dd>
            </div>
            <div>
              <dt>Reported speed</dt>
              <dd>
                {selected.speedMetersPerSecond === undefined
                  ? 'Not reported'
                  : `${Number(selected.speedMetersPerSecond.toFixed(1))} m/s`}
              </dd>
            </div>
            <div>
              <dt>Source</dt>
              <dd>{sourceLabel(selected.sourceId)}</dd>
            </div>
          </dl>
          <div className="telemetry-review-actions">
            <Button kind="quiet" onClick={() => onInspectReceipt(selected.receiptId)}>
              Inspect segment receipt
            </Button>
            {onReviewMap && (
              <Button kind="primary" data-testid="review-map" onClick={onReviewMap}>
                Review this map
              </Button>
            )}
          </div>
          {onReviewMap && <p className="telemetry-window">A review pins the map exactly as displayed.</p>}
          <details className="telemetry-limitations">
            <summary>Sample provenance</summary>
            <pre>
              {json({
                id: selected.id,
                sourceId: selected.sourceId,
                deviceId: selected.deviceId,
                captureSessionId: selected.sourceSessionId,
                sequenceBasis: 'adapter_capture',
                sequence: selected.sequence,
                segmentId: selected.segmentId,
                receiptId: selected.receiptId,
                eventId: selected.eventId,
                artifactId: selected.artifactId,
                originalSha256: selected.originalSha256,
                originalTopic: selected.original.topic,
                sampleOffset: selected.sampleOffset,
              })}
            </pre>
          </details>
        </section>
      )}
      {samples.length > 0 && (
        <div
          className="telemetry-samples"
          data-testid="telemetry-samples"
          ref={list}
          onScroll={() => {
            const element = list.current;
            if (!element) return;
            const row = Array.from(element.querySelectorAll<HTMLElement>('[data-sample-id]')).find(
              (item) => item.getBoundingClientRect().bottom > element.getBoundingClientRect().top,
            );
            if (row)
              anchor.current = {
                id: row.dataset.sampleId!,
                offset: row.getBoundingClientRect().top - element.getBoundingClientRect().top,
              };
          }}
          aria-label="Recorded samples"
        >
          {samples.map((sample) => (
            <button
              key={sample.id}
              className={`telemetry-sample ${selected?.id === sample.id ? 'is-selected' : ''}`}
              data-sample-id={sample.id}
              data-testid={`telemetry-sample-${sample.id}`}
              aria-pressed={selected?.id === sample.id}
              onClick={() => setSelected(sample)}
            >
              <span>
                Capture {sample.sequence}
                <small>
                  {sourceLabel(sample.sourceId)}
                  {sample.conflict && ' · conflicting claim'}
                </small>
              </span>
              <span>
                {time(sample.occurredAt)}
                <small>Happened</small>
              </span>
              <span className={late.has(sample.id) ? 'sample-late' : undefined}>
                {time(sample.receivedAt)}
                <small>{late.has(sample.id) ? 'Received out of order' : 'Received'}</small>
              </span>
            </button>
          ))}
        </div>
      )}
      {data && (
        <section className="telemetry-detail" aria-label="Telemetry source health">
          <h4>Sources</h4>
          {data.sessions.map((session) => (
            <div className="telemetry-source" key={session.id}>
              <div className="telemetry-source-heading">
                <strong>{sourceLabel(session.sourceId)}</strong>
                <Badge tone={session.conflictCount || session.gapCount ? 'attention' : 'neutral'}>
                  {session.conflictCount
                    ? `${session.conflictCount} conflicts`
                    : session.gapCount
                      ? `${session.gapCount} capture gaps`
                      : 'No capture gap'}
                </Badge>
              </div>
              <p>
                Last received {age(session.lastReceivedAt)} · {time(session.lastReceivedAt, true)} {timeZoneLabel()} ·
                up to capture {session.highestSequence}
              </p>
              <p>
                {session.missingSequenceCount} missing · {session.duplicateCount} duplicate captures
              </p>
            </div>
          ))}
          <details className="telemetry-limitations">
            <summary>Capture sessions and gap ranges</summary>
            <pre>
              {json({
                sessions: data.sessions.map((session) => ({
                  sourceId: session.sourceId,
                  deviceId: session.deviceId,
                  captureSessionId: session.sourceSessionId,
                })),
                gaps: data.gaps,
              })}
            </pre>
          </details>
        </section>
      )}
      <details className="telemetry-limitations">
        <summary>What this map does not show</summary>
        <ul>
          <li>Only recorded samples are plotted. There are no provisional live positions.</li>
          <li>
            The coordinate grid is a local display approximation. It gives no terrain, airspace, obstacle, navigation,
            or clearance assessment.
          </li>
          <li>
            Altitude is as the source reported it. Unknown and relative references are kept; no AGL or MSL conversion is
            inferred.
          </li>
          <li>
            Tracks are separated by source, capture session and device. Lines break at missing captures, conflicting
            samples and reversed occurrence time.
          </li>
          <li>
            Capture order describes the adapter session. It does not establish vehicle-message loss or completeness.
          </li>
          <li>Source health covers receipt freshness and capture integrity. The aircraft link’s health is unknown.</li>
          {data && (
            <li>
              Out-of-order receipt is judged per track within this snapshot window (up to {data.window.sampleLimit}{' '}
              samples, {data.window.sessionLimit} sessions, {data.window.segmentLimit} segments and{' '}
              {data.window.gapLimit} gaps). The window does not prove full flight coverage.
            </li>
          )}
        </ul>
      </details>
    </section>
  );
}
