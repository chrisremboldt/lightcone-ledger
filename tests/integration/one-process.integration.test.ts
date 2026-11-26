import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { startOneProcess } from '../../apps/api/src/one-process.js';
import { createPool, MemoryObjectStore } from '../../packages/persistence/src/index.js';

const admin = createPool(process.env.DATABASE_ADMIN_URL);
const worker = createPool(process.env.WORKER_DATABASE_URL);
afterAll(async () => {
  await admin.end();
  await worker.end();
});

describe('The one-process start', () => {
  it('serves the API as ledger_app and runs the workers as ledger_worker, under the same row-level security', async () => {
    const running = await startOneProcess({
      port: 0,
      host: '127.0.0.1',
      app: { env: 'test', objectStore: new MemoryObjectStore(), logger: false },
    });
    try {
      const { port } = running.app.server.address() as AddressInfo;
      const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
      expect(ready.status).toBe(200);
      expect(await ready.json()).toMatchObject({ status: 'ready', role: 'ledger_app' });
      // The workers in this process hold their own connections, as the worker role.
      let connected = false;
      for (let attempt = 0; attempt < 100 && !connected; attempt++) {
        const { rowCount } = await admin.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename='ledger_worker' AND pid<>pg_backend_pid()",
        );
        connected = Boolean(rowCount);
        if (!connected) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(connected).toBe(true);
    } finally {
      await running.stop();
    }
    await expect(running.workers.done).resolves.toBeUndefined();
  });

  it('serves one metrics endpoint for the API and the workers, on a listener apart from the API', async () => {
    const running = await startOneProcess({
      port: 0,
      host: '127.0.0.1',
      env: { ...process.env, LEDGER_METRICS_LISTEN: '127.0.0.1:0' },
      app: { env: 'test', objectStore: new MemoryObjectStore(), logger: false },
    });
    try {
      const { port } = running.app.server.address() as AddressInfo;
      expect(running.metrics!.server.port).not.toBe(port);
      expect((await fetch(`http://127.0.0.1:${port}/metrics`)).status).not.toBe(200);
      expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
      const scrape = `http://127.0.0.1:${running.metrics!.server.port}/metrics`;
      let text = '';
      for (
        let attempt = 0;
        attempt < 100 && !/ledger_worker_passes_total\{outcome="completed"\} [1-9]/.test(text);
        attempt++
      ) {
        text = await (await fetch(scrape)).text();
        if (!/ledger_worker_passes_total\{outcome="completed"\} [1-9]/.test(text))
          await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(text).toContain('ledger_http_requests_total{method="GET",route="/healthz",status_class="2xx"} 1');
      expect(text).toMatch(/ledger_worker_passes_total\{outcome="completed"\} [1-9]/);
      expect(text).toContain('ledger_database_pool_connections{pool="api",state="idle"}');
      expect(text).toContain('ledger_database_pool_connections{pool="workers",state="idle"}');
      expect(text).toContain('# TYPE ledger_evaluation_lag_seconds gauge');
      expect(text).toMatch(/^ledger_queue_ready_items\{queue="notice_delivery"\} \d+$/m);
      expect(text).toMatch(/^ledger_evaluation_lag_seconds [\d.]+$/m);
      expect(text.match(/# TYPE ledger_process_cpu_seconds_total counter/g)).toHaveLength(1);
    } finally {
      await running.stop();
    }
    await expect(running.workers.done).resolves.toBeUndefined();
  });

  it('gives that worker role no rows outside an organization and no way to change history', async () => {
    const roles = await admin.query(
      "SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname IN ('ledger_app','ledger_worker') ORDER BY rolname",
    );
    expect(roles.rows).toEqual([
      { rolname: 'ledger_app', rolsuper: false, rolbypassrls: false },
      { rolname: 'ledger_worker', rolsuper: false, rolbypassrls: false },
    ]);
    const owned = Number((await admin.query('SELECT count(*) FROM journal_events')).rows[0].count);
    expect(owned).toBeGreaterThan(0);
    expect(Number((await worker.query('SELECT count(*) FROM journal_events')).rows[0].count)).toBe(0);
    const client = await worker.connect();
    try {
      const { tenant_id } = (await admin.query('SELECT tenant_id FROM journal_events LIMIT 1')).rows[0];
      await client.query('BEGIN');
      await client.query("SELECT set_config('ledger.tenant_id',$1,true)", [tenant_id]);
      await expect(client.query('UPDATE journal_events SET payload=payload')).rejects.toThrow();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
