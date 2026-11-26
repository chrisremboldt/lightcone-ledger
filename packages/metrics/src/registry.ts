/**
 * The only label names a metric may carry. None of them can hold an organization, a person, a credential, a record
 * or an address: each takes a value from a short list the code fixes, and `route` takes a route's template, never a
 * request's path. A new label name is added here, with a test that says where its values come from.
 */
export const LABEL_NAMES = ['method', 'route', 'status_class', 'queue', 'outcome', 'kind', 'pool', 'state'] as const;
export type LabelName = (typeof LABEL_NAMES)[number];
export type Labels = Partial<Record<LabelName, string>>;

const allowedLabels = new Set<string>(LABEL_NAMES);
const METRIC_NAME = /^ledger_[a-z]+(?:_[a-z]+)*$/;
const LABEL_VALUE = /^[A-Za-z0-9_.:/*{}-]{1,200}$/;
// What an id looks like: a UUID, or a run of digits such as a record or flight number.
const LOOKS_LIKE_AN_ID = /[0-9a-f]{8}-[0-9a-f]{4}-|\d{4,}/i;

export class MetricsLabelError extends Error {
  override name = 'MetricsLabelError';
}

function checkLabelNames(metric: string, names: readonly string[]): void {
  if (!METRIC_NAME.test(metric))
    throw new MetricsLabelError(`${metric} is not a metric name: ledger_ and lower-case words joined by _`);
  for (const name of names)
    if (!allowedLabels.has(name))
      throw new MetricsLabelError(`${metric} names the label ${name}, which is not one of ${LABEL_NAMES.join(', ')}`);
}

function checkLabelValue(metric: string, name: string, value: string): void {
  if (!LABEL_VALUE.test(value) || LOOKS_LIKE_AN_ID.test(value))
    throw new MetricsLabelError(`${metric} was given a ${name} label value that could name a record or an address`);
}

type MetricType = 'counter' | 'gauge' | 'histogram';

abstract class Metric {
  private readonly series = new Map<string, Labels>();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly LabelName[],
    readonly type: MetricType,
  ) {
    checkLabelNames(name, labelNames);
  }

  /** The key of one labelled series, after checking it carries exactly the declared labels. */
  protected key(labels: Labels): string {
    const given = Object.keys(labels);
    if (given.length !== this.labelNames.length || given.some((name) => !this.labelNames.includes(name as LabelName)))
      throw new MetricsLabelError(`${this.name} takes the labels ${this.labelNames.join(', ') || 'none'}`);
    const values = this.labelNames.map((name) => {
      const value = labels[name]!;
      checkLabelValue(this.name, name, value);
      return value;
    });
    const key = values.join('\u0000');
    if (!this.series.has(key)) this.series.set(key, labels);
    return key;
  }

  protected labelsOf(key: string): Labels {
    return this.series.get(key)!;
  }

  abstract lines(): string[];
}

function formatValue(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return '+Inf';
  if (value === -Infinity) return '-Inf';
  return String(value);
}

function formatLabels(labels: Labels, extra?: [string, string]): string {
  const pairs = Object.entries(labels).map(([name, value]) => `${name}="${escapeLabel(value!)}"`);
  if (extra) pairs.push(`${extra[0]}="${extra[1]}"`);
  return pairs.length ? `{${pairs.join(',')}}` : '';
}

function escapeLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

class ValueMetric extends Metric {
  private readonly values = new Map<string, number>();

  protected change(labels: Labels, update: (current: number) => number): void {
    const key = this.key(labels);
    this.values.set(key, update(this.values.get(key) ?? 0));
  }

  lines(): string[] {
    if (!this.labelNames.length && !this.values.size) return [`${this.name} 0`];
    return [...this.values].map(
      ([key, value]) => `${this.name}${formatLabels(this.labelsOf(key))} ${formatValue(value)}`,
    );
  }
}

export class Counter extends ValueMetric {
  inc(labels: Labels = {}, by = 1): void {
    if (by < 0) throw new Error(`${this.name} is a counter and only goes up`);
    this.change(labels, (current) => current + by);
  }

  /** For a total the process keeps itself (its CPU time), read when the metrics are collected. */
  setTotal(labels: Labels, total: number): void {
    this.change(labels, () => total);
  }
}

export class Gauge extends ValueMetric {
  set(labels: Labels, value: number): void {
    this.change(labels, () => value);
  }

  inc(labels: Labels = {}, by = 1): void {
    this.change(labels, (current) => current + by);
  }

  dec(labels: Labels = {}, by = 1): void {
    this.change(labels, (current) => current - by);
  }
}

export class Histogram extends Metric {
  private readonly counts = new Map<string, { buckets: number[]; sum: number; count: number }>();

  constructor(
    name: string,
    help: string,
    labelNames: readonly LabelName[],
    readonly buckets: readonly number[],
  ) {
    super(name, help, labelNames, 'histogram');
    if (!buckets.length || buckets.some((bound, index) => index > 0 && bound <= buckets[index - 1]!))
      throw new Error(`${name} needs bucket bounds in increasing order`);
  }

  observe(labels: Labels, value: number): void {
    const key = this.key(labels);
    let entry = this.counts.get(key);
    if (!entry) this.counts.set(key, (entry = { buckets: this.buckets.map(() => 0), sum: 0, count: 0 }));
    this.buckets.forEach((bound, index) => {
      if (value <= bound) entry.buckets[index]!++;
    });
    entry.sum += value;
    entry.count++;
  }

  lines(): string[] {
    const lines: string[] = [];
    for (const [key, entry] of this.counts) {
      const labels = this.labelsOf(key);
      this.buckets.forEach((bound, index) =>
        lines.push(`${this.name}_bucket${formatLabels(labels, ['le', formatValue(bound)])} ${entry.buckets[index]}`),
      );
      lines.push(`${this.name}_bucket${formatLabels(labels, ['le', '+Inf'])} ${entry.count}`);
      lines.push(`${this.name}_sum${formatLabels(labels)} ${formatValue(entry.sum)}`);
      lines.push(`${this.name}_count${formatLabels(labels)} ${entry.count}`);
    }
    return lines;
  }
}

/**
 * The metrics of one process, rendered in the Prometheus text format. The API and the workers in one process share
 * one registry, so the process has one endpoint; a metric both register (the database pool's) is the same metric,
 * told apart by its labels.
 */
export class MetricsRegistry {
  private readonly metrics = new Map<string, Metric>();
  private readonly collectors: (() => void | Promise<void>)[] = [];

  counter(name: string, help: string, labelNames: readonly LabelName[] = []): Counter {
    return this.add(name, 'counter', labelNames, () => new Counter(name, help, labelNames, 'counter'));
  }

  gauge(name: string, help: string, labelNames: readonly LabelName[] = []): Gauge {
    return this.add(name, 'gauge', labelNames, () => new Gauge(name, help, labelNames, 'gauge'));
  }

  histogram(name: string, help: string, labelNames: readonly LabelName[], buckets: readonly number[]): Histogram {
    return this.add(name, 'histogram', labelNames, () => new Histogram(name, help, labelNames, buckets));
  }

  /** Runs before each rendering, to read figures that are sampled rather than counted (a pool's connections). */
  onCollect(collect: () => void | Promise<void>): void {
    this.collectors.push(collect);
  }

  async render(): Promise<string> {
    for (const collect of this.collectors) await collect();
    const lines: string[] = [];
    for (const metric of this.metrics.values()) {
      lines.push(`# HELP ${metric.name} ${metric.help.replaceAll('\\', '\\\\').replaceAll('\n', '\\n')}`);
      lines.push(`# TYPE ${metric.name} ${metric.type}`);
      lines.push(...metric.lines());
    }
    return `${lines.join('\n')}\n`;
  }

  private add<M extends Metric>(name: string, type: MetricType, labelNames: readonly LabelName[], make: () => M): M {
    const existing = this.metrics.get(name);
    if (existing) {
      if (existing.type !== type || existing.labelNames.join() !== labelNames.join())
        throw new Error(`${name} is already registered as a ${existing.type} with other labels`);
      return existing as M;
    }
    const metric = make();
    this.metrics.set(name, metric);
    return metric;
  }
}
