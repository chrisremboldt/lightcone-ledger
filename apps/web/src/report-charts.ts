import type { IndicatorHistory } from '@ledger/contracts';

/**
 * The geometry of the reports' charts, as pure functions from recorded numbers to points, so each is tested and the
 * drawing only draws. Nothing is interpolated: a point is a recorded result, a bar a recorded count, and the time
 * between two windows with no recorded result is a gap that is named, never a line drawn across.
 */

/** The drawing area of a chart, in the SVG's own units. */
export interface ChartFrame {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export const indicatorFrame: ChartFrame = { width: 720, height: 300, left: 64, right: 20, top: 24, bottom: 48 };
export const monthlyFrame: ChartFrame = { width: 720, height: 260, left: 44, right: 12, top: 20, bottom: 44 };
/**
 * The frames a chart is drawn in on a phone. A chart is scaled to its width, so a narrower frame keeps its labels near
 * their own size; it shows fewer ticks rather than smaller text.
 */
export const narrowIndicatorFrame: ChartFrame = { width: 360, height: 240, left: 52, right: 14, top: 24, bottom: 44 };
export const narrowMonthlyFrame: ChartFrame = { width: 360, height: 220, left: 36, right: 8, top: 20, bottom: 44 };

/** How many time ticks fit across a frame: one per 90 units of plot, between two and five. */
export const timeTickCount = (frame: ChartFrame) => Math.max(2, Math.min(5, Math.floor(plotWidth(frame) / 90)));

/** Every how many months a month is labelled, so each label has about 34 units: a short month name at its size. */
export function monthLabelEvery(months: number, frame: ChartFrame): number {
  const slot = plotWidth(frame) / Math.max(1, months);
  return Math.max(months > 12 ? 3 : 1, Math.ceil(34 / slot));
}

const plotHeight = (frame: ChartFrame) => frame.height - frame.top - frame.bottom;
const plotWidth = (frame: ChartFrame) => frame.width - frame.left - frame.right;
const round = (value: number) => Math.round(value * 100) / 100;

/** The smallest step of 1, 2, 2.5 or 5 times a power of ten that covers a range in that many steps. */
export function niceStep(range: number, steps: number): number {
  if (!(range > 0)) return 1;
  const raw = range / steps;
  const power = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((factor) => factor * power).find((step) => step >= raw - 1e-12)!;
}

/** A scale from zero to a round value at or above the largest one, with its ticks. */
export function zeroScale(largest: number, steps = 4, whole = false): { max: number; ticks: number[] } {
  let step = niceStep(largest, steps);
  if (whole) step = Math.max(1, Math.ceil(step));
  const count = Math.max(1, Math.ceil(largest / step - 1e-9));
  const max = step * Math.max(count, 1);
  return { max, ticks: Array.from({ length: Math.round(max / step) + 1 }, (_, index) => round(index * step)) };
}

const DAY = 86_400_000;

export interface IndicatorPoint {
  id: string;
  status: IndicatorHistory['results'][number]['status'];
  /** The stated rate as a number, or null when the result states none. */
  rate: number | null;
  /** Where the point is drawn: the middle of its window, and its rate, or the baseline for a result with none. */
  x: number;
  y: number;
  /** The window the result covers, drawn as a line under the point. */
  startX: number;
  endX: number;
}

export interface IndicatorGap {
  from: string;
  until: string;
  startX: number;
  endX: number;
}

export interface IndicatorGeometry {
  points: IndicatorPoint[];
  yTicks: { value: number; y: number }[];
  xTicks: { at: string; x: number }[];
  limit: { value: number; y: number } | null;
  gaps: IndicatorGap[];
  baseline: number;
}

/** Each recorded result as a point at the middle of its window, the limit as a level, and the gaps between windows. */
export function indicatorGeometry(
  results: IndicatorHistory['results'],
  limit: string | null,
  frame: ChartFrame = indicatorFrame,
): IndicatorGeometry {
  const baseline = frame.height - frame.bottom;
  const starts = results.map((result) => Date.parse(result.window.start));
  const ends = results.map((result) => Date.parse(result.window.end));
  let first = starts.length ? Math.min(...starts) : 0;
  let last = ends.length ? Math.max(...ends) : DAY;
  if (last <= first) {
    first -= DAY / 2;
    last += DAY / 2;
  }
  const x = (at: number) => round(frame.left + ((at - first) / (last - first)) * plotWidth(frame));
  const rates = results.map((result) => (result.rate ? Number(result.rate.decimal) : null));
  const limitValue = limit === null ? null : Number(limit);
  const largest = Math.max(0, ...rates.filter((rate): rate is number => rate !== null), limitValue ?? 0);
  // A tenth more than the largest, so the highest point and the limit's label are not drawn on the top edge.
  const scale = zeroScale(largest * 1.1);
  const y = (value: number) => round(baseline - (value / scale.max) * plotHeight(frame));
  const points = results.map((result, index): IndicatorPoint => {
    const start = starts[index]!;
    const end = ends[index]!;
    const rate = rates[index]!;
    return {
      id: result.id,
      status: result.status,
      rate,
      x: x((start + end) / 2),
      y: rate === null ? baseline : y(rate),
      startX: x(start),
      endX: x(end),
    };
  });
  return {
    points,
    yTicks: scale.ticks.map((value) => ({ value, y: y(value) })),
    xTicks: timeTicks(first, last, timeTickCount(frame)).map((at) => ({ at: new Date(at).toISOString(), x: x(at) })),
    limit: limitValue === null ? null : { value: limitValue, y: y(limitValue) },
    gaps: windowGaps(results).map((gap) => ({
      ...gap,
      startX: x(Date.parse(gap.from)),
      endX: x(Date.parse(gap.until)),
    })),
    baseline,
  };
}

/** The stretches between recorded windows that no recorded result covers, in time order. */
export function windowGaps(results: IndicatorHistory['results']): { from: string; until: string }[] {
  const windows = [...results]
    .map((result) => ({ start: Date.parse(result.window.start), end: Date.parse(result.window.end) }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const gaps: { from: string; until: string }[] = [];
  let covered = windows[0]?.end ?? 0;
  for (const window of windows.slice(1)) {
    if (window.start > covered)
      gaps.push({ from: new Date(covered).toISOString(), until: new Date(window.start).toISOString() });
    covered = Math.max(covered, window.end);
  }
  return gaps;
}

/** At most five instants evenly across a span, the first and the last included. */
export function timeTicks(first: number, last: number, count = 5): number[] {
  if (last <= first) return [first];
  return Array.from({ length: count }, (_, index) => first + ((last - first) * index) / (count - 1));
}

export interface MonthlyBar {
  kind: 'opened' | 'closed';
  value: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MonthlyGeometry {
  groups: { month: string; x: number; width: number; bars: MonthlyBar[] }[];
  yTicks: { value: number; y: number }[];
  baseline: number;
}

/** One group a month, of the findings opened and those closed, side by side; a whole-number scale from zero. */
export function monthlyGeometry(
  months: readonly string[],
  opened: readonly number[],
  closed: readonly number[],
  frame: ChartFrame = monthlyFrame,
): MonthlyGeometry {
  const baseline = frame.height - frame.bottom;
  const scale = zeroScale(Math.max(0, ...opened, ...closed), 4, true);
  const y = (value: number) => round(baseline - (value / scale.max) * plotHeight(frame));
  const slot = plotWidth(frame) / Math.max(1, months.length);
  const bar = Math.max(2, Math.min(22, (slot * 0.7) / 2));
  const groups = months.map((month, index) => {
    const centre = frame.left + slot * index + slot / 2;
    const bars = (['opened', 'closed'] as const).map((kind, side): MonthlyBar => {
      const value = (kind === 'opened' ? opened : closed)[index] ?? 0;
      const top = y(value);
      return {
        kind,
        value,
        x: round(centre - bar + side * bar),
        y: top,
        width: round(bar),
        height: round(baseline - top),
      };
    });
    return { month, x: round(centre), width: round(slot), bars };
  });
  return { groups, yTicks: scale.ticks.map((value) => ({ value, y: y(value) })), baseline };
}

/**
 * The labels under a monthly chart: every `every`th month's short name, and its year under the first labelled month
 * and each labelled month whose year differs from the one labelled before it, so two years never overlap.
 */
export function monthTickLabels(months: readonly string[], every: number): { month?: string; year?: string }[] {
  let lastYear: string | null = null;
  return months.map((month, index) => {
    if (index % every !== 0) return {};
    const year = month.slice(0, 4);
    const shown = year !== lastYear ? year : undefined;
    lastYear = year;
    return { month: monthLabel(month).split(' ')[0], ...(shown ? { year: shown } : {}) };
  });
}

/** A month's short name in the organization's calendar, as in "Nov 2026". Months have no time zone of their own. */
export function monthLabel(month: string): string {
  const [year, number] = month.split('-').map(Number) as [number, number];
  const name = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(
    new Date(Date.UTC(year, number - 1, 15)),
  );
  return `${name} ${year}`;
}

/** The sentence a monthly chart is told in: how many opened and closed, and in which month the most opened. */
export function monthlySentence(
  months: readonly string[],
  opened: readonly number[],
  closed: readonly number[],
): string {
  const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
  const span =
    months.length === 1 ? monthLabel(months[0]!) : `${monthLabel(months[0]!)} to ${monthLabel(months.at(-1)!)}`;
  const openedTotal = sum(opened);
  const closedTotal = sum(closed);
  if (!openedTotal && !closedTotal) return `No counted finding opened or closed from ${span}.`;
  const most = Math.max(...opened);
  const busiest = months.filter((_, index) => opened[index] === most).map(monthLabel);
  const findings = (count: number) => `${count} finding${count === 1 ? '' : 's'}`;
  return `From ${span}, ${findings(openedTotal)} opened and ${closedTotal} closed.${
    most > 0 ? ` The most opened in one month was ${most}, in ${busiest.join(', ')}.` : ''
  }`;
}

/** The sentence an indicator chart is told in: how many results, which stated a rate, and how they stand to its limit. */
export function indicatorSentence(history: IndicatorHistory): string {
  const results = history.results;
  if (!results.length) return 'No result of this indicator is recorded yet.';
  const unit = history.definition.unitLabel ?? '';
  const stated = results.filter((result) => result.rate);
  const values = stated.map((result) => Number(result.rate!.decimal));
  const parts = [
    `${results.length} result${results.length === 1 ? '' : 's'} recorded`,
    stated.length === results.length
      ? `each states a rate`
      : `${stated.length} state${stated.length === 1 ? 's' : ''} a rate and ${results.length - stated.length} state${
          results.length - stated.length === 1 ? 's' : ''
        } none, for want of evidence`,
  ];
  let text = `${parts.join('; ')}.`;
  if (values.length) {
    const low = stated[values.indexOf(Math.min(...values))]!.rate!.decimal;
    const high = stated[values.indexOf(Math.max(...values))]!.rate!.decimal;
    text += low === high ? ` The stated rate is ${low} ${unit}.` : ` Stated rates run from ${low} to ${high} ${unit}.`;
  }
  const limit = history.definition.limit;
  if (limit && values.length) {
    const above = values.filter((value) => value > Number(limit.rate)).length;
    text += ` ${above} of the stated rates ${above === 1 ? 'is' : 'are'} above the ${limit.label.toLowerCase()} of ${limit.rate} ${unit}.`;
  }
  const gaps = windowGaps(results).length;
  if (gaps)
    text += ` ${gaps} stretch${gaps === 1 ? '' : 'es'} between windows ${gaps === 1 ? 'has' : 'have'} no recorded result.`;
  return text.replace(/\s+\./g, '.').replace(/ {2,}/g, ' ');
}
