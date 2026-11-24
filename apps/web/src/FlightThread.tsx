import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ApiError, LedgerClient } from '@ledger/contracts/client';
import type {
  DecisionRecord,
  FlightSummary,
  HistoryPage,
  OrderListResponse,
  Principal,
  Receipt,
  SourceCapability,
  TelemetryResponse,
  TimelineItem,
  TimelineResponse,
} from '@ledger/contracts';
import { Badge, Button, Notice } from '@ledger/ui';
import { age, errorMessage, time, timeZoneLabel } from './format.js';
import {
  activityPresentation,
  aircraftLabel,
  attentionReasons,
  coveragePresentation,
  nextStep,
  ownershipLine,
  highlightHeading,
  kindLabel,
  linkStatus,
  orderSummary,
  reportedFlightTimes,
  sourceLabel,
  threadHighlights,
} from './labels.js';
import { sortItems, type Axis } from './record.js';
import { EvidenceInspector } from './EvidenceInspector.js';
import { ActionPanel, type ActionPanelHandle } from './ActionPanel.js';
import { TelemetryLens } from './TelemetryLens.js';
import { operationDisplay } from './operation-display.js';
import { RecordTimeline } from './RecordTimeline.js';
import { FlightRail } from './FlightRail.js';
import { FindingsPanel, type FindingEvidenceTarget } from './FindingsPanel.js';
import { SubjectFindings } from './SubjectFindings.js';
import { FlightWindows } from './FlightWindows.js';
import { FlightPredeparturePanel } from './FlightPredeparturePanel.js';
import type { FlightFinding } from './safety-navigation.js';
import type { DecisionPacketRequests } from './decision-packet-requests.js';
import { readFailureOutcome } from './read-failure.js';

interface Props {
  active: boolean;
  client: LedgerClient;
  cacheScope: string;
  selected: FlightSummary;
  crumb?: string;
  principal: Principal | null;
  packetRequests: DecisionPacketRequests;
  unresolved: Receipt[];
  receiptPage: HistoryPage | null;
  onOlderReceipts: () => void;
  onLatestReceipts: () => void;
  capabilities: SourceCapability[];
  showUnresolved: boolean;
  onSafety?: (finding: FlightFinding) => void;
  focusedFinding?: { id: string; sequence: number };
  onMission: (releaseId?: string, briefingId?: string) => void;
  focusedRecord?: { id: string; sequence: number };
}

export function FlightThread({
  active,
  client,
  cacheScope,
  selected,
  crumb,
  principal,
  packetRequests,
  unresolved,
  receiptPage,
  onOlderReceipts,
  onLatestReceipts,
  capabilities,
  showUnresolved,
  onSafety,
  focusedFinding,
  onMission,
  focusedRecord,
}: Props) {
  const [data, setData] = useState<TimelineResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [axis, setAxis] = useState<Axis>('occurredAt');
  const [lens, setLens] = useState<'record' | 'telemetry'>('record');
  const [mapSnapshot, setMapSnapshot] = useState<{ scope: string; value: TelemetryResponse | null } | null>(null);
  const receiveMapSnapshot = useCallback(
    (value: TelemetryResponse | null) => setMapSnapshot({ scope: cacheScope, value }),
    [cacheScope],
  );
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [newIds, setNewIds] = useState<Set<string>>(new Set());
  const [reload, setReload] = useState(0);
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const [revealRecord, setRevealRecord] = useState<{ id: string; sequence: number }>();
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const [olderItems, setOlderItems] = useState<{ items: TimelineItem[]; page: HistoryPage } | null>(null);
  const [olderDecisions, setOlderDecisions] = useState<{ decisions: DecisionRecord[]; page: HistoryPage } | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [orderCursor, setOrderCursor] = useState<string | undefined>();
  const [orderPage, setOrderPage] = useState<OrderListResponse | null>(null);
  const [orderError, setOrderError] = useState<string | null>(null);
  const currentSelection = useRef<string | null>(null);
  const retainedItem = useRef<TimelineItem | null>(null);
  const retainedDecision = useRef<DecisionRecord | null>(null);
  const anchorItem = useRef<TimelineItem | null>(null);
  const renderedItems = useRef<TimelineItem[]>([]);
  const activeHistory = useRef(true);
  const scroller = useRef<HTMLDivElement>(null);
  const knownIds = useRef<Set<string> | null>(null);
  const scrollAnchor = useRef<{ id: string; offset: number } | null>(null);
  const actions = useRef<ActionPanelHandle>(null);
  const revealSequence = useRef(0);
  const pendingReveal = useRef<{
    id: string;
    sequence: number;
    receiptId?: string;
    previousItemId: string | null;
    previousReceiptId: string | null;
  } | null>(null);
  const reviewMap = useCallback(() => actions.current?.reviewMap(), []);

  function clearPrivateHistory() {
    setData(null);
    setOlderItems(null);
    setOlderDecisions(null);
    setOrderPage(null);
    setOrderCursor(undefined);
    setSelectedItemId(null);
    setReceiptId(null);
    setRevealRecord(undefined);
    setEvidenceError(null);
    pendingReveal.current = null;
    setNewIds(new Set());
    retainedItem.current = null;
    retainedDecision.current = null;
    anchorItem.current = null;
    knownIds.current = null;
    scrollAnchor.current = null;
  }

  function captureTimelineAnchor() {
    if (pendingReveal.current) return;
    const element = scroller.current;
    if (!element || element.scrollTop <= 0 || !element.getClientRects().length) return;
    const top = element.getBoundingClientRect().top;
    const headerHeight = element.querySelector('.timeline-lanes')?.getBoundingClientRect().height ?? 0;
    const firstVisible = Array.from(element.querySelectorAll<HTMLElement>('[data-anchor-id]')).find(
      (item) => item.getBoundingClientRect().bottom > top + headerHeight,
    );
    if (firstVisible) {
      scrollAnchor.current = {
        id: firstVisible.dataset.anchorId!,
        offset: firstVisible.getBoundingClientRect().top - top,
      };
      anchorItem.current = renderedItems.current.find((item) => item.id === firstVisible.dataset.anchorId) ?? null;
    }
  }

  useEffect(() => {
    activeHistory.current = active;
    if (!active) setHistoryBusy(false);
    return () => {
      activeHistory.current = false;
    };
  }, [active]);
  useEffect(() => {
    if (!active) return;
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    async function pollOrders() {
      try {
        const response = await client.orders({
          flightId: selected.id,
          limit: 100,
          ...(orderCursor ? { cursor: orderCursor } : {}),
        });
        if (!stopped) {
          setOrderPage(response);
          setOrderError(null);
        }
      } catch (failure) {
        if (!stopped) {
          if (
            failure instanceof ApiError &&
            failure.status === 400 &&
            (failure.body as { error?: { code?: string } })?.error?.code === 'cursor_scope_mismatch'
          )
            setOrderCursor(undefined);
          else {
            if (readFailureOutcome(failure, true) === 'access_lost') clearPrivateHistory();
            setOrderError(errorMessage(failure));
          }
        }
      }
      if (!stopped) timer = setTimeout(() => void pollOrders(), 2000);
    }
    void pollOrders();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [client, selected.id, orderCursor, active]);

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const requestedReveal = pendingReveal.current;
      try {
        const response = await client.timeline(selected.id, { selectedItemId: currentSelection.current ?? undefined });
        if (stopped) return;
        captureTimelineAnchor();
        let mismatchedEvidence = false;
        if (requestedReveal && pendingReveal.current?.sequence === requestedReveal.sequence) {
          pendingReveal.current = null;
          const evidence =
            response.selectedItem?.id === requestedReveal.id
              ? response.selectedItem
              : response.items.find((item) => item.id === requestedReveal.id);
          if (!evidence) setEvidenceError('The requested evidence record is unavailable in this flight’s timeline.');
          else if (requestedReveal.receiptId && evidence.receiptId !== requestedReveal.receiptId) {
            mismatchedEvidence = true;
            setSelectedItemId(requestedReveal.previousItemId);
            setReceiptId(requestedReveal.previousReceiptId);
            setRevealRecord(undefined);
            setEvidenceError('The requested event and receipt do not match the retained evidence reference.');
          }
        }
        if (!mismatchedEvidence) {
          const nextIds = new Set(response.items.map((item) => item.id));
          const previousIds = knownIds.current;
          if (previousIds) {
            const arrivals = response.items.filter((item) => !previousIds.has(item.id)).map((item) => item.id);
            setNewIds((previous) => new Set([...previous].filter((id) => nextIds.has(id)).concat(arrivals)));
          }
          knownIds.current = nextIds;
          setData(response);
          setSelectedItemId(
            (previous) => previous ?? response.decisions.at(-1)?.id ?? response.items.at(-1)?.id ?? null,
          );
        }
        setError(null);
      } catch (failure) {
        if (!stopped) {
          if (requestedReveal && pendingReveal.current?.sequence === requestedReveal.sequence) {
            pendingReveal.current = null;
            setEvidenceError('The evidence record could not be loaded. Retry its evidence link.');
          }
          if (readFailureOutcome(failure, true) === 'access_lost') clearPrivateHistory();
          setError(errorMessage(failure));
        }
      }
      if (!stopped) timer = setTimeout(() => void poll(), 2000);
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [client, selected.id, reload, active]);

  useLayoutEffect(() => {
    if (lens !== 'record') return;
    const anchor = scrollAnchor.current;
    const element = scroller.current;
    if (anchor && element) {
      const row = Array.from(element.querySelectorAll<HTMLElement>('[data-anchor-id]')).find(
        (item) => item.dataset.anchorId === anchor.id,
      );
      if (row)
        element.scrollTop += row.getBoundingClientRect().top - element.getBoundingClientRect().top - anchor.offset;
    }
    scrollAnchor.current = null;
  }, [data, lens, olderItems, olderDecisions]);

  const visibleData = useMemo(() => {
    if (!data) return null;
    const items = new Map<string, TimelineItem>(),
      decisions = new Map<string, DecisionRecord>();
    for (const item of [
      anchorItem.current,
      retainedItem.current,
      ...(olderItems?.items ?? []),
      data.selectedItem,
      ...data.items,
    ])
      if (item) items.set(item.id, item);
    for (const decision of [
      retainedDecision.current,
      ...(olderDecisions?.decisions ?? []),
      data.selectedDecision,
      ...data.decisions,
    ])
      if (decision) decisions.set(decision.id, decision);
    return {
      ...data,
      items: [...items.values()],
      decisions: [...decisions.values()].sort(
        (a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id),
      ),
    };
  }, [data, olderItems, olderDecisions]);
  const sortedItems = useMemo(() => sortItems(visibleData?.items ?? [], axis), [visibleData, axis]);
  const flight = data?.flight ?? selected;
  const flightActivity = activityPresentation(flight);
  const operation = operationDisplay(flight);
  const highlights = useMemo(() => threadHighlights(visibleData?.items ?? [], flight), [visibleData, flight]);
  renderedItems.current = sortedItems;
  currentSelection.current = selectedItemId;
  const reasons = attentionReasons(flight);
  const summaryHighlights =
    highlights.length || flight.findingSummary
      ? highlights
      : reasons.map((text) => ({ tone: 'attention' as const, text }));
  const heading = highlightHeading(summaryHighlights, flight);
  const recordState = coveragePresentation(flight);
  const item = visibleData?.items.find((candidate) => candidate.id === selectedItemId) ?? null;
  const selectedDecision = visibleData?.decisions.find((decision) => decision.id === selectedItemId) ?? null;
  const pinnedDecision =
    visibleData?.decisions.find((decision) => decision.id === selectedItemId) ?? data?.decisions.at(-1) ?? null;
  const receiptItem = receiptId
    ? (visibleData?.items.find((candidate) => candidate.receiptId === receiptId) ?? null)
    : null;
  const inspectedId = receiptId ? (receiptItem?.id ?? null) : (item?.id ?? selectedDecision?.id ?? null);
  const refreshed = () => setReload((previous) => previous + 1);
  const activeMap = mapSnapshot?.scope === cacheScope ? mapSnapshot.value : null;
  const mapConsistent = Boolean(
    activeMap &&
    data &&
    activeMap.flightId === selected.id &&
    activeMap.flightRevision === data.flight.revision &&
    activeMap.meta.inputCut.basisRevision === data.flight.basisRevision &&
    activeMap.meta.dependencyBasis === data.meta.dependencyBasis &&
    activeMap.meta.inputCut.principalRevision === data.meta.inputCut.principalRevision,
  );
  const mapBasis =
    activeMap && activeMap.meta.inputCut.basisRevision !== undefined
      ? {
          revision: activeMap.flightRevision,
          basisRevision: activeMap.meta.inputCut.basisRevision,
          inputCut: activeMap.meta.inputCut,
          dependencyBasis: activeMap.meta.dependencyBasis,
        }
      : undefined;
  const reported = reportedFlightTimes(visibleData?.items ?? [], flight);

  function selectRecord(id: string) {
    if (pendingReveal.current?.id !== id) pendingReveal.current = null;
    if (revealRecord?.id !== id) setRevealRecord(undefined);
    setEvidenceError(null);
    retainedItem.current = visibleData?.items.find((candidate) => candidate.id === id) ?? null;
    retainedDecision.current = visibleData?.decisions.find((candidate) => candidate.id === id) ?? null;
    setSelectedItemId(id);
    setReceiptId(null);
  }
  function revealEvidence(target: FindingEvidenceTarget) {
    const suffix = `:${selected.id}`;
    const eventId = target.eventId.endsWith(suffix) ? target.eventId.slice(0, -suffix.length) : target.eventId;
    const loaded = visibleData?.items.find((candidate) => candidate.id === target.eventId || candidate.id === eventId);
    const receiptMatch = target.receiptId
      ? visibleData?.items.find((candidate) => candidate.receiptId === target.receiptId)
      : undefined;
    if (
      (loaded && target.receiptId && loaded.receiptId !== target.receiptId) ||
      (receiptMatch && receiptMatch.id !== target.eventId && receiptMatch.id !== eventId)
    ) {
      setEvidenceError('The requested event and receipt do not match the retained evidence reference.');
      setLens('record');
      return;
    }
    const id = loaded?.id ?? eventId;
    const previousItemId = selectedItemId;
    const previousReceiptId = receiptId;
    selectRecord(id);
    const request = { id, sequence: ++revealSequence.current };
    pendingReveal.current = { ...request, receiptId: target.receiptId, previousItemId, previousReceiptId };
    scrollAnchor.current = null;
    setRevealRecord(request);
    setReceiptId(target.receiptId || null);
    setLens('record');
    setReload((previous) => previous + 1);
  }
  useEffect(() => {
    if (!focusedRecord) return;
    revealEvidence({ eventId: focusedRecord.id });
  }, [focusedRecord]);
  async function loadOlder(kind: 'items' | 'decisions') {
    if (!data || historyBusy) return;
    const page =
      kind === 'items' ? (olderItems?.page ?? data.window.items) : (olderDecisions?.page ?? data.window.decisions);
    if (!page.nextCursor) return;
    setHistoryBusy(true);
    setHistoryError(null);
    try {
      const response = await client.timeline(selected.id, {
        ...(kind === 'items' ? { cursor: page.nextCursor } : { decisionCursor: page.nextCursor }),
        selectedItemId: currentSelection.current ?? undefined,
      });
      if (!activeHistory.current) return;
      const receivedPage = response.window[kind];
      if (receivedPage.nextCursor === page.nextCursor)
        throw new Error('History did not advance. The displayed records are retained.');
      captureTimelineAnchor();
      if (response.selectedItem) retainedItem.current = response.selectedItem;
      if (response.selectedDecision) retainedDecision.current = response.selectedDecision;
      if (kind === 'items') setOlderItems({ items: response.items, page: receivedPage });
      else setOlderDecisions({ decisions: response.decisions, page: receivedPage });
    } catch (failure) {
      if (activeHistory.current) {
        if (
          failure instanceof ApiError &&
          failure.status === 400 &&
          (failure.body as { error?: { code?: string } })?.error?.code === 'cursor_scope_mismatch'
        ) {
          clearPrivateHistory();
          setReload((previous) => previous + 1);
          setHistoryError('History authority changed. Start from the refreshed recent window.');
        } else {
          if (readFailureOutcome(failure, true) === 'access_lost') clearPrivateHistory();
          setHistoryError(errorMessage(failure));
        }
      }
    } finally {
      if (activeHistory.current) setHistoryBusy(false);
    }
  }

  function viewArrivals() {
    const latest = sortedItems.filter((candidate) => newIds.has(candidate.id)).at(-1);
    if (latest) {
      selectRecord(latest.id);
      requestAnimationFrame(() => {
        const row = Array.from(scroller.current?.querySelectorAll<HTMLElement>('[data-anchor-id]') ?? []).find(
          (candidate) => candidate.dataset.anchorId === latest.id,
        );
        row?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
      });
    }
    setNewIds(new Set());
  }

  const inspector = (item || receiptId || selectedDecision) && (
    <EvidenceInspector
      key={receiptId ?? item?.id ?? selectedDecision?.id}
      client={client}
      active={active && lens === 'record'}
      item={receiptId ? receiptItem : item}
      receiptId={receiptId ?? item?.receiptId ?? null}
      data={visibleData}
      decision={receiptId ? null : selectedDecision}
      principal={principal}
      packetRequests={packetRequests}
      capabilities={capabilities}
      onChanged={refreshed}
      onMission={onMission}
    />
  );
  const receiptOutsideFlight = Boolean(receiptId && !receiptItem);

  return (
    <div className="thread-layout">
      <div ref={scroller} className="thread-main" data-testid="timeline-scroll" tabIndex={0} aria-label="Flight record">
        <header className="thread-header">
          {crumb && <p className="thread-crumbs">Flights / {crumb}</p>}
          <div className="thread-title">
            <h2>{flight.label}</h2>
            <div className="thread-badges">
              <Badge tone={flightActivity.tone} title={flightActivity.detail ?? undefined}>
                {flightActivity.label}
              </Badge>
              <Badge tone={recordState.tone}>{recordState.label}</Badge>
            </div>
            {recordState.detail && <p className="thread-coverage">{recordState.detail}</p>}
            {flightActivity.detail && (
              <p className="thread-coverage">
                {flightActivity.detail}
                {flightActivity.observedAt ? ` Last observation ${age(flightActivity.observedAt)}.` : ''}
              </p>
            )}
          </div>
          {flight.operation && (
            <p className="thread-coverage" data-testid="flight-operation-context">
              {operation.reason} · checked {time(flight.operation.asOf, true)} {timeZoneLabel()}
            </p>
          )}
          <p className="thread-facts">
            <strong>{aircraftLabel(flight.aircraft)}</strong>
            <span>{orderSummary(flight, orderPage?.orders ?? [])}</span>
            {reported.departedAt && (
              <span>
                Departure reported <b className="mono">{time(reported.departedAt, true)}</b> {timeZoneLabel()}
              </span>
            )}
            {reported.landings.length > 0 && (
              <span>
                {reported.landings.length > 1 ? 'Landing reports in view' : 'Landing reported'}{' '}
                <b className="mono">
                  {reported.landings
                    .slice(0, 2)
                    .map((value) => time(value, true))
                    .join(' / ')}
                </b>{' '}
                {timeZoneLabel()}
                {reported.landings.length > 2 && ` · ${reported.landings.length - 2} more times in view`}
              </span>
            )}
            <span>
              {visibleData ? `${visibleData.items.length} records · ` : ''}last received{' '}
              <b className="mono">{age(flight.lastReceivedAt)}</b>
            </span>
          </p>
          <FlightWindows key={cacheScope} client={client} flight={flight} active={active} />
          <FlightPredeparturePanel
            active={active}
            client={client}
            flightId={flight.id}
            onReviewRoute={() => onMission()}
          />
          <Button kind="next" onClick={() => onMission()}>
            Review mission route <span aria-hidden="true">→</span>
          </Button>
        </header>
        {error && (
          <Notice tone="alert" title="Flight updates interrupted">
            {error} The last received record stays on screen.
          </Notice>
        )}
        {summaryHighlights.length > 0 && (
          <section className={`attention attention--${heading.tone}`} aria-label={heading.label}>
            <h3>
              {heading.label} · {summaryHighlights.length}
            </h3>
            <p className="attention-owner">
              {flight.findingSummary
                ? 'These signals come from the flight record. Recorded findings have their own owner and treatment.'
                : ownershipLine(flight)}
            </p>
            <ul>
              {summaryHighlights.map((highlight) => (
                <li key={highlight.text} className={`attention-line attention-line--${highlight.tone}`}>
                  <i aria-hidden="true" />
                  {highlight.text}
                </li>
              ))}
            </ul>
          </section>
        )}
        {showUnresolved && (
          <section className="unresolved-receipts" aria-label="Unlinked evidence receipts">
            <div className="history-navigation">
              <p>
                {receiptPage?.selection === 'continuation' ? 'Older unlinked inputs' : 'Recent unlinked inputs'} ·{' '}
                {unresolved.length} shown{receiptPage?.hasMore ? ' · more available' : ''}
              </p>
              <div>
                {receiptPage?.selection === 'continuation' && (
                  <Button kind="quiet" onClick={onLatestReceipts}>
                    Latest unlinked receipts
                  </Button>
                )}
                <Button kind="quiet" disabled={!receiptPage?.nextCursor} onClick={onOlderReceipts}>
                  Older unlinked receipts
                </Button>
              </div>
            </div>
            {unresolved.length === 0 ? (
              <p className="muted">Nothing is waiting for a flight.</p>
            ) : (
              unresolved.map((receipt) => (
                <button
                  key={receipt.id}
                  data-testid={`unresolved-receipt-${receipt.id}`}
                  onClick={() => setReceiptId(receipt.id)}
                  aria-pressed={receiptId === receipt.id}
                  className="unresolved-receipt"
                >
                  <span>
                    <strong>{kindLabel(receipt.kind)}</strong>
                    <small>{sourceLabel(receipt.sourceId)}</small>
                  </span>
                  <span className="mono">{time(receipt.receivedAt)}</span>
                  <Badge tone={linkStatus[receipt.linkStatus].tone}>{linkStatus[receipt.linkStatus].label}</Badge>
                </button>
              ))
            )}
            {receiptOutsideFlight && inspector}
          </section>
        )}
        {!showUnresolved && receiptOutsideFlight && inspector}
        <div className="thread-tabs">
          <button className="thread-tab" aria-pressed={lens === 'record'} onClick={() => setLens('record')}>
            Record
            <span className="tab-count" aria-hidden="true">
              {visibleData?.items.length ?? ''}
            </span>
          </button>
          <button
            className="thread-tab"
            aria-pressed={lens === 'telemetry'}
            onClick={() => {
              captureTimelineAnchor();
              setLens('telemetry');
            }}
          >
            <i className="map-swatch" aria-hidden="true" />
            Map
          </button>
          <span className="thread-tabs-spacer" />
          {data && (
            <span className="viewing-as-of">
              Viewing as of <b className="mono">{time(data.meta.computedAt)}</b>
            </span>
          )}
          <fieldset className="axis-toggle" hidden={lens !== 'record'}>
            <legend className="sr-only">Order the record by</legend>
            <span className="axis-label" aria-hidden="true">
              Order by
            </span>
            <button aria-pressed={axis === 'occurredAt'} onClick={() => setAxis('occurredAt')}>
              When it happened
            </button>
            <button aria-pressed={axis === 'receivedAt'} onClick={() => setAxis('receivedAt')}>
              When we learned it
            </button>
          </fieldset>
        </div>
        <TelemetryLens
          key={cacheScope}
          client={client}
          flightId={selected.id}
          enabled={active && lens === 'telemetry'}
          onSnapshot={receiveMapSnapshot}
          onInspectReceipt={(id) => {
            setReceiptId(id);
            setLens('record');
          }}
          onReviewMap={data?.availableCommands.includes('decision:write') ? reviewMap : undefined}
        />
        <section className="record-section" aria-label="Flight record" hidden={lens !== 'record'}>
          {data && (
            <div className="history-navigation" data-testid="timeline-history">
              <p>
                Latest {data.window.items.returned} records
                {olderItems ? ` and ${olderItems.items.length} older` : ''}
                {data.window.items.hasMore || olderItems ? ' · earlier history may be omitted' : ''}
              </p>
              <div>
                {olderItems && (
                  <Button
                    kind="quiet"
                    onClick={() => {
                      captureTimelineAnchor();
                      setOlderItems(null);
                    }}
                  >
                    Latest history window
                  </Button>
                )}
                <Button
                  kind="quiet"
                  disabled={historyBusy || !(olderItems?.page ?? data.window.items).nextCursor}
                  onClick={() => void loadOlder('items')}
                >
                  Older history
                </Button>
              </div>
            </div>
          )}
          {historyError && (
            <Notice tone="attention" title="History page unavailable">
              {historyError} Current flight updates continue.
            </Notice>
          )}
          {evidenceError && (
            <Notice tone="attention" title="Evidence record unavailable">
              {evidenceError}
            </Notice>
          )}
          <RecordTimeline
            items={visibleData?.items ?? []}
            findings={visibleData?.findings ?? []}
            flightId={selected.id}
            axis={axis}
            selectedId={selectedItemId}
            inspectedId={inspectedId}
            revealRecord={revealRecord}
            newIds={newIds}
            principal={principal}
            inspector={receiptOutsideFlight ? null : inspector}
            loading={!data && !error}
            onSelect={selectRecord}
            notice={
              newIds.size > 0 && (
                <div className="arrival-notice" data-testid="late-arrivals">
                  <span>
                    <strong>
                      {newIds.size} new input{newIds.size === 1 ? '' : 's'}
                    </strong>{' '}
                    · your selection is kept
                  </span>
                  <button onClick={viewArrivals}>
                    Review arrivals <span aria-hidden="true">↓</span>
                  </button>
                </div>
              )
            }
          />
        </section>
      </div>
      <aside className="rail" aria-label="Decision basis and actions">
        {visibleData && (
          <FindingsPanel
            active={active}
            client={client}
            data={visibleData}
            principal={principal}
            view={lens === 'telemetry' ? 'telemetry' : 'record'}
            renderedBasis={lens === 'telemetry' ? mapBasis : undefined}
            acceptanceBlocked={lens === 'telemetry' && !mapConsistent}
            onChanged={refreshed}
            onSafety={onSafety}
            focusedFinding={focusedFinding}
            onEvidence={revealEvidence}
          />
        )}
        {visibleData && principal?.capabilities.includes('evidence:read') && (
          <SubjectFindings
            client={client}
            subject={{ kind: 'flight', id: visibleData.flight.id }}
            only="proposed"
            // Proposed rules are evaluated apart from the flight's own revision: read them again as the page refreshes,
            // at most every half minute.
            version={`${visibleData.flight.revision}:${Math.floor(Date.parse(visibleData.meta.computedAt) / 30_000)}`}
          />
        )}
        {visibleData && (
          <ActionPanel
            reviewRef={actions}
            client={client}
            data={visibleData}
            view={lens === 'telemetry' ? 'telemetry' : 'record'}
            renderedBasis={lens === 'telemetry' ? mapBasis : undefined}
            acceptanceBlocked={lens === 'telemetry' && !mapConsistent}
            selectedItem={item}
            receiptId={showUnresolved ? receiptId : null}
            suggestedKind={nextStep(flight)}
            onChanged={refreshed}
          />
        )}
        <FlightRail
          data={data}
          items={visibleData?.items ?? []}
          decisions={visibleData?.decisions ?? []}
          pinned={pinnedDecision}
          selectedId={selectedItemId}
          principal={principal}
          onSelect={(id) => {
            selectRecord(id);
            setLens('record');
            requestAnimationFrame(() => {
              scroller.current
                ?.querySelector('[data-testid="receipt-inspector"]')
                ?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
            });
          }}
          decisionHistory={{
            olderLoaded: Boolean(olderDecisions),
            busy: historyBusy,
            hasOlder: Boolean(data && (olderDecisions?.page ?? data.window.decisions).nextCursor),
            onOlder: () => void loadOlder('decisions'),
            onRecent: () => setOlderDecisions(null),
          }}
          orders={{
            page: orderPage,
            error: orderError,
            onFirst: () => setOrderCursor(undefined),
            onNext: () => {
              if (orderPage?.page.nextCursor && orderPage.page.nextCursor !== orderCursor)
                setOrderCursor(orderPage.page.nextCursor);
            },
          }}
          flight={flight}
          capabilities={capabilities}
        />
      </aside>
    </div>
  );
}
