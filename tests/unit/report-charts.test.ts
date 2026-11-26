import { describe, expect, it } from 'vitest';
import type { IndicatorHistory } from '../../packages/contracts/src/index.js';
import {
  indicatorFrame,
  indicatorGeometry,
  indicatorSentence,
  monthlyFrame,
  monthlyGeometry,
  monthlySentence,
  monthLabel,
  monthLabelEvery,
  monthTickLabels,
  narrowIndicatorFrame,
  narrowMonthlyFrame,
  niceStep,
  timeTickCount,
  timeTicks,
  windowGaps,
  zeroScale,
} from '../../apps/web/src/report-charts.js';

type Result = IndicatorHistory['results'][number];

const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString();
function result(
  id: string,
  start: number,
  end: number,
  rate: string | null,
  status: Result['status'] = 'supported',
): Result {
  return {
    id,
    digest: 'a'.repeat(64),
    windowId: `window-${id}`,
    hazardId: 'hazard-1',
    window: { start: day(start), end: day(end) },
    recordedAt: day(end),
    recordedThrough: day(end),
    status: rate === null && status === 'supported' ? 'insufficient' : status,
    eventCount: 1,
    exposure: { decimal: '2', unit: 'flight hours' },
    rate: rate === null ? null : { decimal: rate, label: 'per flight hour' },
  };
}
const history = (results: Result[], limit: { rate: string; label: string } | null = null): IndicatorHistory => ({
  definition: {
    id: 'test.indicator',
    version: 1,
    title: 'Fictional excursions per flight hour',
    description: null,
    unitLabel: 'per flight hour',
    limit,
  },
  results,
  truncated: false,
  computedAt: day(40),
});

describe('scales', () => {
  it('steps by 1, 2, 2.5 or 5 times a power of ten', () => {
    expect(niceStep(10, 4)).toBe(2.5);
    expect(niceStep(0.9, 4)).toBe(0.25);
    expect(niceStep(7, 4)).toBe(2);
    expect(niceStep(0, 4)).toBe(1);
  });
  it('runs from zero to a round value at or above the largest', () => {
    expect(zeroScale(10)).toEqual({ max: 10, ticks: [0, 2.5, 5, 7.5, 10] });
    expect(zeroScale(3, 4, true)).toEqual({ max: 3, ticks: [0, 1, 2, 3] });
    expect(zeroScale(0, 4, true)).toEqual({ max: 1, ticks: [0, 1] });
    expect(zeroScale(0.35).max).toBeGreaterThanOrEqual(0.35);
  });
  it('places time ticks evenly, first and last included', () => {
    expect(timeTicks(0, 100)).toEqual([0, 25, 50, 75, 100]);
    expect(timeTicks(5, 5)).toEqual([5]);
  });
});

describe('an indicator’s results over time', () => {
  const frame = indicatorFrame;
  const baseline = frame.height - frame.bottom;

  it('puts each result at the middle of its window and at its rate, with the limit drawn at its level', () => {
    const shown = indicatorGeometry(
      [result('a', 0, 10, '0.5'), result('b', 10, 20, '1'), result('c', 20, 30, null)],
      '1.5',
    );
    expect(shown.points.map((point) => point.id)).toEqual(['a', 'b', 'c']);
    const width = frame.width - frame.left - frame.right;
    expect(shown.points[0]!.x).toBeCloseTo(frame.left + width / 6, 1);
    expect(shown.points[0]!.startX).toBe(frame.left);
    expect(shown.points[2]!.endX).toBe(frame.width - frame.right);
    // The scale holds the limit: 0 to 2 in steps of 0.5.
    expect(shown.yTicks.map((tick) => tick.value)).toEqual([0, 0.5, 1, 1.5, 2]);
    const height = frame.height - frame.top - frame.bottom;
    expect(shown.points[1]!.y).toBeCloseTo(baseline - height / 2, 1);
    expect(shown.limit).toEqual({ value: 1.5, y: expect.closeTo(baseline - height * 0.75, 1) });
    // A result that states no rate sits on the baseline with no rate, never at an interpolated level.
    expect(shown.points[2]).toMatchObject({ rate: null, y: baseline, status: 'insufficient' });
  });

  it('names the stretches between windows that no result covers', () => {
    const results = [result('a', 0, 10, '1'), result('b', 20, 30, '2'), result('c', 25, 28, '1')];
    expect(windowGaps(results)).toEqual([{ from: day(10), until: day(20) }]);
    const shown = indicatorGeometry(results, null);
    expect(shown.gaps).toHaveLength(1);
    expect(shown.gaps[0]!.endX).toBeGreaterThan(shown.gaps[0]!.startX);
    expect(shown.limit).toBeNull();
  });

  it('draws one result over a window of its own, and none over no results', () => {
    const one = indicatorGeometry([result('a', 3, 3, '1')], null);
    expect(one.points[0]!.x).toBeCloseTo(frame.left + (frame.width - frame.left - frame.right) / 2, 1);
    expect(indicatorGeometry([], null).points).toEqual([]);
  });

  it('tells the chart in one sentence: results, rates, the limit and the gaps', () => {
    expect(indicatorSentence(history([]))).toBe('No result of this indicator is recorded yet.');
    const told = indicatorSentence(
      history([result('a', 0, 10, '0.5'), result('b', 20, 30, '2'), result('c', 30, 40, null)], {
        rate: '1',
        label: 'Alert level',
      }),
    );
    expect(told).toBe(
      '3 results recorded; 2 state a rate and 1 states none, for want of evidence. Stated rates run from 0.5 to 2 per flight hour. 1 of the stated rates is above the alert level of 1 per flight hour. 1 stretch between windows has no recorded result.',
    );
    expect(indicatorSentence(history([result('a', 0, 10, '1')]))).toBe(
      '1 result recorded; each states a rate. The stated rate is 1 per flight hour.',
    );
  });
});

describe('findings opened and closed per month', () => {
  const frame = monthlyFrame;
  const baseline = frame.height - frame.bottom;
  const months = ['2026-01', '2026-02', '2026-03'];

  it('draws a pair of bars a month, their heights in proportion to the counts, a zero as no height', () => {
    const shown = monthlyGeometry(months, [4, 0, 2], [1, 3, 0]);
    expect(shown.groups.map((group) => group.month)).toEqual(months);
    expect(shown.yTicks.map((tick) => tick.value)).toEqual([0, 1, 2, 3, 4]);
    const [january, february] = shown.groups;
    expect(january!.bars.map((bar) => bar.kind)).toEqual(['opened', 'closed']);
    const height = frame.height - frame.top - frame.bottom;
    expect(january!.bars[0]!.height).toBeCloseTo(height, 1);
    expect(january!.bars[1]!.height).toBeCloseTo(height / 4, 1);
    expect(february!.bars[0]).toMatchObject({ value: 0, height: 0, y: baseline });
    // The bars of a month sit side by side, closed to the right of opened.
    expect(january!.bars[1]!.x).toBeCloseTo(january!.bars[0]!.x + january!.bars[0]!.width, 1);
    expect(shown.groups[1]!.x - shown.groups[0]!.x).toBeCloseTo((frame.width - frame.left - frame.right) / 3, 1);
  });

  it('keeps a whole-number scale when nothing is counted', () => {
    expect(monthlyGeometry(months, [0, 0, 0], [0, 0, 0]).yTicks.map((tick) => tick.value)).toEqual([0, 1]);
  });

  it('names months and tells the chart in one sentence', () => {
    expect(monthLabel('2026-11')).toBe('Nov 2026');
    expect(monthlySentence(months, [4, 0, 4], [1, 3, 0])).toBe(
      'From Jan 2026 to Mar 2026, 8 findings opened and 4 closed. The most opened in one month was 4, in Jan 2026, Mar 2026.',
    );
    expect(monthlySentence(['2026-01'], [0], [0])).toBe('No counted finding opened or closed from Jan 2026.');
  });
});

describe('a chart on a phone', () => {
  // A chart is scaled to its width: on a 375 px screen a 360-unit frame draws its 11-unit labels near 11 px.
  it('is drawn in a frame near the phone’s width, so its labels keep a readable size', () => {
    expect(narrowIndicatorFrame.width).toBeLessThanOrEqual(375);
    expect(narrowMonthlyFrame.width).toBeLessThanOrEqual(375);
  });

  it('shows fewer ticks rather than smaller text', () => {
    expect(timeTickCount(indicatorFrame)).toBe(5);
    expect(timeTickCount(narrowIndicatorFrame)).toBe(3);
    expect(monthLabelEvery(12, monthlyFrame)).toBe(1);
    expect(monthLabelEvery(12, narrowMonthlyFrame)).toBe(2);
    expect(monthLabelEvery(24, monthlyFrame)).toBe(3);
    expect(monthLabelEvery(24, narrowMonthlyFrame)).toBe(3);
    const narrow = indicatorGeometry([result('a', 0, 1, '1'), result('b', 30, 31, '2')], null, narrowIndicatorFrame);
    expect(narrow.xTicks).toHaveLength(3);
  });

  it('names a year under a labelled month only, so two years never overlap', () => {
    const months = ['2025-12', '2026-01', '2026-02', '2026-03'];
    expect(monthTickLabels(months, 2)).toEqual([
      { month: 'Dec', year: '2025' },
      {},
      { month: 'Feb', year: '2026' },
      {},
    ]);
    expect(monthTickLabels(months, 1).map((label) => label.year)).toEqual(['2025', '2026', undefined, undefined]);
  });
});
