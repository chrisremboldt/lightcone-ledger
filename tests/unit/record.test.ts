import { expect, test } from 'vitest';
import type { TimelineItem } from '@ledger/contracts';
import { buildSpine, type SpineRow } from '../../apps/web/src/record.js';
import { displayLane, itemSource, recordTitle } from '../../apps/web/src/labels.js';

const now = Date.parse('2026-10-05T19:58:00Z');
const learned = '2026-10-05T19:56:12Z';

function item(id: string, kind: string, occurredAt: string, sourceId?: string, receivedAt = learned): TimelineItem {
  const lane = kind === 'decision.record' ? 'decisions' : kind === 'flight.observation' ? 'observed' : 'plan';
  return {
    id,
    lane,
    kind,
    title: id,
    occurredAt,
    receivedAt,
    actorId: 'principal-alpha-actor',
    sourceId,
    payload: {},
    linkStatus: 'linked',
  };
}

const items = [
  item('exchange-3', 'source.observation', '2026-10-05T19:56:03Z', 'airspace-link'),
  item('approved', 'airspace.status', '2026-10-04T13:50:00Z', 'airspace-link'),
  item('older', 'order.revision', '2026-10-03T15:00:00Z', 'partner-orders'),
  item('departed', 'flight.observation', '2026-10-04T14:00:00Z', 'simulation-person-alpha'),
  item('exchange-1', 'source.observation', '2026-10-05T19:56:01Z', 'airspace-link', '2026-10-05T19:56:01Z'),
  item('exchange-2', 'source.observation', '2026-10-05T19:56:02Z', 'airspace-link', '2026-10-05T19:56:02Z'),
  item('exchange-4', 'source.observation', '2026-10-05T19:56:04Z', 'airspace-link'),
  item('note', 'decision.record', '2026-10-05T19:56:30Z', undefined, '2026-10-05T19:56:30Z'),
  item('landed-1', 'flight.observation', '2026-10-04T14:34:00Z', 'aircraft-live'),
  item('rescinded', 'airspace.status', '2026-10-04T14:35:00Z', 'airspace-link'),
  item('landed-2', 'flight.observation', '2026-10-04T14:37:00Z', 'aircraft-live'),
  item('landed-3', 'flight.observation', '2026-10-04T14:40:00Z', 'aircraft-live'),
];

function summary(rows: SpineRow[]) {
  return rows.map((row) =>
    row.type === 'item'
      ? ['item', row.item.id]
      : row.type === 'group'
        ? ['group', row.label, row.items.map((member) => member.id)]
        : ['day', row.label],
  );
}

test('buildSpine breaks days in Central time and collapses runs of three or more from one source', () => {
  expect(summary(buildSpine(items, 'occurredAt', 'all', now))).toEqual([
    ['day', 'Sat Oct 3'],
    ['item', 'older'],
    ['day', 'Yesterday · Sun Oct 4'],
    ['item', 'approved'],
    ['item', 'departed'],
    ['item', 'landed-1'],
    ['item', 'rescinded'],
    ['item', 'landed-2'],
    ['item', 'landed-3'],
    ['day', 'Today · Mon Oct 5'],
    ['group', '4 Airspace Link exchanges', ['exchange-1', 'exchange-2', 'exchange-3', 'exchange-4']],
    ['item', 'note'],
  ]);
});

test('buildSpine orders by receipt time with id tie-breaks and filters by lane before grouping', () => {
  expect(summary(buildSpine(items, 'receivedAt', 'all', now))).toEqual([
    ['day', 'Today · Mon Oct 5'],
    ['item', 'exchange-1'],
    ['item', 'exchange-2'],
    ['item', 'approved'],
    ['item', 'departed'],
    ['item', 'exchange-3'],
    ['item', 'exchange-4'],
    ['group', '3 Aircraft live feed reports', ['landed-1', 'landed-2', 'landed-3']],
    ['item', 'older'],
    ['item', 'rescinded'],
    ['item', 'note'],
  ]);
  expect(summary(buildSpine(items, 'occurredAt', 'observed', now))).toEqual([
    ['day', 'Yesterday · Sun Oct 4'],
    ['item', 'departed'],
    ['group', '3 Aircraft live feed reports', ['landed-1', 'landed-2', 'landed-3']],
  ]);
});

test('recorded evaluations remain in the checks lane with their own source label', () => {
  const evaluation: TimelineItem = { ...item('evaluation', 'evaluation.recorded', learned), lane: 'checks' };
  expect(displayLane(evaluation)).toBe('checks');
  expect(itemSource(evaluation)).toBe('Ledger evaluator');
  expect(summary(buildSpine([evaluation], 'occurredAt', 'plan', now))).toEqual([]);
  expect(summary(buildSpine([evaluation], 'occurredAt', 'checks', now))).toEqual([
    ['day', 'Today · Mon Oct 5'],
    ['item', 'evaluation'],
  ]);
});

test('a retained human effectiveness review shows its author only when the event identity matches', () => {
  // A review recorded before the flight-side hazard system was retired stays on the flight record as it was.
  const retained = {
    version: 'hazard.effectiveness-review.2',
    recordedAt: '2026-10-05T19:57:00Z',
    actor: { id: 'principal-alpha-operator', name: 'Dana Ortiz' },
    decision: { kind: 'control.effectiveness-review', conclusion: 'effective' },
  };
  const review: TimelineItem = {
    ...item('review', 'decision.record', retained.recordedAt),
    lane: 'checks',
    actorId: retained.actor.id,
    payload: { decision: retained.decision, acceptance: retained },
  };
  expect(recordTitle(review)).toBe('Control effectiveness reviewed');
  expect(itemSource(review)).toBe(retained.actor.name);
  expect(itemSource({ ...review, actorId: 'principal-beta-actor' })).toBe('Field crew');
});

test('anomalies stay visible between grouped telemetry and exact evidence can be revealed without changing lane', () => {
  const samples = Array.from({ length: 6 }, (_, index) =>
    item(`sample-${index}`, 'telemetry.segment', `2026-10-05T19:56:0${index}Z`, 'dji-osd'),
  ).map((sample) => ({ ...sample, lane: 'observed' as const }));
  const loss = {
    ...item('loss', 'command-link.status', '2026-10-05T19:56:02.500Z', 'radio'),
    lane: 'observed' as const,
  };
  const plan = item('plan', 'airspace.status', '2026-10-05T19:55:00Z', 'airspace-link');
  const all = [...samples, loss, plan];
  const rows = buildSpine(all, 'occurredAt', 'all', now, { ungroupedIds: new Set(['loss']) });
  expect(rows.filter((row) => row.type === 'group').map((row) => row.items.length)).toEqual([3, 3]);
  expect(rows.some((row) => row.type === 'item' && row.item.id === 'loss')).toBe(true);
  for (const axis of ['occurredAt', 'receivedAt'] as const) {
    const revealed = buildSpine(all, axis, 'plan', now, { revealedId: 'loss' });
    expect(
      revealed
        .filter((row) => row.type === 'item')
        .map((row) => row.item.id)
        .sort(),
    ).toEqual(['loss', 'plan']);
    expect(
      buildSpine(all, axis, 'plan', now)
        .filter((row) => row.type === 'item')
        .map((row) => row.item.id),
    ).toEqual(['plan']);
  }
});
