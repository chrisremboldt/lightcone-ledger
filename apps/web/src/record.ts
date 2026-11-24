import type { TimelineItem } from '@ledger/contracts';
import { ctDay } from './format.js';
import { dayLabel, displayLane, groupLabel, type DisplayLane } from './labels.js';

export type Axis = 'occurredAt' | 'receivedAt';

export type SpineRow =
  | { type: 'day'; key: string; label: string }
  | { type: 'item'; key: string; item: TimelineItem }
  | { type: 'group'; key: string; items: TimelineItem[]; label: string };

const minimumGroup = 3;

function compareTime(left: string, right: string) {
  const difference = Date.parse(left) - Date.parse(right);
  return Number.isFinite(difference) ? difference : left.localeCompare(right);
}

export function sortItems(items: TimelineItem[], axis: Axis) {
  return [...items].sort(
    (a, b) => compareTime(a[axis], b[axis]) || compareTime(a.receivedAt, b.receivedAt) || a.id.localeCompare(b.id),
  );
}

export function buildSpine(
  items: TimelineItem[],
  axis: Axis,
  lane: DisplayLane | 'all',
  now = Date.now(),
  { ungroupedIds, revealedId }: { ungroupedIds?: ReadonlySet<string>; revealedId?: string } = {},
): SpineRow[] {
  const rows: SpineRow[] = [];
  let day: string | null = null;
  let run: TimelineItem[] = [];
  const flush = () => {
    const first = run[0];
    if (first && run.length >= minimumGroup)
      rows.push({ type: 'group', key: `group:${first.id}`, items: run, label: groupLabel(first, run.length) });
    else rows.push(...run.map((item): SpineRow => ({ type: 'item', key: item.id, item })));
    run = [];
  };
  for (const item of sortItems(items, axis)) {
    if (lane !== 'all' && displayLane(item) !== lane && item.id !== revealedId) continue;
    const itemDay = ctDay(item[axis]);
    if (itemDay !== day) {
      flush();
      rows.push({ type: 'day', key: `day:${itemDay}`, label: dayLabel(item[axis], now) });
      day = itemDay;
    }
    if (ungroupedIds?.has(item.id) || item.id === revealedId) {
      flush();
      rows.push({ type: 'item', key: item.id, item });
      continue;
    }
    const head = run[0];
    if (head && (head.kind !== item.kind || head.sourceId !== item.sourceId)) flush();
    run.push(item);
  }
  flush();
  return rows;
}
