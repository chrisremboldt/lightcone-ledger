import { describe, expect, it } from 'vitest';
import {
  LABEL_NAMES,
  MetricsLabelError,
  MetricsRegistry,
  metricsListen,
  refuseSharedPort,
  registerPoolMetrics,
  serveMetrics,
  startMetrics,
} from './src/index.js';

describe('the metrics registry', () => {
  it('takes label names from its fixed list only', () => {
    const registry = new MetricsRegistry();
    for (const label of ['tenant', 'organization', 'principal', 'credential', 'flight', 'path', 'address'])
      expect(() => registry.counter('ledger_test_total', 'A test.', [label as never])).toThrow(MetricsLabelError);
    expect(LABEL_NAMES).toEqual(['method', 'route', 'status_class', 'queue', 'outcome', 'kind', 'pool', 'state']);
  });

  it('refuses a metric name that is not ledger_ and words', () => {
    const registry = new MetricsRegistry();
    for (const name of ['http_requests_total', 'ledger_tenant_alpha_1_total', 'ledger_Requests', 'ledger_'])
      expect(() => registry.gauge(name, 'A test.')).toThrow(MetricsLabelError);
  });

  it('refuses a label value that could be an id or a path with one in it', () => {
    const counter = new MetricsRegistry().counter('ledger_test_total', 'A test.', ['route']);
    for (const value of [
      '/v1/flights/0f6c1b2e-9d3a-4c11-8a55-3f1e2d4c5b6a',
      '/v1/flights/12345',
      '/v1/receipts?flightId=x',
      'avery@example.org',
      '',
    ])
      expect(() => counter.inc({ route: value }), value).toThrow(MetricsLabelError);
    counter.inc({ route: '/v1/flights/:id' });
  });

  it('takes exactly the labels a metric declares', () => {
    const counter = new MetricsRegistry().counter('ledger_test_total', 'A test.', ['method']);
    expect(() => counter.inc({})).toThrow(MetricsLabelError);
    expect(() => counter.inc({ method: 'GET', route: '/x' })).toThrow(MetricsLabelError);
  });

  it('renders the Prometheus text format', async () => {
    const registry = new MetricsRegistry();
    registry.counter('ledger_test_total', 'Things counted.', ['outcome']).inc({ outcome: 'completed' }, 3);
    registry.gauge('ledger_test_level', 'A level.').set({}, 0.5);
    const histogram = registry.histogram('ledger_test_seconds', 'Durations.', ['queue'], [0.1, 1]);
    histogram.observe({ queue: 'projection' }, 0.05);
    histogram.observe({ queue: 'projection' }, 2);
    expect(await registry.render()).toBe(
      [
        '# HELP ledger_test_total Things counted.',
        '# TYPE ledger_test_total counter',
        'ledger_test_total{outcome="completed"} 3',
        '# HELP ledger_test_level A level.',
        '# TYPE ledger_test_level gauge',
        'ledger_test_level 0.5',
        '# HELP ledger_test_seconds Durations.',
        '# TYPE ledger_test_seconds histogram',
        'ledger_test_seconds_bucket{queue="projection",le="0.1"} 1',
        'ledger_test_seconds_bucket{queue="projection",le="1"} 1',
        'ledger_test_seconds_bucket{queue="projection",le="+Inf"} 2',
        'ledger_test_seconds_sum{queue="projection"} 2.05',
        'ledger_test_seconds_count{queue="projection"} 2',
        '',
      ].join('\n'),
    );
  });

  it('gives two parts of one process the same metric when both register it', async () => {
    const registry = new MetricsRegistry();
    registerPoolMetrics(registry, 'api', { totalCount: 3, idleCount: 1, waitingCount: 0, options: { max: 10 } });
    registerPoolMetrics(registry, 'workers', { totalCount: 2, idleCount: 2, waitingCount: 1, options: { max: 10 } });
    const text = await registry.render();
    expect(text.match(/# TYPE ledger_database_pool_connections gauge/g)).toHaveLength(1);
    expect(text).toContain('ledger_database_pool_connections{pool="api",state="in_use"} 2');
    expect(text).toContain('ledger_database_pool_waiting_requests{pool="workers"} 1');
    expect(() => registry.counter('ledger_database_pool_connections', 'Again.', ['pool'])).toThrow();
  });
});

describe('where the metrics listen', () => {
  it('is off when unset, loopback when only a port is given, and the address given otherwise', () => {
    expect(metricsListen(undefined)).toBeUndefined();
    expect(metricsListen(' ')).toBeUndefined();
    expect(metricsListen('9464')).toEqual({ host: '127.0.0.1', port: 9464 });
    expect(metricsListen('0.0.0.0:9464')).toEqual({ host: '0.0.0.0', port: 9464 });
    expect(metricsListen('[::1]:9464')).toEqual({ host: '::1', port: 9464 });
    for (const value of ['metrics', '9464:', '127.0.0.1', '70000', 'http://127.0.0.1:9464'])
      expect(() => metricsListen(value), value).toThrow(/LEDGER_METRICS_LISTEN/);
  });

  it('never shares the port that serves the API', () => {
    expect(() => refuseSharedPort({ host: '127.0.0.1', port: 4000 }, 4000)).toThrow(/a port of their own/);
    expect(() => refuseSharedPort({ host: '127.0.0.1', port: 9464 }, 4000)).not.toThrow();
  });

  it('serves GET /metrics on its own listener and nothing else', async () => {
    const running = await startMetrics({ LEDGER_METRICS_LISTEN: '0' }, { servicePort: 4000 });
    expect(running).toBeDefined();
    try {
      const base = `http://127.0.0.1:${running!.server.port}`;
      expect(running!.server.host).toBe('127.0.0.1');
      const scrape = await fetch(`${base}/metrics`);
      expect(scrape.status).toBe(200);
      expect(scrape.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
      const text = await scrape.text();
      expect(text).toContain('# TYPE ledger_process_cpu_seconds_total counter');
      expect(text).toMatch(/^ledger_process_resident_memory_bytes \d+$/m);
      expect((await fetch(`${base}/`)).status).toBe(404);
      expect((await fetch(`${base}/metrics`, { method: 'POST' })).status).toBe(404);
    } finally {
      await running!.server.close();
    }
    expect(await startMetrics({})).toBeUndefined();
  });

  it('answers 500 without detail when a collection fails', async () => {
    const registry = new MetricsRegistry();
    registry.onCollect(() => {
      throw new Error('tenant-alpha');
    });
    const server = await serveMetrics(registry, { host: '127.0.0.1', port: 0 });
    try {
      const answer = await fetch(`http://127.0.0.1:${server.port}/metrics`);
      expect(answer.status).toBe(500);
      expect(await answer.text()).toBe('Metrics unavailable\n');
    } finally {
      await server.close();
    }
  });
});
