import { afterAll, describe, expect, it } from 'vitest';
import { createPool } from '../../packages/persistence/src/index.js';
import { WORK_QUEUES } from '../../apps/workers/src/work-metrics.js';

const admin = createPool(process.env.DATABASE_ADMIN_URL);
const worker = createPool(process.env.WORKER_DATABASE_URL);
const application = createPool(process.env.DATABASE_URL);
afterAll(async () => {
  await Promise.all([admin.end(), worker.end(), application.end()]);
});

describe('ledger_queue_figures()', () => {
  it('returns one row of counts and an age per queue, the same whichever organization the session names', async () => {
    const tenants = (await admin.query<{ id: string }>('SELECT id FROM tenants ORDER BY id')).rows.map((row) => row.id);
    expect(tenants.length).toBeGreaterThan(1);
    const client = await worker.connect();
    try {
      // One transaction, so now() and the snapshot are the same for every call.
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const figures = async () => (await client.query('SELECT * FROM ledger_queue_figures()')).rows;
      const unscoped = await figures();
      for (const tenant of [...tenants, 'no-such-organization']) {
        await client.query("SELECT set_config('ledger.tenant_id',$1,true)", [tenant]);
        expect(await figures()).toEqual(unscoped);
      }
      await client.query('COMMIT');
      expect(unscoped.map((row) => row.queue)).toEqual([...WORK_QUEUES].sort());
      for (const row of unscoped) {
        expect(Object.keys(row)).toEqual(['queue', 'ready', 'leased', 'oldest_ready_seconds']);
        expect(Number(row.ready)).toBeGreaterThanOrEqual(0);
        expect(row.oldest_ready_seconds).toBeGreaterThanOrEqual(0);
      }
      const text = JSON.stringify(unscoped);
      for (const tenant of tenants) expect(text).not.toContain(tenant);
    } finally {
      client.release();
    }
  });

  it('counts what the tables hold across every organization', async () => {
    const client = await admin.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const figures = (await client.query('SELECT * FROM ledger_queue_figures()')).rows;
      const projection = (
        await client.query(
          `SELECT count(*) FILTER (WHERE state='pending' AND available_at<=now() OR state='leased' AND lease_until<now()) AS ready,
                  count(*) FILTER (WHERE state='leased' AND lease_until>=now()) AS leased
           FROM work_items`,
        )
      ).rows[0];
      const schedules = (await client.query('SELECT count(*) AS total FROM notice_schedules')).rows[0];
      await client.query('COMMIT');
      expect(figures.find((row) => row.queue === 'projection')).toMatchObject(projection);
      const schedule = figures.find((row) => row.queue === 'notice_schedule')!;
      expect(Number(schedule.ready) + Number(schedule.leased)).toBeLessThanOrEqual(Number(schedules.total));
    } finally {
      client.release();
    }
  });

  it('may be run by the workers only', async () => {
    await expect(application.query('SELECT * FROM ledger_queue_figures()')).rejects.toThrow(/permission denied/);
    const grants = await admin.query(
      `SELECT grantee FROM information_schema.routine_privileges
       WHERE routine_name='ledger_queue_figures' AND privilege_type='EXECUTE'
       AND grantee<>(SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE proname='ledger_queue_figures')`,
    );
    expect(grants.rows.map((row) => row.grantee)).toEqual(['ledger_worker']);
  });
});
