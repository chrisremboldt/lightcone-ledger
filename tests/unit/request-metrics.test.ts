import { afterEach, describe, expect, it, vi } from 'vitest';
import { LABEL_NAMES, MetricsRegistry } from '../../packages/metrics/src/index.js';
import { createApp } from '../../apps/api/src/index.js';
import { MemoryObjectStore, type Pool } from '../../packages/persistence/src/index.js';

const principalRow = {
  id: 'principal-ridge-source',
  tenant_id: 'tenant-example-ridge',
  name: 'Example Ridge Survey weather source',
  kind: 'source',
  capabilities: ['input:write'],
  revision: 1,
  active: true,
};

// Answers the role check and the credential lookup; anything that needs a connection fails, which a count must
// survive as well.
const pool = {
  query: async (sql: string) =>
    sql.includes('ledger_authenticate')
      ? { rows: [principalRow] }
      : {
          rows: [{ name: 'ledger_app', role: 'ledger_app', rolsuper: false, rolbypassrls: false, owns_tables: false }],
        },
  connect: async () => {
    throw Object.assign(new Error('no database in this test'), { code: 'XX000' });
  },
  end: async () => undefined,
  totalCount: 4,
  idleCount: 1,
  waitingCount: 0,
  options: { max: 10 },
} as unknown as Pool;

const authorization = 'Bearer ledger-service-ridge-weather';

/** Every label name in an exposition, and every label value. */
function labelsIn(text: string): { names: Set<string>; values: string[] } {
  const names = new Set<string>();
  const values: string[] = [];
  for (const line of text.split('\n').filter((line) => line && !line.startsWith('#')))
    for (const [, name, value] of line.matchAll(/([a-z_]+)="([^"]*)"/g)) {
      names.add(name!);
      values.push(value!);
    }
  return { names, values };
}

describe('the API request metrics', () => {
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  afterEach(async () => {
    await app?.close();
    vi.restoreAllMocks();
  });

  it('count a request by its route template, never its path, and carry only the listed labels', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const metrics = new MetricsRegistry();
    app = await createApp({ pool, env: 'test', objectStore: new MemoryObjectStore(), metrics });
    const flight = await app.inject({
      method: 'GET',
      url: '/v1/flights/flight-ridge-0042?view=full',
      headers: { authorization },
    });
    expect(flight.statusCode).toBeGreaterThanOrEqual(500);
    await app.inject({ method: 'GET', url: '/v1/no-such-route/RIDGE-AC-1', headers: { authorization } });
    await app.inject({
      method: 'POST',
      url: '/v1/inputs',
      headers: { authorization },
      payload: { kind: 'observation' },
    });
    const text = await metrics.render();
    expect(text).toContain('ledger_http_requests_total{method="GET",route="/v1/flights/:id",status_class="5xx"} 1');
    expect(text).toMatch(/ledger_http_request_duration_seconds_count\{method="GET",route="\/v1\/flights\/:id"/);
    expect(text).toContain('ledger_http_requests_total{method="GET",route="unmatched",status_class="4xx"} 1');
    expect(text).toContain('ledger_observations_total{outcome="refused"} 1');
    expect(text).toContain('ledger_database_pool_connections{pool="api",state="in_use"} 3');
    for (const raw of ['flight-ridge-0042', 'RIDGE-AC-1', 'tenant-example-ridge', 'principal-ridge-source', 'view='])
      expect(text).not.toContain(raw);
    const { names, values } = labelsIn(text);
    for (const name of names) expect([...LABEL_NAMES, 'le']).toContain(name);
    for (const value of values.filter((value) => value.startsWith('/')))
      expect(value, 'a route is counted by its template').not.toMatch(/\/[^/:*]*\d[^/]*$|\?/);
  });

  it('measure nothing when the process has no metrics', async () => {
    app = await createApp({ pool, env: 'test', objectStore: new MemoryObjectStore() });
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  });
});
