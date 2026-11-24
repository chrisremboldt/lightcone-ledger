import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, type PoolClient } from '../../packages/persistence/src/index.js';
import { sha256 } from '../../packages/integrity/src/index.js';
import { settleOwnedWork, withOwnedWork } from './worker-queue.js';

// The built API and workers run as their own processes, as `pnpm dev` and a deployment start them. Their database
// connections are ended (pg_terminate_backend) while each process waits inside a transaction, and the database then
// refuses new connections for a while: both processes stay up, the API answers 503 meanwhile, and both carry on
// once the database lets them in again.

const SECOND = 1000;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function eventually<T>(what: string, check: () => Promise<T | undefined>, timeoutMs = 60 * SECOND): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

interface Running {
  child: ChildProcess;
  output: string[];
}

function start(script: string, env: NodeJS.ProcessEnv): Running {
  const child = spawn(process.execPath, [script], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  const output: string[] = [];
  child.stdout!.on('data', (bytes) => output.push(String(bytes)));
  child.stderr!.on('data', (bytes) => output.push(String(bytes)));
  return { child, output };
}

const alive = ({ child }: Running) => child.exitCode === null && child.signalCode === null;

describe.runIf(process.env.LEDGER_ENV !== 'staging')('A lost database connection', () => {
  const tenantId = `connection-loss-${randomUUID()}`;
  const actor = `${tenantId}:actor`;
  const worker = `${tenantId}:worker`;
  const credential = `ledger-dev-${actor}`;
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  let database = '';
  let superuser = false;
  let objects = '';
  let base = '';
  let api: Running;
  let workers: Running;

  const request = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${credential}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': randomUUID() }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  const createFlight = (label: string) =>
    request('POST', '/v1/flights', { originationKey: `${tenantId}:${label}`, label: `Fictional ${label}` });
  const openWork = async () =>
    Number(
      (
        await admin.query(`SELECT COUNT(*) AS count FROM work_items WHERE tenant_id=$1 AND state<>'completed'`, [
          tenantId,
        ])
      ).rows[0].count,
    );
  const waiting = async (role: string) =>
    (
      await admin.query(
        `SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename=$1 AND wait_event_type='Lock'`,
        [role],
      )
    ).rowCount;
  const admitConnections = (limit: number) =>
    admin.query(`ALTER DATABASE "${database.replaceAll('"', '""')}" CONNECTION LIMIT ${limit}`);
  const processes = () => `API:\n${api.output.join('')}\nWorkers:\n${workers.output.join('')}`;

  beforeAll(async () => {
    const role = (
      await admin.query('SELECT current_database() AS name,rolsuper FROM pg_roles WHERE rolname=current_user')
    ).rows[0];
    database = role.name;
    superuser = role.rolsuper;
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, 'Fictional connection loss operator']);
    await admin.query('INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,$4,$5)', [
      actor,
      tenantId,
      'Avery Example',
      'human',
      ['flight:create', 'flight:read'],
    ]);
    await admin.query('INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,$4,$5)', [
      worker,
      tenantId,
      'Fictional worker',
      'worker',
      ['flight:read'],
    ]);
    await admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [
      sha256(credential),
      actor,
    ]);
    objects = await mkdtemp(join(tmpdir(), 'ledger-connection-loss-'));
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const env = {
      ...process.env,
      LEDGER_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      OBJECT_STORE: '',
      OBJECT_STORAGE_BACKEND: '',
      OBJECT_STORAGE_DIR: objects,
    };
    api = start('apps/api/dist/main.js', env);
    workers = start('apps/workers/dist/main.js', env);
    await eventually('the API to be ready', async () => ((await fetch(`${base}/readyz`)).ok ? true : undefined));
  });

  afterAll(async () => {
    if (database) await admitConnections(-1);
    for (const running of [api, workers].filter(Boolean)) {
      if (!alive(running)) continue;
      const exited = new Promise((resolve) => running.child.once('exit', resolve));
      running.child.kill('SIGTERM');
      await exited;
    }
    await settleOwnedWork([tenantId]);
    await admin.end();
    if (objects) await rm(objects, { recursive: true, force: true });
  });

  it('leaves the API and the workers running: 503 while the database is away, working again once it is back', async (context) => {
    if (!superuser) return context.skip('Refusing new connections to the test database needs a superuser admin role');
    // Only this file's tenant's work is open to the worker process; every other tenant's leasable work stays locked.
    await withOwnedWork(admin, [tenantId], async () => {
      expect((await createFlight('before')).status).toBe(201);
      await eventually('the workers to project the first flight', async () =>
        (await openWork()) === 0 ? true : undefined,
      );

      // Each process waits inside a transaction, on its principal's row, when its connections are ended.
      const lock: PoolClient = await admin.connect();
      let refused: Awaited<ReturnType<typeof request>> | undefined;
      try {
        await lock.query('BEGIN');
        await lock.query('SELECT 1 FROM principals WHERE id=$1 FOR UPDATE', [worker]);
        expect((await createFlight('during')).status).toBe(201);
        await eventually('the workers to wait inside a transaction', async () =>
          (await waiting('ledger_worker')) ? true : undefined,
        );
        await lock.query('SELECT 1 FROM principals WHERE id=$1 FOR UPDATE', [actor]);
        const inFlight = createFlight('cut-off');
        await eventually('the API to wait inside a transaction', async () =>
          (await waiting('ledger_app')) ? true : undefined,
        );
        await admitConnections(0);
        const ended = await admin.query(
          `SELECT pg_terminate_backend(pid) AS ended FROM pg_stat_activity
           WHERE datname=current_database() AND usename IN ('ledger_app','ledger_worker')`,
        );
        expect(ended.rowCount).toBeGreaterThanOrEqual(2);
        refused = await inFlight;
      } finally {
        await lock.query('ROLLBACK');
        lock.release();
      }
      expect(refused.status, JSON.stringify(refused.body)).toBe(503);
      expect(refused.body.error.code).toBe('database_unavailable');

      // While the database refuses them, both processes stay up and the API answers in plain words.
      const away = await request('GET', '/v1/me');
      expect(away.status, JSON.stringify(away.body)).toBe(503);
      expect(away.body.error).toEqual({
        code: 'database_unavailable',
        message:
          'Ledger cannot reach its database right now, so this request may not have been completed. Try it again in a moment.',
      });
      expect((await fetch(`${base}/readyz`)).status).toBe(503);
      await new Promise((resolve) => setTimeout(resolve, 2 * SECOND));
      expect(alive(api), processes()).toBe(true);
      expect(alive(workers), processes()).toBe(true);

      // Once it admits them again, the API answers and the workers finish the work they lost, and take on new work.
      await admitConnections(-1);
      await eventually('the API to be ready again', async () =>
        (await fetch(`${base}/readyz`)).ok ? true : undefined,
      );
      expect((await request('GET', '/v1/me')).status).toBe(200);
      expect((await createFlight('after')).status).toBe(201);
      await eventually(
        'the workers to finish every flight',
        async () => ((await openWork()) === 0 ? true : undefined),
        90 * SECOND,
      );
      const flights = await request('GET', '/v1/flights');
      expect(flights.status).toBe(200);
      expect(alive(api), processes()).toBe(true);
      expect(alive(workers), processes()).toBe(true);
    });
  }, 180_000);
});
