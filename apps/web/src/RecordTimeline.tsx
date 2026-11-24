import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { FindingRecord, Principal, TimelineItem } from '@ledger/contracts';
import { Spinner } from '@ledger/ui';
import { ctDay, ctDayName, shortTime, time, timeZoneLabel } from './format.js';
import {
  decisionNote,
  displayLane,
  itemDetail,
  itemSource,
  lanes,
  lateness,
  linkStatus,
  recordTitle,
  relativeDay,
  sourceLabel,
  type DisplayLane,
} from './labels.js';
import { buildSpine, type Axis, type SpineRow } from './record.js';
import { buildAnomalyPresentation, type RecordAnomaly } from './record-anomalies.js';

interface Props {
  items: TimelineItem[];
  findings: FindingRecord[];
  flightId: string;
  revealRecord?: { id: string; sequence: number };
  axis: Axis;
  selectedId: string | null;
  inspectedId: string | null;
  newIds: Set<string>;
  principal: Principal | null;
  inspector: ReactNode;
  notice: ReactNode;
  loading: boolean;
  onSelect: (id: string) => void;
}

const axisNames: Record<Axis, string> = { occurredAt: 'Happened', receivedAt: 'Ledger learned it' };
const laneNames = Object.fromEntries(lanes.map((lane) => [lane.key, lane.label])) as Record<DisplayLane, string>;

function otherAxis(axis: Axis): Axis {
  return axis === 'occurredAt' ? 'receivedAt' : 'occurredAt';
}

export function RecordTimeline({
  items,
  findings,
  flightId,
  revealRecord,
  axis,
  selectedId,
  inspectedId,
  newIds,
  principal,
  inspector,
  notice,
  loading,
  onSelect,
}: Props) {
  const [lane, setLane] = useState<DisplayLane | 'all'>('all');
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [dismissedReveal, setDismissedReveal] = useState<number | null>(null);
  const timeline = useRef<HTMLDivElement>(null);
  const focusedReveal = useRef<number | null>(null);
  const anomalies = useMemo(() => buildAnomalyPresentation(items, findings, flightId), [items, findings, flightId]);
  const revealed = revealRecord && revealRecord.sequence !== dismissedReveal ? revealRecord : undefined;
  const revealedItem = items.find((member) => member.id === revealed?.id);
  const outsideLane = revealedItem && lane !== 'all' && displayLane(revealedItem) !== lane;
  const rows = useMemo(
    () =>
      buildSpine(items, axis, lane, Date.now(), { ungroupedIds: new Set(anomalies.keys()), revealedId: revealed?.id }),
    [items, axis, lane, anomalies, revealed?.id],
  );
  useLayoutEffect(() => {
    if (!revealed || focusedReveal.current === revealed.sequence) return;
    const target = Array.from(timeline.current?.querySelectorAll<HTMLButtonElement>('.spine-card-button') ?? []).find(
      (button) => button.closest<HTMLElement>('[data-anchor-id]')?.dataset.anchorId === revealed.id,
    );
    if (!target) return;
    target.focus({ preventScroll: true });
    const headerHeight = timeline.current?.querySelector('.timeline-lanes')?.getBoundingClientRect().height ?? 0;
    target.style.scrollMarginTop = `${headerHeight + 12}px`;
    target.scrollIntoView({ block: 'start', behavior: 'auto' });
    const frame = requestAnimationFrame(() => {
      const header = timeline.current?.querySelector('.timeline-lanes');
      const overlap = target.getBoundingClientRect().top - (header?.getBoundingClientRect().bottom ?? 0) - 12;
      if (overlap < 0) {
        const container = target.closest<HTMLElement>('.thread-main');
        if (container && getComputedStyle(container).overflowY !== 'visible') container.scrollTop += overlap;
        else window.scrollBy({ top: overlap, behavior: 'auto' });
      }
      focusedReveal.current = revealed.sequence;
    });
    return () => cancelAnimationFrame(frame);
  }, [revealed, rows]);
  function chooseLane(next: DisplayLane | 'all') {
    setLane(next);
    setDismissedReveal(revealRecord?.sequence ?? null);
  }
  const focused = (member: TimelineItem) => member.id === selectedId || member.id === inspectedId;
  const isOpen = (row: Extract<SpineRow, { type: 'group' }>) => opened.has(row.key) || row.items.some(focused);
  const inspectedShown = rows.some(
    (row) =>
      (row.type === 'item' && row.item.id === inspectedId) ||
      (row.type === 'group' && isOpen(row) && row.items.some((member) => member.id === inspectedId)),
  );
  const toggle = (key: string) =>
    setOpened((previous) => {
      const next = new Set(previous);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const entries: ReactNode[] = [];
  let previousTime: string | null = null;
  const pushItem = (member: TimelineItem, grouped: boolean) => {
    const anomaly = anomalies.get(member.id);
    const when = anomaly ? time(member[axis]) : shortTime(member[axis]);
    entries.push(
      <SpineItem
        key={member.id}
        item={member}
        anomaly={anomaly}
        finding={anomaly?.findingId ? findings.find((finding) => finding.id === anomaly.findingId) : undefined}
        axis={axis}
        grouped={grouped}
        repeatedTime={when === previousTime}
        selected={member.id === selectedId}
        isNew={newIds.has(member.id)}
        principal={principal}
        onSelect={onSelect}
      >
        {member.id === inspectedId ? inspector : null}
      </SpineItem>,
    );
    previousTime = when;
  };
  for (const row of rows) {
    if (row.type === 'day') {
      entries.push(
        <div key={row.key} className="spine-day">
          {row.label}
        </div>,
      );
      previousTime = null;
    } else if (row.type === 'item') pushItem(row.item, false);
    else {
      const open = isOpen(row);
      const forced = row.items.some(focused);
      entries.push(
        <GroupHeader
          key={row.key}
          row={row}
          axis={axis}
          open={open}
          onToggle={forced ? undefined : () => toggle(row.key)}
        />,
      );
      previousTime = shortTime(row.items[0]![axis]);
      if (open) for (const member of row.items) pushItem(member, true);
    }
  }

  return (
    <div className="record-timeline" ref={timeline}>
      <div className="timeline-lanes">
        <div className="lane-filters" role="group" aria-label="Show lane">
          <button className="lane-filter" aria-pressed={lane === 'all'} onClick={() => chooseLane('all')}>
            All <span className="lane-count">{items.length}</span>
          </button>
          {lanes.map((option) => (
            <button
              key={option.key}
              className="lane-filter"
              aria-pressed={lane === option.key}
              title={option.description}
              onClick={() => chooseLane(option.key)}
            >
              <i className={`lane-mark lane-mark--${option.key}`} aria-hidden="true" />
              {option.label}
              <span className="lane-count">{items.filter((member) => displayLane(member) === option.key).length}</span>
            </button>
          ))}
        </div>
        <div className="arrival-space" aria-live="polite">
          {notice}
        </div>
        {outsideLane && revealedItem && (
          <div className="timeline-reveal" role="status">
            <span>
              Showing selected {laneNames[displayLane(revealedItem)]} evidence outside the {laneNames[lane]} filter.
            </span>
            <button onClick={() => setDismissedReveal(revealRecord!.sequence)}>Show only {laneNames[lane]}</button>
          </div>
        )}
        <div className="spine-columns" aria-hidden="true">
          <span>{axisNames[axis]}</span>
          <span />
          <span>What was recorded</span>
          <span>{axisNames[otherAxis(axis)]}</span>
        </div>
      </div>
      {loading && (
        <div className="timeline-empty">
          <Spinner label="Reading the flight record" />
        </div>
      )}
      {!loading && items.length === 0 && (
        <div className="timeline-empty">
          <strong>Flight created</strong>
          <p>Reports, evidence and decisions appear here as they arrive.</p>
        </div>
      )}
      {!loading && items.length > 0 && rows.length === 0 && (
        <div className="timeline-empty">
          <p>Nothing in this lane yet.</p>
        </div>
      )}
      {inspector && !inspectedShown && <div className="spine-floating">{inspector}</div>}
      <div className="spine">{entries}</div>
      <div className="timeline-end">End of the loaded history</div>
    </div>
  );
}

function OtherClock({ item, axis, precise = false }: { item: TimelineItem; axis: Axis; precise?: boolean }) {
  const other = otherAxis(axis);
  const late = lateness(item);
  const sameDay = ctDay(item[other]) === ctDay(item[axis]);
  return (
    <div className={`spine-stamp ${late ? 'is-late' : ''}`}>
      <span className="spine-wire" aria-hidden="true" />
      <span className="spine-stamp-text">
        <time dateTime={item[other]}>
          {!sameDay && <small>{relativeDay(item[other]) ?? ctDayName(item[other])}</small>}
          {precise ? time(item[other]) : shortTime(item[other])}
        </time>
        {late ? (
          <span className="late-tag">{late}</span>
        ) : (
          <small className="on-time">{other === 'receivedAt' ? 'Received' : 'Happened'}</small>
        )}
      </span>
    </div>
  );
}

function SpineItem({
  item,
  anomaly,
  finding,
  axis,
  grouped,
  repeatedTime,
  selected,
  isNew,
  principal,
  onSelect,
  children,
}: {
  item: TimelineItem;
  anomaly?: RecordAnomaly;
  finding?: FindingRecord;
  axis: Axis;
  grouped: boolean;
  repeatedTime: boolean;
  selected: boolean;
  isNew: boolean;
  principal: Principal | null;
  onSelect: (id: string) => void;
  children: ReactNode;
}) {
  const lane = displayLane(item);
  const detail = itemDetail(item);
  const note = item.kind === 'decision.record' ? decisionNote(item) : null;
  const responsibility = finding
    ? finding.status === 'resolved'
      ? 'Resolved'
      : finding.owner
        ? `${finding.owner.name} owns this finding`
        : 'Needs an owner'
    : null;
  const evidence = finding
    ? {
        supported: 'supported evidence',
        conflicting: 'conflicting evidence',
        insufficient: 'insufficient evidence',
        not_applicable: 'check not applicable',
      }[finding.latestEvaluation.evidenceState]
    : null;
  return (
    <div
      className={`spine-row spine-row--${lane} ${grouped ? 'is-grouped' : ''} ${isNew ? 'is-new' : ''}`}
      data-anchor-id={item.id}
      data-anomaly-kind={anomaly?.kind}
      data-anomaly-tone={anomaly?.tone}
    >
      <time className={`spine-when ${repeatedTime ? 'is-repeated' : ''}`} dateTime={item[axis]}>
        {anomaly ? time(item[axis]) : shortTime(item[axis])}
      </time>
      <span className="spine-marker">
        {anomaly?.tone === 'neutral' ? (
          <span className="spine-anomaly-marker" aria-hidden="true">
            ?
          </span>
        ) : anomaly ? (
          <svg className="spine-anomaly-marker" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 1 15 14H1Z" fill="var(--paper)" stroke="currentColor" strokeLinejoin="round" />
            <path d="M8 5v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            <circle cx="8" cy="11.5" r=".8" fill="currentColor" />
          </svg>
        ) : (
          <i className={`lane-mark lane-mark--${lane}`} aria-hidden="true" />
        )}
      </span>
      <div className={`spine-card ${selected ? 'is-selected' : ''}`}>
        <button
          className="spine-card-button"
          data-testid={`timeline-item-${item.id}`}
          aria-pressed={selected}
          onClick={() => onSelect(item.id)}
        >
          <span className="spine-card-head">
            <span className={`lane-tag lane-tag--${lane}`}>{laneNames[lane]}</span>
            <strong>{recordTitle(item)}</strong>
            {isNew && <span className="new-marker">NEW</span>}
            <span className="spine-flags">
              {item.linkStatus !== 'linked' && <span className="flag">{linkStatus[item.linkStatus].label}</span>}
            </span>
          </span>
          {anomaly && (
            <span className="spine-anomaly">
              <strong>{anomaly.label}</strong>
              {anomaly.detail && <span>{anomaly.detail}</span>}
              {anomaly.related?.slice(0, 3).map((related, index) => (
                <span className="spine-related" key={`${related.eventId}:${index}`}>
                  {related.label}
                  {related.reportedAt
                    ? ` · landing at ${time(related.reportedAt, true)} ${timeZoneLabel()}`
                    : related.occurredAt
                      ? ` · ${time(related.occurredAt, true)} ${timeZoneLabel()}`
                      : ''}
                </span>
              ))}
              {anomaly.related && anomaly.related.length > 3 && (
                <small>{anomaly.related.length - 3} more related records in retained evidence.</small>
              )}
              {finding && (
                <small>
                  Current finding: {responsibility} · {evidence}
                </small>
              )}
              <small>Severity not recorded</small>
            </span>
          )}
          {note && <span className="spine-quote">“{note}”</span>}
          <span className="spine-card-sub">
            {detail && (
              <>
                {detail}
                <i className="separator">·</i>
              </>
            )}
            <span className="spine-source">{itemSource(item, principal)}</span>
          </span>
        </button>
        {children}
      </div>
      <OtherClock item={item} axis={axis} precise={Boolean(anomaly)} />
    </div>
  );
}

function GroupHeader({
  row,
  axis,
  open,
  onToggle,
}: {
  row: Extract<SpineRow, { type: 'group' }>;
  axis: Axis;
  open: boolean;
  onToggle?: () => void;
}) {
  const first = row.items[0]!;
  const last = row.items.at(-1)!;
  const lane = displayLane(first);
  return (
    <div className={`spine-row spine-row--${lane} spine-row--group ${open ? 'is-open' : ''}`}>
      <time className="spine-when" dateTime={first[axis]}>
        {shortTime(first[axis])}
      </time>
      <span className="spine-marker">
        <i className={`lane-mark lane-mark--${lane}`} aria-hidden="true" />
      </span>
      <button className="spine-card spine-group" aria-expanded={open} onClick={onToggle}>
        <span className="spine-card-head">
          <span className={`lane-tag lane-tag--${lane}`}>{laneNames[lane]}</span>
          <strong>{row.label}</strong>
          {onToggle && <span className="group-toggle">{open ? 'Hide' : 'Show all'}</span>}
        </span>
        <span className="spine-card-sub">
          {sourceLabel(first.sourceId)}
          <i className="separator">·</i>
          <span className="mono">
            {shortTime(first[axis])}–{shortTime(last[axis])}
          </span>
        </span>
      </button>
      <OtherClock item={first} axis={axis} />
    </div>
  );
}
