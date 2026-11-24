import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createPool, withScope } from '../../packages/persistence/src/index.js';
import { settleOwnedWork } from './worker-queue.js';

/**
 * The evaluator's reads run without PostgreSQL's just-in-time compilation: their cost estimates over the partitioned
 * journal are high while the reads take milliseconds, and compiling each took hundreds of milliseconds inside the
 * worker's transaction.
 */
describe('statements in a scoped transaction', () => {
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const pool = createPool(process.env.WORKER_DATABASE_URL);
  const tenantId = `statements-${randomUUID()}`;
  const workerId = `${tenantId}:worker`;

  afterAll(async () => {
    await settleOwnedWork([tenantId]);
    await pool.end();
    await admin.end();
  });

  it('are not compiled just in time, and the setting ends with the transaction', async () => {
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, 'Fictional statements operator']);
    await admin.query('INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,$4,$5)', [
      workerId,
      tenantId,
      'Worker',
      'worker',
      ['evidence:read'],
    ]);
    const inside = await withScope(pool, { id: workerId, tenantId }, async (client) => {
      return (await client.query<{ jit: string }>("SELECT current_setting('jit') AS jit")).rows[0]!.jit;
    });
    expect(inside).toBe('off');
    const client = await pool.connect();
    try {
      const outside = (await client.query<{ jit: string }>("SELECT current_setting('jit') AS jit")).rows[0]!.jit;
      const server = (await admin.query<{ jit: string }>("SELECT reset_val AS jit FROM pg_settings WHERE name='jit'"))
        .rows[0]!.jit;
      expect(outside).toBe(server);
    } finally {
      client.release();
    }
  });
});
