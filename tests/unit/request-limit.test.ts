import { afterEach, describe, expect, it } from 'vitest';
import { MetricsRegistry } from '../../packages/metrics/src/index.js';
import { createApp } from '../../apps/api/src/index.js';
import {
  DEFAULT_REQUEST_LIMITS,
  RequestLimiter,
  requestLimitSettings,
  type RequestLimitSettings,
} from '../../apps/api/src/request-limit.js';
import { MemoryObjectStore, type Pool } from '../../packages/persistence/src/index.js';

describe('the request limit settings', () => {
  it('are off under LEDGER_ENV=local and test, so the simulated day and the test suites are never throttled', () => {
    expect(requestLimitSettings({}, 'local').enabled).toBe(false);
    expect(requestLimitSettings({}, 'test').enabled).toBe(false);
    expect(requestLimitSettings({ LEDGER_REQUEST_LIMIT: 'on' }, 'local').enabled).toBe(true);
    expect(requestLimitSettings({ LEDGER_REQUEST_LIMIT: 'on' }, 'test').enabled).toBe(true);
  });

  it('are on everywhere else unless switched off', () => {
    expect(requestLimitSettings({}, 'staging').enabled).toBe(true);
    expect(requestLimitSettings({ LEDGER_REQUEST_LIMIT: 'off' }, 'staging').enabled).toBe(false);
    expect(() => requestLimitSettings({ LEDGER_REQUEST_LIMIT: 'yes' }, 'staging')).toThrow(/on or off/);
  });

  it('give sources a higher rate and burst than people and services, and read both from the environment', () => {
    const defaults = requestLimitSettings({}, 'staging');
    expect(defaults.ordinary).toEqual(DEFAULT_REQUEST_LIMITS.ordinary);
    expect(defaults.source.rate).toBeGreaterThan(defaults.ordinary.rate);
    expect(defaults.source.burst).toBeGreaterThan(defaults.ordinary.burst);
    const set = requestLimitSettings(
      {
        LEDGER_REQUEST_RATE: '5',
        LEDGER_REQUEST_BURST: '50',
        LEDGER_SOURCE_REQUEST_RATE: '0.5',
        LEDGER_SOURCE_REQUEST_BURST: '10',
      },
      'staging',
    );
    expect(set).toEqual({ enabled: true, ordinary: { rate: 5, burst: 50 }, source: { rate: 0.5, burst: 10 } });
    expect(() => requestLimitSettings({ LEDGER_REQUEST_RATE: '0' }, 'staging')).toThrow(/positive/);
  });
});

describe('a token bucket per credential', () => {
  const settings: RequestLimitSettings = {
    enabled: true,
    ordinary: { rate: 2, burst: 3 },
    source: { rate: 10, burst: 20 },
  };

  it('admits a burst, then refills at the steady rate', () => {
    let now = 0;
    const limiter = new RequestLimiter(settings, () => now);
    for (let index = 0; index < 3; index++) expect(limiter.admit('person', 'human')).toBeUndefined();
    expect(limiter.admit('person', 'human')).toBe(1);
    now += 500;
    expect(limiter.admit('person', 'human')).toBeUndefined();
    expect(limiter.admit('person', 'human')).toBe(1);
  });

  it('keeps each credential to its own bucket, and a source to the higher pair', () => {
    const limiter = new RequestLimiter(settings, () => 0);
    for (let index = 0; index < 3; index++) limiter.admit('first', 'human');
    expect(limiter.admit('first', 'human')).toBe(1);
    expect(limiter.admit('second', 'service')).toBeUndefined();
    for (let index = 0; index < 20; index++) expect(limiter.admit('adapter', 'source')).toBeUndefined();
    expect(limiter.admit('adapter', 'source')).toBe(1);
  });

  it('forgets credentials whose bucket has filled again once it holds many', () => {
    let now = 0;
    const limiter = new RequestLimiter(settings, () => now);
    for (let index = 0; index <= 10_000; index++) limiter.admit(`credential-${index}`, 'human');
    expect(limiter.size).toBe(10_001);
    now += 2000;
    limiter.admit('one more', 'human');
    expect(limiter.size).toBe(1);
  });
});

const principalRow = {
  id: 'principal-avery',
  tenant_id: 'tenant-example',
  name: 'Avery Example',
  kind: 'human',
  capabilities: [],
  revision: 1,
  active: true,
};

// Answers the role check and the credential lookup only; a request the limit admits ends at 404, a route that
// does not exist, before it could reach the database.
const pool = {
  query: async (sql: string) =>
    sql.includes('ledger_authenticate')
      ? { rows: [principalRow] }
      : {
          rows: [{ name: 'ledger_app', role: 'ledger_app', rolsuper: false, rolbypassrls: false, owns_tables: false }],
        },
  end: async () => undefined,
  totalCount: 0,
  idleCount: 0,
  waitingCount: 0,
} as unknown as Pool;

describe('the API under a request limit', () => {
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  afterEach(async () => app?.close());

  it('answers 429 with Retry-After and its usual error shape, and counts it', async () => {
    const metrics = new MetricsRegistry();
    app = await createApp({
      pool,
      env: 'test',
      objectStore: new MemoryObjectStore(),
      metrics,
      requestLimit: { enabled: true, ordinary: { rate: 1, burst: 2 }, source: { rate: 1, burst: 2 } },
    });
    const send = () =>
      app!.inject({ method: 'GET', url: '/v1/nothing-here', headers: { authorization: 'Bearer ledger-dev-avery' } });
    expect((await send()).statusCode).toBe(404);
    expect((await send()).statusCode).toBe(404);
    const refused = await send();
    expect(refused.statusCode).toBe(429);
    expect(refused.headers['retry-after']).toBe('1');
    expect(refused.json()).toMatchObject({
      error: { code: 'request_limit', details: { retryAfterSeconds: 1 } },
      requestId: expect.any(String),
    });
    // A request without a credential is the proxy's to limit.
    for (let index = 0; index < 5; index++)
      expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    const text = await metrics.render();
    expect(text).toContain('ledger_http_requests_limited_total{kind="human"} 1');
    expect(text).toContain('ledger_http_requests_total{method="GET",route="unmatched",status_class="4xx"} 3');
    expect(text).toContain('ledger_http_requests_total{method="GET",route="/healthz",status_class="2xx"} 5');
  });

  it.each(['local', 'test'] as const)('never throttles under LEDGER_ENV=%s', async (env) => {
    app = await createApp({ pool, env, objectStore: new MemoryObjectStore() });
    for (let index = 0; index < DEFAULT_REQUEST_LIMITS.ordinary.burst + 20; index++) {
      const answer = await app.inject({
        method: 'GET',
        url: '/v1/nothing-here',
        headers: { authorization: 'Bearer ledger-dev-avery' },
      });
      expect(answer.statusCode).toBe(404);
    }
  });
});
