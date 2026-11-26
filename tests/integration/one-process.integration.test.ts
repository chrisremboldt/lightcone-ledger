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
