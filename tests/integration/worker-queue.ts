import { expect } from 'vitest';
import { leaseWork, processLease, runOnce } from '../../apps/workers/src/index.js';
import { createPool, type ObjectStore, type Pool } from '../../packages/persistence/src/index.js';

// Every integration file shares one database and so one set of work queues. A file names the tenants it owns: a
// tenant is owned when its id equals one of the names or begins with one. The worker lease functions take work for
// any tenant, so while a file leases, the other tenants' work that could be leased is held under row locks that the
// lease functions skip. Work not due for a while is left unlocked, so the locks stay few as the database fills.

export type OwnedTenants = readonly string[];

// Each queue, when its pending work falls due (by $at, or now), and how a leftover row is named.
const QUEUES = [
  {
    table: 'work_items',
    scheduled: 'true',
    due: 'true',
    kind: 'j.event_type',
    from: 'work_items q JOIN journal_events j ON j.tenant_id=q.tenant_id AND j.id=q.event_id',
  },
  {
    table: 'selection_work',
    scheduled: 'q.due_at<=$at',
    due: 'q.due_at<=clock_timestamp()',
    kind: 'q.kind',
    from: 'selection_work q',
  },
  {
    table: 'evaluation_deadlines',
    scheduled: 'q.due_at<=$at',
    due: 'q.due_at<=clock_timestamp()',
    kind: 'q.leaf_id',
    from: 'evaluation_deadlines q',
  },
  {
    table: 'rule_evaluation_work',
    scheduled: 'q.due_at<=$at',
    due: 'q.due_at<=clock_timestamp()',
    kind: "q.subject_kind||' '||q.leaf_id",
    from: 'rule_evaluation_work q',
  },
] as const;

// Longer than any one worker pass in these tests.
const LOCK_HORIZON = "clock_timestamp()+interval '10 minutes'";

const OWNED = `(q.tenant_id=ANY($1::text[]) OR EXISTS(SELECT 1 FROM unnest($1::text[]) owned(name)
  WHERE left(q.tenant_id,length(owned.name))=owned.name))`;

// Runs `work` while every other tenant's leasable work is locked, so whatever it leases belongs to the owned tenants.
export async function withOwnedWork<T>(admin: Pool, tenants: OwnedTenants, work: () => Promise<T>): Promise<T> {
  if (!tenants.length) throw new Error('Name at least one owned tenant');
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    for (const { table, scheduled } of QUEUES)
      await client.query(
        `SELECT 1 FROM ${table} q WHERE (q.state='leased' OR q.state='pending' AND q.available_at<=${LOCK_HORIZON}
         AND ${scheduled.replace('$at', LOCK_HORIZON)}) AND NOT ${OWNED} FOR UPDATE SKIP LOCKED`,
        [tenants],
      );
    const result = await work();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export interface OwnedWorkOptions {
  objectStore?: ObjectStore;
  limit?: number;
}

// One worker pass (projection, rule selection, deadlines, rule evaluation) over the owned tenants' work only.
export function runOwnedWork(
  admin: Pool,
  workers: Pool,
  tenants: OwnedTenants,
  options: OwnedWorkOptions = {},
): Promise<number> {
  return withOwnedWork(admin, tenants, () => runOnce(workers, { limit: 100, ...options }));
}

// Runs worker passes until one completes nothing.
export async function drainOwnedWork(
  admin: Pool,
  workers: Pool,
  tenants: OwnedTenants,
  options: OwnedWorkOptions & { passes?: number } = {},
): Promise<void> {
  const { passes = 100, ...run } = options;
  for (let pass = 0; pass < passes; pass++) if (!(await runOwnedWork(admin, workers, tenants, run))) return;
  throw new Error(`Owned work did not drain in ${passes} passes`);
}

// Projects the owned tenants' journal events only, failing on the first event that does not project.
export async function projectOwnedWork(
  admin: Pool,
  workers: Pool,
  tenants: OwnedTenants,
  options: { objectStore?: ObjectStore; passes?: number } = {},
): Promise<void> {
  const { passes = 60, objectStore } = options;
  for (let pass = 0; pass < passes; pass++) {
    const leases = await withOwnedWork(admin, tenants, () => leaseWork(workers, { limit: 100 }));
    if (!leases.length) return;
    for (const lease of leases) expect(await processLease(workers, lease, { objectStore })).toBe(true);
  }
  throw new Error(`Owned projection did not drain in ${passes} passes`);
}

// Leased work, pending work a worker could take now, and failed attempts waiting to retry, of the owned tenants, by
// queue, state, event type (or rule) and the last error. Work scheduled for later, such as the end of a flight's
// window, is not counted, nor is work of a tenant with no active worker principal, which no lease function takes.
export async function openOwnedWork(admin: Pool, tenants: OwnedTenants): Promise<string[]> {
  const open: string[] = [];
  for (const { table, due, kind, from } of QUEUES) {
    const rows = (
      await admin.query<{ state: string; kind: string; error: string | null; count: number }>(
        `SELECT q.state, ${kind} AS kind, left(q.error,160) AS error, count(*)::int AS count FROM ${from}
         WHERE (q.state='leased' OR q.state='pending' AND (q.error IS NOT NULL OR ${due} AND q.available_at<=clock_timestamp()))
         AND ${OWNED} AND EXISTS(SELECT 1 FROM principals p WHERE p.tenant_id=q.tenant_id AND p.kind='worker' AND p.active)
         GROUP BY 1,2,3 ORDER BY 1,2,3`,
        [tenants],
      )
    ).rows;
    for (const row of rows)
      open.push(`${table} ${row.state} ${row.kind} x${row.count}${row.error ? ` (${row.error})` : ''}`);
  }
  return open;
}

// Fails the file when it leaves work for another file's workers to find.
export async function expectNoOwnedWork(admin: Pool, tenants: OwnedTenants): Promise<void> {
  expect(await openOwnedWork(admin, tenants), 'work this file left pending or leased').toEqual([]);
}

// The end of a file: drain what it created with its own object store, then fail on anything still open. It opens
// its own pools, so a file that never runs workers can call it too.
export async function settleOwnedWork(tenants: OwnedTenants, options: OwnedWorkOptions = {}): Promise<void> {
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const workers = createPool(process.env.WORKER_DATABASE_URL);
  try {
    await drainOwnedWork(admin, workers, tenants, options);
    await expectNoOwnedWork(admin, tenants);
  } finally {
    await Promise.all([admin.end(), workers.end()]);
  }
}

export type QueueTable = (typeof QUEUES)[number]['table'];

// The database's clock now. Rows are recorded by this clock, so a bound that a recorded row must fall before or
// after, such as an evidence cut or the end of a window, is taken from it rather than from this machine's clock.
export async function databaseNow(pool: Pool): Promise<string> {
  const { rows } = await pool.query<{ now: Date }>('SELECT clock_timestamp() AS now');
  return rows[0]!.now.toISOString();
}

// Resolves once the database clock has passed the lease on a queue row. A test that needs a lease to have expired
// waits for this instead of sleeping for a guessed length.
export async function leaseExpired(admin: Pool, table: QueueTable, id: string): Promise<void> {
  const expired = `SELECT 1 FROM ${table} WHERE id=$1 AND lease_until<clock_timestamp()`;
  while (!(await admin.query(expired, [id])).rowCount) await new Promise((resolve) => setTimeout(resolve, 20));
}

// Resolves once some session in this database waits for a lock another holds. A test that orders two transactions
// against each other waits for this instead of sleeping for a guessed length.
export async function lockWaitStarted(admin: Pool): Promise<void> {
  const waiting = `SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
    WHERE NOT l.granted AND a.datname=current_database()`;
  while (!(await admin.query(waiting)).rowCount) await new Promise((resolve) => setTimeout(resolve, 20));
}
